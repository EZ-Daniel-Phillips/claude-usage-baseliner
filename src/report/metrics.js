import { buildDistributionSummary } from '../stats/distribution.js';
import { compareDistributions } from '../stats/compare.js';
import { tokensPerRequest, tokensPerSession, tokensPerActiveHour } from '../stats/rates.js';
import { estimateCostByModel, COST_MODEL_NOTES, byModelHasTtlSplit } from './cost.js';
import { perRequestProfile, decomposeCostChange, buildInsights } from './insights.js';

const TIERS = ['main', 'subagent', 'workflow-agent'];

function sumTokenClasses(records) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  // Tracked separately from the aggregate so the cost model can bill 1h cache writes at 2x instead
  // of 1.25x. `ttlSplitComplete` stays true only while every record reported a breakdown - a partial
  // split would silently under-bill the records that lack one.
  let cc5 = 0;
  let cc1h = 0;
  let ttlSplitComplete = records.length > 0;
  for (const r of records) {
    totals.inputTokens += r.usage.inputTokens;
    totals.outputTokens += r.usage.outputTokens;
    totals.cacheCreationTokens += r.usage.cacheCreationTokens;
    totals.cacheReadTokens += r.usage.cacheReadTokens;
    if (r.usage.cacheCreation5mTokens === null || r.usage.cacheCreation1hTokens === null) {
      ttlSplitComplete = false;
    } else {
      cc5 += r.usage.cacheCreation5mTokens;
      cc1h += r.usage.cacheCreation1hTokens;
    }
  }
  const total = totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
  return {
    ...totals,
    total,
    cacheCreation5mTokens: ttlSplitComplete ? cc5 : null,
    cacheCreation1hTokens: ttlSplitComplete ? cc1h : null,
  };
}

// Exported so mergeReportData.js can recompute a merged report's share from summed token totals
// with the exact same formula, instead of re-deriving it.
export function tokenShare(totals) {
  const t = totals.total || 1; // avoid div-by-zero when there is genuinely no data
  return {
    input: (totals.inputTokens / t) * 100,
    output: (totals.outputTokens / t) * 100,
    cacheCreation: (totals.cacheCreationTokens / t) * 100,
    cacheRead: (totals.cacheReadTokens / t) * 100,
  };
}

function groupTotals(records, keyFn) {
  const groups = new Map();
  for (const r of records) {
    const key = keyFn(r) ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()]
    .map(([key, recs]) => ({ key, requests: recs.length, tokens: sumTokenClasses(recs) }))
    .sort((a, b) => b.tokens.total - a.tokens.total);
}

function buildDistributions(records, bootstrapSamples) {
  return {
    tokensPerRequest: buildDistributionSummary(tokensPerRequest(records), {
      metric: 'tokens per request',
      scope: { tier: 'all' },
      bootstrapSamples,
    }),
    tokensPerSession: buildDistributionSummary(tokensPerSession(records), {
      metric: 'tokens per session',
      scope: { tier: 'all' },
      bootstrapSamples,
    }),
    tokensPerActiveHour: buildDistributionSummary(tokensPerActiveHour(records), {
      metric: 'tokens per active hour',
      scope: { tier: 'all' },
      bootstrapSamples,
    }),
  };
}

function buildCompactionSummary(events) {
  const byTrigger = { manual: 0, auto: 0, unknown: 0 };
  let totalDropped = 0;
  let sumPre = 0;
  let sumPost = 0;
  let sumDuration = 0;
  let durationCount = 0;
  for (const e of events) {
    byTrigger[e.trigger] = (byTrigger[e.trigger] ?? 0) + 1;
    totalDropped += e.cumulativeDroppedTokens ?? 0;
    sumPre += e.preTokens ?? 0;
    sumPost += e.postTokens ?? 0;
    if (typeof e.durationMs === 'number') {
      sumDuration += e.durationMs;
      durationCount += 1;
    }
  }
  const n = events.length;
  return {
    count: n,
    byTrigger,
    totalDroppedTokens: totalDropped,
    avgPreTokens: n ? sumPre / n : null,
    avgPostTokens: n ? sumPost / n : null,
    avgDurationMs: durationCount ? sumDuration / durationCount : null,
  };
}

function topByBytes(events, keyField, limit = 15) {
  const groups = new Map();
  for (const e of events) {
    const key = e[keyField] ?? 'unknown';
    if (!groups.has(key)) groups.set(key, { key, count: 0, totalBytes: 0 });
    const g = groups.get(key);
    g.count += 1;
    g.totalBytes += e.bytes;
  }
  return [...groups.values()].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, limit);
}

