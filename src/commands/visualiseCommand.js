import path from 'node:path';
import fs from 'node:fs';
import { readStatsCache, readGhPrCache } from '../scan/rootStats.js';
import { scanActivity } from '../scan/activityScanner.js';
import { buildActivityReportData } from '../report/activityMetrics.js';
import { writeJsonReport } from '../report/json.js';
import { renderVisualiseHtml } from '../report/visualiseHtml.js';
import { getVisualiseDir } from '../state/paths.js';
import { compactIsoTimestamp } from '../util/time.js';
import { info } from '../util/log.js';

// A third, independent mode alongside --baseline/--compare: "what did you actually do with Claude",
// not "what did it cost". Deliberately never touches state.json (state/cursor.js) or the
// baselines/compares directories - see report/activityMetrics.js and scan/activityScanner.js for why
// each data source was chosen to be independently readable without perturbing those modes.
export async function runVisualise({ claudeDir }) {
  info(`Reading usage cache under ${claudeDir} ...`);
  const statsCache = readStatsCache(claudeDir);
  const ghPrs = readGhPrCache(claudeDir);

  info(`Scanning transcripts under ${claudeDir} for activity (commits, worktrees, PRs, code written) ...`);
  const activityScan = await scanActivity(claudeDir);

  const id = `visualise-${compactIsoTimestamp()}`;
  const reportData = buildActivityReportData({
    claudeDir,
    id,
    generatedAt: new Date().toISOString(),
    statsCache,
    ghPrs,
    activityScan,
  });

  const visualiseDir = getVisualiseDir();
  fs.mkdirSync(visualiseDir, { recursive: true });
  const jsonPath = path.join(visualiseDir, `${id}.json`);
  const htmlPath = path.join(visualiseDir, `${id}.html`);

  writeJsonReport(jsonPath, reportData);
  fs.writeFileSync(htmlPath, renderVisualiseHtml(reportData), 'utf8');

  info(
    `Visualise complete: ${activityScan.filesScanned.toLocaleString('en-US')} transcript files scanned` +
      (statsCache ? `, ${(statsCache.totalSessions ?? 0).toLocaleString('en-US')} sessions on record since ${statsCache.firstSessionDate}` : ', no usage cache found')
  );
  info(`  JSON: ${jsonPath}`);
  info(`  HTML: ${htmlPath}`);

  return { reportData, jsonPath, htmlPath };
}
