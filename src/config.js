import { defaultClaudeDir } from './state/paths.js';

export const DEFAULT_MIN_N = 10;
export const DEFAULT_BOOTSTRAP_SAMPLES = 1500;

export function resolveConfig(parsed) {
  return {
    claudeDir: parsed.values['claude-dir'] || defaultClaudeDir(),
    minN: parsed.values['min-n'] ? parseInt(parsed.values['min-n'], 10) : DEFAULT_MIN_N,
    bootstrapSamples: parsed.values['bootstrap-samples']
      ? parseInt(parsed.values['bootstrap-samples'], 10)
      : DEFAULT_BOOTSTRAP_SAMPLES,
    quiet: Boolean(parsed.values.quiet),
    verbose: Boolean(parsed.values.verbose),
  };
}
