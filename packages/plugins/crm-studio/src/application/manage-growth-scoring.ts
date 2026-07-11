import type {
  ConfigRevision,
  CrmContext,
  CrmSegment,
  GrowthProgram,
  JsonRecord,
  MessageTemplate,
  MetricFact,
  ScoreRun
} from "../types.js";
import { requestPayloadFingerprint } from "../domain/membership.js";
import {
  scoreProgramPerformance,
  scoreProgramReadiness,
  scoreTemplateQuality
} from "../domain/scoring.js";
import { apiError, apiSuccess, isJsonRecord } from "./contracts.js";
import { getSegmentMembershipEpoch } from "../infrastructure/repositories.js";

export var GROWTH_SCORE_FORMULA_VERSION = "crm-growth-score-v1";
var METRIC_FACT_BATCH_LIMIT = 16;
var METRIC_FACT_QUERY_LIMIT = 100;

var MUTATION_ENVELOPE_FIELDS: Record<string, boolean> = {
  schema_version: true,
  request_id: true,
  source: true,
  occurred_at: true,
  dry_run: true
};
var TEMPLATE_INPUT_FIELDS: Record<string, boolean> = { template: true };
var PROGRAM_INPUT_FIELDS: Record<string, boolean> = { program: true };
var METRIC_INPUT_FIELDS: Record<string, boolean> = { program_key: true, facts: true };
var EVALUATE_INPUT_FIELDS: Record<string, boolean> = { program_key: true, period_key: true };

var TEMPLATE_FIELDS: Record<string, boolean> = {
  key: true,
  name: true,
  channel: true,
  subject: true,
  body_html: true,
  body_text: true,
  cta_label: true,
  cta_url: true,
  sender_profile_key: true,
  is_active: true
};
var PROGRAM_FIELDS: Record<string, boolean> = {
  key: true,
  name: true,
  description: true,
  offer_type: true,
  audience_segment_key: true,
  template_key: true,
  safety: true,
  measurement: true,
  is_active: true
};
var SAFETY_FIELDS: Record<string, boolean> = {
  require_marketing_consent: true,
  exclude_crm_contact_safety: true,
  exclude_crm_blacklist: true,
  exclude_paid_tv_users: true
};
var MEASUREMENT_FIELDS: Record<string, boolean> = {
  primary_metric: true,
  conversion_event: true,
  attribution_window_days: true,
  target_value: true,
  baseline_value: true,
  control_group_percentage: true,
  minimum_sample_size: true
};
var METRIC_FACT_FIELDS: Record<string, boolean> = {
  source_fact_id: true,
  period_key: true,
  sequence: true,
  sent: true,
  delivered: true,
  unique_clicks: true,
  conversions: true,
  complaints: true,
  unsubscribes: true
};

interface PreparedMetricFact {
  source_fact_id: string;
  period_key: string;
  sequence: number;
  sent: number;
  delivered: number;
  unique_clicks: number;
  conversions: number;
  complaints: number;
  unsubscribes: number;
}

interface SegmentEvidenceResult {
  evidence: JsonRecord;
  fingerprint: string;
}

interface SafetyEvidenceResult {
  ok: boolean;
  evidence?: JsonRecord;
  fingerprint?: string;
  error?: JsonRecord;
}

function validateKnownFields(value: JsonRecord, allowed: Record<string, boolean>, code: string): JsonRecord | null {
  var keys = Object.keys(value);
  for (var index = 0; index < keys.length; index++) {
    if (!allowed[keys[index]]) return apiError(code, "Unsupported field: " + keys[index]);
  }
  return null;
}

function validateOperationFields(value: JsonRecord, allowed: Record<string, boolean>): JsonRecord | null {
  var keys = Object.keys(value);
  for (var index = 0; index < keys.length; index++) {
    if (!MUTATION_ENVELOPE_FIELDS[keys[index]] && !allowed[keys[index]]) {
      return apiError("UNKNOWN_OPERATION_FIELD", "Unsupported top-level field: " + keys[index]);
    }
  }
  return null;
}

function stableKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  var normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) return null;
  return normalized;
}

function requiredText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  var normalized = value.trim();
  if (!normalized || normalized.length > maximum) return null;
  return normalized;
}

function optionalText(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, maximum);
}

function validBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function staleUpdate(updatedAt: string, lastRequestId: string, occurredAt: string, requestId: string): boolean {
  var incoming = Date.parse(occurredAt);
  var current = Date.parse(updatedAt);
  if (incoming < current) return true;
  if (incoming > current) return false;
  return requestId < lastRequestId;
}

function templateDefinition(template: MessageTemplate): JsonRecord {
  return {
    key: template.key,
    name: template.name,
    channel: template.channel,
    subject: template.subject,
    body_html: template.body_html,
    body_text: template.body_text,
    cta_label: template.cta_label,
    cta_url: template.cta_url,
    sender_profile_key: template.sender_profile_key,
    is_active: template.is_active
  };
}

function programDefinition(program: GrowthProgram): JsonRecord {
  return {
    key: program.key,
    name: program.name,
    description: program.description,
    offer_type: program.offer_type,
    audience_segment_key: program.audience_segment_key,
    template_key: program.template_key,
    safety: program.safety,
    measurement: program.measurement,
    is_active: program.is_active
  };
}

function configRevisionId(entityType: string, entityKey: string, fingerprint: string): string {
  return "config-revision|" + entityType + "|" + entityKey + "|" + fingerprint;
}

