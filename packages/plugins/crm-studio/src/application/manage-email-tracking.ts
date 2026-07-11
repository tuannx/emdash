import type {
  CrmContext,
  CrmProfile,
  EmailDelivery,
  GrowthProgram,
  JsonRecord,
  TrackingEvent,
  TrackingLink
} from "../types.js";
import { apiError, apiSuccess, isJsonRecord } from "./contracts.js";
import { requestPayloadFingerprint } from "../domain/membership.js";

var MAX_TRACKED_LINKS = 20;
var TOKEN_PATTERN = /^[a-f0-9]{48}$/;

function randomToken(): string {
  var bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  var output: string[] = [];
  for (var index = 0; index < bytes.length; index++) output.push(bytes[index].toString(16).padStart(2, "0"));
  return output.join("");
}

async function fingerprint(value: string): Promise<string> {
  return await requestPayloadFingerprint("email-tracking", { value: value });
}

function normalizeHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    var parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch (_error) {
    return null;
  }
}

function safeTarget(value: string, trackingOrigin: string): string | null {
  try {
    var parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    if (parsed.origin === trackingOrigin && (parsed.pathname.indexOf("/crm-track/c/") === 0 || parsed.pathname.indexOf("/crm-track/o/") === 0)) return null;
    return parsed.toString();
  } catch (_error) {
    return null;
  }
}

function classifyUserAgent(value: string): "human_candidate" | "proxy_or_bot" | "unknown" {
  var normalized = value.toLowerCase();
  if (!normalized) return "unknown";
  if (/bot|crawler|spider|scanner|preview|proxy|mailprivacy|googleimageproxy|outlook-ios|safelinks/.test(normalized)) return "proxy_or_bot";
  if (/mozilla|applewebkit|chrome|safari|firefox|edge/.test(normalized)) return "human_candidate";
  return "unknown";
}

function header(headers: Record<string, string>, name: string): string {
  var direct = headers[name];
  if (typeof direct === "string") return direct;
  var keys = Object.keys(headers);
  for (var index = 0; index < keys.length; index++) {
    if (keys[index].toLowerCase() === name.toLowerCase()) return String(headers[keys[index]] || "");
  }
  return "";
}

async function validateAudience(ctx: CrmContext, program: GrowthProgram | null, profile: CrmProfile | null): Promise<JsonRecord | null> {
  if (!program || program.is_active !== true) return apiError("PROGRAM_NOT_ACTIVE", "An active program is required for delivery");
  if (!profile || profile.traits?.eligible_for_messaging !== true || !profile.email) {
    return apiError("PROFILE_NOT_ELIGIBLE", "Profile must have granted consent, healthy email, and email reachability");
  }
  var membership = await ctx.storage.segmentMembershipStates.get("state|" + program.audience_segment_key + "|" + profile.id);
  if (!membership || membership.status !== "open") return apiError("PROFILE_NOT_IN_AUDIENCE", "Profile is not an open member of the program audience");
  var suppression = await ctx.storage.suppressions.query({
    where: { profile_id: profile.id, channel: "email", is_active: true },
    limit: 1
  });
  if (suppression.items.length > 0) return apiError("PROFILE_SUPPRESSED", "Profile has an active email suppression");
  var blacklist = await ctx.storage.segmentMembershipStates.get("state|crm_blacklist|" + profile.id);
  if (blacklist && blacklist.status === "open") return apiError("PROFILE_BLACKLISTED", "Profile is in crm_blacklist");
  if (program.offer_type === "discount" || program.offer_type === "acquisition") {
    var paidTv = await ctx.storage.segmentMembershipStates.get("state|paid_tv_users|" + profile.id);
    if (paidTv && paidTv.status === "open") return apiError("PROFILE_PAID_TV_EXCLUDED", "Paid TV users are excluded from this offer type");
  }
  return null;
}

