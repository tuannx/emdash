import type {
  CrmContext,
  CrmEvent,
  CrmProfile,
  CrmSegment,
  JsonRecord,
  MembershipHistory
} from "../types.js";
import { eventId, membershipHistoryId, receiptId } from "../domain/membership.js";
import { SEGMENT_RECOMPUTE_PAGE_LIMIT } from "../domain/limits.js";
import { stableStringify } from "../domain/profile.js";
import { normalizeSegmentKey, profileMatchesRule } from "../domain/rule.js";
import { getProfileEpoch } from "../infrastructure/repositories.js";

interface Candidate extends JsonRecord {
  profile_id: string;
  selection_key: string;
}

interface RecomputeState extends JsonRecord {
  segment_key: string;
  generation: string;
  status: "running" | "completed";
  phase: "scanning" | "materializing" | "completed";
  cursor: string | null;
  scanned: number;
  matched: number;
  selected: number;
  materialized: number;
  candidates: Candidate[];
  started_at: string;
  completed_at: string | null;
  segment_fingerprint: string;
  profile_epoch: number;
  last_request_id: string | null;
  last_request_receipt_required: boolean;
  last_input_fingerprint: string | null;
  last_result: JsonRecord | null;
}

function stateKey(segmentKey: string): string {
  return "state:segmentRecompute:" + segmentKey;
}

function segmentDefinitionFingerprint(segment: CrmSegment): string {
  return stableStringify({
    key: segment.key,
    rule: segment.rule,
    membership_limit: segment.membership_limit,
    kind: segment.kind,
    is_active: segment.is_active
  });
}

function recomputeStateView(state: RecomputeState): JsonRecord {
  return {
    segment_key: state.segment_key,
    generation: state.generation,
    status: state.status,
    phase: state.phase,
    cursor: state.cursor,
    scanned: state.scanned,
    matched: state.matched,
    selected: state.selected,
    materialized: state.materialized,
    started_at: state.started_at,
    completed_at: state.completed_at,
    profile_epoch: state.profile_epoch
  };
}

function profileSelectionKey(profile: CrmProfile): string {
  if (profile.emdash_user_id) return "0:" + profile.emdash_user_id;
  return "1:" + profile.id;
}

function mergeCandidates(existing: Candidate[], profiles: CrmProfile[], limit: number): Candidate[] {
  var byId: Record<string, Candidate> = {};
  for (var existingIndex = 0; existingIndex < existing.length; existingIndex++) {
    byId[existing[existingIndex].profile_id] = existing[existingIndex];
  }
  for (var profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
    var profile = profiles[profileIndex];
    byId[profile.id] = { profile_id: profile.id, selection_key: profileSelectionKey(profile) };
  }
  var candidates: Candidate[] = [];
  var ids = Object.keys(byId);
  for (var idIndex = 0; idIndex < ids.length; idIndex++) candidates.push(byId[ids[idIndex]]);
  candidates.sort(function(left, right) {
    var keyComparison = left.selection_key.localeCompare(right.selection_key);
    if (keyComparison !== 0) return keyComparison;
    return left.profile_id.localeCompare(right.profile_id);
  });
  return candidates.slice(0, limit);
}

function membershipWritesForIds(
  segment: CrmSegment,
  state: RecomputeState,
  profileIds: string[],
  occurredAt: string
): Array<{ id: string; data: MembershipHistory }> {
  var writes: Array<{ id: string; data: MembershipHistory }> = [];
  for (var index = 0; index < profileIds.length; index++) {
    var profileId = profileIds[index];
    var membershipId = membershipHistoryId(segment.key, profileId, state.generation);
    var membership: MembershipHistory = {
      id: membershipId,
      segment_key: segment.key,
      profile_id: profileId,
      status: "snapshot",
      generation: state.generation,
      request_id: state.generation,
      entered_at: state.started_at,
      exited_at: null,
      created_at: state.started_at,
      updated_at: occurredAt
    };
    writes.push({ id: membershipId, data: membership });
  }
  return writes;
}

