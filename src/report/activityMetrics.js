import { estimateCostByModel, COST_MODEL_NOTES } from './cost.js';

// Assembles the report-data object for --visualise from two independent, read-only sources:
//   - rootStats: Claude Code's own stats-cache.json (survives transcript rotation, so it covers the
//     tool's *entire* history, not just the last ~30 days)
//   - activityScan: this run's fresh walk of transcripts still on disk (scan/activityScanner.js),
//     which sees things the cache does not - commits, worktrees, lines written
//
// Neither source is shared with buildReportData() (report/metrics.js) or with state.json, so nothing
// here can affect --baseline/--compare's numbers or their stored reference point.
//
// Deliberately does NOT report pull-request counts. gh-pr-status-cache.json turned out to be a small
// rolling status-poll cache (whatever PRs the status line last checked), not a ledger, so "PRs raised"
// read from it was a silent, large undercount - and the gh-CLI command counts from transcripts are no
// more trustworthy (they only see the last ~30 days, and only PRs actually created *through* the gh
// CLI). Neither signal is reliable enough to report as a metric, so this was removed rather than kept
// with caveats.

function daysBetween(aIso, bIso) {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000) + 1; // inclusive of both endpoints
}

// Active-day coverage over the exact span the cache itself reports, plus the longest unbroken run
// of active days and the longest silent gap - three different ways of answering "was this steady
// daily use, or a handful of bursts", which a single percentage cannot distinguish on its own.
//
// Exported (along with buildHourOfDay below) so report/mergeActivity.js can recompute these from
// combined raw data rather than trying to average two already-derived summaries, which would be
// wrong for anything path-dependent (streaks, gaps, hour spread).
export function buildCoverage(dailyActivity) {
  if (!dailyActivity.length) return null;
  const dates = [...new Set(dailyActivity.filter((d) => d.messageCount > 0 || d.sessionCount > 0).map((d) => d.date))].sort();
  if (!dates.length) return null;
  const first = dates[0];
  const last = dates[dates.length - 1];
  const totalCalendarDays = daysBetween(first, last);
  const activeDays = dates.length;

  let longestStreak = 1;
  let currentStreak = 1;
  let longestGapDays = 0;
  for (let i = 1; i < dates.length; i++) {
    // daysBetween() is an inclusive span (same date -> 1), so two consecutive calendar dates give 2;
    // subtracting 2 (not 1) is what turns that into "how many days were skipped in between".
    const gap = daysBetween(dates[i - 1], dates[i]) - 2;
    if (gap === 0) {
      currentStreak += 1;
      longestStreak = Math.max(longestStreak, currentStreak);
    } else {
      currentStreak = 1;
      longestGapDays = Math.max(longestGapDays, gap);
    }
  }

  return {
    firstActiveDate: first,
    lastActiveDate: last,
    totalCalendarDays,
    activeDays,
    coveragePct: totalCalendarDays ? (activeDays / totalCalendarDays) * 100 : null,
    longestStreakDays: longestStreak,
    longestGapDays,
  };
}

// Hour-of-day usage shape: how many of the 24 hours ever saw activity, and what share falls inside a
// conventional 09:00-17:00 workday (local to whatever timezone Claude Code stamped the hour in).
// Deliberately not called "uptime" in this module's data - that word implies a service kept alive,
// and this is presence-of-activity across a usage history instead. The HTML layer chooses the label.
export const BUSINESS_HOUR_START = 9;
export const BUSINESS_HOUR_END = 17; // exclusive

export function buildHourOfDay(hourCounts) {
  const entries = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourCounts[String(h)] ?? 0 }));
  const total = entries.reduce((a, e) => a + e.count, 0);
  const hoursWithActivity = entries.filter((e) => e.count > 0).length;
  const businessHoursCount = entries
    .filter((e) => e.hour >= BUSINESS_HOUR_START && e.hour < BUSINESS_HOUR_END)
    .reduce((a, e) => a + e.count, 0);
  return {
    hours: entries.map((e) => ({ ...e, pct: total ? (e.count / total) * 100 : 0 })),
    total,
    hoursWithActivity,
    hourSpreadPct: (hoursWithActivity / 24) * 100,
    businessHoursSharePct: total ? (businessHoursCount / total) * 100 : null,
  };
}

