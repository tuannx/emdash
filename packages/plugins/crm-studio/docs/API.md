# CRM Studio API V1

Base URL:

```text
/_emdash/api/plugins/crm-studio/<route-name>
```

All routes are private. Use an EmDash admin session or a bearer API token with
`admin` scope for every mutation and membership preview. The remaining GET
status/segment-definition routes contain no profile PII. Every
session-authenticated POST, including the read-only preview POST, also requires
`X-EmDash-Request: 1`; bearer-token requests are not subject to cookie CSRF.

EmDash wraps plugin output as `{ "data": <plugin-result> }`. The plugin result
itself is `{ "ok": true, "data": ... }` or
`{ "ok": false, "error": { "code", "message" } }`.

## Mutation envelope

Every mutation POST body requires the envelope below. The admin-scoped,
read-only segment preview is the only V1 API POST exception.

```json
{
  "schema_version": 1,
  "request_id": "source-operation-unique-id",
  "source": "product_api",
  "occurred_at": "2026-07-10T12:00:00Z",
  "dry_run": false
}
```

- `request_id` is 8–128 safe characters and is the idempotency key.
- `source` is a stable lowercase integration namespace. For external profiles,
  `external_source` must equal it (or may be omitted). Current EmDash core does
  not bind this claimed source to the bearer token identity, so it is an audit
  and namespace guard, not an authorization boundary.
- `occurred_at` must use strict ISO-8601 date-time syntax with seconds and a `Z`
  or numeric offset (for example `2026-07-10T12:00:00Z`). Impossible calendar
  dates, `24:00`, loose numeric dates, and values more than five minutes in the
  future are rejected.
- `dry_run` is optional.
- Reusing a request ID with the same payload replays a `checkpointed` or
  `completed` result.
- Reusing it with a changed payload returns `REQUEST_ID_CONFLICT`.
- A request-scoped `processing` claim is stored before domain writes. This keeps
  changed-payload retries conflicting even when the final receipt write fails.
- After domain writes, the result is stored as `checkpointed` before the
  best-effort transition to `completed`. A checkpointed result is durable and
  replayable; a finalization warning does not mean the domain mutation failed.
- A `PARTIAL_WRITE` response must be retried with the exact same request ID and
  payload. Deterministic IDs plus profile/migration/static-membership operation
  markers preserve outcomes for the covered paths. Cross-isolate atomic claim
  still requires a future core compare-and-swap primitive.
- Paginated API migration and recompute workflows do not advance past a step
  whose receipt is not `checkpointed` or `completed`; retry the previous
  request ID when `PREVIOUS_STEP_UNCONFIRMED` is returned.

The in-process mutation queue serializes work only inside one sandbox isolate.
Because EmDash storage has no cross-isolate compare-and-swap, every integration
must provide one sequenced writer across shared request IDs and for each
identity, segment, template, program, and metric fact stream. Do not let two
workers concurrently allocate request IDs or update the same logical stream.

Conservative D1 limits are 20 profiles per ingest, 10 identities per static
membership mutation, 30 users per migration step, 28 profiles per recompute
step, 16 metric facts per ingest, 50 documents per read page, and 100 stored
fact revisions per queried stream or scored period. Larger work must be split
into sequenced requests.

## Routes

### Inspect and load file configuration

`GET v1/config/file/status` returns the bundled configuration version,
fingerprint, formula version, activation thresholds, default-record comparison,
and runtime status (`clean`, `missing_defaults`, or `drifted`).

`POST v1/config/file/load` uses the standard mutation envelope. It validates
the complete bundled manifest, creates only missing default segment records,
and acknowledges the exact fingerprint. It never overwrites drifted runtime
records. Exact request replays are idempotent; unknown operation fields are
rejected.

### Operational statistics

`GET v1/statistics/summary` returns bounded, aggregate-only operational health:
profile consent/health/eligibility counts, segment materialization, active and
draft program/template counts, outcome rates, readiness/template/performance
dimension health, per-program score coverage, configuration drift, and operator
alerts. No profile rows or message content are returned.

