import type { Block, BlockInteraction, BlockResponse, TableBlock } from "@emdash-cms/blocks/server";
import type { CrmContext, CrmEvent, CrmSegment, JsonRecord } from "../types.js";
import { eventId, requestPayloadFingerprint } from "../domain/membership.js";
import {
  READ_PAGE_LIMIT,
  STATIC_MEMBERSHIP_BATCH_LIMIT,
  USER_MIGRATION_PAGE_LIMIT
} from "../domain/limits.js";
import { isJsonRecord } from "../application/contracts.js";
import {
  addProfilesToStaticSegment,
  normalizeProfileIds,
  removeProfilesFromStaticSegment,
  resolveProfiles,
  resolveStaticSegment,
  upsertSegment
} from "../application/feed-static-segment.js";
import { recomputeSegmentStep } from "../application/recompute-segment.js";
import {
  evaluateGrowthProgramPeriod,
  ingestMetricFactsBatch,
  upsertGrowthProgram,
  upsertMessageTemplate
} from "../application/manage-growth-scoring.js";
import { getMigrationState, syncEmDashUsersStep } from "../application/sync-emdash-users.js";
import { ensureDefaults } from "../infrastructure/repositories.js";
import { serializeMutation } from "../infrastructure/mutation-queue.js";

function toast(message: string, type: "success" | "error" | "info", blocks: Block[]): BlockResponse {
  return { blocks: blocks, toast: { message: message, type: type } };
}

function resultErrorMessage(result: JsonRecord): string {
  if (result.ok === true) return "";
  if (isJsonRecord(result.error) && typeof result.error.message === "string") return result.error.message;
  return "Operation failed";
}

async function buildDashboard(ctx: CrmContext): Promise<BlockResponse> {
  var profileCount = await ctx.storage.profiles.count();
  var segmentCount = await ctx.storage.segments.count();
  var staticMemberCount = await ctx.storage.segmentMembershipStates.count({ status: "open" });
  var eventCount = await ctx.storage.events.count();
  var programCount = await ctx.storage.programs.count();
  var templateCount = await ctx.storage.messageTemplates.count();
  var latestScorePage = await ctx.storage.scoreRuns.query({
    limit: 1,
    orderBy: { created_at: "desc" }
  });
  var latestScore = latestScorePage.items.length > 0 ? latestScorePage.items[0].data : null;
  var migration = await getMigrationState(ctx);
  var blocks: Block[] = [
    { type: "header", text: "CRM Growth Studio" },
    {
      type: "banner",
      title: "Delivery is disabled in V1",
      description: "This release projects users, ingests traits, and materializes audiences. It does not send campaign messages.",
      variant: "default"
    },
    {
      type: "stats",
      items: [
        { label: "Profiles", value: profileCount },
        { label: "Segments", value: segmentCount },
        { label: "Programs", value: programCount },
        { label: "Templates", value: templateCount },
        { label: "Static open members", value: staticMemberCount },
        { label: "Audit events", value: eventCount }
      ]
    },
    { type: "divider" },
    {
      type: "fields",
      fields: [
        { label: "Migration", value: migration.status },
        { label: "Processed", value: String(migration.processed) },
        { label: "Consent default", value: "unknown (fail-closed)" },
        { label: "Latest program score", value: latestScore && latestScore.overall_score !== null ? String(latestScore.overall_score) : "not scored" },
        { label: "Score status", value: latestScore ? latestScore.status : "—" },
        { label: "API auth", value: "EmDash admin session or PAT admin scope" },
        { label: "Writer model", value: "one sequenced writer per mutation stream" }
      ]
    },
    {
      type: "actions",
      elements: [
        { type: "button", label: "Sync next user page", action_id: "migration_step", style: "primary" },
        { type: "button", label: "Refresh", action_id: "refresh_dashboard", style: "secondary" }
      ]
    }
  ];
  return { blocks: blocks };
}

async function buildProfiles(ctx: CrmContext, cursor?: string): Promise<BlockResponse> {
  var result = await ctx.storage.profiles.query({ limit: READ_PAGE_LIMIT, cursor: cursor });
  var rows: Array<Record<string, unknown>> = [];
  for (var index = 0; index < result.items.length; index++) {
    var profile = result.items[index].data;
    rows.push({
      id: profile.id,
      name: profile.name || "—",
      email: profile.email || "—",
      source: profile.source,
      consent: profile.marketing_consent,
      eligible: profile.traits.eligible_for_messaging ? "yes" : "no",
      updated_at: profile.updated_at
    });
  }
  var table: TableBlock = {
    type: "table",
    block_id: "profiles_table",
    columns: [
      { key: "name", label: "Name", format: "text" },
      { key: "email", label: "Email", format: "text" },
      { key: "source", label: "Source", format: "badge" },
      { key: "consent", label: "Consent", format: "badge" },
      { key: "eligible", label: "Eligible", format: "badge" },
      { key: "updated_at", label: "Updated", format: "relative_time" }
    ],
    rows: rows,
    page_action_id: "profiles_page",
    empty_text: "No CRM profiles yet. Run the EmDash user migration or use the profile ingest API."
  };
  if (result.cursor) table.next_cursor = result.cursor;
  return { blocks: [{ type: "header", text: "CRM Profiles" }, table] };
}

