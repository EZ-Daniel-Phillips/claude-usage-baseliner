import { summarizeNumeric, median, percentile } from './percentiles.js';
import { bootstrapMedianCI, bootstrapP85CI } from './bootstrap.js';

const LOW_CONFIDENCE_PERCENTILE_N = 20;

// Reservoir sampling (Algorithm R) - unbiased random sample of size k from a full in-memory array.
// Used to cap the raw-value array stored in JSON dumps (a baseline can have hundreds of thousands of
// values; only a bounded sample needs to survive so a later --compare can run Mann-Whitney/bootstrap
// against the stored baseline without keeping the full dataset around).
export function reservoirSample(values, k) {
  const n = values.length;
  if (n <= k) return [...values];
  const sample = values.slice(0, k);
  for (let i = k; i < n; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < k) sample[j] = values[i];
  }
  return sample;
}

// Canonical distribution-summary shape, shared by baseline and compare JSON dumps.
// `values` is the full in-memory numeric array for this metric (exact stats computed from it);
// only a bounded reservoir sample is retained in the returned object for storage.
export function buildDistributionSummary(
  values,
  { metric, scope = {}, maxSampleSize = 5000, bootstrapSamples = 1500 } = {}
) {
  const summary = summarizeNumeric(values);
  const n = values.length;
  const lowConfidencePercentiles = n < LOW_CONFIDENCE_PERCENTILE_N;

  let bootstrapCI = null;
  if (n >= 2) {
    bootstrapCI = {
      median: bootstrapMedianCI(values, { resamples: bootstrapSamples }),
      p85: bootstrapP85CI(values, { resamples: bootstrapSamples }),
    };
  }

  const sampled = n > maxSampleSize;
  const sample = sampled ? reservoirSample(values, maxSampleSize) : [...values];

  return {
    metric,
    scope,
    n: summary.n,
    sum: summary.sum,
    mean: summary.mean,
    stdev: summary.stdev,
    median: summary.median,
    percentiles: summary.percentiles,
    min: summary.min,
    max: summary.max,
    lowConfidencePercentiles,
    bootstrapCI,
    sample,
    sampled,
    maxSampleSize,
  };
}

export { median, percentile };
