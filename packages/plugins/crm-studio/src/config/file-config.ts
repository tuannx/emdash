import type { CrmSegment, JsonRecord } from "../types.js";

export interface GradeBandsConfig extends JsonRecord {
  excellent: number;
  strong: number;
  fair: number;
  weak: number;
}

export interface DimensionStatusConfig extends JsonRecord {
  pass_ratio: number;
  warn_ratio: number;
}

export interface ReadinessConfig extends JsonRecord {
  safety_max: number;
  consent_weight: number;
  contact_safety_weight: number;
  blacklist_weight: number;
  audience_max: number;
  audience_key_weight: number;
  audience_exists_weight: number;
  template_max: number;
  measurement_max: number;
  primary_metric_weight: number;
  conversion_event_weight: number;
  attribution_window_weight: number;
  comparison_plan_weight: number;
}

export interface TemplateQualityConfig extends JsonRecord {
  coverage_max: number;
  subject_present_weight: number;
  subject_length_weight: number;
  subject_length_partial_weight: number;
  body_present_weight: number;
  body_complete_weight: number;
  body_partial_weight: number;
  body_thin_weight: number;
  cta_max: number;
  cta_label_weight: number;
  cta_url_weight: number;
  personalization_max: number;
  safety_max: number;
  active_content_penalty: number;
  manual_unsubscribe_penalty: number;
  fallback_max: number;
}

export interface RateComponentConfig extends JsonRecord {
  max_score: number;
  floor: number;
  target: number;
  warning_below: number;
}

export interface SafetyRateComponentConfig extends JsonRecord {
  max_score: number;
  target: number;
  warning_above: number;
  stop_at: number;
}

export interface PerformanceConfig extends JsonRecord {
  default_minimum_sample_size: number;
  medium_confidence_multiplier: number;
  high_confidence_multiplier: number;
  delivery: RateComponentConfig;
  click: RateComponentConfig;
  conversion: RateComponentConfig;
  complaint: SafetyRateComponentConfig;
  unsubscribe: SafetyRateComponentConfig;
}

export interface OverallConfig extends JsonRecord {
  readiness_weight: number;
  performance_weight: number;
}

export interface StatisticsConfig extends JsonRecord {
  score_run_window: number;
  table_limit: number;
  stale_after_hours: number;
}

export interface FileSegmentDefinition extends JsonRecord {
  key: string;
  name: string;
  description: string;
  kind: "static" | "dynamic";
  evaluation_mode: "scheduled" | "event" | "hybrid";
  rule: JsonRecord | null;
  membership_limit: number | null;
  group_key: string | null;
  is_active: boolean;
}

export interface GrowthStudioFileConfig extends JsonRecord {
  schema_version: number;
  config_key: string;
  config_version: string;
  formula_version: string;
  activation_minimum_score: number;
  blocker_score_cap: number;
  grade_bands: GradeBandsConfig;
  dimension_status: DimensionStatusConfig;
  readiness: ReadinessConfig;
  template_quality: TemplateQualityConfig;
  performance: PerformanceConfig;
  overall: OverallConfig;
  statistics: StatisticsConfig;
  default_segments: FileSegmentDefinition[];
}

