// Renders the self-contained --visualise dashboard: "what did you actually do with Claude over the
// period this machine has data for". Same offline-safe, no-<script>, inline-SVG constraints as
// html.js (see that file's header) - this is a second report page reusing its STYLE/TV_STYLE
// constants and the shared chart primitives, not a variant of the baseline/compare report itself.
//
// Designed to be read from across a room off a TV during a presentation: light and high-contrast
// regardless of the viewing device's own dark-mode setting, a wide layout, and a large type scale.
// TV_STYLE (defined in html.js, shared with --baseline/--compare) is appended after STYLE in this
// page's own <style> tag - see its header comment in html.js for why it stays light no matter what
// the TV/browser's own theme is set to.

import { STYLE, TV_STYLE } from './html.js';
import { horizontalBars, stackedShareBar, timeSeriesBars, hourOfDayChart, dayOfWeekChart, fmtCompact } from './charts.js';
import { BUSINESS_HOUR_START, BUSINESS_HOUR_END, LATE_NIGHT_START, LATE_NIGHT_END, DOW_LABELS } from './activityMetrics.js';

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return Math.round(n).toLocaleString('en-US');
}

function fmtNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function usd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function fmtWhen(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `<span title="${esc(iso)}">${esc(date)}, ${esc(time)}</span>`;
}

function fmtDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return 'n/a';
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// `eyebrow` renders as a shell-prompt-styled tag above the heading (e.g. "activity --hour-of-day") -
// this report's one signature visual device, tying the page back to the fact that everything on it
// was read out of a command-line tool. Used consistently, once per section, nowhere else.
function section(title, bodyHtml, { lede, eyebrow } = {}) {
  return `<section>
  ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
  <h2>${esc(title)}</h2>
  ${lede ? `<p class="lede">${lede}</p>` : ''}
  ${bodyHtml}
</section>`;
}

// "23" -> "23:00". Used wherever a single hour is named in prose or a KPI value, so the page never
// leaves a bare number that could be read as a count.
function fmtHour(hour) {
  if (hour === null || hour === undefined) return 'n/a';
  return `${String(hour).padStart(2, '0')}:00`;
}

// 0 -> "Sunday". Same contract as fmtHour(): never renders a bare index, never throws on null.
function fmtDay(day) {
  if (day === null || day === undefined) return 'n/a';
  return DOW_LABELS[day] ?? 'n/a';
}

// A weekend-intensity percentage in words. The number on its own is easy to misread in either
// direction - 40% sounds low until you realise it means a Saturday carries nearly half a working
// day's load - so every rendering of it is paired with one of these.
function weekendVerdict(intensityPct, weekendNoun) {
  if (intensityPct === null || intensityPct === undefined) return '';
  if (intensityPct >= 85) return `A weekend day looks essentially identical to a working day - there is no weekend here in the ${weekendNoun} data.`;
  if (intensityPct >= 50) return `A weekend day carries over half a working day's load - the weekend is a slower version of the week, not a break from it.`;
  if (intensityPct >= 20) return `Weekends are clearly lighter than weekdays, but not off - work spills into them regularly.`;
  if (intensityPct > 0) return `Weekends are close to genuinely off, with only occasional spillover.`;
  return `No ${weekendNoun} activity at all on a Saturday or Sunday in this window.`;
}

