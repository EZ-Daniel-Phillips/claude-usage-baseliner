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

// Measures ALL activity since the last explicit --baseline and compares it against that baseline.
//
// This is deliberately a content-time window, not a read-position one. The original implementation
// resumed from a monotonic byte-offset cursor and advanced it on every run, which meant each compare
// consumed its own window: running --compare twice in a row reported the full period and then just
// the handful of requests written in between, with the statistics collapsing to n=1 and the
// headline percentage swinging on a single sample. Because the cursor advanced, that period could
// never be measured again. Anchoring to the baseline's timestamp instead makes a compare
// repeatable, cumulative and monotonically growing - the same question always gets the same answer.
//
// `sinceLast` restores the old incremental behaviour for the "what happened in the last little
// while" question, which is a legitimate thing to ask, just not the default.
//
// The reference distribution is always the last explicit --baseline, never a previous --compare, so
// the yardstick only moves when you deliberately move it.
export async function runCompare({ claudeDir, minN, bootstrapSamples, sinceLast = false }) {
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

  // Cumulative mode reads the whole corpus and filters by timestamp, so it does not depend on cursor
  // state at all - which also means it works against a baseline taken before this fix, whose cursors
  // have long since been advanced past it.
  const baselineMs = Date.parse(state.lastBaseline.generatedAt);
  const windowStart = sinceLast ? (state.lastCompare?.generatedAt ?? state.lastBaseline.generatedAt) : state.lastBaseline.generatedAt;

  info(
    sinceLast
      ? `Scanning ${claudeDir} for activity since the last scan (${windowStart}) ...`
      : `Scanning ${claudeDir} for all activity since baseline "${state.lastBaseline.id}" (${state.lastBaseline.generatedAt}) ...`
  );

  const scanResult = sinceLast
    ? await scanCorpus(claudeDir, state.fileCursors ?? {})
    : await scanCorpus(claudeDir, {}, { sinceMs: baselineMs });

  const id = `compare-${compactIsoTimestamp()}`;
  const reportData = buildReportData({
    mode: 'compare',
    id,
    claudeDir,
    scanResult,
    baselineReportData,
    baselineRef: state.lastBaseline.id,
    window: {
      mode: sinceLast ? 'since-last-scan' : 'since-baseline',
      start: windowStart,
      end: null, // filled in below from the scan's own completion time
    },
    minN,
    bootstrapSamples,
  });
  reportData.window.end = reportData.generatedAt;

  const comparesDir = getComparesDir();
  fs.mkdirSync(comparesDir, { recursive: true });
  const jsonPath = path.join(comparesDir, `${id}.json`);
  const htmlPath = path.join(comparesDir, `${id}.html`);

  writeJsonReport(jsonPath, reportData);
  fs.writeFileSync(htmlPath, renderHtmlReport(reportData), 'utf8');

  state.lastCompare = { id, generatedAt: reportData.generatedAt, baselineRef: state.lastBaseline.id };
  // Only an incremental run may advance the cursors. A cumulative compare must leave them alone, or
  // it would destroy the very window it just measured and the next run would report nothing.
  if (sinceLast) state.fileCursors = scanResult.fileCursors;
  saveState(state);

  info(
    sinceLast
      ? `Compare complete: ${reportData.totals.requests.toLocaleString('en-US')} requests since the last scan (${windowStart}), measured against baseline "${state.lastBaseline.id}".`
      : `Compare complete: ${reportData.totals.requests.toLocaleString('en-US')} requests since baseline "${state.lastBaseline.id}" (${state.lastBaseline.generatedAt}).`
  );
  info(`  ${reportData.comparison?.headlineVerdict ?? 'No new activity since last scan.'}`);
  info(`  JSON: ${jsonPath}`);
  info(`  HTML: ${htmlPath}`);

  return { reportData, jsonPath, htmlPath };
}
