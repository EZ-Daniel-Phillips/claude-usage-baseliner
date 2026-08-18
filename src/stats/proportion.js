// Two-proportion significance testing, for rate metrics like "errors per tool call".
//
// The percentile machinery in this package compares distributions of magnitudes. A failure rate is a
// different shape of question - two counts out of two totals - and needs its own test, otherwise a
// quality regression can only ever be eyeballed.

// Normal CDF, via the Abramowitz & Stegun 7.1.26 erf approximation (max error ~1.5e-7 - far below
// anything that matters for a p-value we only ever threshold at 0.05).
function erf(x) {
  const sign = Math.sign(x);
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// Wilson score interval - preferred over the normal approximation because it stays inside [0,1] and
// stays sensible at small counts, which is exactly the regime a compare window sits in.
export function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return null;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half), level: 0.95 };
}

// Pooled two-proportion z-test. `minCount` guards against reporting significance off a handful of
// events - below it the result is returned as skipped, mirroring how mannwhitney.js handles small n.
export function twoProportionTest(successes1, total1, successes2, total2, { minCount = 30 } = {}) {
  if (!total1 || !total2 || total1 < minCount || total2 < minCount) {
    return {
      skipped: true,
      reason: `insufficient observations (n1=${total1}, n2=${total2}, need ${minCount} per side)`,
      rate1: total1 ? successes1 / total1 : null,
      rate2: total2 ? successes2 / total2 : null,
      direction: null,
    };
  }

  const p1 = successes1 / total1;
  const p2 = successes2 / total2;
  const pooled = (successes1 + successes2) / (total1 + total2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / total1 + 1 / total2));

  // A zero standard error means both sides are all-successes or all-failures: no signal, not a
  // divide-by-zero to propagate as Infinity.
  if (!se) {
    return { skipped: false, rate1: p1, rate2: p2, z: 0, pValue: 1, significant: false, direction: 'flat', ci2: wilsonInterval(successes2, total2) };
  }

  const z = (p2 - p1) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return {
    skipped: false,
    rate1: p1,
    rate2: p2,
    z,
    pValue,
    significant: pValue < 0.05,
    direction: p2 > p1 ? 'up' : p2 < p1 ? 'down' : 'flat',
    ci2: wilsonInterval(successes2, total2),
  };
}
