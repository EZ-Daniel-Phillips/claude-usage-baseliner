import fs from 'node:fs';
import path from 'node:path';
import { getStateFilePath } from './paths.js';

const STATE_VERSION = 1;

function emptyState() {
  return { version: STATE_VERSION, lastBaseline: null, lastCompare: null, fileCursors: {} };
}

export function loadState() {
  const statePath = getStateFilePath();
  if (!fs.existsSync(statePath)) return emptyState();
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
  } catch {
    // Corrupt state file - safer to treat as fresh than to crash the tool; the next --baseline
    // re-establishes everything (a --compare will correctly hard-error with "no baseline found").
    return emptyState();
  }
}

export function saveState(state) {
  const statePath = getStateFilePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}
