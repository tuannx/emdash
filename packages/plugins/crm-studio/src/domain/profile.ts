import type {
  CrmProfile,
  CrmTraits,
  EmDashUser,
  JsonRecord,
  ProjectedProfileResult,
  ValidationResult
} from "../types.js";

var TRAIT_NAMES = [
  "billing_state",
  "lifecycle_stage",
  "has_tv",
  "paid_tv_access",
  "reachability",
  "email_health",
  "marketing_consent",
  "country",
  "last_active_at",
  "last_premium_conversion_at",
  "user_created_at",
  "days_since_active",
  "eligible_for_messaging"
];
var PROFILE_SCHEMA_VERSION = 2;

var TRAIT_NAME_SET: Record<string, boolean> = {};
for (var traitIndex = 0; traitIndex < TRAIT_NAMES.length; traitIndex++) {
  TRAIT_NAME_SET[TRAIT_NAMES[traitIndex]] = true;
}

function failure<T>(result: ValidationResult<unknown>): ValidationResult<T> {
  return { ok: false, code: result.code, message: result.message };
}

function copyRecord(input: JsonRecord): JsonRecord {
  var output: JsonRecord = {};
  var keys = Object.keys(input);
  for (var index = 0; index < keys.length; index++) {
    output[keys[index]] = input[keys[index]];
  }
  return output;
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  var normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 320) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

export function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return null;
  var normalized = value.trim();
  if (!normalized || normalized.length > maxLength) return null;
  return normalized;
}

export function validateIdentityToken(value: unknown, maxLength: number): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, code: "INVALID_IDENTITY", message: "Identity must be a string" };
  }
  var normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !/^[A-Za-z0-9._:@-]+$/.test(normalized)) {
    return { ok: false, code: "INVALID_IDENTITY", message: "Identity contains unsupported characters" };
  }
  return { ok: true, value: normalized };
}

export function normalizeSource(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, code: "INVALID_SOURCE", message: "External source is required" };
  }
  var normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) {
    return { ok: false, code: "INVALID_SOURCE", message: "External source must be a stable lowercase key" };
  }
  return { ok: true, value: normalized };
}

function isIsoDateOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 40) return false;
  return isStrictIsoTimestamp(value);
}

export function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var second = Number(match[6]);
  var offsetHour = match[9] ? Number(match[9]) : 0;
  var offsetMinute = match[10] ? Number(match[10]) : 0;
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
  return !Number.isNaN(Date.parse(value));
}

function isShortEnum(value: unknown): boolean {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function validateTraitValue(name: string, value: unknown): boolean {
  if (name === "has_tv" || name === "paid_tv_access" || name === "eligible_for_messaging") {
    return value === null || typeof value === "boolean";
  }
  if (name === "days_since_active") {
    return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 365000);
  }
  if (name === "last_active_at" || name === "last_premium_conversion_at" || name === "user_created_at") {
    return isIsoDateOrNull(value);
  }
  if (name === "country") {
    return value === null || (typeof value === "string" && /^[A-Z]{2,3}$/.test(value));
  }
  if (name === "marketing_consent") {
    return value === "unknown" || value === "granted" || value === "denied";
  }
  return isShortEnum(value);
}

export function defaultTraits(userCreatedAt: string | null): CrmTraits {
  return {
    billing_state: "unknown",
    lifecycle_stage: "unknown",
    has_tv: null,
    paid_tv_access: null,
    reachability: "unknown",
    email_health: "unknown",
    marketing_consent: "unknown",
    country: null,
    last_active_at: null,
    last_premium_conversion_at: null,
    user_created_at: userCreatedAt,
    days_since_active: null,
    eligible_for_messaging: false
  };
}

export function sanitizeTraits(input: unknown): ValidationResult<Partial<CrmTraits>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "INVALID_TRAITS", message: "traits must be an object" };
  }
  var record = input as JsonRecord;
  var keys = Object.keys(record);
  var output: Partial<CrmTraits> = {};
  for (var index = 0; index < keys.length; index++) {
    var key = keys[index];
    if (!TRAIT_NAME_SET[key]) {
      return { ok: false, code: "UNKNOWN_TRAIT", message: "Unsupported trait: " + key };
    }
    if (!validateTraitValue(key, record[key])) {
      return { ok: false, code: "INVALID_TRAIT_VALUE", message: "Invalid value for trait: " + key };
    }
    output[key] = record[key] as never;
  }
  return { ok: true, value: output };
}

