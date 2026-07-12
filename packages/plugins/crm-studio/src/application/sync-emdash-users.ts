import type { CrmContext, CrmEvent, CrmProfile, JsonRecord } from "../types.js";
import { eventId, receiptId } from "../domain/membership.js";
import { USER_MIGRATION_PAGE_LIMIT } from "../domain/limits.js";
import { projectEmDashUser } from "../domain/profile.js";
import { bumpProfileEpoch } from "../infrastructure/repositories.js";

export interface MigrationState extends JsonRecord {
  epoch: string;
  status: "idle" | "running" | "completed" | "failed";
  cursor: string | null;
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  last_request_id: string | null;
  last_request_receipt_required: boolean;
  last_input_fingerprint: string | null;
  last_result: JsonRecord | null;
}

function emptyState(): MigrationState {
  return {
    epoch: "",
    status: "idle",
    cursor: null,
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    started_at: null,
    completed_at: null,
    last_error: null,
    last_request_id: null,
    last_request_receipt_required: false,
    last_input_fingerprint: null,
    last_result: null
  };
}

export function migrationStateView(state: MigrationState): JsonRecord {
  return {
    epoch: state.epoch,
    status: state.status,
    cursor: state.cursor,
    processed: state.processed,
    created: state.created,
    updated: state.updated,
    unchanged: state.unchanged,
    started_at: state.started_at,
    completed_at: state.completed_at,
    last_error: state.last_error
  };
}

export async function getMigrationState(ctx: CrmContext): Promise<MigrationState> {
  var state = await ctx.kv.get<MigrationState>("state:emdashUserMigration");
  return state || emptyState();
}

export async function syncEmDashUsersStep(
  ctx: CrmContext,
  input: JsonRecord,
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  actorSource: string,
  payloadFingerprint: string,
  receiptRequired: boolean
): Promise<JsonRecord> {
  if (!ctx.users) return { ok: false, error: { code: "USERS_CAPABILITY_MISSING", message: "users:read is unavailable" } };
  var limit = input.limit === undefined ? USER_MIGRATION_PAGE_LIMIT : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > USER_MIGRATION_PAGE_LIMIT) {
    return {
      ok: false,
      error: { code: "INVALID_LIMIT", message: "limit must be between 1 and " + USER_MIGRATION_PAGE_LIMIT }
    };
  }

  var previous = await getMigrationState(ctx);
  if (previous.last_request_id === requestId && previous.last_result) {
    if (previous.last_input_fingerprint !== payloadFingerprint) {
      return { ok: false, error: { code: "REQUEST_ID_CONFLICT", message: "request_id was already used with a different payload" } };
    }
    return previous.last_result;
  }
  if (previous.last_request_receipt_required && previous.last_request_id) {
    var previousReceipt = await ctx.storage.ingestRequests.get(receiptId(previous.last_request_id));
    if (!previousReceipt || (previousReceipt.status !== "completed" && previousReceipt.status !== "checkpointed")) {
      return {
        ok: false,
        error: {
          code: "PREVIOUS_STEP_UNCONFIRMED",
          message: "Retry the previous migration request_id before advancing the cursor"
        }
      };
    }
  }
  var restart = input.restart === true;
  if (previous.status === "completed" && !restart && !dryRun) {
    return {
      ok: true,
      data: {
        already_completed: true,
        state: migrationStateView(previous),
        message: "Set restart=true to begin a new reconciliation epoch"
      }
    };
  }
  var state = previous;
  if (restart || previous.status === "idle" || !previous.epoch) {
    state = {
      epoch: requestId,
      status: "running",
      cursor: null,
      processed: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      started_at: occurredAt,
      completed_at: null,
      last_error: null,
      last_request_id: null,
      last_request_receipt_required: false,
      last_input_fingerprint: null,
      last_result: null
    };
  }

  var page = await ctx.users.list({ limit: limit, cursor: state.cursor || undefined });
  var profileIds: string[] = [];
  for (var idIndex = 0; idIndex < page.items.length; idIndex++) {
    profileIds.push("emdash:" + page.items[idIndex].id);
  }
  var existingProfiles = await ctx.storage.profiles.getMany(profileIds);
  var profileWrites: Array<{ id: string; data: CrmProfile }> = [];
  var created = 0;
  var updated = 0;
  var unchanged = 0;
  for (var index = 0; index < page.items.length; index++) {
    var user = page.items[index];
    var profileId = profileIds[index];
    var existing = existingProfiles.get(profileId) || null;
    if (existing && existing.last_migration_request_id === requestId && existing.last_migration_outcome) {
      if (existing.last_migration_fingerprint !== payloadFingerprint) {
        return {
          ok: false,
          error: { code: "REQUEST_ID_CONFLICT", message: "request_id was already used with a different payload" }
        };
      }
      if (existing.last_migration_outcome === "created") created++;
      else if (existing.last_migration_outcome === "updated") updated++;
      else unchanged++;
      profileWrites.push({ id: profileId, data: existing });
      continue;
    }
    var projected = projectEmDashUser(user, existing, {}, occurredAt);
    var outcome: "created" | "updated" | "unchanged" = !existing
      ? "created"
      : projected.changed ? "updated" : "unchanged";
    if (outcome === "created") created++;
    else if (outcome === "updated") updated++;
    else unchanged++;
    projected.profile.last_migration_request_id = requestId;
    projected.profile.last_migration_fingerprint = payloadFingerprint;
    projected.profile.last_migration_outcome = outcome;
    profileWrites.push({ id: profileId, data: projected.profile });
  }

  var nextState: MigrationState = {
    epoch: state.epoch,
    status: page.nextCursor ? "running" : "completed",
    cursor: page.nextCursor || null,
    processed: state.processed + page.items.length,
    created: state.created + created,
    updated: state.updated + updated,
    unchanged: state.unchanged + unchanged,
    started_at: state.started_at,
    completed_at: page.nextCursor ? null : occurredAt,
    last_error: null,
    last_request_id: null,
    last_request_receipt_required: false,
    last_input_fingerprint: null,
    last_result: null
  };

  var response: JsonRecord = {
    ok: true,
    data: {
      dry_run: dryRun,
      batch: { processed: page.items.length, created: created, updated: updated, unchanged: unchanged },
      state: migrationStateView(nextState)
    }
  };

  if (!dryRun) {
    if (profileWrites.length > 0) await ctx.storage.profiles.putMany(profileWrites);
    var migrationEventId = eventId("emdash_users_migrated", requestId, state.epoch + ":" + (state.cursor || "start"));
    var migrationEvent: CrmEvent = {
      id: migrationEventId,
      type: "emdash_users_migrated",
      profile_id: null,
      segment_key: null,
      request_id: requestId,
      occurred_at: occurredAt,
      metadata: {
        epoch: state.epoch,
        batch_size: page.items.length,
        created: created,
        updated: updated,
        unchanged: unchanged,
        has_more: !!page.nextCursor,
        source: actorSource
      }
    };
    await ctx.storage.events.put(migrationEventId, migrationEvent);
    if (created + updated > 0) await bumpProfileEpoch(ctx, requestId);
    nextState.last_request_id = requestId;
    nextState.last_request_receipt_required = receiptRequired;
    nextState.last_input_fingerprint = payloadFingerprint;
    nextState.last_result = response;
    await ctx.kv.set("state:emdashUserMigration", nextState);
  }
  return response;
}
