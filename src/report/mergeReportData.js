// Combines two or more --baseline/--compare report-data JSON objects (e.g. one dumped from each of
// several machines) into a single report-data object shaped exactly like a --baseline report, so it
// renders with the ordinary renderHtmlReport() unchanged. The most common use: two machines each ran
// --baseline (or --compare) at their own pace, and you want one combined view of your fleet's total
// usage rather than switching between two files.
//
// A merged report always has `mode: 'baseline'` and `comparison: null`, whatever mix of --baseline
// and --compare sources went in. Mixing the two is allowed - a --baseline's window is "everything
// ever scanned on that machine" and a --compare's is "everything since that machine's own baseline",
// and both are stored in an identical shape (totals/byModel/byAgentType/byTier/distributions/
// toolPayload/compaction all describe "this report's own window"), so summing them is mechanical.
// What is NOT attempted is a combined before/after verdict: a --compare report does not persist its
// baseline's raw per-agent-type/tool-payload/compaction data (only the already-computed findings
// derived from it), so there isn't enough on disk to rebuild a rigorous merged comparison - only an
// approximate one, and this tool does not fake precision it cannot back up. Each source's own window
// is disclosed in the `sources` table instead, so the reader can judge comparability themselves.
//
// Statistical honesty note: every report-data JSON stores EXACT totals (n, sum, min, max) for its
// distributions, but only a bounded random sample (up to 5,000 values) for anything that needs the
// raw values (percentiles, bootstrap CIs). So a merged report's n/mean/min/max are exact, but its
// median/percentiles/bootstrap CIs are recomputed from a combined sample - see mergeDistribution()
// below for how sources of very different sizes are weighted so a small source cannot dominate a
// much larger one just because both contribute an equally-sized stored sample.

import { estimateCostByModel, COST_MODEL_NOTES } from './cost.js';
import { perRequestProfile } from './insights.js';
import { tokenShare } from './metrics.js';
import { reservoirSample } from '../stats/distribution.js';
import { percentile, stdev } from '../stats/percentiles.js';
import { bootstrapMedianCI, bootstrapP85CI } from '../stats/bootstrap.js';

export class MergeReportDataError extends Error {}

function sumField(list, fn) {
  return list.reduce((acc, r) => acc + (fn(r) ?? 0), 0);
}

// Null-safe sum of already-aggregated token-class bundles (as found in byModel/byTier/totals rows),
// mirroring metrics.js's sumTokenClasses() but operating on pre-summed bundles instead of raw
// records. The TTL split (cacheCreation5mTokens/1hTokens) is only kept if EVERY bundle carried one -
// a partial split would silently under-bill whichever bundles lacked it.
function sumTokenBundles(bundles) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  let cc5 = 0;
  let cc1h = 0;
  let ttlComplete = bundles.length > 0;
  for (const t of bundles) {
    totals.inputTokens += t.inputTokens;
    totals.outputTokens += t.outputTokens;
    totals.cacheCreationTokens += t.cacheCreationTokens;
    totals.cacheReadTokens += t.cacheReadTokens;
    if (typeof t.cacheCreation5mTokens !== 'number' || typeof t.cacheCreation1hTokens !== 'number') {
      ttlComplete = false;
    } else {
      cc5 += t.cacheCreation5mTokens;
      cc1h += t.cacheCreation1hTokens;
    }
  }
  const total = totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
  return {
    ...totals,
    total,
    cacheCreation5mTokens: ttlComplete ? cc5 : null,
    cacheCreation1hTokens: ttlComplete ? cc1h : null,
  };
}

// Merges N arrays of {key, requests, tokens} rows (byModel/byAgentType shape) by unioning keys and
// summing requests/tokens for every row sharing a key, re-sorted by total tokens descending - the
// same order groupTotals() in metrics.js produces.
function mergeKeyedTotals(sourceArrays) {
  const groups = new Map();
  for (const arr of sourceArrays) {
    for (const row of arr ?? []) {
      if (!groups.has(row.key)) groups.set(row.key, []);
      groups.get(row.key).push(row);
    }
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      requests: rows.reduce((a, r) => a + r.requests, 0),
      tokens: sumTokenBundles(rows.map((r) => r.tokens)),
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total);
}

function mergeByTier(tierObjects) {
  const tiers = ['main', 'subagent', 'workflow-agent'];
  const out = {};
  for (const tier of tiers) {
    const rows = tierObjects.map((o) => o?.[tier]).filter(Boolean);
    out[tier] = {
      requests: rows.reduce((a, r) => a + r.requests, 0),
      tokens: sumTokenBundles(rows.map((r) => r.tokens)),
    };
  }
  return out;
}