async function renderTrackedMessage(
  ctx: CrmContext,
  delivery: EmailDelivery,
  bodyHtml: string,
  bodyText: string,
  trackingOrigin: string,
  persist: boolean
): Promise<{ html: string; text: string; links: TrackingLink[] }> {
  var links: TrackingLink[] = [];
  var seen: Record<string, TrackingLink> = {};
  var expression = /href\s*=\s*(["'])(https:\/\/[^"']+)\1/gi;
  var matches: Array<{ full: string; quote: string; target: string }> = [];
  var match: RegExpExecArray | null;
  while ((match = expression.exec(bodyHtml)) !== null && matches.length < MAX_TRACKED_LINKS) {
    matches.push({ full: match[0], quote: match[1], target: match[2] });
  }
  var html = bodyHtml;
  for (var index = 0; index < matches.length; index++) {
    var target = safeTarget(matches[index].target, trackingOrigin);
    if (!target) continue;
    var targetFingerprint = await fingerprint(target);
    var link = seen[targetFingerprint];
    if (!link) {
      var token = persist ? randomToken() : "preview" + String(index).padStart(41, "0");
      link = {
        id: "tracking-link|" + token,
        schema_version: 1,
        token: token,
        delivery_key: delivery.delivery_key,
        program_key: delivery.program_key,
        period_key: delivery.period_key,
        profile_id: delivery.profile_id,
        target_url: target,
        target_fingerprint: targetFingerprint,
        created_at: delivery.created_at
      };
      seen[targetFingerprint] = link;
      links.push(link);
    }
    html = html.replace(matches[index].full, "href=" + matches[index].quote + trackingOrigin + "/crm-track/c/" + link.token + matches[index].quote);
  }
  var pixelUrl = trackingOrigin + "/crm-track/o/" + delivery.open_token + ".gif";
  html += '<img src="' + pixelUrl + '" width="1" height="1" alt="" style="display:none!important;width:1px;height:1px;border:0" />';
  var text = bodyText;
  for (var linkIndex = 0; linkIndex < links.length; linkIndex++) {
    text = text.split(links[linkIndex].target_url).join(trackingOrigin + "/crm-track/c/" + links[linkIndex].token);
  }
  if (persist && links.length > 0) {
    await ctx.storage.trackingLinks.putMany(links.map(function(item) { return { id: item.id, data: item }; }));
  }
  return { html: html, text: text, links: links };
}

export async function sendTrackedEmail(
  ctx: CrmContext,
  input: JsonRecord,
  requestId: string,
  occurredAt: string,
  dryRun: boolean
): Promise<JsonRecord> {
  var programKey = typeof input.program_key === "string" ? input.program_key.trim() : "";
  var profileId = typeof input.profile_id === "string" ? input.profile_id.trim() : "";
  var periodKey = typeof input.period_key === "string" ? input.period_key.trim() : "";
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(programKey)) return apiError("INVALID_PROGRAM_KEY", "program_key is invalid");
  if (!profileId || profileId.length > 160) return apiError("INVALID_PROFILE_ID", "profile_id is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,95}$/.test(periodKey)) return apiError("INVALID_PERIOD_KEY", "period_key is invalid");
  var program = await ctx.storage.programs.get("program:" + programKey);
  var profile = await ctx.storage.profiles.get(profileId);
  var audienceError = await validateAudience(ctx, program, profile);
  if (audienceError) return audienceError;
  var template = await ctx.storage.messageTemplates.get("message-template:" + String(program?.template_key || ""));
  if (!template || template.is_active !== true) return apiError("TEMPLATE_NOT_ACTIVE", "Program template must be active");
  var configuredOrigin = await ctx.kv.get<string>("settings:trackingBaseUrl");
  var trackingOrigin = normalizeHttpsOrigin(configuredOrigin);
  if (!trackingOrigin) return apiError("TRACKING_BASE_URL_NOT_CONFIGURED", "Configure an HTTPS tracking base URL before preparing delivery");
  var deliveryKey = programKey + "|" + periodKey + "|" + profileId;
  var existing = await ctx.storage.emailDeliveries.get("delivery|" + deliveryKey);
  if (existing && existing.provider_status !== "failed") return apiSuccess({ delivery: existing, replayed: true });
  var recipientHash = await fingerprint(String(profile?.email || "").trim().toLowerCase());
  var delivery: EmailDelivery = {
    id: "delivery|" + deliveryKey,
    schema_version: 1,
    delivery_key: deliveryKey,
    program_key: programKey,
    period_key: periodKey,
    profile_id: profileId,
    template_key: template.key,
    provider: "cloudflare_email_service",
    provider_status: "prepared",
    recipient_hash: recipientHash,
    subject_fingerprint: await fingerprint(template.subject),
    open_token: dryRun ? "preview00000000000000000000000000000000000000000" : randomToken(),
    unique_opened_at: null,
    unique_clicked_at: null,
    open_observations: 0,
    click_observations: 0,
    provider_error_code: null,
    provider_error_message: null,
    provider_message_id: null,
    provider_reported_at: null,
    provider_match_confidence: null,
    sent_at: null,
    request_id: requestId,
    created_at: occurredAt,
    updated_at: occurredAt
  };
  var rendered = await renderTrackedMessage(ctx, delivery, template.body_html, template.body_text || "", trackingOrigin, !dryRun);
  if (dryRun) return apiSuccess({ delivery: delivery, preview: { subject: template.subject, html: rendered.html, text: rendered.text, tracked_links: rendered.links.length } });
  await ctx.storage.emailDeliveries.put(delivery.id, delivery);
  var accountId = await ctx.kv.get<string>("settings:cloudflareAccountId");
  var apiToken = await ctx.kv.get<string>("settings:cloudflareApiToken");
  var fromAddress = await ctx.kv.get<string>("settings:cloudflareFromAddress");
  if (!accountId || !apiToken || !fromAddress || !ctx.http) {
    delivery.provider_status = "failed";
    delivery.provider_error_code = "PROVIDER_NOT_CONFIGURED";
    delivery.provider_error_message = "Cloudflare Email Service credentials or network capability are missing";
    delivery.updated_at = new Date().toISOString();
    await ctx.storage.emailDeliveries.put(delivery.id, delivery);
    return apiError("PROVIDER_NOT_CONFIGURED", delivery.provider_error_message);
  }
  var response = await ctx.http.fetch("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(accountId) + "/email/sending/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      to: profile?.email,
      from: fromAddress,
      subject: template.subject,
      html: rendered.html,
      text: rendered.text,
      headers: {
        "X-CRM-Delivery-ID": delivery.delivery_key,
        "X-CRM-Program-ID": programKey,
        "List-Unsubscribe": "<" + trackingOrigin + "/crm-track/u/" + delivery.open_token + ">",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      }
    })
  });
  var providerBody: any = null;
  try { providerBody = await response.json(); } catch (_error) { providerBody = null; }
  if (!response.ok || !providerBody || providerBody.success !== true) {
    var firstError = providerBody && Array.isArray(providerBody.errors) ? providerBody.errors[0] : null;
    delivery.provider_status = "failed";
    delivery.provider_error_code = firstError ? String(firstError.code || "CLOUDFLARE_SEND_FAILED") : "CLOUDFLARE_SEND_FAILED";
    delivery.provider_error_message = firstError ? String(firstError.message || "Cloudflare rejected the email") : "Cloudflare rejected the email";
  } else if (providerBody.result && Array.isArray(providerBody.result.delivered) && providerBody.result.delivered.length > 0) {
    delivery.provider_status = "delivered";
    delivery.provider_match_confidence = "immediate";
  } else if (providerBody.result && Array.isArray(providerBody.result.permanent_bounces) && providerBody.result.permanent_bounces.length > 0) {
    delivery.provider_status = "permanent_bounce";
  } else {
    delivery.provider_status = "queued";
  }
  delivery.sent_at = occurredAt;
  delivery.updated_at = new Date().toISOString();
  await ctx.storage.emailDeliveries.put(delivery.id, delivery);
  if (delivery.provider_status === "failed") return apiError("CLOUDFLARE_SEND_FAILED", delivery.provider_error_message || "Cloudflare send failed", { code: delivery.provider_error_code });
  return apiSuccess({ delivery: delivery, tracked_links: rendered.links.length, provider_result: delivery.provider_status });
}

