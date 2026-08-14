import path from 'node:path';
import fs from 'node:fs';
import { scanCorpus } from '../scan/scanner.js';
import { buildReportData } from '../report/metrics.js';
import { writeJsonReport } from '../report/json.js';
import { renderHtmlReport } from '../report/html.js';
import { loadState, saveState } from '../state/cursor.js';
import { getComparesDir, getBaselinesDir } from '../state/paths.js';
import { compactIsoTimestamp } from '../util/time.js';
import { info } from '../util/log.js';

export class NoBaselineError extends Error {}

// Scans only the increment since the last scan (baseline or previous compare - the I/O cursor is
// monotonic), then statistically compares that increment against the last *explicit* --baseline
// (never a previous --compare's distribution - see the plan's control-chart rationale for why the
// reference must stay fixed rather than rolling).
export async function runCompare({ claudeDir, minN, bootstrapSamples }) {
  const state = loadState();
  if (!state.lastBaseline) {
    throw new NoBaselineError('No baseline found. Run --baseline first.');
  }

  const baselineJsonPath = path.join(getBaselinesDir(), `${state.lastBaseline.id}.json`);
  if (!fs.existsSync(baselineJsonPath)) {
    throw new NoBaselineError(
      `No baseline found. state.json points at "${state.lastBaseline.id}" but ${baselineJsonPath} is missing. Run --baseline again.`
    );
  }
  const baselineReportData = JSON.parse(fs.readFileSync(baselineJsonPath, 'utf8'));

  info(`Scanning ${claudeDir} for activity since ${state.lastBaseline.generatedAt} ...`);
  const scanResult = await scanCorpus(claudeDir, state.fileCursors ?? {});

  const id = `compare-${compactIsoTimestamp()}`;
  const reportData = buildReportData({
    mode: 'compare',
    id,
    claudeDir,
    scanResult,
    baselineReportData,
    baselineRef: state.lastBaseline.id,
    minN,
    bootstrapSamples,
  });

  const comparesDir = getComparesDir();
  fs.mkdirSync(comparesDir, { recursive: true });
  const jsonPath = path.join(comparesDir, `${id}.json`);
  const htmlPath = path.join(comparesDir, `${id}.html`);

  writeJsonReport(jsonPath, reportData);
  fs.writeFileSync(htmlPath, renderHtmlReport(reportData), 'utf8');

  state.lastCompare = { id, generatedAt: reportData.generatedAt, baselineRef: state.lastBaseline.id };
  state.fileCursors = scanResult.fileCursors;
  saveState(state);

  info(`Compare complete: ${reportData.totals.requests.toLocaleString('en-US')} new requests since baseline "${state.lastBaseline.id}".`);
  info(`  ${reportData.comparison?.headlineVerdict ?? 'No new activity since last scan.'}`);
  info(`  JSON: ${jsonPath}`);
  info(`  HTML: ${htmlPath}`);

  return { reportData, jsonPath, htmlPath };
}