function segmentCreateForm(): Block {
  return {
    type: "form",
    block_id: "segment_create_form",
    fields: [
      { type: "text_input", action_id: "key", label: "Stable key", placeholder: "churned_users" },
      { type: "text_input", action_id: "name", label: "Name", placeholder: "Churned users" },
      { type: "text_input", action_id: "description", label: "Description", multiline: true },
      {
        type: "select",
        action_id: "kind",
        label: "Kind",
        options: [
          { label: "Static", value: "static" },
          { label: "Dynamic", value: "dynamic" }
        ],
        initial_value: "static"
      },
      {
        type: "text_input",
        action_id: "rule_json",
        label: "Dynamic rule JSON",
        multiline: true,
        placeholder: "{\"trait\":\"marketing_consent\",\"operator\":\"eq\",\"value\":\"granted\"}"
      },
      { type: "number_input", action_id: "membership_limit", label: "Dynamic membership limit", min: 1, max: 1000 },
      { type: "text_input", action_id: "group_key", label: "Optional group key", placeholder: "crm_contact_safety" }
    ],
    submit: { label: "Save segment", action_id: "save_segment" }
  };
}

function membershipForm(): Block {
  return {
    type: "form",
    block_id: "static_membership_form",
    fields: [
      { type: "text_input", action_id: "segment_key", label: "Static segment key", placeholder: "crm_blacklist" },
      {
        type: "text_input",
        action_id: "profile_ids",
        label: "Profile IDs (comma or newline separated, max " + STATIC_MEMBERSHIP_BATCH_LIMIT + ")",
        multiline: true,
        placeholder: "emdash:01ABC"
      },
      {
        type: "select",
        action_id: "member_action",
        label: "Action",
        options: [
          { label: "Add", value: "add" },
          { label: "Remove", value: "remove" }
        ],
        initial_value: "add"
      }
    ],
    submit: { label: "Apply membership change", action_id: "manage_static_members" }
  };
}

async function buildSegments(ctx: CrmContext): Promise<BlockResponse> {
  var result = await ctx.storage.segments.query({ limit: 50 });
  var blocks: Block[] = [
    { type: "header", text: "Segments" },
    {
      type: "banner",
      title: "Static and dynamic audiences use different write paths",
      description: "Direct member add/remove is restricted to static segments. Dynamic segments only change through rule recompute.",
      variant: "default"
    }
  ];
  if (result.items.length === 0) {
    blocks.push({ type: "empty", title: "No segments", description: "Bootstrap defaults or create a segment below." });
  }
  for (var index = 0; index < result.items.length; index++) {
    var segment = result.items[index].data;
    var text = "**" + segment.name + "** (" + segment.key + ")\n" +
      segment.kind + " · " + (segment.is_active ? "active" : "inactive") +
      (segment.membership_limit ? " · limit " + segment.membership_limit : "") +
      (segment.group_key ? " · group " + segment.group_key : "");
    if (segment.kind === "dynamic") {
      blocks.push({
        type: "section",
        text: text,
        accessory: { type: "button", label: "Recompute step", action_id: "recompute_segment", value: segment.key }
      });
    } else {
      blocks.push({ type: "section", text: text });
    }
  }
  blocks.push({ type: "divider" });
  blocks.push(segmentCreateForm());
  blocks.push({ type: "divider" });
  blocks.push(membershipForm());
  return { blocks: blocks };
}

function templateCreateForm(): Block {
  return {
    type: "form",
    block_id: "template_create_form",
    fields: [
      { type: "text_input", action_id: "key", label: "Stable key", placeholder: "winback_email_v1" },
      { type: "text_input", action_id: "name", label: "Name", placeholder: "Win-back email V1" },
      { type: "text_input", action_id: "subject", label: "Subject", placeholder: "A personal update for {{first_name}}" },
      { type: "text_input", action_id: "body_html", label: "HTML or plain body", multiline: true },
      { type: "text_input", action_id: "body_text", label: "Plain-text fallback", multiline: true },
      { type: "text_input", action_id: "cta_label", label: "CTA label", placeholder: "Review my update" },
      { type: "text_input", action_id: "cta_url", label: "CTA HTTPS URL", placeholder: "https://example.com/account" },
      { type: "text_input", action_id: "sender_profile_key", label: "Sender profile key (reserved)", placeholder: "default_sender" },
      {
        type: "select",
        action_id: "is_active",
        label: "Configuration state",
        options: [
          { label: "Draft", value: "false" },
          { label: "Active configuration", value: "true" }
        ],
        initial_value: "false"
      }
    ],
    submit: { label: "Save and score template", action_id: "save_template" }
  };
}

