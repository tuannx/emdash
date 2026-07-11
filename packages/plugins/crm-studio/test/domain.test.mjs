import assert from "node:assert/strict";
import {
  applyProfileTraits,
  isStrictIsoTimestamp,
  projectEmDashUser,
  sanitizeTraits,
} from "../dist/domain/profile.js";
import { buildSegment, profileMatchesRule, validateRule } from "../dist/domain/rule.js";
import { selectBoundedProfiles } from "../dist/domain/membership.js";

const timestamp = "2026-07-10T12:00:00.000Z";
const user = {
  id: "01USERA",
  email: "Owner@Example.com",
  name: "Owner",
  role: 50,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const first = projectEmDashUser(user, null, {}, timestamp);
assert.equal(first.profile.id, "emdash:01USERA");
assert.equal(first.profile.email, "owner@example.com");
assert.equal(first.profile.marketing_consent, "unknown");
assert.equal(first.profile.email_health, "unknown");
assert.equal(first.profile.reachability, "unknown");
assert.equal(first.profile.traits.eligible_for_messaging, false);

const firstEvidenceAt = new Date(Date.now() - 60_000).toISOString();
const enriched = applyProfileTraits(first.profile, {
  billing_state: "paying",
  marketing_consent: "granted",
  email_health: "healthy",
  reachability: "email",
  paid_tv_access: true,
}, timestamp, {
  source: "test_suite",
  captured_at: firstEvidenceAt,
  policy_version: "test-v1",
  channel: "email",
});
assert.equal(enriched.ok, true);
assert.equal(enriched.value.profile.traits.eligible_for_messaging, true);
assert.equal(enriched.value.profile.consent_evidence.policy_version, "test-v1");

const denied = applyProfileTraits(
  enriched.value.profile,
  { marketing_consent: "denied" },
  "2026-07-10T14:00:00.000Z",
);
assert.equal(denied.ok, true);
assert.equal(denied.value.profile.consent_evidence, null, "denial clears active grant evidence");
assert.equal(denied.value.profile.last_consent_evidence_at, firstEvidenceAt, "evidence watermark must survive denial");
const unsafeRegrant = applyProfileTraits(
  denied.value.profile,
  { marketing_consent: "granted" },
  "2026-07-10T15:00:00.000Z",
);
assert.equal(unsafeRegrant.ok, false);
assert.equal(unsafeRegrant.code, "CONSENT_EVIDENCE_REQUIRED");
const staleEvidenceRegrant = applyProfileTraits(
  denied.value.profile,
  { marketing_consent: "granted" },
  "2026-07-10T15:00:00.000Z",
  {
    source: "test_suite",
    captured_at: new Date(Date.parse(firstEvidenceAt) - 1_000).toISOString(),
    policy_version: "test-v2",
    channel: "email",
  },
);
assert.equal(staleEvidenceRegrant.ok, false);
assert.equal(staleEvidenceRegrant.code, "STALE_CONSENT_EVIDENCE");
const reusedEvidenceRegrant = applyProfileTraits(
  denied.value.profile,
  { marketing_consent: "granted" },
  "2026-07-10T15:00:00.000Z",
  {
    source: "test_suite",
    captured_at: firstEvidenceAt,
    policy_version: "test-v2",
    channel: "email",
  },
);
assert.equal(reusedEvidenceRegrant.ok, false);
assert.equal(reusedEvidenceRegrant.code, "STALE_CONSENT_EVIDENCE", "regrant cannot reuse the cleared evidence timestamp");

const reaffirmedDenial = applyProfileTraits(
  denied.value.profile,
  { marketing_consent: "denied" },
  "2026-07-10T15:00:00.000Z",
);
assert.equal(reaffirmedDenial.ok, true);
assert.equal(reaffirmedDenial.value.changed, true, "newer same-value event must advance ordering watermark");
const delayedGrant = applyProfileTraits(
  reaffirmedDenial.value.profile,
  { marketing_consent: "granted" },
  "2026-07-10T14:30:00.000Z",
  {
    source: "test_suite",
    captured_at: new Date().toISOString(),
    policy_version: "test-v3",
    channel: "email",
  },
);
assert.equal(delayedGrant.ok, false);
assert.equal(delayedGrant.code, "STALE_TRAIT_UPDATE");

const renamedUser = { ...user, name: "Renamed Owner" };
const resynced = projectEmDashUser(renamedUser, enriched.value.profile, {}, "2026-07-10T13:00:00.000Z");
assert.equal(resynced.profile.name, "Renamed Owner");
assert.equal(resynced.profile.billing_state, "paying", "EmDash sync must preserve CRM-owned traits");
assert.equal(resynced.profile.marketing_consent, "granted");

assert.equal(sanitizeTraits({ raw_sql: "1=1" }).ok, false, "unknown traits must be rejected");
assert.equal(validateRule({ trait: "raw_sql", operator: "eq", value: "x" }).ok, false);

const unknownSafetyProfile = projectEmDashUser({ ...user, id: "01UNKNOWN" }, null, {}, timestamp).profile;
const notPaidRule = {
  op: "not",
  rules: [{ trait: "paid_tv_access", operator: "eq", value: true }],
};
assert.equal(
  profileMatchesRule(unknownSafetyProfile, notPaidRule),
  false,
  "three-valued logic must not turn unknown paid status into an eligible match",
);
assert.equal(
  profileMatchesRule(unknownSafetyProfile, { trait: "marketing_consent", operator: "not_eq", value: "denied" }),
  false,
  "literal unknown must not pass a negative consent rule",
);
assert.equal(
  profileMatchesRule(unknownSafetyProfile, {
    op: "not",
    rules: [{ trait: "marketing_consent", operator: "eq", value: "granted" }],
  }),
  false,
  "negating an unknown consent check must remain unknown",
);
assert.equal(
  profileMatchesRule(unknownSafetyProfile, { trait: "marketing_consent", operator: "eq", value: "unknown" }),
  true,
  "explicit unknown diagnostics remain possible",
);
assert.equal(
  profileMatchesRule(enriched.value.profile, { trait: "billing_state", operator: "eq", value: "paying" }),
  true,
);
assert.equal(
  profileMatchesRule(enriched.value.profile, { trait: "lifecycle_stage", operator: "eq", value: "inactive premium user" }),
  false,
  "multi-word values are compared as a phrase, not split into words",
);

let tooDeep = { trait: "billing_state", operator: "eq", value: "paying" };
for (let index = 0; index < 9; index++) tooDeep = { op: "not", rules: [tooDeep] };
assert.equal(validateRule(tooDeep).ok, false);

assert.equal(isStrictIsoTimestamp("0"), false);
assert.equal(isStrictIsoTimestamp("2026-02-30T00:00:00Z"), false);
assert.equal(isStrictIsoTimestamp("2026-01-01T24:00:00Z"), false);
assert.equal(isStrictIsoTimestamp("2026-07-10T12:00:00Z"), true);

const profileB = projectEmDashUser({ ...user, id: "B" }, null, {}, timestamp).profile;
const profileA = projectEmDashUser({ ...user, id: "A" }, null, {}, timestamp).profile;
assert.deepEqual(
  selectBoundedProfiles([profileB, profileA], 1).map((profile) => profile.id),
  ["emdash:A"],
  "bounded selection must use a deterministic EmDash user ID order",
);

const existingSegment = {
  id: "segment:test_dynamic",
  schema_version: 1,
  key: "test_dynamic",
  name: "Test dynamic",
  description: "",
  kind: "dynamic",
  evaluation_mode: "scheduled",
  rule: { trait: "billing_state", operator: "eq", value: "paying" },
  membership_limit: 200,
  group_key: null,
  is_active: true,
  active_generation: "gen:old",
  created_at: timestamp,
  updated_at: timestamp,
  last_recomputed_at: timestamp,
};
const editedSegment = buildSegment({
  key: "test_dynamic",
  name: "Test dynamic",
  kind: "dynamic",
  membership_limit: 100,
  rule: { trait: "billing_state", operator: "eq", value: "paying" },
}, existingSegment, "2026-07-10T13:00:00.000Z");
assert.equal(editedSegment.ok, true);
assert.equal(editedSegment.value.active_generation, null, "definition edit invalidates the old generation");
assert.equal(editedSegment.value.last_recomputed_at, null);

console.log("CRM Studio domain tests passed");
