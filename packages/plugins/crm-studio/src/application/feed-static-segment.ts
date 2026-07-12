import type {
  CrmContext,
  CrmEvent,
  CrmProfile,
  CrmSegment,
  JsonRecord,
  MembershipHistory,
  MembershipState,
  ValidationResult
} from "../types.js";
import { eventId, membershipHistoryId, membershipIdentity, membershipStateId } from "../domain/membership.js";
import { STATIC_MEMBERSHIP_BATCH_LIMIT } from "../domain/limits.js";
import { normalizeSegmentKey, buildSegment } from "../domain/rule.js";
import { stableStringify, validateIdentityToken } from "../domain/profile.js";
import { isJsonRecord } from "./contracts.js";
import { bumpSegmentMembershipEpoch } from "../infrastructure/repositories.js";

export interface FeedResult extends JsonRecord {
  segment_key: string;
  requested: number;
  added: number;
  already_members: number;
  removed: number;
  already_absent: number;
  profile_ids: string[];
}

function failure<T>(result: ValidationResult<unknown>): ValidationResult<T> {
  return { ok: false, code: result.code, message: result.message };
}

function validateProfileId(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") return { ok: false, code: "INVALID_PROFILE_ID", message: "profile_id must be a string" };
  var normalized = value.trim();
  if (!normalized || normalized.length > 260 || !/^(emdash|external):[A-Za-z0-9._:@-]+(?::[A-Za-z0-9._:@-]+)?$/.test(normalized)) {
    return { ok: false, code: "INVALID_PROFILE_ID", message: "profile_id is invalid" };
  }
  return { ok: true, value: normalized };
}

export function normalizeProfileIds(input: JsonRecord): ValidationResult<string[]> {
  var values: unknown[] = [];
  if (Array.isArray(input.profile_ids)) {
    for (var profileIndex = 0; profileIndex < input.profile_ids.length; profileIndex++) values.push(input.profile_ids[profileIndex]);
  }
  if (Array.isArray(input.emdash_user_ids)) {
    for (var userIndex = 0; userIndex < input.emdash_user_ids.length; userIndex++) {
      var userIdResult = validateIdentityToken(input.emdash_user_ids[userIndex], 160);
      if (!userIdResult.ok || !userIdResult.value) return failure<string[]>(userIdResult);
      values.push("emdash:" + userIdResult.value);
    }
  }
  if (values.length === 0 || values.length > STATIC_MEMBERSHIP_BATCH_LIMIT) {
    return {
      ok: false,
      code: "INVALID_BATCH_SIZE",
      message: "Provide 1 to " + STATIC_MEMBERSHIP_BATCH_LIMIT + " profile_ids or emdash_user_ids"
    };
  }
  var seen: Record<string, boolean> = {};
  var output: string[] = [];
  for (var index = 0; index < values.length; index++) {
    var profileIdResult = validateProfileId(values[index]);
    if (!profileIdResult.ok || !profileIdResult.value) return failure<string[]>(profileIdResult);
    if (seen[profileIdResult.value]) {
      return { ok: false, code: "DUPLICATE_PROFILE", message: "Duplicate profile_id in request" };
    }
    seen[profileIdResult.value] = true;
    output.push(profileIdResult.value);
  }
  return { ok: true, value: output };
}

export async function resolveStaticSegment(ctx: CrmContext, keyValue: unknown): Promise<ValidationResult<CrmSegment>> {
  var keyResult = normalizeSegmentKey(keyValue);
  if (!keyResult.ok || !keyResult.value) return failure<CrmSegment>(keyResult);
  var segment = await ctx.storage.segments.get("segment:" + keyResult.value);
  if (!segment) return { ok: false, code: "SEGMENT_NOT_FOUND", message: "Segment does not exist" };
  if (!segment.is_active) return { ok: false, code: "SEGMENT_INACTIVE", message: "Segment is inactive" };
  if (segment.kind !== "static") {
    return { ok: false, code: "DYNAMIC_SEGMENT_FEED_DENIED", message: "Dynamic segments must be recomputed from whitelisted traits" };
  }
  return { ok: true, value: segment };
}