function cloudflareStatus(value: string): EmailDelivery["provider_status"] | null {
  if (value === "delivered" || value === "sent") return "delivered";
  if (value === "deliveryFailed" || value === "rejected") return "permanent_bounce";
  if (value === "queued") return "queued";
  if (value === "failed") return "failed";
  return null;
}

export async function syncCloudflareReport(ctx: CrmContext, input: JsonRecord): Promise<JsonRecord> {
  var programKey = typeof input.program_key === "string" ? input.program_key.trim() : "";
  var periodKey = typeof input.period_key === "string" ? input.period_key.trim() : "";
  if (!programKey || !periodKey) return apiError("INVALID_REPORT_SCOPE", "program_key and period_key are required");
  var deliveries = await ctx.storage.emailDeliveries.query({ where: { program_key: programKey, period_key: periodKey }, orderBy: { created_at: "desc" }, limit: 25 });
  if (deliveries.items.length === 0) return apiSuccess({ program_key: programKey, period_key: periodKey, matched: 0, ambiguous: 0, unmatched: 0, provider_events: 0 });
  var zoneId = await ctx.kv.get<string>("settings:cloudflareZoneId");
  var apiToken = await ctx.kv.get<string>("settings:cloudflareApiToken");
  if (!zoneId || !apiToken || !ctx.http) return apiError("PROVIDER_REPORT_NOT_CONFIGURED", "Cloudflare zone ID, API token, and network capability are required");
  var earliest = deliveries.items[deliveries.items.length - 1].data.sent_at || deliveries.items[deliveries.items.length - 1].data.created_at;
  var minimum = Date.now() - 31 * 24 * 60 * 60 * 1000;
  if (Date.parse(earliest) < minimum) earliest = new Date(minimum).toISOString();
  var query = "query CrmEmailEvents($zoneTag: string!, $start: Time!, $end: Time!) { viewer { zones(filter: { zoneTag: $zoneTag }) { emailSendingAdaptive(filter: { datetime_geq: $start, datetime_leq: $end }, limit: 500, orderBy: [datetime_DESC]) { datetime to subject status messageId errorCause errorDetail isLastEvent } } } }";
  var response = await ctx.http.fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query: query, variables: { zoneTag: zoneId, start: earliest, end: new Date().toISOString() } })
  });
  var body: any = null;
  try { body = await response.json(); } catch (_error) { body = null; }
  if (!response.ok || !body || (Array.isArray(body.errors) && body.errors.length > 0)) return apiError("CLOUDFLARE_REPORT_FAILED", "Cloudflare GraphQL report query failed");
  var zones = body.data && body.data.viewer && Array.isArray(body.data.viewer.zones) ? body.data.viewer.zones : [];
  var events = zones[0] && Array.isArray(zones[0].emailSendingAdaptive) ? zones[0].emailSendingAdaptive : [];
  var matched = 0;
  var ambiguous = 0;
  var unmatched = 0;
  for (var index = 0; index < deliveries.items.length; index++) {
    var delivery = deliveries.items[index].data;
    var profile = await ctx.storage.profiles.get(delivery.profile_id);
    var template = await ctx.storage.messageTemplates.get("message-template:" + delivery.template_key);
    if (!profile?.email || !template) { unmatched += 1; continue; }
    var expectedEmail = String(profile.email).toLowerCase();
    var expectedSubject = template.subject;
    var candidates = events.filter(function(event: any) {
      return String(event.to || "").toLowerCase() === expectedEmail &&
        String(event.subject || "") === expectedSubject &&
        Date.parse(String(event.datetime || "")) >= Date.parse(String(delivery.sent_at || delivery.created_at)) - 60000;
    });
    var finalCandidates = candidates.filter(function(event: any) { return Number(event.isLastEvent) === 1; });
    if (finalCandidates.length === 1) candidates = finalCandidates;
    if (candidates.length !== 1) {
      if (candidates.length > 1) ambiguous += 1;
      else unmatched += 1;
      continue;
    }
    var event = candidates[0];
    var mappedStatus = cloudflareStatus(String(event.status || ""));
    if (mappedStatus) delivery.provider_status = mappedStatus;
    delivery.provider_message_id = typeof event.messageId === "string" ? event.messageId : null;
    delivery.provider_error_code = typeof event.errorCause === "string" && event.errorCause ? event.errorCause : null;
    delivery.provider_error_message = typeof event.errorDetail === "string" && event.errorDetail ? event.errorDetail : null;
    delivery.provider_reported_at = typeof event.datetime === "string" ? event.datetime : new Date().toISOString();
    delivery.provider_match_confidence = "exact_recipient_subject_time";
    delivery.updated_at = new Date().toISOString();
    await ctx.storage.emailDeliveries.put(delivery.id, delivery);
    matched += 1;
  }
  return apiSuccess({
    program_key: programKey,
    period_key: periodKey,
    deliveries_loaded: deliveries.items.length,
    provider_events: events.length,
    matched: matched,
    ambiguous: ambiguous,
    unmatched: unmatched,
    truncated: deliveries.hasMore || events.length === 500,
    retention_days: 31,
    correlation: "exact_recipient_subject_time_fail_closed"
  });
}