async function persistConfigRevision(
  ctx: CrmContext,
  entityType: "message_template" | "program",
  entityKey: string,
  entityId: string,
  definition: JsonRecord,
  definitionFingerprint: string,
  requestId: string,
  payloadFingerprint: string,
  source: string,
  occurredAt: string,
  dryRun: boolean
): Promise<string> {
  var id = configRevisionId(entityType, entityKey, definitionFingerprint);
  if (dryRun) return id;
  var existing = await ctx.storage.configRevisions.get(id);
  if (existing) return id;
  var revision: ConfigRevision = {
    id: id,
    schema_version: 1,
    entity_type: entityType,
    entity_key: entityKey,
    entity_id: entityId,
    definition_fingerprint: definitionFingerprint,
    definition: definition,
    request_id: requestId,
    request_payload_fingerprint: payloadFingerprint,
    source: source,
    created_at: occurredAt
  };
  await ctx.storage.configRevisions.put(id, revision);
  return id;
}

export async function upsertMessageTemplate(
  ctx: CrmContext,
  input: JsonRecord,
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  source: string,
  payloadFingerprint: string
): Promise<JsonRecord> {
  var operationFieldError = validateOperationFields(input, TEMPLATE_INPUT_FIELDS);
  if (operationFieldError) return operationFieldError;
  if (!isJsonRecord(input.template)) return apiError("INVALID_TEMPLATE", "template object is required");
  var value = input.template;
  var fieldError = validateKnownFields(value, TEMPLATE_FIELDS, "UNKNOWN_TEMPLATE_FIELD");
  if (fieldError) return fieldError;
  var key = stableKey(value.key);
  if (!key) return apiError("INVALID_TEMPLATE_KEY", "template.key must be a stable lowercase key");
  var name = requiredText(value.name, 120);
  if (!name) return apiError("INVALID_TEMPLATE_NAME", "template.name is required and must be at most 120 characters");
  if (value.channel !== undefined && value.channel !== "email") return apiError("INVALID_TEMPLATE_CHANNEL", "Only the email channel is supported in V1");
  if (typeof value.subject !== "string" || value.subject.length > 200) return apiError("INVALID_TEMPLATE_SUBJECT", "template.subject must be a string of at most 200 characters");
  if (typeof value.body_html !== "string" || value.body_html.length > 40960) return apiError("INVALID_TEMPLATE_BODY", "template.body_html must be a string of at most 40960 characters");
  var bodyText = optionalText(value.body_text, 40960);
  if (value.body_text !== undefined && value.body_text !== null && value.body_text !== "" && bodyText === null) return apiError("INVALID_TEMPLATE_BODY_TEXT", "template.body_text is invalid");
  var ctaLabel = optionalText(value.cta_label, 160);
  if (value.cta_label !== undefined && value.cta_label !== null && value.cta_label !== "" && ctaLabel === null) return apiError("INVALID_TEMPLATE_CTA", "template.cta_label is invalid");
  var ctaUrl = optionalText(value.cta_url, 2048);
  if (value.cta_url !== undefined && value.cta_url !== null && value.cta_url !== "" && ctaUrl === null) return apiError("INVALID_TEMPLATE_CTA", "template.cta_url is invalid");
  var senderProfileKey = value.sender_profile_key === undefined || value.sender_profile_key === null
    ? null
    : stableKey(value.sender_profile_key);
  if (value.sender_profile_key !== undefined && value.sender_profile_key !== null && !senderProfileKey) return apiError("INVALID_SENDER_PROFILE_KEY", "sender_profile_key must be a stable lowercase key");
  if (!validBoolean(value.is_active)) return apiError("INVALID_TEMPLATE_STATUS", "template.is_active must be boolean");

  var existing = await ctx.storage.messageTemplates.get("message-template:" + key);
  var provisional: MessageTemplate = {
    id: "message-template:" + key,
    schema_version: 1,
    key: key,
    name: name,
    channel: "email",
    subject: value.subject,
    body_html: value.body_html,
    body_text: bodyText,
    cta_label: ctaLabel,
    cta_url: ctaUrl,
    sender_profile_key: senderProfileKey,
    is_active: value.is_active === true,
    delivery_enabled: false,
    quality_score: 0,
    quality_grade: "",
    quality_result: {},
    config_revision_id: "",
    definition_fingerprint: "",
    created_at: existing ? existing.created_at : occurredAt,
    updated_at: occurredAt,
    last_request_id: requestId,
    last_payload_fingerprint: payloadFingerprint,
    last_outcome: existing ? "updated" : "created",
    last_source: source
  };
  var definition = templateDefinition(provisional);
  var definitionFingerprint = await requestPayloadFingerprint("message-template-definition", definition);
  if (existing && existing.definition_fingerprint === definitionFingerprint) {
    var replayedOutcome = existing.last_request_id === requestId && existing.last_payload_fingerprint === payloadFingerprint
      ? existing.last_outcome || "updated"
      : "unchanged";
    return apiSuccess({ dry_run: dryRun, outcome: replayedOutcome, template: existing, revision_created: false });
  }
  if (existing && staleUpdate(existing.updated_at, existing.last_request_id, occurredAt, requestId)) {
    return apiError("STALE_TEMPLATE_UPDATE", "Template update is older than the current definition");
  }
  if (existing) {
    var activeReferences = await ctx.storage.programs.query({
      where: { template_key: key, is_active: true },
      limit: 1
    });
    if (activeReferences.items.length > 0) {
      return apiError("TEMPLATE_IN_USE", "Deactivate programs that reference this template before changing its definition");
    }
  }
  var quality = scoreTemplateQuality(definition);
  provisional.quality_score = quality.score;
  provisional.quality_grade = quality.grade;
  provisional.quality_result = quality;
  if (provisional.is_active && (quality.blockers.length > 0 || quality.score < 75)) {
    return apiError("TEMPLATE_NOT_READY", "An active template must have no safety blockers and a quality score of at least 75");
  }
  provisional.definition_fingerprint = definitionFingerprint;
  provisional.config_revision_id = configRevisionId("message_template", key, definitionFingerprint);
  await persistConfigRevision(
    ctx,
    "message_template",
    key,
    provisional.id,
    definition,
    definitionFingerprint,
    requestId,
    payloadFingerprint,
    source,
    occurredAt,
    dryRun
  );
  if (!dryRun) await ctx.storage.messageTemplates.put(provisional.id, provisional);
  return apiSuccess({
    dry_run: dryRun,
    outcome: existing ? "updated" : "created",
    template: provisional,
    revision_created: true
  });
}

