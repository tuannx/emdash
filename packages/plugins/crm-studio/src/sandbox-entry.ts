import type { SandboxedPlugin } from "emdash/plugin";
import type { CrmContext } from "./types.js";
import { handleAdmin } from "./presentation/admin.js";
import {
  handleBootstrap,
  handleFileConfigLoad,
  handleFileConfigStatus,
  handleMetricFactsIngest,
  handleMigrationStatus,
  handleMigrationStep,
  handleProgramEvaluate,
  handleProgramUpsert,
  handleProfilesUpsert,
  handleSegmentMembersAdd,
  handleSegmentMembersRemove,
  handleSegmentPreview,
  handleSegmentRecompute,
  handleSegmentsList,
  handleSegmentUpsert,
  handleStatisticsSummary,
  handleTemplateUpsert
} from "./presentation/routes.js";

export default {
  routes: {
    admin: {
      handler: async function(routeCtx, ctx) {
        return await handleAdmin(routeCtx.input, ctx as unknown as CrmContext);
      }
    },
    "v1/bootstrap": {
      handler: async function(routeCtx, ctx) {
        return await handleBootstrap(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/statistics/summary": {
      handler: async function(routeCtx, ctx) {
        return await handleStatisticsSummary(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/config/file/status": {
      handler: async function(routeCtx, ctx) {
        return await handleFileConfigStatus(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/config/file/load": {
      handler: async function(routeCtx, ctx) {
        return await handleFileConfigLoad(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/profiles/upsert-batch": {
      handler: async function(routeCtx, ctx) {
        return await handleProfilesUpsert(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/templates/upsert": {
      handler: async function(routeCtx, ctx) {
        return await handleTemplateUpsert(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/programs/upsert": {
      handler: async function(routeCtx, ctx) {
        return await handleProgramUpsert(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/metrics/ingest-batch": {
      handler: async function(routeCtx, ctx) {
        return await handleMetricFactsIngest(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/programs/evaluate": {
      handler: async function(routeCtx, ctx) {
        return await handleProgramEvaluate(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/segments/upsert": {
      handler: async function(routeCtx, ctx) {
        return await handleSegmentUpsert(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/segments/list": {
      handler: async function(routeCtx, ctx) {
        return await handleSegmentsList(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/segments/members/add": {
      handler: async function(routeCtx, ctx) {
        return await handleSegmentMembersAdd(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/segments/members/remove": {
      handler: async function(routeCtx, ctx) {
        return await handleSegmentMembersRemove(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/segments/recompute-step": {
      handler: async function(routeCtx, ctx) {
        return await handleSegmentRecompute(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/segments/preview": {
      handler: async function(routeCtx, ctx) {
        return await handleSegmentPreview(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/migrations/emdash-users/step": {
      handler: async function(routeCtx, ctx) {
        return await handleMigrationStep(routeCtx, ctx as unknown as CrmContext);
      }
    },
    "v1/migrations/emdash-users/status": {
      handler: async function(routeCtx, ctx) {
        return await handleMigrationStatus(routeCtx, ctx as unknown as CrmContext);
      }
    }
  }
} satisfies SandboxedPlugin;
