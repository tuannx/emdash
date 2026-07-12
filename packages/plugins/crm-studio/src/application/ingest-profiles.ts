import type {
  CrmContext,
  CrmEvent,
  CrmProfile,
  JsonRecord,
  ProjectedProfileResult,
  ValidationResult
} from "../types.js";
import { eventId } from "../domain/membership.js";
import { PROFILE_BATCH_LIMIT } from "../domain/limits.js";
import {
  applyProfileTraits,
  normalizeSource,
  projectExternalProfile,
  sanitizeTraits,
  validateIdentityToken
} from "../domain/profile.js";
import { isJsonRecord } from "./contracts.js";
import { bumpProfileEpoch } from "../infrastructure/repositories.js";

interface PreparedInput {
  profile_id: string;
  value: JsonRecord;
  kind: "emdash" | "external";
}

var EMDASH_PROFILE_FIELDS: Record<string, boolean> = {
  emdash_user_id: true,
  traits: true,
  consent_evidence: true
};
var EXTERNAL_PROFILE_FIELDS: Record<string, boolean> = {
  external_source: true,
  external_id: true,
  email: true,
  name: true,
  traits: true,
  consent_evidence: true
};

function failure<T>(result: ValidationResult<unknown>): ValidationResult<T> {
  return { ok: false, code: result.code, message: result.message };
}

function validateItemFields(value: JsonRecord, allowed: Record<string, boolean>): ValidationResult<boolean> {
  var keys = Object.keys(value);
  for (var index = 0; index < keys.length; index++) {
    if (!allowed[keys[index]]) {
      return { ok: false, code: "UNKNOWN_PROFILE_FIELD", message: "Unsupported profile field: " + keys[index] };
    }
  }
  return { ok: true, value: true };
}

function prepareItem(value: unknown, actorSource: string): ValidationResult<PreparedInput> {
  if (!isJsonRecord(value)) return { ok: false, code: "INVALID_PROFILE", message: "Each profile must be an object" };
  var traitsResult = sanitizeTraits(value.traits);
  if (!traitsResult.ok) return failure<PreparedInput>(traitsResult);
  if (value.emdash_user_id !== undefined && value.emdash_user_id !== null) {
    var emdashFieldsResult = validateItemFields(value, EMDASH_PROFILE_FIELDS);
    if (!emdashFieldsResult.ok) return failure<PreparedInput>(emdashFieldsResult);
    var userIdResult = validateIdentityToken(value.emdash_user_id, 160);
    if (!userIdResult.ok || !userIdResult.value) return failure<PreparedInput>(userIdResult);
    if (value.external_id !== undefined || value.external_source !== undefined) {
      return { ok: false, code: "AMBIGUOUS_IDENTITY", message: "EmDash profiles cannot include an external identity" };
    }
    if (value.email !== undefined || value.name !== undefined || value.role !== undefined) {
      return {
        ok: false,
        code: "FIELD_OWNERSHIP_VIOLATION",
        message: "Email, name, and role are owned by the EmDash user migration"
      };
    }
    if (traitsResult.value && traitsResult.value.user_created_at !== undefined) {
      return {
        ok: false,
        code: "FIELD_OWNERSHIP_VIOLATION",
        message: "user_created_at is owned by the EmDash user migration"
      };
    }
    return { ok: true, value: { profile_id: "emdash:" + userIdResult.value, value: value, kind: "emdash" } };
  }
  var externalFieldsResult = validateItemFields(value, EXTERNAL_PROFILE_FIELDS);
  if (!externalFieldsResult.ok) return failure<PreparedInput>(externalFieldsResult);
  var sourceResult = normalizeSource(value.external_source || actorSource);
  if (!sourceResult.ok || !sourceResult.value) return failure<PreparedInput>(sourceResult);
  if (sourceResult.value !== actorSource) {
    return {
      ok: false,
      code: "SOURCE_NAMESPACE_MISMATCH",
      message: "external_source must match the mutation envelope source"
    };
  }
  value.external_source = sourceResult.value;
  var externalIdResult = validateIdentityToken(value.external_id, 160);
  if (!externalIdResult.ok || !externalIdResult.value) return failure<PreparedInput>(externalIdResult);
  return {
    ok: true,
    value: {
      profile_id: "external:" + sourceResult.value + ":" + externalIdResult.value,
      value: value,
      kind: "external"
    }
  };
}