async function recordEvent(
  ctx: CrmContext,
  delivery: EmailDelivery,
  token: string | null,
  eventType: "open_observed" | "click",
  headers: Record<string, string>
): Promise<void> {
  var occurredAt = new Date().toISOString();
  var agentClass = classifyUserAgent(header(headers, "user-agent"));
  var minute = occurredAt.slice(0, 16);
  var requestFingerprint = await fingerprint(delivery.delivery_key + "|" + eventType + "|" + String(token || "") + "|" + agentClass + "|" + minute);
  var event: TrackingEvent = {
    id: "tracking-event|" + requestFingerprint,
    schema_version: 1,
    event_type: eventType,
    delivery_key: delivery.delivery_key,
    program_key: delivery.program_key,
    period_key: delivery.period_key,
    profile_id: delivery.profile_id,
    token: token,
    occurred_at: occurredAt,
    request_fingerprint: requestFingerprint,
    user_agent_class: agentClass,
    metadata: { confidence: eventType === "click" && agentClass === "human_candidate" ? "high" : "observed_only" }
  };
  var isNewEvent = !(await ctx.storage.trackingEvents.exists(event.id));
  if (isNewEvent) await ctx.storage.trackingEvents.put(event.id, event);
  if (!isNewEvent) return;
  if (eventType === "open_observed") {
    delivery.open_observations += 1;
    if (!delivery.unique_opened_at) delivery.unique_opened_at = occurredAt;
  } else {
    delivery.click_observations += 1;
    if (agentClass === "human_candidate" && !delivery.unique_clicked_at) delivery.unique_clicked_at = occurredAt;
  }
  delivery.updated_at = occurredAt;
  await ctx.storage.emailDeliveries.put(delivery.id, delivery);
}

