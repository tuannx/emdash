import type { JsonRecord } from "../types.js";

export type ScoreGrade = "Excellent" | "Strong" | "Fair" | "Weak" | "Critical" | "Blocked" | "Unsafe" | "Insufficient data" | "Invalid data";
export type ScoreConfidence = "high" | "medium" | "low" | "insufficient" | "none";
export type ScoreStatus = "pass" | "warn" | "fail" | "blocked" | "insufficient";
export type HintSeverity = "blocker" | "high" | "medium" | "low";

export interface ScoringDimension extends JsonRecord {
  key: string;
  label: string;
  score: number | null;
  max_score: number;
  status: ScoreStatus;
  detail: string;
}

export interface ScoringHint extends JsonRecord {
  code: string;
  severity: HintSeverity;
  dimension: string;
  message: string;
  action: string;
}

export interface ScoreResult extends JsonRecord {
  score: number;
  grade: ScoreGrade;
  confidence: ScoreConfidence;
  confidence_score: number;
  dimensions: ScoringDimension[];
  hints: ScoringHint[];
  blockers: string[];
}

export interface PerformanceScoreResult extends JsonRecord {
  score: number | null;
  grade: ScoreGrade;
  confidence: ScoreConfidence;
  confidence_score: number;
  dimensions: ScoringDimension[];
  hints: ScoringHint[];
  blockers: string[];
  sample_size: number;
  minimum_sample_size: number;
  rates: JsonRecord;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  var normalized = value.trim();
  return normalized ? normalized : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function roundScore(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

function gradeForScore(score: number): ScoreGrade {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Strong";
  if (score >= 60) return "Fair";
  if (score >= 40) return "Weak";
  return "Critical";
}

function statusForDimension(score: number, maximum: number, blocked: boolean): ScoreStatus {
  if (blocked) return "blocked";
  if (maximum <= 0) return "fail";
  var ratio = score / maximum;
  if (ratio >= 0.85) return "pass";
  if (ratio >= 0.5) return "warn";
  return "fail";
}

function addHint(
  hints: ScoringHint[],
  code: string,
  severity: HintSeverity,
  dimension: string,
  message: string,
  action: string
): void {
  hints.push({
    code: code,
    severity: severity,
    dimension: dimension,
    message: message,
    action: action
  });
}

function containsString(value: unknown, expected: string): boolean {
  if (!Array.isArray(value)) return false;
  for (var index = 0; index < value.length; index++) {
    if (typeof value[index] === "string" && value[index].trim().toLowerCase() === expected) return true;
  }
  return false;
}

function findNestedString(record: JsonRecord | null, keys: string[]): string | null {
  if (!record) return null;
  for (var index = 0; index < keys.length; index++) {
    var value = asNonEmptyString(record[keys[index]]);
    if (value) return value;
  }
  return null;
}

function findNestedBoolean(record: JsonRecord | null, keys: string[]): boolean | null {
  if (!record) return null;
  for (var index = 0; index < keys.length; index++) {
    if (typeof record[keys[index]] === "boolean") return record[keys[index]] as boolean;
  }
  return null;
}

function ruleRequiresValue(value: unknown, trait: string, expected: unknown): boolean {
  var rule = asRecord(value);
  if (!rule) return false;
  if (rule.op === undefined && rule.trait === trait && rule.operator === "eq" && rule.value === expected) return true;
  if (!Array.isArray(rule.rules)) return false;
  if (rule.op === "and") {
    for (var andIndex = 0; andIndex < rule.rules.length; andIndex++) {
      if (ruleRequiresValue(rule.rules[andIndex], trait, expected)) return true;
    }
    return false;
  }
  if (rule.op === "or" && rule.rules.length > 0) {
    for (var orIndex = 0; orIndex < rule.rules.length; orIndex++) {
      if (!ruleRequiresValue(rule.rules[orIndex], trait, expected)) return false;
    }
    return true;
  }
  return false;
}

function hasConsentGate(definition: JsonRecord, audience: JsonRecord | null, safety: JsonRecord | null): boolean {
  if (findNestedBoolean(safety, ["require_marketing_consent", "consent_required"]) === true) return true;
  if (findNestedBoolean(audience, ["require_marketing_consent", "consent_required"]) === true) return true;
  if (definition.require_marketing_consent === true || definition.consent_required === true) return true;
  if (ruleRequiresValue(audience ? audience.rule : null, "marketing_consent", "granted")) return true;
  if (ruleRequiresValue(definition.eligibility_rule, "marketing_consent", "granted")) return true;
  return false;
}

function excludesNamedSegment(
  definition: JsonRecord,
  audience: JsonRecord | null,
  safety: JsonRecord | null,
  segmentKey: string,
  booleanKey: string
): boolean {
  if (findNestedBoolean(safety, [booleanKey]) === true) return true;
  if (findNestedBoolean(audience, [booleanKey]) === true) return true;
  if (definition[booleanKey] === true) return true;
  if (containsString(definition.exclusions, segmentKey)) return true;
  if (containsString(definition.excluded_segments, segmentKey)) return true;
  if (containsString(definition.excluded_segment_keys, segmentKey)) return true;
  if (audience && containsString(audience.exclusions, segmentKey)) return true;
  if (audience && containsString(audience.excluded_segments, segmentKey)) return true;
  if (audience && containsString(audience.excluded_segment_keys, segmentKey)) return true;
  if (safety && containsString(safety.exclusions, segmentKey)) return true;
  if (safety && containsString(safety.excluded_segments, segmentKey)) return true;
  if (safety && containsString(safety.excluded_segment_keys, segmentKey)) return true;
  return false;
}

function excludesContactSafety(definition: JsonRecord, audience: JsonRecord | null, safety: JsonRecord | null): boolean {
  return excludesNamedSegment(definition, audience, safety, "crm_contact_safety", "exclude_crm_contact_safety");
}

function resolveSegmentExistence(
  segmentKey: string | null,
  audience: JsonRecord | null,
  context: JsonRecord | null
): boolean | null {
  var direct = findNestedBoolean(context, ["segment_exists", "audience_segment_exists"]);
  if (direct !== null) return direct;
  direct = findNestedBoolean(audience, ["segment_exists"]);
  if (direct !== null) return direct;
  if (segmentKey && context && Array.isArray(context.available_segment_keys)) {
    return containsString(context.available_segment_keys, segmentKey.toLowerCase());
  }
  return null;
}

function resolveTemplate(definition: JsonRecord): JsonRecord | null {
  var template = asRecord(definition.template);
  if (template) return template;
  var message = asRecord(definition.message);
  if (message) return message;
  return null;
}

function resolveTemplateExistence(definition: JsonRecord, context: JsonRecord | null): boolean | null {
  if (resolveTemplate(definition)) return true;
  if (!findNestedString(definition, ["template_key", "message_template_key"])) return false;
  var direct = findNestedBoolean(context, ["template_exists"]);
  if (direct !== null) return direct;
  return null;
}

function resolveTemplateQualityScore(context: JsonRecord | null): number | null {
  if (!context) return null;
  var value = asFiniteNumber(context.template_quality_score);
  if (value === null) value = asFiniteNumber(context.template_score);
  if (value === null) return null;
  return roundScore(value);
}

function confidenceForCoverage(known: number, total: number): ScoreConfidence {
  if (total <= 0 || known <= 0) return "low";
  var ratio = known / total;
  if (ratio >= 0.85) return "high";
  if (ratio >= 0.5) return "medium";
  return "low";
}

function confidenceNumber(confidence: ScoreConfidence): number {
  if (confidence === "high") return 100;
  if (confidence === "medium") return 70;
  if (confidence === "low") return 40;
  return 0;
}

export function scoreProgramReadiness(definitionInput: unknown, contextInput?: unknown): ScoreResult {
  var definition = asRecord(definitionInput) || {};
  var context = asRecord(contextInput);
  var audience = asRecord(definition.audience);
  var safety = asRecord(definition.safety);
  var measurement = asRecord(definition.measurement) || asRecord(definition.measurement_plan);
  var dimensions: ScoringDimension[] = [];
  var hints: ScoringHint[] = [];
  var blockers: string[] = [];
  var safetyScore = 0;
  var consentGate = hasConsentGate(definition, audience, safety);
  var contactSafetyExcluded = excludesContactSafety(definition, audience, safety);
  var blacklistExcluded = excludesNamedSegment(definition, audience, safety, "crm_blacklist", "exclude_crm_blacklist");
  var paidTvExcluded = excludesNamedSegment(definition, audience, safety, "paid_tv_users", "exclude_paid_tv_users");
  var offerType = findNestedString(definition, ["offer_type", "program_type"]);
  var paidTvRequired = offerType === "discount" || offerType === "acquisition";

  if (consentGate) safetyScore += 12;
  else {
    blockers.push("PROGRAM_CONSENT_GATE_MISSING");
    addHint(
      hints,
      "PROGRAM_CONSENT_GATE_MISSING",
      "blocker",
      "safety",
      "The program does not prove that marketing consent is required.",
      "Require marketing_consent = granted in the audience rule or set safety.require_marketing_consent to true."
    );
  }
  if (contactSafetyExcluded) safetyScore += 9;
  else {
    blockers.push("PROGRAM_CONTACT_SAFETY_EXCLUSION_MISSING");
    addHint(
      hints,
      "PROGRAM_CONTACT_SAFETY_EXCLUSION_MISSING",
      "blocker",
      "safety",
      "The protected crm_contact_safety audience is not excluded.",
      "Add crm_contact_safety to safety.excluded_segments before activation."
    );
  }
  if (blacklistExcluded) safetyScore += 9;
  else {
    blockers.push("PROGRAM_BLACKLIST_EXCLUSION_MISSING");
    addHint(
      hints,
      "PROGRAM_BLACKLIST_EXCLUSION_MISSING",
      "blocker",
      "safety",
      "The crm_blacklist audience is not excluded.",
      "Set safety.exclude_crm_blacklist to true before activation."
    );
  }
  if (paidTvRequired && !paidTvExcluded) {
    blockers.push("PROGRAM_PAID_TV_EXCLUSION_MISSING");
    addHint(
      hints,
      "PROGRAM_PAID_TV_EXCLUSION_MISSING",
      "blocker",
      "safety",
      "Discount and acquisition programs must exclude paid_tv_users.",
      "Set safety.exclude_paid_tv_users to true and review paid exposure before activation."
    );
  }
  dimensions.push({
    key: "safety",
    label: "Audience safety",
    score: safetyScore,
    max_score: 30,
    status: statusForDimension(safetyScore, 30, safetyScore < 30 || (paidTvRequired && !paidTvExcluded)),
    detail: safetyScore === 30 && (!paidTvRequired || paidTvExcluded) ? "Consent and required safety exclusions are explicit." : "One or more mandatory audience protections are missing."
  });

  var segmentKey = findNestedString(audience, ["segment_key", "segment"]);
  if (!segmentKey) segmentKey = findNestedString(definition, ["segment_key", "audience_segment_key"]);
  var segmentExists = resolveSegmentExistence(segmentKey, audience, context);
  var audienceScore = 0;
  if (segmentKey) audienceScore += 10;
  else {
    blockers.push("PROGRAM_SEGMENT_KEY_MISSING");
    addHint(
      hints,
      "PROGRAM_SEGMENT_KEY_MISSING",
      "blocker",
      "audience",
      "The program has no stable audience segment key.",
      "Select a CRM Studio segment and persist its segment_key."
    );
  }
  if (segmentExists === true) audienceScore += 15;
  else if (segmentExists === false) {
    blockers.push("PROGRAM_SEGMENT_NOT_FOUND");
    addHint(
      hints,
      "PROGRAM_SEGMENT_NOT_FOUND",
      "blocker",
      "audience",
      "The configured audience segment does not exist.",
      "Create or restore the segment, then score readiness again with segment_exists = true."
    );
  } else {
    blockers.push("PROGRAM_SEGMENT_UNVERIFIED");
    addHint(
      hints,
      "PROGRAM_SEGMENT_UNVERIFIED",
      "blocker",
      "audience",
      "Audience segment existence was not verified.",
      "Resolve the segment from storage and pass segment_exists or available_segment_keys into the scorer."
    );
  }
  dimensions.push({
    key: "audience",
    label: "Audience definition",
    score: audienceScore,
    max_score: 25,
    status: statusForDimension(audienceScore, 25, segmentExists !== true || !segmentKey),
    detail: segmentExists === true && segmentKey ? "The referenced audience segment exists." : "The audience reference is missing or unverified."
  });

  var inlineTemplate = resolveTemplate(definition);
  var templateExists = resolveTemplateExistence(definition, context);
  var templateScore = 0;
  var templateQuality: ScoreResult | null = null;
  var templateDimensionBlocked = false;
  if (inlineTemplate) {
    if (inlineTemplate.channel !== "email") {
      templateDimensionBlocked = true;
      blockers.push("PROGRAM_TEMPLATE_CHANNEL_UNSUPPORTED");
      addHint(hints, "PROGRAM_TEMPLATE_CHANNEL_UNSUPPORTED", "blocker", "template", "The program template channel is missing or unsupported.", "Use an email template in CRM Studio V1.");
    }
    if (inlineTemplate.is_active !== true) {
      templateDimensionBlocked = true;
      blockers.push("PROGRAM_TEMPLATE_INACTIVE");
      addHint(hints, "PROGRAM_TEMPLATE_INACTIVE", "blocker", "template", "The program template is not active configuration.", "Activate a safe template revision before marking the program ready.");
    }
    templateQuality = scoreTemplateQuality(inlineTemplate);
    templateScore = Math.round(templateQuality.score * 0.25);
    if (templateQuality.blockers.length > 0) {
      templateDimensionBlocked = true;
      blockers.push("PROGRAM_TEMPLATE_UNSAFE");
      addHint(
        hints,
        "PROGRAM_TEMPLATE_UNSAFE",
        "blocker",
        "template",
        "The inline message template contains a safety blocker.",
        "Resolve every blocker returned by scoreTemplateQuality before activation."
      );
    } else {
      var requiredTemplateContentMissing = false;
      for (var templateHintIndex = 0; templateHintIndex < templateQuality.hints.length; templateHintIndex++) {
        var templateHintCode = templateQuality.hints[templateHintIndex].code;
        if (
          templateHintCode === "TEMPLATE_SUBJECT_MISSING" ||
          templateHintCode === "TEMPLATE_BODY_MISSING" ||
          templateHintCode === "TEMPLATE_CTA_LABEL_MISSING" ||
          templateHintCode === "TEMPLATE_CTA_URL_MISSING"
        ) {
          requiredTemplateContentMissing = true;
        }
      }
      if (requiredTemplateContentMissing) {
        templateDimensionBlocked = true;
        blockers.push("PROGRAM_TEMPLATE_INCOMPLETE");
        addHint(
          hints,
          "PROGRAM_TEMPLATE_INCOMPLETE",
          "blocker",
          "template",
          "The inline template is missing required subject, body, or CTA coverage.",
          "Complete the required template fields and run the readiness score again."
        );
      }
    }
    if (templateQuality.blockers.length === 0 && templateQuality.score < 75) {
      addHint(
        hints,
        "PROGRAM_TEMPLATE_QUALITY_LOW",
        "medium",
        "template",
        "The inline template is incomplete or low quality.",
        "Improve subject, body, CTA, personalization, and fallback coverage until template quality is at least 75."
      );
    }
  } else if (templateExists === true) {
    var referencedQuality = resolveTemplateQualityScore(context);
    if (referencedQuality === null) {
      templateScore = 12;
      templateDimensionBlocked = true;
      blockers.push("PROGRAM_TEMPLATE_UNSCORED");
      addHint(
        hints,
        "PROGRAM_TEMPLATE_UNSCORED",
        "medium",
        "template",
        "The referenced template exists but has no quality score.",
        "Load the template definition, run scoreTemplateQuality, and pass template_quality_score."
      );
    } else {
      templateScore = Math.round(referencedQuality * 0.25);
      if (referencedQuality < 75) {
        templateDimensionBlocked = true;
        blockers.push("PROGRAM_TEMPLATE_NOT_READY");
        addHint(
          hints,
          "PROGRAM_TEMPLATE_QUALITY_LOW",
          "medium",
          "template",
          "The referenced template quality score is below 75.",
          "Improve the template and rescore it before scheduling the program."
        );
      }
    }
  } else {
    templateDimensionBlocked = true;
    var missingTemplateCode = templateExists === false ? "PROGRAM_TEMPLATE_MISSING" : "PROGRAM_TEMPLATE_UNVERIFIED";
    blockers.push(missingTemplateCode);
    addHint(
      hints,
      missingTemplateCode,
      "blocker",
      "template",
      templateExists === false ? "The program has no message template." : "The referenced message template was not verified.",
      "Attach an inline template or verify the referenced template exists."
    );
  }
  dimensions.push({
    key: "template",
    label: "Message template",
    score: templateScore,
    max_score: 25,
    status: statusForDimension(templateScore, 25, templateDimensionBlocked),
    detail: templateQuality ? "Inline template quality: " + templateQuality.score + "/100." : templateExists === true ? "Referenced template coverage is available." : "Template coverage is missing or unverified."
  });

  var measurementScore = 0;
  var primaryMetric = findNestedString(measurement, ["primary_metric", "goal_metric", "success_metric"]);
  var conversionEvent = findNestedString(measurement, ["conversion_event", "success_event", "event"]);
  var attributionDays = measurement ? asFiniteNumber(measurement.attribution_window_days) : null;
  var targetValue = measurement ? asFiniteNumber(measurement.target_value) : null;
  var baselineValue = measurement ? asFiniteNumber(measurement.baseline_value) : null;
  var controlPercent = measurement ? asFiniteNumber(measurement.control_group_percentage) : null;
  var measurementBlocked = false;
  if (primaryMetric) measurementScore += 6;
  else {
    measurementBlocked = true;
    blockers.push("PROGRAM_PRIMARY_METRIC_MISSING");
    addHint(hints, "PROGRAM_PRIMARY_METRIC_MISSING", "blocker", "measurement", "No primary success metric is defined.", "Set measurement.primary_metric to one business outcome.");
  }
  if (conversionEvent) measurementScore += 5;
  else {
    measurementBlocked = true;
    blockers.push("PROGRAM_CONVERSION_EVENT_MISSING");
    addHint(hints, "PROGRAM_CONVERSION_EVENT_MISSING", "blocker", "measurement", "No attributable conversion event is defined.", "Set measurement.conversion_event to a stable event key.");
  }
  if (attributionDays !== null && attributionDays > 0 && attributionDays <= 365) measurementScore += 4;
  else {
    measurementBlocked = true;
    blockers.push("PROGRAM_ATTRIBUTION_WINDOW_MISSING");
    addHint(hints, "PROGRAM_ATTRIBUTION_WINDOW_MISSING", "blocker", "measurement", "The attribution window is missing or invalid.", "Set attribution_window_days between 1 and 365.");
  }
  if (targetValue !== null || baselineValue !== null || (controlPercent !== null && controlPercent > 0 && controlPercent < 100)) measurementScore += 5;
  else {
    measurementBlocked = true;
    blockers.push("PROGRAM_COMPARISON_PLAN_MISSING");
    addHint(hints, "PROGRAM_COMPARISON_PLAN_MISSING", "blocker", "measurement", "The program has no target, baseline, or control group.", "Add target_value, baseline_value, or a control_group_percentage between 0 and 100.");
  }
  dimensions.push({
    key: "measurement",
    label: "Measurement plan",
    score: measurementScore,
    max_score: 20,
    status: statusForDimension(measurementScore, 20, measurementBlocked),
    detail: measurementScore === 20 ? "Outcome, attribution, and comparison are defined." : "The measurement plan is incomplete."
  });

  var total = safetyScore + audienceScore + templateScore + measurementScore;
  if (blockers.length > 0) total = Math.min(total, 49);
  total = roundScore(total);
  var knownCoverage = 0;
  if (segmentExists !== null) knownCoverage++;
  if (inlineTemplate || templateExists !== null) knownCoverage++;
  if (measurement) knownCoverage++;
  var confidence = confidenceForCoverage(knownCoverage, 3);
  return {
    score: total,
    grade: blockers.length > 0 ? "Blocked" : gradeForScore(total),
    confidence: confidence,
    confidence_score: confidenceNumber(confidence),
    dimensions: dimensions,
    hints: hints,
    blockers: blockers
  };
}

function firstTemplateString(template: JsonRecord, keys: string[]): string | null {
  return findNestedString(template, keys);
}

function templateHasHtml(value: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(value);
}

function decodeHtmlEntities(value: string): string {
  var decoded = value.replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, function(_match, hexadecimal, decimal) {
    var codePoint = parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 1114111) return "";
    try {
      return String.fromCodePoint(codePoint);
    } catch (_error) {
      return "";
    }
  });
  return decoded
    .replace(/&colon;?/gi, ":")
    .replace(/&tab;?/gi, "\t")
    .replace(/&newline;?/gi, "\n")
    .replace(/&lt;?/gi, "<")
    .replace(/&gt;?/gi, ">")
    .replace(/&quot;?/gi, "\"")
    .replace(/&apos;?/gi, "'")
    .replace(/&amp;?/gi, "&");
}