export function normalizeConsentEvidence(
  input: unknown,
  incomingConsent: unknown,
  existingEvidence: JsonRecord | null,
  lastEvidenceAt?: string | null
): ValidationResult<JsonRecord | null> {
  if (input === undefined || input === null) {
    if (incomingConsent === "granted") {
      return {
        ok: false,
        code: "CONSENT_EVIDENCE_REQUIRED",
        message: "Setting marketing_consent to granted requires consent_evidence"
      };
    }
    if (incomingConsent === "denied" || incomingConsent === "unknown") return { ok: true, value: null };
    return { ok: true, value: existingEvidence };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "INVALID_CONSENT_EVIDENCE", message: "consent_evidence must be an object" };
  }
  if (incomingConsent !== "granted") {
    return {
      ok: false,
      code: "CONSENT_EVIDENCE_WITHOUT_GRANT",
      message: "consent_evidence is only accepted with an explicit marketing_consent grant"
    };
  }
  var record = input as JsonRecord;
  var sourceResult = normalizeSource(record.source);
  if (!sourceResult.ok || !sourceResult.value) return failure<JsonRecord | null>(sourceResult);
  if (!isStrictIsoTimestamp(record.captured_at)) {
    return { ok: false, code: "INVALID_CONSENT_EVIDENCE", message: "consent_evidence.captured_at must be an ISO timestamp" };
  }
  if (Date.parse(record.captured_at) > Date.now() + 5 * 60 * 1000) {
    return { ok: false, code: "INVALID_CONSENT_EVIDENCE", message: "consent evidence cannot be captured in the future" };
  }
  var policyVersion = normalizeOptionalText(record.policy_version, 100);
  if (!policyVersion) {
    return { ok: false, code: "INVALID_CONSENT_EVIDENCE", message: "consent_evidence.policy_version is required" };
  }
  var channel = record.channel === undefined ? "email" : record.channel;
  if (channel !== "email") {
    return { ok: false, code: "INVALID_CONSENT_EVIDENCE", message: "V1 only supports email consent evidence" };
  }
  var minimumCapturedAt = lastEvidenceAt;
  if (!minimumCapturedAt && existingEvidence && typeof existingEvidence.captured_at === "string") {
    minimumCapturedAt = existingEvidence.captured_at;
  }
  var evidenceTime = Date.parse(record.captured_at);
  var minimumTime = minimumCapturedAt ? Date.parse(minimumCapturedAt) : Number.NaN;
  if (
    minimumCapturedAt &&
    (evidenceTime < minimumTime || (!existingEvidence && lastEvidenceAt === minimumCapturedAt && evidenceTime === minimumTime))
  ) {
    return { ok: false, code: "STALE_CONSENT_EVIDENCE", message: "Consent evidence is older than or reuses cleared historical evidence" };
  }
  return {
    ok: true,
    value: {
      source: sourceResult.value,
      captured_at: record.captured_at,
      policy_version: policyVersion,
      channel: channel
    }
  };
}

function validateTraitOrdering(
  existing: CrmProfile | null,
  incoming: Partial<CrmTraits>,
  timestamp: string
): ValidationResult<Record<string, string>> {
  var updatedAt: Record<string, string> = {};
  if (existing && existing.trait_updated_at) {
    var existingKeys = Object.keys(existing.trait_updated_at);
    for (var existingIndex = 0; existingIndex < existingKeys.length; existingIndex++) {
      updatedAt[existingKeys[existingIndex]] = existing.trait_updated_at[existingKeys[existingIndex]];
    }
  }
  var incomingKeys = Object.keys(incoming);
  for (var index = 0; index < incomingKeys.length; index++) {
    var key = incomingKeys[index];
    if (updatedAt[key]) {
      var incomingTime = Date.parse(timestamp);
      var currentTime = Date.parse(updatedAt[key]);
      if (incomingTime < currentTime) {
        return { ok: false, code: "STALE_TRAIT_UPDATE", message: "Trait update is older than current value: " + key };
      }
      if (incomingTime === currentTime && existing && stableStringify(existing.traits[key]) !== stableStringify(incoming[key])) {
        return { ok: false, code: "AMBIGUOUS_TRAIT_ORDER", message: "Conflicting trait values share the same timestamp: " + key };
      }
    }
    updatedAt[key] = timestamp;
  }
  return { ok: true, value: updatedAt };
}

