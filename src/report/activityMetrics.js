import { estimateCostByModel, COST_MODEL_NOTES } from './cost.js';
import { buildGitActivity } from './gitMetrics.js';

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
// prompts" (genuine keystroke-driven lines, main tier only - see scan/activityScanner.js's
// isSyntheticUserLine() for how system-injected turns like background notifications, teammate
// messages, and scheduled-loop check-ins are told apart from something a human actually typed).
// Business-hours share is computed against the "Claude working" series since it is the more complete
// signal.
export const BUSINESS_HOUR_START = 9;
export const BUSINESS_HOUR_END = 17; // exclusive

export function buildHourOfDay({ claudeWorking, humanPrompts, humanPromptsSource = 'transcripts' }) {
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
    // 'history' means the prompts series was read from history.jsonl and therefore covers the tool's
    // whole lifetime rather than the retained transcript window; 'transcripts' is the fallback used
    // when that file is missing. Consumed only by the report's method/caption prose - the chart itself
    // draws one prompts series either way.
    humanPromptsSource,
    totalClaudeWorking,
    totalHumanPrompts,
    hoursWithActivity,
    hourSpreadPct: (hoursWithActivity / 24) * 100,
    businessHoursSharePct: totalClaudeWorking ? (businessHoursClaudeWorking / totalClaudeWorking) * 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Day-of-week shape, and the weekday/weekend split
// ---------------------------------------------------------------------------
// The same two event series as buildHourOfDay(), folded into 7 local-weekday slots instead of 24
// local-hour ones. Bucketed in local time (see scan/activityScanner.js and scan/promptHistory.js for
// why UTC would be wrong here specifically).
//
// The subtlety this section exists to get right: a raw weekday-vs-weekend share is close to
// meaningless on its own, because a week contains five weekdays and two weekend days. Someone who
// works exactly as hard on a Saturday as on a Tuesday still shows only ~28.6% of their activity at
// the weekend, and a reader will misread that as "I barely work weekends". So the weekend figure is
// reported two ways:
//   - `weekendSharePct`     - the plain share of events that landed on a Sat/Sun. Honest, but has to
//                             be read against the 28.6% an evenly-spread week would produce.
//   - `weekendIntensityPct` - events per weekend DAY as a percentage of events per weekday DAY. This
//                             is the figure that answers the question directly: 100% means a weekend
//                             day looks exactly like a working day, 0% means the weekend is genuinely
//                             off.
// The per-day denominators are calendar-day counts over each series' own observed span, not counts of
// *active* days - a Saturday with no activity is the signal, so dropping it would assume the answer.
//
// The two series have different spans (transcripts rotate at ~30 days, history.jsonl does not), so
// each gets its own occurrence denominator rather than sharing one.
export const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Sat/Sun. Not configurable, for the same reason BUSINESS_HOUR_START/END are not: every calendar
// convention in this report is a fixed, documented assumption rather than a setting, and a reader on
// a Sun-Thu week is better served by the per-day figures than by a flag nobody remembers to set.
export function isWeekendDay(day) {
  return day === 0 || day === 6;
}

// How many times each weekday actually occurred between two timestamps, inclusive, in local calendar
// days. This is the denominator that turns "events on Saturdays" into "events per Saturday".
//
// Steps by setDate(+1) rather than adding 86_400_000ms deliberately: across a DST transition a local
// day is 23 or 25 hours long, and fixed-millisecond stepping drifts far enough over a multi-month
// span to miscount whole days. Returns null rather than a zero-filled array when the span is unknown
// or implausible, so callers report "n/a" instead of dividing by zero and claiming a per-day rate
// they cannot actually compute.
export function weekdayOccurrences(firstTs, lastTs) {
  if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs) || lastTs < firstTs) return null;
  const counts = new Array(7).fill(0);
  const cur = new Date(firstTs);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(lastTs);
  end.setHours(0, 0, 0, 0);
  // ~54 years of days. A corrupt far-future timestamp should degrade this one figure, not hang the run.
  let guard = 0;
  while (cur <= end && guard < 20000) {
    counts[cur.getDay()] += 1;
    cur.setDate(cur.getDate() + 1);
    guard += 1;
  }
  return guard >= 20000 ? null : counts;
}