The score-run query is bounded by the file-configured window (default 50).
Aggregates use only the newest immutable score run for each
`(program_key, period_key)` and expose both `immutable_runs_loaded` and
`current_program_period_snapshots` for auditability.

### Bootstrap defaults

`POST v1/bootstrap`

Creates missing default segment definitions and sets delivery mode to disabled.
It never resets an existing definition or deletes runtime data.
With `dry_run: true`, it only returns the missing-segment/settings plan and does
not write a receipt, segment, or setting.
The success payload also returns
`"concurrency_mode": "single_sequenced_writer_required"` so integrations can
fail configuration checks before opening concurrent mutation workers.

### Migrate EmDash users

`POST v1/migrations/emdash-users/step`

```json
{
  "schema_version": 1,
  "request_id": "migration-epoch1-page1",
  "source": "crm_operator",
  "occurred_at": "2026-07-10T12:00:00Z",
  "restart": true,
  "limit": 30
}
```

- `restart: true` begins a new reconciliation epoch at the first user.
- Subsequent calls omit `restart` and use a new request ID.
- `limit` is 1–30.
- The server owns the cursor. Do not pass one from the client.
- A completed state requires `restart: true` before another full scan.

Status: `GET v1/migrations/emdash-users/status`.

### Upsert profile batch

`POST v1/profiles/upsert-batch` accepts 1–20 items.

External identity:

```json
{
  "schema_version": 1,
  "request_id": "profiles-product-0042",
  "source": "billing",
  "occurred_at": "2026-07-10T12:00:00Z",
  "profiles": [
    {
      "external_source": "billing",
      "external_id": "customer-77",
      "email": "customer@example.com",
      "name": "Customer 77",
      "traits": {
        "billing_state": "paying",
        "marketing_consent": "unknown",
        "paid_tv_access": true
      }
    }
  ]
}
```

Patch CRM-owned traits on a migrated EmDash profile:

```json
{
  "schema_version": 1,
  "request_id": "traits-user-77-0043",
  "source": "product_api",
  "occurred_at": "2026-07-10T12:01:00Z",
  "profiles": [
    {
      "emdash_user_id": "USER_ULID",
      "consent_evidence": {
        "source": "checkout",
        "captured_at": "2026-07-10T12:00:00Z",
        "policy_version": "marketing-v3",
        "channel": "email"
      },
      "traits": {
        "marketing_consent": "granted",
        "email_health": "healthy",
        "reachability": "email"
      }
    }
  ]
}
```

An EmDash trait patch fails with `EMDASH_MIGRATION_REQUIRED` if the projection
does not already exist. The endpoint never creates or mutates an auth user.
Changing `marketing_consent` to `granted` requires durable `consent_evidence`
with source, capture time, policy version, and email channel.
Trait timestamps are monotonic per field. Older changes return
`STALE_TRAIT_UPDATE`; conflicting values at the same timestamp return
`AMBIGUOUS_TRAIT_ORDER`. A denial/unknown clears active grant evidence while
retaining its historical capture-time watermark.

Supported traits:

```text
billing_state, lifecycle_stage, has_tv, paid_tv_access, reachability,
email_health, marketing_consent, country, last_active_at,
last_premium_conversion_at, user_created_at, days_since_active,
eligible_for_messaging
```

`eligible_for_messaging` is accepted for schema compatibility but recomputed
fail-closed from consent, health, and reachability; clients cannot force it on.

Full profiles are intentionally available only inside the admin plugin page.
There is no profile-list API because private GET plugin routes currently allow
the lower `plugins:read` role and would downgrade access to email/consent PII.

### Upsert and score a message template

`POST v1/templates/upsert`

```json
{
  "schema_version": 1,
  "request_id": "template-winback-0001",
  "source": "crm_operator",
  "occurred_at": "2026-07-10T12:00:00Z",
  "template": {
    "key": "winback_email_v1",
    "name": "Win-back email V1",
    "channel": "email",
    "subject": "A personal account update for {{first_name}}",
    "body_html": "<p>Hello {{first_name}}, here is a clear summary of your account update and the next step available to you.</p>",
    "body_text": "Hello {{first_name}}, here is a clear summary of your account update and the next step available to you.",
    "cta_label": "Review my update",
    "cta_url": "https://example.com/account",
    "sender_profile_key": "default_sender",
    "is_active": true
  }
}
```