function copyTraits(input: CrmTraits): CrmTraits {
  return copyRecord(input) as CrmTraits;
}

export function mergeTraits(existing: CrmTraits | null, incoming: Partial<CrmTraits>, userCreatedAt: string | null): CrmTraits {
  var merged = existing ? copyTraits(existing) : defaultTraits(userCreatedAt);
  var incomingKeys = Object.keys(incoming);
  for (var index = 0; index < incomingKeys.length; index++) {
    var key = incomingKeys[index];
    merged[key] = incoming[key] as never;
  }
  if (!merged.user_created_at && userCreatedAt) merged.user_created_at = userCreatedAt;

  // Eligibility is fail-closed and derived. Callers cannot turn it on by only
  // setting the derived field while consent or reachability remains unknown.
  merged.eligible_for_messaging =
    merged.marketing_consent === "granted" &&
    merged.email_health === "healthy" &&
    (merged.reachability === "email" || merged.reachability === "multi");
  return merged;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    var arrayParts: string[] = [];
    for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex++) {
      arrayParts.push(stableStringify(value[arrayIndex]));
    }
    return "[" + arrayParts.join(",") + "]";
  }
  var record = value as JsonRecord;
  var keys = Object.keys(record).sort();
  var parts: string[] = [];
  for (var index = 0; index < keys.length; index++) {
    var key = keys[index];
    if (record[key] !== undefined) {
      parts.push(JSON.stringify(key) + ":" + stableStringify(record[key]));
    }
  }
  return "{" + parts.join(",") + "}";
}

function flattenProfile(profile: CrmProfile): CrmProfile {
  profile.billing_state = profile.traits.billing_state;
  profile.lifecycle_stage = profile.traits.lifecycle_stage;
  profile.reachability = profile.traits.reachability;
  profile.email_health = profile.traits.email_health;
  profile.marketing_consent = profile.traits.marketing_consent;
  profile.country = profile.traits.country;
  return profile;
}

export function projectEmDashUser(user: EmDashUser, existing: CrmProfile | null, incomingTraits: Partial<CrmTraits>, timestamp: string): ProjectedProfileResult {
  var core = {
    id: user.id,
    email: normalizeEmail(user.email),
    name: normalizeOptionalText(user.name, 200),
    role: user.role,
    created_at: user.createdAt
  };
  var sourceFingerprint = stableStringify(core);
  var traits = mergeTraits(existing ? existing.traits : null, incomingTraits, user.createdAt || null);
  var sourceUpdatedAt = existing && existing.source_fingerprint === sourceFingerprint
    ? existing.source_updated_at || existing.updated_at
    : timestamp;
  var profile: CrmProfile = {
    id: "emdash:" + user.id,
    schema_version: PROFILE_SCHEMA_VERSION,
    identity_key: "emdash:" + user.id,
    source: "emdash",
    emdash_user_id: user.id,
    external_source: null,
    external_id: null,
    email: core.email,
    name: core.name,
    role: user.role,
    consent_evidence: existing ? existing.consent_evidence : null,
    last_consent_evidence_at: existing
      ? existing.last_consent_evidence_at || (
          existing.consent_evidence && typeof existing.consent_evidence.captured_at === "string"
            ? existing.consent_evidence.captured_at
            : null
        )
      : null,
    source_fingerprint: sourceFingerprint,
    source_updated_at: sourceUpdatedAt,
    traits: traits,
    trait_updated_at: existing && existing.trait_updated_at ? existing.trait_updated_at : {},
    last_ingest_request_id: existing ? existing.last_ingest_request_id || null : null,
    last_ingest_fingerprint: existing ? existing.last_ingest_fingerprint || null : null,
    last_ingest_outcome: existing ? existing.last_ingest_outcome || null : null,
    last_ingest_source: existing ? existing.last_ingest_source || null : null,
    last_migration_request_id: existing ? existing.last_migration_request_id || null : null,
    last_migration_fingerprint: existing ? existing.last_migration_fingerprint || null : null,
    last_migration_outcome: existing ? existing.last_migration_outcome || null : null,
    billing_state: traits.billing_state,
    lifecycle_stage: traits.lifecycle_stage,
    reachability: traits.reachability,
    email_health: traits.email_health,
    marketing_consent: traits.marketing_consent,
    country: traits.country,
    created_at: existing ? existing.created_at : timestamp,
    updated_at: timestamp,
    last_synced_at: timestamp
  };
  flattenProfile(profile);
  var changed =
    !existing ||
    existing.schema_version !== PROFILE_SCHEMA_VERSION ||
    existing.source_fingerprint !== sourceFingerprint ||
    stableStringify(existing.traits) !== stableStringify(traits) ||
    !existing.trait_updated_at ||
    existing.last_consent_evidence_at === undefined ||
    existing.last_ingest_request_id === undefined ||
    existing.last_migration_request_id === undefined ||
    existing.source_updated_at === undefined;
  return { profile: changed ? profile : existing as CrmProfile, changed: changed };
}

