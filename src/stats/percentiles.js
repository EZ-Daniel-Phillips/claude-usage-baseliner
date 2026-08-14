// Linear-interpolation percentile (NumPy default / R type-7). Values must already be sorted ascending.
export function percentileSorted(sortedValues, p) {
  const n = sortedValues.length;
  if (n === 0) return null;
  if (n === 1) return sortedValues[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (idx - lo) * (sortedValues[hi] - sortedValues[lo]);
}

export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return percentileSorted(sorted, p);
}

export function median(values) {
  return percentile(values, 0.5);
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Sample standard deviation (n-1 denominator). Returns null when fewer than 2 values.
export function stdev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  const sumSq = values.reduce((acc, v) => acc + (v - m) ** 2, 0);
  return Math.sqrt(sumSq / (values.length - 1));
}

// Full numeric summary for a distribution of raw values.
export function summarizeNumeric(values) {
  const n = values.length;
  if (n === 0) {
    return {
      n: 0, sum: 0, mean: null, stdev: null, median: null,
      percentiles: { p50: null, p75: null, p85: null, p95: null },
      min: null, max: null,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n,
    sum,
    mean: mean(sorted),
    stdev: stdev(sorted),
    median: percentileSorted(sorted, 0.5),
    percentiles: {
      p50: percentileSorted(sorted, 0.5),
      p75: percentileSorted(sorted, 0.75),
      p85: percentileSorted(sorted, 0.85),
      p95: percentileSorted(sorted, 0.95),
    },
    min: sorted[0],
    max: sorted[n - 1],
  };
}
