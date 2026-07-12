import type { PluginDescriptor } from "emdash";

/**
 * CRM Growth Studio for EmDash.
 *
 * The standard plugin format keeps CRM data isolated in plugin storage and
 * gives the runtime read-only access to EmDash users for profile projection.
 */
export function crmStudioPlugin(): PluginDescriptor {
  return {
    id: "crm-studio",
    version: "0.1.0",
    format: "standard",
    entrypoint: "@aikit/crm-studio/sandbox",
    capabilities: ["users:read", "network:request"],
    allowedHosts: ["api.cloudflare.com"],
    storage: {
      profiles: {
        indexes: [
          "identity_key",
          "source",
          "emdash_user_id",
          "email",
          "billing_state",
          "lifecycle_stage",
          "reachability",
          "email_health",
          "marketing_consent",
          "country",
          "updated_at"
        ],
        uniqueIndexes: ["identity_key", "emdash_user_id"]
      },
      segments: {
        indexes: ["key", "kind", "group_key", "is_active", "updated_at"],
        uniqueIndexes: ["key"]
      },
      segmentMemberships: {
        indexes: ["segment_key", "profile_id", "status", "generation", "entered_at", "exited_at", "request_id"]
      },
      segmentMembershipStates: {
        indexes: ["segment_key", "profile_id", "status", "updated_at"],
        uniqueIndexes: ["identity_key"]
      },
      events: {
        indexes: ["type", "profile_id", "segment_key", "request_id", "occurred_at"]
      },
      ingestRequests: {
        indexes: ["request_id", "route", "status", "created_at"],
        uniqueIndexes: ["request_id"]
      },
      suppressions: {
        indexes: ["profile_id", "channel", "scope", "is_active", "updated_at"]
      },
      programs: {
        indexes: ["key", "offer_type", "audience_segment_key", "template_key", "is_active", "readiness_score", "updated_at"],
        uniqueIndexes: ["key"]
      },
      messageTemplates: {
        indexes: ["key", "channel", "is_active", "quality_score", "updated_at"],
        uniqueIndexes: ["key"]
      },
      configRevisions: {
        indexes: ["entity_type", "entity_key", "definition_fingerprint", "created_at"]
      },
      metricFacts: {
        indexes: ["program_key", "period_key", "source", "source_fact_id", "fact_stream_key", "sequence", "created_at"]
      },
      scoreRuns: {
        indexes: ["program_key", "period_key", "status", "formula_version", "input_facts_fingerprint", "created_at"]
      },
      emailDeliveries: {
        indexes: ["delivery_key", "program_key", "period_key", "profile_id", "provider_status", "created_at"],
        uniqueIndexes: ["delivery_key", "open_token"]
      },
      trackingLinks: {
        indexes: ["token", "delivery_key", "program_key", "period_key", "created_at"],
        uniqueIndexes: ["token"]
      },
      trackingEvents: {
        indexes: ["event_type", "delivery_key", "program_key", "period_key", "occurred_at", "request_fingerprint"]
      }
    },
    adminPages: [
      { path: "/dashboard", label: "CRM Studio", icon: "chart" },
      { path: "/profiles", label: "Profiles", icon: "users" },
      { path: "/segments", label: "Segments", icon: "layers" },
      { path: "/programs", label: "Programs", icon: "target" },
      { path: "/templates", label: "Templates", icon: "file-text" },
      { path: "/measurement", label: "Measurement", icon: "bar-chart" },
      { path: "/tracking", label: "Email Tracking", icon: "mouse-pointer" },
      { path: "/statistics", label: "Statistics", icon: "trending-up" },
      { path: "/configuration", label: "Configuration", icon: "sliders" },
      { path: "/events", label: "Events", icon: "activity" },
      { path: "/migration", label: "User Migration", icon: "refresh-cw" },
      { path: "/settings", label: "API Settings", icon: "settings" }
    ],
    adminWidgets: [
      { id: "crm-studio-overview", title: "CRM Studio", size: "full" }
    ]
  };
}