async function buildTemplates(ctx: CrmContext, cursor?: string): Promise<BlockResponse> {
  var result = await ctx.storage.messageTemplates.query({
    limit: READ_PAGE_LIMIT,
    cursor: cursor,
    orderBy: { updated_at: "desc" }
  });
  var rows: Array<Record<string, unknown>> = [];
  for (var index = 0; index < result.items.length; index++) {
    var template = result.items[index].data;
    rows.push({
      name: template.name,
      key: template.key,
      channel: template.channel,
      quality_score: String(template.quality_score),
      quality_grade: template.quality_grade,
      state: template.is_active ? "active" : "draft",
      updated_at: template.updated_at
    });
  }
  var table: TableBlock = {
    type: "table",
    block_id: "templates_table",
    columns: [
      { key: "name", label: "Template", format: "text" },
      { key: "key", label: "Stable key", format: "code" },
      { key: "channel", label: "Channel", format: "badge" },
      { key: "quality_score", label: "Quality", format: "text" },
      { key: "quality_grade", label: "Grade", format: "badge" },
      { key: "state", label: "State", format: "badge" },
      { key: "updated_at", label: "Updated", format: "relative_time" }
    ],
    rows: rows,
    page_action_id: "templates_page",
    empty_text: "No message templates yet. Save a draft below to receive a deterministic quality score."
  };
  if (result.cursor) table.next_cursor = result.cursor;
  return {
    blocks: [
      { type: "header", text: "Message Templates" },
      {
        type: "banner",
        title: "Quality scoring does not enable delivery",
        description: "Template bodies are stored as configuration and never rendered as raw admin HTML. Active content and manual unsubscribe markup are blocked by the scorer.",
        variant: "default"
      },
      table,
      { type: "divider" },
      templateCreateForm()
    ]
  };
}

function programCreateForm(): Block {
  return {
    type: "form",
    block_id: "program_create_form",
    fields: [
      { type: "text_input", action_id: "key", label: "Stable key", placeholder: "premium_reactivation" },
      { type: "text_input", action_id: "name", label: "Name", placeholder: "Premium reactivation" },
      { type: "text_input", action_id: "description", label: "Description", multiline: true },
      {
        type: "select",
        action_id: "offer_type",
        label: "Program type",
        options: [
          { label: "Lifecycle", value: "lifecycle" },
          { label: "Informational", value: "informational" },
          { label: "Discount", value: "discount" },
          { label: "Acquisition", value: "acquisition" }
        ],
        initial_value: "lifecycle"
      },
      { type: "text_input", action_id: "audience_segment_key", label: "Audience segment key", placeholder: "churned_users" },
      { type: "text_input", action_id: "template_key", label: "Template key", placeholder: "winback_email_v1" },
      {
        type: "select",
        action_id: "require_marketing_consent",
        label: "Require marketing consent",
        options: [
          { label: "Required", value: "true" },
          { label: "Not proven", value: "false" }
        ],
        initial_value: "true"
      },
      {
        type: "select",
        action_id: "exclude_contact_safety",
        label: "Exclude crm_contact_safety",
        options: [
          { label: "Excluded", value: "true" },
          { label: "Not excluded", value: "false" }
        ],
        initial_value: "true"
      },
      {
        type: "select",
        action_id: "exclude_crm_blacklist",
        label: "Exclude crm_blacklist",
        options: [
          { label: "Excluded", value: "true" },
          { label: "Not excluded", value: "false" }
        ],
        initial_value: "true"
      },
      {
        type: "select",
        action_id: "exclude_paid_tv_users",
        label: "Exclude paid_tv_users",
        options: [
          { label: "Excluded", value: "true" },
          { label: "Not excluded", value: "false" }
        ],
        initial_value: "false"
      },
      { type: "text_input", action_id: "primary_metric", label: "Primary metric", placeholder: "premium_reactivation" },
      { type: "text_input", action_id: "conversion_event", label: "Conversion event", placeholder: "subscription_reactivated" },
      { type: "number_input", action_id: "attribution_window_days", label: "Attribution window (days)", min: 1, max: 365 },
      { type: "number_input", action_id: "minimum_sample_size", label: "Minimum delivered sample", min: 1, max: 1000000 },
      { type: "number_input", action_id: "control_group_percentage", label: "Control group percentage", min: 1, max: 99 },
      {
        type: "select",
        action_id: "is_active",
        label: "Configuration state",
        options: [
          { label: "Draft", value: "false" },
          { label: "Active configuration", value: "true" }
        ],
        initial_value: "false"
      }
    ],
    submit: { label: "Save and score program", action_id: "save_program" }
  };
}

