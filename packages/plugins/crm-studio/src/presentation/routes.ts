import type {
  CrmContext,
  CrmEvent,
  CrmSegment,
  JsonRecord,
  SandboxedRouteInput
} from "../types.js";
import type { MutationEnvelope } from "../application/contracts.js";
import {
  apiError,
  apiSuccess,
  isJsonRecord,
  requireMethod,
  validateMutationEnvelope,
  validationError
} from "../application/contracts.js";
import { eventId } from "../domain/membership.js";
import { READ_PAGE_LIMIT } from "../domain/limits.js";
import { normalizeSegmentKey } from "../domain/rule.js";
import {
  addProfilesToStaticSegment,
  normalizeProfileIds,
  removeProfilesFromStaticSegment,
  resolveProfiles,
  resolveStaticSegment,
  upsertSegment
} from "../application/feed-static-segment.js";
import { upsertProfilesBatch } from "../application/ingest-profiles.js";
import {
  evaluateGrowthProgramPeriod,
  ingestMetricFactsBatch,
  upsertGrowthProgram,
  upsertMessageTemplate
} from "../application/manage-growth-scoring.js";
import { recomputeSegmentStep } from "../application/recompute-segment.js";
import { getMigrationState, migrationStateView, syncEmDashUsersStep } from "../application/sync-emdash-users.js";
import { checkReceipt, ensureDefaults, writeReceipt } from "../infrastructure/repositories.js";
import { serializeMutation } from "../infrastructure/mutation-queue.js";
import { buildOperationalStatistics } from "../application/build-operational-statistics.js";
import { inspectFileConfig, loadFileConfig } from "../application/manage-file-config.js";
import {
  buildTrackingMetricFact,
  observeClick,
  observeOpen,
  observeUnsubscribe,
  sendTrackedEmail,
  syncCloudflareReport
} from "../application/manage-email-tracking.js";

interface MutationOperation {
  (envelope: MutationEnvelope, payloadFingerprint: string): Promise<JsonRecord>;
}

async function runMutation(
  ctx: CrmContext,
  routeCtx: SandboxedRouteInput,
  route: string,
  operation: MutationOperation
): Promise<JsonRecord> {
  var methodError = requireMethod(routeCtx.request.method, "POST");
  if (methodError) return methodError;
  var envelopeResult = validateMutationEnvelope(routeCtx.input);
  if (!envelopeResult.ok || !envelopeResult.value) return validationError(envelopeResult);
  var envelope = envelopeResult.value;
  return await serializeMutation(async function() {
    var receiptCheck = await checkReceipt(ctx, route, envelope.request_id, envelope.input);
    if (receiptCheck.conflict) {
      return apiError("REQUEST_ID_CONFLICT", "request_id was already used with a different payload");
    }
    if (receiptCheck.replay && receiptCheck.receipt) return receiptCheck.receipt.result;

    if (!envelope.dry_run) {
      try {
        await writeReceipt(
          ctx,
          route,
          envelope.request_id,
          envelope.source,
          receiptCheck.payload_fingerprint,
          "processing",
          apiError("PROCESSING", "Mutation has claimed this request_id"),
          new Date().toISOString()
        );
      } catch (_claimError) {
        return apiError(
          "IDEMPOTENCY_CLAIM_FAILED",
          "The request_id could not be durably claimed; no domain mutation was started"
        );
      }
    }

    var result: JsonRecord;
    try {
      result = await operation(envelope, receiptCheck.payload_fingerprint);
    } catch (_error) {
      var partial = apiError(
        "PARTIAL_WRITE",
        "Storage failed before the operation checkpoint completed. Retry the exact request_id and payload"
      );
      try {
        await writeReceipt(
          ctx,
          route,
          envelope.request_id,
          envelope.source,
          receiptCheck.payload_fingerprint,
          "partial",
          partial,
          new Date().toISOString()
        );
      } catch (_partialReceiptError) {
        // The retry instruction remains valid when receipt storage also fails.
      }
      return partial;
    }
    if (result.ok !== true) {
      if (!envelope.dry_run) {
        try {
          await writeReceipt(
            ctx,
            route,
            envelope.request_id,
            envelope.source,
            receiptCheck.payload_fingerprint,
            "completed",
            result,
            new Date().toISOString()
          );
        } catch (_errorReceiptFailure) {
          result.idempotency_warning = "Validation failed and its final receipt could not be stored";
        }
      }
      return result;
    }
    if (envelope.dry_run) return result;
    try {
      await writeReceipt(
        ctx,
        route,
        envelope.request_id,
        envelope.source,
        receiptCheck.payload_fingerprint,
        "checkpointed",
        result,
        new Date().toISOString()
      );
    } catch (_checkpointError) {
      var checkpointFailure = apiError(
        "RESULT_CHECKPOINT_FAILED",
        "Domain writes completed but their request result was not durably checkpointed; retry the exact payload"
      );
      try {
        await writeReceipt(
          ctx,
          route,
          envelope.request_id,
          envelope.source,
          receiptCheck.payload_fingerprint,
          "partial",
          checkpointFailure,
          new Date().toISOString()
        );
      } catch (_checkpointReceiptError) {
        // The original processing claim still prevents changed-payload reuse.
      }
      return checkpointFailure;
    }
    try {
      await writeReceipt(
        ctx,
        route,
        envelope.request_id,
        envelope.source,
        receiptCheck.payload_fingerprint,
        "completed",
        result,
        new Date().toISOString()
      );
    } catch (_completionError) {
      result.idempotency_warning = "Operation result is checkpointed but its receipt is not finalized";
    }
    return result;
  });
}