function sumModelUsageTokens(modelUsage) {
  const byModel = [];
  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  for (const [model, u] of Object.entries(modelUsage)) {
    const tokens = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheCreationTokens: u.cacheCreationInputTokens ?? 0,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
    };
    tokens.total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
    totals.inputTokens += tokens.inputTokens;
    totals.outputTokens += tokens.outputTokens;
    totals.cacheCreationTokens += tokens.cacheCreationTokens;
    totals.cacheReadTokens += tokens.cacheReadTokens;
    // requests is unknown at this granularity (the cache tracks tokens, not per-model request
    // counts) - 0 is safe here since estimateCostByModel only uses it for costPerRequest and the
    // unpriced-request tally, neither of which this report surfaces per model.
    byModel.push({ key: model, requests: 0, tokens });
  }
  totals.total = totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
  byModel.sort((a, b) => b.tokens.total - a.tokens.total);
  return { byModel, totals };
}

export function buildActivityReportData({ claudeDir, id, generatedAt, statsCache, activityScan }) {
  const coverage = statsCache ? buildCoverage(statsCache.dailyActivity) : null;
  const hourOfDay = statsCache ? buildHourOfDay(statsCache.hourCounts) : null;
  const tokenSummary = statsCache ? sumModelUsageTokens(statsCache.modelUsage) : { byModel: [], totals: null };
  const cost = tokenSummary.byModel.length ? estimateCostByModel(tokenSummary.byModel) : null;

  const recentSessions = activityScan.sessions.filter((s) => s.durationMs !== null);
  const recentTotalDurationMs = recentSessions.reduce((a, s) => a + s.durationMs, 0);

  return {
    mode: 'visualise',
    id,
    generatedAt,
    claudeDir,
    dataAvailability: {
      hasStatsCache: statsCache !== null,
    },
    period: {
      firstSessionDate: statsCache?.firstSessionDate ?? null,
      lastComputedDate: statsCache?.lastComputedDate ?? null,
      recentWindowStart: activityScan.oldestTs !== null ? new Date(activityScan.oldestTs).toISOString() : null,
      recentWindowEnd: activityScan.newestTs !== null ? new Date(activityScan.newestTs).toISOString() : null,
    },
    coverage,
    hourOfDay,
    dailyActivity: statsCache?.dailyActivity ?? [],
    sessions: {
      totalAllTime: statsCache?.totalSessions ?? null,
      totalMessagesAllTime: statsCache?.totalMessages ?? null,
      longestSession: statsCache?.longestSession ?? null,
      recentWindow: {
        count: recentSessions.length,
        totalDurationMs: recentTotalDurationMs,
        avgDurationMs: recentSessions.length ? recentTotalDurationMs / recentSessions.length : null,
      },
    },
    tokens: {
      totals: tokenSummary.totals,
      byModel: tokenSummary.byModel,
      cost,
      costModelNotes: COST_MODEL_NOTES,
    },
    worktrees: {
      createdViaTool: activityScan.worktreeTool.created,
      enteredViaTool: activityScan.worktreeTool.entered,
      distinctToolNames: activityScan.worktreeTool.distinctNames,
      projectTraceCount: activityScan.worktreeProjectsSeen,
      projectTraceLabels: activityScan.worktreeProjectLabels,
      gitWorktreeAddCommands: activityScan.bash.gitWorktreeAdd,
      gitWorktreeRemoveCommands: activityScan.bash.gitWorktreeRemove,
    },
    git: {
      commits: activityScan.bash.gitCommit,
      pushes: activityScan.bash.gitPush,
    },
    code: {
      linesWritten: activityScan.loc.linesWritten,
      editLinesAdded: activityScan.loc.editLinesAdded,
      editLinesRemoved: activityScan.loc.editLinesRemoved,
    },
    projects: {
      distinctCount: activityScan.projects.length,
      // Full list (not just the count) so a merge can union two machines' project sets instead of
      // just summing counts, which would double-count a project touched from both.
      list: activityScan.projects,
      workflowRunsSeen: activityScan.workflowRunsSeen,
      subagentFiles: activityScan.subagentFiles,
      workflowAgentFiles: activityScan.workflowAgentFiles,
    },
    tools: {
      // Kept in full (not sliced to a display-sized top-N) so a merge can sum calls per tool exactly
      // before re-sorting; report/visualiseHtml.js slices to a display-sized list at render time.
      topTools: activityScan.toolCallCounts,
    },
    skillInvocations: activityScan.skillInvocations,
    scan: {
      filesScanned: activityScan.filesScanned,
    },
  };
}