async function buildPrograms(ctx: CrmContext, cursor?: string): Promise<BlockResponse> {
  var result = await ctx.storage.programs.query({
    limit: READ_PAGE_LIMIT,
    cursor: cursor,
    orderBy: { updated_at: "desc" }
  });
  var rows: Array<Record<string, unknown>> = [];
  for (var index = 0; index < result.items.length; index++) {
    var program = result.items[index].data;
    rows.push({
      name: program.name,
      key: program.key,
      offer_type: program.offer_type,
      audience: program.audience_segment_key,
      template: program.template_key,
      readiness_score: String(program.readiness_score),
      readiness_grade: program.readiness_grade,
      state: program.is_active ? "active" : "draft",
      updated_at: program.updated_at
    });
  }
  var table: TableBlock = {
    type: "table",
    block_id: "programs_table",
    columns: [
      { key: "name", label: "Program", format: "text" },
      { key: "key", label: "Stable key", format: "code" },
      { key: "offer_type", label: "Type", format: "badge" },
      { key: "audience", label: "Audience", format: "code" },
      { key: "template", label: "Template", format: "code" },
      { key: "readiness_score", label: "Readiness", format: "text" },
      { key: "readiness_grade", label: "Grade", format: "badge" },
      { key: "state", label: "State", format: "badge" },
      { key: "updated_at", label: "Updated", format: "relative_time" }
    ],
    rows: rows,
    page_action_id: "programs_page",
    empty_text: "No growth programs yet. Programs remain non-delivering configuration in V1."
  };
  if (result.cursor) table.next_cursor = result.cursor;
  return {
    blocks: [
      { type: "header", text: "Growth Programs" },
      {
        type: "banner",
        title: "Readiness is fail-closed",
        description: "A program cannot earn an activation-ready grade unless its segment, template, consent gate, crm_contact_safety exclusion, and measurement plan are verified.",
        variant: "default"
      },
      table,
      { type: "divider" },
      programCreateForm()
    ]
  };
}

function metricFactForm(): Block {
  return {
    type: "form",
    block_id: "metric_fact_form",
    fields: [
      { type: "text_input", action_id: "program_key", label: "Program key", placeholder: "premium_reactivation" },
      { type: "text_input", action_id: "period_key", label: "Period key", placeholder: "2026-07-week-2" },
      { type: "text_input", action_id: "source_fact_id", label: "Opaque source fact ID", placeholder: "018f47a2-7c31-7a6d-8f22-5f1d32f9a4c0" },
      { type: "number_input", action_id: "sequence", label: "Correction sequence", min: 1, max: 1000000 },
      { type: "number_input", action_id: "sent", label: "Sent", min: 0 },
      { type: "number_input", action_id: "delivered", label: "Delivered", min: 0 },
      { type: "number_input", action_id: "unique_clicks", label: "Unique clicks", min: 0 },
      { type: "number_input", action_id: "conversions", label: "Conversions", min: 0 },
      { type: "number_input", action_id: "complaints", label: "Complaints", min: 0 },
      { type: "number_input", action_id: "unsubscribes", label: "Unsubscribes", min: 0 }
    ],
    submit: { label: "Ingest aggregate fact", action_id: "ingest_metric_fact" }
  };
}

function evaluateProgramForm(): Block {
  return {
    type: "form",
    block_id: "evaluate_program_form",
    fields: [
      { type: "text_input", action_id: "program_key", label: "Program key", placeholder: "premium_reactivation" },
      { type: "text_input", action_id: "period_key", label: "Period key", placeholder: "2026-07-week-2" }
    ],
    submit: { label: "Evaluate immutable score run", action_id: "evaluate_program" }
  };
}

