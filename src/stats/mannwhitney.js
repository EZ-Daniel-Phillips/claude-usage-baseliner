// Mann-Whitney U test with tie-corrected normal approximation and rank-biserial effect size.
// Appropriate for skewed, non-normal data (token/cost distributions) where Welch's t-test / Cohen's d
// would be unreliable. Only meaningful with a reasonable sample size per side; callers should apply
// the N>=minN gate before trusting the result (see mannWhitneyU's `skipped` output below).

const MIN_N_DEFAULT = 10;

// Assigns average ranks to a combined, labeled array of values (ties share the mean of their ranks).
function averageRanks(combined) {
  const sorted = [...combined].sort((a, b) => a.value - b.value);
  const ranks = new Array(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].value === sorted[i].value) j++;
    // ranks are 1-indexed; positions i..j (inclusive) tie, average rank = mean of (i+1)..(j+1)
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avgRank;
    i = j + 1;
  }
  return sorted.map((entry, idx) => ({ ...entry, rank: ranks[idx] }));
}

function effectSizeLabel(absR) {
  if (absR < 0.1) return 'negligible';
  if (absR < 0.3) return 'small';
  if (absR < 0.5) return 'medium';
  return 'large';
}

// Standard normal CDF via the Abramowitz-Stegun approximation (no external deps).
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

export function mannWhitneyU(sampleA, sampleB, { minN = MIN_N_DEFAULT } = {}) {
  const n1 = sampleA.length;
  const n2 = sampleB.length;

  const medianA = sampleA.length ? [...sampleA].sort((a, b) => a - b)[Math.floor((n1 - 1) / 2)] : null;
  const medianB = sampleB.length ? [...sampleB].sort((a, b) => a - b)[Math.floor((n2 - 1) / 2)] : null;
  let directionalTrend = 'flat';
  if (medianA !== null && medianB !== null) {
    if (medianB > medianA) directionalTrend = 'up';
    else if (medianB < medianA) directionalTrend = 'down';
  }

  if (n1 < minN || n2 < minN) {
    return {
      skipped: true,
      reason: `insufficient sample size (n1=${n1}, n2=${n2}, need >=${minN} each)`,
      directionalTrend,
      n1,
      n2,
    };
  }

  const combined = [
    ...sampleA.map((value) => ({ value, group: 'A' })),
    ...sampleB.map((value) => ({ value, group: 'B' })),
  ];
  const ranked = averageRanks(combined);

  const rankSumA = ranked.filter((r) => r.group === 'A').reduce((acc, r) => acc + r.rank, 0);
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;

  // Tie correction for variance
  const rankGroups = new Map();
  for (const r of ranked) {
    rankGroups.set(r.rank, (rankGroups.get(r.rank) || 0) + 1);
  }
  const nTotal = n1 + n2;
  let tieSum = 0;
  for (const count of rankGroups.values()) {
    if (count > 1) tieSum += count ** 3 - count;
  }
  const meanU = (n1 * n2) / 2;
  const varU =
    (n1 * n2 / 12) * (nTotal + 1 - tieSum / (nTotal * (nTotal - 1) || 1));
  const sigmaU = Math.sqrt(Math.max(varU, 0));

  const uMin = Math.min(u1, u2);
  let z = 0;
  if (sigmaU > 0) {
    // continuity correction
    const diff = uMin - meanU;
    const cc = diff < 0 ? 0.5 : -0.5;
    z = (diff + cc) / sigmaU;
  }
  const pValue = 2 * normalCdf(-Math.abs(z));
  const rankBiserial = 1 - (2 * u1) / (n1 * n2);

  return {
    skipped: false,
    n1,
    n2,
    u1,
    u2,
    z,
    pValue: Math.min(1, Math.max(0, pValue)),
    rankBiserial,
    effectSizeLabel: effectSizeLabel(Math.abs(rankBiserial)),
    directionalTrend,
  };
}