// Weekday/weekend aggregates for ONE series, given its 7 per-day counts and the calendar-day
// occurrences of its own span. `occurrences` may be null (span unknown) - everything needing a
// per-day denominator then comes back null rather than being faked from an assumed 5:2 ratio.
function weekdaySplit(counts, occurrences) {
  const total = counts.reduce((a, b) => a + b, 0);
  const weekendTotal = counts.reduce((a, c, day) => a + (isWeekendDay(day) ? c : 0), 0);
  const weekdayTotal = total - weekendTotal;
  const weekendDays = occurrences ? occurrences.reduce((a, c, day) => a + (isWeekendDay(day) ? c : 0), 0) : null;
  const weekdayDays = occurrences ? occurrences.reduce((a, c, day) => a + (isWeekendDay(day) ? 0 : c), 0) : null;
  const weekendPerDay = weekendDays ? weekendTotal / weekendDays : null;
  const weekdayPerDay = weekdayDays ? weekdayTotal / weekdayDays : null;

  const ranked = counts.map((c, day) => ({ day, count: c })).sort((a, b) => b.count - a.count);
  const busiest = ranked[0];
  const quietest = ranked[ranked.length - 1];

  return {
    total,
    weekdayTotal,
    weekendTotal,
    weekdaySharePct: total ? (weekdayTotal / total) * 100 : null,
    weekendSharePct: total ? (weekendTotal / total) * 100 : null,
    weekdayDays,
    weekendDays,
    weekdayPerDay,
    weekendPerDay,
    // The headline: a weekend day's volume as a percentage of a weekday's. 100% means no weekend at
    // all in the behavioural sense. Null when either denominator is unknown, or when the weekday rate
    // is zero and there is nothing to be a percentage of.
    weekendIntensityPct: weekdayPerDay && weekendPerDay !== null ? (weekendPerDay / weekdayPerDay) * 100 : null,
    busiestDay: busiest.day,
    busiestDayCount: busiest.count,
    busiestDaySharePct: total ? (busiest.count / total) * 100 : null,
    quietestDay: quietest.day,
    quietestDayCount: quietest.count,
    daysWithActivity: counts.filter((c) => c > 0).length,
  };
}

// `claudeSpan` / `promptSpan` are {firstTs, lastTs} in epoch ms for each series' own observed window -
// transcripts still on disk for the Claude-working series, history.jsonl for the prompts series.
// Either may be null, which costs only that series' per-day figures.
export function buildDayOfWeek({
  claudeWorking,
  humanPrompts,
  humanPromptsSource = 'transcripts',
  claudeSpan = null,
  promptSpan = null,
}) {
  const cw = Array.from({ length: 7 }, (_, d) => claudeWorking?.[d] ?? 0);
  const hp = Array.from({ length: 7 }, (_, d) => humanPrompts?.[d] ?? 0);
  const claudeOccurrences = claudeSpan ? weekdayOccurrences(claudeSpan.firstTs, claudeSpan.lastTs) : null;
  const promptOccurrences = promptSpan ? weekdayOccurrences(promptSpan.firstTs, promptSpan.lastTs) : null;

  const totalClaudeWorking = cw.reduce((a, b) => a + b, 0);
  const totalHumanPrompts = hp.reduce((a, b) => a + b, 0);

  const days = Array.from({ length: 7 }, (_, day) => ({
    day,
    label: DOW_LABELS[day],
    short: DOW_SHORT[day],
    weekend: isWeekendDay(day),
    claudeWorking: cw[day],
    humanPrompts: hp[day],
    // Share of each series' own total, exactly as the hour-of-day chart does. Slot-against-slot is
    // fair here without a per-day denominator, because over any span longer than a few weeks each
    // weekday occurs an almost equal number of times - the 5-vs-2 problem only bites when the weekday
    // and weekend BLOCKS are compared, which is what weekdaySplit() above handles.
    pctClaudeWorking: totalClaudeWorking ? (cw[day] / totalClaudeWorking) * 100 : 0,
    pctHumanPrompts: totalHumanPrompts ? (hp[day] / totalHumanPrompts) * 100 : 0,
    claudeWorkingPerDay: claudeOccurrences?.[day] ? cw[day] / claudeOccurrences[day] : null,
    humanPromptsPerDay: promptOccurrences?.[day] ? hp[day] / promptOccurrences[day] : null,
    claudeOccurrences: claudeOccurrences?.[day] ?? null,
    promptOccurrences: promptOccurrences?.[day] ?? null,
  }));

  return {
    days,
    humanPromptsSource,
    totalClaudeWorking,
    totalHumanPrompts,
    // What an evenly-spread week would put in each slot. The chart draws this as a reference line so
    // "is Wednesday actually a peak" is answerable by eye rather than by arithmetic.
    evenSharePct: 100 / 7,
    claude: weekdaySplit(cw, claudeOccurrences),
    prompts: weekdaySplit(hp, promptOccurrences),
    // Kept raw so report/mergeActivity.js can re-sum across machines without reversing percentages.
    rawClaudeWorking: cw,
    rawHumanPrompts: hp,
    claudeSpan,
    promptSpan,
  };
}

