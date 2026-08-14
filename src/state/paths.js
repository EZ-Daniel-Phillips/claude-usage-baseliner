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

export function defaultClaudeDir() {
  return path.join(os.homedir(), '.claude');
}