function buildToolPayloadTable(toolPayloadStats) {
  return [...toolPayloadStats.entries()]
    .map(([tool, s]) => ({
      tool,
      calls: s.calls,
      totalBytes: s.totalBytes,
      meanBytes: s.calls ? s.totalBytes / s.calls : 0,
      maxBytes: s.maxBytes,
      errors: s.errors,
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

// Builds the full report-data object rendered by both json.js and html.js. `scanResult` is the return
// value of scanCorpus(). For compare reports, pass `baselineReportData` (the loaded prior baseline's
// report-data JSON) so distribution comparisons can be computed against it.
export function buildReportData({
  mode,
  id,
  claudeDir,
  scanResult,
  baselineReportData = null,
  baselineRef = null,
  window = null,
  minN = 10,
  bootstrapSamples = 1500,
}) {
  const records = scanResult.records;
  const totals = sumTokenClasses(records);

  const byTier = {};
  for (const tier of TIERS) {
    const tierRecords = records.filter((r) => r.tier === tier);
    byTier[tier] = { requests: tierRecords.length, tokens: sumTokenClasses(tierRecords) };
  }

  const byAgentType = groupTotals(
    records.filter((r) => r.tier !== 'main'),
    (r) => r.agentType ?? r.tier
  );
  const byModel = groupTotals(records, (r) => r.model);

  const distributions = buildDistributions(records, bootstrapSamples);

  let comparison = null;
  if (mode === 'compare' && baselineReportData) {
    const comparisonDistributions = {
      tokensPerRequest: compareDistributions(
        baselineReportData.distributions.tokensPerRequest,
        distributions.tokensPerRequest,
        { minN }
      ),
      tokensPerSession: compareDistributions(
        baselineReportData.distributions.tokensPerSession,
        distributions.tokensPerSession,
        { minN }
      ),
      tokensPerActiveHour: compareDistributions(
        baselineReportData.distributions.tokensPerActiveHour,
        distributions.tokensPerActiveHour,
        { minN }
      ),
    };
    // The baseline's own report JSON already carries everything needed to re-derive its cost profile
    // (totals + byModel), so a compare can be enriched against a baseline captured by an older
    // version of this tool without rescanning or re-baselining.
    // Both sides must be priced with the same cache-write rules. A baseline captured before the TTL
    // split was recorded has no 5m/1h breakdown, so pricing this window exactly against it would
    // show a ~2.5% cost rise that is purely a change in metering, not in behaviour.
    const ttlMode =
      byModelHasTtlSplit(byModel) && byModelHasTtlSplit(baselineReportData.byModel) ? 'exact' : 'flat';

    const baselineProfile = perRequestProfile(
      baselineReportData.totals.tokens,
      baselineReportData.totals.requests,
      baselineReportData.byModel,
      { ttlMode }
    );
    const compareProfile = perRequestProfile(totals, records.length, byModel, { ttlMode });

    // The decomposition is computed first so the insight text can be like-for-like aware: an
    // aggregate metric and its per-model equivalent can point in opposite directions when the
    // workload moves between models, and the report must report that rather than pick a side.
    const decomposition = decomposeCostChange(baselineProfile, compareProfile);

    comparison = {
      distributions: comparisonDistributions,
      headlineVerdict: comparisonDistributions.tokensPerRequest.verdict,
      baselineProfile,
      compareProfile,
      decomposition,
      insights: buildInsights({
        base: baselineProfile,
        comp: compareProfile,
        comparison: { distributions: comparisonDistributions },
        decomposition,
        baseCompaction: baselineReportData.compaction,
        compCompaction: buildCompactionSummary(scanResult.compactionEvents),
        baseToolPayload: baselineReportData.toolPayload,
        compToolPayload: buildToolPayloadTable(scanResult.toolPayloadStats),
        baseByAgentType: baselineReportData.byAgentType,
        compByAgentType: byAgentType,
      }),
      ttlMode,
    };
  }

  return {
    mode,
    id,
    generatedAt: scanResult.generatedAt,
    claudeDir,
    baselineRef,
    // Which period this report actually covers. Previously unrecorded, which made it impossible to
    // tell from a stored report what window its numbers described.
    window,
    scan: {
      filesScanned: scanResult.filesScanned,
      newFiles: scanResult.newFiles,
      corruptLineCount: scanResult.corruptLineCount,
      boundaryReconciliations: scanResult.boundaryReconciliations,
      outOfWindowLines: scanResult.outOfWindowLines ?? 0,
      undatedLinesSkipped: scanResult.undatedLinesSkipped ?? 0,
    },
    totals: { requests: records.length, tokens: totals, tokenShare: tokenShare(totals) },
    cost: { ...estimateCostByModel(byModel), model: COST_MODEL_NOTES },
    profile: perRequestProfile(totals, records.length, byModel),
    byTier,
    byAgentType,
    byModel,
    distributions,
    compaction: buildCompactionSummary(scanResult.compactionEvents),
    attachments: {
      topSkills: topByBytes(scanResult.skillInvocations, 'skillName'),
      topNestedMemory: topByBytes(scanResult.nestedMemoryEvents, 'path'),
    },
    toolPayload: buildToolPayloadTable(scanResult.toolPayloadStats),
    workflowDefinitions: {
      count: scanResult.workflowDefinitions.length,
      totalScriptBytes: scanResult.workflowDefinitions.reduce((acc, w) => acc + (w.scriptByteLength ?? 0), 0),
    },
    comparison,
  };
}
