import assert from "node:assert/strict";
import {
  scoreProgramPerformance,
  scoreProgramReadiness,
  scoreTemplatePerformance,
  scoreTemplateQuality,
} from "../dist/domain/scoring.js";

const completeTemplate = {
  channel: "email",
  is_active: true,
  subject: "A personal update prepared for {{first_name}}",
  body: "Hello {{first_name}}, we prepared a focused account update for you. Review the details, confirm that they match your needs, and choose the next step when you are ready.",
  cta: {
    label: "Review my update",
    url: "https://example.com/account/update",
  },
};

const completeProgram = {
  key: "premium_reactivation",
  offer_type: "lifecycle",
  audience: {
    segment_key: "inactive_premium",
  },
  safety: {
    require_marketing_consent: true,
    excluded_segments: ["crm_contact_safety", "crm_blacklist"],
  },
  template: completeTemplate,
  measurement: {
    primary_metric: "premium_reactivation",
    conversion_event: "subscription_reactivated",
    attribution_window_days: 30,
    control_group_percentage: 10,
  },
};

const perfectTemplateResult = scoreTemplateQuality(completeTemplate);
assert.equal(perfectTemplateResult.score, 100);
assert.equal(perfectTemplateResult.grade, "Excellent");
assert.equal(perfectTemplateResult.confidence, "high");
assert.deepEqual(perfectTemplateResult.blockers, []);
assert.equal(perfectTemplateResult.dimensions.length, 5);
assert.equal(perfectTemplateResult.hints.length, 0);

const perfectProgramResult = scoreProgramReadiness(completeProgram, {
  segment_exists: true,
});
assert.equal(perfectProgramResult.score, 100);
assert.equal(perfectProgramResult.grade, "Excellent");
assert.equal(perfectProgramResult.confidence, "high");
assert.deepEqual(perfectProgramResult.blockers, []);
assert.deepEqual(
  perfectProgramResult.dimensions.map((dimension) => [dimension.key, dimension.score, dimension.max_score]),
  [
    ["safety", 30, 30],
    ["audience", 25, 25],
    ["template", 25, 25],
    ["measurement", 20, 20],
  ],
);

const availableSegmentsResult = scoreProgramReadiness(completeProgram, {
  available_segment_keys: ["another_segment", "inactive_premium"],
});
assert.equal(availableSegmentsResult.score, 100, "segment existence can be proven by an available-key set");

const missingSafetyResult = scoreProgramReadiness({
  audience: { segment_key: "everyone" },
  template: completeTemplate,
  measurement: completeProgram.measurement,
}, { segment_exists: true });
assert.equal(missingSafetyResult.grade, "Blocked");
assert.ok(missingSafetyResult.score <= 49, "hard safety failures cap readiness below activation quality");
assert.deepEqual(missingSafetyResult.blockers, [
  "PROGRAM_CONSENT_GATE_MISSING",
  "PROGRAM_CONTACT_SAFETY_EXCLUSION_MISSING",
  "PROGRAM_BLACKLIST_EXCLUSION_MISSING",
]);

const missingSegmentResult = scoreProgramReadiness(completeProgram, { segment_exists: false });
assert.equal(missingSegmentResult.grade, "Blocked");
assert.ok(missingSegmentResult.blockers.includes("PROGRAM_SEGMENT_NOT_FOUND"));
assert.ok(missingSegmentResult.hints.some((hint) => hint.action.includes("Create or restore")));

const unverifiedSegmentResult = scoreProgramReadiness(completeProgram);
assert.equal(unverifiedSegmentResult.grade, "Blocked");
assert.ok(unverifiedSegmentResult.blockers.includes("PROGRAM_SEGMENT_UNVERIFIED"));
assert.equal(unverifiedSegmentResult.confidence, "medium");