function appendTemplateString(values: string[], value: unknown): void {
  if (typeof value === "string") values.push(value);
}

function allTemplateStrings(template: JsonRecord): string {
  var values: string[] = [];
  var keys = ["subject", "body", "html", "body_html", "content", "text", "body_text", "plain_text", "cta_label", "cta_text", "cta_url", "cta_href"];
  for (var index = 0; index < keys.length; index++) appendTemplateString(values, template[keys[index]]);
  var cta = asRecord(template.cta);
  if (cta) {
    appendTemplateString(values, cta.label);
    appendTemplateString(values, cta.text);
    appendTemplateString(values, cta.url);
    appendTemplateString(values, cta.href);
  }
  return values.join(" ");
}

function templateHasActiveContent(value: string): boolean {
  var normalized = decodeHtmlEntities(value).toLowerCase();
  var compact = normalized.replace(/[\u0000-\u0020]+/g, "");
  if (normalized.indexOf("<script") >= 0) return true;
  if (normalized.indexOf("<svg") >= 0 || normalized.indexOf("<math") >= 0) return true;
  if (compact.indexOf("javascript:") >= 0) return true;
  if (compact.indexOf("data:text/html") >= 0) return true;
  if (/<\s*(iframe|object|embed)\b/i.test(normalized)) return true;
  if (/<\s*(meta|link)\b/i.test(normalized)) return true;
  if (/\bsrcdoc\s*=/i.test(normalized)) return true;
  return /[\s/]on[a-z]+\s*=/i.test(normalized);
}

