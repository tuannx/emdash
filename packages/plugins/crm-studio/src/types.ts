import type { StorageCollection } from "emdash";

export type JsonRecord = Record<string, unknown>;

export interface CrmTraits extends JsonRecord {
  billing_state: string;
  lifecycle_stage: string;
  has_tv: boolean | null;
  paid_tv_access: boolean | null;
  reachability: string;
  email_health: string;
  marketing_consent: string;
  country: string | null;
  last_active_at: string | null;
  last_premium_conversion_at: string | null;
  user_created_at: string | null;
  days_since_active: number | null;
  eligible_for_messaging: boolean;
}

export interface CrmProfile extends JsonRecord {
  id: string;
  schema_version: number;
  identity_key: string;
  source: "emdash" | "external";
  emdash_user_id: string | null;
  external_source: string | null;
  external_id: string | null;
  email: string | null;
  name: string | null;
  role: number | null;
  consent_evidence: JsonRecord | null;
  last_consent_evidence_at: string | null;
  source_fingerprint: string;
  source_updated_at: string;
  traits: CrmTraits;
  trait_updated_at: Record<string, string>;
  last_ingest_request_id: string | null;
  last_ingest_fingerprint: string | null;
  last_ingest_outcome: "created" | "updated" | "unchanged" | null;
  last_ingest_source: string | null;
  last_migration_request_id: string | null;
  last_migration_fingerprint: string | null;
  last_migration_outcome: "created" | "updated" | "unchanged" | null;
  billing_state: string;
  lifecycle_stage: string;
  reachability: string;
  email_health: string;
  marketing_consent: string;
  country: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at: string;
}

export interface CrmSegment extends JsonRecord {
  id: string;
  schema_version: number;
  key: string;
  name: string;
  description: string;
  kind: "static" | "dynamic";
  evaluation_mode: "scheduled" | "event" | "hybrid";
  rule: JsonRecord | null;
  membership_limit: number | null;
  group_key: string | null;
  is_active: boolean;
  active_generation: string | null;
  created_at: string;
  updated_at: string;
  last_recomputed_at: string | null;
}

export interface MembershipState extends JsonRecord {
  id: string;
  identity_key: string;
  segment_key: string;
  profile_id: string;
  status: "open" | "closed";
  membership_id: string | null;
  entry_version: number;
  generation: string | null;
  entered_at: string | null;
  exited_at: string | null;
  updated_at: string;
  last_request_id: string | null;
  last_request_action: "add" | "remove" | null;
  last_request_outcome: "added" | "already_members" | "removed" | "already_absent" | null;
}