const consentRuleResult = scoreProgramReadiness({
  audience: {
    segment_key: "consented_users",
    rule: { trait: "marketing_consent", operator: "eq", value: "granted" },
    excluded_segments: ["crm_contact_safety", "crm_blacklist"],
    segment_exists: true,
  },
  template: completeTemplate,
  measurement_plan: completeProgram.measurement,
});
assert.equal(consentRuleResult.score, 100, "an explicit granted-consent rule is a valid consent gate");

const unsafeOrConsentResult = scoreProgramReadiness({
  ...completeProgram,
  audience: {
    segment_key: "mixed_consent",
    rule: {
      op: "or",
      rules: [
        { trait: "marketing_consent", operator: "eq", value: "granted" },
        { trait: "billing_state", operator: "eq", value: "paying" },
      ],
    },
  },
  safety: { excluded_segments: ["crm_contact_safety", "crm_blacklist"] },
}, { segment_exists: true });
assert.ok(
  unsafeOrConsentResult.blockers.includes("PROGRAM_CONSENT_GATE_MISSING"),
  "one consented branch in an OR rule does not protect every audience member",
);

const safeOrConsentResult = scoreProgramReadiness({
  ...completeProgram,
  audience: {
    segment_key: "consented_branches",
    rule: {
      op: "or",
      rules: [
        {
          op: "and",
          rules: [
            { trait: "marketing_consent", operator: "eq", value: "granted" },
            { trait: "billing_state", operator: "eq", value: "paying" },
          ],
        },
        {
          op: "and",
          rules: [
            { trait: "marketing_consent", operator: "eq", value: "granted" },
            { trait: "billing_state", operator: "eq", value: "trial" },
          ],
        },
      ],
    },
  },
  safety: { excluded_segments: ["crm_contact_safety", "crm_blacklist"] },
}, { segment_exists: true });
assert.equal(safeOrConsentResult.score, 100, "every OR branch may prove the same consent requirement");

const missingTemplateResult = scoreProgramReadiness({
  audience: { segment_key: "inactive_premium" },
  safety: completeProgram.safety,
  measurement: completeProgram.measurement,
}, { segment_exists: true });
assert.equal(missingTemplateResult.grade, "Blocked");
assert.deepEqual(missingTemplateResult.blockers, ["PROGRAM_TEMPLATE_MISSING"]);

const emptyInlineTemplateResult = scoreProgramReadiness({
  ...completeProgram,
  template: {},
}, { segment_exists: true });
assert.equal(emptyInlineTemplateResult.grade, "Blocked");
assert.ok(emptyInlineTemplateResult.blockers.includes("PROGRAM_TEMPLATE_INCOMPLETE"));

const incompleteMeasurementResult = scoreProgramReadiness({
  ...completeProgram,
  measurement: { primary_metric: "click" },
}, { segment_exists: true });
assert.equal(incompleteMeasurementResult.grade, "Blocked");
assert.equal(incompleteMeasurementResult.dimensions.find((dimension) => dimension.key === "measurement").score, 6);
assert.deepEqual(
  incompleteMeasurementResult.hints.filter((hint) => hint.dimension === "measurement").map((hint) => hint.code),
  [
    "PROGRAM_CONVERSION_EVENT_MISSING",
    "PROGRAM_ATTRIBUTION_WINDOW_MISSING",
    "PROGRAM_COMPARISON_PLAN_MISSING",
  ],
);

const unsafeTemplateResult = scoreTemplateQuality({
  ...completeTemplate,
  body: completeTemplate.body + '<script src="https://bad.example/x.js"></script><a href="{{unsubscribe_url}}">Unsubscribe</a>',
});
assert.equal(unsafeTemplateResult.grade, "Unsafe");
assert.ok(unsafeTemplateResult.score <= 49);
assert.deepEqual(unsafeTemplateResult.blockers, [
  "TEMPLATE_ACTIVE_CONTENT",
  "TEMPLATE_MANUAL_UNSUBSCRIBE",
]);
assert.ok(unsafeTemplateResult.hints.every((hint) => typeof hint.action === "string" && hint.action.length > 0));