export async function resolveProfiles(ctx: CrmContext, profileIds: string[]): Promise<ValidationResult<CrmProfile[]>> {
  var profileMap = await ctx.storage.profiles.getMany(profileIds);
  var profiles: CrmProfile[] = [];
  var missing: string[] = [];
  for (var index = 0; index < profileIds.length; index++) {
    var profile = profileMap.get(profileIds[index]);
    if (profile) profiles.push(profile);
    else missing.push(profileIds[index]);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: "PROFILE_NOT_FOUND",
      message: "Migrate or upsert every profile before adding segment membership: " + missing.join(", ")
    };
  }
  return { ok: true, value: profiles };
}

function staleMembershipMutation(current: MembershipState | undefined, occurredAt: string, requestId: string): boolean {
  if (!current) return false;
  var incomingTime = Date.parse(occurredAt);
  var currentTime = Date.parse(current.updated_at);
  if (incomingTime < currentTime) return true;
  if (incomingTime > currentTime || !current.last_request_id) return false;
  return requestId < current.last_request_id;
}

export async function addProfilesToStaticSegment(
  ctx: CrmContext,
  segment: CrmSegment,
  profiles: CrmProfile[],
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  actorSource: string
): Promise<ValidationResult<FeedResult>> {
  var stateIds: string[] = [];
  for (var stateIndex = 0; stateIndex < profiles.length; stateIndex++) {
    stateIds.push(membershipStateId(segment.key, profiles[stateIndex].id));
  }
  var states = await ctx.storage.segmentMembershipStates.getMany(stateIds);
  var historyWrites: Array<{ id: string; data: MembershipHistory }> = [];
  var stateWrites: Array<{ id: string; data: MembershipState }> = [];
  var eventWrites: Array<{ id: string; data: CrmEvent }> = [];
  var addedIds: string[] = [];
  var alreadyMembers = 0;

  for (var staleIndex = 0; staleIndex < stateIds.length; staleIndex++) {
    if (staleMembershipMutation(states.get(stateIds[staleIndex]), occurredAt, requestId)) {
      return {
        ok: false,
        code: "STALE_MEMBERSHIP_UPDATE",
        message: "Membership update is older than the current state for " + profiles[staleIndex].id
      };
    }
  }

  for (var index = 0; index < profiles.length; index++) {
    var profile = profiles[index];
    var stateId = stateIds[index];
    var current = states.get(stateId);
    if (current && current.last_request_id === requestId && current.last_request_action === "add") {
      if (current.last_request_outcome === "added") addedIds.push(profile.id);
      else alreadyMembers++;
      continue;
    }
    if (current && current.status === "open") {
      alreadyMembers++;
      continue;
    }
    var currentVersion = current && Number.isInteger(current.entry_version) ? current.entry_version : current ? 1 : 0;
    var nextVersion = currentVersion + 1;
    var historyId = membershipHistoryId(segment.key, profile.id, "entry:" + nextVersion);
    var identityKey = membershipIdentity(segment.key, profile.id);
    var history: MembershipHistory = {
      id: historyId,
      segment_key: segment.key,
      profile_id: profile.id,
      status: "open",
      generation: "static",
      request_id: requestId,
      entered_at: occurredAt,
      exited_at: null,
      created_at: occurredAt,
      updated_at: occurredAt
    };
    var state: MembershipState = {
      id: stateId,
      identity_key: identityKey,
      segment_key: segment.key,
      profile_id: profile.id,
      status: "open",
      membership_id: historyId,
      entry_version: nextVersion,
      generation: "static",
      entered_at: occurredAt,
      exited_at: null,
      updated_at: occurredAt,
      last_request_id: requestId,
      last_request_action: "add",
      last_request_outcome: "added"
    };
    var createdEventId = eventId("segment_entered", requestId, identityKey);
    var event: CrmEvent = {
      id: createdEventId,
      type: "segment_entered",
      profile_id: profile.id,
      segment_key: segment.key,
      request_id: requestId,
      occurred_at: occurredAt,
      metadata: { membership_id: historyId, kind: "static", source: actorSource }
    };
    historyWrites.push({ id: historyId, data: history });
    eventWrites.push({ id: createdEventId, data: event });
    stateWrites.push({ id: stateId, data: state });
    addedIds.push(profile.id);
  }

  if (!dryRun && historyWrites.length > 0) {
    // State is written last. A retry after any partial failure replays the
    // deterministic history/event IDs and repairs the open-state pointer.
    await ctx.storage.segmentMemberships.putMany(historyWrites);
    await ctx.storage.events.putMany(eventWrites);
    await ctx.storage.segmentMembershipStates.putMany(stateWrites);
  }
  if (!dryRun && addedIds.length > 0) await bumpSegmentMembershipEpoch(ctx, segment.key, requestId);

  return {
    ok: true,
    value: {
      segment_key: segment.key,
      requested: profiles.length,
      added: addedIds.length,
      already_members: alreadyMembers,
      removed: 0,
      already_absent: 0,
      profile_ids: addedIds
    }
  };
}