function normalizeSafety(value: unknown): JsonRecord | null {
  if (value === undefined || value === null) {
    return {
      require_marketing_consent: false,
      exclude_crm_contact_safety: false,
      exclude_crm_blacklist: false,
      exclude_paid_tv_users: false
    };
  }
  if (!isJsonRecord(value)) return null;
  if (validateKnownFields(value, SAFETY_FIELDS, "UNKNOWN_PROGRAM_SAFETY_FIELD")) return null;
  if (
    !validBoolean(value.require_marketing_consent) ||
    !validBoolean(value.exclude_crm_contact_safety) ||
    !validBoolean(value.exclude_crm_blacklist) ||
    !validBoolean(value.exclude_paid_tv_users)
  ) return null;
  return {
    require_marketing_consent: value.require_marketing_consent === true,
    exclude_crm_contact_safety: value.exclude_crm_contact_safety === true,
    exclude_crm_blacklist: value.exclude_crm_blacklist === true,
    exclude_paid_tv_users: value.exclude_paid_tv_users === true
  };
}

function normalizeMeasurement(value: unknown): JsonRecord | null {
  if (value === undefined || value === null) return {};
  if (!isJsonRecord(value)) return null;
  if (validateKnownFields(value, MEASUREMENT_FIELDS, "UNKNOWN_PROGRAM_MEASUREMENT_FIELD")) return null;
  var output: JsonRecord = {};
  var primaryMetric = optionalText(value.primary_metric, 120);
  var conversionEvent = optionalText(value.conversion_event, 120);
  if (value.primary_metric !== undefined && value.primary_metric !== null && value.primary_metric !== "" && primaryMetric === null) return null;
  if (value.conversion_event !== undefined && value.conversion_event !== null && value.conversion_event !== "" && conversionEvent === null) return null;
  if (primaryMetric) output.primary_metric = primaryMetric;
  if (conversionEvent) output.conversion_event = conversionEvent;
  var integerFields = ["attribution_window_days", "minimum_sample_size"];
  for (var integerIndex = 0; integerIndex < integerFields.length; integerIndex++) {
    var integerField = integerFields[integerIndex];
    if (value[integerField] !== undefined) {
      if (typeof value[integerField] !== "number" || !Number.isInteger(value[integerField]) || (value[integerField] as number) <= 0) return null;
      output[integerField] = value[integerField];
    }
  }
  var numericFields = ["target_value", "baseline_value", "control_group_percentage"];
  for (var numericIndex = 0; numericIndex < numericFields.length; numericIndex++) {
    var numericField = numericFields[numericIndex];
    if (value[numericField] !== undefined) {
      if (typeof value[numericField] !== "number" || !Number.isFinite(value[numericField])) return null;
      output[numericField] = value[numericField];
    }
  }
  if (typeof output.attribution_window_days === "number" && output.attribution_window_days > 365) return null;
  if (typeof output.minimum_sample_size === "number" && output.minimum_sample_size > 1000000000) return null;
  if (
    typeof output.control_group_percentage === "number" &&
    (output.control_group_percentage <= 0 || output.control_group_percentage >= 100)
  ) return null;
  return output;
}

async function collectSegmentEvidence(ctx: CrmContext, segment: CrmSegment): Promise<SegmentEvidenceResult> {
  var memberCount = 0;
  var membershipEpoch: number | null = null;
  if (segment.kind === "dynamic") {
    if (segment.active_generation) {
      memberCount = await ctx.storage.segmentMemberships.count({
        segment_key: segment.key,
        generation: segment.active_generation,
        status: "snapshot"
      });
    }
  } else {
    memberCount = await ctx.storage.segmentMembershipStates.count({ segment_key: segment.key, status: "open" });
    membershipEpoch = await getSegmentMembershipEpoch(ctx, segment.key);
  }
  var evidence: JsonRecord = {
    key: segment.key,
    kind: segment.kind,
    rule: segment.rule,
    membership_limit: segment.membership_limit,
    group_key: segment.group_key,
    is_active: segment.is_active,
    updated_at: segment.updated_at,
    active_generation: segment.active_generation,
    static_membership_epoch: membershipEpoch,
    member_count: memberCount
  };
  var fingerprint = await requestPayloadFingerprint("growth-segment-evidence", evidence);
  return { evidence: evidence, fingerprint: fingerprint };
}

function primaryAudienceError(segment: CrmSegment, result: SegmentEvidenceResult): JsonRecord | null {
  if (!segment.is_active) return apiError("SEGMENT_INACTIVE", "An active program requires an active audience segment");
  if (segment.kind === "dynamic" && !segment.active_generation) {
    return apiError("SEGMENT_NOT_MATERIALIZED", "The dynamic audience must complete a recompute before program activation or scoring");
  }
  if ((result.evidence.member_count as number) < 1) {
    return apiError("SEGMENT_EMPTY", "The active program audience must contain at least one current member");
  }
  return null;
}

