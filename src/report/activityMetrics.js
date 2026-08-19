import { estimateCostByModel, COST_MODEL_NOTES } from './cost.js';

// Assembles the report-data object for --visualise from two independent, read-only sources:
//   - rootStats: Claude Code's own stats-cache.json + gh-pr-status-cache.json (survive transcript
//     rotation, so they cover the tool's *entire* history, not just the last ~30 days)
//   - activityScan: this run's fresh walk of transcripts still on disk (scan/activityScanner.js),
//     which sees things the caches do not - commits, worktrees, PRs raised via gh, lines written
//
// Neither source is shared with buildReportData() (report/metrics.js) or with state.json, so nothing
// here can affect --baseline/--compare's numbers or their stored reference point.

function daysBetween(aIso, bIso) {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000) + 1; // inclusive of both endpoints
}

// Active-day coverage over the exact span the cache itself reports, plus the longest unbroken run
// of active days and the longest silent gap - three different ways of answering "was this steady
// daily use, or a handful of bursts", which a single percentage cannot distinguish on its own.
function buildCoverage(dailyActivity) {
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
// conventional 08:00-18:00 workday (local to whatever timezone Claude Code stamped the hour in).
// Deliberately not called "uptime" in this module's data - that word implies a service kept alive,
// and this is presence-of-activity across a usage history instead. The HTML layer chooses the label.
function buildHourOfDay(hourCounts) {
  const entries = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourCounts[String(h)] ?? 0 }));
  const total = entries.reduce((a, e) => a + e.count, 0);
  const hoursWithActivity = entries.filter((e) => e.count > 0).length;
  const businessHoursCount = entries.filter((e) => e.hour >= 8 && e.hour < 18).reduce((a, e) => a + e.count, 0);
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

function buildPrSummary(prs) {
  if (!prs) return null;
  const byState = {};
  const byReview = { APPROVED: 0, CHANGES_REQUESTED: 0, COMMENTED: 0, none: 0 };
  let additions = 0;
  let deletions = 0;
  for (const pr of prs) {
    byState[pr.state] = (byState[pr.state] ?? 0) + 1;
    const key = pr.review && byReview[pr.review] !== undefined ? pr.review : pr.review ? 'other' : 'none';
    byReview[key] = (byReview[key] ?? 0) + 1;
    additions += pr.additions;
    deletions += pr.deletions;
  }
  const top = [...prs]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, 10)
    .map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, review: pr.review, additions: pr.additions, deletions: pr.deletions, url: pr.url }));
  return {
    total: prs.length,
    byState,
    byReview,
    reviewedCount: prs.length - byReview.none,
    additions,
    deletions,
    linesChanged: additions + deletions,
    top,
  };
}

export function buildActivityReportData({ claudeDir, id, generatedAt, statsCache, ghPrs, activityScan }) {
  const coverage = statsCache ? buildCoverage(statsCache.dailyActivity) : null;
  const hourOfDay = statsCache ? buildHourOfDay(statsCache.hourCounts) : null;
  const tokenSummary = statsCache ? sumModelUsageTokens(statsCache.modelUsage) : { byModel: [], totals: null };
  const cost = tokenSummary.byModel.length ? estimateCostByModel(tokenSummary.byModel) : null;
  const prSummary = buildPrSummary(ghPrs);

  const recentSessions = activityScan.sessions.filter((s) => s.durationMs !== null);
  const recentTotalDurationMs = recentSessions.reduce((a, s) => a + s.durationMs, 0);

  return {
    mode: 'visualise',
    id,
    generatedAt,
    claudeDir,
    dataAvailability: {
      hasStatsCache: statsCache !== null,
      hasGhPrCache: ghPrs !== null,
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
    github: {
      prCreateCommands: activityScan.bash.ghPrCreate,
      prMergeCommands: activityScan.bash.ghPrMerge,
      prReviewCommands: activityScan.bash.ghPrReview,
      prCommentCommands: activityScan.bash.ghPrComment,
      prs: prSummary,
    },
    code: {
      linesWritten: activityScan.loc.linesWritten,
      editLinesAdded: activityScan.loc.editLinesAdded,
      editLinesRemoved: activityScan.loc.editLinesRemoved,
    },
    projects: {
      distinctCount: activityScan.projects.length,
      workflowRunsSeen: activityScan.workflowRunsSeen,
      subagentFiles: activityScan.subagentFiles,
      workflowAgentFiles: activityScan.workflowAgentFiles,
    },
    tools: {
      topTools: activityScan.toolCallCounts.slice(0, 12),
    },
    skillInvocations: activityScan.skillInvocations,
    scan: {
      filesScanned: activityScan.filesScanned,
    },
  };
}
