# CRM Growth Studio V1 architecture

## Mapping from the source specification

| Source capability | V1 status | Implementation |
| --- | --- | --- |
| Host user projection | Implemented | `application/sync-emdash-users.ts`, deterministic `emdash:<id>` profiles |
| Trait ingestion | Implemented | Private `v1/profiles/upsert-batch`, strict whitelist |
| Static audiences | Implemented | Versioned add/remove plus open-state pointer and interval history |
| Dynamic audiences | Implemented | Three-valued rule engine and generation snapshot recompute |
| `membership_limit` | Implemented | Top N by stable EmDash user ID, staged before activation, max 1,000 in V1 |
| Audit/event spine | Implemented | Deterministic event IDs and retry-stable audit documents |
| Message templates | Implemented as configuration | Stable keys, quality scoring, immutable definition revisions; delivery remains false |
| Growth programs | Implemented as configuration | Stable keys, offer/safety/measurement contract, readiness scoring and active-config gate |
| Aggregate metric facts | Implemented | Strict no-PII schema, max 16 per request, append-only correction sequences pinned to configuration/evidence |
| Program score runs | Implemented | Formula-versioned, input-fingerprinted readiness/performance score snapshots |
| Suppressions | Storage reserved | Enforcement belongs to the delivery phase; no live send exists in V1 |
| Funnels/enrollments | Deferred | Requires a reliable scheduler and product policy decisions |
| Durable message outbox | Deferred | Requires transactional claim/retry semantics beyond plugin storage |
| Email transport/compliance | Deferred | Current sandbox email API lacks required sender/header/provider controls |
| Open/click/unsubscribe HTTP | Deferred | Plugin routes cannot return raw GIF, redirect, or HTML responses |

## Bounded contexts

```text
EmDash users (read only)
  -> migration application
  -> CRM profile projection
  -> whitelisted rule evaluator
  -> staged segment generation
  -> active audience read model

External product/billing feeds
  -> private authenticated plugin routes
  -> envelope + identity + trait validation
  -> per-entity operation marker + idempotency receipt
  -> profile or static membership write
  -> deterministic audit event

CRM operator / aggregate warehouse
  -> stable template and program keys
  -> immutable config revisions
  -> template quality + program readiness gates
  -> aggregate-only metric fact correction streams
  -> immutable reproducible score runs
```

`email-crm` is not part of this flow. Plugin storage is namespaced by plugin ID,
and automatic email-based merging would conflate sales contacts with product
identities. A future cross-plugin migration must use an explicit export/import
contract and operator reconciliation.

## Ownership rules

| Field group | Owner | Sync behavior |
| --- | --- | --- |
| EmDash ID, email, name, role, created time | EmDash user projection | Refreshed during migration |
| Billing/activity/device traits | Product feed | Preserved during EmDash re-sync |
| Consent evidence and suppressions | CRM/compliance integration | Never inferred from email presence |
| Message eligibility | CRM derived field | Fail-closed calculation |
| Template/program definitions | CRM operator/integration | Current pointer plus immutable definition revisions |
| Aggregate metric facts | Measurement integration | Append-only correction sequence; no profile PII |
| Scores and hints | CRM scoring domain | Immutable reproducible score runs |

The read-only EmDash user API does not expose `email_verified`, `disabled`, or
custom user data. V1 therefore cannot infer email health, detect disabled users,
or classify billing/lifecycle without an external trait feed.

## Storage model

- `profiles`: materialized CRM projection.
- `segments`: stable-key audience definitions and active generation pointer.
- `segmentMemberships`: static intervals and immutable dynamic generation snapshots.
- `segmentMembershipStates`: deterministic open pointer for static audiences.
- `events`: deterministic audit records (storage uses idempotent upsert by ID).
- `ingestRequests`: idempotency and partial-write receipts.
- `suppressions`: reserved V1 storage for the later delivery gate.
- `messageTemplates`: current template definitions plus quality result;
  `delivery_enabled` is always false.
- `programs`: current program definitions plus readiness result;
  `delivery_enabled` is always false.
- `configRevisions`: immutable content-addressed template/program definitions.
- `metricFacts`: append-only aggregate fact revisions keyed by program, source,
  opaque source fact ID, sequence, and semantic fingerprint; each revision pins
  program/template revisions plus audience/safety evidence.
- `scoreRuns`: immutable formula/input-fingerprinted period evaluations.

Plugin storage does not offer a transaction spanning collections. Write order
is therefore part of correctness:

1. validate the complete bounded request;
2. serialize mutations inside the current sandbox isolate;
3. persist a request-scoped payload-fingerprint receipt in `processing` state;
4. write deterministic history/event documents and per-entity outcome markers;
5. write current-state pointer or active-generation pointer last;
6. persist the successful result as a replayable `checkpointed` receipt;
7. best-effort finalize the receipt as `completed`.

A same-payload retry replays either a checkpointed or completed result and can
recover deterministic documents/outcome markers used by profile ingest,
migration, and static membership feeds. Multi-step migration/recompute state
stores the last request ID and refuses to advance while its external receipt is
unconfirmed. Dynamic generations are invisible until the segment pointer
switches, so a partial recompute never becomes the active audience. There is no
atomic claim or compare-and-swap across isolates. The isolate-local queue is
not a distributed lock: integrations must use one sequenced writer across
shared request IDs and for each identity, segment, template, program, and metric
fact stream until core provides an atomic claim primitive.

Conservative request caps keep D1 work bounded: 20 profile upserts, 10 static
membership changes, 30 migration users, 28 recompute profiles, and 16 metric
facts. Read pages are at most 50, and metric stream/period evaluation refuses
more than 100 stored revisions.

