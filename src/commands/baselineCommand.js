import path from 'node:path';
import { scanCorpus } from '../scan/scanner.js';
import { buildReportData } from '../report/metrics.js';
import { writeJsonReport } from '../report/json.js';
import { renderHtmlReport } from '../report/html.js';
import { loadState, saveState } from '../state/cursor.js';
import { getBaselinesDir } from '../state/paths.js';
import { compactIsoTimestamp } from '../util/time.js';
import fs from 'node:fs';
import { info } from '../util/log.js';

// Full scan of everything currently available under claudeDir. Establishes a fresh reference point:
// state.lastBaseline is updated (never lastCompare - only an explicit --baseline moves the reference
// distribution; see the plan's control-chart rationale). Cursor-wise this is equivalent to a
// --compare with an empty prior cursor map, since a first-ever run has nothing to resume from.
export async function runBaseline({ claudeDir, minN, bootstrapSamples }) {
  info(`Scanning ${claudeDir} ...`);
  const scanResult = await scanCorpus(claudeDir, {});

  const id = `baseline-${compactIsoTimestamp()}`;
  const reportData = buildReportData({
    mode: 'baseline',
    id,
    claudeDir,
    scanResult,
    minN,
    bootstrapSamples,
  });

  const baselinesDir = getBaselinesDir();
  fs.mkdirSync(baselinesDir, { recursive: true });
  const jsonPath = path.join(baselinesDir, `${id}.json`);
  const htmlPath = path.join(baselinesDir, `${id}.html`);

  writeJsonReport(jsonPath, reportData);
  fs.writeFileSync(htmlPath, renderHtmlReport(reportData), 'utf8');

  const state = loadState();
  state.lastBaseline = { id, generatedAt: reportData.generatedAt };
  state.fileCursors = scanResult.fileCursors;
  saveState(state);

  info(`Baseline complete: ${fmtSummary(reportData)}`);
  info(`  JSON: ${jsonPath}`);
  info(`  HTML: ${htmlPath}`);

  return { reportData, jsonPath, htmlPath };
}

function fmtSummary(reportData) {
  return `${reportData.totals.requests.toLocaleString('en-US')} requests across ${reportData.scan.filesScanned.toLocaleString('en-US')} files, ${reportData.totals.tokens.total.toLocaleString('en-US')} total tokens`;
}
