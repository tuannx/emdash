import assert from "node:assert/strict";
import { validateBlocks } from "@emdash-cms/blocks/server";
import sandbox from "../dist/sandbox.mjs";
import { createCtx, mutationInput, routeContext } from "./helpers.mjs";

const ctx = createCtx();

async function invoke(route, input) {
  return await sandbox.routes[route].handler(routeContext("POST", input), ctx);
}

await invoke("v1/bootstrap", mutationInput("growth-bootstrap-0001"));
await invoke("v1/profiles/upsert-batch", mutationInput("growth-profile-0001", {
  profiles: [{ external_id: "growth-audience-member", traits: {} }],
}));
await invoke("v1/segments/members/add", mutationInput("growth-audience-0001", {
  segment_key: "emdash_users",
  profile_ids: ["external:test_suite:growth-audience-member"],
}));

const privateBodyMarker = "PRIVATE_TEMPLATE_BODY_MARKER";
const templateBody = mutationInput("growth-template-0001", {
  template: {
    key: "premium_reactivation_email",
    name: "Premium reactivation email",
    channel: "email",
    subject: "A personal update prepared for {{first_name}}",
    body_html: "<p>Hello {{first_name}}, " + privateBodyMarker + " explains the account value, the safe next step, and what to expect after reviewing this focused update.</p>",
    body_text: "Hello {{first_name}}, review your focused account update and choose the next step when you are ready.",
    cta_label: "Review my update",
    cta_url: "https://example.com/account/update",
    is_active: true,
  },
});
const templateCreated = await invoke("v1/templates/upsert", templateBody);
assert.equal(templateCreated.ok, true);
assert.equal(templateCreated.data.outcome, "created");
assert.equal(templateCreated.data.template.quality_score, 100);
assert.equal(templateCreated.data.template.delivery_enabled, false);
assert.equal(await ctx.storage.configRevisions.count(), 1);
assert.deepEqual(await invoke("v1/templates/upsert", templateBody), templateCreated);

const changedTemplateRequest = await invoke("v1/templates/upsert", {
  ...templateBody,
  template: { ...templateBody.template, subject: "Changed subject" },
});
assert.equal(changedTemplateRequest.ok, false);
assert.equal(changedTemplateRequest.error.code, "REQUEST_ID_CONFLICT");

const unsafeActiveTemplate = await invoke("v1/templates/upsert", mutationInput("growth-template-unsafe-0001", {
  template: {
    key: "unsafe_template",
    name: "Unsafe template",
    channel: "email",
    subject: "Unsafe active content for {{first_name}}",
    body_html: '<p>Useful body text for the recipient.</p><a href="jav&#x61;script:alert(1)">Run</a>',
    body_text: "Useful fallback body text for the recipient.",
    cta_label: "Review",
    cta_url: "https://example.com/safe",
    is_active: true,
  },
}));
assert.equal(unsafeActiveTemplate.ok, false);
assert.equal(unsafeActiveTemplate.error.code, "TEMPLATE_NOT_READY");
assert.equal(await ctx.storage.messageTemplates.get("message-template:unsafe_template"), null);

const unknownTemplateField = await invoke("v1/templates/upsert", mutationInput("growth-template-pii-0001", {
  email: "person@example.com",
  template: templateBody.template,
}));
assert.equal(unknownTemplateField.ok, false);
assert.equal(unknownTemplateField.error.code, "UNKNOWN_OPERATION_FIELD");

