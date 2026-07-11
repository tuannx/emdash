import assert from "node:assert/strict";
import {
  CRM_STUDIO_FILE_CONFIG,
  buildFileDefaultSegments,
  validateFileConfig,
} from "../dist/config/file-config.js";
import { fileConfigFingerprint } from "../dist/application/manage-file-config.js";

assert.deepEqual(validateFileConfig(), []);
assert.equal(CRM_STUDIO_FILE_CONFIG.formula_version, "crm-growth-score-v2-file-config");
assert.equal(CRM_STUDIO_FILE_CONFIG.overall.readiness_weight + CRM_STUDIO_FILE_CONFIG.overall.performance_weight, 1);

const readiness = CRM_STUDIO_FILE_CONFIG.readiness;
assert.equal(readiness.safety_max + readiness.audience_max + readiness.template_max + readiness.measurement_max, 100);
const performance = CRM_STUDIO_FILE_CONFIG.performance;
assert.equal(
  performance.delivery.max_score +
    performance.click.max_score +
    performance.conversion.max_score +
    performance.complaint.max_score +
    performance.unsubscribe.max_score,
  100,
);

const defaults = buildFileDefaultSegments("2026-07-11T00:00:00.000Z");
assert.deepEqual(defaults.map((segment) => segment.key), [
  "emdash_users",
  "crm_blacklist",
  "paid_tv_users",
  "paying_customers",
]);
assert.equal(defaults.find((segment) => segment.key === "paid_tv_users").rule.trait, "paid_tv_access");
assert.equal(defaults.find((segment) => segment.key === "crm_blacklist").active_generation, "static");

const firstFingerprint = await fileConfigFingerprint();
const secondFingerprint = await fileConfigFingerprint();
assert.match(firstFingerprint, /^[a-f0-9]{64}$/);
assert.equal(firstFingerprint, secondFingerprint, "file config fingerprint must be deterministic");

const invalid = JSON.parse(JSON.stringify(CRM_STUDIO_FILE_CONFIG));
invalid.overall.performance_weight = 0.7;
assert.ok(validateFileConfig(invalid).includes("OVERALL_WEIGHTS_MUST_SUM_1"));
invalid.default_segments.push(JSON.parse(JSON.stringify(invalid.default_segments[0])));
assert.ok(validateFileConfig(invalid).includes("DEFAULT_SEGMENT_KEYS_INVALID"));

console.log("CRM Studio file config tests passed");
