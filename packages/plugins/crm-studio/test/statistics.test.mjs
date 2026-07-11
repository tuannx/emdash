import assert from "node:assert/strict";
import sandbox from "../dist/sandbox.mjs";
import { createCtx, routeContext } from "./helpers.mjs";

const ctx = createCtx();

function scoreRun(id, createdAt, sent, delivered) {
  return {
    id,
    schema_version: 1,
    formula_version: "crm-growth-score-v2-file-config",
    file_config_version: "2026-07-11.2",
    file_config_fingerprint: "a".repeat(64),
    program_key: "dedupe_program",
    period_key: "2026-07-dedupe",
    status: "scored",
    overall_score: 90,
    readiness_score: 100,
    performance_score: 84,
    template_quality_score: 100,
    readiness_result: {
      dimensions: [{ key: "measurement", label: "Measurement plan", score: 20, max_score: 20, status: "pass" }],
    },
    performance_result: {
      dimensions: [{ key: "delivery", label: "Delivery rate", score: 30, max_score: 30, status: "pass" }],
    },
    template_quality_result: {
      dimensions: [{ key: "safety", label: "Template safety", score: 25, max_score: 25, status: "pass" }],
    },
    aggregate_metrics: {
      sent,
      delivered,
      unique_clicks: Math.floor(delivered / 10),
      conversions: Math.floor(delivered / 20),
      complaints: 0,
      unsubscribes: 0,
    },
    input_fact_id: null,
    input_fact_ids: [],
    input_facts_fingerprint: id,
    program_revision_id: "program-revision",
    template_revision_id: "template-revision",
    audience_segment_fingerprint: "audience",
    audience_evidence: {},
    safety_evidence_fingerprint: "safety",
    safety_evidence: {},
    request_id: id,
    request_payload_fingerprint: id,
    source: "test_suite",
    created_at: createdAt,
  };
}

await ctx.storage.scoreRuns.put("older", scoreRun("older", "2026-07-11T00:00:00.000Z", 100, 90));
await ctx.storage.scoreRuns.put("latest", scoreRun("latest", "2026-07-11T01:00:00.000Z", 200, 190));

const response = await sandbox.routes["v1/statistics/summary"].handler(routeContext("GET", {}), ctx);
assert.equal(response.ok, true);
const stats = response.data.statistics;
assert.equal(stats.window.immutable_runs_loaded, 2);
assert.equal(stats.window.current_program_period_snapshots, 1);
assert.equal(stats.measurement.aggregate_counts.sent, 200, "older immutable run must not double-count the current period");
assert.equal(stats.measurement.aggregate_counts.delivered, 190);
assert.equal(stats.measurement.score_run_status.scored, 1);
assert.equal(stats.components.find((row) => row.scope === "performance" && row.component === "delivery").runs, 1);

console.log("CRM Studio operational statistics tests passed");