const programBody = mutationInput("growth-program-0001", {
  program: {
    key: "premium_reactivation",
    name: "Premium reactivation",
    description: "Configuration-only lifecycle measurement program.",
    offer_type: "lifecycle",
    audience_segment_key: "emdash_users",
    template_key: "premium_reactivation_email",
    safety: {
      require_marketing_consent: true,
      exclude_crm_contact_safety: true,
      exclude_crm_blacklist: true,
      exclude_paid_tv_users: false,
    },
    measurement: {
      primary_metric: "premium_reactivation",
      conversion_event: "subscription_reactivated",
      attribution_window_days: 30,
      control_group_percentage: 10,
      minimum_sample_size: 100,
    },
    is_active: true,
  },
});
const programCreated = await invoke("v1/programs/upsert", programBody);
assert.equal(programCreated.ok, true);
assert.equal(programCreated.data.program.readiness_score, 100);
assert.equal(programCreated.data.program.delivery_enabled, false);
assert.equal(await ctx.storage.configRevisions.count(), 2);

const unmaterializedProgram = await invoke("v1/programs/upsert", mutationInput("growth-program-unmaterialized-0001", {
  program: {
    ...programBody.program,
    key: "unmaterialized_program",
    audience_segment_key: "paying_customers",
  },
}));
assert.equal(unmaterializedProgram.ok, false);
assert.equal(unmaterializedProgram.error.code, "SEGMENT_NOT_MATERIALIZED");

const unsafeDiscountProgram = await invoke("v1/programs/upsert", mutationInput("growth-program-discount-0001", {
  program: {
    ...programBody.program,
    key: "discount_without_paid_safety",
    offer_type: "discount",
    safety: { ...programBody.program.safety, exclude_paid_tv_users: false },
  },
}));
assert.equal(unsafeDiscountProgram.ok, false);
assert.equal(unsafeDiscountProgram.error.code, "SAFETY_SEGMENT_NOT_MATERIALIZED");
assert.equal(await ctx.storage.programs.get("program:discount_without_paid_safety"), null);

const baseFact = {
  source_fact_id: "11111111111111111111111111111111",
  period_key: "2026-07-week-2",
  sequence: 1,
  sent: 1000,
  delivered: 980,
  unique_clicks: 90,
  conversions: 50,
  complaints: 0,
  unsubscribes: 0,
};
const metricCreated = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-0001", {
  program_key: "premium_reactivation",
  facts: [baseFact],
}));
assert.equal(metricCreated.ok, true);
assert.equal(metricCreated.data.accepted, 1);
assert.equal(await ctx.storage.metricFacts.count(), 1);

const metricCrossRequestReplay = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-0002", {
  program_key: "premium_reactivation",
  facts: [baseFact],
}));
assert.equal(metricCrossRequestReplay.ok, true);
assert.equal(metricCrossRequestReplay.data.accepted, 0);
assert.equal(metricCrossRequestReplay.data.unchanged, 1);

const metricConflict = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-0003", {
  program_key: "premium_reactivation",
  facts: [{ ...baseFact, conversions: 51 }],
}));
assert.equal(metricConflict.ok, false);
assert.equal(metricConflict.error.code, "FACT_ID_CONFLICT");

const correctedFact = { ...baseFact, sequence: 2, delivered: 990, unique_clicks: 100, conversions: 60 };
const metricCorrection = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-0004", {
  program_key: "premium_reactivation",
  facts: [correctedFact],
}));
assert.equal(metricCorrection.ok, true);
assert.equal(metricCorrection.data.accepted, 1);
assert.equal(await ctx.storage.metricFacts.count(), 2, "corrections append instead of overwriting history");

const scoreResult = await invoke("v1/programs/evaluate", mutationInput("growth-score-0001", {
  program_key: "premium_reactivation",
  period_key: "2026-07-week-2",
}));
assert.equal(scoreResult.ok, true);
assert.equal(scoreResult.data.score_run.status, "scored");
assert.equal(scoreResult.data.score_run.overall_score, 100);
assert.equal(scoreResult.data.score_run.input_fact_ids.length, 1);
assert.ok(scoreResult.data.score_run.input_fact_ids[0].includes("|2|"));
assert.equal(await ctx.storage.scoreRuns.count(), 1);

