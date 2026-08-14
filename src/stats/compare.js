import { mannWhitneyU } from './mannwhitney.js';

function pctChange(from, to) {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  if (from === 0) return to === 0 ? 0 : null; // avoid divide-by-zero; null = "undefined change"
  return ((to - from) / Math.abs(from)) * 100;
}

function fmtPct(p) {
  if (p === null) return 'n/a';
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(1)}%`;
}

// Compares a compare-window distribution summary against its baseline reference. Both summaries must
// be built via buildDistributionSummary (same metric). The statistical reference is always the
// baseline that was passed in - never a rolling prior-compare - per the plan's control-chart rationale.
export function compareDistributions(baselineSummary, compareSummary, { minN = 10 } = {}) {
  const medianPctChange = pctChange(baselineSummary.median, compareSummary.median);

  const percentileDeltas = {};
  for (const key of ['p50', 'p75', 'p85', 'p95']) {
    const baseVal = baselineSummary.percentiles[key];
    const compVal = compareSummary.percentiles[key];
    percentileDeltas[key] = {
      baseline: baseVal,
      compare: compVal,
      pctChange: pctChange(baseVal, compVal),
      lowConfidence: baselineSummary.lowConfidencePercentiles || compareSummary.lowConfidencePercentiles,
    };
  }

  const mannWhitney = mannWhitneyU(baselineSummary.sample, compareSummary.sample, { minN });

  let verdict;
  if (compareSummary.n === 0) {
    verdict = 'No new activity since last scan.';
  } else if (mannWhitney.skipped) {
    const dir = mannWhitney.directionalTrend;
    const dirWord = dir === 'up' ? 'higher than' : dir === 'down' ? 'lower than' : 'flat vs.';
    verdict = `Median ${baselineSummary.metric} ${fmtPct(medianPctChange)} vs baseline (directional only - ${mannWhitney.reason}); trend is ${dirWord} baseline.`;
  } else {
    const sig = mannWhitney.pValue < 0.05 ? 'statistically significant' : 'not statistically significant at p<0.05';
    verdict = `Median ${baselineSummary.metric} ${fmtPct(medianPctChange)} vs baseline (${sig}, effect size ${mannWhitney.effectSizeLabel}, rank-biserial r=${mannWhitney.rankBiserial.toFixed(2)}).`;
  }

  return {
    metric: baselineSummary.metric,
    scope: baselineSummary.scope,
    baseline: baselineSummary,
    compare: compareSummary,
    medianPctChange,
    percentileDeltas,
    mannWhitney,
    verdict,
  };
}