async function collectSafetyEvidence(
  ctx: CrmContext,
  offerType: string
): Promise<SafetyEvidenceResult> {
  var requiredKeys = ["crm_blacklist"];
  if (offerType === "discount" || offerType === "acquisition") requiredKeys.push("paid_tv_users");
  var ids: string[] = [];
  for (var idIndex = 0; idIndex < requiredKeys.length; idIndex++) ids.push("segment:" + requiredKeys[idIndex]);
  var segmentMap = await ctx.storage.segments.getMany(ids);
  var manifest: JsonRecord[] = [];
  for (var index = 0; index < requiredKeys.length; index++) {
    var segment = segmentMap.get("segment:" + requiredKeys[index]);
    if (!segment) {
      return { ok: false, error: apiError("SAFETY_SEGMENT_NOT_FOUND", "Required safety segment does not exist: " + requiredKeys[index]) };
    }
    if (!segment.is_active) {
      return { ok: false, error: apiError("SAFETY_SEGMENT_INACTIVE", "Required safety segment is inactive: " + requiredKeys[index]) };
    }
    if (requiredKeys[index] === "paid_tv_users" && segment.kind === "dynamic" && !segment.active_generation) {
      return { ok: false, error: apiError("SAFETY_SEGMENT_NOT_MATERIALIZED", "paid_tv_users must complete recompute before discount or acquisition scoring") };
    }
    var evidenceResult = await collectSegmentEvidence(ctx, segment);
    manifest.push({ key: requiredKeys[index], fingerprint: evidenceResult.fingerprint, evidence: evidenceResult.evidence });
  }
  var evidence: JsonRecord = { required_segments: manifest };
  var fingerprint = await requestPayloadFingerprint("growth-safety-evidence", evidence);
  return { ok: true, evidence: evidence, fingerprint: fingerprint };
}

function readinessDefinition(program: GrowthProgram, template?: MessageTemplate): JsonRecord {
  var definition: JsonRecord = {
    offer_type: program.offer_type,
    audience: {
      segment_key: program.audience_segment_key,
      require_marketing_consent: program.safety.require_marketing_consent,
      exclude_crm_contact_safety: program.safety.exclude_crm_contact_safety
    },
    safety: program.safety,
    template_key: program.template_key,
    measurement: program.measurement
  };
  if (template) definition.template = templateDefinition(template);
  return definition;
}