// ---------------------------------------------------------------------------
// Full-lifetime prompt hours (history.jsonl)
// ---------------------------------------------------------------------------
// Counts every prompt actually typed, by local hour, over the tool's entire history - built from
// ~/.claude/history.jsonl, which Claude Code keeps outside the rotating transcript corpus (see
// scan/promptHistory.js for why that file is trusted for this and what it cannot answer).
//
// This feeds two things: the "your prompts" series of the single hour-of-day chart (see
// buildActivityReportData() below, which prefers it over the transcript-derived count), and the
// prompt-side KPI cards - busiest hour, late-night total, hours-of-day ever prompted in. Those are
// counts of human keystrokes only; they are never summed with or averaged against the Claude-working
// event counts, which measure a different thing.
export const LATE_NIGHT_START = 22; // inclusive
export const LATE_NIGHT_END = 6; // exclusive - the band wraps midnight

export function isLateNightHour(hour) {
  return hour >= LATE_NIGHT_START || hour < LATE_NIGHT_END;
}

export function buildPromptHours(promptHistory) {
  if (!promptHistory || !Array.isArray(promptHistory.hours)) return null;
  const total = promptHistory.hours.reduce((a, b) => a + b, 0);
  if (total === 0) return null;

  const hours = promptHistory.hours.map((prompts, hour) => ({
    hour,
    prompts,
    pct: (prompts / total) * 100,
    lateNight: isLateNightHour(hour),
    businessHours: hour >= BUSINESS_HOUR_START && hour < BUSINESS_HOUR_END,
  }));

  const peak = hours.reduce((best, h) => (h.prompts > best.prompts ? h : best), hours[0]);
  const lateNightPrompts = hours.filter((h) => h.lateNight).reduce((a, h) => a + h.prompts, 0);
  const businessPrompts = hours.filter((h) => h.businessHours).reduce((a, h) => a + h.prompts, 0);
  const hoursWithActivity = hours.filter((h) => h.prompts > 0).length;

  return {
    source: 'history.jsonl',
    hours,
    total,
    slashCommands: promptHistory.slashCommands ?? null,
    distinctSessions: promptHistory.distinctSessions ?? null,
    distinctProjects: promptHistory.distinctProjects ?? null,
    firstPromptAt: promptHistory.firstTs !== null ? new Date(promptHistory.firstTs).toISOString() : null,
    lastPromptAt: promptHistory.lastTs !== null ? new Date(promptHistory.lastTs).toISOString() : null,
    spanDays:
      promptHistory.firstTs !== null && promptHistory.lastTs !== null
        ? Math.max(1, Math.round((promptHistory.lastTs - promptHistory.firstTs) / 86400000))
        : null,
    peakHour: peak.hour,
    peakHourPrompts: peak.prompts,
    peakHourPct: peak.pct,
    hoursWithActivity,
    hourSpreadPct: (hoursWithActivity / 24) * 100,
    lateNightPrompts,
    lateNightPct: (lateNightPrompts / total) * 100,
    businessHoursPrompts: businessPrompts,
    businessHoursSharePct: (businessPrompts / total) * 100,
    monthly: promptHistory.monthly ?? [],
    // Kept as a raw 24-slot array so buildActivityReportData() can hand it straight to
    // buildHourOfDay() as the chart's prompts series, and report/mergeActivity.js can re-sum across
    // machines, neither of them having to reverse-engineer counts back out of the percentages above.
    rawHours: [...promptHistory.hours],
    // Same rationale as rawHours, for the 7-slot weekday histogram. Null on a promptHistory object
    // built before this field existed (a --merge of an older --visualise JSON), which degrades the
    // prompts series of the day-of-week chart rather than failing the merge.
    rawDow: Array.isArray(promptHistory.dow) ? [...promptHistory.dow] : null,
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

export function buildActivityReportData({ claudeDir, id, generatedAt, statsCache, activityScan, promptHistory = null, gitHarvest = null }) {
  const lastComputedDate = statsCache?.lastComputedDate ?? null;
  const cachedDaily = statsCache?.dailyActivity ?? [];
  // Only the portion of the live scan's window the cache does not already cover, so the two series
  // are never double-counted where they could theoretically overlap.
  const recentDaily = activityScan.dailyActivity.filter((d) => !lastComputedDate || d.date > lastComputedDate);

  const activeDates = [...activeDatesFromCachedDaily(cachedDaily), ...activeDatesFromRecentDaily(recentDaily)];
  const coverage = activeDates.length ? buildCoverage(activeDates) : null;

  // Full-lifetime typed-prompt hours, from history.jsonl rather than transcripts - the only source
  // that survives transcript rotation for this question. Null when the file is absent/unreadable.
  const promptHours = buildPromptHours(promptHistory);

  // One hour-of-day series pair, not two charts: the prompts series is taken from history.jsonl when
  // it is available (same measurement, same units, just not truncated at the ~30-day transcript
  // rotation), and falls back to the transcript-derived count when it is not. The "Claude working"
  // series can only ever come from transcripts - history.jsonl holds no record of Claude's side - so
  // that half is unavoidably limited to what is still on disk. The two are plotted together because
  // each is scaled as a share of its own total, which is a shape comparison, not a volume one.
  const lifetimePromptHours = promptHours ? promptHours.rawHours : null;
  const hourEventTotal =
    activityScan.hourOfDay.claudeWorking.reduce((a, b) => a + b, 0) +
    (lifetimePromptHours ?? activityScan.hourOfDay.humanPrompts).reduce((a, b) => a + b, 0);
  const hourOfDay =
    hourEventTotal > 0
      ? buildHourOfDay({
          claudeWorking: activityScan.hourOfDay.claudeWorking,
          humanPrompts: lifetimePromptHours ?? activityScan.hourOfDay.humanPrompts,
          humanPromptsSource: lifetimePromptHours ? 'history' : 'transcripts',
        })
      : null;

  // Day-of-week uses exactly the same source preference as the hour chart above - history.jsonl for
  // the prompts series when it is there, transcripts otherwise - so the two charts never disagree
  // about what "your prompts" means. Each series also carries its own span, because the per-weekday
  // averages need a denominator ("how many Saturdays were there?") and the two series cover very
  // different stretches of time: transcripts rotate at ~30 days, history.jsonl does not rotate at all.
  const lifetimePromptDow = promptHours ? promptHours.rawDow : null;
  const claudeSpan =
    activityScan.oldestTs !== null && activityScan.newestTs !== null
      ? { firstTs: activityScan.oldestTs, lastTs: activityScan.newestTs }
      : null;
  const promptSpan =
    lifetimePromptDow && promptHistory?.firstTs != null && promptHistory?.lastTs != null
      ? { firstTs: promptHistory.firstTs, lastTs: promptHistory.lastTs }
      : claudeSpan; // transcript-derived fallback series shares the transcript window
  const dowClaude = activityScan.dayOfWeek?.claudeWorking ?? new Array(7).fill(0);
  const dowPrompts = lifetimePromptDow ?? activityScan.dayOfWeek?.humanPrompts ?? new Array(7).fill(0);
  const dayOfWeek =
    dowClaude.reduce((a, b) => a + b, 0) + dowPrompts.reduce((a, b) => a + b, 0) > 0
      ? buildDayOfWeek({
          claudeWorking: dowClaude,
          humanPrompts: dowPrompts,
          humanPromptsSource: lifetimePromptDow ? 'history' : 'transcripts',
          claudeSpan,
          promptSpan,
        })
      : null;

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
    dayOfWeek,
    promptHours,
    // Real git history, read from the repositories themselves rather than inferred from transcripts.
    // Null only when --no-git was passed; an unavailable harvest still produces an object saying why,
    // so the report can state the reason instead of silently omitting a section.
    gitActivity: gitHarvest ? buildGitActivity(gitHarvest) : null,
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