function mergeCompaction(compactions) {
  const rows = (compactions ?? []).filter(Boolean);
  const byTrigger = { manual: 0, auto: 0, unknown: 0 };
  for (const c of rows) {
    for (const k of Object.keys(byTrigger)) byTrigger[k] += c.byTrigger?.[k] ?? 0;
  }
  // Weighted by each source's own compaction count, not a plain average of averages - a source with
  // one compaction must not carry the same weight as one with a thousand.
  const weightedAvg = (field) => {
    let wsum = 0;
    let wcount = 0;
    for (const c of rows) {
      if (typeof c[field] !== 'number' || !c.count) continue;
      wsum += c[field] * c.count;
      wcount += c.count;
    }
    return wcount ? wsum / wcount : null;
  };
  return {
    count: rows.reduce((a, c) => a + c.count, 0),
    byTrigger,
    totalDroppedTokens: rows.reduce((a, c) => a + (c.totalDroppedTokens ?? 0), 0),
    avgPreTokens: weightedAvg('avgPreTokens'),
    avgPostTokens: weightedAvg('avgPostTokens'),
    avgDurationMs: weightedAvg('avgDurationMs'),
  };
}

function mergeToolPayload(payloadArrays) {
  const groups = new Map();
  for (const arr of payloadArrays) {
    for (const row of arr ?? []) {
      if (!groups.has(row.tool)) groups.set(row.tool, { tool: row.tool, calls: 0, totalBytes: 0, maxBytes: 0, errors: 0 });
      const g = groups.get(row.tool);
      g.calls += row.calls;
      g.totalBytes += row.totalBytes;
      g.maxBytes = Math.max(g.maxBytes, row.maxBytes ?? 0);
      g.errors += row.errors;
    }
  }
  return [...groups.values()]
    .map((g) => ({ ...g, meanBytes: g.calls ? g.totalBytes / g.calls : 0 }))
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

function mergeTopByBytes(arrays, limit = 15) {
  const groups = new Map();
  for (const arr of arrays) {
    for (const row of arr ?? []) {
      if (!groups.has(row.key)) groups.set(row.key, { key: row.key, count: 0, totalBytes: 0 });
      const g = groups.get(row.key);
      g.count += row.count;
      g.totalBytes += row.totalBytes;
    }
  }
  return [...groups.values()].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, limit);
}

// Proportionally-weighted draw from each source's stored sample, so a source that only kept a
// reservoir sample of a much larger population isn't outweighed by a smaller source whose sample
// happens to be the same stored size. Each source's own sample is already a uniform random subset of
// that source's true population, so a further uniform subset of it (reservoirSample again) stays a
// uniform random subset of that source - the combined draw is therefore representative of the true
// combined population, not just of the stored samples' sizes.
function weightedMergeSample(sources, targetSize) {
  const totalN = sources.reduce((a, s) => a + s.n, 0);
  if (totalN === 0 || targetSize === 0) return [];
  const raw = sources.map((s) => (s.n / totalN) * targetSize);
  const want = raw.map(Math.floor);
  let used = want.reduce((a, b) => a + b, 0);
  // Largest-remainder method: hand out the leftover slots (from rounding down) to the sources with
  // the biggest fractional remainder, so the total drawn always matches targetSize exactly.
  const remainders = raw.map((v, i) => ({ i, frac: v - want[i] })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < targetSize && k < remainders.length; k++, used++) {
    want[remainders[k].i] += 1;
  }
  const merged = [];
  sources.forEach((s, i) => {
    const n = Math.min(want[i], s.sample.length);
    merged.push(...reservoirSample(s.sample, n));
  });
  return merged;
}

// Merges N buildDistributionSummary()-shaped objects for the SAME metric into one of the same shape,
// so it drops straight into distributionSection()/distributionTable() unchanged. n/sum/mean/min/max
// are exact (every source already carries its own exact totals); median/percentiles/stdev/bootstrap
// CIs are recomputed from a combined weighted sample and are therefore an estimate whenever any
// source itself held more values than its stored sample - `sampled` is set to disclose this.
export function mergeDistributionSummary(sources, { bootstrapSamples = 1500, maxSampleSize = 5000 } = {}) {
  const live = (sources ?? []).filter((s) => s && s.n > 0);
  const metric = sources?.[0]?.metric ?? 'unknown';
  const scope = sources?.[0]?.scope ?? {};
  if (!live.length) {
    return {
      metric,
      scope,
      n: 0,
      sum: 0,
      mean: null,
      stdev: null,
      median: null,
      percentiles: { p50: null, p75: null, p85: null, p95: null },
      min: null,
      max: null,
      lowConfidencePercentiles: true,
      bootstrapCI: null,
      sample: [],
      sampled: false,
      maxSampleSize,
    };
  }

  const n = live.reduce((a, s) => a + s.n, 0);
  const sum = live.reduce((a, s) => a + s.sum, 0);
  const mean = sum / n;
  const min = Math.min(...live.map((s) => s.min));
  const max = Math.max(...live.map((s) => s.max));
  const anySourceAlreadySampled = live.some((s) => s.sampled);

  const targetSize = Math.min(n, maxSampleSize);
  const sample = weightedMergeSample(live, targetSize);
  const sampled = anySourceAlreadySampled || sample.length < n;

  const percentiles = {
    p50: percentile(sample, 0.5),
    p75: percentile(sample, 0.75),
    p85: percentile(sample, 0.85),
    p95: percentile(sample, 0.95),
  };
  const bootstrapCI =
    sample.length >= 2
      ? { median: bootstrapMedianCI(sample, { resamples: bootstrapSamples }), p85: bootstrapP85CI(sample, { resamples: bootstrapSamples }) }
      : null;

  return {
    metric,
    scope,
    n,
    sum,
    mean,
    stdev: stdev(sample),
    median: percentiles.p50,
    percentiles,
    min,
    max,
    lowConfidencePercentiles: n < 20 || sample.length < 20,
    bootstrapCI,
    sample,
    sampled,
    maxSampleSize,
  };
}