export async function upsertGrowthProgram(
  ctx: CrmContext,
  input: JsonRecord,
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  source: string,
  payloadFingerprint: string
): Promise<JsonRecord> {
  var operationFieldError = validateOperationFields(input, PROGRAM_INPUT_FIELDS);
  if (operationFieldError) return operationFieldError;
  if (!isJsonRecord(input.program)) return apiError("INVALID_PROGRAM", "program object is required");
  var value = input.program;
  var fieldError = validateKnownFields(value, PROGRAM_FIELDS, "UNKNOWN_PROGRAM_FIELD");
  if (fieldError) return fieldError;
  var key = stableKey(value.key);
  var segmentKey = stableKey(value.audience_segment_key);
  var templateKey = stableKey(value.template_key);
  var name = requiredText(value.name, 120);
  var offerType = typeof value.offer_type === "string" ? value.offer_type : "";
  if (!key) return apiError("INVALID_PROGRAM_KEY", "program.key must be a stable lowercase key");
  if (!name) return apiError("INVALID_PROGRAM_NAME", "program.name is required and must be at most 120 characters");
  if (!segmentKey) return apiError("INVALID_SEGMENT_KEY", "program.audience_segment_key must be a stable lowercase key");
  if (!templateKey) return apiError("INVALID_TEMPLATE_KEY", "program.template_key must be a stable lowercase key");
  if (offerType !== "informational" && offerType !== "lifecycle" && offerType !== "discount" && offerType !== "acquisition") {
    return apiError("INVALID_OFFER_TYPE", "program.offer_type must be informational, lifecycle, discount, or acquisition");
  }
  var description = optionalText(value.description, 2000) || "";
  if (!validBoolean(value.is_active)) return apiError("INVALID_PROGRAM_STATUS", "program.is_active must be boolean");
  var safety = normalizeSafety(value.safety);
  if (!safety) return apiError("INVALID_PROGRAM_SAFETY", "program.safety contains unsupported or invalid fields");
  var measurement = normalizeMeasurement(value.measurement);
  if (!measurement) return apiError("INVALID_PROGRAM_MEASUREMENT", "program.measurement contains unsupported or invalid fields");
  var segment = await ctx.storage.segments.get("segment:" + segmentKey);
  if (!segment) return apiError("SEGMENT_NOT_FOUND", "The referenced audience segment does not exist");
  var template = await ctx.storage.messageTemplates.get("message-template:" + templateKey);
  if (!template) return apiError("TEMPLATE_NOT_FOUND", "The referenced message template does not exist");
  var requestedActive = value.is_active === true;
  if (requestedActive && !template.is_active) return apiError("TEMPLATE_INACTIVE", "An active program requires an active message template");

  var existing = await ctx.storage.programs.get("program:" + key);
  var provisional: GrowthProgram = {
    id: "program:" + key,
    schema_version: 1,
    key: key,
    name: name,
    description: description,
    offer_type: offerType as "informational" | "lifecycle" | "discount" | "acquisition",
    audience_segment_key: segmentKey,
    template_key: templateKey,
    safety: safety,
    measurement: measurement,
    is_active: requestedActive,
    delivery_enabled: false,
    readiness_score: 0,
    readiness_grade: "",
    readiness_result: {},
    readiness_checked_at: occurredAt,
    config_revision_id: "",
    definition_fingerprint: "",
    created_at: existing ? existing.created_at : occurredAt,
    updated_at: occurredAt,
    last_request_id: requestId,
    last_payload_fingerprint: payloadFingerprint,
    last_outcome: existing ? "updated" : "created",
    last_source: source
  };
  var definition = programDefinition(provisional);
  var definitionFingerprint = await requestPayloadFingerprint("program-definition", definition);
  var definitionUnchanged = !!existing && existing.definition_fingerprint === definitionFingerprint;
  if (existing && !definitionUnchanged && staleUpdate(existing.updated_at, existing.last_request_id, occurredAt, requestId)) {
    return apiError("STALE_PROGRAM_UPDATE", "Program update is older than the current definition");
  }
  var readiness = scoreProgramReadiness(readinessDefinition(provisional, template), {
    segment_exists: true,
    template_exists: true,
    template_quality_score: template.quality_score
  });
  provisional.readiness_score = readiness.score;
  provisional.readiness_grade = readiness.grade;
  provisional.readiness_result = readiness;
  if (provisional.is_active) {
    var audienceEvidence = await collectSegmentEvidence(ctx, segment);
    var audienceError = primaryAudienceError(segment, audienceEvidence);
    if (audienceError) return audienceError;
    var safetyEvidence = await collectSafetyEvidence(ctx, provisional.offer_type);
    if (!safetyEvidence.ok || !safetyEvidence.evidence || !safetyEvidence.fingerprint) {
      return safetyEvidence.error || apiError("SAFETY_EVIDENCE_UNAVAILABLE", "Safety segment evidence could not be collected");
    }
    readiness.audience_evidence = audienceEvidence.evidence;
    readiness.audience_evidence_fingerprint = audienceEvidence.fingerprint;
    readiness.safety_evidence = safetyEvidence.evidence;
    readiness.safety_evidence_fingerprint = safetyEvidence.fingerprint;
  }
  if (provisional.is_active && (readiness.blockers.length > 0 || readiness.score < 75)) {
    return apiError("PROGRAM_NOT_READY", "An active program must have no readiness blockers and a readiness score of at least 75");
  }
  if (existing && definitionUnchanged) {
    existing.readiness_score = readiness.score;
    existing.readiness_grade = readiness.grade;
    existing.readiness_result = readiness;
    existing.readiness_checked_at = occurredAt;
    if (!dryRun) await ctx.storage.programs.put(existing.id, existing);
    var replayedOutcome = existing.last_request_id === requestId && existing.last_payload_fingerprint === payloadFingerprint
      ? existing.last_outcome || "updated"
      : "unchanged";
    return apiSuccess({ dry_run: dryRun, outcome: replayedOutcome, program: existing, revision_created: false });
  }
  provisional.definition_fingerprint = definitionFingerprint;
  provisional.config_revision_id = configRevisionId("program", key, definitionFingerprint);
  await persistConfigRevision(
    ctx,
    "program",
    key,
    provisional.id,
    definition,
    definitionFingerprint,
    requestId,
    payloadFingerprint,
    source,
    occurredAt,
    dryRun
  );
  if (!dryRun) await ctx.storage.programs.put(provisional.id, provisional);
  return apiSuccess({
    dry_run: dryRun,
    outcome: existing ? "updated" : "created",
    program: provisional,
    revision_created: true
  });
}

function validCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function prepareMetricFact(value: unknown): JsonRecord | PreparedMetricFact {
  if (!isJsonRecord(value)) return apiError("INVALID_METRIC_FACT", "Each fact must be an object");
  var fieldError = validateKnownFields(value, METRIC_FACT_FIELDS, "UNKNOWN_METRIC_FIELD");
  if (fieldError) return fieldError;
  var sourceFactId = typeof value.source_fact_id === "string" ? value.source_fact_id.trim() : "";
  var periodKey = typeof value.period_key === "string" ? value.period_key.trim() : "";
  var opaqueHex = /^[0-9a-f]{32,64}$/i.test(sourceFactId);
  var opaqueUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceFactId);
  if (!opaqueHex && !opaqueUuid) return apiError("INVALID_SOURCE_FACT_ID", "source_fact_id must be an opaque UUID or 32 to 64 character hex ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(periodKey)) return apiError("INVALID_PERIOD_KEY", "period_key is invalid");
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return apiError("INVALID_FACT_SEQUENCE", "sequence must be a positive safe integer");
  var fields = ["sent", "delivered", "unique_clicks", "conversions", "complaints", "unsubscribes"];
  for (var index = 0; index < fields.length; index++) {
    if (!validCount(value[fields[index]])) return apiError("INVALID_METRIC_COUNTS", "Metric counts must be non-negative safe integers");
  }
  var sent = value.sent as number;
  var delivered = value.delivered as number;
  var uniqueClicks = value.unique_clicks as number;
  var conversions = value.conversions as number;
  var complaints = value.complaints as number;
  var unsubscribes = value.unsubscribes as number;
  if (
    delivered > sent ||
    uniqueClicks > delivered ||
    conversions > delivered ||
    complaints > delivered ||
    unsubscribes > delivered
  ) return apiError("INVALID_METRIC_COUNTS", "Metric counts violate their aggregate denominators");
  return {
    source_fact_id: sourceFactId,
    period_key: periodKey,
    sequence: value.sequence as number,
    sent: sent,
    delivered: delivered,
    unique_clicks: uniqueClicks,
    conversions: conversions,
    complaints: complaints,
    unsubscribes: unsubscribes
  };
}