`key` and `sender_profile_key` are stable lowercase keys of 2–64 characters
using letters, digits, `_`, and `-`. V1 supports only `email`. Unknown template
or top-level operation fields are rejected.

The response includes `quality_score`, `quality_grade`, dimensions, hints, and
blockers. Template quality dimensions are subject/body coverage (40), CTA
(20), personalization (10), safety (25), and plain-text fallback (5). Active
content, JavaScript-like URLs/handlers, embedded frames/objects, and manually
implemented unsubscribe markup are safety blockers. `is_active: true` requires
no blockers and a score of at least 75. This is an active configuration flag,
not a send switch: `delivery_enabled` always remains `false` in V1.

Each distinct definition creates an immutable `configRevision`; the mutable
template record points at its revision through `config_revision_id`. Repeating
an identical definition returns `outcome: "unchanged"`. Older definition
updates are rejected as `STALE_TEMPLATE_UPDATE`.

### Upsert and score a growth program

`POST v1/programs/upsert`

```json
{
  "schema_version": 1,
  "request_id": "program-winback-0001",
  "source": "crm_operator",
  "occurred_at": "2026-07-10T12:01:00Z",
  "program": {
    "key": "premium_reactivation",
    "name": "Premium reactivation",
    "description": "Measured reactivation configuration",
    "offer_type": "discount",
    "audience_segment_key": "churned_users",
    "template_key": "winback_email_v1",
    "safety": {
      "require_marketing_consent": true,
      "exclude_crm_contact_safety": true,
      "exclude_crm_blacklist": true,
      "exclude_paid_tv_users": true
    },
    "measurement": {
      "primary_metric": "premium_reactivation",
      "conversion_event": "subscription_reactivated",
      "attribution_window_days": 14,
      "target_value": 0.04,
      "baseline_value": 0.02,
      "control_group_percentage": 10,
      "minimum_sample_size": 200
    },
    "is_active": true
  }
}
```

Program keys use the same stable-key syntax. `offer_type` must be one of
`informational`, `lifecycle`, `discount`, or `acquisition`. The referenced
segment and template must already exist. Unknown program, safety, measurement,
or operation fields are rejected.

Readiness dimensions are audience safety (30), audience definition (25),
message template (25), and measurement plan (20). Consent,
`crm_contact_safety`, and `crm_blacklist` protections are mandatory blockers;
`discount` and `acquisition` additionally require `paid_tv_users` exclusion.
The measurement plan must name a primary metric and conversion event, use an
attribution window of 1–365 days, and provide a target, baseline, or control
group comparison.

`is_active: true` additionally requires an active, nonempty audience segment,
an active template, no readiness blocker, and readiness score at least 75. A
dynamic audience must have a completed `active_generation`; an active but
unmaterialized audience fails with `SEGMENT_NOT_MATERIALIZED`, and an empty
current audience fails with `SEGMENT_EMPTY`.

Activation also fingerprints the active `crm_blacklist` definition and static
membership epoch/count. Discount/acquisition programs additionally fingerprint
`paid_tv_users`, which must be active and have a materialized dynamic
generation. Safety segments can legitimately have zero members; their current
definition and membership evidence is still pinned. Program activation still
leaves `delivery_enabled: false`. Each distinct definition creates an immutable
program revision; stale updates are rejected and an identical definition is
revalidated against current audience/safety evidence before it is unchanged.

### Ingest aggregate measurement facts

`POST v1/metrics/ingest-batch` accepts 1–16 facts.

```json
{
  "schema_version": 1,
  "request_id": "metric-premium-2026w28-0001",
  "source": "warehouse",
  "occurred_at": "2026-07-10T13:00:00Z",
  "program_key": "premium_reactivation",
  "facts": [
    {
      "source_fact_id": "65a10c8e-4618-4c96-9989-42aaf312af39",
      "period_key": "2026-W28",
      "sequence": 1,
      "sent": 1000,
      "delivered": 980,
      "unique_clicks": 80,
      "conversions": 45,
      "complaints": 0,
      "unsubscribes": 2
    }
  ]
}
```