function tokenFromUrl(url: string): string {
  try { return new URL(url).searchParams.get("token") || ""; } catch (_error) { return ""; }
}

export async function observeOpen(ctx: CrmContext, requestUrl: string, headers: Record<string, string>): Promise<JsonRecord> {
  var token = tokenFromUrl(requestUrl);
  if (!TOKEN_PATTERN.test(token)) return apiError("TRACKING_NOT_FOUND", "Tracking token was not found");
  var result = await ctx.storage.emailDeliveries.query({ where: { open_token: token }, limit: 1 });
  if (result.items.length !== 1) return apiError("TRACKING_NOT_FOUND", "Tracking token was not found");
  await recordEvent(ctx, result.items[0].data, token, "open_observed", headers);
  return apiSuccess({ action: "pixel", cache_control: "no-store" });
}

export async function observeClick(ctx: CrmContext, requestUrl: string, headers: Record<string, string>): Promise<JsonRecord> {
  var token = tokenFromUrl(requestUrl);
  if (!TOKEN_PATTERN.test(token)) return apiError("TRACKING_NOT_FOUND", "Tracking token was not found");
  var links = await ctx.storage.trackingLinks.query({ where: { token: token }, limit: 1 });
  if (links.items.length !== 1) return apiError("TRACKING_NOT_FOUND", "Tracking token was not found");
  var link = links.items[0].data;
  var delivery = await ctx.storage.emailDeliveries.get("delivery|" + link.delivery_key);
  if (!delivery) return apiError("TRACKING_NOT_FOUND", "Delivery was not found");
  await recordEvent(ctx, delivery, token, "click", headers);
  return apiSuccess({ action: "redirect", location: link.target_url, cache_control: "no-store" });
}

