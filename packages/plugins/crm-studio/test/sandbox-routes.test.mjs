import assert from "node:assert/strict";
import { validateBlocks } from "@emdash-cms/blocks/server";
import sandbox from "../dist/sandbox.mjs";
import { crmStudioPlugin } from "../dist/index.js";
import { createCtx, mutationInput, routeContext } from "./helpers.mjs";

const expectedRoutes = [
  "admin",
  "v1/bootstrap",
  "v1/config/file/load",
  "v1/config/file/status",
  "v1/deliveries/send",
  "v1/metrics/ingest-batch",
  "v1/metrics/materialize-tracking",
  "v1/profiles/upsert-batch",
  "v1/programs/evaluate",
  "v1/programs/upsert",
  "v1/providers/cloudflare/report-sync",
  "v1/segments/upsert",
  "v1/segments/list",
  "v1/segments/members/add",
  "v1/segments/members/remove",
  "v1/segments/recompute-step",
  "v1/segments/preview",
  "v1/statistics/summary",
  "v1/migrations/emdash-users/step",
  "v1/migrations/emdash-users/status",
  "v1/templates/upsert",
  "v1/tracking/click",
  "v1/tracking/open",
  "v1/tracking/unsubscribe",
];
const publicRoutes = new Set(["v1/tracking/click", "v1/tracking/open", "v1/tracking/unsubscribe"]);
for (const route of expectedRoutes) {
  assert.equal(typeof sandbox.routes[route]?.handler, "function", route + " handler must exist");
  assert.equal(sandbox.routes[route]?.public === true, publicRoutes.has(route), route + " visibility must match contract");
}
assert.deepEqual(Object.keys(sandbox.routes).sort(), expectedRoutes.slice().sort(), "sandbox route surface must be exact");

const descriptor = crmStudioPlugin();
assert.equal(descriptor.id, "crm-studio");
assert.equal(descriptor.format, "standard");
assert.equal(descriptor.entrypoint, "@aikit/crm-studio/sandbox");
assert.deepEqual(descriptor.capabilities, ["users:read", "network:fetch"]);
assert.equal(descriptor.capabilities.includes("email:send"), false, "V1 delivery must remain disabled by capability");
assert.deepEqual(descriptor.allowedHosts, ["api.cloudflare.com"]);
assert.ok(descriptor.storage.profiles);
assert.ok(descriptor.storage.segmentMembershipStates);
assert.ok(descriptor.storage.ingestRequests);
assert.ok(descriptor.storage.programs);
assert.ok(descriptor.storage.messageTemplates);
assert.ok(descriptor.storage.configRevisions);
assert.ok(descriptor.storage.metricFacts);
assert.ok(descriptor.storage.scoreRuns);
assert.ok(descriptor.storage.emailDeliveries);
assert.ok(descriptor.storage.trackingLinks);
assert.ok(descriptor.storage.trackingEvents);
assert.ok(descriptor.adminPages.some((page) => page.path === "/statistics"));
assert.ok(descriptor.adminPages.some((page) => page.path === "/configuration"));
assert.ok(descriptor.adminPages.some((page) => page.path === "/tracking"));