export async function removeProfilesFromStaticSegment(
  ctx: CrmContext,
  segment: CrmSegment,
  profiles: CrmProfile[],
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  actorSource: string
): Promise<ValidationResult<FeedResult>> {
  var stateIds: string[] = [];
  for (var stateIndex = 0; stateIndex < profiles.length; stateIndex++) {
    stateIds.push(membershipStateId(segment.key, profiles[stateIndex].id));
  }
  var states = await ctx.storage.segmentMembershipStates.getMany(stateIds);
  var historyIds: string[] = [];
  for (var historyIndex = 0; historyIndex < stateIds.length; historyIndex++) {
    var stateForHistory = states.get(stateIds[historyIndex]);
    if (stateForHistory && stateForHistory.status === "open" && stateForHistory.membership_id) {
      historyIds.push(stateForHistory.membership_id);
    }
  }
  var histories = await ctx.storage.segmentMemberships.getMany(historyIds);
  var historyWrites: Array<{ id: string; data: MembershipHistory }> = [];
  var stateWrites: Array<{ id: string; data: MembershipState }> = [];
  var eventWrites: Array<{ id: string; data: CrmEvent }> = [];
  var removedIds: string[] = [];
  var alreadyAbsent = 0;

  for (var staleIndex = 0; staleIndex < stateIds.length; staleIndex++) {
    if (staleMembershipMutation(states.get(stateIds[staleIndex]), occurredAt, requestId)) {
      return {
        ok: false,
        code: "STALE_MEMBERSHIP_UPDATE",
        message: "Membership update is older than the current state for " + profiles[staleIndex].id
      };
    }
  }

  for (var index = 0; index < profiles.length; index++) {
    var profile = profiles[index];
    var stateId = stateIds[index];
    var current = states.get(stateId);
    if (current && current.last_request_id === requestId && current.last_request_action === "remove") {
      if (current.last_request_outcome === "removed") removedIds.push(profile.id);
      else alreadyAbsent++;
      continue;
    }
    if (!current || current.status !== "open" || !current.membership_id) {
      alreadyAbsent++;
      continue;
    }
    var history = histories.get(current.membership_id);
    if (!history) throw new Error("Open membership history is missing for " + current.membership_id);
    history.status = "closed";
    history.exited_at = occurredAt;
    history.updated_at = occurredAt;
    current.status = "closed";
    current.exited_at = occurredAt;
    current.updated_at = occurredAt;
    current.entry_version = Number.isInteger(current.entry_version) ? current.entry_version : 1;
    current.last_request_id = requestId;
    current.last_request_action = "remove";
    current.last_request_outcome = "removed";
    var identityKey = membershipIdentity(segment.key, profile.id);
    var closedEventId = eventId("segment_exited", requestId, identityKey);
    var event: CrmEvent = {
      id: closedEventId,
      type: "segment_exited",
      profile_id: profile.id,
      segment_key: segment.key,
      request_id: requestId,
      occurred_at: occurredAt,
      metadata: { membership_id: history.id, kind: "static", source: actorSource }
    };
    historyWrites.push({ id: history.id, data: history });
    eventWrites.push({ id: closedEventId, data: event });
    stateWrites.push({ id: stateId, data: current });
    removedIds.push(profile.id);
  }

  if (stateWrites.length > 0) {
    var activeReferences = await ctx.storage.programs.query({
      where: { audience_segment_key: segment.key, is_active: true },
      limit: 1
    });
    if (activeReferences.items.length > 0) {
      var currentOpenCount = await ctx.storage.segmentMembershipStates.count({ segment_key: segment.key, status: "open" });
      if (currentOpenCount - stateWrites.length < 1) {
        return {
          ok: false,
          code: "SEGMENT_REQUIRED_BY_ACTIVE_PROGRAM",
          message: "Deactivate programs that use this audience before removing its last member"
        };
      }
    }
  }

  if (!dryRun && historyWrites.length > 0) {
    await ctx.storage.segmentMemberships.putMany(historyWrites);
    await ctx.storage.events.putMany(eventWrites);
    await ctx.storage.segmentMembershipStates.putMany(stateWrites);
  }
  if (!dryRun && removedIds.length > 0) await bumpSegmentMembershipEpoch(ctx, segment.key, requestId);

  return {
    ok: true,
    value: {
      segment_key: segment.key,
      requested: profiles.length,
      added: 0,
      already_members: 0,
      removed: removedIds.length,
      already_absent: alreadyAbsent,
      profile_ids: removedIds
    }
  };
}

