import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { readStatsCache } from '../scan/rootStats.js';
import { scanActivity } from '../scan/activityScanner.js';
import { readPromptHistory } from '../scan/promptHistory.js';
import { harvestGitActivity } from '../scan/gitHarvest.js';
import { buildActivityReportData } from '../report/activityMetrics.js';
import { writeJsonReport } from '../report/json.js';
import { renderVisualiseHtml } from '../report/visualiseHtml.js';
import { getVisualiseDir } from '../state/paths.js';
import { compactIsoTimestamp } from '../util/time.js';
import { info, warn } from '../util/log.js';

// Thrown when the usage cache is stale beyond the configured threshold and the run was not allowed
// to proceed (either the user declined the interactive prompt, or stdin isn't a TTY to prompt on and
// --allow-stale-cache wasn't passed). Caught in cli.js for a clean one-line error, like
// NoBaselineError/MergeInputError.
export class StaleCacheError extends Error {}

const MS_PER_DAY = 86400000;

async function confirmStaleCache(daysStale, lastComputedDate, maxCacheAgeDays) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Usage cache (stats-cache.json) is ${daysStale} day(s) old (last computed ${lastComputedDate}), older than the ` +
        `${maxCacheAgeDays}-day threshold. Run \`/stats\` inside Claude Code first for a more complete report.\n` +
        `Continue anyway with the stale cache? [y/N] `
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// A third, independent mode alongside --baseline/--compare: "what did you actually do with Claude",
// not "what did it cost". Deliberately never touches state.json (state/cursor.js) or the
// baselines/compares directories - see report/activityMetrics.js and scan/activityScanner.js for why
// each data source was chosen to be independently readable without perturbing those modes.
export async function runVisualise({ claudeDir, maxCacheAgeDays = 2, allowStaleCache = false, harvestGit = true, extraRepos = [] }) {
  info(`Reading usage cache under ${claudeDir} ...`);
  const statsCache = readStatsCache(claudeDir);

  // A missing cache degrades the report gracefully (see readStatsCache/activityMetrics.js) and is not
  // gated here - only a cache that exists but has gone stale prompts/blocks, since running /stats is
  // the only known way to force Claude Code to recompute it (see cli --help for the flags to opt out).
  if (statsCache?.lastComputedDate && !allowStaleCache) {
    const daysStale = Math.floor((Date.now() - Date.parse(statsCache.lastComputedDate)) / MS_PER_DAY);
    if (daysStale > maxCacheAgeDays) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const proceed = await confirmStaleCache(daysStale, statsCache.lastComputedDate, maxCacheAgeDays);
        if (!proceed) {
          throw new StaleCacheError(
            `Aborted: usage cache is ${daysStale} day(s) stale. Run \`/stats\` in Claude Code to refresh it, then re-run this command - or pass --allow-stale-cache to proceed anyway.`
          );
        }
        warn(`Continuing with a ${daysStale}-day-stale cache.`);
      } else {
        throw new StaleCacheError(
          `Usage cache is ${daysStale} day(s) stale (threshold: ${maxCacheAgeDays}). Run \`/stats\` in Claude Code to refresh it, then re-run this command - or pass --allow-stale-cache to proceed anyway.`
        );
      }
    }
  }

  info(`Scanning transcripts under ${claudeDir} for activity (sessions, tools, code written) ...`);
  const activityScan = await scanActivity(claudeDir);

  // The hour-of-day chart's "your prompts" series comes from here rather than from the transcript scan
  // above, because history.jsonl is not rotated with the transcripts and so covers the tool's whole
  // history. A missing or unreadable file falls back to the transcript-derived prompt counts, which
  // are the same measurement truncated at the retention window (see report/activityMetrics.js).
  info(`Reading typed-prompt history (history.jsonl) for full-history hour-of-day coverage ...`);
  const promptHistory = await readPromptHistory(claudeDir);

  // The only step that reads anything outside ~/.claude. Strictly read-only git queries against the
  // repositories the transcripts say you worked in - see scan/gitHarvest.js for why this replaced the
  // transcript-mined commit counts, and what it can and cannot see. Opt out with --no-git.
  let gitHarvest = null;
  if (harvestGit) {
    info(`Harvesting real git history from the repositories seen in transcripts (read-only) ...`);
    gitHarvest = await harvestGitActivity({ cwds: activityScan.cwds ?? [], extraRepos });
    if (!gitHarvest.available) {
      warn(`Git harvest unavailable: ${gitHarvest.reason}. The report will say so rather than estimating.`);
    }
  }

  const id = `visualise-${compactIsoTimestamp()}`;
  const reportData = buildActivityReportData({
    claudeDir,
    id,
    generatedAt: new Date().toISOString(),
    statsCache,
    activityScan,
    promptHistory,
    gitHarvest,
  });

  const visualiseDir = getVisualiseDir();
  fs.mkdirSync(visualiseDir, { recursive: true });
  const jsonPath = path.join(visualiseDir, `${id}.json`);
  const htmlPath = path.join(visualiseDir, `${id}.html`);

  writeJsonReport(jsonPath, reportData);
  fs.writeFileSync(htmlPath, renderVisualiseHtml(reportData), 'utf8');

  info(
    `Visualise complete: ${activityScan.filesScanned.toLocaleString('en-US')} transcript files scanned` +
      (statsCache ? `, ${(statsCache.totalSessions ?? 0).toLocaleString('en-US')} sessions on record since ${statsCache.firstSessionDate}` : ', no usage cache found') +
      (promptHistory
        ? `, ${promptHistory.entries.toLocaleString('en-US')} typed prompts read from history.jsonl (full lifetime)`
        : ', no history.jsonl found (lifetime prompt hours unavailable)') +
      (reportData.gitActivity?.available
        ? `, ${reportData.gitActivity.claudeCommits.toLocaleString('en-US')} Claude-attributed commits across ${reportData.gitActivity.reposWithClaudeCommits} repo(s)`
        : '')
  );
  info(`  JSON: ${jsonPath}`);
  info(`  HTML: ${htmlPath}`);

  return { reportData, jsonPath, htmlPath };
}
