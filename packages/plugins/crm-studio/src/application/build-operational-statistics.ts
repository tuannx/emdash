import type {
  CrmContext,
  GrowthProgram,
  JsonRecord,
  ScoreRun
} from "../types.js";
import { CRM_STUDIO_FILE_CONFIG } from "../config/file-config.js";
import { inspectFileConfig } from "./manage-file-config.js";

interface DimensionAccumulator {
  scope: string;
  key: string;
  label: string;
  runs: number;
  scored: number;
  score_total: number;
  max_total: number;
  pass: number;
  warn: number;
  fail: number;
  blocked: number;
  insufficient: number;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeTotal(current: number | null, value: unknown): number | null {
  var numberValue = finiteNumber(value);
  if (current === null || numberValue === null || !Number.isSafeInteger(numberValue) || numberValue < 0) return null;
  var next = current + numberValue;
  return Number.isSafeInteger(next) ? next : null;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return rounded(numerator / denominator * 100);
}

function average(total: number, count: number): number | null {
  return count > 0 ? rounded(total / count) : null;
}

function accumulateDimensions(
  accumulators: Record<string, DimensionAccumulator>,
  scope: string,
  resultInput: unknown
): void {
  var result = asRecord(resultInput);
  if (!result || !Array.isArray(result.dimensions)) return;
  for (var index = 0; index < result.dimensions.length; index++) {
    var dimension = asRecord(result.dimensions[index]);
    if (!dimension || typeof dimension.key !== "string") continue;
    var accumulatorKey = scope + ":" + dimension.key;
    var accumulator = accumulators[accumulatorKey];
    if (!accumulator) {
      accumulator = {
        scope: scope,
        key: dimension.key,
        label: typeof dimension.label === "string" ? dimension.label : dimension.key,
        runs: 0,
        scored: 0,
        score_total: 0,
        max_total: 0,
        pass: 0,
        warn: 0,
        fail: 0,
        blocked: 0,
        insufficient: 0
      };
      accumulators[accumulatorKey] = accumulator;
    }
    accumulator.runs++;
    var score = finiteNumber(dimension.score);
    var maximum = finiteNumber(dimension.max_score);
    if (score !== null && maximum !== null && maximum > 0) {
      accumulator.scored++;
      accumulator.score_total += score;
      accumulator.max_total += maximum;
    }
    var status = typeof dimension.status === "string" ? dimension.status : "fail";
    if (status === "pass") accumulator.pass++;
    else if (status === "warn") accumulator.warn++;
    else if (status === "blocked") accumulator.blocked++;
    else if (status === "insufficient") accumulator.insufficient++;
    else accumulator.fail++;
  }
}

function dimensionRows(accumulators: Record<string, DimensionAccumulator>): JsonRecord[] {
  var keys = Object.keys(accumulators);
  keys.sort();
  var rows: JsonRecord[] = [];
  for (var index = 0; index < keys.length; index++) {
    var value = accumulators[keys[index]];
    rows.push({
      scope: value.scope,
      component: value.key,
      label: value.label,
      runs: value.runs,
      scored_runs: value.scored,
      average_score: average(value.score_total, value.scored),
      average_percent: value.max_total > 0 ? rounded(value.score_total / value.max_total * 100) : null,
      pass: value.pass,
      warn: value.warn,
      fail: value.fail,
      blocked: value.blocked,
      insufficient: value.insufficient
    });
  }
  return rows;
}

function latestProgramRows(programs: GrowthProgram[], latest: Record<string, ScoreRun>): JsonRecord[] {
  var rows: JsonRecord[] = [];
  for (var index = 0; index < programs.length; index++) {
    var program = programs[index];
    var scoreRun = latest[program.key];
    rows.push({
      program_key: program.key,
      state: program.is_active ? "active" : "draft",
      readiness_score: program.readiness_score,
      latest_period: scoreRun ? scoreRun.period_key : null,
      latest_status: scoreRun ? scoreRun.status : "not_evaluated",
      latest_overall_score: scoreRun ? scoreRun.overall_score : null,
      latest_performance_score: scoreRun ? scoreRun.performance_score : null,
      formula_current: scoreRun ? scoreRun.formula_version === CRM_STUDIO_FILE_CONFIG.formula_version : false,
      evaluated_at: scoreRun ? scoreRun.created_at : null
    });
  }
  return rows;
}

export async function buildOperationalStatistics(ctx: CrmContext): Promise<JsonRecord> {
  var window = CRM_STUDIO_FILE_CONFIG.statistics.score_run_window;
  var countResults = await Promise.all([
    ctx.storage.profiles.count(),
    ctx.storage.profiles.count({ marketing_consent: "granted" }),
    ctx.storage.profiles.count({ marketing_consent: "unknown" }),
    ctx.storage.profiles.count({ email_health: "healthy" }),
    ctx.storage.profiles.count({ email_health: "unknown" }),
    ctx.storage.profiles.count({ marketing_consent: "granted", email_health: "healthy", reachability: "email" }),
    ctx.storage.profiles.count({ marketing_consent: "granted", email_health: "healthy", reachability: "multi" }),
    ctx.storage.segmentMembershipStates.count({ status: "open" }),
    ctx.storage.metricFacts.count(),
    ctx.storage.events.count()
  ]);
  var segmentPage = await ctx.storage.segments.query({ limit: window });
  var programPage = await ctx.storage.programs.query({ limit: window, orderBy: { updated_at: "desc" } });
  var templatePage = await ctx.storage.messageTemplates.query({ limit: window, orderBy: { updated_at: "desc" } });
  var scorePage = await ctx.storage.scoreRuns.query({ limit: window, orderBy: { created_at: "desc" } });
  var fileConfig = await inspectFileConfig(ctx);

  var segmentStats: JsonRecord = {
    sampled: segmentPage.items.length,
    truncated: !!segmentPage.hasMore,
    active: 0,
    static: 0,
    dynamic: 0,
    dynamic_materialized: 0,
    dynamic_unmaterialized: 0,
    open_static_memberships: countResults[7]
  };
  for (var segmentIndex = 0; segmentIndex < segmentPage.items.length; segmentIndex++) {
    var segment = segmentPage.items[segmentIndex].data;
    if (segment.is_active) segmentStats.active = (segmentStats.active as number) + 1;
    if (segment.kind === "static") segmentStats.static = (segmentStats.static as number) + 1;
    else {
      segmentStats.dynamic = (segmentStats.dynamic as number) + 1;
      if (segment.active_generation) segmentStats.dynamic_materialized = (segmentStats.dynamic_materialized as number) + 1;
      else segmentStats.dynamic_unmaterialized = (segmentStats.dynamic_unmaterialized as number) + 1;
    }
  }

  var programStats: JsonRecord = { sampled: programPage.items.length, truncated: !!programPage.hasMore, active: 0, draft: 0, average_readiness: null };
  var programReadinessTotal = 0;
  var programs: GrowthProgram[] = [];
  for (var programIndex = 0; programIndex < programPage.items.length; programIndex++) {
    var program = programPage.items[programIndex].data;
    programs.push(program);
    if (program.is_active) programStats.active = (programStats.active as number) + 1;
    else programStats.draft = (programStats.draft as number) + 1;
    programReadinessTotal += program.readiness_score;
  }
  programStats.average_readiness = average(programReadinessTotal, programs.length);

  var templateStats: JsonRecord = { sampled: templatePage.items.length, truncated: !!templatePage.hasMore, active: 0, draft: 0, activation_ready: 0, average_quality: null };
  var templateQualityTotal = 0;
  for (var templateIndex = 0; templateIndex < templatePage.items.length; templateIndex++) {
    var template = templatePage.items[templateIndex].data;
    if (template.is_active) templateStats.active = (templateStats.active as number) + 1;
    else templateStats.draft = (templateStats.draft as number) + 1;
    if (template.quality_score >= CRM_STUDIO_FILE_CONFIG.activation_minimum_score && isResultUnblocked(template.quality_result)) {
      templateStats.activation_ready = (templateStats.activation_ready as number) + 1;
    }
    templateQualityTotal += template.quality_score;
  }
  templateStats.average_quality = average(templateQualityTotal, templatePage.items.length);

  var statusCounts: JsonRecord = { scored: 0, blocked: 0, insufficient_data: 0 };
  var overallTotal = 0;
  var overallCount = 0;
  var readinessTotal = 0;
  var performanceTotal = 0;
  var performanceCount = 0;
  var aggregateSent: number | null = 0;
  var aggregateDelivered: number | null = 0;
  var aggregateClicks: number | null = 0;
  var aggregateConversions: number | null = 0;
  var aggregateComplaints: number | null = 0;
  var aggregateUnsubscribes: number | null = 0;
  var dimensions: Record<string, DimensionAccumulator> = {};
  var latestByProgram: Record<string, ScoreRun> = {};
  var staleFormulaRuns = 0;
  var currentPeriodRuns: ScoreRun[] = [];
  var seenProgramPeriods: Record<string, boolean> = {};
  for (var periodIndex = 0; periodIndex < scorePage.items.length; periodIndex++) {
    var candidateRun = scorePage.items[periodIndex].data;
    var programPeriodKey = candidateRun.program_key + "::" + candidateRun.period_key;
    if (!seenProgramPeriods[programPeriodKey]) {
      seenProgramPeriods[programPeriodKey] = true;
      currentPeriodRuns.push(candidateRun);
    }
  }
  for (var scoreIndex = 0; scoreIndex < currentPeriodRuns.length; scoreIndex++) {
    var run = currentPeriodRuns[scoreIndex];
    statusCounts[run.status] = (statusCounts[run.status] as number) + 1;
    readinessTotal += run.readiness_score;
    if (run.overall_score !== null) {
      overallTotal += run.overall_score;
      overallCount++;
    }
    if (run.performance_score !== null) {
      performanceTotal += run.performance_score;
      performanceCount++;
    }
    if (run.formula_version !== CRM_STUDIO_FILE_CONFIG.formula_version) staleFormulaRuns++;
    if (!latestByProgram[run.program_key]) latestByProgram[run.program_key] = run;
    var metrics = asRecord(run.aggregate_metrics) || {};
    aggregateSent = safeTotal(aggregateSent, metrics.sent);
    aggregateDelivered = safeTotal(aggregateDelivered, metrics.delivered);
    aggregateClicks = safeTotal(aggregateClicks, metrics.unique_clicks);
    aggregateConversions = safeTotal(aggregateConversions, metrics.conversions);
    aggregateComplaints = safeTotal(aggregateComplaints, metrics.complaints);
    aggregateUnsubscribes = safeTotal(aggregateUnsubscribes, metrics.unsubscribes);
    accumulateDimensions(dimensions, "readiness", run.readiness_result);
    accumulateDimensions(dimensions, "template", run.template_quality_result);
    accumulateDimensions(dimensions, "performance", run.performance_result);
  }

  var activeWithoutScore = 0;
  var staleLatestScores = 0;
  var staleBoundary = Date.now() - CRM_STUDIO_FILE_CONFIG.statistics.stale_after_hours * 60 * 60 * 1000;
  for (var staleIndex = 0; staleIndex < programs.length; staleIndex++) {
    if (!programs[staleIndex].is_active) continue;
    var latest = latestByProgram[programs[staleIndex].key];
    if (!latest) activeWithoutScore++;
    else if (latest.formula_version !== CRM_STUDIO_FILE_CONFIG.formula_version || Date.parse(latest.created_at) < staleBoundary) staleLatestScores++;
  }

  var alerts: JsonRecord[] = [];
  if ((segmentStats.dynamic_unmaterialized as number) > 0) alerts.push({ severity: "high", code: "DYNAMIC_SEGMENTS_UNMATERIALIZED", count: segmentStats.dynamic_unmaterialized, action: "Complete recompute checkpoints before program activation." });
  if ((statusCounts.blocked as number) > 0) alerts.push({ severity: "high", code: "BLOCKED_SCORE_RUNS", count: statusCounts.blocked, action: "Review safety guardrails and blocker hints before expansion." });
  if ((statusCounts.insufficient_data as number) > 0) alerts.push({ severity: "medium", code: "INSUFFICIENT_SCORE_RUNS", count: statusCounts.insufficient_data, action: "Collect the configured minimum delivered sample." });
  if (activeWithoutScore > 0) alerts.push({ severity: "medium", code: "ACTIVE_PROGRAMS_NOT_EVALUATED", count: activeWithoutScore, action: "Ingest aggregate facts and evaluate each active program." });
  if (staleLatestScores > 0) alerts.push({ severity: "medium", code: "ACTIVE_PROGRAM_SCORES_STALE", count: staleLatestScores, action: "Evaluate active programs with the current file formula and fresh facts." });
  if (fileConfig.deployment_status !== "acknowledged" || fileConfig.runtime_status !== "clean") alerts.push({ severity: "high", code: "FILE_CONFIG_REVIEW_REQUIRED", count: 1, action: "Open Configuration, review drift, and load the deployed file config." });

  var eligible = countResults[5] + countResults[6];
  return {
    generated_at: new Date().toISOString(),
    formula_version: CRM_STUDIO_FILE_CONFIG.formula_version,
    config_version: CRM_STUDIO_FILE_CONFIG.config_version,
    window: {
      score_runs: window,
      immutable_runs_loaded: scorePage.items.length,
      current_program_period_snapshots: currentPeriodRuns.length,
      score_runs_truncated: !!scorePage.hasMore
    },
    profiles: {
      total: countResults[0],
      consent_granted: countResults[1],
      consent_unknown: countResults[2],
      consent_other: Math.max(0, countResults[0] - countResults[1] - countResults[2]),
      email_health_healthy: countResults[3],
      email_health_unknown: countResults[4],
      email_health_other: Math.max(0, countResults[0] - countResults[3] - countResults[4]),
      eligible_for_messaging: eligible,
      eligible_rate_percent: rate(eligible, countResults[0])
    },
    segments: segmentStats,
    programs: programStats,
    templates: templateStats,
    measurement: {
      fact_revisions_total: countResults[8],
      audit_events_total: countResults[9],
      score_run_status: statusCounts,
      average_overall_score: average(overallTotal, overallCount),
      average_readiness_score: average(readinessTotal, currentPeriodRuns.length),
      average_performance_score: average(performanceTotal, performanceCount),
      stale_formula_runs: staleFormulaRuns,
      aggregate_counts: {
        sent: aggregateSent,
        delivered: aggregateDelivered,
        unique_clicks: aggregateClicks,
        conversions: aggregateConversions,
        complaints: aggregateComplaints,
        unsubscribes: aggregateUnsubscribes
      },
      aggregate_rates_percent: {
        delivery: rate(aggregateDelivered, aggregateSent),
        click: rate(aggregateClicks, aggregateDelivered),
        conversion: rate(aggregateConversions, aggregateDelivered),
        complaint: rate(aggregateComplaints, aggregateDelivered),
        unsubscribe: rate(aggregateUnsubscribes, aggregateDelivered)
      }
    },
    components: dimensionRows(dimensions),
    program_rows: latestProgramRows(programs, latestByProgram),
    alerts: alerts,
    file_config: fileConfig
  };
}

function isResultUnblocked(value: unknown): boolean {
  var result = asRecord(value);
  return !!result && Array.isArray(result.blockers) && result.blockers.length === 0;
}