async function activateGeneration(
  ctx: CrmContext,
  segment: CrmSegment,
  state: RecomputeState,
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  actorSource: string
): Promise<JsonRecord | null> {
  if (dryRun) return null;
  if (await getProfileEpoch(ctx) !== state.profile_epoch) {
    return {
      ok: false,
      error: {
        code: "PROFILES_CHANGED_DURING_RECOMPUTE",
        message: "Profiles changed before activation. Restart the recompute"
      }
    };
  }
  var freshSegment = await ctx.storage.segments.get(segment.id);
  if (!freshSegment || segmentDefinitionFingerprint(freshSegment) !== state.segment_fingerprint) {
    return {
      ok: false,
      error: {
        code: "SEGMENT_CHANGED_DURING_RECOMPUTE",
        message: "Segment definition changed before activation. Restart the recompute"
      }
    };
  }
  var activeReferences = await ctx.storage.programs.query({
    where: { audience_segment_key: segment.key, is_active: true },
    limit: 1
  });
  if (activeReferences.items.length > 0) {
    var activeMemberCount = await ctx.storage.segmentMemberships.count({
      segment_key: segment.key,
      generation: state.generation,
      status: "snapshot"
    });
    if (activeMemberCount < 1) {
      return {
        ok: false,
        error: {
          code: "SEGMENT_REQUIRED_BY_ACTIVE_PROGRAM",
          message: "The new generation is empty; deactivate dependent programs before activation"
        }
      };
    }
  }
  var completedEventId = eventId("segment_recomputed", requestId, segment.key + ":" + state.generation);
  var completedEvent: CrmEvent = {
    id: completedEventId,
    type: "segment_recomputed",
    profile_id: null,
    segment_key: segment.key,
    request_id: requestId,
    occurred_at: occurredAt,
    metadata: {
      generation: state.generation,
      scanned: state.scanned,
      matched: state.matched,
      selected: state.selected,
      membership_limit: freshSegment.membership_limit,
      source: actorSource
    }
  };
  await ctx.storage.events.put(completedEventId, completedEvent);
  freshSegment.active_generation = state.generation;
  freshSegment.last_recomputed_at = occurredAt;
  await ctx.storage.segments.put(freshSegment.id, freshSegment);
  return null;
}

export async function getRecomputeState(ctx: CrmContext, segmentKey: string): Promise<RecomputeState | null> {
  return await ctx.kv.get<RecomputeState>(stateKey(segmentKey));
}