const lockedTemplateUpdate = await invoke("v1/templates/upsert", mutationInput("growth-template-locked-0001", {
  template: { ...templateBody.template, subject: "A locked update for {{first_name}}" },
}));
assert.equal(lockedTemplateUpdate.ok, false);
assert.equal(lockedTemplateUpdate.error.code, "TEMPLATE_IN_USE");
const lockedSegmentUpdate = await invoke("v1/segments/upsert", mutationInput("growth-segment-locked-0001", {
  segment: {
    key: "emdash_users",
    name: "All EmDash users",
    description: "Changed while a program is active",
    kind: "static",
    is_active: true,
  },
}));
assert.equal(lockedSegmentUpdate.ok, false);
assert.equal(lockedSegmentUpdate.error.code, "SEGMENT_IN_USE");
const lastAudienceMemberRemoval = await invoke("v1/segments/members/remove", mutationInput("growth-audience-remove-0001", {
  segment_key: "emdash_users",
  profile_ids: ["external:test_suite:growth-audience-member"],
}));
assert.equal(lastAudienceMemberRemoval.ok, false);
assert.equal(lastAudienceMemberRemoval.error.code, "SEGMENT_REQUIRED_BY_ACTIVE_PROGRAM");

await invoke("v1/profiles/upsert-batch", mutationInput("growth-partial-remove-profiles-0001", {
  profiles: [
    { external_id: "growth-audience-member-2", traits: {} },
    { external_id: "growth-audience-member-3", traits: {} },
  ],
}));
await invoke("v1/segments/members/add", mutationInput("growth-partial-remove-add-0001", {
  segment_key: "emdash_users",
  profile_ids: [
    "external:test_suite:growth-audience-member-2",
    "external:test_suite:growth-audience-member-3",
  ],
}));
assert.equal(
  await ctx.storage.segmentMembershipStates.count({ segment_key: "emdash_users", status: "open" }),
  3,
);
const originalMembershipStatePutMany = ctx.storage.segmentMembershipStates.putMany.bind(ctx.storage.segmentMembershipStates);
let failMembershipRemovalOnce = true;
ctx.storage.segmentMembershipStates.putMany = async function(writes) {
  if (failMembershipRemovalOnce && writes.length === 2) {
    failMembershipRemovalOnce = false;
    await originalMembershipStatePutMany([writes[0]]);
    throw new Error("simulated partial static membership removal");
  }
  return await originalMembershipStatePutMany(writes);
};
const partialRemovalOccurredAt = new Date(Date.now() + 1000).toISOString();
const partialRemovalBody = mutationInput("growth-partial-remove-0001", {
  occurred_at: partialRemovalOccurredAt,
  segment_key: "emdash_users",
  profile_ids: [
    "external:test_suite:growth-audience-member-2",
    "external:test_suite:growth-audience-member-3",
  ],
});
const partialRemovalFirst = await invoke("v1/segments/members/remove", partialRemovalBody);
assert.equal(partialRemovalFirst.ok, false);
assert.equal(partialRemovalFirst.error.code, "PARTIAL_WRITE");
const partialRemovalRetry = await invoke("v1/segments/members/remove", partialRemovalBody);
assert.equal(partialRemovalRetry.ok, true);
assert.equal(partialRemovalRetry.data.result.removed, 2);
assert.equal(
  await ctx.storage.segmentMembershipStates.count({ segment_key: "emdash_users", status: "open" }),
  1,
  "exact retry must only subtract still-open removals from the active-audience invariant",
);
ctx.storage.segmentMembershipStates.putMany = originalMembershipStatePutMany;