const unsafeUrlResult = scoreTemplateQuality({
  ...completeTemplate,
  cta: { label: "Run", url: "javascript:alert(1)" },
});
assert.equal(unsafeUrlResult.grade, "Unsafe");
assert.ok(unsafeUrlResult.blockers.includes("TEMPLATE_CTA_URL_UNSAFE"));
assert.ok(unsafeUrlResult.blockers.includes("TEMPLATE_ACTIVE_CONTENT"));

const unsafeCtaLabelResult = scoreTemplateQuality({
  ...completeTemplate,
  cta: { label: '<img/onerror="alert(1)">', url: "https://example.com/safe" },
});
assert.ok(unsafeCtaLabelResult.blockers.includes("TEMPLATE_ACTIVE_CONTENT"));

const encodedActiveContentResult = scoreTemplateQuality({
  ...completeTemplate,
  body_html: '<a href="jav&#x61;script:alert(1)">Review</a>',
});
assert.ok(encodedActiveContentResult.blockers.includes("TEMPLATE_ACTIVE_CONTENT"));

const shadowedActiveContentResult = scoreTemplateQuality({
  ...completeTemplate,
  body: completeTemplate.body,
  body_html: "<script>alert(1)</script>",
});
assert.ok(shadowedActiveContentResult.blockers.includes("TEMPLATE_ACTIVE_CONTENT"));

const unboundTemplateEvidence = scoreProgramReadiness({
  ...completeProgram,
  template: undefined,
}, { segment_exists: true, template_exists: true, template_quality_score: 100 });
assert.ok(unboundTemplateEvidence.blockers.includes("PROGRAM_TEMPLATE_MISSING"));

const unsafeReferencedTemplate = scoreProgramReadiness({
  ...completeProgram,
  template: undefined,
  template_key: "unsafe_template",
}, { segment_exists: true, template_exists: true, template_quality_score: 49 });
assert.ok(unsafeReferencedTemplate.blockers.includes("PROGRAM_TEMPLATE_NOT_READY"));

const discountWithoutPaidTvSafety = scoreProgramReadiness({
  ...completeProgram,
  offer_type: "discount",
}, { segment_exists: true });
assert.ok(discountWithoutPaidTvSafety.blockers.includes("PROGRAM_PAID_TV_EXCLUSION_MISSING"));

const htmlFallbackResult = scoreTemplateQuality({
  ...completeTemplate,
  body: "<p>Hello {{first_name}}, this HTML account update contains enough useful detail to explain the value and the recommended next step clearly.</p>",
});
assert.equal(htmlFallbackResult.dimensions.find((dimension) => dimension.key === "fallback").score, 0);
assert.ok(htmlFallbackResult.hints.some((hint) => hint.code === "TEMPLATE_TEXT_FALLBACK_MISSING"));

const emptyTemplateResult = scoreTemplateQuality(null);
assert.equal(emptyTemplateResult.score, 0, "absence of content cannot earn unverified safety points");
assert.equal(emptyTemplateResult.grade, "Critical");
assert.equal(emptyTemplateResult.confidence, "low");
assert.deepEqual(
  emptyTemplateResult.hints.map((hint) => hint.code),
  [
    "TEMPLATE_SUBJECT_MISSING",
    "TEMPLATE_BODY_MISSING",
    "TEMPLATE_CTA_LABEL_MISSING",
    "TEMPLATE_CTA_URL_MISSING",
    "TEMPLATE_PERSONALIZATION_MISSING",
  ],
);

const insufficientPerformance = scoreProgramPerformance({
  sent: 99,
  delivered: 98,
  unique_clicks: 10,
  conversions: 4,
  complaints: 0,
  unsubscribes: 0,
});
assert.equal(insufficientPerformance.score, null);
assert.equal(insufficientPerformance.grade, "Insufficient data");
assert.equal(insufficientPerformance.confidence, "insufficient");
assert.equal(insufficientPerformance.sample_size, 98);
assert.ok(insufficientPerformance.rates.delivery > 0.98, "rates remain observable while the score is withheld");
assert.ok(insufficientPerformance.dimensions.every((dimension) => dimension.score === null));

