import os from 'node:os';
import path from 'node:path';

// Always resolved from the user's home directory, never from process.cwd() or the repo location -
// output must persist across repo/machine lifecycles independent of where this tool is installed/run.
export function getOutputRoot() {
  return path.join(os.homedir(), '.claude', 'claude-usage-baseliner');
}

export function getStateFilePath() {
  return path.join(getOutputRoot(), 'state.json');
}

export function getBaselinesDir() {
  return path.join(getOutputRoot(), 'baselines');
}

export function getComparesDir() {
  return path.join(getOutputRoot(), 'compares');
}

// Separate from baselines/ and compares/ by construction: --visualise never reads or writes
// state.json, so it cannot perturb the baseline/compare reference point no matter what it does.
export function getVisualiseDir() {
  return path.join(getOutputRoot(), 'visualise');
}

// Also separate from baselines/ and compares/: a merged --baseline/--compare report is a read-only,
// standalone snapshot assembled from other reports' JSON. It is never state.json's lastBaseline, and
// can never be passed to --compare as a reference point, so it must never be mistaken for one of the
// real per-machine files those directories hold.
export function getMergedReportsDir() {
  return path.join(getOutputRoot(), 'merged');
}

export function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}