Facts are aggregate-only. The strict schema accepts only the fields shown;
unknown fields are rejected, so do not send profile IDs, names, emails,
arbitrary dimensions, per-recipient events, or provider payloads.
`source_fact_id` must be a stable, opaque UUID or a 32–64 character hexadecimal
ID. Human-readable job names, emails, account identifiers, and other PII-bearing
keys are rejected. Counts must be non-negative safe integers with
`delivered <= sent` and clicks,
conversions, complaints, and unsubscribes each `<= delivered`.

A fact stream is `(program_key, envelope source, source_fact_id)`. The first
write uses a positive sequence. Corrections append a strictly higher sequence
and retain `correction_of_fact_id`; they never overwrite history and cannot
move the stream to another `period_key`, program revision, template revision,
audience evidence, or safety evidence. Moving pinned configuration/evidence
returns `FACT_CONFIG_IMMUTABLE`. Repeating the same sequence and semantic
payload is unchanged; changing its semantics is `FACT_ID_CONFLICT`. The
immutable stored fact ID includes the semantic fingerprint as well as stream
and sequence, so conflicting concurrent payloads cannot overwrite one another.
A stream with more than 100 stored revisions requires operator review.

Ingest requires an active program/template, the same active, materialized,
nonempty primary audience required for activation, and current safety evidence:
`crm_blacklist` for every offer plus `paid_tv_users` for discount/acquisition.
Every accepted fact pins the current program/template revision IDs and the
audience/safety evidence fingerprints. If configuration or membership evidence
changes, start a new opaque fact stream rather than correcting the old stream.

These counts are supplied by an external aggregate measurement source. CRM
Studio V1 does not send messages, collect provider events, or independently
prove attribution/tracking.

### Evaluate a program period

`POST v1/programs/evaluate`

```json
{
  "schema_version": 1,
  "request_id": "score-premium-2026w28-0001",
  "source": "crm_operator",
  "occurred_at": "2026-07-10T13:05:00Z",
  "program_key": "premium_reactivation",
  "period_key": "2026-W28"
}
```

Evaluation requires the program plus an active template, an active and nonempty
primary audience, a materialized generation for dynamic audiences, and the
current required safety evidence. It selects the highest accepted sequence from
each fact stream in the period, then computes:

- current template quality using the dimensions above;
- current program readiness using the pinned configuration and audience;
- performance across delivery (30), unique clicks (25), conversions (30), and
  complaint/unsubscribe safety (15).

Performance uses delivered messages as the effective sample and remains
`null` with status `insufficient_data` below the configured
`minimum_sample_size` (default 100). Invalid aggregate denominators also return
a null performance score. Complaint rate `>= 0.5%` or unsubscribe rate
`>= 3%` is a blocking guardrail. If readiness and performance have no blockers
and performance is available, `overall_score` is rounded from
`0.4 * readiness_score + 0.6 * performance_score`; otherwise it is `null`.

Each score run is immutable and reproducible. Its deterministic fingerprint
pins the bundled formula version (currently `crm-growth-score-v2-file-config`),
the file configuration version and fingerprint, program and template revision IDs,
the primary audience evidence, required safety evidence, and the selected
metric-fact IDs and semantic fingerprints. Static audience evidence includes a
membership epoch/count; dynamic evidence includes `active_generation` and its
member count. Identical inputs return the existing run rather than rewriting
it. Evaluation returns `METRIC_CONFIG_REVISION_MISMATCH` if any selected fact
pins another program/template revision or stale/mixed audience/safety evidence;
facts are never silently reattributed to current configuration. A period with
more than 100 stored fact revisions is refused for D1-safe evaluation.

### Upsert a segment

`POST v1/segments/upsert`

