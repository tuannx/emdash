# CRM Growth Studio for EmDash

CRM Growth Studio is a safety-first EmDash plugin for user projection, audited
profile ingestion, audience materialization, growth-program configuration, and
reproducible template/readiness/performance scoring.

The plugin is intentionally separate from `aikit-email-crm`. The existing
email CRM is a relationship/deal pipeline; CRM Studio is the lifecycle and
audience bounded context described by the Growth Studio specification.

## V1 scope

- Projects existing EmDash auth users into isolated CRM profiles.
- Preserves EmDash user IDs as the immutable identity link.
- Upserts external CRM profiles by stable `(source, external_id)`; an explicit
  `external_source` must match the mutation envelope source.
- Validates a whitelist-only segment rule DSL with three-valued, fail-closed
  evaluation for missing safety traits.
- Adds/removes members through dedicated static-segment APIs.
- Recomputes dynamic segments into a staging generation and only switches
  `active_generation` after the generation is complete.
- Supports deterministic `membership_limit` selection (up to 1,000) by EmDash
  user ID across paginated scans.
- Records deterministic audit documents, per-entity operation markers, and
  idempotency receipts.
- Stores message templates and growth programs under stable lowercase keys,
  with an immutable revision for every distinct definition.
- Scores template quality and program readiness before an operator may mark
  configuration active.
- Ingests aggregate-only measurement facts in append-only correction streams
  and creates immutable, input-fingerprinted score runs by program period.
- Renders Block Kit admin pages for profiles, segments, programs, templates,
  measurement, email tracking, operational statistics, file configuration,
  migration, events, and API integration.

Bulk journeys remain disabled. CRM Studio exposes an explicit, private,
per-recipient tracked-send route backed by Cloudflare Email Service REST; it
does not request EmDash `email:send`. Every send re-checks profile eligibility,
audience membership, suppressions, CRM blacklist, paid-TV exclusions, and
active program/template state before contacting the provider.

## Safety invariants

1. EmDash `users` remain the source of truth for authentication. CRM migration
   never updates or creates auth users.
2. EmDash-owned profile fields are `email`, `name`, `role`, and
   `user_created_at`. A re-sync preserves CRM-owned traits.
3. `marketing_consent`, `email_health`, and `reachability` default to
   `unknown`. Presence of an email does not make a profile message-eligible.
4. `eligible_for_messaging` is derived and only becomes true when consent is
   `granted`, email health is `healthy`, and reachability is `email` or `multi`.
5. Static member feeds cannot target dynamic segments. Dynamic segments only
   change through rule recompute.
6. All V1 routes are private. No route sets `public: true`.
7. Every mutation validates the complete batch before writing and uses a
   route-specific D1-safe limit: 20 profiles, 10 static memberships, 30
   migration users, 28 recompute profiles, or 16 metric facts per step.
8. Active templates require a quality score of at least 75 with no safety
   blockers. Active programs require an active, nonempty audience and active
   template, a readiness score of at least 75, and no readiness blockers. A
   dynamic audience must have a completed `active_generation`.
9. Every program must explicitly require marketing consent and exclude
   `crm_contact_safety` and `crm_blacklist` to clear readiness blockers.
   `discount` and `acquisition` programs must also exclude `paid_tv_users`.
   Activation, metric ingest, and evaluation pin current `crm_blacklist`
   evidence; discount/acquisition also pin `paid_tv_users`, whose dynamic
   generation must be materialized. Safety segments may legitimately contain
   zero members, but their active definition and membership evidence are still
   fingerprinted.
10. Metric facts contain aggregate counts only. Unknown fields, profile IDs,
    emails, names, arbitrary dimensions, and provider-message payloads are not
    accepted by the schema.
11. Mutations are serialized inside one sandbox isolate. Deterministic IDs and
   per-entity outcome markers make exact-payload retries repairable when a
   receipt/checkpoint write fails. EmDash storage still has no cross-isolate
   compare-and-swap or multi-collection transaction; integrations must use one
   sequenced writer across shared request IDs and for each identity, segment,
    template, program, and metric fact stream.