function isErrorResult(value: JsonRecord | PreparedMetricFact): value is JsonRecord {
  return (value as JsonRecord).ok === false;
}

function factSemantics(
  program: GrowthProgram,
  template: MessageTemplate,
  source: string,
  fact: PreparedMetricFact,
  audienceEvidenceFingerprint: string,
  safetyEvidenceFingerprint: string
): JsonRecord {
  return {
    program_key: program.key,
    program_revision_id: program.config_revision_id,
    template_revision_id: template.config_revision_id,
    audience_evidence_fingerprint: audienceEvidenceFingerprint,
    safety_evidence_fingerprint: safetyEvidenceFingerprint,
    source: source,
    source_fact_id: fact.source_fact_id,
    period_key: fact.period_key,
    sent: fact.sent,
    delivered: fact.delivered,
    unique_clicks: fact.unique_clicks,
    conversions: fact.conversions,
    complaints: fact.complaints,
    unsubscribes: fact.unsubscribes
  };
}

export async function ingestMetricFactsBatch(
  ctx: CrmContext,
  input: JsonRecord,
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  source: string,
  payloadFingerprint: string
): Promise<JsonRecord> {
  var operationFieldError = validateOperationFields(input, METRIC_INPUT_FIELDS);
  if (operationFieldError) return operationFieldError;
  var programKey = stableKey(input.program_key);
  if (!programKey) return apiError("INVALID_PROGRAM_KEY", "program_key must be a stable lowercase key");
  if (!Array.isArray(input.facts) || input.facts.length < 1 || input.facts.length > METRIC_FACT_BATCH_LIMIT) {
    return apiError("INVALID_FACT_BATCH_SIZE", "facts must contain 1 to " + METRIC_FACT_BATCH_LIMIT + " items");
  }
  var program = await ctx.storage.programs.get("program:" + programKey);
  if (!program) return apiError("PROGRAM_NOT_FOUND", "The referenced program does not exist");
  if (!program.is_active) return apiError("PROGRAM_INACTIVE", "Metric facts require an active program configuration");
  var segment = await ctx.storage.segments.get("segment:" + program.audience_segment_key);
  if (!segment) return apiError("SEGMENT_NOT_FOUND", "The program audience segment no longer exists");
  var template = await ctx.storage.messageTemplates.get("message-template:" + program.template_key);
  if (!template) return apiError("TEMPLATE_NOT_FOUND", "The program message template no longer exists");
  if (!template.is_active) return apiError("TEMPLATE_INACTIVE", "Metric facts require an active template configuration");
  var audienceEvidence = await collectSegmentEvidence(ctx, segment);
  var audienceError = primaryAudienceError(segment, audienceEvidence);
  if (audienceError) return audienceError;
  var safetyEvidence = await collectSafetyEvidence(ctx, program.offer_type);
  if (!safetyEvidence.ok || !safetyEvidence.evidence || !safetyEvidence.fingerprint) {
    return safetyEvidence.error || apiError("SAFETY_EVIDENCE_UNAVAILABLE", "Safety segment evidence could not be collected");
  }
  var requestIdFingerprint = await requestPayloadFingerprint("metric-request-id", { request_id: requestId });
  var prepared: PreparedMetricFact[] = [];
  var seen: Record<string, boolean> = {};
  for (var index = 0; index < input.facts.length; index++) {
    var preparedResult = prepareMetricFact(input.facts[index]);
    if (isErrorResult(preparedResult)) {
      preparedResult.item_index = index;
      return preparedResult;
    }
    if (seen[preparedResult.source_fact_id]) return apiError("DUPLICATE_FACT_ID", "source_fact_id must be unique within a batch");
    seen[preparedResult.source_fact_id] = true;
    prepared.push(preparedResult);
  }

  var writes: Array<{ id: string; data: MetricFact }> = [];
  var acceptedIds: string[] = [];
  var unchangedIds: string[] = [];
  for (var factIndex = 0; factIndex < prepared.length; factIndex++) {
    var candidate = prepared[factIndex];
    var streamKey = programKey + "|" + source + "|" + candidate.source_fact_id;
    var page = await ctx.storage.metricFacts.query({ where: { fact_stream_key: streamKey }, limit: METRIC_FACT_QUERY_LIMIT });
    if (page.hasMore) return apiError("FACT_REVISION_LIMIT_EXCEEDED", "A fact stream has more than 100 revisions and requires operator review");
    var semanticsFingerprint = await requestPayloadFingerprint(
      "metric-fact-semantics",
      factSemantics(program, template, source, candidate, audienceEvidence.fingerprint, safetyEvidence.fingerprint)
    );
    var highest: MetricFact | null = null;
    var sameRevision: MetricFact | null = null;
    for (var revisionIndex = 0; revisionIndex < page.items.length; revisionIndex++) {
      var revision = page.items[revisionIndex].data;
      if (
        revision.program_revision_id !== program.config_revision_id ||
        revision.template_revision_id !== template.config_revision_id ||
        revision.audience_evidence_fingerprint !== audienceEvidence.fingerprint ||
        revision.safety_evidence_fingerprint !== safetyEvidence.fingerprint
      ) {
        return apiError("FACT_CONFIG_IMMUTABLE", "A correction stream cannot move to another program, template, audience, or safety revision", {
          item_index: factIndex,
          source_fact_id: candidate.source_fact_id
        });
      }
      if (!highest || revision.sequence > highest.sequence) highest = revision;
      if (revision.sequence === candidate.sequence) {
        if (revision.semantic_fingerprint !== semanticsFingerprint) {
          return apiError("FACT_ID_CONFLICT", "source_fact_id and sequence already exist with a different semantic payload", {
            item_index: factIndex,
            source_fact_id: candidate.source_fact_id
          });
        }
        sameRevision = revision;
      }
      if (revision.period_key !== candidate.period_key) {
        return apiError("FACT_PERIOD_IMMUTABLE", "A correction cannot move source_fact_id to another period", {
          item_index: factIndex,
          source_fact_id: candidate.source_fact_id
        });
      }
    }
    if (sameRevision) {
      if (sameRevision.first_request_payload_fingerprint === payloadFingerprint) acceptedIds.push(sameRevision.id);
      else unchangedIds.push(sameRevision.id);
      continue;
    }
    if (highest && candidate.sequence <= highest.sequence) {
      return apiError("STALE_FACT_SEQUENCE", "A correction must use a sequence higher than the current revision", {
        item_index: factIndex,
        source_fact_id: candidate.source_fact_id,
        current_sequence: highest.sequence
      });
    }
    var id = "metric-fact|" + programKey + "|" + source + "|" + candidate.source_fact_id + "|" + candidate.sequence + "|" + semanticsFingerprint;
    var fact: MetricFact = {
      id: id,
      schema_version: 1,
      program_key: programKey,
      period_key: candidate.period_key,
      source: source,
      source_fact_id: candidate.source_fact_id,
      fact_stream_key: streamKey,
      sequence: candidate.sequence,
      sent: candidate.sent,
      delivered: candidate.delivered,
      unique_clicks: candidate.unique_clicks,
      conversions: candidate.conversions,
      complaints: candidate.complaints,
      unsubscribes: candidate.unsubscribes,
      semantic_fingerprint: semanticsFingerprint,
      correction_of_fact_id: highest ? highest.id : null,
      program_revision_id: program.config_revision_id,
      template_revision_id: template.config_revision_id,
      audience_evidence_fingerprint: audienceEvidence.fingerprint,
      safety_evidence_fingerprint: safetyEvidence.fingerprint,
      first_request_id_fingerprint: requestIdFingerprint,
      first_request_payload_fingerprint: payloadFingerprint,
      occurred_at: occurredAt,
      created_at: occurredAt
    };
    writes.push({ id: id, data: fact });
    acceptedIds.push(id);
  }
  if (!dryRun && writes.length > 0) await ctx.storage.metricFacts.putMany(writes);
  return apiSuccess({
    dry_run: dryRun,
    program_key: programKey,
    requested: prepared.length,
    accepted: acceptedIds.length,
    unchanged: unchangedIds.length,
    fact_ids: acceptedIds,
    unchanged_fact_ids: unchangedIds
  });
}