function templateHasManualUnsubscribe(value: string): boolean {
  return /unsubscribe|opt[ -]?out|hủy\s*đăng\s*ký|huy\s*dang\s*ky|\{\{\s*unsubscribe(?:_url)?\s*\}\}/i.test(decodeHtmlEntities(value));
}

function templateHasPersonalization(value: string): boolean {
  return /\{\{\s*(first_name|name|display_name|profile\.name)\s*\}\}/i.test(value);
}

function resolveCta(template: JsonRecord): { label: string | null; url: string | null } {
  var cta = asRecord(template.cta);
  var label = findNestedString(cta, ["label", "text"]);
  var url = findNestedString(cta, ["url", "href"]);
  if (!label) label = findNestedString(template, ["cta_label", "cta_text"]);
  if (!url) url = findNestedString(template, ["cta_url", "cta_href"]);
  return { label: label, url: url };
}

function isSafeCtaUrl(value: string): boolean {
  var decoded = decodeHtmlEntities(value).trim();
  if (templateHasActiveContent(decoded)) return false;
  return /^https:\/\/[^\s]+$/i.test(decoded) || /^\/[A-Za-z0-9]/.test(decoded);
}

export function scoreTemplateQuality(templateInput: unknown): ScoreResult {
  var template = asRecord(templateInput) || {};
  var hints: ScoringHint[] = [];
  var blockers: string[] = [];
  var dimensions: ScoringDimension[] = [];
  var subject = firstTemplateString(template, ["subject"]);
  var body = firstTemplateString(template, ["body", "html", "body_html", "content"]);
  var textBody = firstTemplateString(template, ["text", "body_text", "plain_text"]);
  var coverageScore = 0;

  if (subject) {
    coverageScore += 10;
    if (subject.length >= 20 && subject.length <= 65) coverageScore += 5;
    else {
      coverageScore += 2;
      addHint(hints, "TEMPLATE_SUBJECT_LENGTH", "low", "coverage", "The subject is outside the recommended 20 to 65 character range.", "Rewrite the subject to be specific and scannable in 20 to 65 characters.");
    }
  } else addHint(hints, "TEMPLATE_SUBJECT_MISSING", "high", "coverage", "The template has no subject.", "Add a concise subject line.");

  if (body) {
    coverageScore += 15;
    var visibleBody = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (visibleBody.length >= 80) coverageScore += 10;
    else if (visibleBody.length >= 20) {
      coverageScore += 5;
      addHint(hints, "TEMPLATE_BODY_THIN", "medium", "coverage", "The message body has little explanatory content.", "Explain the value and next step in at least 80 visible characters.");
    } else {
      coverageScore += 2;
      addHint(hints, "TEMPLATE_BODY_THIN", "high", "coverage", "The message body is too short to communicate value safely.", "Add a clear value proposition and next step.");
    }
  } else addHint(hints, "TEMPLATE_BODY_MISSING", "high", "coverage", "The template has no message body.", "Add a complete message body.");

  dimensions.push({
    key: "coverage",
    label: "Subject and body coverage",
    score: coverageScore,
    max_score: 40,
    status: statusForDimension(coverageScore, 40, false),
    detail: subject && body ? "Subject and body are present." : "Required message content is missing."
  });

  var cta = resolveCta(template);
  var ctaScore = 0;
  if (cta.label) ctaScore += 10;
  else addHint(hints, "TEMPLATE_CTA_LABEL_MISSING", "medium", "cta", "The call to action has no label.", "Add one concrete action label.");
  if (cta.url && isSafeCtaUrl(cta.url)) ctaScore += 10;
  else if (cta.url) {
    blockers.push("TEMPLATE_CTA_URL_UNSAFE");
    addHint(hints, "TEMPLATE_CTA_URL_UNSAFE", "blocker", "cta", "The CTA URL is not an HTTPS or safe relative URL.", "Use an HTTPS destination or a validated relative application path.");
  } else addHint(hints, "TEMPLATE_CTA_URL_MISSING", "medium", "cta", "The call to action has no destination.", "Add a validated HTTPS CTA URL.");
  dimensions.push({
    key: "cta",
    label: "Call to action",
    score: ctaScore,
    max_score: 20,
    status: statusForDimension(ctaScore, 20, cta.url !== null && !isSafeCtaUrl(cta.url)),
    detail: ctaScore === 20 ? "CTA label and destination are complete." : "CTA coverage is incomplete or unsafe."
  });

  var combined = allTemplateStrings(template);
  var personalizationScore = templateHasPersonalization(combined) ? 10 : 0;
  if (personalizationScore === 0) addHint(hints, "TEMPLATE_PERSONALIZATION_MISSING", "low", "personalization", "No supported recipient-name token is present.", "Use {{first_name}}, {{name}}, {{display_name}}, or {{profile.name}} when a safe fallback is available.");
  dimensions.push({
    key: "personalization",
    label: "Personalization",
    score: personalizationScore,
    max_score: 10,
    status: statusForDimension(personalizationScore, 10, false),
    detail: personalizationScore === 10 ? "A supported recipient-name token is present." : "No supported personalization token was found."
  });

  var safetyScore = combined.trim() ? 25 : 0;
  var activeContent = templateHasActiveContent(combined);
  var manualUnsubscribe = templateHasManualUnsubscribe(combined);
  if (activeContent) {
    safetyScore -= 15;
    blockers.push("TEMPLATE_ACTIVE_CONTENT");
    addHint(hints, "TEMPLATE_ACTIVE_CONTENT", "blocker", "safety", "The template contains scriptable or embedded active content.", "Remove scripts, event handlers, JavaScript URLs, iframes, objects, and embeds.");
  }
  if (manualUnsubscribe) {
    safetyScore -= 10;
    blockers.push("TEMPLATE_MANUAL_UNSUBSCRIBE");
    addHint(hints, "TEMPLATE_MANUAL_UNSUBSCRIBE", "blocker", "safety", "The template manually implements unsubscribe content.", "Remove the manual link and use the signed compliance footer from the trusted delivery layer.");
  }
  dimensions.push({
    key: "safety",
    label: "Template safety",
    score: safetyScore,
    max_score: 25,
    status: statusForDimension(safetyScore, 25, activeContent || manualUnsubscribe),
    detail: safetyScore === 25 ? "No active content or manual unsubscribe implementation was detected." : combined.trim() ? "Unsafe template constructs require removal." : "No content was available for a safety assessment."
  });

  var fallbackScore = 0;
  if (body && !templateHasHtml(body)) fallbackScore = 5;
  else if (body && textBody) fallbackScore = 5;
  else if (body) addHint(hints, "TEMPLATE_TEXT_FALLBACK_MISSING", "low", "fallback", "The HTML message has no plain-text fallback.", "Add body_text or plain_text for non-HTML clients.");
  dimensions.push({
    key: "fallback",
    label: "Plain-text fallback",
    score: fallbackScore,
    max_score: 5,
    status: statusForDimension(fallbackScore, 5, false),
    detail: fallbackScore === 5 ? "Plain-text rendering is covered." : "A plain-text fallback is missing."
  });

  var total = coverageScore + ctaScore + personalizationScore + safetyScore + fallbackScore;
  if (blockers.length > 0) total = Math.min(total, 49);
  total = roundScore(total);
  var known = 0;
  if (subject) known++;
  if (body) known++;
  if (cta.label || cta.url) known++;
  var confidence = confidenceForCoverage(known, 3);
  return {
    score: total,
    grade: blockers.length > 0 ? "Unsafe" : gradeForScore(total),
    confidence: confidence,
    confidence_score: confidenceNumber(confidence),
    dimensions: dimensions,
    hints: hints,
    blockers: blockers
  };
}