const excellentPerformance = scoreProgramPerformance({
  sent_count: 1000,
  delivered_count: 990,
  clicked: 100,
  conversion_count: 60,
  spam_complaints: 0,
  unsubscribe_count: 0,
});
assert.equal(excellentPerformance.score, 100);
assert.equal(excellentPerformance.grade, "Excellent");
assert.equal(excellentPerformance.confidence, "medium");
assert.deepEqual(excellentPerformance.blockers, []);
assert.equal(excellentPerformance.dimensions.length, 4);
assert.equal(excellentPerformance.rates.delivery, 0.99);
assert.equal(excellentPerformance.rates.safe_contact, 1);
assert.deepEqual(
  scoreTemplatePerformance({
    sent: 1000,
    delivered: 990,
    unique_clicks: 100,
    conversions: 60,
    complaints: 0,
    unsubscribes: 0,
  }),
  scoreProgramPerformance({
    sent: 1000,
    delivered: 990,
    unique_clicks: 100,
    conversions: 60,
    complaints: 0,
    unsubscribes: 0,
  }),
  "template performance uses the same aggregate scoring contract",
);

const customMinimum = scoreProgramPerformance({
  sent: 25,
  delivered: 25,
  unique_clicks: 2,
  conversions: 2,
  complaints: 0,
  unsubscribes: 0,
}, { minimum_sample_size: 25 });
assert.equal(customMinimum.score, 100);
assert.equal(customMinimum.confidence, "low");

const weakDeliveredSample = scoreProgramPerformance({
  sent: 2000,
  delivered: 1,
  unique_clicks: 1,
  conversions: 1,
  complaints: 0,
  unsubscribes: 0,
});
assert.equal(weakDeliveredSample.score, null);
assert.equal(weakDeliveredSample.confidence, "insufficient");
assert.equal(weakDeliveredSample.sample_size, 1);

const poorPerformance = scoreProgramPerformance({
  sent: 1000,
  delivered: 850,
  unique_clicks: 5,
  conversions: 0,
  complaints: 5,
  unsubscribes: 30,
});
assert.ok(poorPerformance.score < 25);
assert.equal(poorPerformance.grade, "Blocked");
assert.deepEqual(
  poorPerformance.hints.map((hint) => hint.code),
  [
    "PERFORMANCE_DELIVERY_LOW",
    "PERFORMANCE_CLICK_LOW",
    "PERFORMANCE_CONVERSION_LOW",
    "PERFORMANCE_COMPLAINT_HIGH",
    "PERFORMANCE_UNSUBSCRIBE_HIGH",
    "PERFORMANCE_COMPLAINT_GUARDRAIL",
    "PERFORMANCE_UNSUBSCRIBE_GUARDRAIL",
  ],
);

const missingCountsResult = scoreProgramPerformance({ sent: 100 });
assert.equal(missingCountsResult.score, null);
assert.equal(missingCountsResult.grade, "Invalid data");
assert.deepEqual(missingCountsResult.blockers, ["PERFORMANCE_COUNTS_INVALID"]);

const inconsistentCountsResult = scoreProgramPerformance({
  sent: 100,
  delivered: 101,
  unique_clicks: 0,
  conversions: 0,
  complaints: 0,
  unsubscribes: 0,
});
assert.equal(inconsistentCountsResult.score, null);
assert.equal(inconsistentCountsResult.grade, "Invalid data");
assert.deepEqual(inconsistentCountsResult.blockers, ["PERFORMANCE_COUNTS_INCONSISTENT"]);

const deterministicFirst = scoreProgramReadiness(completeProgram, { segment_exists: true });
const deterministicSecond = scoreProgramReadiness(completeProgram, { segment_exists: true });
assert.deepEqual(deterministicFirst, deterministicSecond, "scoring must not depend on time, randomness, or input mutation");
assert.equal(completeProgram.safety.excluded_segments[0], "crm_contact_safety", "input definitions are not mutated");

console.log("CRM Studio scoring tests passed");