export var CRM_STUDIO_FILE_CONFIG: GrowthStudioFileConfig = {
  schema_version: 1,
  config_key: "crm_studio_core",
  config_version: "2026-07-11.2",
  formula_version: "crm-growth-score-v2-file-config",
  activation_minimum_score: 75,
  blocker_score_cap: 49,
  grade_bands: {
    excellent: 90,
    strong: 75,
    fair: 60,
    weak: 40
  },
  dimension_status: {
    pass_ratio: 0.85,
    warn_ratio: 0.5
  },
  readiness: {
    safety_max: 30,
    consent_weight: 12,
    contact_safety_weight: 9,
    blacklist_weight: 9,
    audience_max: 25,
    audience_key_weight: 10,
    audience_exists_weight: 15,
    template_max: 25,
    measurement_max: 20,
    primary_metric_weight: 6,
    conversion_event_weight: 5,
    attribution_window_weight: 4,
    comparison_plan_weight: 5
  },
  template_quality: {
    coverage_max: 40,
    subject_present_weight: 10,
    subject_length_weight: 5,
    subject_length_partial_weight: 2,
    body_present_weight: 15,
    body_complete_weight: 10,
    body_partial_weight: 5,
    body_thin_weight: 2,
    cta_max: 20,
    cta_label_weight: 10,
    cta_url_weight: 10,
    personalization_max: 10,
    safety_max: 25,
    active_content_penalty: 15,
    manual_unsubscribe_penalty: 10,
    fallback_max: 5
  },
  performance: {
    default_minimum_sample_size: 100,
    medium_confidence_multiplier: 5,
    high_confidence_multiplier: 20,
    delivery: { max_score: 30, floor: 0.8, target: 0.98, warning_below: 0.95 },
    click: { max_score: 25, floor: 0.005, target: 0.08, warning_below: 0.02 },
    conversion: { max_score: 30, floor: 0, target: 0.05, warning_below: 0.01 },
    complaint: { max_score: 8, target: 0.001, warning_above: 0.001, stop_at: 0.005 },
    unsubscribe: { max_score: 7, target: 0.005, warning_above: 0.005, stop_at: 0.03 }
  },
  overall: {
    readiness_weight: 0.4,
    performance_weight: 0.6
  },
  statistics: {
    score_run_window: 50,
    table_limit: 20,
    stale_after_hours: 168
  },
  default_segments: [
    {
      key: "emdash_users",
      name: "All EmDash users",
      description: "Static migration cohort. Membership does not imply marketing eligibility.",
      kind: "static",
      evaluation_mode: "event",
      rule: null,
      membership_limit: null,
      group_key: null,
      is_active: true
    },
    {
      key: "crm_blacklist",
      name: "CRM blacklist",
      description: "Manual safety exclusion for every campaign channel.",
      kind: "static",
      evaluation_mode: "event",
      rule: null,
      membership_limit: null,
      group_key: "crm_contact_safety",
      is_active: true
    },
    {
      key: "paid_tv_users",
      name: "Paid TV users",
      description: "Safety audience for direct payers and shared-TV users when the host feed provides paid_tv_access.",
      kind: "dynamic",
      evaluation_mode: "scheduled",
      rule: { trait: "paid_tv_access", operator: "eq", value: true },
      membership_limit: null,
      group_key: "crm_contact_safety",
      is_active: true
    },
    {
      key: "paying_customers",
      name: "Paying customers",
      description: "Safety audience for profiles classified as paying.",
      kind: "dynamic",
      evaluation_mode: "scheduled",
      rule: { trait: "billing_state", operator: "eq", value: "paying" },
      membership_limit: null,
      group_key: "crm_contact_safety",
      is_active: true
    }
  ]
};

export function buildFileDefaultSegments(timestamp: string): CrmSegment[] {
  var output: CrmSegment[] = [];
  for (var index = 0; index < CRM_STUDIO_FILE_CONFIG.default_segments.length; index++) {
    var definition = CRM_STUDIO_FILE_CONFIG.default_segments[index];
    output.push({
      id: "segment:" + definition.key,
      schema_version: 1,
      key: definition.key,
      name: definition.name,
      description: definition.description,
      kind: definition.kind,
      evaluation_mode: definition.evaluation_mode,
      rule: definition.rule,
      membership_limit: definition.membership_limit,
      group_key: definition.group_key,
      is_active: definition.is_active,
      active_generation: definition.kind === "static" ? "static" : null,
      created_at: timestamp,
      updated_at: timestamp,
      last_recomputed_at: null
    });
  }
  return output;
}

function sum(values: number[]): number {
  var total = 0;
  for (var index = 0; index < values.length; index++) total += values[index];
  return total;
}