export async function handleBootstrap(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/bootstrap", async function(envelope) {
    var plan = await ensureDefaults(ctx, envelope.dry_run);
    return apiSuccess({
      initialized: !envelope.dry_run,
      delivery_mode: "disabled",
      concurrency_mode: "single_sequenced_writer_required",
      plan: plan
    });
  });
}

export async function handleStatisticsSummary(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  var methodError = requireMethod(routeCtx.request.method, "GET");
  if (methodError) return methodError;
  return apiSuccess({ statistics: await buildOperationalStatistics(ctx) });
}

export async function handleFileConfigStatus(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  var methodError = requireMethod(routeCtx.request.method, "GET");
  if (methodError) return methodError;
  return apiSuccess({ config: await inspectFileConfig(ctx) });
}

export async function handleFileConfigLoad(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/config/file/load", async function(envelope) {
    var keys = Object.keys(envelope.input);
    var allowed: Record<string, boolean> = {
      schema_version: true,
      request_id: true,
      source: true,
      occurred_at: true,
      dry_run: true
    };
    for (var index = 0; index < keys.length; index++) {
      if (!allowed[keys[index]]) return apiError("UNKNOWN_OPERATION_FIELD", "Unsupported file config load field: " + keys[index]);
    }
    return await loadFileConfig(ctx, envelope.request_id, envelope.occurred_at, envelope.dry_run);
  });
}

export async function handleTrackedEmailSend(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/deliveries/send", async function(envelope) {
    return await sendTrackedEmail(ctx, envelope.input, envelope.request_id, envelope.occurred_at, envelope.dry_run);
  });
}

export async function handleCloudflareReportSync(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/providers/cloudflare/report-sync", async function(envelope) {
    if (envelope.dry_run) return apiError("DRY_RUN_UNSUPPORTED", "Provider report sync is read-through and does not support dry_run");
    return await syncCloudflareReport(ctx, envelope.input);
  });
}

export async function handleTrackingMetricsMaterialize(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/metrics/materialize-tracking", async function(envelope, payloadFingerprint) {
    var programKey = typeof envelope.input.program_key === "string" ? envelope.input.program_key.trim() : "";
    var periodKey = typeof envelope.input.period_key === "string" ? envelope.input.period_key.trim() : "";
    if (!programKey || !periodKey) return apiError("INVALID_TRACKING_SCOPE", "program_key and period_key are required");
    var built = await buildTrackingMetricFact(ctx, programKey, periodKey, envelope.dry_run);
    if (built.ok !== true || !isJsonRecord(built.data) || !isJsonRecord(built.data.fact)) return built;
    var metricInput: JsonRecord = { program_key: programKey, facts: [built.data.fact] };
    var ingested = await ingestMetricFactsBatch(
      ctx,
      metricInput,
      envelope.request_id,
      envelope.occurred_at,
      envelope.dry_run,
      "crm_tracking",
      payloadFingerprint
    );
    if (ingested.ok === true && isJsonRecord(ingested.data)) ingested.data.tracking_observations = built.data.observations;
    return ingested;
  });
}

export async function handleTrackingOpen(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  var methodError = requireMethod(routeCtx.request.method, "GET");
  if (methodError) return methodError;
  return await observeOpen(ctx, routeCtx.request.url, routeCtx.request.headers);
}