```json
{
  "schema_version": 1,
  "request_id": "segment-churned-v1",
  "source": "crm_operator",
  "occurred_at": "2026-07-10T12:00:00Z",
  "segment": {
    "key": "churned_users",
    "name": "Churned users",
    "kind": "dynamic",
    "membership_limit": 200,
    "rule": {
      "op": "and",
      "rules": [
        { "trait": "billing_state", "operator": "eq", "value": "churned" },
        { "trait": "marketing_consent", "operator": "eq", "value": "granted" }
      ]
    }
  }
}
```

Rule nodes support `and`, `or`, `not`; leaf operators support `eq`, `not_eq`,
`in`, `not_in`, `gte`, `lte`, `gt`, `lt`, `present`, and `blank`. Rules are
limited to depth 8 and 100 nodes. Missing values and the literal safety sentinel
`"unknown"` use three-valued logic, and only an exact `true` result joins an
audience. Explicit `eq "unknown"`/`in ["unknown"]` diagnostics are supported;
negative rules do not turn unknown consent or safety state into a match.

`membership_limit` is dynamic-only and 1–1,000 in V1.
Segment upsert is a full-definition replacement, not a patch: omitted optional
fields return to their documented defaults. `kind` is immutable, and an
`occurred_at` older than the stored definition returns `STALE_SEGMENT_UPDATE`.

List segments: `GET v1/segments/list?limit=50&cursor=<cursor>`.

### Add/remove static members

- `POST v1/segments/members/add`
- `POST v1/segments/members/remove`

```json
{
  "schema_version": 1,
  "request_id": "blacklist-feed-0044",
  "source": "support_api",
  "occurred_at": "2026-07-10T12:00:00Z",
  "segment_key": "crm_blacklist",
  "emdash_user_ids": ["USER_ULID"]
}
```

The request may use `profile_ids` (for example
`external:billing:customer-77`) and/or `emdash_user_ids`. Every profile must
already exist. Duplicate identities and batches over 10 are rejected.

Direct feed into a dynamic segment returns `DYNAMIC_SEGMENT_FEED_DENIED`.
Static membership ordering is monotonic; an event older than the current
membership state returns `STALE_MEMBERSHIP_UPDATE`.

### Recompute dynamic segment

`POST v1/segments/recompute-step`

```json
{
  "schema_version": 1,
  "request_id": "recompute-churned-step-1",
  "source": "crm_operator",
  "occurred_at": "2026-07-10T12:00:00Z",
  "segment_key": "churned_users",
  "restart": true
}
```

Call repeatedly with a new request ID until `state.status` is `completed`.

- Unbounded audiences write staged snapshot rows as each 28-profile page is
  scanned.
- Bounded audiences first maintain the globally lowest N stable EmDash user
  IDs, then re-check and materialize at most 28 selected rows per step.
- `active_generation` changes only after scanning and materialization succeed.
  Failed or abandoned generations remain inactive.
- Editing the segment mid-run returns `SEGMENT_CHANGED_DURING_RECOMPUTE` until
  the caller restarts.
- A recompute captures the current profile epoch. Profile creation or change
  through migration/profile ingest advances that epoch; any mismatch during
  scanning or immediately before activation returns
  `PROFILES_CHANGED_DURING_RECOMPUTE`. Retry with `restart: true` so the new
  generation evaluates one coherent profile snapshot.
- Each scan/materialization call handles at most 28 profiles. A caller cannot
  advance to a later step until the prior external API step has a replayable
  `checkpointed` or `completed` receipt.

Preview current active membership through the admin-scoped POST route:

```json
POST v1/segments/preview
{ "segment_key": "churned_users", "limit": 20 }
```

Dynamic generations are point-in-time snapshots. V1 has no delivery consumer;
any future sender must re-check live consent, reachability, health, and
suppression state at send time rather than treating membership as permission.

## Important V1 limitation

Private plugin routes currently require broad EmDash admin scope because core
does not provide plugin-specific service scopes. Do not turn these routes
public to work around that limitation. Add a narrower core scope before
granting third-party systems unattended write access.

The absence of cross-isolate compare-and-swap is also an integration boundary,
not merely a retry detail. Keep one sequenced writer across request-ID
allocation and for each identity, segment, template, program, and metric fact
stream until core provides an atomic claim primitive.