async function buildMeasurement(ctx: CrmContext, scoreCursor?: string): Promise<BlockResponse> {
  var scorePage = await ctx.storage.scoreRuns.query({
    limit: READ_PAGE_LIMIT,
    cursor: scoreCursor,
    orderBy: { created_at: "desc" }
  });
  var scoreRows: Array<Record<string, unknown>> = [];
  for (var scoreIndex = 0; scoreIndex < scorePage.items.length; scoreIndex++) {
    var scoreRun = scorePage.items[scoreIndex].data;
    scoreRows.push({
      program_key: scoreRun.program_key,
      period_key: scoreRun.period_key,
      status: scoreRun.status,
      overall_score: scoreRun.overall_score === null ? "—" : String(scoreRun.overall_score),
      readiness_score: String(scoreRun.readiness_score),
      performance_score: scoreRun.performance_score === null ? "—" : String(scoreRun.performance_score),
      created_at: scoreRun.created_at
    });
  }
  var scoreTable: TableBlock = {
    type: "table",
    block_id: "score_runs_table",
    columns: [
      { key: "program_key", label: "Program", format: "code" },
      { key: "period_key", label: "Period", format: "code" },
      { key: "status", label: "Status", format: "badge" },
      { key: "overall_score", label: "Overall", format: "text" },
      { key: "readiness_score", label: "Readiness", format: "text" },
      { key: "performance_score", label: "Performance", format: "text" },
      { key: "created_at", label: "Evaluated", format: "relative_time" }
    ],
    rows: scoreRows,
    page_action_id: "score_runs_page",
    empty_text: "No score runs yet. Ingest aggregate facts and evaluate a program period."
  };
  if (scorePage.cursor) scoreTable.next_cursor = scorePage.cursor;
  return {
    blocks: [
      { type: "header", text: "Measurement and Scoring" },
      {
        type: "banner",
        title: "Aggregate facts only",
        description: "Metric facts contain no profile IDs, names, emails, arbitrary dimensions, or provider message IDs. Corrections append a higher sequence; historical facts and score runs remain immutable.",
        variant: "default"
      },
      scoreTable,
      { type: "divider" },
      evaluateProgramForm(),
      { type: "divider" },
      metricFactForm()
    ]
  };
}

async function buildEvents(ctx: CrmContext): Promise<BlockResponse> {
  var result = await ctx.storage.events.query({
    limit: READ_PAGE_LIMIT,
    orderBy: { occurred_at: "desc" }
  });
  var rows: Array<Record<string, unknown>> = [];
  for (var index = 0; index < result.items.length; index++) {
    var event = result.items[index].data;
    rows.push({
      type: event.type,
      profile_id: event.profile_id || "—",
      segment_key: event.segment_key || "—",
      request_id: event.request_id,
      occurred_at: event.occurred_at
    });
  }
  var table: TableBlock = {
    type: "table",
    block_id: "events_table",
    columns: [
      { key: "type", label: "Type", format: "badge" },
      { key: "profile_id", label: "Profile", format: "code" },
      { key: "segment_key", label: "Segment", format: "code" },
      { key: "request_id", label: "Request", format: "code" },
      { key: "occurred_at", label: "When", format: "relative_time" }
    ],
    rows: rows,
    page_action_id: "events_page",
    empty_text: "No audit events yet."
  };
  return { blocks: [{ type: "header", text: "CRM Audit Events" }, table] };
}

async function buildMigration(ctx: CrmContext): Promise<BlockResponse> {
  var state = await getMigrationState(ctx);
  var blocks: Block[] = [
    { type: "header", text: "EmDash User Migration" },
    {
      type: "banner",
      title: "Projection only — auth users remain untouched",
      description: "Each step reads at most " + USER_MIGRATION_PAGE_LIMIT + " EmDash users and upserts deterministic CRM profiles. Consent, reachability, and email health default to unknown.",
      variant: "default"
    },
    {
      type: "fields",
      fields: [
        { label: "Status", value: state.status },
        { label: "Epoch", value: state.epoch || "—" },
        { label: "Processed", value: String(state.processed) },
        { label: "Created", value: String(state.created) },
        { label: "Updated", value: String(state.updated) },
        { label: "Unchanged", value: String(state.unchanged) },
        { label: "Completed", value: state.completed_at || "—" }
      ]
    },
    {
      type: "actions",
      elements: [
        { type: "button", label: "Sync next page", action_id: "migration_step", style: "primary" },
        {
          type: "button",
          label: "Start full reconciliation",
          action_id: "migration_restart",
          style: "danger",
          confirm: {
            title: "Start a new reconciliation epoch?",
            text: "Existing CRM-owned traits are preserved. The scan restarts from the first EmDash user.",
            confirm: "Start",
            deny: "Cancel",
            style: "danger"
          }
        }
      ]
    }
  ];
  return { blocks: blocks };
}