export async function recomputeSegmentStep(
  ctx: CrmContext,
  input: JsonRecord,
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  actorSource: string,
  payloadFingerprint: string,
  receiptRequired: boolean
): Promise<JsonRecord> {
  var keyResult = normalizeSegmentKey(input.segment_key);
  if (!keyResult.ok || !keyResult.value) {
    return { ok: false, error: { code: keyResult.code || "INVALID_SEGMENT_KEY", message: keyResult.message || "Invalid segment key" } };
  }
  var segment = await ctx.storage.segments.get("segment:" + keyResult.value);
  if (!segment) return { ok: false, error: { code: "SEGMENT_NOT_FOUND", message: "Segment does not exist" } };
  if (segment.kind !== "dynamic" || !segment.rule) {
    return { ok: false, error: { code: "STATIC_SEGMENT_RECOMPUTE_DENIED", message: "Static segments are managed through member add/remove APIs" } };
  }
  if (!segment.is_active) return { ok: false, error: { code: "SEGMENT_INACTIVE", message: "Segment is inactive" } };

  var definitionFingerprint = segmentDefinitionFingerprint(segment);
  var currentProfileEpoch = await getProfileEpoch(ctx);
  var prior = await getRecomputeState(ctx, segment.key);
  if (prior && prior.last_request_id === requestId && prior.last_result) {
    if (prior.last_input_fingerprint !== payloadFingerprint) {
      return { ok: false, error: { code: "REQUEST_ID_CONFLICT", message: "request_id was already used with a different payload" } };
    }
    return prior.last_result;
  }
  if (prior && prior.last_request_receipt_required && prior.last_request_id) {
    var previousReceipt = await ctx.storage.ingestRequests.get(receiptId(prior.last_request_id));
    if (!previousReceipt || (previousReceipt.status !== "completed" && previousReceipt.status !== "checkpointed")) {
      return {
        ok: false,
        error: {
          code: "PREVIOUS_STEP_UNCONFIRMED",
          message: "Retry the previous recompute request_id before advancing this generation"
        }
      };
    }
  }
  var restart = input.restart === true;
  var state: RecomputeState;
  if (!prior || restart || prior.status === "completed") {
    state = {
      segment_key: segment.key,
      generation: "gen:" + requestId,
      status: "running",
      phase: "scanning",
      cursor: null,
      scanned: 0,
      matched: 0,
      selected: 0,
      materialized: 0,
      candidates: [],
      started_at: occurredAt,
      completed_at: null,
      segment_fingerprint: definitionFingerprint,
      profile_epoch: currentProfileEpoch,
      last_request_id: null,
      last_request_receipt_required: false,
      last_input_fingerprint: null,
      last_result: null
    };
  } else {
    state = prior;
    if (state.segment_fingerprint !== definitionFingerprint) {
      return {
        ok: false,
        error: {
          code: "SEGMENT_CHANGED_DURING_RECOMPUTE",
          message: "Segment definition changed. Retry with restart=true to create a new generation"
        }
      };
    }
    if (state.profile_epoch !== currentProfileEpoch) {
      return {
        ok: false,
        error: {
          code: "PROFILES_CHANGED_DURING_RECOMPUTE",
          message: "Profiles changed during the scan. Retry with restart=true"
        }
      };
    }
  }

  if (state.phase === "materializing") {
    var candidatePage = state.candidates.slice(
      state.materialized,
      state.materialized + SEGMENT_RECOMPUTE_PAGE_LIMIT
    );
    var candidateIds: string[] = [];
    for (var candidateIndex = 0; candidateIndex < candidatePage.length; candidateIndex++) {
      candidateIds.push(candidatePage[candidateIndex].profile_id);
    }
    var candidateProfiles = await ctx.storage.profiles.getMany(candidateIds);
    var currentCandidateIds: string[] = [];
    for (var currentIndex = 0; currentIndex < candidateIds.length; currentIndex++) {
      var currentProfile = candidateProfiles.get(candidateIds[currentIndex]);
      if (currentProfile && profileMatchesRule(currentProfile, segment.rule)) {
        currentCandidateIds.push(currentProfile.id);
      }
    }
    var materializeWrites = membershipWritesForIds(segment, state, currentCandidateIds, occurredAt);
    var materializedCount = state.materialized + candidateIds.length;
    var materializationComplete = materializedCount >= state.candidates.length;
    var materializedState: RecomputeState = {
      segment_key: state.segment_key,
      generation: state.generation,
      status: materializationComplete ? "completed" : "running",
      phase: materializationComplete ? "completed" : "materializing",
      cursor: null,
      scanned: state.scanned,
      matched: state.matched,
      selected: state.selected,
      materialized: materializedCount,
      candidates: state.candidates,
      started_at: state.started_at,
      completed_at: materializationComplete ? occurredAt : null,
      segment_fingerprint: state.segment_fingerprint,
      profile_epoch: state.profile_epoch,
      last_request_id: null,
      last_request_receipt_required: false,
      last_input_fingerprint: null,
      last_result: null
    };
    var materializedResponse: JsonRecord = {
      ok: true,
      data: {
        dry_run: dryRun,
        batch: { scanned: 0, matched: 0, selected: 0, materialized: currentCandidateIds.length },
        state: recomputeStateView(materializedState),
        activated: !dryRun && materializationComplete
      }
    };
    if (!dryRun && materializeWrites.length > 0) await ctx.storage.segmentMemberships.putMany(materializeWrites);
    if (materializationComplete) {
      var materializeActivationError = await activateGeneration(
        ctx,
        segment,
        materializedState,
        requestId,
        occurredAt,
        dryRun,
        actorSource
      );
      if (materializeActivationError) return materializeActivationError;
    }
    if (!dryRun) {
      materializedState.last_request_id = requestId;
      materializedState.last_request_receipt_required = receiptRequired;
      materializedState.last_input_fingerprint = payloadFingerprint;
      materializedState.last_result = materializedResponse;
      await ctx.kv.set(stateKey(segment.key), materializedState);
    }
    return materializedResponse;
  }

  var page = await ctx.storage.profiles.query({
    limit: SEGMENT_RECOMPUTE_PAGE_LIMIT,
    cursor: state.cursor || undefined
  });
  var matchingProfiles: CrmProfile[] = [];
  for (var profileIndex = 0; profileIndex < page.items.length; profileIndex++) {
    var profile = page.items[profileIndex].data;
    if (profileMatchesRule(profile, segment.rule)) matchingProfiles.push(profile);
  }

  var candidates = state.candidates;
  var selectedProfiles = matchingProfiles;
  var membershipWrites: Array<{ id: string; data: MembershipHistory }> = [];
  if (segment.membership_limit !== null) {
    candidates = mergeCandidates(state.candidates, matchingProfiles, segment.membership_limit);
    selectedProfiles = [];
  } else {
    var selectedIds: string[] = [];
    for (var matchIndex = 0; matchIndex < matchingProfiles.length; matchIndex++) selectedIds.push(matchingProfiles[matchIndex].id);
    membershipWrites = membershipWritesForIds(segment, state, selectedIds, occurredAt);
  }

  var scanComplete = !page.hasMore;
  var needsMaterialization = scanComplete && segment.membership_limit !== null && candidates.length > 0;
  var completesEmptyGeneration = scanComplete && segment.membership_limit !== null && candidates.length === 0;
  var nextState: RecomputeState = {
    segment_key: state.segment_key,
    generation: state.generation,
    status: completesEmptyGeneration || (scanComplete && segment.membership_limit === null) ? "completed" : "running",
    phase: needsMaterialization ? "materializing" : scanComplete ? "completed" : "scanning",
    cursor: page.cursor || null,
    scanned: state.scanned + page.items.length,
    matched: state.matched + matchingProfiles.length,
    selected: segment.membership_limit === null ? state.selected + selectedProfiles.length : candidates.length,
    materialized: state.materialized,
    candidates: candidates,
    started_at: state.started_at,
    completed_at: completesEmptyGeneration || (scanComplete && segment.membership_limit === null) ? occurredAt : null,
    segment_fingerprint: state.segment_fingerprint,
    profile_epoch: state.profile_epoch,
    last_request_id: null,
    last_request_receipt_required: false,
    last_input_fingerprint: null,
    last_result: null
  };

  var scanResponse: JsonRecord = {
    ok: true,
    data: {
      dry_run: dryRun,
      batch: {
        scanned: page.items.length,
        matched: matchingProfiles.length,
        selected: segment.membership_limit === null ? selectedProfiles.length : candidates.length,
        materialized: membershipWrites.length
      },
      state: recomputeStateView(nextState),
      activated: !dryRun && scanComplete && !needsMaterialization
    }
  };

  if (!dryRun && membershipWrites.length > 0) await ctx.storage.segmentMemberships.putMany(membershipWrites);
  var activatesNow = scanComplete && !needsMaterialization;
  if (activatesNow) {
    var scanActivationError = await activateGeneration(
      ctx,
      segment,
      nextState,
      requestId,
      occurredAt,
      dryRun,
      actorSource
    );
    if (scanActivationError) return scanActivationError;
  }
  if (!dryRun) {
    nextState.last_request_id = requestId;
    nextState.last_request_receipt_required = receiptRequired;
    nextState.last_input_fingerprint = payloadFingerprint;
    nextState.last_result = scanResponse;
    await ctx.kv.set(stateKey(segment.key), nextState);
  }

  return scanResponse;
}
