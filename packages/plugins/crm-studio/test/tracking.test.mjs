import assert from "node:assert/strict";
import {
  buildTrackingMetricFact,
  observeClick,
  observeOpen,
  observeUnsubscribe,
  sendTrackedEmail,
  syncCloudflareReport,
} from "../dist/application/manage-email-tracking.js";
import { createCtx } from "./helpers.mjs";

const ctx = createCtx();
const timestamp = "2026-07-11T20:00:00.000Z";
await ctx.storage.profiles.put("profile:one", {
  id: "profile:one",
  email: "reader@example.com",
  traits: { eligible_for_messaging: true },
});
await ctx.storage.programs.put("program:weekly", {
  id: "program:weekly",
  key: "weekly",
  template_key: "weekly_template",
  audience_segment_key: "emdash_users",
  offer_type: "informational",
  is_active: true,
});
await ctx.storage.messageTemplates.put("message-template:weekly_template", {
  id: "message-template:weekly_template",
  key: "weekly_template",
  subject: "Weekly update",
  body_html: '<p>Hello</p><a href="https://example.com/offer?x=1">View offer</a>',
  body_text: "View https://example.com/offer?x=1",
  is_active: true,
});
await ctx.storage.segmentMembershipStates.put("state|emdash_users|profile:one", {
  id: "state|emdash_users|profile:one",
  status: "open",
});
await ctx.kv.set("settings:trackingBaseUrl", "https://crm.example.com");
await ctx.kv.set("settings:cloudflareAccountId", "account");
await ctx.kv.set("settings:cloudflareZoneId", "zone");
await ctx.kv.set("settings:cloudflareApiToken", "secret-token");
await ctx.kv.set("settings:cloudflareFromAddress", "news@example.com");

let sentPayload;
ctx.http = {
  async fetch(url, init) {
    assert.equal(url.includes("/email/sending/send"), true);
    sentPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ success: true, errors: [], result: { delivered: ["reader@example.com"], permanent_bounces: [], queued: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};

const disabledSend = await sendTrackedEmail(ctx, {
  program_key: "weekly",
  profile_id: "profile:one",
  period_key: "2026-W28",
}, "tracking-send-disabled-0001", timestamp, false);
assert.equal(disabledSend.ok, false);
assert.equal(disabledSend.error.code, "DELIVERY_DISABLED");
assert.equal(await ctx.storage.emailDeliveries.count(), 0, "disabled delivery must not persist a delivery");
await ctx.kv.set("settings:deliveryMode", "enabled");

const sent = await sendTrackedEmail(ctx, {
  program_key: "weekly",
  profile_id: "profile:one",
  period_key: "2026-W28",
}, "tracking-send-0001", timestamp, false);
assert.equal(sent.ok, true);
assert.equal(sent.data.delivery.provider_status, "delivered");
assert.equal(sent.data.tracked_links, 1);
assert.match(sentPayload.html, /\/crm-track\/c\/[a-f0-9]{48}/);
assert.match(sentPayload.html, /\/crm-track\/o\/[a-f0-9]{48}\.gif/);
assert.equal(sentPayload.headers["X-CRM-Delivery-ID"], "weekly|2026-W28|profile:one");
assert.equal(sentPayload.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
assert.equal(JSON.stringify(sentPayload).includes("secret-token"), false);

const delivery = sent.data.delivery;
const links = await ctx.storage.trackingLinks.query({ where: { delivery_key: delivery.delivery_key }, limit: 10 });
assert.equal(links.items.length, 1);
const linkToken = links.items[0].data.token;
const open = await observeOpen(ctx, "https://crm.example.com/_emdash/api/plugins/crm-studio/v1/tracking/open?token=" + delivery.open_token, { "user-agent": "Mozilla/5.0" });
assert.equal(open.ok, true);
const click = await observeClick(ctx, "https://crm.example.com/_emdash/api/plugins/crm-studio/v1/tracking/click?token=" + linkToken, { "user-agent": "Mozilla/5.0" });
assert.equal(click.ok, true);
assert.equal(click.data.location, "https://example.com/offer?x=1");

const metrics = await buildTrackingMetricFact(ctx, "weekly", "2026-W28", false);
assert.equal(metrics.ok, true);
assert.equal(metrics.data.fact.sent, 1);
assert.equal(metrics.data.fact.delivered, 1);
assert.equal(metrics.data.fact.unique_clicks, 1);
assert.equal(metrics.data.observations.opens_used_for_scoring, false);

const confirmation = await observeUnsubscribe(ctx, "https://crm.example.com/_emdash/api/plugins/crm-studio/v1/tracking/unsubscribe?token=" + delivery.open_token, { "user-agent": "Mozilla/5.0" }, false);
assert.equal(confirmation.data.action, "confirm_unsubscribe");
assert.equal(await ctx.storage.suppressions.get("suppression|email|profile:one"), null, "GET must not unsubscribe because scanners preload links");
const unsubscribed = await observeUnsubscribe(ctx, "https://crm.example.com/_emdash/api/plugins/crm-studio/v1/tracking/unsubscribe?token=" + delivery.open_token, { "user-agent": "Mozilla/5.0" }, true);
assert.equal(unsubscribed.ok, true);
assert.equal((await ctx.storage.suppressions.get("suppression|email|profile:one")).is_active, true);

ctx.http.fetch = async function(url, init) {
  assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
  assert.equal(init.headers.Authorization, "Bearer secret-token");
  return new Response(JSON.stringify({
    data: { viewer: { zones: [{ emailSendingAdaptive: [{
      datetime: "2026-07-11T20:00:10.000Z",
      to: "reader@example.com",
      subject: "Weekly update",
      status: "delivered",
      messageId: "cf-message-1",
      errorCause: "",
      errorDetail: "",
      isLastEvent: 1,
    }] }] } },
    errors: null,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const report = await syncCloudflareReport(ctx, { program_key: "weekly", period_key: "2026-W28" });
assert.equal(report.ok, true);
assert.equal(report.data.matched, 1);
assert.equal((await ctx.storage.emailDeliveries.get(delivery.id)).provider_message_id, "cf-message-1");

assert.equal((await observeOpen(ctx, "https://crm.example.com/?token=bad", {})).error.code, "TRACKING_NOT_FOUND");
assert.equal((await observeClick(ctx, "https://crm.example.com/?token=" + "f".repeat(48), {})).error.code, "TRACKING_NOT_FOUND");

console.log("CRM Studio tracking, cloaking, pixel, unsubscribe, and Cloudflare report tests passed");