function buildSettings(): BlockResponse {
  var apiExample = "curl -X POST https://your-site/_emdash/api/plugins/crm-studio/v1/segments/members/add \\\n" +
    "  -H \"Authorization: Bearer $EMDASH_ADMIN_TOKEN\" \\\n" +
    "  -H \"Content-Type: application/json\" \\\n" +
    "  -d '{\"schema_version\":1,\"request_id\":\"feed-20260710-001\",\"source\":\"product_api\",\"occurred_at\":\"2026-07-10T12:00:00Z\",\"segment_key\":\"crm_blacklist\",\"emdash_user_ids\":[\"USER_ULID\"]}'";
  return {
    blocks: [
      { type: "header", text: "CRM API Integration" },
      {
        type: "banner",
        title: "All V1 routes are private",
        description: "Use an EmDash admin session or PAT with admin scope. No CRM write route is exposed with public:true.",
        variant: "default"
      },
      {
        type: "banner",
        title: "Single sequenced writer required",
        description: "EmDash plugin storage has no cross-isolate compare-and-swap. Serialize request IDs and each identity, segment, template, program, and metric fact stream at the integration boundary.",
        variant: "alert"
      },
      {
        type: "fields",
        fields: [
          { label: "Profile batch", value: "POST v1/profiles/upsert-batch" },
          { label: "Static add", value: "POST v1/segments/members/add" },
          { label: "Static remove", value: "POST v1/segments/members/remove" },
          { label: "Dynamic recompute", value: "POST v1/segments/recompute-step" },
          { label: "User migration", value: "POST v1/migrations/emdash-users/step" },
          { label: "Template upsert", value: "POST v1/templates/upsert" },
          { label: "Program upsert", value: "POST v1/programs/upsert" },
          { label: "Metric facts", value: "POST v1/metrics/ingest-batch" },
          { label: "Score evaluation", value: "POST v1/programs/evaluate" },
          { label: "Delivery mode", value: "disabled" }
        ]
      },
      { type: "code", code: apiExample, language: "bash" }
    ]
  };
}

async function recordAdminSegmentEvent(ctx: CrmContext, segment: CrmSegment, requestId: string, timestamp: string): Promise<void> {
  var id = eventId("segment_upserted", requestId, segment.key);
  var event: CrmEvent = {
    id: id,
    type: "segment_upserted",
    profile_id: null,
    segment_key: segment.key,
    request_id: requestId,
    occurred_at: timestamp,
    metadata: { kind: segment.kind, source: "admin" }
  };
  await ctx.storage.events.put(id, event);
}

async function handleSegmentForm(ctx: CrmContext, values: Record<string, unknown>): Promise<BlockResponse> {
  var segmentInput: JsonRecord = {
    key: values.key,
    name: values.name,
    description: values.description,
    kind: values.kind,
    group_key: values.group_key,
    membership_limit: values.membership_limit
  };
  if (values.kind === "dynamic") {
    try {
      segmentInput.rule = JSON.parse(typeof values.rule_json === "string" ? values.rule_json : "");
    } catch (_error) {
      return toast("Dynamic rule JSON is invalid", "error", (await buildSegments(ctx)).blocks);
    }
  }
  var timestamp = new Date().toISOString();
  var result = await upsertSegment(ctx, segmentInput, timestamp, false);
  if (!result.ok || !result.value) {
    return toast(result.message || "Segment validation failed", "error", (await buildSegments(ctx)).blocks);
  }
  var requestId = "admin-segment-" + Date.now();
  await recordAdminSegmentEvent(ctx, result.value, requestId, timestamp);
  return toast("Segment saved", "success", (await buildSegments(ctx)).blocks);
}

async function handleStaticMembershipForm(ctx: CrmContext, values: Record<string, unknown>): Promise<BlockResponse> {
  var rawIds = typeof values.profile_ids === "string" ? values.profile_ids : "";
  var splitIds = rawIds.split(/[\s,]+/).filter(function(value) { return value.length > 0; });
  var segmentResult = await resolveStaticSegment(ctx, values.segment_key);
  if (!segmentResult.ok || !segmentResult.value) {
    return toast(segmentResult.message || "Static segment not found", "error", (await buildSegments(ctx)).blocks);
  }
  var idsResult = normalizeProfileIds({ profile_ids: splitIds });
  if (!idsResult.ok || !idsResult.value) {
    return toast(idsResult.message || "Invalid profile IDs", "error", (await buildSegments(ctx)).blocks);
  }
  var profilesResult = await resolveProfiles(ctx, idsResult.value);
  if (!profilesResult.ok || !profilesResult.value) {
    return toast(profilesResult.message || "Profiles not found", "error", (await buildSegments(ctx)).blocks);
  }
  var timestamp = new Date().toISOString();
  var requestId = "admin-membership-" + Date.now();
  var membershipResult = values.member_action === "remove"
    ? await removeProfilesFromStaticSegment(
        ctx,
        segmentResult.value,
        profilesResult.value,
        requestId,
        timestamp,
        false,
        "admin"
      )
    : await addProfilesToStaticSegment(
        ctx,
        segmentResult.value,
        profilesResult.value,
        requestId,
        timestamp,
        false,
        "admin"
      );
  if (!membershipResult.ok) {
    return toast(membershipResult.message || "Membership update failed", "error", (await buildSegments(ctx)).blocks);
  }
  return toast("Static membership updated", "success", (await buildSegments(ctx)).blocks);
}

function adminBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function adminOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  var parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function handleTemplateForm(ctx: CrmContext, values: Record<string, unknown>): Promise<BlockResponse> {
  var input: JsonRecord = {
    template: {
      key: values.key,
      name: values.name,
      channel: "email",
      subject: values.subject,
      body_html: values.body_html,
      body_text: values.body_text,
      cta_label: values.cta_label,
      cta_url: values.cta_url,
      sender_profile_key: values.sender_profile_key,
      is_active: adminBoolean(values.is_active)
    }
  };
  var timestamp = new Date().toISOString();
  var requestId = "admin-template-" + Date.now();
  var fingerprint = await requestPayloadFingerprint("admin/template", input);
  var result = await upsertMessageTemplate(ctx, input, requestId, timestamp, false, "admin", fingerprint);
  var blocks = (await buildTemplates(ctx)).blocks;
  var error = resultErrorMessage(result);
  return error ? toast(error, "error", blocks) : toast("Template saved and scored", "success", blocks);
}

async function handleProgramForm(ctx: CrmContext, values: Record<string, unknown>): Promise<BlockResponse> {
  var measurement: JsonRecord = {
    primary_metric: values.primary_metric,
    conversion_event: values.conversion_event
  };
  var attributionWindow = adminOptionalNumber(values.attribution_window_days);
  var minimumSample = adminOptionalNumber(values.minimum_sample_size);
  var controlPercent = adminOptionalNumber(values.control_group_percentage);
  if (attributionWindow !== null) measurement.attribution_window_days = attributionWindow;
  if (minimumSample !== null) measurement.minimum_sample_size = minimumSample;
  if (controlPercent !== null) measurement.control_group_percentage = controlPercent;
  var input: JsonRecord = {
    program: {
      key: values.key,
      name: values.name,
      description: values.description,
      offer_type: values.offer_type,
      audience_segment_key: values.audience_segment_key,
      template_key: values.template_key,
      safety: {
        require_marketing_consent: adminBoolean(values.require_marketing_consent),
        exclude_crm_contact_safety: adminBoolean(values.exclude_contact_safety),
        exclude_crm_blacklist: adminBoolean(values.exclude_crm_blacklist),
        exclude_paid_tv_users: adminBoolean(values.exclude_paid_tv_users)
      },
      measurement: measurement,
      is_active: adminBoolean(values.is_active)
    }
  };
  var timestamp = new Date().toISOString();
  var requestId = "admin-program-" + Date.now();
  var fingerprint = await requestPayloadFingerprint("admin/program", input);
  var result = await upsertGrowthProgram(ctx, input, requestId, timestamp, false, "admin", fingerprint);
  var blocks = (await buildPrograms(ctx)).blocks;
  var error = resultErrorMessage(result);
  return error ? toast(error, "error", blocks) : toast("Program saved and readiness scored", "success", blocks);
}

async function handleMetricFactForm(ctx: CrmContext, values: Record<string, unknown>): Promise<BlockResponse> {
  var input: JsonRecord = {
    program_key: values.program_key,
    facts: [{
      source_fact_id: values.source_fact_id,
      period_key: values.period_key,
      sequence: Number(values.sequence),
      sent: Number(values.sent),
      delivered: Number(values.delivered),
      unique_clicks: Number(values.unique_clicks),
      conversions: Number(values.conversions),
      complaints: Number(values.complaints),
      unsubscribes: Number(values.unsubscribes)
    }]
  };
  var timestamp = new Date().toISOString();
  var requestId = "admin-metric-" + Date.now();
  var fingerprint = await requestPayloadFingerprint("admin/metric", input);
  var result = await ingestMetricFactsBatch(ctx, input, requestId, timestamp, false, "admin", fingerprint);
  var blocks = (await buildMeasurement(ctx)).blocks;
  var error = resultErrorMessage(result);
  return error ? toast(error, "error", blocks) : toast("Aggregate metric fact stored", "success", blocks);
}

async function handleEvaluateProgramForm(ctx: CrmContext, values: Record<string, unknown>): Promise<BlockResponse> {
  var input: JsonRecord = {
    program_key: values.program_key,
    period_key: values.period_key
  };
  var timestamp = new Date().toISOString();
  var requestId = "admin-score-" + Date.now();
  var fingerprint = await requestPayloadFingerprint("admin/score", input);
  var result = await evaluateGrowthProgramPeriod(ctx, input, requestId, timestamp, false, "admin", fingerprint);
  var blocks = (await buildMeasurement(ctx)).blocks;
  var error = resultErrorMessage(result);
  return error ? toast(error, "error", blocks) : toast("Program score evaluated", "success", blocks);
}

function interactionCursor(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isJsonRecord(value) && typeof value.cursor === "string") return value.cursor;
  return undefined;
}