export async function upsertProfilesBatch(
  ctx: CrmContext,
  input: JsonRecord,
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  actorSource: string,
  payloadFingerprint: string
): Promise<JsonRecord> {
  if (!Array.isArray(input.profiles) || input.profiles.length === 0 || input.profiles.length > PROFILE_BATCH_LIMIT) {
    return {
      ok: false,
      error: { code: "INVALID_BATCH_SIZE", message: "profiles must contain 1 to " + PROFILE_BATCH_LIMIT + " items" }
    };
  }
  var prepared: PreparedInput[] = [];
  var profileIds: string[] = [];
  var seen: Record<string, boolean> = {};
  for (var index = 0; index < input.profiles.length; index++) {
    var itemResult = prepareItem(input.profiles[index], actorSource);
    if (!itemResult.ok || !itemResult.value) {
      return {
        ok: false,
        error: { code: itemResult.code || "INVALID_PROFILE", message: itemResult.message || "Invalid profile", item_index: index }
      };
    }
    if (seen[itemResult.value.profile_id]) {
      return { ok: false, error: { code: "DUPLICATE_PROFILE", message: "Duplicate profile identity in batch", item_index: index } };
    }
    seen[itemResult.value.profile_id] = true;
    prepared.push(itemResult.value);
    profileIds.push(itemResult.value.profile_id);
  }

  var existingProfiles = await ctx.storage.profiles.getMany(profileIds);
  var projected: ProjectedProfileResult[] = [];
  var outcomes: Array<"created" | "updated" | "unchanged"> = [];
  for (var projectIndex = 0; projectIndex < prepared.length; projectIndex++) {
    var preparedItem = prepared[projectIndex];
    var existing = existingProfiles.get(preparedItem.profile_id) || null;
    if (existing && existing.last_ingest_request_id === requestId && existing.last_ingest_outcome) {
      if (existing.last_ingest_fingerprint !== payloadFingerprint) {
        return {
          ok: false,
          error: { code: "REQUEST_ID_CONFLICT", message: "request_id was already used with a different payload" }
        };
      }
      outcomes.push(existing.last_ingest_outcome);
      projected.push({ profile: existing, changed: existing.last_ingest_outcome !== "unchanged" });
      continue;
    }
    if (preparedItem.kind === "emdash") {
      if (!existing) {
        return {
          ok: false,
          error: {
            code: "EMDASH_MIGRATION_REQUIRED",
            message: "Run the EmDash user migration before applying CRM traits",
            item_index: projectIndex
          }
        };
      }
      var appliedResult = applyProfileTraits(
        existing,
        preparedItem.value.traits,
        occurredAt,
        preparedItem.value.consent_evidence
      );
      if (!appliedResult.ok || !appliedResult.value) {
        return {
          ok: false,
          error: { code: appliedResult.code || "INVALID_TRAITS", message: appliedResult.message || "Invalid traits", item_index: projectIndex }
        };
      }
      projected.push(appliedResult.value);
      outcomes.push(appliedResult.value.changed ? "updated" : "unchanged");
    } else {
      var externalResult = projectExternalProfile(preparedItem.value, existing, occurredAt);
      if (!externalResult.ok || !externalResult.value) {
        return {
          ok: false,
          error: { code: externalResult.code || "INVALID_PROFILE", message: externalResult.message || "Invalid profile", item_index: projectIndex }
        };
      }
      projected.push(externalResult.value);
      outcomes.push(!existing ? "created" : externalResult.value.changed ? "updated" : "unchanged");
    }
  }

  var profileWrites: Array<{ id: string; data: CrmProfile }> = [];
  var eventWrites: Array<{ id: string; data: CrmEvent }> = [];
  var created = 0;
  var updated = 0;
  var unchanged = 0;
  for (var writeIndex = 0; writeIndex < projected.length; writeIndex++) {
    var projection = projected[writeIndex];
    var profileId = prepared[writeIndex].profile_id;
    var outcome = outcomes[writeIndex];
    if (outcome === "created") created++;
    else if (outcome === "updated") updated++;
    else unchanged++;
    projection.profile.last_ingest_request_id = requestId;
    projection.profile.last_ingest_fingerprint = payloadFingerprint;
    projection.profile.last_ingest_outcome = outcome;
    projection.profile.last_ingest_source = actorSource;
    profileWrites.push({ id: profileId, data: projection.profile });
    var profileEventId = eventId("profile_upserted", requestId, profileId);
    var profileEvent: CrmEvent = {
      id: profileEventId,
      type: "profile_upserted",
      profile_id: profileId,
      segment_key: null,
      request_id: requestId,
      occurred_at: occurredAt,
      metadata: {
        changed: outcome !== "unchanged",
        outcome: outcome,
        identity_source: projection.profile.source,
        source: actorSource
      }
    };
    eventWrites.push({ id: profileEventId, data: profileEvent });
  }

  if (!dryRun) {
    await ctx.storage.profiles.putMany(profileWrites);
    await ctx.storage.events.putMany(eventWrites);
    if (created + updated > 0) await bumpProfileEpoch(ctx, requestId);
  }
  return {
    ok: true,
    data: {
      dry_run: dryRun,
      requested: prepared.length,
      created: created,
      updated: updated,
      unchanged: unchanged,
      profile_ids: profileIds
    }
  };
}
