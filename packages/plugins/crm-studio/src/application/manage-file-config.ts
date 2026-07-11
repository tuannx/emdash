import type { CrmContext, CrmSegment, JsonRecord } from "../types.js";
import {
  CRM_STUDIO_FILE_CONFIG,
  buildFileDefaultSegments,
  validateFileConfig
} from "../config/file-config.js";
import { requestPayloadFingerprint } from "../domain/membership.js";
import { stableStringify } from "../domain/profile.js";
import { ensureDefaults } from "../infrastructure/repositories.js";

export interface FileConfigLoadState extends JsonRecord {
  config_key: string;
  config_version: string;
  formula_version: string;
  fingerprint: string;
  loaded_at: string;
  request_id: string;
}

function segmentDefinition(segment: CrmSegment): JsonRecord {
  return {
    key: segment.key,
    name: segment.name,
    description: segment.description,
    kind: segment.kind,
    evaluation_mode: segment.evaluation_mode,
    rule: segment.rule,
    membership_limit: segment.membership_limit,
    group_key: segment.group_key,
    is_active: segment.is_active
  };
}

export async function fileConfigFingerprint(): Promise<string> {
  return await requestPayloadFingerprint("crm-studio-file-config", CRM_STUDIO_FILE_CONFIG);
}

export async function inspectFileConfig(ctx: CrmContext): Promise<JsonRecord> {
  var validationErrors = validateFileConfig();
  var fingerprint = await fileConfigFingerprint();
  var timestamp = new Date().toISOString();
  var defaults = buildFileDefaultSegments(timestamp);
  var ids: string[] = [];
  for (var idIndex = 0; idIndex < defaults.length; idIndex++) ids.push(defaults[idIndex].id);
  var existing = await ctx.storage.segments.getMany(ids);
  var missing: string[] = [];
  var drifted: string[] = [];
  var matched: string[] = [];
  for (var index = 0; index < defaults.length; index++) {
    var current = existing.get(defaults[index].id);
    if (!current) missing.push(defaults[index].key);
    else if (stableStringify(segmentDefinition(current)) === stableStringify(segmentDefinition(defaults[index]))) matched.push(defaults[index].key);
    else drifted.push(defaults[index].key);
  }
  var loaded = await ctx.kv.get<FileConfigLoadState>("settings:fileConfigLoadState");
  var deploymentStatus = validationErrors.length > 0
    ? "invalid"
    : loaded && loaded.fingerprint === fingerprint ? "acknowledged" : "review_required";
  var runtimeStatus = missing.length > 0 ? "missing_defaults" : drifted.length > 0 ? "drifted" : "clean";
  return {
    schema_version: CRM_STUDIO_FILE_CONFIG.schema_version,
    config_key: CRM_STUDIO_FILE_CONFIG.config_key,
    config_version: CRM_STUDIO_FILE_CONFIG.config_version,
    formula_version: CRM_STUDIO_FILE_CONFIG.formula_version,
    fingerprint: fingerprint,
    source_file: "packages/plugins/crm-studio/src/config/file-config.ts",
    deployment_status: deploymentStatus,
    runtime_status: runtimeStatus,
    validation_errors: validationErrors,
    default_segment_count: defaults.length,
    missing_segment_keys: missing,
    drifted_segment_keys: drifted,
    matched_segment_keys: matched,
    loaded_at: loaded ? loaded.loaded_at : null,
    loaded_request_id: loaded ? loaded.request_id : null,
    activation_minimum_score: CRM_STUDIO_FILE_CONFIG.activation_minimum_score,
    score_run_window: CRM_STUDIO_FILE_CONFIG.statistics.score_run_window
  };
}

export async function loadFileConfig(
  ctx: CrmContext,
  requestId: string,
  occurredAt: string,
  dryRun: boolean
): Promise<JsonRecord> {
  var validationErrors = validateFileConfig();
  if (validationErrors.length > 0) {
    return {
      ok: false,
      error: {
        code: "FILE_CONFIG_INVALID",
        message: "The bundled CRM Studio file config failed validation",
        details: { validation_errors: validationErrors }
      }
    };
  }
  var fingerprint = await fileConfigFingerprint();
  var plan = await ensureDefaults(ctx, dryRun);
  if (!dryRun) {
    var state: FileConfigLoadState = {
      config_key: CRM_STUDIO_FILE_CONFIG.config_key,
      config_version: CRM_STUDIO_FILE_CONFIG.config_version,
      formula_version: CRM_STUDIO_FILE_CONFIG.formula_version,
      fingerprint: fingerprint,
      loaded_at: occurredAt,
      request_id: requestId
    };
    await ctx.kv.set("settings:fileConfigLoadState", state);
  }
  var inspection = await inspectFileConfig(ctx);
  return {
    ok: true,
    data: {
      dry_run: dryRun,
      outcome: dryRun ? "planned" : "loaded",
      config: inspection,
      create_missing_plan: plan,
      existing_drift_overwritten: false
    }
  };
}