function kpiCard(label, value, meaning) {
  return `<div class="kpi kpi-neutral">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-values"><span class="kpi-after">${esc(value)}</span></div>
    <p class="kpi-meaning">${esc(meaning)}</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Headline KPIs
// ---------------------------------------------------------------------------

function headlineKpis(rd) {
  const cost = rd.tokens.cost;
  const cards = [
    kpiCard('Sessions, all time', fmtInt(rd.sessions.totalAllTime), `Every conversation Claude Code has recorded since ${rd.period.firstSessionDate ? fmtWhen(rd.period.firstSessionDate).replace(/<[^>]+>/g, '') : 'it started tracking'}.`),
    kpiCard('Messages, all time', fmtInt(rd.sessions.totalMessagesAllTime), 'Total messages exchanged across every session on record.'),
    kpiCard('Longest session', rd.sessions.longestSession ? fmtDuration(rd.sessions.longestSession.duration) : 'n/a', rd.sessions.longestSession ? `${fmtInt(rd.sessions.longestSession.messageCount)} messages in one sitting.` : 'No session-length data recorded.'),
    kpiCard('Total tokens, all time', cost ? fmtCompact(rd.tokens.totals.total) : 'n/a', 'Every token class combined, summed across every model you have used.'),
    kpiCard('Estimated spend, all time', cost ? usd(cost.total) : 'n/a', 'Priced at published API list rates - see the note at the bottom of this page.'),
  ];

  // "Prompts typed" replaces the commits/worktrees/lines-written cards that used to sit here. Those
  // three were all mined from transcripts, which rotate at ~30 days, so an "at a glance" scoreboard
  // headed by the tool's full lifetime was mixing lifetime figures with month-to-date ones and
  // labelling the result as if it were all-time - the commit count in particular counted `git commit`
  // *invocations* in a shell, not commits that actually landed. This one is exact and genuinely
  // all-time: history.jsonl is not rotated, so it is the one activity figure that matches the
  // lifetime framing the rest of this section uses.
  if (rd.promptHours) {
    cards.push(
      kpiCard(
        'Prompts typed, all time',
        fmtInt(rd.promptHours.total),
        `Every prompt you have submitted, across ${fmtInt(rd.promptHours.spanDays)} days - read from history.jsonl, which is not subject to transcript rotation.`
      )
    );
  }

  // A commit figure earns a place here again only because it is now read from the repositories' real
  // history rather than inferred from transcripts. It is still a floor, and the card says so - the
  // word "at least" is doing real work and should not be edited out.
  const g = rd.gitActivity;
  if (g?.available && g.claudeCommits > 0) {
    cards.push(
      kpiCard(
        'Commits Claude helped land',
        `${fmtInt(g.claudeCommits)}+`,
        `At least this many commits you authored carry a Claude attribution marker, across ${fmtInt(g.reposWithClaudeCommits)} repo(s)${
          g.claudeSharePct !== null ? ` - ${fmtNum(g.claudeSharePct, 0)}% of everything you committed` : ''
        }. Read from real git history, not transcripts. A floor, not a total.`
      )
    );
  }
  return `<div class="kpi-grid">${cards.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Steadiness of usage ("uptime")
// ---------------------------------------------------------------------------

function steadinessSection(rd) {
  const cov = rd.coverage;
  const hod = rd.hourOfDay;
  const dow = rd.dayOfWeek;
  const ph = rd.promptHours;
  if (!cov && !hod) {
    return '<p class="callout callout-warn"><strong>No activity data available.</strong> Nothing this machine keeps - the usage cache, the transcripts still on disk, or the typed-prompt history - has any recorded activity, so activity history and hour-of-day patterns cannot be shown.</p>';
  }

  const cachedRows = (rd.dailyActivity ?? [])
    .filter((d) => (d.messageCount ?? 0) > 0 || (d.sessionCount ?? 0) > 0)
    .map((d) => ({ label: d.date, value: d.messageCount, valueText: `${fmtInt(d.messageCount)} messages, ${fmtInt(d.sessionCount)} session(s)` }));

  // Plain em dashes here, not &mdash; - this string is passed through kpiCard(), which escapes its
  // meaning text (correctly, since most callers pass plain text), so an HTML entity here would come
  // out double-encoded as the literal text "&mdash;" instead of a dash.
  const spreadVerdict = !hod
    ? ''
    : hod.hourSpreadPct >= 90
      ? `Claude has been working in ${hod.hoursWithActivity} of the 24 hours of the day at some point — usage is spread around the clock rather than confined to a shift.`
      : hod.hourSpreadPct >= 60
        ? `Claude has been working in ${hod.hoursWithActivity} of 24 hours — a wide spread, but with a clear quiet stretch.`
        : `Claude's working hours are concentrated in just ${hod.hoursWithActivity} of the 24 hours — this looks like a working-hours pattern, not round-the-clock use.`;

  const lateVerdict = !ph
    ? ''
    : ph.lateNightPct >= 10
      ? `A substantial ${fmtNum(ph.lateNightPct, 1)}% of every prompt you have typed landed in that band.`
      : ph.lateNightPct >= 3
        ? `${fmtNum(ph.lateNightPct, 1)}% of every prompt you have typed landed in that band - a real, recurring habit rather than a one-off.`
        : `Only ${fmtNum(ph.lateNightPct, 1)}% of your prompts landed in that band.`;

  const covCards = cov
    ? `${kpiCard('Active-day coverage', cov.coveragePct === null ? 'n/a' : `${fmtNum(cov.coveragePct, 1)}%`, `${fmtInt(cov.activeDays)} active day(s) out of ${fmtInt(cov.totalCalendarDays)} calendar days between ${cov.firstActiveDate} and ${cov.lastActiveDate}.`)}
      ${kpiCard('Longest streak', `${fmtInt(cov.longestStreakDays)} day(s)`, 'The longest unbroken run of consecutive active days.')}
      ${kpiCard('Longest quiet gap', `${fmtInt(cov.longestGapDays)} day(s)`, 'The longest run of consecutive days with no recorded activity at all.')}`
    : '';
  const hodCard = hod ? kpiCard('Hour-of-day spread', `${fmtInt(hod.hoursWithActivity)} / 24 hours`, spreadVerdict) : '';

  // Prompt-side KPIs sit in the same grid as the coverage ones rather than a second block: they are
  // more facts about the same question ("when do you actually work"), not a different report.
  const promptCards = ph
    ? `${kpiCard('Prompts typed', fmtInt(ph.total), `Every prompt you have submitted, across ${fmtInt(ph.spanDays)} days and ${fmtInt(ph.distinctSessions)} sessions${ph.slashCommands ? `, including ${fmtInt(ph.slashCommands)} slash commands` : ''}.`)}
      ${kpiCard('Busiest hour', fmtHour(ph.peakHour), `${fmtInt(ph.peakHourPrompts)} prompts (${fmtNum(ph.peakHourPct, 1)}% of the total) were typed in this hour.`)}
      ${kpiCard('Late-night prompts', fmtInt(ph.lateNightPrompts), `Typed between ${fmtHour(LATE_NIGHT_START)} and ${fmtHour(LATE_NIGHT_END)}. ${lateVerdict}`)}
      ${kpiCard('Hours you have prompted in', `${fmtInt(ph.hoursWithActivity)} / 24`, 'Distinct hours of the day in which you have typed at least one prompt.')}`
    : '';

  // Weekend KPIs lead with intensity (per-day, normalised) rather than share, because share is the
  // figure a reader gets wrong: five weekdays against two weekend days means an evenly-worked week
  // still reports only ~28.6% weekend share. Share is still shown, in the meaning text, next to the
  // 28.6% it has to be read against.
  const wkPrompts = dow?.prompts ?? null;
  const wkClaude = dow?.claude ?? null;
  const weekendCards =
    wkPrompts && wkPrompts.total
      ? `${kpiCard(
          'Busiest day of the week',
          fmtDay(wkPrompts.busiestDay),
          `${fmtInt(wkPrompts.busiestDayCount)} prompts (${fmtNum(wkPrompts.busiestDaySharePct, 1)}% of the total) were typed on a ${fmtDay(wkPrompts.busiestDay)}. The quietest is ${fmtDay(wkPrompts.quietestDay)}, with ${fmtInt(wkPrompts.quietestDayCount)}.`
        )}
      ${kpiCard(
        'Weekend intensity',
        wkPrompts.weekendIntensityPct === null ? 'n/a' : `${fmtNum(wkPrompts.weekendIntensityPct, 0)}%`,
        `Prompts per weekend day as a share of prompts per weekday${
          wkPrompts.weekendPerDay !== null && wkPrompts.weekdayPerDay !== null
            ? ` (${fmtNum(wkPrompts.weekendPerDay, 1)} vs ${fmtNum(wkPrompts.weekdayPerDay, 1)} per day)`
            : ''
        }. ${weekendVerdict(wkPrompts.weekendIntensityPct, 'prompt')}`
      )}
      ${kpiCard(
        'Weekend share of prompts',
        wkPrompts.weekendSharePct === null ? 'n/a' : `${fmtNum(wkPrompts.weekendSharePct, 1)}%`,
        `${fmtInt(wkPrompts.weekendTotal)} of ${fmtInt(wkPrompts.total)} prompts landed on a Saturday or Sunday. Read this against 28.6% - the share two days out of seven would hold if every day were worked equally.`
      )}`
      : '';

  const cachedChart = cachedRows.length
    ? `<h3>Messages per active day (all-time, usage cache)</h3>
  ${timeSeriesBars(cachedRows, { valueLabel: 'messages per day' })}
  <p class="muted">One bar per day the usage cache recorded any activity (${cachedRows.length} days), through ${esc(rd.period.lastComputedDate ?? 'its last computation')}. Gaps in the axis are days with zero activity, not zero-height bars.</p>`
    : '';

  // One hour-of-day chart, two series. The prompts series covers everything you have ever typed; the
  // Claude-working series covers what the transcripts still hold. That difference is a provenance
  // detail, documented once in "How to read this page" - it is not a second chart, a third series, or
  // an extra legend key here, because the reader's question ("what hours do I work?") is one question.
  const hodChart = hod
    ? `<h3>What hour of day work happens</h3>
  <p class="callout callout-info">Two series, both by local hour. &ldquo;Claude working&rdquo; counts every assistant turn and tool round-trip across main sessions, subagents and workflow agents - so a session left running unattended overnight or for days shows up as hours of activity, not one entry at whatever hour you started it. &ldquo;Your prompts&rdquo; counts what you actually typed${ph ? `: ${fmtInt(ph.total)} prompts over ${fmtInt(ph.spanDays)} days, from ${fmtWhen(ph.firstPromptAt)} to ${fmtWhen(ph.lastPromptAt)}` : ''}. Each series is scaled against its own total, since a single prompt can set off dozens of tool round-trips.</p>
  ${hourOfDayChart(hod.hours, {
    businessStart: BUSINESS_HOUR_START,
    businessEnd: BUSINESS_HOUR_END,
    lateNightStart: LATE_NIGHT_START,
    lateNightEnd: LATE_NIGHT_END,
  })}
  <p class="muted">${fmtNum(hod.businessHoursSharePct, 1)}% of all Claude-working events fell inside a conventional ${fmtHour(BUSINESS_HOUR_START)}&ndash;${fmtHour(BUSINESS_HOUR_END)} workday; the rest happened outside it, including any overnight or multi-day unattended runs.${
    ph
      ? ` On the prompt side, ${fmtNum(ph.businessHoursSharePct, 1)}% of what you typed landed inside those hours, and ${fmtInt(ph.lateNightPrompts)} prompt(s) (${fmtNum(ph.lateNightPct, 1)}%) landed between ${fmtHour(LATE_NIGHT_START)} and ${fmtHour(LATE_NIGHT_END)}.`
      : ''
  }</p>${
    ph && ph.monthly.length
      ? `
  <p class="muted">Prompts per month: ${ph.monthly.map((m) => `${esc(m.month)} (${fmtInt(m.prompts)})`).join(', ')}.</p>`
      : ''
  }`
    : '';

  // A second chart rather than a second series on the first one: hour-of-day and day-of-week are
  // orthogonal axes over the same events, and overlaying them would need a 24x7 heatmap, which trades
  // the one thing this page is for (readable across a room) for detail nobody asked for. The two
  // charts share a visual grammar instead, so reading the second costs nothing once the first is read.
  const dowChart = dow
    ? `<h3>What day of the week work happens</h3>
  <p class="callout callout-info">The same two series as above, folded into the seven days of the week by local date. The dashed line marks ${fmtNum(dow.evenSharePct, 1)}% &ndash; the share each day would hold if work were spread evenly &ndash; so a bar above it is a genuinely busier day rather than ordinary noise. Shaded columns are the weekend.</p>
  ${dayOfWeekChart(dow.days, { evenSharePct: dow.evenSharePct })}
  <p class="muted">${
    wkClaude && wkClaude.total
      ? `Claude worked on ${fmtInt(wkClaude.daysWithActivity)} of the 7 days of the week, busiest on ${fmtDay(wkClaude.busiestDay)} (${fmtNum(wkClaude.busiestDaySharePct, 1)}% of all Claude-working events)${
          wkClaude.weekendIntensityPct !== null
            ? `, and a weekend day ran at ${fmtNum(wkClaude.weekendIntensityPct, 0)}% of a weekday's volume`
            : ''
        }. `
      : ''
  }${
    wkPrompts && wkPrompts.total
      ? `On the prompt side, ${fmtInt(wkPrompts.weekdayTotal)} prompt(s) were typed on weekdays and ${fmtInt(wkPrompts.weekendTotal)} at the weekend${
          wkPrompts.weekdayDays !== null && wkPrompts.weekendDays !== null
            ? `, across ${fmtInt(wkPrompts.weekdayDays)} weekdays and ${fmtInt(wkPrompts.weekendDays)} weekend days of elapsed calendar time`
            : ''
        }. ${weekendVerdict(wkPrompts.weekendIntensityPct, 'prompt')}`
      : ''
  }</p>
  <p class="muted">Per-day averages here divide by every calendar day in the window, not just the active ones &mdash; a Saturday you did not work is exactly the signal this is measuring, so dropping it would assume the answer. The two series divide by different windows: the prompts series spans ${ph ? `${fmtInt(ph.spanDays)} days` : 'the whole typed-prompt history'}, the Claude-working series only the transcripts still on disk.</p>`
    : '';

  return `<p class="callout callout-info"><strong>What &ldquo;uptime&rdquo; means here.</strong> Claude Code is an interactive CLI, not a server, so there is no process to ask &ldquo;was it running 24/7&rdquo;. The closest honest signal this machine can give is <em>presence</em>: on how many days did you actually use it, and at what hours. That is what this section shows.</p>
  <div class="kpi-grid">
    ${covCards}
    ${hodCard}
    ${promptCards}
    ${weekendCards}
  </div>
  ${cachedChart}
  ${hodChart}
  ${dowChart}`;
}

// ---------------------------------------------------------------------------
// Tokens & cost
// ---------------------------------------------------------------------------

function tokenSection(rd) {
  const t = rd.tokens;
  if (!t.totals) return '<p class="callout callout-warn">No token usage data available - no usage cache and no priced turns found in transcripts still on disk.</p>';

  const stale = rd.period.staleness;
  const stalenessNote =
    stale && stale.daysSinceComputed !== null
      ? `<p class="callout ${stale.daysSinceComputed > 3 ? 'callout-warn' : 'callout-info'}"><strong>Usage cache is ${fmtInt(stale.daysSinceComputed)} day(s) old</strong> (last computed ${esc(stale.lastComputedDate)}).${
          t.liveSupplementTotal > 0
            ? ` ${fmtInt(t.liveSupplementTotal)} tokens since then were recovered from transcripts still on disk and are already included in the totals below - this is what makes a recently-adopted model (e.g. Sonnet 5, Opus 5) show up even though the cache itself hasn't recomputed.`
            : ' No transcripts newer than the cache were found on disk to supplement it with, so any model or activity newer than the cache date is not reflected below.'
        }${
          stale.unrecoverableGapDays
            ? ` There is also a gap of roughly ${fmtInt(stale.unrecoverableGapDays)} day(s) between the cache date and the oldest transcript still on disk that neither source can fill - permanently unrecoverable.`
            : ''
        }</p>`
      : '';

  const bar = stackedShareBar([
    { label: 'Cache read', value: t.totals.cacheReadTokens, valueText: fmtInt(t.totals.cacheReadTokens), colorVar: 'series-1' },
    { label: 'Cache write', value: t.totals.cacheCreationTokens, valueText: fmtInt(t.totals.cacheCreationTokens), colorVar: 'series-2' },
    { label: 'Output', value: t.totals.outputTokens, valueText: fmtInt(t.totals.outputTokens), colorVar: 'series-3' },
    { label: 'Input', value: t.totals.inputTokens, valueText: fmtInt(t.totals.inputTokens), colorVar: 'series-4' },
  ]);

  const modelChart = t.cost
    ? horizontalBars(
        t.cost.perModel.slice(0, 10).map((m) => ({ label: m.model, value: m.cost, valueText: usd(m.cost), colorVar: 'series-1' }))
      )
    : '';

  const rows = (t.cost?.perModel ?? [])
    .map(
      (m) => `<tr>
      <td>${esc(m.model)}${m.priced ? '' : ' <span class="badge badge-warn">unpriced, costed at Opus rate</span>'}</td>
      <td class="num">${fmtInt(m.tokens.total)}</td>
      <td class="num">${esc(usd(m.cost))}</td>
    </tr>`
    )
    .join('');

  return `${stalenessNote}${bar}
  <h3>Estimated spend by model</h3>
  ${modelChart}
  <table>
    <thead><tr><th>Model</th><th class="num">Total tokens</th><th class="num">Estimated cost</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="muted">no per-model data</td></tr>'}</tbody>
  </table>
  <p class="muted">Priced with the same list-rate table <code>--baseline</code>/<code>--compare</code> use (version ${esc(t.costModelNotes.priceTableVersion)}). Combines Claude Code's own all-time token cache with anything newer found live in transcripts still on disk (see note above). No per-model TTL cache-write split is recorded in the cached portion, so cache writes are costed at the flat ${t.costModelNotes.cacheWriteFallbackMultiplier}&times; rate throughout (see <code>--help</code> report for the exact/flat distinction).</p>`;
}

// ---------------------------------------------------------------------------
// Git / GitHub
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Git activity (harvested from real repositories)
// ---------------------------------------------------------------------------
// Replaces the transcript-mined commit counts this report used to carry. See scan/gitHarvest.js for
// the four problems the harvest had to solve and the evidence behind each; the prose here only has to
// convey the two a reader needs in order not to misread the numbers: they are restricted to YOUR
// author identity (a shared repo contains other people's Claude commits), and they are a FLOOR
// (attribution depends on a marker in the commit message, which is a convention, not a guarantee).

function gitSection(rd) {
  const g = rd.gitActivity;
  if (!g) {
    return '<p class="callout callout-info"><strong>Git harvest skipped.</strong> This report was generated with <code>--no-git</code>, so no repository history was read. Re-run without that flag to include real commit figures.</p>';
  }
  if (!g.available) {
    return `<p class="callout callout-warn"><strong>Git harvest unavailable.</strong> ${esc(g.reason ?? 'unknown reason')}. No commit figures are shown rather than estimated ones - the transcript-derived counts this section used to carry were removed for being wrong by a wide margin, and a guess is not an improvement on nothing.</p>`;
  }
  if (!g.claudeCommits) {
    return `<p class="callout callout-info"><strong>No Claude-attributed commits found.</strong> ${fmtInt(g.reposHarvested)} repository(ies) were read, but none contained a commit authored by you carrying an attribution marker (${g.markers.map((m) => `<code>${esc(m)}</code>`).join(' or ')}). If your commits do not carry one of these, this section cannot see them - that is a limitation of the marker convention, not a claim that no work happened.</p>`;
  }

  const monthlyRows = (g.monthly ?? []).map((m) => ({
    label: m.month,
    value: m.commits,
    valueText: `${fmtInt(m.commits)} commit(s), +${fmtInt(m.insertions)}/-${fmtInt(m.deletions)}`,
  }));

  const repoRows = (g.repos ?? [])
    .map(
      (r) => `<tr>
        <td><strong>${esc(r.fullName ?? r.name)}</strong>${
          (r.aliasPaths ?? []).length
            ? `<br><span class="muted">harvested once, via ${fmtInt(r.aliasPaths.length + 1)} checkout(s) on disk</span>`
            : ''
        }</td>
        <td class="num">${fmtInt(r.claudeCommits)}</td>
        <td class="num">${fmtInt(r.authoredCommits)}</td>
        <td class="num">${r.claudeSharePct === null ? 'n/a' : `${fmtNum(r.claudeSharePct, 0)}%`}</td>
        <td class="num">+${fmtInt(r.insertions)} / -${fmtInt(r.deletions)}</td>
        <td>${esc((r.firstClaudeCommitAt ?? '').slice(0, 10))} &ndash; ${esc((r.lastClaudeCommitAt ?? '').slice(0, 10))}</td>
      </tr>`
    )
    .join('');

  // Duplicates are worth stating explicitly rather than hiding: they are the single most likely way
  // this kind of figure gets silently inflated, and saying how many were collapsed is the only way a
  // reader can tell the dedupe actually ran.
  const dupes = (g.skipped ?? []).filter((sk) => /worktree of|shares history with/.test(sk.reason ?? '')).length;
  const missing = (g.skipped ?? []).filter((sk) => /no longer exists/.test(sk.reason ?? '')).length;

  return `<p class="callout callout-warn"><strong>Every number here is a floor, not a total.</strong> A commit counts as Claude-assisted only if its message carries an attribution marker (${g.markers
    .map((m) => `<code>${esc(m)}</code>`)
    .join(' or ')}). Commits from a session that did not emit one, or from before you adopted the convention, are invisible to this and always will be. Read these as &ldquo;at least this much&rdquo;.</p>
  <div class="kpi-grid">
    ${kpiCard('Commits Claude helped land', `${fmtInt(g.claudeCommits)}+`, `Non-merge commits authored by you carrying an attribution marker${g.claudeMergesExcluded ? `. A further ${fmtInt(g.claudeMergesExcluded)} merge commit(s) also carried one and are excluded, because a merge would double-count the branch commits underneath it` : ''}.`)}
    ${kpiCard('Share of your commits', g.claudeSharePct === null ? 'n/a' : `${fmtNum(g.claudeSharePct, 1)}%`, `Of the ${fmtInt(g.authoredCommits)} non-merge commits you authored in these repositories, this share carries a Claude marker. Both halves are restricted to your own git identity, so a shared repo's other authors do not inflate it.`)}
    ${kpiCard('Lines added', `+${fmtCompact(g.insertions)}`, `Real insertions from the diffs of those commits - what actually landed, not what was typed into a tool call.`)}
    ${kpiCard('Lines removed', `-${fmtCompact(g.deletions)}`, `Real deletions from the same diffs. Net change: ${g.netLines >= 0 ? '+' : ''}${fmtCompact(g.netLines)} line(s) across ${fmtInt(g.filesChanged)} file touches.`)}
    ${kpiCard('Repositories', fmtInt(g.reposWithClaudeCommits), `Distinct repositories with at least one Claude-assisted commit, out of ${fmtInt(g.reposHarvested)} read${dupes ? ` (${fmtInt(dupes)} duplicate path(s) collapsed - worktrees and second clones share one history and would otherwise be counted twice)` : ''}.`)}
    ${kpiCard('First Claude commit', esc((g.firstClaudeCommitAt ?? '').slice(0, 10)) || 'n/a', `The earliest one found${g.spanDays ? `, ${fmtInt(g.spanDays)} days before the most recent` : ''}. Unlike anything derived from transcripts, this is not capped by the ~30-day retention window.`)}
  </div>
  ${
    monthlyRows.length > 1
      ? `<h3>Claude-assisted commits per month</h3>
  ${timeSeriesBars(monthlyRows, { valueLabel: 'commits per month' })}
  <p class="muted">Months with no Claude-attributed commits are absent from the axis rather than drawn as zero-height bars.</p>`
      : ''
  }
  <h3>By repository</h3>
  <table>
    <thead><tr><th>Repository</th><th class="num">Claude commits</th><th class="num">Your commits</th><th class="num">Share</th><th class="num">Lines (+/-)</th><th>Span</th></tr></thead>
    <tbody>${repoRows}</tbody>
  </table>
  <p class="muted">Each row is one <em>repository</em>, named by its remote rather than by the directory it happens to sit in, and counted once however many checkouts of it exist on this machine. A <code>git worktree</code> reports its parent's entire history, so a row labelled by a worktree's directory name would be naming the wrong thing while reporting the right numbers. Repositories are discovered from the working directories recorded in transcripts still on disk, so a repo you have not opened in Claude Code for ~30 days will not appear here even though its history is intact - pass <code>--git-repo &lt;path&gt;</code> to add one. ${
    dupes ? `${fmtInt(dupes)} directory(ies) were skipped as duplicates of a repository already counted. ` : ''
  }${missing ? `${fmtInt(missing)} recorded directory(ies) no longer exist on disk. ` : ''}Identity resolution used ${fmtInt(g.identityCount)} git author identity(ies); the addresses themselves are deliberately not printed into this report.</p>`;
}

// ---------------------------------------------------------------------------
// Code output, tools, projects
// ---------------------------------------------------------------------------
// There is deliberately no "Git activity" section here any more. It reported `git commit`/`git push`
// *shell invocations* found in transcripts still on disk, which is wrong twice over: it counts
// attempts rather than commits that landed (a rejected pre-commit hook, an amend, a retry after a
// conflict each scored a commit), it cannot see any commit made outside a Claude Code session, and
// transcript rotation caps the whole thing at ~30 days while the page around it is framed as
// all-time. On this corpus that read 645 "commits" for a month against 1,681 real Claude-attributed
// commits in the underlying repos since January. The scanner still collects these counts and they are
// still present in the report JSON (so --merge is unaffected, and nothing needs re-instrumenting);
// only the presentation is gone, because a number this far off is worse than no number.

function codeSection(rd) {
  const c = rd.code;
  return `<div class="kpi-grid">
    ${kpiCard('Lines written (Write tool)', fmtInt(c.linesWritten), 'Total line count of file content passed to the Write tool - new files and full-file rewrites.')}
    ${kpiCard('Lines added (Edit tool)', fmtInt(c.editLinesAdded), 'Line count of the replacement text in every Edit call.')}
    ${kpiCard('Lines removed (Edit tool)', fmtInt(c.editLinesRemoved), 'Line count of the text each Edit call replaced.')}
  </div>
  <p class="callout callout-warn"><strong>This is an estimate, not a diff.</strong> It counts lines passed to the Write/Edit tools in transcripts still on disk - it cannot see whether an edit was reverted, whether the same lines were rewritten several times in one session, or code changed by any other means. Treat it as a sense of volume, not an audit trail.</p>`;
}

function toolsSection(rd) {
  const chart = rd.tools.topTools.length
    ? horizontalBars(rd.tools.topTools.slice(0, 12).map((t) => ({ label: t.tool, value: t.calls, valueText: fmtInt(t.calls), colorVar: 'series-1' })))
    : '<p class="muted">No tool-call data.</p>';
  return `<div class="kpi-grid">
    ${kpiCard('Subagents spawned', fmtInt(rd.projects.subagentFiles), 'Task/Agent tool invocations that produced their own transcript file.')}
    ${kpiCard('Workflow runs', fmtInt(rd.projects.workflowRunsSeen), 'Distinct multi-agent Workflow orchestration runs.')}
    ${kpiCard('Workflow agent calls', fmtInt(rd.projects.workflowAgentFiles), 'Individual agent invocations inside all workflow runs combined.')}
    ${kpiCard('Skills invoked', fmtInt(rd.skillInvocations), 'Times a packaged skill was loaded into context.')}
    ${kpiCard('Distinct projects/repos', fmtInt(rd.projects.distinctCount), 'Distinct working directories Claude Code has a transcript for (each worktree counts separately from its parent repo).')}
  </div>
  <h3>Most-used tools</h3>
  ${chart}`;
}

// ---------------------------------------------------------------------------
// Method / caveats
// ---------------------------------------------------------------------------

function methodSection(rd) {
  const merged = Array.isArray(rd.sources) && rd.sources.length > 0;
  return `<div class="explainer">
    <h3>Where this data comes from</h3>
    <ul>
      <li><strong>All-time sessions/messages figures</strong> come from Claude Code's own <code>stats-cache.json</code>, last computed <strong>${esc(rd.period.lastComputedDate ?? 'unknown')}</strong>. It persists across transcript rotation, so it is the only source here with a history longer than about 30 days - but it is only recomputed by Claude Code on its own schedule, not on every run, so it can lag behind today.</li>
      <li><strong>The hour-of-day chart's two series come from two different files, and reach back different distances.</strong> &ldquo;Your prompts&rdquo; is read from <code>history.jsonl</code>, Claude Code's own log of every prompt typed into the prompt box, which is <em>not</em> rotated with the transcripts - so that series covers your whole history${rd.promptHours ? ` - ${fmtInt(rd.promptHours.spanDays)} days of it, back to ${esc((rd.promptHours.firstPromptAt ?? '').slice(0, 10))}` : ''}. &ldquo;Claude working&rdquo; is computed from transcript timestamps still on disk, which rotate after roughly 30 days; <code>history.jsonl</code> holds no record of Claude's side of the conversation, so the older part of that series is permanently gone and is left missing rather than estimated. The chart shows them together, each scaled against its own total, because the question they answer is one question - the difference in reach is recorded here rather than as a second chart. Neither series comes from the cache's <code>hourCounts</code> field: an audit found that counts one entry per <em>session start</em>, not per unit of activity, so a session left running unattended for hours or days registered identically to a 30-second one. &ldquo;Your prompts&rdquo; also excludes Claude Code's own system-injected turns - background task/subagent notifications, teammate messages, scheduled-loop or cron check-ins, skill payloads and slash-command artifacts - which a further audit found made up roughly half of all non-tool-result &ldquo;user&rdquo; lines in a real sample, and were previously counted as if you had typed them at whatever hour they happened to fire. Slash commands you did type are counted (typing <code>/clear</code> at 23:40 is still you at the keyboard at 23:40), and nothing is deduplicated, since typing the same prompt twice is two prompts.</li>
      <li><strong>The weekday/weekend split is normalised per day, because the raw share is misleading.</strong> A week has five weekdays and two weekend days, so someone who works a Saturday exactly as hard as a Tuesday still shows only 28.6% of their activity at the weekend - a figure most readers will file as &ldquo;I barely work weekends&rdquo;. The report therefore leads with <em>weekend intensity</em>: events per weekend day as a percentage of events per weekday, where 100% means a weekend day is indistinguishable from a working day. The raw share is still shown, next to the 28.6% it has to be read against. Both denominators count <em>every</em> calendar day in the window, not just the active ones, since a Saturday you did not work is precisely the signal being measured. Day of week is taken from local time, not UTC: a prompt typed at 23:40 on a Friday is Friday-night work, and bucketing by UTC date would push a real share of late-evening work onto the next day - which on a Friday manufactures weekend activity that never happened. The two series divide by different windows, for the same reason their hour-of-day counterparts reach back different distances.</li>
      <li><strong>Token/model totals</strong> combine the cached totals with anything newer found live in transcripts still on disk (deduplicated by message id, so nothing is double-counted) - this is what lets a model adopted after the cache's last computation (e.g. a newly-released model) still show up in the cost breakdown.</li>
      <li><strong>Lines written/edited</strong> comes from that same fresh read of every transcript file still on disk${merged ? ' on each merged machine' : ` under <code>${esc(rd.claudeDir)}</code>`} (${fmtInt(rd.scan.filesScanned)} files total this run). Local transcripts rotate after roughly 30 days, so this figure only covers recent activity even though the page is titled by the tool's full lifetime - which is why it is confined to its own section, under its own warning, rather than appearing in the scoreboard at the top.</li>
      <li><strong>Git activity is read from your real repositories, not from transcripts.</strong> An earlier version of this page counted <code>git commit</code> and <code>git push</code> shell invocations found in transcripts and presented them as commits and pushes. That was wrong three ways over: it counted <em>attempts</em> rather than commits that landed, it was blind to every commit made outside a Claude Code session, and transcript rotation capped it at ~30 days on a page framed as all-time. It now runs read-only <code>git log</code> queries against the repositories themselves, which four things make honest: commits are restricted to <strong>your own author identity</strong> (a shared repo here contained Claude-attributed commits from at least five different people - counting them all would report your team's usage as yours); repositories are deduplicated by <strong>root-commit hash</strong> rather than path (a worktree reports its parent's entire history, and on this machine that had the same repo appearing three times under different paths); merge commits carrying a marker are <strong>excluded</strong> from the headline, because a merge would double-count the branch commits beneath it; and line counts come from <strong>the commits' real diffs</strong>, not from tool-call text. Everything it produces is a <em>floor</em>: attribution depends on a marker in the commit message, so any commit that never carried one is invisible. Repository <em>discovery</em> is still bounded by the transcript window - the tool has to have seen you working somewhere to know the repo exists - but the <em>history</em> read out of each discovered repo is complete. <code>--git-repo</code> adds repos by hand; <code>--no-git</code> skips the whole step and keeps the run inside <code>~/.claude</code>.</li>
    </ul>
    ${
      merged
        ? `<h3>How the merged sources were combined</h3>
    <p>This report was built with <code>--merge</code> from ${fmtInt(rd.sources.length)} separate <code>--visualise</code> JSON reports (see the source table above). Figures were combined per field, not simply concatenated:</p>
    <ul>
      <li><strong>Summed</strong> (each source's activity is genuinely independent, so nothing here can double-count): sessions, messages, tokens, prompts typed, lines written/edited, subagent/workflow counts, transcript files scanned.</li>
      <li><strong>Combined by repository identity, not summed</strong>: git figures are keyed on each repository's root-commit hash, which is identical in every clone on every machine. Two machines holding the same repo therefore contribute it once, at the larger of the two views, rather than twice - a commit is a fact about the repository, not about the machine that read it.</li>
      <li><strong>Recomputed from combined raw data</strong>, not averaged: daily activity is merged date-by-date before active-day coverage, streaks and gaps are recalculated; hour-of-day and day-of-week counts - both the transcript-window series and the full-lifetime typed-prompt series - are summed per slot before percentages are recalculated, and the lifetime prompt span becomes the union of the sources' spans rather than any kind of total. The weekday/weekend per-day denominators are recomputed from that union span rather than summed across sources, since summing would double-count every calendar day two machines were both active on; note that a union span also credits each machine with days it may not have been in use for, so merged per-day rates are a floor rather than an exact figure, and machines in different timezones each bucket their own events locally before being combined. Averaging the already-derived percentages instead would have been wrong for anything path-dependent, like a streak that only exists because two machines' active days interleave.</li>
      <li><strong>Deduplicated</strong>: distinct project/worktree names are unioned rather than summed.</li>
    </ul>`
        : ''
    }
    <h3>What this page does not touch</h3>
    <p>This mode reads <code>stats-cache.json</code> and the transcript corpus, and writes only its own JSON/HTML pair under <code>claude-usage-baseliner/visualise/</code>. It never reads or writes <code>state.json</code>, so it cannot move, consume or otherwise affect your <code>--baseline</code> reference point or any <code>--compare</code> window.</p>
    <h3>Dollar figures are estimates, not a bill</h3>
    <p>As with <code>--baseline</code>/<code>--compare</code>, cost figures here are computed at published Claude API list rates and are not billing data - useful for a consistent sense of scale, not as an amount anyone invoiced you.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderVisualiseHtml(rd) {
  const merged = Array.isArray(rd.sources) && rd.sources.length > 0;

  // Every value here is either already a safe fmt*/esc() result or genuine inline HTML (fmtWhen's
  // <span title>), so this renders each value as-is rather than escaping it a second time.
  const metaItems = [
    ['Generated', fmtWhen(rd.generatedAt)],
    ['Usage cache since', rd.period.firstSessionDate ? fmtWhen(rd.period.firstSessionDate) : 'n/a'],
    ['Usage cache last computed', esc(rd.period.lastComputedDate ?? 'n/a')],
    ['Prompts typed (all time)', rd.promptHours ? fmtInt(rd.promptHours.total) : 'n/a'],
    ['Transcripts scanned', fmtInt(rd.scan.filesScanned)],
    [merged ? 'Merged from' : 'Scanned directory', merged ? `${fmtInt(rd.sources.length)} machine(s)` : esc(rd.claudeDir)],
  ];

  const sourcesPanel = merged
    ? `<div class="explainer">
      <h3>Sources merged into this report</h3>
      <table>
        <thead><tr><th>Claude directory</th><th>Report generated</th><th class="num">Transcripts scanned</th></tr></thead>
        <tbody>${rd.sources
          .map((s) => `<tr><td>${esc(s.claudeDir)}</td><td>${fmtWhen(s.generatedAt)}</td><td class="num">${fmtInt(s.filesScanned)}</td></tr>`)
          .join('')}</tbody>
      </table>
      <p class="muted">See &ldquo;How to read this page&rdquo; below for exactly how figures from each source were combined.</p>
    </div>`
    : '';

  const body = `<div class="wrap">
  <h1>What you did with Claude</h1>
  <p class="lede">${merged ? `Combined from ${fmtInt(rd.sources.length)} machines' ` : "Everything this machine's "}Claude Code usage cache and local transcripts can tell you about how you have actually used it - independent of, and without affecting, your <code>--baseline</code>/<code>--compare</code> data.</p>
  <div class="meta-grid">
    ${metaItems.map(([label, value]) => `<div class="meta-item"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`).join('')}
  </div>
  ${sourcesPanel}

  ${section('At a glance', headlineKpis(rd), { eyebrow: 'overview --scoreboard' })}
  ${section('How steady is your usage?', steadinessSection(rd), { eyebrow: 'activity --when', lede: 'Claude Code is a CLI, not a server, so "uptime" here means presence: how many days you used it, at what hours, and on which days of the week.' })}
  ${section('Tokens and estimated spend', tokenSection(rd), { eyebrow: 'tokens --spend', lede: 'All-time totals from Claude Code’s own usage cache, weighted the same way --baseline/--compare weight theirs.' })}
  ${section('Git activity', gitSection(rd), { eyebrow: 'git log --author=you', lede: 'Real commit history, read straight from the repositories you work in - not inferred from transcripts, and not capped by the ~30-day retention window.' })}
  ${section('Code written', codeSection(rd), { eyebrow: 'diff --stat' })}
  ${section('Tools, subagents and skills', toolsSection(rd), { eyebrow: 'tools --top' })}
  ${section('How to read this page', methodSection(rd), { eyebrow: '--help' })}

  <footer>
    <p>Generated by claude-usage-baseliner --visualise. This report is independent of, and does not read or write, the state used by --baseline/--compare.</p>
  </footer>
</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What you did with Claude - ${esc(rd.id)}</title>
<style>${STYLE}${TV_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}