function readCount(metrics: JsonRecord, keys: string[]): number | null {
  for (var index = 0; index < keys.length; index++) {
    if (metrics[keys[index]] !== undefined) return asFiniteNumber(metrics[keys[index]]);
  }
  return null;
}

function validCount(value: number | null): boolean {
  return value !== null && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function scaledRate(rate: number, floor: number, target: number, maximum: number): number {
  if (target <= floor) return 0;
  return Math.round(clamp((rate - floor) / (target - floor), 0, 1) * maximum);
}

function lowerIsBetterScore(rate: number, target: number, failure: number, maximum: number): number {
  if (rate <= target) return maximum;
  if (rate >= failure) return 0;
  return Math.round((1 - (rate - target) / (failure - target)) * maximum);
}

function performanceConfidence(sample: number, minimum: number): ScoreConfidence {
  if (sample < minimum) return "insufficient";
  if (sample >= minimum * 20) return "high";
  if (sample >= minimum * 5) return "medium";
  return "low";
}

function emptyPerformanceDimensions(status: ScoreStatus): ScoringDimension[] {
  return [
    { key: "delivery", label: "Delivery rate", score: null, max_score: 30, status: status, detail: "Not scored." },
    { key: "click", label: "Click rate", score: null, max_score: 25, status: status, detail: "Not scored." },
    { key: "conversion", label: "Conversion rate", score: null, max_score: 30, status: status, detail: "Not scored." },
    { key: "safety", label: "Complaint and unsubscribe safety", score: null, max_score: 15, status: status, detail: "Not scored." }
  ];
}

export function scoreProgramPerformance(metricsInput: unknown, optionsInput?: unknown): PerformanceScoreResult {
  var metrics = asRecord(metricsInput) || {};
  var options = asRecord(optionsInput);
  var configuredMinimum = options ? asFiniteNumber(options.minimum_sample_size) : null;
  if (configuredMinimum === null && options) configuredMinimum = asFiniteNumber(options.min_sample_size);
  var minimum = configuredMinimum !== null && Number.isInteger(configuredMinimum) && configuredMinimum > 0 ? configuredMinimum : 100;
  var sent = readCount(metrics, ["sent", "sent_count"]);
  var delivered = readCount(metrics, ["delivered", "delivered_count"]);
  var clicks = readCount(metrics, ["unique_clicks", "clicked", "clicks", "click_count"]);
  var conversions = readCount(metrics, ["conversions", "conversion_count"]);
  var complaints = readCount(metrics, ["complaints", "complaint_count", "spam_complaints"]);
  var unsubscribes = readCount(metrics, ["unsubscribes", "unsubscribed", "unsubscribe_count"]);
  var hints: ScoringHint[] = [];
  var blockers: string[] = [];

  if (!validCount(sent) || !validCount(delivered) || !validCount(clicks) || !validCount(conversions) || !validCount(complaints) || !validCount(unsubscribes)) {
    blockers.push("PERFORMANCE_COUNTS_INVALID");
    addHint(hints, "PERFORMANCE_COUNTS_INVALID", "blocker", "measurement", "Performance counts must be present as non-negative safe integers.", "Provide sent, delivered, unique_clicks, conversions, complaints, and unsubscribes aggregate counts.");
    return {
      score: null,
      grade: "Invalid data",
      confidence: "none",
      confidence_score: 0,
      dimensions: emptyPerformanceDimensions("blocked"),
      hints: hints,
      blockers: blockers,
      sample_size: validCount(sent) ? sent as number : 0,
      minimum_sample_size: minimum,
      rates: { delivery: null, click: null, conversion: null, complaint: null, unsubscribe: null, safe_contact: null }
    };
  }

  var sentCount = sent as number;
  var deliveredCount = delivered as number;
  var clickCount = clicks as number;
  var conversionCount = conversions as number;
  var complaintCount = complaints as number;
  var unsubscribeCount = unsubscribes as number;
  if (deliveredCount > sentCount || clickCount > deliveredCount || conversionCount > deliveredCount || complaintCount > deliveredCount || unsubscribeCount > deliveredCount) {
    blockers.push("PERFORMANCE_COUNTS_INCONSISTENT");
    addHint(hints, "PERFORMANCE_COUNTS_INCONSISTENT", "blocker", "measurement", "Aggregate counts violate denominator constraints.", "Ensure delivered is at most sent and downstream outcome counts are at most delivered.");
    return {
      score: null,
      grade: "Invalid data",
      confidence: "none",
      confidence_score: 0,
      dimensions: emptyPerformanceDimensions("blocked"),
      hints: hints,
      blockers: blockers,
      sample_size: sentCount,
      minimum_sample_size: minimum,
      rates: { delivery: null, click: null, conversion: null, complaint: null, unsubscribe: null, safe_contact: null }
    };
  }

  var deliveryRate = sentCount > 0 ? deliveredCount / sentCount : 0;
  var clickRate = deliveredCount > 0 ? clickCount / deliveredCount : 0;
  var conversionRate = deliveredCount > 0 ? conversionCount / deliveredCount : 0;
  var complaintRate = deliveredCount > 0 ? complaintCount / deliveredCount : 0;
  var unsubscribeRate = deliveredCount > 0 ? unsubscribeCount / deliveredCount : 0;
  var safeContactRate = deliveredCount > 0 ? clamp(1 - complaintRate - unsubscribeRate, 0, 1) : 0;
  var rates: JsonRecord = {
    delivery: deliveryRate,
    click: clickRate,
    conversion: conversionRate,
    complaint: complaintRate,
    unsubscribe: unsubscribeRate,
    safe_contact: safeContactRate
  };
  var effectiveSample = Math.min(sentCount, deliveredCount);

  if (effectiveSample < minimum) {
    addHint(hints, "PERFORMANCE_SAMPLE_TOO_SMALL", "medium", "measurement", "The delivered sample is below the configured minimum.", "Collect at least " + minimum + " delivered messages before using downstream performance rates.");
    return {
      score: null,
      grade: "Insufficient data",
      confidence: "insufficient",
      confidence_score: 0,
      dimensions: emptyPerformanceDimensions("insufficient"),
      hints: hints,
      blockers: blockers,
      sample_size: effectiveSample,
      minimum_sample_size: minimum,
      rates: rates
    };
  }

  var deliveryScore = scaledRate(deliveryRate, 0.8, 0.98, 30);
  var clickScore = scaledRate(clickRate, 0.005, 0.08, 25);
  var conversionScore = scaledRate(conversionRate, 0, 0.05, 30);
  var complaintScore = lowerIsBetterScore(complaintRate, 0.001, 0.005, 8);
  var unsubscribeScore = lowerIsBetterScore(unsubscribeRate, 0.005, 0.03, 7);
  var safetyScore = complaintScore + unsubscribeScore;

  if (deliveryRate < 0.95) addHint(hints, "PERFORMANCE_DELIVERY_LOW", "high", "delivery", "Delivery rate is below 95%.", "Review list hygiene, suppressions, and provider rejection reasons.");
  if (clickRate < 0.02) addHint(hints, "PERFORMANCE_CLICK_LOW", "medium", "click", "Unique click rate is below 2% of delivered messages.", "Test message relevance, CTA clarity, and audience fit.");
  if (conversionRate < 0.01) addHint(hints, "PERFORMANCE_CONVERSION_LOW", "medium", "conversion", "Attributed conversion rate is below 1% of delivered messages.", "Check offer alignment, landing flow, and attribution-event integrity.");
  if (complaintRate > 0.001) addHint(hints, "PERFORMANCE_COMPLAINT_HIGH", "high", "safety", "Complaint rate is above 0.1%.", "Pause expansion, inspect consent evidence, and narrow the audience before resuming.");
  if (unsubscribeRate > 0.005) addHint(hints, "PERFORMANCE_UNSUBSCRIBE_HIGH", "high", "safety", "Unsubscribe rate is above 0.5%.", "Reduce frequency and improve audience-message relevance.");
  var safetyBlocked = false;
  if (complaintRate >= 0.005) {
    safetyBlocked = true;
    blockers.push("PERFORMANCE_COMPLAINT_GUARDRAIL");
    addHint(hints, "PERFORMANCE_COMPLAINT_GUARDRAIL", "blocker", "safety", "Complaint rate reached the 0.5% stop threshold.", "Keep expansion blocked until consent, audience, and provider evidence are reviewed.");
  }
  if (unsubscribeRate >= 0.03) {
    safetyBlocked = true;
    blockers.push("PERFORMANCE_UNSUBSCRIBE_GUARDRAIL");
    addHint(hints, "PERFORMANCE_UNSUBSCRIBE_GUARDRAIL", "blocker", "safety", "Unsubscribe rate reached the 3% stop threshold.", "Keep expansion blocked and correct frequency or audience-message fit.");
  }

  var dimensions: ScoringDimension[] = [
    {
      key: "delivery",
      label: "Delivery rate",
      score: deliveryScore,
      max_score: 30,
      status: statusForDimension(deliveryScore, 30, false),
      detail: Math.round(deliveryRate * 10000) / 100 + "% delivered."
    },
    {
      key: "click",
      label: "Click rate",
      score: clickScore,
      max_score: 25,
      status: statusForDimension(clickScore, 25, false),
      detail: Math.round(clickRate * 10000) / 100 + "% unique clicks per delivered message."
    },
    {
      key: "conversion",
      label: "Conversion rate",
      score: conversionScore,
      max_score: 30,
      status: statusForDimension(conversionScore, 30, false),
      detail: Math.round(conversionRate * 10000) / 100 + "% conversions per delivered message."
    },
    {
      key: "safety",
      label: "Complaint and unsubscribe safety",
      score: safetyScore,
      max_score: 15,
      status: statusForDimension(safetyScore, 15, safetyBlocked),
      detail: Math.round(complaintRate * 10000) / 100 + "% complaints; " + Math.round(unsubscribeRate * 10000) / 100 + "% unsubscribes."
    }
  ];
  var total = roundScore(deliveryScore + clickScore + conversionScore + safetyScore);
  var confidence = performanceConfidence(effectiveSample, minimum);
  return {
    score: total,
    grade: safetyBlocked ? "Blocked" : gradeForScore(total),
    confidence: confidence,
    confidence_score: confidenceNumber(confidence),
    dimensions: dimensions,
    hints: hints,
    blockers: blockers,
    sample_size: effectiveSample,
    minimum_sample_size: minimum,
    rates: rates
  };
}

export function scoreTemplatePerformance(metricsInput: unknown, optionsInput?: unknown): PerformanceScoreResult {
  return scoreProgramPerformance(metricsInput, optionsInput);
}