export async function upsertSegment(ctx: CrmContext, input: JsonRecord, timestamp: string, dryRun: boolean): Promise<ValidationResult<CrmSegment>> {
  var keyResult = normalizeSegmentKey(input.key);
  if (!keyResult.ok || !keyResult.value) return failure<CrmSegment>(keyResult);
  var existing = await ctx.storage.segments.get("segment:" + keyResult.value);
  var segmentResult = buildSegment(input, existing, timestamp);
  if (!segmentResult.ok || !segmentResult.value) return segmentResult;
  if (existing) {
    var currentDefinition = stableStringify({
      name: existing.name,
      description: existing.description,
      kind: existing.kind,
      evaluation_mode: existing.evaluation_mode,
      rule: existing.rule,
      membership_limit: existing.membership_limit,
      group_key: existing.group_key,
      is_active: existing.is_active
    });
    var nextDefinition = stableStringify({
      name: segmentResult.value.name,
      description: segmentResult.value.description,
      kind: segmentResult.value.kind,
      evaluation_mode: segmentResult.value.evaluation_mode,
      rule: segmentResult.value.rule,
      membership_limit: segmentResult.value.membership_limit,
      group_key: segmentResult.value.group_key,
      is_active: segmentResult.value.is_active
    });
    if (currentDefinition !== nextDefinition) {
      var activeReferences = existing.key === "crm_blacklist" || existing.key === "paid_tv_users"
        ? await ctx.storage.programs.query({ where: { is_active: true }, limit: 1 })
        : await ctx.storage.programs.query({
            where: { audience_segment_key: existing.key, is_active: true },
            limit: 1
          });
      if (activeReferences.items.length > 0) {
        return {
          ok: false,
          code: "SEGMENT_IN_USE",
          message: "Deactivate programs that reference this segment before changing its definition"
        };
      }
    }
  }
  if (!dryRun) await ctx.storage.segments.put(segmentResult.value.id, segmentResult.value);
  return segmentResult;
}

export function parseSegmentInput(input: unknown): ValidationResult<JsonRecord> {
  if (!isJsonRecord(input)) return { ok: false, code: "INVALID_BODY", message: "JSON object body is required" };
  return { ok: true, value: input };
}