export function projectExternalProfile(input: JsonRecord, existing: CrmProfile | null, timestamp: string): ValidationResult<ProjectedProfileResult> {
  var sourceResult = normalizeSource(input.external_source || input.source);
  if (!sourceResult.ok || !sourceResult.value) return failure<ProjectedProfileResult>(sourceResult);
  var idResult = validateIdentityToken(input.external_id, 160);
  if (!idResult.ok || !idResult.value) return failure<ProjectedProfileResult>(idResult);
  var traitsResult = sanitizeTraits(input.traits);
  if (!traitsResult.ok || !traitsResult.value) return failure<ProjectedProfileResult>(traitsResult);
  var evidenceResult = normalizeConsentEvidence(
    input.consent_evidence,
    traitsResult.value.marketing_consent,
    existing ? existing.consent_evidence : null,
    existing ? existing.last_consent_evidence_at : null
  );
  if (!evidenceResult.ok || evidenceResult.value === undefined) return failure<ProjectedProfileResult>(evidenceResult);
  var orderingResult = validateTraitOrdering(existing, traitsResult.value, timestamp);
  if (!orderingResult.ok || !orderingResult.value) return failure<ProjectedProfileResult>(orderingResult);

  var identityKey = "external:" + sourceResult.value + ":" + idResult.value;
  var email: string | null = existing ? existing.email : null;
  if (input.email === null || input.email === "") email = null;
  else if (input.email !== undefined) {
    email = normalizeEmail(input.email);
    if (!email) return { ok: false, code: "INVALID_EMAIL", message: "email is invalid" };
  }
  var name = existing ? existing.name : null;
  if (input.name === null || input.name === "") name = null;
  else if (input.name !== undefined) {
    name = normalizeOptionalText(input.name, 200);
  }
  if (input.name !== undefined && input.name !== null && input.name !== "" && !name) {
    return { ok: false, code: "INVALID_NAME", message: "name is invalid" };
  }
  var traits = mergeTraits(existing ? existing.traits : null, traitsResult.value, null);
  var core = { external_source: sourceResult.value, external_id: idResult.value, email: email, name: name };
  var sourceFingerprint = stableStringify(core);
  var hasCorePatch = input.email !== undefined || input.name !== undefined;
  if (existing && hasCorePatch) {
    var incomingTime = Date.parse(timestamp);
    var existingTime = Date.parse(existing.source_updated_at || existing.updated_at);
    if (incomingTime < existingTime) {
      return { ok: false, code: "STALE_PROFILE_UPDATE", message: "Profile core update is older than the current value" };
    }
    if (incomingTime === existingTime && existing.source_fingerprint !== sourceFingerprint) {
      return { ok: false, code: "AMBIGUOUS_PROFILE_ORDER", message: "Conflicting profile core values share the same timestamp" };
    }
  }
  var sourceUpdatedAt = existing && !hasCorePatch
    ? existing.source_updated_at || existing.updated_at
    : timestamp;
  var profile: CrmProfile = {
    id: identityKey,
    schema_version: PROFILE_SCHEMA_VERSION,
    identity_key: identityKey,
    source: "external",
    emdash_user_id: null,
    external_source: sourceResult.value,
    external_id: idResult.value,
    email: email,
    name: name,
    role: null,
    consent_evidence: evidenceResult.value,
    last_consent_evidence_at: evidenceResult.value && typeof evidenceResult.value.captured_at === "string"
      ? evidenceResult.value.captured_at
      : existing ? existing.last_consent_evidence_at || null : null,
    source_fingerprint: sourceFingerprint,
    source_updated_at: sourceUpdatedAt,
    traits: traits,
    trait_updated_at: orderingResult.value,
    last_ingest_request_id: existing ? existing.last_ingest_request_id || null : null,
    last_ingest_fingerprint: existing ? existing.last_ingest_fingerprint || null : null,
    last_ingest_outcome: existing ? existing.last_ingest_outcome || null : null,
    last_ingest_source: existing ? existing.last_ingest_source || null : null,
    last_migration_request_id: existing ? existing.last_migration_request_id || null : null,
    last_migration_fingerprint: existing ? existing.last_migration_fingerprint || null : null,
    last_migration_outcome: existing ? existing.last_migration_outcome || null : null,
    billing_state: traits.billing_state,
    lifecycle_stage: traits.lifecycle_stage,
    reachability: traits.reachability,
    email_health: traits.email_health,
    marketing_consent: traits.marketing_consent,
    country: traits.country,
    created_at: existing ? existing.created_at : timestamp,
    updated_at: timestamp,
    last_synced_at: timestamp
  };
  flattenProfile(profile);
  var changed =
    !existing ||
    existing.schema_version !== PROFILE_SCHEMA_VERSION ||
    existing.source_fingerprint !== sourceFingerprint ||
    existing.source_updated_at !== sourceUpdatedAt ||
    stableStringify(existing.traits) !== stableStringify(traits) ||
    stableStringify(existing.consent_evidence) !== stableStringify(evidenceResult.value) ||
    stableStringify(existing.trait_updated_at) !== stableStringify(orderingResult.value);
  return { ok: true, value: { profile: changed ? profile : existing as CrmProfile, changed: changed } };
}