export function validateFileConfig(config?: GrowthStudioFileConfig): string[] {
  var value = config || CRM_STUDIO_FILE_CONFIG;
  var errors: string[] = [];
  var readiness = value.readiness;
  var template = value.template_quality;
  var performance = value.performance;
  if (value.schema_version !== 1) errors.push("CONFIG_SCHEMA_VERSION_UNSUPPORTED");
  if (!value.config_key || !value.config_version || !value.formula_version) errors.push("CONFIG_IDENTITY_MISSING");
  if (value.activation_minimum_score < 1 || value.activation_minimum_score > 100) errors.push("ACTIVATION_MINIMUM_INVALID");
  if (value.blocker_score_cap >= value.activation_minimum_score) errors.push("BLOCKER_CAP_NOT_FAIL_CLOSED");
  if (!(value.grade_bands.excellent > value.grade_bands.strong && value.grade_bands.strong > value.grade_bands.fair && value.grade_bands.fair > value.grade_bands.weak)) errors.push("GRADE_BANDS_INVALID");
  if (value.dimension_status.pass_ratio <= value.dimension_status.warn_ratio || value.dimension_status.pass_ratio > 1 || value.dimension_status.warn_ratio < 0) errors.push("DIMENSION_STATUS_INVALID");
  if (sum([readiness.safety_max, readiness.audience_max, readiness.template_max, readiness.measurement_max]) !== 100) errors.push("READINESS_MAXIMA_MUST_SUM_100");
  if (sum([readiness.consent_weight, readiness.contact_safety_weight, readiness.blacklist_weight]) !== readiness.safety_max) errors.push("READINESS_SAFETY_WEIGHTS_INVALID");
  if (sum([readiness.audience_key_weight, readiness.audience_exists_weight]) !== readiness.audience_max) errors.push("READINESS_AUDIENCE_WEIGHTS_INVALID");
  if (sum([readiness.primary_metric_weight, readiness.conversion_event_weight, readiness.attribution_window_weight, readiness.comparison_plan_weight]) !== readiness.measurement_max) errors.push("READINESS_MEASUREMENT_WEIGHTS_INVALID");
  if (sum([template.coverage_max, template.cta_max, template.personalization_max, template.safety_max, template.fallback_max]) !== 100) errors.push("TEMPLATE_MAXIMA_MUST_SUM_100");
  if (sum([performance.delivery.max_score, performance.click.max_score, performance.conversion.max_score, performance.complaint.max_score, performance.unsubscribe.max_score]) !== 100) errors.push("PERFORMANCE_MAXIMA_MUST_SUM_100");
  if (Math.abs(value.overall.readiness_weight + value.overall.performance_weight - 1) > 0.000001) errors.push("OVERALL_WEIGHTS_MUST_SUM_1");
  if (!(performance.delivery.floor < performance.delivery.target && performance.click.floor < performance.click.target && performance.conversion.floor < performance.conversion.target)) errors.push("PERFORMANCE_RATE_TARGETS_INVALID");
  if (!(performance.complaint.target <= performance.complaint.warning_above && performance.complaint.warning_above < performance.complaint.stop_at)) errors.push("COMPLAINT_THRESHOLDS_INVALID");
  if (!(performance.unsubscribe.target <= performance.unsubscribe.warning_above && performance.unsubscribe.warning_above < performance.unsubscribe.stop_at)) errors.push("UNSUBSCRIBE_THRESHOLDS_INVALID");
  if (value.statistics.score_run_window < 1 || value.statistics.score_run_window > 100) errors.push("STATISTICS_WINDOW_INVALID");
  var keys: Record<string, boolean> = {};
  for (var index = 0; index < value.default_segments.length; index++) {
    var key = value.default_segments[index].key;
    if (!key || keys[key]) errors.push("DEFAULT_SEGMENT_KEYS_INVALID");
    keys[key] = true;
  }
  return errors;
}