const users = [];
for (let index = 0; index < 105; index++) {
  users.push({
    id: "USER" + String(index).padStart(3, "0"),
    email: "user" + index + "@example.com",
    name: "User " + index,
    role: index === 0 ? 50 : 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
const ctx = createCtx(users);

async function invoke(route, method, input, suffix = "") {
  return await sandbox.routes[route].handler(routeContext(method, input, suffix), ctx);
}

const dryRunCtx = createCtx();
const dryRunBootstrap = await sandbox.routes["v1/bootstrap"].handler(
  routeContext("POST", mutationInput("bootstrap-dry-0001", { dry_run: true })),
  dryRunCtx,
);
assert.equal(dryRunBootstrap.ok, true);
assert.equal(dryRunBootstrap.data.concurrency_mode, "single_sequenced_writer_required");
assert.equal(await dryRunCtx.storage.segments.count(), 0, "bootstrap dry-run must not write segments");
assert.equal(await dryRunCtx.storage.ingestRequests.count(), 0, "dry-run must not write a receipt");
assert.equal(await dryRunCtx.kv.get("settings:deliveryMode"), null, "bootstrap dry-run must not write settings");

const bootstrapBody = mutationInput("bootstrap-0001");
const bootstrap = await invoke("v1/bootstrap", "POST", bootstrapBody);
assert.equal(bootstrap.ok, true);
assert.equal(bootstrap.data.delivery_mode, "disabled");
assert.equal(bootstrap.data.concurrency_mode, "single_sequenced_writer_required");
assert.equal(await ctx.storage.segments.count(), 4);
assert.equal(await ctx.kv.get("settings:deliveryMode"), "disabled");
await ctx.storage.segments.delete("segment:paying_customers");
assert.equal(await ctx.storage.segments.count(), 3);
const repairedBootstrap = await invoke("v1/bootstrap", "POST", mutationInput("bootstrap-repair-0001"));
assert.equal(repairedBootstrap.ok, true);
assert.deepEqual(repairedBootstrap.data.plan.missing_segment_keys, ["paying_customers"]);
assert.equal(await ctx.storage.segments.count(), 4, "bootstrap must repair a missing default after initial setup");

const fileConfigCtx = createCtx();
await sandbox.routes["v1/bootstrap"].handler(
  routeContext("POST", mutationInput("file-config-bootstrap-0001")),
  fileConfigCtx,
);
const fileConfigStatusBefore = await sandbox.routes["v1/config/file/status"].handler(
  routeContext("GET", {}),
  fileConfigCtx,
);
assert.equal(fileConfigStatusBefore.ok, true);
assert.equal(fileConfigStatusBefore.data.config.deployment_status, "review_required");
assert.equal(fileConfigStatusBefore.data.config.runtime_status, "clean");
const fileConfigLoadBody = mutationInput("file-config-load-0001");
const fileConfigLoaded = await sandbox.routes["v1/config/file/load"].handler(
  routeContext("POST", fileConfigLoadBody),
  fileConfigCtx,
);
assert.equal(fileConfigLoaded.ok, true);
assert.equal(fileConfigLoaded.data.config.deployment_status, "acknowledged");
assert.equal(fileConfigLoaded.data.config.runtime_status, "clean");
assert.equal(fileConfigLoaded.data.existing_drift_overwritten, false);
assert.deepEqual(
  await sandbox.routes["v1/config/file/load"].handler(routeContext("POST", fileConfigLoadBody), fileConfigCtx),
  fileConfigLoaded,
  "file config load must replay its checkpointed result",
);
const fileConfigUnknownField = await sandbox.routes["v1/config/file/load"].handler(
  routeContext("POST", mutationInput("file-config-load-unknown-0001", { reset_runtime: true })),
  fileConfigCtx,
);
assert.equal(fileConfigUnknownField.ok, false);
assert.equal(fileConfigUnknownField.error.code, "UNKNOWN_OPERATION_FIELD");
const driftedPayingSegment = await fileConfigCtx.storage.segments.get("segment:paying_customers");
driftedPayingSegment.description = "Operator-owned runtime description";
await fileConfigCtx.storage.segments.put(driftedPayingSegment.id, driftedPayingSegment);
const fileConfigDrift = await sandbox.routes["v1/config/file/status"].handler(
  routeContext("GET", {}),
  fileConfigCtx,
);
assert.equal(fileConfigDrift.data.config.runtime_status, "drifted");
assert.deepEqual(fileConfigDrift.data.config.drifted_segment_keys, ["paying_customers"]);
const fileConfigReloaded = await sandbox.routes["v1/config/file/load"].handler(
  routeContext("POST", mutationInput("file-config-load-0002")),
  fileConfigCtx,
);
assert.equal(fileConfigReloaded.ok, true);
assert.equal(fileConfigReloaded.data.config.runtime_status, "drifted");
assert.equal(
  (await fileConfigCtx.storage.segments.get("segment:paying_customers")).description,
  "Operator-owned runtime description",
  "load must not overwrite drifted runtime records",
);
const emptyStatistics = await sandbox.routes["v1/statistics/summary"].handler(
  routeContext("GET", {}),
  fileConfigCtx,
);
assert.equal(emptyStatistics.ok, true);
assert.equal(emptyStatistics.data.statistics.profiles.total, 0);
assert.equal(emptyStatistics.data.statistics.file_config.runtime_status, "drifted");
assert.equal(
  (await sandbox.routes["v1/statistics/summary"].handler(routeContext("POST", {}), fileConfigCtx)).error.code,
  "METHOD_NOT_ALLOWED",
);

const adminConfigCtx = createCtx();
const adminConfigPage = await sandbox.routes.admin.handler(
  routeContext("POST", { type: "page_load", page: "/configuration" }),
  adminConfigCtx,
);
const adminConfigValidation = validateBlocks(adminConfigPage.blocks);
assert.equal(adminConfigValidation.valid, true, JSON.stringify(adminConfigValidation.errors));
assert.equal(JSON.stringify(adminConfigPage.blocks).includes("2026-07-11.2"), true);
assert.equal(JSON.stringify(adminConfigPage.blocks).includes("src/config/file-config.ts"), true);
const adminConfigLoad = await sandbox.routes.admin.handler(
  routeContext("POST", { type: "block_action", action_id: "load_file_config" }),
  adminConfigCtx,
);
assert.equal(adminConfigLoad.toast.type, "success");
assert.equal(
  (await sandbox.routes["v1/config/file/status"].handler(routeContext("GET", {}), adminConfigCtx)).data.config.deployment_status,
  "acknowledged",
  "admin action must checkpoint the exact bundled file config",
);
const adminStatisticsPage = await sandbox.routes.admin.handler(
  routeContext("POST", { type: "page_load", page: "/statistics" }),
  adminConfigCtx,
);
const adminStatisticsValidation = validateBlocks(adminStatisticsPage.blocks);
assert.equal(adminStatisticsValidation.valid, true, JSON.stringify(adminStatisticsValidation.errors));
const adminTrackingPage = await sandbox.routes.admin.handler(
  routeContext("POST", { type: "page_load", page: "/tracking" }),
  adminConfigCtx,
);
const adminTrackingValidation = validateBlocks(adminTrackingPage.blocks);
assert.equal(adminTrackingValidation.valid, true, JSON.stringify(adminTrackingValidation.errors));
assert.equal(JSON.stringify(adminTrackingPage.blocks).includes("Open used for scoring"), true);

const firstMigrationBody = mutationInput("migration-0001", { restart: true, limit: 30 });
const firstMigration = await invoke("v1/migrations/emdash-users/step", "POST", firstMigrationBody);
assert.equal(firstMigration.ok, true);
assert.equal(firstMigration.data.batch.processed, 30);
assert.equal(firstMigration.data.state.status, "running");
assert.equal(await ctx.storage.profiles.count(), 30);

const secondMigrationBody = mutationInput("migration-0002", { limit: 30 });
const secondMigration = await invoke("v1/migrations/emdash-users/step", "POST", secondMigrationBody);
assert.equal(secondMigration.ok, true);
assert.equal(secondMigration.data.batch.processed, 30);
assert.equal(secondMigration.data.state.status, "running");
assert.equal(await ctx.storage.profiles.count(), 60);

const thirdMigrationBody = mutationInput("migration-0003", { limit: 30 });
const thirdMigration = await invoke("v1/migrations/emdash-users/step", "POST", thirdMigrationBody);
assert.equal(thirdMigration.ok, true);
assert.equal(thirdMigration.data.batch.processed, 30);
assert.equal(thirdMigration.data.state.status, "running");
assert.equal(await ctx.storage.profiles.count(), 90);

const fourthMigrationBody = mutationInput("migration-0004", { limit: 30 });
const fourthMigration = await invoke("v1/migrations/emdash-users/step", "POST", fourthMigrationBody);
assert.equal(fourthMigration.ok, true);
assert.equal(fourthMigration.data.batch.processed, 15);
assert.equal(fourthMigration.data.state.status, "completed");
assert.equal(await ctx.storage.profiles.count(), 105);

const replayedMigration = await invoke("v1/migrations/emdash-users/step", "POST", fourthMigrationBody);
assert.deepEqual(replayedMigration, fourthMigration, "same request ID and payload must replay the receipt");
assert.equal(await ctx.storage.profiles.count(), 105);

const migrationOverLimit = await invoke(
  "v1/migrations/emdash-users/step",
  "POST",
  mutationInput("migration-limit-0001", { restart: true, limit: 31 }),
);
assert.equal(migrationOverLimit.ok, false);
assert.equal(migrationOverLimit.error.code, "INVALID_LIMIT");

const traitBody = mutationInput("profile-traits-0001", {
  profiles: [{
    emdash_user_id: "USER000",
    consent_evidence: {
      source: "test_suite",
      captured_at: new Date().toISOString(),
      policy_version: "test-v1",
      channel: "email",
    },
    traits: {
      marketing_consent: "granted",
      email_health: "healthy",
      reachability: "email",
      paid_tv_access: true,
      billing_state: "paying",
    },
  }],
});
const traitResult = await invoke("v1/profiles/upsert-batch", "POST", traitBody);
assert.equal(traitResult.ok, true);
const oversizedProfiles = [];
for (let index = 0; index < 21; index++) {
  oversizedProfiles.push({ emdash_user_id: "USER" + String(index).padStart(3, "0"), traits: { billing_state: "unknown" } });
}
const profileOverLimit = await invoke(
  "v1/profiles/upsert-batch",
  "POST",
  mutationInput("profile-limit-0001", { profiles: oversizedProfiles }),
);
assert.equal(profileOverLimit.ok, false);
assert.equal(profileOverLimit.error.code, "INVALID_BATCH_SIZE");
ctx._users[0].name = "Renamed User Zero";
const restartMigration = await invoke(
  "v1/migrations/emdash-users/step",
  "POST",
  mutationInput("migration-0005", { restart: true, limit: 30 }),
);
assert.equal(restartMigration.ok, true);
const migratedProfile = await ctx.storage.profiles.get("emdash:USER000");
assert.equal(migratedProfile.name, "Renamed User Zero");
assert.equal(migratedProfile.marketing_consent, "granted", "migration must preserve CRM-owned consent");
assert.equal(migratedProfile.traits.eligible_for_messaging, true);

const externalProfile = await invoke(
  "v1/profiles/upsert-batch",
  "POST",
  mutationInput("external-profile-0001", {
    source: "product_api",
    profiles: [{
      external_id: "customer-77",
      email: "customer77@example.com",
      name: "Customer 77",
      traits: { marketing_consent: "unknown" },
    }],
  }),
);
assert.equal(externalProfile.ok, true);
assert.ok(await ctx.storage.profiles.get("external:product_api:customer-77"));

const mismatchedSource = await invoke(
  "v1/profiles/upsert-batch",
  "POST",
  mutationInput("external-profile-0002", {
    source: "product_api",
    profiles: [{ external_source: "billing", external_id: "customer-88", traits: {} }],
  }),
);
assert.equal(mismatchedSource.ok, false);
assert.equal(mismatchedSource.error.code, "SOURCE_NAMESPACE_MISMATCH");

const membershipBaseTime = Date.now() - 20_000;
const addBody = mutationInput("segment-add-0001", {
  occurred_at: new Date(membershipBaseTime).toISOString(),
  segment_key: "crm_blacklist",
  emdash_user_ids: ["USER000"],
});
const addResult = await invoke("v1/segments/members/add", "POST", addBody);
assert.equal(addResult.ok, true);
assert.equal(addResult.data.result.added, 1);
assert.equal(await ctx.storage.segmentMembershipStates.count({ segment_key: "crm_blacklist", status: "open" }), 1);

const replayedAdd = await invoke("v1/segments/members/add", "POST", addBody);
assert.deepEqual(replayedAdd, addResult);
assert.equal(await ctx.storage.segmentMemberships.count({ segment_key: "crm_blacklist" }), 1);

const requestConflict = await invoke(
  "v1/segments/members/add",
  "POST",
  { ...addBody, emdash_user_ids: ["USER001"] },
);
assert.equal(requestConflict.ok, false);
assert.equal(requestConflict.error.code, "REQUEST_ID_CONFLICT");

const dynamicFeed = await invoke(
  "v1/segments/members/add",
  "POST",
  mutationInput("segment-add-0002", { segment_key: "paid_tv_users", emdash_user_ids: ["USER000"] }),
);
assert.equal(dynamicFeed.ok, false);
assert.equal(dynamicFeed.error.code, "DYNAMIC_SEGMENT_FEED_DENIED");

const membershipOverLimit = await invoke(
  "v1/segments/members/add",
  "POST",
  mutationInput("segment-limit-0001", {
    segment_key: "crm_blacklist",
    emdash_user_ids: users.slice(0, 11).map((user) => user.id),
  }),
);
assert.equal(membershipOverLimit.ok, false);
assert.equal(membershipOverLimit.error.code, "INVALID_BATCH_SIZE");

const removeResult = await invoke(
  "v1/segments/members/remove",
  "POST",
  mutationInput("segment-remove-0001", {
    occurred_at: new Date(membershipBaseTime + 1_000).toISOString(),
    segment_key: "crm_blacklist",
    emdash_user_ids: ["USER000"],
  }),
);
assert.equal(removeResult.ok, true);
assert.equal(removeResult.data.result.removed, 1);
assert.equal(await ctx.storage.segmentMembershipStates.count({ segment_key: "crm_blacklist", status: "open" }), 0);

const readdResult = await invoke(
  "v1/segments/members/add",
  "POST",
  mutationInput("segment-readd-0001", {
    occurred_at: new Date(membershipBaseTime + 2_000).toISOString(),
    segment_key: "crm_blacklist",
    emdash_user_ids: ["USER000"],
  }),
);
assert.equal(readdResult.ok, true);
assert.equal(readdResult.data.result.added, 1);
const reopenedState = await ctx.storage.segmentMembershipStates.get("state|crm_blacklist|emdash:USER000");
assert.equal(reopenedState.entry_version, 2);
assert.equal(await ctx.storage.segmentMemberships.count({ segment_key: "crm_blacklist" }), 2);

const staleRemove = await invoke(
  "v1/segments/members/remove",
  "POST",
  mutationInput("segment-stale-0001", {
    occurred_at: new Date(membershipBaseTime + 1_500).toISOString(),
    segment_key: "crm_blacklist",
    emdash_user_ids: ["USER000"],
  }),
);
assert.equal(staleRemove.ok, false);
assert.equal(staleRemove.error.code, "STALE_MEMBERSHIP_UPDATE");

const concurrentTime = new Date(membershipBaseTime + 3_000).toISOString();
const concurrentBodies = [
  mutationInput("concurrent-add-0001", {
    occurred_at: concurrentTime,
    segment_key: "crm_blacklist",
    emdash_user_ids: ["USER001"],
  }),
  mutationInput("concurrent-add-0002", {
    occurred_at: concurrentTime,
    segment_key: "crm_blacklist",
    emdash_user_ids: ["USER001"],
  }),
];
const concurrentAdds = await Promise.all(concurrentBodies.map((body) => invoke("v1/segments/members/add", "POST", body)));
assert.deepEqual(
  concurrentAdds.map((result) => result.data.result.added).sort(),
  [0, 1],
  "same-isolate mutation queue must prevent duplicate open histories",
);
assert.equal(await ctx.storage.segmentMemberships.count({ segment_key: "crm_blacklist", profile_id: "emdash:USER001" }), 1);

const recomputeOne = await invoke(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("recompute-0001", { segment_key: "paid_tv_users", restart: true }),
);
assert.equal(recomputeOne.ok, true);
assert.equal(recomputeOne.data.activated, false);
assert.equal((await ctx.storage.segments.get("segment:paid_tv_users")).active_generation, null);

const recomputeTwo = await invoke(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("recompute-0002", { segment_key: "paid_tv_users" }),
);
assert.equal(recomputeTwo.ok, true);
assert.equal(recomputeTwo.data.activated, false);
const recomputeThree = await invoke(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("recompute-0003", { segment_key: "paid_tv_users" }),
);
assert.equal(recomputeThree.ok, true);
assert.equal(recomputeThree.data.activated, false);
const recomputeFour = await invoke(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("recompute-0004", { segment_key: "paid_tv_users" }),
);
assert.equal(recomputeFour.ok, true);
assert.equal(recomputeFour.data.activated, true);
assert.equal((await ctx.storage.segments.get("segment:paid_tv_users")).active_generation, "gen:recompute-0001");
assert.equal(
  await ctx.storage.segmentMemberships.count({ segment_key: "paid_tv_users", status: "snapshot" }),
  1,
  "dynamic generations use immutable snapshot rows",
);

const preview = await invoke(
  "v1/segments/preview",
  "POST",
  { segment_key: "paid_tv_users", limit: 10 },
);
assert.equal(preview.ok, true);
assert.equal(preview.data.count, 1);
assert.deepEqual(preview.data.sample_profile_ids, ["emdash:USER000"]);

for (const page of ["/dashboard", "/profiles", "/segments", "/events", "/migration", "/settings"]) {
  const adminResult = await sandbox.routes.admin.handler(
    routeContext("POST", { type: "page_load", page }),
    ctx,
  );
  const validation = validateBlocks(adminResult.blocks);
  assert.equal(validation.valid, true, page + " Block Kit invalid: " + JSON.stringify(validation.errors));
}

const profileAdminPage = await sandbox.routes.admin.handler(
  routeContext("POST", { type: "page_load", page: "/profiles" }),
  ctx,
);
const profileTable = profileAdminPage.blocks.find((block) => block.type === "table");
assert.ok(profileTable.next_cursor, "profile page must expose a cursor when more rows exist");
const nextProfilePage = await sandbox.routes.admin.handler(
  routeContext("POST", {
    type: "block_action",
    action_id: "profiles_page",
    value: { cursor: profileTable.next_cursor, sort: null },
  }),
  ctx,
);
assert.equal(validateBlocks(nextProfilePage.blocks).valid, true, "Block Kit object cursor must load the next profile page");
assert.ok(nextProfilePage.blocks.find((block) => block.type === "table").rows.length > 0);

for (let index = 0; index < 55; index++) {
  const occurredAt = new Date(Date.UTC(2999, 0, 1, 0, 0, index)).toISOString();
  await ctx.storage.events.put("manual-event-" + index, {
    id: "manual-event-" + index,
    type: "manual_event_" + index,
    profile_id: null,
    segment_key: null,
    request_id: "manual-request-" + index,
    occurred_at: occurredAt,
    metadata: {},
  });
}
const eventsAdminPage = await sandbox.routes.admin.handler(
  routeContext("POST", { type: "page_load", page: "/events" }),
  ctx,
);
const eventsTable = eventsAdminPage.blocks.find((block) => block.type === "table");
assert.equal(eventsTable.rows[0].type, "manual_event_54", "events page must show the newest global event first");
assert.equal(eventsTable.next_cursor, undefined, "descending event view must not expose an invalid cursor");

const wrongMethod = await invoke("v1/profiles/upsert-batch", "GET", traitBody);
assert.equal(wrongMethod.ok, false);
assert.equal(wrongMethod.error.code, "METHOD_NOT_ALLOWED");

// Per-profile operation markers preserve the original outcome when the global
// receipt write fails after domain writes have completed.
const receiptCtx = createCtx();
async function invokeReceipt(route, method, input) {
  return await sandbox.routes[route].handler(routeContext(method, input), receiptCtx);
}
await invokeReceipt("v1/bootstrap", "POST", mutationInput("receipt-bootstrap-0001"));
const originalReceiptPut = receiptCtx.storage.ingestRequests.put.bind(receiptCtx.storage.ingestRequests);
let profileReceiptWriteCount = 0;
receiptCtx.storage.ingestRequests.put = async function(id, data) {
  if (id === "receipt|receipt-profile-0001") profileReceiptWriteCount++;
  if (id === "receipt|receipt-profile-0001" && profileReceiptWriteCount === 3) {
    throw new Error("simulated receipt failure");
  }
  return await originalReceiptPut(id, data);
};
const receiptProfileBody = mutationInput("receipt-profile-0001", {
  source: "billing",
  profiles: [{ external_source: "billing", external_id: "retry-user", traits: { billing_state: "paying" } }],
});
const receiptProfileFirst = await invokeReceipt("v1/profiles/upsert-batch", "POST", receiptProfileBody);
assert.equal(receiptProfileFirst.ok, true);
assert.equal(receiptProfileFirst.data.created, 1);
assert.ok(receiptProfileFirst.idempotency_warning);
const receiptConflict = await invokeReceipt(
  "v1/profiles/upsert-batch",
  "POST",
  { ...receiptProfileBody, profiles: [{ external_source: "billing", external_id: "retry-user", name: "Changed", traits: {} }] },
);
assert.equal(receiptConflict.ok, false);
assert.equal(receiptConflict.error.code, "REQUEST_ID_CONFLICT");
const receiptIdentityConflict = await invokeReceipt(
  "v1/profiles/upsert-batch",
  "POST",
  { ...receiptProfileBody, profiles: [{ external_source: "billing", external_id: "different-user", traits: {} }] },
);
assert.equal(receiptIdentityConflict.ok, false);
assert.equal(receiptIdentityConflict.error.code, "REQUEST_ID_CONFLICT");
assert.equal(await receiptCtx.storage.profiles.get("external:billing:different-user"), null);
const receiptProfileRetry = await invokeReceipt("v1/profiles/upsert-batch", "POST", receiptProfileBody);
assert.equal(receiptProfileRetry.ok, true);
assert.equal(receiptProfileRetry.data.created, 1, "receipt retry must preserve the original created outcome");
const retryProfileEvent = await receiptCtx.storage.events.get(
  "event|profile_upserted|receipt-profile-0001|external:billing:retry-user",
);
assert.equal(retryProfileEvent.metadata.outcome, "created");

const secondReceiptProfile = await invokeReceipt(
  "v1/profiles/upsert-batch",
  "POST",
  mutationInput("receipt-profile-0002", {
    source: "billing",
    profiles: [{ external_id: "retry-user-2", traits: {} }],
  }),
);
assert.equal(secondReceiptProfile.ok, true);
let staticReceiptWriteCount = 0;
receiptCtx.storage.ingestRequests.put = async function(id, data) {
  if (id === "receipt|receipt-static-0001") staticReceiptWriteCount++;
  if (id === "receipt|receipt-static-0001" && staticReceiptWriteCount === 3) {
    throw new Error("simulated static receipt failure");
  }
  return await originalReceiptPut(id, data);
};
const receiptStaticBody = mutationInput("receipt-static-0001", {
  source: "billing",
  segment_key: "crm_blacklist",
  profile_ids: ["external:billing:retry-user"],
});
const receiptStaticFirst = await invokeReceipt("v1/segments/members/add", "POST", receiptStaticBody);
assert.equal(receiptStaticFirst.ok, true);
assert.equal(receiptStaticFirst.data.result.added, 1);
const receiptStaticConflict = await invokeReceipt(
  "v1/segments/members/add",
  "POST",
  { ...receiptStaticBody, profile_ids: ["external:billing:retry-user-2"] },
);
assert.equal(receiptStaticConflict.ok, false);
assert.equal(receiptStaticConflict.error.code, "REQUEST_ID_CONFLICT");
assert.equal(
  await receiptCtx.storage.segmentMembershipStates.get("state|crm_blacklist|external:billing:retry-user-2"),
  null,
);
const receiptStaticRetry = await invokeReceipt("v1/segments/members/add", "POST", receiptStaticBody);
assert.equal(receiptStaticRetry.ok, true);
assert.equal(receiptStaticRetry.data.result.added, 1, "membership marker must preserve the original add outcome");
assert.equal(await receiptCtx.storage.segmentMemberships.count({ segment_key: "crm_blacklist" }), 1);

const migrationRetryCtx = createCtx([{
  id: "RETRYUSER",
  email: "retry@example.com",
  name: "Retry User",
  role: 10,
  createdAt: "2026-01-01T00:00:00.000Z",
}]);
const originalKvSet = migrationRetryCtx.kv.set.bind(migrationRetryCtx.kv);
let failMigrationCheckpointOnce = true;
migrationRetryCtx.kv.set = async function(key, value) {
  if (key === "state:emdashUserMigration" && failMigrationCheckpointOnce) {
    failMigrationCheckpointOnce = false;
    throw new Error("simulated migration checkpoint failure");
  }
  return await originalKvSet(key, value);
};
const migrationRetryBody = mutationInput("migration-retry-0001", { restart: true, limit: 30 });
const migrationPartial = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", migrationRetryBody),
  migrationRetryCtx,
);
assert.equal(migrationPartial.ok, false);
assert.equal(migrationPartial.error.code, "PARTIAL_WRITE");
const migrationRecovered = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", migrationRetryBody),
  migrationRetryCtx,
);
assert.equal(migrationRecovered.ok, true);
assert.equal(migrationRecovered.data.batch.created, 1, "checkpoint retry must preserve the original migration outcome");

// A late retry of an older page replays its checkpointed result without
// rolling the durable migration cursor back after a newer page completed.
const delayedMigrationUsers = [];
for (let index = 0; index < 31; index++) {
  delayedMigrationUsers.push({
    id: "DELAYED" + String(index).padStart(3, "0"),
    email: "delayed" + index + "@example.com",
    name: "Delayed " + index,
    role: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
const delayedMigrationCtx = createCtx(delayedMigrationUsers);
const originalDelayedReceiptPut = delayedMigrationCtx.storage.ingestRequests.put.bind(
  delayedMigrationCtx.storage.ingestRequests,
);
let delayedReceiptWriteCount = 0;
delayedMigrationCtx.storage.ingestRequests.put = async function(id, data) {
  if (id === "receipt|delayed-migration-0001") delayedReceiptWriteCount++;
  if (id === "receipt|delayed-migration-0001" && delayedReceiptWriteCount === 3) {
    throw new Error("simulated delayed migration completion receipt failure");
  }
  return await originalDelayedReceiptPut(id, data);
};
const delayedMigrationBody = mutationInput("delayed-migration-0001", { restart: true, limit: 30 });
const delayedMigrationFirst = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", delayedMigrationBody),
  delayedMigrationCtx,
);
assert.equal(delayedMigrationFirst.ok, true);
assert.ok(delayedMigrationFirst.idempotency_warning);
const delayedMigrationSecond = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", mutationInput("delayed-migration-0002", { limit: 30 })),
  delayedMigrationCtx,
);
assert.equal(delayedMigrationSecond.data.state.status, "completed");
const delayedMigrationReplay = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", delayedMigrationBody),
  delayedMigrationCtx,
);
assert.equal(delayedMigrationReplay.data.batch.processed, 30);
const delayedMigrationState = await delayedMigrationCtx.kv.get("state:emdashUserMigration");
assert.equal(delayedMigrationState.status, "completed");
assert.equal(delayedMigrationState.processed, 31);

// An API caller cannot impersonate the internal admin path by claiming
// source=admin. A failed result checkpoint must still gate the next cursor.
const forgedAdminUsers = [];
for (let forgedIndex = 0; forgedIndex < 31; forgedIndex++) {
  forgedAdminUsers.push({
    id: "FORGED" + String(forgedIndex).padStart(3, "0"),
    email: "forged" + forgedIndex + "@example.com",
    name: "Forged Admin Source " + forgedIndex,
    role: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
const forgedAdminCtx = createCtx(forgedAdminUsers);
const originalForgedReceiptPut = forgedAdminCtx.storage.ingestRequests.put.bind(
  forgedAdminCtx.storage.ingestRequests,
);
let forgedReceiptWriteCount = 0;
forgedAdminCtx.storage.ingestRequests.put = async function(id, data) {
  if (id === "receipt|forged-admin-migration-0001") forgedReceiptWriteCount++;
  if (id === "receipt|forged-admin-migration-0001" && forgedReceiptWriteCount === 2) {
    throw new Error("simulated forged-admin checkpoint failure");
  }
  return await originalForgedReceiptPut(id, data);
};
const forgedAdminFirstBody = mutationInput("forged-admin-migration-0001", {
  source: "admin",
  restart: true,
  limit: 30,
});
const forgedAdminFirst = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", forgedAdminFirstBody),
  forgedAdminCtx,
);
assert.equal(forgedAdminFirst.ok, false);
assert.equal(forgedAdminFirst.error.code, "RESULT_CHECKPOINT_FAILED");
const forgedAdminState = await forgedAdminCtx.kv.get("state:emdashUserMigration");
assert.equal(forgedAdminState.processed, 30);
assert.equal(forgedAdminState.last_request_receipt_required, true);
const forgedAdminAdvance = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", mutationInput("forged-admin-migration-0002", { source: "admin", limit: 30 })),
  forgedAdminCtx,
);
assert.equal(forgedAdminAdvance.ok, false);
assert.equal(forgedAdminAdvance.error.code, "PREVIOUS_STEP_UNCONFIRMED");
assert.equal((await forgedAdminCtx.kv.get("state:emdashUserMigration")).processed, 30);
const forgedAdminRecovered = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", forgedAdminFirstBody),
  forgedAdminCtx,
);
assert.equal(forgedAdminRecovered.ok, true);
assert.equal(forgedAdminRecovered.data.state.processed, 30);

// Recompute generations are invalidated if any profile changes between scan
// pages, avoiding a mixed-time audience snapshot.
const epochUsers = [];
for (let index = 0; index < 31; index++) {
  epochUsers.push({
    id: "EPOCH" + String(index).padStart(3, "0"),
    email: "epoch" + index + "@example.com",
    name: "Epoch " + index,
    role: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
const epochCtx = createCtx(epochUsers);
async function invokeEpoch(route, method, input) {
  return await sandbox.routes[route].handler(routeContext(method, input), epochCtx);
}
await invokeEpoch("v1/bootstrap", "POST", mutationInput("epoch-bootstrap-0001"));
await invokeEpoch(
  "v1/migrations/emdash-users/step",
  "POST",
  mutationInput("epoch-migration-0001", { restart: true, limit: 30 }),
);
await invokeEpoch(
  "v1/migrations/emdash-users/step",
  "POST",
  mutationInput("epoch-migration-0002", { limit: 30 }),
);
const epochScanOne = await invokeEpoch(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("epoch-recompute-0001", { segment_key: "paying_customers", restart: true }),
);
assert.equal(epochScanOne.data.state.phase, "scanning");
await invokeEpoch(
  "v1/profiles/upsert-batch",
  "POST",
  mutationInput("epoch-profile-0001", {
    profiles: [{ emdash_user_id: "EPOCH000", traits: { billing_state: "paying" } }],
  }),
);
const staleEpochScan = await invokeEpoch(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("epoch-recompute-0002", { segment_key: "paying_customers" }),
);
assert.equal(staleEpochScan.ok, false);
assert.equal(staleEpochScan.error.code, "PROFILES_CHANGED_DURING_RECOMPUTE");
const restartedEpochScan = await invokeEpoch(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("epoch-recompute-0003", { segment_key: "paying_customers", restart: true }),
);
assert.equal(restartedEpochScan.ok, true);
assert.equal(restartedEpochScan.data.state.scanned, 28);

// Bounded recompute keeps a top-N candidate set across scan pages and only
// activates the generation after the selected rows are materialized.
const boundedUsers = [];
for (let index = 0; index < 101; index++) {
  const id = index === 0 ? "ZZZ_EARLY" : index === 100 ? "AAA_LATE" : "MID_" + String(index).padStart(3, "0");
  boundedUsers.push({
    id,
    email: "bounded" + index + "@example.com",
    name: "Bounded " + index,
    role: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
const boundedCtx = createCtx(boundedUsers);
async function invokeBounded(route, method, input, suffix = "") {
  return await sandbox.routes[route].handler(routeContext(method, input, suffix), boundedCtx);
}
await invokeBounded("v1/bootstrap", "POST", mutationInput("bounded-bootstrap-0001"));
await invokeBounded(
  "v1/migrations/emdash-users/step",
  "POST",
  mutationInput("bounded-migration-0001", { restart: true, limit: 30 }),
);
await invokeBounded(
  "v1/migrations/emdash-users/step",
  "POST",
  mutationInput("bounded-migration-0002", { limit: 30 }),
);
await invokeBounded(
  "v1/migrations/emdash-users/step",
  "POST",
  mutationInput("bounded-migration-0003", { limit: 30 }),
);
await invokeBounded(
  "v1/migrations/emdash-users/step",
  "POST",
  mutationInput("bounded-migration-0004", { limit: 30 }),
);
await invokeBounded(
  "v1/profiles/upsert-batch",
  "POST",
  mutationInput("bounded-traits-0001", {
    profiles: [
      { emdash_user_id: "ZZZ_EARLY", traits: { billing_state: "paying" } },
      { emdash_user_id: "AAA_LATE", traits: { billing_state: "paying" } },
    ],
  }),
);
await invokeBounded(
  "v1/segments/upsert",
  "POST",
  mutationInput("bounded-segment-0001", {
    segment: {
      key: "bounded_paying",
      name: "Bounded paying",
      kind: "dynamic",
      membership_limit: 1,
      rule: { trait: "billing_state", operator: "eq", value: "paying" },
    },
  }),
);
const boundedScanOne = await invokeBounded(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("bounded-recompute-0001", { segment_key: "bounded_paying", restart: true }),
);
assert.equal(boundedScanOne.data.state.phase, "scanning");
const boundedScanTwo = await invokeBounded(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("bounded-recompute-0002", { segment_key: "bounded_paying" }),
);
assert.equal(boundedScanTwo.data.state.phase, "scanning");
assert.equal(boundedScanTwo.data.activated, false);
assert.equal((await boundedCtx.storage.segments.get("segment:bounded_paying")).active_generation, null);
const boundedScanThree = await invokeBounded(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("bounded-recompute-0003", { segment_key: "bounded_paying" }),
);
assert.equal(boundedScanThree.data.state.phase, "scanning");
assert.equal(boundedScanThree.data.activated, false);
const boundedScanFour = await invokeBounded(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("bounded-recompute-0004", { segment_key: "bounded_paying" }),
);
assert.equal(boundedScanFour.data.state.phase, "materializing");
assert.equal(boundedScanFour.data.activated, false);
const boundedMaterialize = await invokeBounded(
  "v1/segments/recompute-step",
  "POST",
  mutationInput("bounded-recompute-0005", { segment_key: "bounded_paying" }),
);
assert.equal(boundedMaterialize.data.activated, true);
const boundedPreview = await invokeBounded(
  "v1/segments/preview",
  "POST",
  { segment_key: "bounded_paying" },
);
assert.deepEqual(
  boundedPreview.data.sample_profile_ids,
  ["emdash:AAA_LATE"],
  "membership_limit must select the lowest stable EmDash user ID across all scan pages",
);

// Approximate the real plugin-storage statement model: getMany/query are one
// statement while putMany expands to one statement per document.
const profileBudgetCtx = createCtx();
const budgetProfiles = [];
for (let index = 0; index < 20; index++) {
  budgetProfiles.push({ external_id: "profile-" + index, traits: { billing_state: "unknown" } });
}
const profileBudgetResult = await sandbox.routes["v1/profiles/upsert-batch"].handler(
  routeContext("POST", mutationInput("budget-profile-0001", { source: "budget", profiles: budgetProfiles })),
  profileBudgetCtx,
);
assert.equal(profileBudgetResult.ok, true);
assert.ok(profileBudgetCtx._statementCount() <= 50, "max profile batch must stay within 50 storage statements");

const staticBudgetCtx = createCtx();
await sandbox.routes["v1/bootstrap"].handler(
  routeContext("POST", mutationInput("budget-bootstrap-0001")),
  staticBudgetCtx,
);
const staticBudgetProfiles = [];
const staticBudgetIds = [];
for (let index = 0; index < 10; index++) {
  staticBudgetProfiles.push({ external_id: "static-" + index, traits: {} });
  staticBudgetIds.push("external:budget:static-" + index);
}
await sandbox.routes["v1/profiles/upsert-batch"].handler(
  routeContext("POST", mutationInput("budget-static-profiles-0001", { source: "budget", profiles: staticBudgetProfiles })),
  staticBudgetCtx,
);
staticBudgetCtx._resetStatementCount();
const staticBudgetResult = await sandbox.routes["v1/segments/members/add"].handler(
  routeContext("POST", mutationInput("budget-static-add-0001", {
    source: "budget",
    segment_key: "crm_blacklist",
    profile_ids: staticBudgetIds,
  })),
  staticBudgetCtx,
);
assert.equal(staticBudgetResult.ok, true);
assert.ok(staticBudgetCtx._statementCount() <= 50, "max static batch must stay within 50 storage statements");

const migrationBudgetUsers = [];
for (let index = 0; index < 30; index++) {
  migrationBudgetUsers.push({
    id: "BUDGET" + index,
    email: "budget" + index + "@example.com",
    name: "Budget " + index,
    role: 10,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
const migrationBudgetCtx = createCtx(migrationBudgetUsers);
const migrationBudgetResult = await sandbox.routes["v1/migrations/emdash-users/step"].handler(
  routeContext("POST", mutationInput("budget-migration-0001", { restart: true, limit: 30 })),
  migrationBudgetCtx,
);
assert.equal(migrationBudgetResult.ok, true);
assert.ok(migrationBudgetCtx._statementCount() <= 50, "max migration page must stay within 50 storage statements");

const recomputeBudgetCtx = createCtx();
const recomputeProfileWrites = [];
for (let index = 0; index < 28; index++) {
  recomputeProfileWrites.push({
    id: "emdash:RECOMPUTE" + index,
    data: {
      id: "emdash:RECOMPUTE" + index,
      emdash_user_id: "RECOMPUTE" + index,
      traits: { billing_state: "paying" },
    },
  });
}
await recomputeBudgetCtx.storage.profiles.putMany(recomputeProfileWrites);
await recomputeBudgetCtx.storage.segments.put("segment:recompute_budget", {
  id: "segment:recompute_budget",
  schema_version: 1,
  key: "recompute_budget",
  name: "Recompute budget",
  description: "",
  kind: "dynamic",
  evaluation_mode: "scheduled",
  rule: { trait: "billing_state", operator: "eq", value: "paying" },
  membership_limit: null,
  group_key: null,
  is_active: true,
  active_generation: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_recomputed_at: null,
});
recomputeBudgetCtx._resetStatementCount();
const recomputeBudgetResult = await sandbox.routes["v1/segments/recompute-step"].handler(
  routeContext("POST", mutationInput("budget-recompute-0001", { segment_key: "recompute_budget", restart: true })),
  recomputeBudgetCtx,
);
assert.equal(recomputeBudgetResult.ok, true);
assert.equal(recomputeBudgetResult.data.activated, true);
assert.ok(recomputeBudgetCtx._statementCount() <= 50, "max recompute page must stay within 50 storage statements");

console.log("CRM Studio sandbox route tests passed");