function sumMetrics(facts: MetricFact[]): JsonRecord | null {
  var aggregate: JsonRecord = {
    sent: 0,
    delivered: 0,
    unique_clicks: 0,
    conversions: 0,
    complaints: 0,
    unsubscribes: 0
  };
  var fields = ["sent", "delivered", "unique_clicks", "conversions", "complaints", "unsubscribes"];
  for (var factIndex = 0; factIndex < facts.length; factIndex++) {
    for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
      var field = fields[fieldIndex];
      var next = (aggregate[field] as number) + (facts[factIndex][field] as number);
      if (!Number.isSafeInteger(next)) return null;
      aggregate[field] = next;
    }
  }
  return aggregate;
}

export async function evaluateGrowthProgramPeriod(
  ctx: CrmContext,
  input: JsonRecord,
  requestId: string,
  occurredAt: string,
  dryRun: boolean,
  source: string,
  payloadFingerprint: string
): Promise<JsonRecord> {
  var operationFieldError = validateOperationFields(input, EVALUATE_INPUT_FIELDS);
  if (operationFieldError) return operationFieldError;
  var programKey = stableKey(input.program_key);
  var periodKey = typeof input.period_key === "string" ? input.period_key.trim() : "";
  if (!programKey) return apiError("INVALID_PROGRAM_KEY", "program_key must be a stable lowercase key");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(periodKey)) return apiError("INVALID_PERIOD_KEY", "period_key is invalid");
  var program = await ctx.storage.programs.get("program:" + programKey);
  if (!program) return apiError("PROGRAM_NOT_FOUND", "The referenced program does not exist");
  if (!program.is_active) return apiError("PROGRAM_INACTIVE", "Only an active program configuration can be evaluated");
  var segment = await ctx.storage.segments.get("segment:" + program.audience_segment_key);
  if (!segment) return apiError("SEGMENT_NOT_FOUND", "The program audience segment no longer exists");
  var template = await ctx.storage.messageTemplates.get("message-template:" + program.template_key);
  if (!template) return apiError("TEMPLATE_NOT_FOUND", "The program message template no longer exists");
  if (!template.is_active) return apiError("TEMPLATE_INACTIVE", "The program message template is inactive");
  var audienceEvidence = await collectSegmentEvidence(ctx, segment);
  var audienceError = primaryAudienceError(segment, audienceEvidence);
  if (audienceError) return audienceError;
  var safetyEvidence = await collectSafetyEvidence(ctx, program.offer_type);
  if (!safetyEvidence.ok || !safetyEvidence.evidence || !safetyEvidence.fingerprint) {
    return safetyEvidence.error || apiError("SAFETY_EVIDENCE_UNAVAILABLE", "Safety segment evidence could not be collected");
  }
  var page = await ctx.storage.metricFacts.query({
    where: { program_key: programKey, period_key: periodKey },
    limit: METRIC_FACT_QUERY_LIMIT
  });
  if (page.hasMore) return apiError("TOO_MANY_METRIC_FACTS", "The period contains more than 100 fact revisions and cannot be scored safely");
  var latest: Record<string, MetricFact> = {};
  for (var index = 0; index < page.items.length; index++) {
    var fact = page.items[index].data;
    var current = latest[fact.fact_stream_key];
    if (!current || fact.sequence > current.sequence) latest[fact.fact_stream_key] = fact;
    else if (fact.sequence === current.sequence && fact.semantic_fingerprint !== current.semantic_fingerprint) {
      return apiError("AMBIGUOUS_METRIC_REVISION", "Equal fact sequences contain different semantic payloads", {
        source_fact_id: fact.source_fact_id,
        sequence: fact.sequence
      });
    } else if (fact.sequence === current.sequence && fact.id < current.id) latest[fact.fact_stream_key] = fact;
  }
  var streamKeys = Object.keys(latest);
  streamKeys.sort();
  var selected: MetricFact[] = [];
  for (var streamIndex = 0; streamIndex < streamKeys.length; streamIndex++) selected.push(latest[streamKeys[streamIndex]]);
  for (var pinIndex = 0; pinIndex < selected.length; pinIndex++) {
    if (
      selected[pinIndex].program_revision_id !== program.config_revision_id ||
      selected[pinIndex].template_revision_id !== template.config_revision_id ||
      selected[pinIndex].audience_evidence_fingerprint !== audienceEvidence.fingerprint ||
      selected[pinIndex].safety_evidence_fingerprint !== safetyEvidence.fingerprint
    ) {
      return apiError("METRIC_CONFIG_REVISION_MISMATCH", "Metric facts were produced for another program, template, audience, or safety revision");
    }
  }
  var aggregate = sumMetrics(selected);
  if (!aggregate) return apiError("METRIC_TOTAL_OVERFLOW", "Aggregate metric totals exceed safe integer limits");
  var quality = scoreTemplateQuality(templateDefinition(template));
  var readiness = scoreProgramReadiness(readinessDefinition(program, template), {
    segment_exists: true,
    template_exists: true,
    template_quality_score: quality.score
  });
  readiness.audience_evidence = audienceEvidence.evidence;
  readiness.audience_evidence_fingerprint = audienceEvidence.fingerprint;
  readiness.safety_evidence = safetyEvidence.evidence;
  readiness.safety_evidence_fingerprint = safetyEvidence.fingerprint;
  var performance = scoreProgramPerformance(aggregate, {
    minimum_sample_size: program.measurement.minimum_sample_size
  });
  var status: "blocked" | "insufficient_data" | "scored";
  var overallScore: number | null = null;
  if (readiness.blockers.length > 0 || performance.blockers.length > 0) status = "blocked";
  else if (performance.score === null) status = "insufficient_data";
  else {
    status = "scored";
    overallScore = Math.round(readiness.score * 0.4 + performance.score * 0.6);
  }
  var inputFactIds: string[] = [];
  var inputFacts: JsonRecord[] = [];
  for (var selectedIndex = 0; selectedIndex < selected.length; selectedIndex++) {
    inputFactIds.push(selected[selectedIndex].id);
    inputFacts.push({ id: selected[selectedIndex].id, semantic_fingerprint: selected[selectedIndex].semantic_fingerprint });
  }
  var inputFingerprint = await requestPayloadFingerprint("growth-score-inputs", {
    formula_version: GROWTH_SCORE_FORMULA_VERSION,
    program_revision_id: program.config_revision_id,
    template_revision_id: template.config_revision_id,
    audience_evidence_fingerprint: audienceEvidence.fingerprint,
    safety_evidence_fingerprint: safetyEvidence.fingerprint,
    facts: inputFacts
  });
  var id = "score-run|" + programKey + "|" + periodKey + "|" + inputFingerprint;
  var existing = await ctx.storage.scoreRuns.get(id);
  if (existing) return apiSuccess({ dry_run: dryRun, outcome: "unchanged", score_run: existing });
  var scoreRun: ScoreRun = {
    id: id,
    schema_version: 1,
    formula_version: GROWTH_SCORE_FORMULA_VERSION,
    program_key: programKey,
    period_key: periodKey,
    status: status,
    overall_score: overallScore,
    readiness_score: readiness.score,
    performance_score: performance.score,
    template_quality_score: quality.score,
    readiness_result: readiness,
    performance_result: performance,
    template_quality_result: quality,
    aggregate_metrics: aggregate,
    input_fact_id: inputFactIds.length === 1 ? inputFactIds[0] : null,
    input_fact_ids: inputFactIds,
    input_facts_fingerprint: inputFingerprint,
    program_revision_id: program.config_revision_id,
    template_revision_id: template.config_revision_id,
    audience_segment_fingerprint: audienceEvidence.fingerprint,
    audience_evidence: audienceEvidence.evidence,
    safety_evidence_fingerprint: safetyEvidence.fingerprint,
    safety_evidence: safetyEvidence.evidence,
    request_id: requestId,
    request_payload_fingerprint: payloadFingerprint,
    source: source,
    created_at: occurredAt
  };
  if (!dryRun) await ctx.storage.scoreRuns.put(id, scoreRun);
  return apiSuccess({ dry_run: dryRun, outcome: "created", score_run: scoreRun });
}