export function applyProfileTraits(
  existing: CrmProfile,
  input: unknown,
  timestamp: string,
  consentEvidence?: unknown
): ValidationResult<ProjectedProfileResult> {
  var traitsResult = sanitizeTraits(input);
  if (!traitsResult.ok || !traitsResult.value) return failure<ProjectedProfileResult>(traitsResult);
  var evidenceResult = normalizeConsentEvidence(
    consentEvidence,
    traitsResult.value.marketing_consent,
    existing.consent_evidence,
    existing.last_consent_evidence_at
  );
  if (!evidenceResult.ok || evidenceResult.value === undefined) return failure<ProjectedProfileResult>(evidenceResult);
  var orderingResult = validateTraitOrdering(existing, traitsResult.value, timestamp);
  if (!orderingResult.ok || !orderingResult.value) return failure<ProjectedProfileResult>(orderingResult);
  var traits = mergeTraits(existing.traits, traitsResult.value, existing.traits.user_created_at);
  var changed =
    existing.schema_version !== PROFILE_SCHEMA_VERSION ||
    stableStringify(existing.traits) !== stableStringify(traits) ||
    stableStringify(existing.consent_evidence) !== stableStringify(evidenceResult.value) ||
    stableStringify(existing.trait_updated_at) !== stableStringify(orderingResult.value);
  if (!changed) return { ok: true, value: { profile: existing, changed: false } };
  var profile = copyRecord(existing) as CrmProfile;
  profile.schema_version = PROFILE_SCHEMA_VERSION;
  profile.traits = traits;
  profile.consent_evidence = evidenceResult.value;
  if (evidenceResult.value && typeof evidenceResult.value.captured_at === "string") {
    profile.last_consent_evidence_at = evidenceResult.value.captured_at;
  }
  profile.trait_updated_at = orderingResult.value;
  profile.last_consent_evidence_at = profile.last_consent_evidence_at || (
    profile.consent_evidence && typeof profile.consent_evidence.captured_at === "string"
      ? profile.consent_evidence.captured_at
      : null
  );
  profile.source_updated_at = profile.source_updated_at || profile.updated_at;
  profile.last_ingest_request_id = profile.last_ingest_request_id || null;
  profile.last_ingest_fingerprint = profile.last_ingest_fingerprint || null;
  profile.last_ingest_outcome = profile.last_ingest_outcome || null;
  profile.last_ingest_source = profile.last_ingest_source || null;
  profile.last_migration_request_id = profile.last_migration_request_id || null;
  profile.last_migration_fingerprint = profile.last_migration_fingerprint || null;
  profile.last_migration_outcome = profile.last_migration_outcome || null;
  profile.updated_at = timestamp;
  flattenProfile(profile);
  return { ok: true, value: { profile: profile, changed: true } };
}

export function isKnownTrait(name: string): boolean {
  return TRAIT_NAME_SET[name] === true;
}
