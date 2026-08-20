import { estimateCostByModel, COST_MODEL_NOTES } from './cost.js';

// Assembles the report-data object for --visualise from two independent, read-only sources:
//   - rootStats: Claude Code's own stats-cache.json (survives transcript rotation, so it covers the
//     tool's *entire* history, not just the last ~30 days) - BUT is only recomputed by Claude Code on
//     its own schedule, not live, and was found 44+ days stale on the machine this was built against.
//   - activityScan: this run's fresh walk of transcripts still on disk (scan/activityScanner.js),
//     which sees things the cache does not (or does not see correctly) - commits, worktrees, lines
//     written, and (critically) real per-hour/per-day activity and any model usage newer than the
//     cache's last computation.
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
//
// Deliberately does NOT use stats-cache.json's hourCounts. An audit against real data proved it is a
// per-SESSION-START histogram (sum(hourCounts) === totalSessions exactly), not an activity histogram:
// an 8-day unattended run and a 30-second session both contribute exactly 1. Hour-of-day and daily
// activity for the retained transcript window are instead computed independently in
// scan/activityScanner.js from raw timestamps, and token/model totals are supplemented with anything
// newer than the cache's lastComputedDate - see buildTokenSummary() below.

function daysBetween(aIso, bIso) {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000) + 1; // inclusive of both endpoints
}

// Active-day coverage over whatever span of dates is passed in, plus the longest unbroken run of
// active days and the longest silent gap - three different ways of answering "was this steady daily
// use, or a handful of bursts", which a single percentage cannot distinguish on its own.
//
// Takes a flat list of "this date had activity" strings rather than a dailyActivity-shaped array, so
// the caller can freely union dates from more than one source (cached history + the live-transcript
// window, which use different underlying definitions of "activity" and must not be blended row-by-row
// - see buildActivityReportData()). Exported so report/mergeActivity.js can recompute this from
// combined raw data rather than trying to average two already-derived summaries, which would be wrong
// for anything path-dependent (streaks, gaps).
export function buildCoverage(activeDatesRaw) {
  const dates = [...new Set(activeDatesRaw)].sort();
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

function activeDatesFromCachedDaily(dailyActivity) {
  return dailyActivity.filter((d) => (d.messageCount ?? 0) > 0 || (d.sessionCount ?? 0) > 0).map((d) => d.date);
}

function activeDatesFromRecentDaily(dailyActivity) {
  return dailyActivity.filter((d) => (d.claudeEvents ?? 0) > 0 || (d.humanPrompts ?? 0) > 0).map((d) => d.date);
}

// Hour-of-day usage shape: two independent series - "Claude working" (assistant turns and tool
// round-trips, every tier, the signal that actually shows unattended/overnight activity) and "human
// prompts" (genuine human-authored lines, main tier only). Business-hours share is computed against
// the "Claude working" series since it is the more complete signal.
export const BUSINESS_HOUR_START = 9;
export const BUSINESS_HOUR_END = 17; // exclusive

export function buildHourOfDay({ claudeWorking, humanPrompts }) {
  const hours = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    claudeWorking: claudeWorking[h] ?? 0,
    humanPrompts: humanPrompts[h] ?? 0,
  }));
  const totalClaudeWorking = hours.reduce((a, h) => a + h.claudeWorking, 0);
  const totalHumanPrompts = hours.reduce((a, h) => a + h.humanPrompts, 0);
  const hoursWithActivity = hours.filter((h) => h.claudeWorking > 0).length;
  const businessHoursClaudeWorking = hours
    .filter((h) => h.hour >= BUSINESS_HOUR_START && h.hour < BUSINESS_HOUR_END)
    .reduce((a, h) => a + h.claudeWorking, 0);
  return {
    hours: hours.map((h) => ({
      ...h,
      pctClaudeWorking: totalClaudeWorking ? (h.claudeWorking / totalClaudeWorking) * 100 : 0,
      pctHumanPrompts: totalHumanPrompts ? (h.humanPrompts / totalHumanPrompts) * 100 : 0,
    })),
    totalClaudeWorking,
    totalHumanPrompts,
    hoursWithActivity,
    hourSpreadPct: (hoursWithActivity / 24) * 100,
    businessHoursSharePct: totalClaudeWorking ? (businessHoursClaudeWorking / totalClaudeWorking) * 100 : null,
  };
}

function sumModelUsageTokens(modelUsage) {
  const byModel = [];
  for (const [model, u] of Object.entries(modelUsage)) {
    const tokens = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheCreationTokens: u.cacheCreationInputTokens ?? 0,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
    };
    tokens.total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
    byModel.push({ key: model, tokens });
  }
  return byModel;
}