12. Tracking URLs use random 192-bit opaque tokens. Destinations remain in
    plugin storage and the click wrapper only redirects to validated HTTPS
    URLs. Invalid tokens return 404 without revealing delivery state.
13. Open pixels are observations, not proof of a human read. Privacy proxies and
    scanners are classified separately, and open counts never contribute to
    performance scoring. Unique clicks and provider delivery status do.

## Growth measurement and scoring

Configuration uses stable keys (`template.key`, `program.key`, segment keys)
rather than database IDs. Saving a distinct template or program definition
creates an immutable configuration revision; the current record points to that
revision without rewriting its history.

- Template quality: subject/body coverage, CTA, personalization, content
  safety, and plain-text fallback.
- Program readiness: audience safety, segment definition, template quality,
  and measurement plan.
- Program performance: delivery, unique clicks, conversions, and
  complaint/unsubscribe safety.

Performance stays `null` until the delivered sample reaches the configured
`minimum_sample_size` (default 100). Complaint rate at or above 0.5% or
unsubscribe rate at or above 3% blocks the score. When readiness and
performance have no blockers and performance is available, the overall score
is `40% readiness + 60% performance`.

Facts use an opaque UUID or 32–64 character hex `source_fact_id` and are grouped
into streams by `(program_key, source, source_fact_id)`. A correction appends a
higher `sequence`; it cannot move to another period, program/template revision,
audience evidence, or safety evidence. Each immutable fact ID includes its
semantic fingerprint, preventing conflicting same-sequence payloads from
overwriting one another. Score runs pin the formula version, program/template
revisions, audience and safety evidence, and latest accepted fact revisions.
Evaluation rejects stale or mixed evidence instead of attributing older facts
to current configuration; repeating identical inputs returns the same run.

Use the private routes `v1/templates/upsert`, `v1/programs/upsert`,
`v1/metrics/ingest-batch` (maximum 16 facts), and `v1/programs/evaluate`, or
the **Templates**, **Programs**, and **Measurement** admin pages. Scoring itself
does not send messages; tracked delivery and provider reconciliation are
separate, explicit operations.

## File configuration and operational statistics

The versioned source of truth is `src/config/file-config.ts`. It defines
scoring weights, thresholds, grade bands, statistics bounds, and the default
segment definitions. The TypeScript manifest is bundled into the sandbox, so
runtime scoring never depends on filesystem access or an optional YAML parser.

Open **CRM Studio -> Configuration** to inspect the bundled version,
fingerprint, runtime drift, and the last acknowledged load. **Load file config**
validates the complete manifest and creates only missing default segment
records. It never overwrites a changed runtime definition or historical data;
drift remains visible for operator review.

Open **CRM Studio -> Statistics** for profile eligibility and safety coverage,
segment materialization, program/template readiness, outcome rates, scoring
component health, and operator alerts. The read model is bounded to the newest
configured score-run window (default 50 immutable runs). For every
`(program_key, period_key)`, only the newest run contributes to aggregate rates;
the page reports both immutable runs loaded and current snapshots so repeated
evaluation cannot double-count a program period.

The same surfaces are available through `GET v1/config/file/status`,
`POST v1/config/file/load`, and `GET v1/statistics/summary`.

## Email tracking and Cloudflare reporting

`POST v1/deliveries/send` rewrites up to 20 HTTPS links to
`/crm-track/c/<opaque-token>`, appends a transparent
`/crm-track/o/<opaque-token>.gif`, and adds one-click unsubscribe plus
`X-CRM-Delivery-ID` and `X-CRM-Program-ID` headers. The raw Astro wrappers return
a real 302, 1x1 GIF, or RFC 8058-compatible unsubscribe response; public plugin
routes retain the isolated storage logic behind them.

