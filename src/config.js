import { defaultClaudeDir } from './state/paths.js';

export const DEFAULT_MIN_N = 10;
export const DEFAULT_BOOTSTRAP_SAMPLES = 1500;
export const DEFAULT_MAX_CACHE_AGE_DAYS = 2;

export function resolveConfig(parsed) {
  return {
    claudeDir: parsed.values['claude-dir'] || defaultClaudeDir(),
    minN: parsed.values['min-n'] ? parseInt(parsed.values['min-n'], 10) : DEFAULT_MIN_N,
    bootstrapSamples: parsed.values['bootstrap-samples']
      ? parseInt(parsed.values['bootstrap-samples'], 10)
      : DEFAULT_BOOTSTRAP_SAMPLES,
    sinceLast: Boolean(parsed.values['since-last']),
    maxCacheAgeDays: parsed.values['max-cache-age'] ? parseInt(parsed.values['max-cache-age'], 10) : DEFAULT_MAX_CACHE_AGE_DAYS,
    allowStaleCache: Boolean(parsed.values['allow-stale-cache']),
    planCostPerMonth: (() => {
      if (!parsed.values['plan-cost']) return null;
      const v = parseFloat(parsed.values['plan-cost']);
      return Number.isFinite(v) && v > 0 ? v : null;
    })(),
    quiet: Boolean(parsed.values.quiet),
    verbose: Boolean(parsed.values.verbose),
  };
}