export async function handleTrackingClick(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  var methodError = requireMethod(routeCtx.request.method, "GET");
  if (methodError) return methodError;
  return await observeClick(ctx, routeCtx.request.url, routeCtx.request.headers);
}

export async function handleTrackingUnsubscribe(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  if (routeCtx.request.method !== "GET" && routeCtx.request.method !== "POST") return apiError("METHOD_NOT_ALLOWED", "This route requires GET or POST");
  return await observeUnsubscribe(ctx, routeCtx.request.url, routeCtx.request.headers, routeCtx.request.method === "POST");
}

export async function handleProfilesUpsert(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/profiles/upsert-batch", async function(envelope, payloadFingerprint) {
    return await upsertProfilesBatch(
      ctx,
      envelope.input,
      envelope.request_id,
      envelope.occurred_at,
      envelope.dry_run,
      envelope.source,
      payloadFingerprint
    );
  });
}

export async function handleTemplateUpsert(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/templates/upsert", async function(envelope, payloadFingerprint) {
    return await upsertMessageTemplate(
      ctx,
      envelope.input,
      envelope.request_id,
      envelope.occurred_at,
      envelope.dry_run,
      envelope.source,
      payloadFingerprint
    );
  });
}

export async function handleProgramUpsert(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/programs/upsert", async function(envelope, payloadFingerprint) {
    return await upsertGrowthProgram(
      ctx,
      envelope.input,
      envelope.request_id,
      envelope.occurred_at,
      envelope.dry_run,
      envelope.source,
      payloadFingerprint
    );
  });
}

export async function handleMetricFactsIngest(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/metrics/ingest-batch", async function(envelope, payloadFingerprint) {
    return await ingestMetricFactsBatch(
      ctx,
      envelope.input,
      envelope.request_id,
      envelope.occurred_at,
      envelope.dry_run,
      envelope.source,
      payloadFingerprint
    );
  });
}

export async function handleProgramEvaluate(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/programs/evaluate", async function(envelope, payloadFingerprint) {
    return await evaluateGrowthProgramPeriod(
      ctx,
      envelope.input,
      envelope.request_id,
      envelope.occurred_at,
      envelope.dry_run,
      envelope.source,
      payloadFingerprint
    );
  });
}

export async function handleSegmentUpsert(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/segments/upsert", async function(envelope) {
    if (!isJsonRecord(envelope.input.segment)) return apiError("INVALID_SEGMENT", "segment object is required");
    var segmentResult = await upsertSegment(ctx, envelope.input.segment, envelope.occurred_at, envelope.dry_run);
    if (!segmentResult.ok || !segmentResult.value) return validationError(segmentResult);
    if (!envelope.dry_run) {
      var segmentEventId = eventId("segment_upserted", envelope.request_id, segmentResult.value.key);
      var segmentEvent: CrmEvent = {
        id: segmentEventId,
        type: "segment_upserted",
        profile_id: null,
        segment_key: segmentResult.value.key,
        request_id: envelope.request_id,
        occurred_at: envelope.occurred_at,
        metadata: { kind: segmentResult.value.kind, source: envelope.source }
      };
      await ctx.storage.events.put(segmentEventId, segmentEvent);
    }
    return apiSuccess({ dry_run: envelope.dry_run, segment: segmentResult.value });
  });
}

async function handleMemberMutation(
  routeCtx: SandboxedRouteInput,
  ctx: CrmContext,
  action: "add" | "remove"
): Promise<JsonRecord> {
  var route = action === "add" ? "v1/segments/members/add" : "v1/segments/members/remove";
  return await runMutation(ctx, routeCtx, route, async function(envelope) {
    var segmentResult = await resolveStaticSegment(ctx, envelope.input.segment_key);
    if (!segmentResult.ok || !segmentResult.value) return validationError(segmentResult);
    var idsResult = normalizeProfileIds(envelope.input);
    if (!idsResult.ok || !idsResult.value) return validationError(idsResult);
    var profilesResult = await resolveProfiles(ctx, idsResult.value);
    if (!profilesResult.ok || !profilesResult.value) return validationError(profilesResult);
    var result = action === "add"
      ? await addProfilesToStaticSegment(
          ctx,
          segmentResult.value,
          profilesResult.value,
          envelope.request_id,
          envelope.occurred_at,
          envelope.dry_run,
          envelope.source
        )
      : await removeProfilesFromStaticSegment(
          ctx,
          segmentResult.value,
          profilesResult.value,
          envelope.request_id,
          envelope.occurred_at,
          envelope.dry_run,
          envelope.source
        );
    if (!result.ok || !result.value) return validationError(result);
    return apiSuccess({ dry_run: envelope.dry_run, result: result.value });
  });
}

