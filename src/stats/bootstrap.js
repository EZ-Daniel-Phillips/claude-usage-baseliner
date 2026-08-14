import { median, percentile } from './percentiles.js';

// Plain percentile bootstrap CI (not bias-corrected/BCa - that's overkill for this tool).
// Resamples with replacement `resamples` times, recomputes statFn on each resample, and takes the
// (1-ciLevel)/2 / 1-(1-ciLevel)/2 percentiles of the resampled statistic distribution as bounds.
export function percentileBootstrapCI(values, statFn, { resamples = 1500, ciLevel = 0.9 } = {}) {
  const n = values.length;
  if (n === 0) return null;
  if (n === 1) {
    const v = statFn(values);
    return { low: v, high: v, level: ciLevel, resamples, approximate: true };
  }

  const stats = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    const resample = new Array(n);
    for (let j = 0; j < n; j++) {
      resample[j] = values[Math.floor(Math.random() * n)];
    }
    stats[i] = statFn(resample);
  }
  stats.sort((a, b) => a - b);

  const alpha = (1 - ciLevel) / 2;
  const low = percentile(stats, alpha);
  const high = percentile(stats, 1 - alpha);

  return { low, high, level: ciLevel, resamples, approximate: true };
}

export function bootstrapMedianCI(values, opts) {
  return percentileBootstrapCI(values, median, opts);
}

export function bootstrapP85CI(values, opts) {
  return percentileBootstrapCI(values, (v) => percentile(v, 0.85), opts);
}