`POST v1/providers/cloudflare/report-sync` reads Cloudflare's
`emailSendingAdaptive` GraphQL dataset. Because the current dataset does not
return custom X-headers, correlation is deliberately fail-closed: recipient,
exact subject, and send time must identify exactly one final provider event.
Ambiguous rows are reported and never attributed. Cloudflare retains these
Email Service analytics for 31 days.

`POST v1/metrics/materialize-tracking` converts provider-delivered, unique-click,
and one-click-unsubscribe counts into an append-only `crm_tracking` metric fact.
Conversions and complaints remain zero until a separately verified source
provides them. Open observations are displayed under **Email Tracking** but are
excluded from scoring.

Cloudflare credentials are read from plugin-scoped KV keys
`settings:cloudflareAccountId`, `settings:cloudflareZoneId`,
`settings:cloudflareApiToken`, `settings:cloudflareFromAddress`, and
`settings:trackingBaseUrl`. Provision the API token through the trusted
deployment secret workflow; CRM Studio never displays or returns it.

## Installation

The workspace site already registers the plugin in `astro.config.mjs`:

```js
import { crmStudioPlugin } from "@aikit/crm-studio";

emdash({
  sandboxed: [crmStudioPlugin()],
});
```

Build and test it with:

```bash
pnpm --filter @aikit/crm-studio test
```

The admin pages mount under:

```text
/_emdash/admin/plugins/crm-studio/dashboard
```

## Migrating existing EmDash users

Migration is explicit and paginated so installing the plugin never launches an
unbounded data job inside the Cloudflare sandbox.

1. Open **CRM Studio → User Migration**.
2. Click **Start full reconciliation** to begin a new epoch.
3. Click **Sync next page** until status is `completed`.
4. Review profile counts and audit events before feeding any segment.

Each step reads at most 30 users. Profile IDs are deterministic:
`emdash:<emdash-user-id>`. Re-running an epoch updates EmDash-owned fields and
preserves CRM traits. V1 never deletes profiles that disappear from a later
scan because the read-only plugin API does not expose disabled/deleted state.

Any migration or profile-ingest change advances a profile epoch. A dynamic
segment recompute pins that epoch and refuses activation with
`PROFILES_CHANGED_DURING_RECOMPUTE` if profiles change mid-scan; restart the
recompute to produce a coherent snapshot.

The same flow is available through
`POST v1/migrations/emdash-users/step`; see [API.md](./docs/API.md).

## Default segments

`POST v1/bootstrap` or the first admin page load creates these definitions
without touching runtime history:

| Key | Kind | Purpose |
| --- | --- | --- |
| `emdash_users` | static | Optional operator-managed cohort of migrated users. Migration does not auto-enroll it. |
| `crm_blacklist` | static | Manual all-channel contact-safety exclusion. |
| `paid_tv_users` | dynamic | Matches `paid_tv_access == true`. Unknown does not match. |
| `paying_customers` | dynamic | Matches `billing_state == paying`. |

## Platform boundaries

EmDash 0.16.1 still cannot implement autonomous bulk journeys safely:

- the Cloudflare wrapper does not expose reliable scheduled cron execution;
- plugin email send does not return provider IDs or support all required
  sender/reply-to/compliance headers, so the bounded send path uses Cloudflare
  Email Service REST directly;
- plugin API routes always return JSON, so site-owned Astro wrappers provide
  the raw pixel, redirect, and unsubscribe responses;
- storage batch writes are not transactional across collections;
- plugin storage has no cross-isolate compare-and-swap primitive;
- route context does not expose the authenticated actor identity for audit.

Journeys and outbox dispatch remain disabled until those core capabilities or a
trusted queue Worker are designed and tested. Per-recipient tracked send is the
only enabled delivery primitive.

## Documentation

- [API contract](./docs/API.md)
- [V1 architecture and specification mapping](./docs/ARCHITECTURE.md)