const programDeactivated = await invoke("v1/programs/upsert", mutationInput("growth-program-deactivate-0001", {
  program: { ...programBody.program, is_active: false },
}));
assert.equal(programDeactivated.ok, true);
const templateUpdated = await invoke("v1/templates/upsert", mutationInput("growth-template-update-0001", {
  template: { ...templateBody.template, subject: "A revised personal update for {{first_name}}" },
}));
assert.equal(templateUpdated.ok, true);
const programReactivated = await invoke("v1/programs/upsert", mutationInput("growth-program-reactivate-0001", {
  program: programBody.program,
}));
assert.equal(programReactivated.ok, true);
const historicalReattribution = await invoke("v1/programs/evaluate", mutationInput("growth-score-revision-0001", {
  program_key: "premium_reactivation",
  period_key: "2026-07-week-2",
}));
assert.equal(historicalReattribution.ok, false);
assert.equal(historicalReattribution.error.code, "METRIC_CONFIG_REVISION_MISMATCH");
const correctionAcrossConfig = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-revision-0001", {
  program_key: "premium_reactivation",
  facts: [{ ...correctedFact, sequence: 3, conversions: 61 }],
}));
assert.equal(correctionAcrossConfig.ok, false);
assert.equal(correctionAcrossConfig.error.code, "FACT_CONFIG_IMMUTABLE");

const originalMetricPutMany = ctx.storage.metricFacts.putMany.bind(ctx.storage.metricFacts);
let failMetricBatchOnce = true;
ctx.storage.metricFacts.putMany = async function(writes) {
  if (failMetricBatchOnce && writes.length === 2) {
    failMetricBatchOnce = false;
    await originalMetricPutMany([writes[0]]);
    throw new Error("simulated partial metric batch write");
  }
  return await originalMetricPutMany(writes);
};
const partialMetricBody = mutationInput("growth-metric-partial-0001", {
  program_key: "premium_reactivation",
  facts: [
    { ...baseFact, source_fact_id: "66666666666666666666666666666666", period_key: "2026-07-partial" },
    { ...baseFact, source_fact_id: "77777777777777777777777777777777", period_key: "2026-07-partial" },
  ],
});
const partialMetricFirst = await invoke("v1/metrics/ingest-batch", partialMetricBody);
assert.equal(partialMetricFirst.ok, false);
assert.equal(partialMetricFirst.error.code, "PARTIAL_WRITE");
const partialMetricRetry = await invoke("v1/metrics/ingest-batch", partialMetricBody);
assert.equal(partialMetricRetry.ok, true);
assert.equal(partialMetricRetry.data.accepted, 2, "retry must preserve each original accepted outcome");
assert.equal(partialMetricRetry.data.unchanged, 0);

const insufficientFact = {
  ...baseFact,
  source_fact_id: "22222222222222222222222222222222",
  period_key: "2026-07-small",
  sent: 20,
  delivered: 20,
  unique_clicks: 2,
  conversions: 1,
};
await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-small-0001", {
  program_key: "premium_reactivation",
  facts: [insufficientFact],
}));
const insufficientScore = await invoke("v1/programs/evaluate", mutationInput("growth-score-small-0001", {
  program_key: "premium_reactivation",
  period_key: "2026-07-small",
}));
assert.equal(insufficientScore.data.score_run.status, "insufficient_data");
assert.equal(insufficientScore.data.score_run.overall_score, null);

const guardrailFact = {
  ...baseFact,
  source_fact_id: "33333333333333333333333333333333",
  period_key: "2026-07-guardrail",
  delivered: 1000,
  complaints: 5,
};
await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-guardrail-0001", {
  program_key: "premium_reactivation",
  facts: [guardrailFact],
}));
const guardrailScore = await invoke("v1/programs/evaluate", mutationInput("growth-score-guardrail-0001", {
  program_key: "premium_reactivation",
  period_key: "2026-07-guardrail",
}));
assert.equal(guardrailScore.data.score_run.status, "blocked");
assert.equal(guardrailScore.data.score_run.overall_score, null);

