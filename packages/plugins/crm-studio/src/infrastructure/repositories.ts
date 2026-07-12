import type {
  CrmContext,
  CrmSegment,
  IngestReceipt,
  JsonRecord
} from "../types.js";
import { buildFileDefaultSegments } from "../config/file-config.js";
import { requestPayloadFingerprint, receiptId } from "../domain/membership.js";

export interface ReceiptCheck {
  replay: boolean;
  conflict: boolean;
  receipt: IngestReceipt | null;
  payload_fingerprint: string;
}

export interface BootstrapPlan extends JsonRecord {
  dry_run: boolean;
  missing_segment_keys: string[];
  delivery_mode_change: boolean;
  applied_writes: number;
}

interface ProfileEpochState extends JsonRecord {
  value: number;
  last_request_id: string | null;
}

interface SegmentMembershipEpochState extends JsonRecord {
  value: number;
  last_request_id: string | null;
}

export async function getProfileEpoch(ctx: CrmContext): Promise<number> {
  var state = await ctx.kv.get<ProfileEpochState>("state:profileEpoch");
  return state && Number.isInteger(state.value) ? state.value : 0;
}

export async function bumpProfileEpoch(ctx: CrmContext, requestId: string): Promise<number> {
  var state = await ctx.kv.get<ProfileEpochState>("state:profileEpoch");
  if (state && state.last_request_id === requestId) return state.value;
  var nextValue = state && Number.isInteger(state.value) ? state.value + 1 : 1;
  await ctx.kv.set("state:profileEpoch", { value: nextValue, last_request_id: requestId });
  return nextValue;
}

function segmentMembershipEpochKey(segmentKey: string): string {
  return "state:segmentMembershipEpoch:" + segmentKey;
}

export async function getSegmentMembershipEpoch(ctx: CrmContext, segmentKey: string): Promise<number> {
  var state = await ctx.kv.get<SegmentMembershipEpochState>(segmentMembershipEpochKey(segmentKey));
  return state && Number.isInteger(state.value) ? state.value : 0;
}

export async function bumpSegmentMembershipEpoch(ctx: CrmContext, segmentKey: string, requestId: string): Promise<number> {
  var key = segmentMembershipEpochKey(segmentKey);
  var state = await ctx.kv.get<SegmentMembershipEpochState>(key);
  if (state && state.last_request_id === requestId) return state.value;
  var nextValue = state && Number.isInteger(state.value) ? state.value + 1 : 1;
  await ctx.kv.set(key, { value: nextValue, last_request_id: requestId });
  return nextValue;
}

export async function ensureDefaults(ctx: CrmContext, dryRun?: boolean): Promise<BootstrapPlan> {
  var deliveryMode = await ctx.kv.get<string>("settings:deliveryMode");
  var timestamp = new Date().toISOString();
  var defaults = buildFileDefaultSegments(timestamp);
  var writes: Array<{ id: string; data: CrmSegment }> = [];
  var missingSegmentKeys: string[] = [];
  var defaultIds: string[] = [];
  for (var index = 0; index < defaults.length; index++) {
    defaultIds.push(defaults[index].id);
  }
  var existingDefaults = await ctx.storage.segments.getMany(defaultIds);
  for (var writeIndex = 0; writeIndex < defaults.length; writeIndex++) {
    if (!existingDefaults.has(defaults[writeIndex].id)) {
      writes.push({ id: defaults[writeIndex].id, data: defaults[writeIndex] });
      missingSegmentKeys.push(defaults[writeIndex].key);
    }
  }
  var deliveryModeChange = deliveryMode !== "disabled";
  if (!dryRun) {
    if (writes.length > 0) await ctx.storage.segments.putMany(writes);
    if (deliveryModeChange) await ctx.kv.set("settings:deliveryMode", "disabled");
  }
  return {
    dry_run: dryRun === true,
    missing_segment_keys: missingSegmentKeys,
    delivery_mode_change: deliveryModeChange,
    applied_writes: dryRun ? 0 : writes.length + (deliveryModeChange ? 1 : 0)
  };
}

export async function checkReceipt(ctx: CrmContext, route: string, requestId: string, input: JsonRecord): Promise<ReceiptCheck> {
  var payloadFingerprint = await requestPayloadFingerprint(route, input);
  var existing = await ctx.storage.ingestRequests.get(receiptId(requestId));
  if (!existing) return { replay: false, conflict: false, receipt: null, payload_fingerprint: payloadFingerprint };
  if (existing.request_id !== requestId || existing.payload_fingerprint !== payloadFingerprint) {
    return { replay: false, conflict: true, receipt: existing, payload_fingerprint: payloadFingerprint };
  }
  return {
    replay: existing.status === "completed" || existing.status === "checkpointed",
    conflict: false,
    receipt: existing,
    payload_fingerprint: payloadFingerprint
  };
}

export async function writeReceipt(
  ctx: CrmContext,
  route: string,
  requestId: string,
  source: string,
  payloadFingerprint: string,
  status: "processing" | "checkpointed" | "completed" | "partial",
  result: JsonRecord,
  timestamp: string
): Promise<void> {
  var id = receiptId(requestId);
  var receipt: IngestReceipt = {
    id: id,
    request_id: requestId,
    route: route,
    source: source,
    payload_fingerprint: payloadFingerprint,
    status: status,
    result: result,
    created_at: timestamp,
    updated_at: timestamp
  };
  await ctx.storage.ingestRequests.put(id, receipt);
}