// stats-cache.json's modelUsage is frozen as of lastComputedDate - it does not update again until
// Claude Code itself recomputes it, which happens on its own schedule, not on every run. Observed 44+
// days stale on the machine this was built against, which hid every model used since (Sonnet 5, Opus
// 5) from the token/cost totals entirely. This supplements the cached totals with per-model tokens
// computed live from transcripts, but only for dates strictly after lastComputedDate, so a day the
// cache already covers is never double-counted - this also correctly handles the (currently
// unobserved) inverse case where the cache is *not* stale and already covers days still on disk.
function buildTokenSummary(statsCache, activityScan) {
  const lastComputedDate = statsCache?.lastComputedDate ?? null;
  const merged = new Map(); // model -> token-class totals (not yet summed to .total)
  for (const row of statsCache ? sumModelUsageTokens(statsCache.modelUsage) : []) {
    merged.set(row.key, { ...row.tokens });
  }

  let liveSupplementTotal = 0;
  for (const day of activityScan.dailyModelTokens) {
    if (lastComputedDate && !(day.date > lastComputedDate)) continue; // already covered by the cache
    for (const [model, u] of Object.entries(day.tokensByModel)) {
      const cur = merged.get(model) ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      cur.inputTokens += u.inputTokens ?? 0;
      cur.outputTokens += u.outputTokens ?? 0;
      cur.cacheCreationTokens += u.cacheCreationTokens ?? 0;
      cur.cacheReadTokens += u.cacheReadTokens ?? 0;
      merged.set(model, cur);
      liveSupplementTotal += (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheCreationTokens ?? 0) + (u.cacheReadTokens ?? 0);
    }
  }

  const byModel = [...merged.entries()]
    // requests is unknown at this granularity (both sources track tokens, not per-model request
    // counts) - 0 is safe here since estimateCostByModel only uses it for costPerRequest and the
    // unpriced-request tally, neither of which this report surfaces per model.
    .map(([key, tokens]) => ({
      key,
      requests: 0,
      tokens: { ...tokens, total: tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens },
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total);

  const totals = byModel.length
    ? byModel.reduce(
        (acc, m) => ({
          inputTokens: acc.inputTokens + m.tokens.inputTokens,
          outputTokens: acc.outputTokens + m.tokens.outputTokens,
          cacheCreationTokens: acc.cacheCreationTokens + m.tokens.cacheCreationTokens,
          cacheReadTokens: acc.cacheReadTokens + m.tokens.cacheReadTokens,
          total: acc.total + m.tokens.total,
        }),
        { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, total: 0 }
      )
    : null;

  return { byModel, totals, liveSupplementTotal };
}

// How out of date stats-cache.json is, and how much of that gap can never be recovered because the
// transcripts that would have filled it have already rotated out. `unrecoverableGapDays` is the count
// of days strictly between lastComputedDate and the oldest transcript still on disk - if that oldest
// transcript is itself only a day or two after lastComputedDate, there is no real gap.
function buildStaleness(statsCache, activityScan) {
  const lastComputedDate = statsCache?.lastComputedDate ?? null;
  if (!lastComputedDate) return null;
  const daysSinceComputed = Math.floor((Date.now() - Date.parse(lastComputedDate)) / 86400000);
  const oldestTranscriptDate = activityScan.oldestTs !== null ? new Date(activityScan.oldestTs).toISOString().slice(0, 10) : null;
  const unrecoverableGapDays = oldestTranscriptDate
    ? Math.max(0, daysBetween(lastComputedDate, oldestTranscriptDate) - 2)
    : null;
  return { lastComputedDate, daysSinceComputed, oldestTranscriptDate, unrecoverableGapDays };
}

export function buildActivityReportData({ claudeDir, id, generatedAt, statsCache, activityScan }) {
  const lastComputedDate = statsCache?.lastComputedDate ?? null;
  const cachedDaily = statsCache?.dailyActivity ?? [];
  // Only the portion of the live scan's window the cache does not already cover, so the two series
  // are never double-counted where they could theoretically overlap.
  const recentDaily = activityScan.dailyActivity.filter((d) => !lastComputedDate || d.date > lastComputedDate);

  const activeDates = [...activeDatesFromCachedDaily(cachedDaily), ...activeDatesFromRecentDaily(recentDaily)];
  const coverage = activeDates.length ? buildCoverage(activeDates) : null;

  const hourEventTotal = activityScan.hourOfDay.claudeWorking.reduce((a, b) => a + b, 0) + activityScan.hourOfDay.humanPrompts.reduce((a, b) => a + b, 0);
  const hourOfDay = hourEventTotal > 0 ? buildHourOfDay(activityScan.hourOfDay) : null;

  const tokenSummary = buildTokenSummary(statsCache, activityScan);
  const cost = tokenSummary.byModel.length ? estimateCostByModel(tokenSummary.byModel) : null;

  const staleness = buildStaleness(statsCache, activityScan);

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
      lastComputedDate,
      recentWindowStart: activityScan.oldestTs !== null ? new Date(activityScan.oldestTs).toISOString() : null,
      recentWindowEnd: activityScan.newestTs !== null ? new Date(activityScan.newestTs).toISOString() : null,
      staleness,
    },
    coverage,
    hourOfDay,
    dailyActivity: cachedDaily,
    recentDailyActivity: recentDaily,
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
      liveSupplementTotal: tokenSummary.liveSupplementTotal,
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
