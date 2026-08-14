import fs from 'node:fs';

// Parses a ~/.claude/workflows/wf_<runId>.json run-definition file, stripping the embedded `.script`
// field (observed 30-150KB+ of raw orchestration JS) at parse time so it never touches memory-resident
// aggregates or the JSON dump - only a byte length + short preview survive.
export function parseWorkflowDefinition(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  const script = obj.script;
  delete obj.script;

  return {
    ...obj,
    scriptByteLength: typeof script === 'string' ? Buffer.byteLength(script, 'utf8') : 0,
    scriptPreview: typeof script === 'string' ? script.slice(0, 200) : null,
  };
}