export async function observeUnsubscribe(ctx: CrmContext, requestUrl: string, headers: Record<string, string>, commit: boolean): Promise<JsonRecord> {
  var token = tokenFromUrl(requestUrl);
  if (!TOKEN_PATTERN.test(token)) return apiError("TRACKING_NOT_FOUND", "Tracking token was not found");
  var result = await ctx.storage.emailDeliveries.query({ where: { open_token: token }, limit: 1 });
  if (result.items.length !== 1) return apiError("TRACKING_NOT_FOUND", "Tracking token was not found");
  var delivery = result.items[0].data;
  if (!commit) return apiSuccess({ action: "confirm_unsubscribe", cache_control: "no-store" });
  var occurredAt = new Date().toISOString();
  var suppressionId = "suppression|email|" + delivery.profile_id;
  await ctx.storage.suppressions.put(suppressionId, {
    id: suppressionId,
    schema_version: 1,
    profile_id: delivery.profile_id,
    channel: "email",
    scope: "global",
    reason: "one_click_unsubscribe",
    is_active: true,
    source_delivery_key: delivery.delivery_key,
    created_at: occurredAt,
    updated_at: occurredAt
  });
  var requestFingerprint = await fingerprint(delivery.delivery_key + "|unsubscribe");
  var event: TrackingEvent = {
    id: "tracking-event|" + requestFingerprint,
    schema_version: 1,
    event_type: "unsubscribe",
    delivery_key: delivery.delivery_key,
    program_key: delivery.program_key,
    period_key: delivery.period_key,
    profile_id: delivery.profile_id,
    token: token,
    occurred_at: occurredAt,
    request_fingerprint: requestFingerprint,
    user_agent_class: classifyUserAgent(header(headers, "user-agent")),
    metadata: { scope: "global", channel: "email" }
  };
  if (!(await ctx.storage.trackingEvents.exists(event.id))) await ctx.storage.trackingEvents.put(event.id, event);
  return apiSuccess({ action: "unsubscribed", cache_control: "no-store" });
}

export function validateProviderEvent(value: unknown): JsonRecord | null {
  if (!isJsonRecord(value)) return apiError("INVALID_PROVIDER_EVENT", "Provider event must be an object");
  if (typeof value.delivery_key !== "string" || typeof value.status !== "string") return apiError("INVALID_PROVIDER_EVENT", "delivery_key and status are required");
  return null;
}

export async function buildTrackingMetricFact(ctx: CrmContext, programKey: string, periodKey: string, dryRun: boolean): Promise<JsonRecord> {
  var deliveries = await ctx.storage.emailDeliveries.query({ where: { program_key: programKey, period_key: periodKey }, limit: 100 });
  if (deliveries.hasMore) return apiError("TRACKING_DELIVERY_LIMIT_EXCEEDED", "More than 100 deliveries require a paginated aggregation worker");
  var sent = 0;
  var delivered = 0;
  var uniqueClicks = 0;
  for (var index = 0; index < deliveries.items.length; index++) {
    var delivery = deliveries.items[index].data;
    if (delivery.provider_status !== "prepared" && delivery.provider_status !== "failed") sent += 1;
    if (delivery.provider_status === "delivered") delivered += 1;
    if (delivery.unique_clicked_at) uniqueClicks += 1;
  }
  var unsubscribeEvents = await ctx.storage.trackingEvents.query({ where: { program_key: programKey, period_key: periodKey, event_type: "unsubscribe" }, limit: 100 });
  if (unsubscribeEvents.hasMore) return apiError("TRACKING_EVENT_LIMIT_EXCEEDED", "More than 100 unsubscribe events require a paginated aggregation worker");
  var uniqueUnsubscribes: Record<string, boolean> = {};
  for (var eventIndex = 0; eventIndex < unsubscribeEvents.items.length; eventIndex++) uniqueUnsubscribes[unsubscribeEvents.items[eventIndex].data.profile_id] = true;
  var sequenceKey = "state:trackingFactSequence:" + programKey + ":" + periodKey;
  var currentSequence = (await ctx.kv.get<number>(sequenceKey)) || 0;
  var sequence = currentSequence + 1;
  if (!dryRun) await ctx.kv.set(sequenceKey, sequence);
  var factId = await fingerprint("tracking-fact|" + programKey + "|" + periodKey);
  return apiSuccess({
    sequence_key: sequenceKey,
    fact: {
      source_fact_id: factId,
      sequence: sequence,
      period_key: periodKey,
      sent: sent,
      delivered: delivered,
      unique_clicks: uniqueClicks,
      conversions: 0,
      complaints: 0,
      unsubscribes: Object.keys(uniqueUnsubscribes).length
    },
    observations: {
      deliveries: deliveries.items.length,
      opens_observed: deliveries.items.filter(function(item) { return item.data.unique_opened_at !== null; }).length,
      opens_used_for_scoring: false,
      clicks_used_for_scoring: true,
      provider_delivery_used_for_scoring: true
    }
  });
}