const piiMetric = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-pii-0001", {
  program_key: "premium_reactivation",
  facts: [{ ...baseFact, source_fact_id: "44444444444444444444444444444444", email: "person@example.com" }],
}));
assert.equal(piiMetric.ok, false);
assert.equal(piiMetric.error.code, "UNKNOWN_METRIC_FIELD");
const piiMetricTopLevel = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-pii-0002", {
  program_key: "premium_reactivation",
  profile_id: "emdash:SECRET",
  facts: [{ ...baseFact, source_fact_id: "55555555555555555555555555555555" }],
}));
assert.equal(piiMetricTopLevel.ok, false);
assert.equal(piiMetricTopLevel.error.code, "UNKNOWN_OPERATION_FIELD");

const ambiguousPeriod = "2026-07-ambiguous";
const ambiguousBase = {
  schema_version: 1,
  program_key: "premium_reactivation",
  period_key: ambiguousPeriod,
  source: "warehouse",
  source_fact_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  fact_stream_key: "premium_reactivation|warehouse|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sequence: 1,
  sent: 1000,
  delivered: 990,
  unique_clicks: 100,
  conversions: 60,
  complaints: 0,
  unsubscribes: 0,
  correction_of_fact_id: null,
  request_id: "ambiguous-direct-write",
  occurred_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};
await ctx.storage.metricFacts.put("ambiguous-fact-a", {
  ...ambiguousBase,
  id: "ambiguous-fact-a",
  semantic_fingerprint: "fingerprint-a",
});
await ctx.storage.metricFacts.put("ambiguous-fact-b", {
  ...ambiguousBase,
  id: "ambiguous-fact-b",
  semantic_fingerprint: "fingerprint-b",
});
const ambiguousScore = await invoke("v1/programs/evaluate", mutationInput("growth-score-ambiguous-0001", {
  program_key: "premium_reactivation",
  period_key: ambiguousPeriod,
}));
assert.equal(ambiguousScore.ok, false);
assert.equal(ambiguousScore.error.code, "AMBIGUOUS_METRIC_REVISION");

const budgetFacts = [];
for (let index = 0; index < 16; index++) {
  budgetFacts.push({
    ...baseFact,
    source_fact_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbb" + String(index).padStart(4, "0"),
    period_key: "2026-07-budget",
  });
}
ctx._resetStatementCount();
const budgetResult = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-budget-0001", {
  program_key: "premium_reactivation",
  facts: budgetFacts,
}));
assert.equal(budgetResult.ok, true);
assert.ok(ctx._statementCount() <= 50, "max metric batch must stay within 50 storage statements");

const overLimitFacts = budgetFacts.concat([{ ...baseFact, source_fact_id: "cccccccccccccccccccccccccccccccc" }]);
const overLimitResult = await invoke("v1/metrics/ingest-batch", mutationInput("growth-metric-limit-0001", {
  program_key: "premium_reactivation",
  facts: overLimitFacts,
}));
assert.equal(overLimitResult.ok, false);
assert.equal(overLimitResult.error.code, "INVALID_FACT_BATCH_SIZE");

const piiRequestId = await invoke("v1/metrics/ingest-batch", {
  ...mutationInput("growth-metric-pii-request"),
  request_id: "person@example.com",
  program_key: "premium_reactivation",
  facts: [{ ...baseFact, source_fact_id: "dddddddddddddddddddddddddddddddd" }],
});
assert.equal(piiRequestId.ok, false);
assert.equal(piiRequestId.error.code, "INVALID_REQUEST_ID");

for (const page of ["/programs", "/templates", "/measurement"]) {
  const adminResult = await sandbox.routes.admin.handler(
    routeContext("POST", { type: "page_load", page }),
    ctx,
  );
  const validation = validateBlocks(adminResult.blocks);
  assert.equal(validation.valid, true, page + " Block Kit invalid: " + JSON.stringify(validation.errors));
  assert.equal(JSON.stringify(adminResult.blocks).includes(privateBodyMarker), false, "template body must not render into admin blocks");
}

console.log("CRM Studio growth routes and scoring E2E tests passed");