// Short, human-readable description of what window one source report actually covers, for the
// sources table - the only place a reader can tell whether combining these particular reports is a
// like-for-like thing to do.
function describeWindow(rd) {
  if (rd.mode === 'baseline') return 'everything scanned as of this baseline';
  if (rd.window?.mode === 'since-baseline') return `everything since baseline (from ${rd.window.start})`;
  if (rd.window?.mode === 'since-last-scan') return `since the previous scan only (from ${rd.window.start})`;
  return 'unknown window';
}

export function mergeReportData(reportDataList, { id, generatedAt, bootstrapSamples = 1500 } = {}) {
  if (!Array.isArray(reportDataList) || reportDataList.length < 2) {
    throw new MergeReportDataError(`mergeReportData needs at least 2 report-data objects, got ${reportDataList?.length ?? 0}.`);
  }
  for (const rd of reportDataList) {
    if (rd.mode !== 'baseline' && rd.mode !== 'compare') {
      throw new MergeReportDataError(
        `Every --input must be a --baseline or --compare report JSON. Got a report with mode "${rd.mode}" - --visualise JSON reports must be merged separately, without mixing in --baseline/--compare files.`
      );
    }
  }

  const scan = {
    filesScanned: sumField(reportDataList, (r) => r.scan.filesScanned),
    newFiles: sumField(reportDataList, (r) => r.scan.newFiles),
    corruptLineCount: sumField(reportDataList, (r) => r.scan.corruptLineCount),
    boundaryReconciliations: sumField(reportDataList, (r) => r.scan.boundaryReconciliations),
    outOfWindowLines: sumField(reportDataList, (r) => r.scan.outOfWindowLines),
    undatedLinesSkipped: sumField(reportDataList, (r) => r.scan.undatedLinesSkipped),
  };

  const byModel = mergeKeyedTotals(reportDataList.map((r) => r.byModel));
  const byAgentType = mergeKeyedTotals(reportDataList.map((r) => r.byAgentType));
  const byTier = mergeByTier(reportDataList.map((r) => r.byTier));

  const totalsTokens = sumTokenBundles(reportDataList.map((r) => r.totals.tokens));
  const totals = {
    requests: sumField(reportDataList, (r) => r.totals.requests),
    tokens: totalsTokens,
    tokenShare: tokenShare(totalsTokens),
  };

  const distributions = {
    tokensPerRequest: mergeDistributionSummary(
      reportDataList.map((r) => r.distributions.tokensPerRequest),
      { bootstrapSamples }
    ),
    tokensPerSession: mergeDistributionSummary(
      reportDataList.map((r) => r.distributions.tokensPerSession),
      { bootstrapSamples }
    ),
    tokensPerActiveHour: mergeDistributionSummary(
      reportDataList.map((r) => r.distributions.tokensPerActiveHour),
      { bootstrapSamples }
    ),
  };

  const compaction = mergeCompaction(reportDataList.map((r) => r.compaction));
  const toolPayload = mergeToolPayload(reportDataList.map((r) => r.toolPayload));
  const attachments = {
    topSkills: mergeTopByBytes(reportDataList.map((r) => r.attachments?.topSkills)),
    topNestedMemory: mergeTopByBytes(reportDataList.map((r) => r.attachments?.topNestedMemory)),
  };
  const workflowDefinitions = {
    count: sumField(reportDataList, (r) => r.workflowDefinitions?.count),
    totalScriptBytes: sumField(reportDataList, (r) => r.workflowDefinitions?.totalScriptBytes),
  };

  return {
    // Always a standing snapshot, never a compare verdict - see this file's header for why a
    // rigorous merged before/after isn't attempted.
    mode: 'baseline',
    id,
    generatedAt,
    claudeDir: null,
    baselineRef: null,
    window: null,
    scan,
    totals,
    cost: { ...estimateCostByModel(byModel), model: COST_MODEL_NOTES },
    profile: perRequestProfile(totals.tokens, totals.requests, byModel),
    byTier,
    byAgentType,
    byModel,
    distributions,
    compaction,
    attachments,
    toolPayload,
    workflowDefinitions,
    comparison: null,
    sources: reportDataList.map((r) => ({
      id: r.id,
      mode: r.mode,
      claudeDir: r.claudeDir,
      generatedAt: r.generatedAt,
      requests: r.totals.requests,
      filesScanned: r.scan.filesScanned,
      windowDescription: describeWindow(r),
      baselineRef: r.baselineRef ?? null,
    })),
  };
}