export async function handleSegmentMembersAdd(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await handleMemberMutation(routeCtx, ctx, "add");
}

export async function handleSegmentMembersRemove(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await handleMemberMutation(routeCtx, ctx, "remove");
}

export async function handleSegmentRecompute(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/segments/recompute-step", async function(envelope, payloadFingerprint) {
    return await recomputeSegmentStep(
      ctx,
      envelope.input,
      envelope.request_id,
      envelope.occurred_at,
      envelope.dry_run,
      envelope.source,
      payloadFingerprint,
      true
    );
  });
}

export async function handleMigrationStep(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  return await runMutation(ctx, routeCtx, "v1/migrations/emdash-users/step", async function(envelope, payloadFingerprint) {
    return await syncEmDashUsersStep(
      ctx,
      envelope.input,
      envelope.request_id,
      envelope.occurred_at,
      envelope.dry_run,
      envelope.source,
      payloadFingerprint,
      true
    );
  });
}

export async function handleMigrationStatus(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  var methodError = requireMethod(routeCtx.request.method, "GET");
  if (methodError) return methodError;
  return apiSuccess({ state: migrationStateView(await getMigrationState(ctx)) });
}

function parseListParams(routeCtx: SandboxedRouteInput): { limit: number; cursor?: string } {
  var url = new URL(routeCtx.request.url);
  var parsedLimit = Number(url.searchParams.get("limit") || "50");
  var limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, READ_PAGE_LIMIT)) : READ_PAGE_LIMIT;
  var cursor = url.searchParams.get("cursor") || undefined;
  return { limit: limit, cursor: cursor };
}

export async function handleSegmentsList(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  var methodError = requireMethod(routeCtx.request.method, "GET");
  if (methodError) return methodError;
  var params = parseListParams(routeCtx);
  var result = await ctx.storage.segments.query({ limit: params.limit, cursor: params.cursor });
  var segments: CrmSegment[] = [];
  for (var index = 0; index < result.items.length; index++) segments.push(result.items[index].data);
  return apiSuccess({ items: segments, cursor: result.cursor || null, has_more: result.hasMore });
}

export async function handleSegmentPreview(routeCtx: SandboxedRouteInput, ctx: CrmContext): Promise<JsonRecord> {
  var methodError = requireMethod(routeCtx.request.method, "POST");
  if (methodError) return methodError;
  if (!isJsonRecord(routeCtx.input)) return apiError("INVALID_BODY", "JSON object body is required");
  var keyResult = normalizeSegmentKey(routeCtx.input.segment_key);
  if (!keyResult.ok || !keyResult.value) return validationError(keyResult);
  var segment = await ctx.storage.segments.get("segment:" + keyResult.value);
  if (!segment) return apiError("SEGMENT_NOT_FOUND", "Segment does not exist");
  var limitValue = Number(routeCtx.input.limit === undefined ? 20 : routeCtx.input.limit);
  var limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(limitValue, READ_PAGE_LIMIT)) : 20;
  if (segment.kind === "static") {
    var staticWhere = { segment_key: segment.key, status: "open" };
    var staticCount = await ctx.storage.segmentMembershipStates.count(staticWhere);
    var staticPage = await ctx.storage.segmentMembershipStates.query({ where: staticWhere, limit: limit });
    var staticIds: string[] = [];
    for (var staticIndex = 0; staticIndex < staticPage.items.length; staticIndex++) {
      staticIds.push(staticPage.items[staticIndex].data.profile_id);
    }
    return apiSuccess({ segment: segment, count: staticCount, sample_profile_ids: staticIds });
  }
  if (!segment.active_generation) {
    return apiSuccess({ segment: segment, count: 0, sample_profile_ids: [], note: "No active recompute generation" });
  }
  var dynamicWhere = { segment_key: segment.key, generation: segment.active_generation, status: "snapshot" };
  var dynamicCount = await ctx.storage.segmentMemberships.count(dynamicWhere);
  var dynamicPage = await ctx.storage.segmentMemberships.query({ where: dynamicWhere, limit: limit });
  var dynamicIds: string[] = [];
  for (var dynamicIndex = 0; dynamicIndex < dynamicPage.items.length; dynamicIndex++) {
    dynamicIds.push(dynamicPage.items[dynamicIndex].data.profile_id);
  }
  return apiSuccess({ segment: segment, count: dynamicCount, sample_profile_ids: dynamicIds });
}