export async function handleAdmin(input: unknown, ctx: CrmContext): Promise<BlockResponse> {
  await serializeMutation(async function() {
    await ensureDefaults(ctx);
    return true;
  });
  if (!isJsonRecord(input) || typeof input.type !== "string") return { blocks: [] };
  var interaction = input as unknown as BlockInteraction;
  if (interaction.type === "page_load") {
    if (interaction.page === "/profiles") return await buildProfiles(ctx);
    if (interaction.page === "/segments") return await buildSegments(ctx);
    if (interaction.page === "/programs") return await buildPrograms(ctx);
    if (interaction.page === "/templates") return await buildTemplates(ctx);
    if (interaction.page === "/measurement") return await buildMeasurement(ctx);
    if (interaction.page === "/events") return await buildEvents(ctx);
    if (interaction.page === "/migration") return await buildMigration(ctx);
    if (interaction.page === "/settings") return buildSettings();
    return await buildDashboard(ctx);
  }

  if (interaction.type === "block_action") {
    if (interaction.action_id === "refresh_dashboard") return await buildDashboard(ctx);
    if (interaction.action_id === "migration_step" || interaction.action_id === "migration_restart") {
      var timestamp = new Date().toISOString();
      var migrationInput: JsonRecord = {
        limit: USER_MIGRATION_PAGE_LIMIT,
        restart: interaction.action_id === "migration_restart"
      };
      var migrationRequestId = "admin-migration-" + Date.now();
      var migrationFingerprint = await requestPayloadFingerprint("admin/migration", migrationInput);
      var result = await serializeMutation(async function() {
        return await syncEmDashUsersStep(
          ctx,
          migrationInput,
          migrationRequestId,
          timestamp,
          false,
          "admin",
          migrationFingerprint,
          false
        );
      });
      var migrationBlocks = (await buildMigration(ctx)).blocks;
      var migrationError = resultErrorMessage(result);
      return migrationError ? toast(migrationError, "error", migrationBlocks) : toast("Migration step completed", "success", migrationBlocks);
    }
    if (interaction.action_id === "recompute_segment" && typeof interaction.value === "string") {
      var recomputeTimestamp = new Date().toISOString();
      var recomputeInput: JsonRecord = { segment_key: interaction.value };
      var recomputeRequestId = "admin-recompute-" + Date.now();
      var recomputeFingerprint = await requestPayloadFingerprint("admin/recompute", recomputeInput);
      var recomputeResult = await serializeMutation(async function() {
        return await recomputeSegmentStep(
          ctx,
          recomputeInput,
          recomputeRequestId,
          recomputeTimestamp,
          false,
          "admin",
          recomputeFingerprint,
          false
        );
      });
      var segmentBlocks = (await buildSegments(ctx)).blocks;
      var recomputeError = resultErrorMessage(recomputeResult);
      return recomputeError ? toast(recomputeError, "error", segmentBlocks) : toast("Recompute step completed", "success", segmentBlocks);
    }
    if (interaction.action_id === "profiles_page") {
      var cursor = interactionCursor(interaction.value);
      if (cursor) return await buildProfiles(ctx, cursor);
    }
    if (interaction.action_id === "templates_page") {
      var templateCursor = interactionCursor(interaction.value);
      if (templateCursor) return await buildTemplates(ctx, templateCursor);
    }
    if (interaction.action_id === "programs_page") {
      var programCursor = interactionCursor(interaction.value);
      if (programCursor) return await buildPrograms(ctx, programCursor);
    }
    if (interaction.action_id === "score_runs_page") {
      var scoreCursor = interactionCursor(interaction.value);
      if (scoreCursor) return await buildMeasurement(ctx, scoreCursor);
    }
  }

  if (interaction.type === "form_submit") {
    var formValues = interaction.values;
    if (interaction.action_id === "save_segment") {
      return await serializeMutation(async function() {
        return await handleSegmentForm(ctx, formValues);
      });
    }
    if (interaction.action_id === "manage_static_members") {
      return await serializeMutation(async function() {
        return await handleStaticMembershipForm(ctx, formValues);
      });
    }
    if (interaction.action_id === "save_template") {
      return await serializeMutation(async function() {
        return await handleTemplateForm(ctx, formValues);
      });
    }
    if (interaction.action_id === "save_program") {
      return await serializeMutation(async function() {
        return await handleProgramForm(ctx, formValues);
      });
    }
    if (interaction.action_id === "ingest_metric_fact") {
      return await serializeMutation(async function() {
        return await handleMetricFactForm(ctx, formValues);
      });
    }
    if (interaction.action_id === "evaluate_program") {
      return await serializeMutation(async function() {
        return await handleEvaluateProgramForm(ctx, formValues);
      });
    }
  }
  return { blocks: [] };
}