export interface MembershipHistory extends JsonRecord {
  id: string;
  segment_key: string;
  profile_id: string;
  status: "open" | "closed" | "snapshot";
  generation: string | null;
  request_id: string;
  entered_at: string;
  exited_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmEvent extends JsonRecord {
  id: string;
  type: string;
  profile_id: string | null;
  segment_key: string | null;
  request_id: string;
  occurred_at: string;
  metadata: JsonRecord;
}

export interface IngestReceipt extends JsonRecord {
  id: string;
  request_id: string;
  route: string;
  source: string;
  payload_fingerprint: string;
  status: "processing" | "checkpointed" | "completed" | "partial";
  result: JsonRecord;
  created_at: string;
  updated_at: string;
}

export interface MessageTemplate extends JsonRecord {
  id: string;
  schema_version: number;
  key: string;
  name: string;
  channel: "email";
  subject: string;
  body_html: string;
  body_text: string | null;
  cta_label: string | null;
  cta_url: string | null;
  sender_profile_key: string | null;
  is_active: boolean;
  delivery_enabled: false;
  quality_score: number;
  quality_grade: string;
  quality_result: JsonRecord;
  quality_checked_at: string;
  scoring_formula_version: string;
  config_revision_id: string;
  definition_fingerprint: string;
  created_at: string;
  updated_at: string;
  last_request_id: string;
  last_payload_fingerprint: string;
  last_outcome: "created" | "updated";
  last_source: string;
}

export interface GrowthProgram extends JsonRecord {
  id: string;
  schema_version: number;
  key: string;
  name: string;
  description: string;
  offer_type: "informational" | "lifecycle" | "discount" | "acquisition";
  audience_segment_key: string;
  template_key: string;
  safety: JsonRecord;
  measurement: JsonRecord;
  is_active: boolean;
  delivery_enabled: false;
  readiness_score: number;
  readiness_grade: string;
  readiness_result: JsonRecord;
  readiness_checked_at: string;
  scoring_formula_version: string;
  config_revision_id: string;
  definition_fingerprint: string;
  created_at: string;
  updated_at: string;
  last_request_id: string;
  last_payload_fingerprint: string;
  last_outcome: "created" | "updated";
  last_source: string;
}

export interface ConfigRevision extends JsonRecord {
  id: string;
  schema_version: number;
  entity_type: "message_template" | "program";
  entity_key: string;
  entity_id: string;
  definition_fingerprint: string;
  definition: JsonRecord;
  request_id: string;
  request_payload_fingerprint: string;
  source: string;
  created_at: string;
}

export interface MetricFact extends JsonRecord {
  id: string;
  schema_version: number;
  program_key: string;
  period_key: string;
  source: string;
  source_fact_id: string;
  fact_stream_key: string;
  sequence: number;
  sent: number;
  delivered: number;
  unique_clicks: number;
  conversions: number;
  complaints: number;
  unsubscribes: number;
  semantic_fingerprint: string;
  correction_of_fact_id: string | null;
  program_revision_id: string;
  template_revision_id: string;
  audience_evidence_fingerprint: string;
  safety_evidence_fingerprint: string;
  first_request_id_fingerprint: string;
  first_request_payload_fingerprint: string;
  occurred_at: string;
  created_at: string;
}

export interface ScoreRun extends JsonRecord {
  id: string;
  schema_version: number;
  formula_version: string;
  file_config_version: string;
  file_config_fingerprint: string;
  program_key: string;
  period_key: string;
  status: "blocked" | "insufficient_data" | "scored";
  overall_score: number | null;
  readiness_score: number;
  performance_score: number | null;
  template_quality_score: number;
  readiness_result: JsonRecord;
  performance_result: JsonRecord;
  template_quality_result: JsonRecord;
  aggregate_metrics: JsonRecord;
  input_fact_id: string | null;
  input_fact_ids: string[];
  input_facts_fingerprint: string;
  program_revision_id: string;
  template_revision_id: string;
  audience_segment_fingerprint: string;
  audience_evidence: JsonRecord;
  safety_evidence_fingerprint: string;
  safety_evidence: JsonRecord;
  request_id: string;
  request_payload_fingerprint: string;
  source: string;
  created_at: string;
}

export interface CrmCollections {
  profiles: StorageCollection<CrmProfile>;
  segments: StorageCollection<CrmSegment>;
  segmentMemberships: StorageCollection<MembershipHistory>;
  segmentMembershipStates: StorageCollection<MembershipState>;
  events: StorageCollection<CrmEvent>;
  ingestRequests: StorageCollection<IngestReceipt>;
  suppressions: StorageCollection<JsonRecord>;
  programs: StorageCollection<GrowthProgram>;
  messageTemplates: StorageCollection<MessageTemplate>;
  configRevisions: StorageCollection<ConfigRevision>;
  metricFacts: StorageCollection<MetricFact>;
  scoreRuns: StorageCollection<ScoreRun>;
}

export interface CrmContext {
  storage: CrmCollections;
  kv: {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
  };
  users?: {
    get(id: string): Promise<EmDashUser | null>;
    getByEmail(email: string): Promise<EmDashUser | null>;
    list(opts?: { role?: number; limit?: number; cursor?: string }): Promise<{
      items: EmDashUser[];
      nextCursor?: string;
    }>;
  };
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  code?: string;
  message?: string;
}

export interface ProjectedProfileResult {
  profile: CrmProfile;
  changed: boolean;
}

export interface AdminBlockResponse {
  blocks: JsonRecord[];
  toast?: {
    message: string;
    type: "success" | "error" | "info";
  };
}

export interface SandboxedRouteInput {
  input: unknown;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  requestMeta?: unknown;
}

export interface EmDashUser {
  id: string;
  email: string;
  name: string | null;
  role: number;
  createdAt: string;
}
export type { StorageCollection };
