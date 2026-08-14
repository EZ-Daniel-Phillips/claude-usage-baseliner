import fs from 'node:fs';
import path from 'node:path';

// toolPayload/byAgentType/etc are already plain arrays/objects in reportData; the only non-JSON-safe
// value that could appear is a Map (toolPayloadStats is consumed into an array by metrics.js before
// this is called, so JSON.stringify here is safe as-is).
export function writeJsonReport(filePath, reportData) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(reportData, null, 2), 'utf8');
}