## Coherent audience generations

Profile ingest and EmDash-user migration advance a request-idempotent global
profile epoch whenever they create or change a projection. A dynamic recompute
pins both the segment-definition fingerprint and profile epoch at restart. It
checks the epoch on every continuation and immediately before switching
`active_generation`; a mismatch fails with
`PROFILES_CHANGED_DURING_RECOMPUTE` and requires a fresh generation. This
prevents a multi-page result from silently mixing old and new profile states.

Unbounded segments stage matching rows in pages of 28. Bounded segments first
retain the globally lowest N stable identity keys, then re-read and materialize
those candidates in pages of 28. In both cases, segment edits or profile-epoch
changes leave the generation inactive.

## Growth configuration and scoring

Template and program records are current read models keyed by stable business
keys. Their definitions are fingerprinted; a new fingerprint appends one
immutable `configRevision`, while an identical definition creates no new
revision. An unchanged active program still refreshes readiness against current
audience/safety evidence. An active template needs quality `>= 75` and no
blocker. An active program needs
an active, nonempty audience and active template, readiness `>= 75`, and no
blocker. A dynamic primary audience must have a completed `active_generation`.
These flags mean configuration readiness only: both models hard-code
`delivery_enabled: false`.

Program `offer_type` is `informational`, `lifecycle`, `discount`, or
`acquisition`. Every program readiness evaluation requires explicit marketing
consent, `crm_contact_safety` exclusion, and `crm_blacklist` exclusion.
Discount/acquisition also require `paid_tv_users` exclusion. Readiness weights
are safety 30, audience 25, template 25, and measurement 20.

Activation, metric ingest, and evaluation collect a fingerprinted audience
manifest. Static evidence contains its membership epoch/count; dynamic evidence
contains `active_generation` and snapshot count. The primary audience must be
nonempty. The safety manifest always contains the active `crm_blacklist` and,
for discount/acquisition, active `paid_tv_users`; its dynamic generation must be
materialized. A safety exclusion may legitimately have zero members, but its
definition and membership evidence remains part of the fingerprint.

Template quality weights are coverage 40, CTA 20, personalization 10, safety
25, and plain-text fallback 5. Active/scriptable content, unsafe CTA URLs, and
manual unsubscribe implementation are blockers. Compliance unsubscribe
rendering remains the responsibility of a future trusted delivery layer.

Metric ingestion accepts only aggregate integer counts for sent, delivered,
unique clicks, conversions, complaints, and unsubscribes. Unknown fields are
rejected, which prevents profile PII and arbitrary per-recipient dimensions
from entering this collection. Each `(program, source, source_fact_id)` stream
uses an opaque UUID or 32–64 character hex source ID and is append-only. Every
fact pins the program/template revisions and audience/safety evidence present at
ingest. A correction must use a higher sequence and preserve its period and all
of those pins. Its immutable storage ID also contains the semantic fingerprint,
preventing a conflicting same-sequence payload from overwriting another fact.

Evaluation chooses the latest revision of each stream only after verifying that
every fact matches the current program/template revisions and current
audience/safety evidence. Stale or mixed evidence returns
`METRIC_CONFIG_REVISION_MISMATCH` instead of reattributing old metrics. Valid
facts score performance as delivery 30, click 25, conversion 30, and
complaint/unsubscribe safety 15.
Below the configured delivered sample minimum (default 100), performance and
overall score are `null`. Complaint rate `>= 0.5%` and unsubscribe rate
`>= 3%` are blocking guardrails. With sufficient, unblocked data, overall is
`40% readiness + 60% performance`.

A score-run ID includes the formula version plus a fingerprint of the exact
program/template revisions, primary-audience evidence, safety-segment evidence,
and selected metric fact revisions/semantic fingerprints. Consequently a
repeated evaluation returns the existing immutable run, while any corrected
fact or evidence/configuration revision produces a new, auditable run. These are
scoring read models over supplied aggregate facts; they do not claim that CRM
Studio sent, tracked, or attributed any message.

The Block Kit admin surface exposes `/templates` for definition/quality score,
`/programs` for safety/readiness configuration, `/measurement` for one-fact
ingest plus immutable period evaluation, `/configuration` for bundled-file
fingerprint and runtime drift, and `/statistics` for bounded operational health.
Statistics deduplicate immutable runs to the newest snapshot per program and
period before computing aggregates. File loads validate the complete manifest
and create only missing defaults; they never overwrite drifted runtime records.
Template bodies are not rendered as raw admin HTML, and no admin action invokes
delivery or tracking.

## Rule safety

Rules cannot name arbitrary document fields or inject query expressions. The
evaluator accepts only the documented traits and operators. Missing values use
three-valued logic:

- `true` joins;
- `false` does not join;
- `unknown` does not join;
- `not unknown` remains `unknown`.

This prevents an unknown `paid_tv_access` value from passing a negated safety
rule and being treated as an eligible acquisition target.

Generation membership is still a point-in-time segment snapshot, not proof of
current send eligibility. A future delivery layer must re-read the profile and
apply consent, health, reachability, blacklist, and suppression gates at the
last responsible moment.

## Required core work before delivery V2

1. Plugin-specific API token scopes and authenticated actor identity.
2. Reliable sandbox cron exposure with observable schedule state.
3. Transactional outbox claim/retry primitives or a trusted Worker service.
4. Email API support for sender profile, reply-to, provider message ID,
   compliance headers, and provider errors.
5. Public response primitives for binary pixel, safe redirects, and HTML form
   responses.
6. Consent source/product/legal decisions from the Growth Studio source spec.

Until those are complete, `deliveryMode=disabled` is an architectural safety
boundary rather than a UI preference.
