// Renders the self-contained --visualise dashboard: "what did you actually do with Claude over the
// period this machine has data for". Same offline-safe, no-<script>, inline-SVG constraints as
// html.js (see that file's header) - this is a second, unrelated report page reusing its STYLE
// constant and the shared chart primitives, not a variant of the baseline/compare report itself.
//
// Designed to be read from across a room off a TV during a presentation: light and high-contrast
// regardless of the viewing device's own dark-mode setting, a wide layout, and a large type scale.
// TV_STYLE below is appended after STYLE in this page's own <style> tag only - it redeclares shared
// tokens/classes (colors, .kpi, .wrap, chart text, etc.) for this document alone, so --baseline/
// --compare (which never load TV_STYLE) keep their exact existing look untouched.

import { STYLE } from './html.js';
import { horizontalBars, stackedShareBar, timeSeriesBars, hourOfDayChart, fmtCompact } from './charts.js';
import { BUSINESS_HOUR_START, BUSINESS_HOUR_END } from './activityMetrics.js';

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
    kpiCard('Commits run', fmtInt(rd.git.commits), 'Bash calls matching `git commit`, seen in transcripts still on disk.'),
    kpiCard('Worktrees created', fmtInt(Math.max(rd.worktrees.createdViaTool, rd.worktrees.projectTraceCount)), 'Distinct worktrees Claude Code created for you (EnterWorktree tool calls, cross-checked against project directory traces).'),
    kpiCard('Lines written or edited', fmtInt(rd.code.linesWritten + rd.code.editLinesAdded), 'Write-tool file content plus Edit-tool replacement text, in transcripts still on disk. An estimate, not a diff.'),
  ];
  return `<div class="kpi-grid">${cards.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Steadiness of usage ("uptime")
// ---------------------------------------------------------------------------

function steadinessSection(rd) {
  const cov = rd.coverage;
  const hod = rd.hourOfDay;
  if (!cov && !hod) {
    return '<p class="callout callout-warn"><strong>No activity data available.</strong> Neither the usage cache nor any transcripts still on disk have any recorded activity, so activity history and hour-of-day patterns cannot be shown.</p>';
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

  const covCards = cov
    ? `${kpiCard('Active-day coverage', cov.coveragePct === null ? 'n/a' : `${fmtNum(cov.coveragePct, 1)}%`, `${fmtInt(cov.activeDays)} active day(s) out of ${fmtInt(cov.totalCalendarDays)} calendar days between ${cov.firstActiveDate} and ${cov.lastActiveDate}.`)}
      ${kpiCard('Longest streak', `${fmtInt(cov.longestStreakDays)} day(s)`, 'The longest unbroken run of consecutive active days.')}
      ${kpiCard('Longest quiet gap', `${fmtInt(cov.longestGapDays)} day(s)`, 'The longest run of consecutive days with no recorded activity at all.')}`
    : '';
  const hodCard = hod ? kpiCard('Hour-of-day spread', `${fmtInt(hod.hoursWithActivity)} / 24 hours`, spreadVerdict) : '';

  const cachedChart = cachedRows.length
    ? `<h3>Messages per active day (all-time, usage cache)</h3>
  ${timeSeriesBars(cachedRows, { valueLabel: 'messages per day' })}
  <p class="muted">One bar per day the usage cache recorded any activity (${cachedRows.length} days), through ${esc(rd.period.lastComputedDate ?? 'its last computation')}. Gaps in the axis are days with zero activity, not zero-height bars.</p>`
    : '';

  const hodChart = hod
    ? `<h3>What hour of day work happens</h3>
  <p class="callout callout-info">This counts every assistant turn and tool round-trip as &ldquo;Claude working&rdquo;, across main sessions, subagents, and workflow agents - so a session you left running unattended overnight or for days shows up as hours of activity, not one entry at whatever hour you started it. &ldquo;Your prompts&rdquo; counts only genuine human-typed messages in main sessions, separately.</p>
  ${hourOfDayChart(hod.hours, { businessStart: BUSINESS_HOUR_START, businessEnd: BUSINESS_HOUR_END })}
  <p class="muted">${fmtNum(hod.businessHoursSharePct, 1)}% of all Claude-working events fell inside a conventional 09:00&ndash;17:00 workday; the rest happened outside it, including any overnight or multi-day unattended runs.</p>`
    : '';

  return `<p class="callout callout-info"><strong>What &ldquo;uptime&rdquo; means here.</strong> Claude Code is an interactive CLI, not a server, so there is no process to ask &ldquo;was it running 24/7&rdquo;. The closest honest signal transcripts and the usage cache can give is <em>presence</em>: on how many days did you actually use it, and at what hours. That is what this section shows.</p>
  <div class="kpi-grid">
    ${covCards}
    ${hodCard}
  </div>
  ${cachedChart}
  ${hodChart}`;
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

function gitSection(rd) {
  const g = rd.git;
  const w = rd.worktrees;
  const cards = [
    kpiCard('Commits', fmtInt(g.commits), '`git commit` invocations seen in transcripts still on disk.'),
    kpiCard('Pushes', fmtInt(g.pushes), '`git push` invocations.'),
    kpiCard('Worktrees created (tool)', fmtInt(w.createdViaTool), 'EnterWorktree tool calls that created a brand-new worktree (passed a `name`).'),
    kpiCard('Worktrees re-entered (tool)', fmtInt(w.enteredViaTool), 'EnterWorktree tool calls that switched into an existing worktree (passed a `path`), not a new one.'),
    kpiCard('Worktree project traces', fmtInt(w.projectTraceCount), 'Distinct project directories whose path shows they were a `.claude/worktrees/<name>` checkout - persists even after the worktree itself was cleaned up.'),
    kpiCard('`git worktree add` commands', fmtInt(w.gitWorktreeAddCommands), 'Raw git-CLI worktree creation, outside the EnterWorktree tool.'),
  ];
  return `<div class="kpi-grid">${cards.join('')}</div>
  <p class="muted">Worktree signals disagree by design: the EnterWorktree tool count is exact but only sees this tool's own mechanism, while the project-trace count survives even after a worktree is deleted but can't tell entries from creations on its own. Read them together, not as competing totals.</p>`;
}

// ---------------------------------------------------------------------------
// Code output, tools, projects
// ---------------------------------------------------------------------------

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
      <li><strong>Hour-of-day and daily &ldquo;Claude working&rdquo;/&ldquo;your prompts&rdquo; activity</strong> are computed independently, directly from transcript timestamps still on disk, not from the cache. An earlier version of this report used the cache's <code>hourCounts</code> field instead; an audit found it counts one entry per <em>session start</em>, not per unit of activity, so a session left running unattended for hours or days registered identically to a 30-second one. The chart below fixes that by counting every assistant turn and tool round-trip as activity, across the whole span of a session.</li>
      <li><strong>Token/model totals</strong> combine the cached totals with anything newer found live in transcripts still on disk (deduplicated by message id, so nothing is double-counted) - this is what lets a model adopted after the cache's last computation (e.g. a newly-released model) still show up in the cost breakdown.</li>
      <li><strong>Commits, pushes, worktrees and lines written/edited</strong> come from that same fresh read of every transcript file still on disk${merged ? ' on each merged machine' : ` under <code>${esc(rd.claudeDir)}</code>`} (${fmtInt(rd.scan.filesScanned)} files total this run). Local transcripts rotate after roughly 30 days, so these figures only cover recent activity even though the page is titled by the tool's full lifetime.</li>
    </ul>
    ${
      merged
        ? `<h3>How the merged sources were combined</h3>
    <p>This report was built with <code>--merge</code> from ${fmtInt(rd.sources.length)} separate <code>--visualise</code> JSON reports (see the source table above). Figures were combined per field, not simply concatenated:</p>
    <ul>
      <li><strong>Summed</strong> (each source's activity is genuinely independent, so nothing here can double-count): sessions, messages, tokens, commits, pushes, lines written/edited, subagent/workflow counts, transcript files scanned.</li>
      <li><strong>Recomputed from combined raw data</strong>, not averaged: daily activity is merged date-by-date before active-day coverage, streaks and gaps are recalculated; hour-of-day counts are summed per hour before percentages are recalculated. Averaging the already-derived percentages instead would have been wrong for anything path-dependent, like a streak that only exists because two machines' active days interleave.</li>
      <li><strong>Deduplicated</strong>: distinct project/worktree names are unioned rather than summed.</li>
      <li><strong>Approximate</strong>: the count of distinctly-named worktrees created via the EnterWorktree tool is summed across sources, which would overcount if the exact same worktree name was used on more than one machine.</li>
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
// TV presentation stylesheet
// ---------------------------------------------------------------------------
// Appended after STYLE, so every rule here is a deliberate override for this page alone: variables
// redeclared in a later, unconditional :root block win over both STYLE's light AND (should the
// viewing device prefer it) dark-mode :root blocks, which is what keeps this report light no matter
// what the TV/browser's own theme is set to - a real risk otherwise, since STYLE's dark-mode block is
// still present in the concatenated stylesheet.
//
// Relies on one mechanical fact about the existing charts: every chart's <svg> sets width="100%" and
// a fixed viewBox with no CSS height, so the whole chart - bars, gaps, and every piece of text inside
// it - already scales up uniformly as its container grows. Widening .wrap below is therefore most of
// the "make this legible from across a room" work; the rest is bumping the HTML (non-SVG) text that
// doesn't live inside an <svg> - headings, KPI numbers, table cells, legends, captions.
const TV_STYLE = `
  :root {
    color-scheme: light;
    --bg: #F2F6F4; --surface: #FFFFFF; --fg: #12191A; --muted: #45564F; --border: #D2DCD6;
    --accent: #146C4E; --accent-soft: #E1F1E8;
    --series-1: #146C4E; --series-2: #1D5C8F; --series-3: #B9821A; --series-4: #AC4630;
    --good: #1C7A46; --bad: #AE3A2C; --warn: #B07419; --neutral: #45564F;
    --good-bg: #E4F3E9; --bad-bg: #FAEAE7; --warn-bg: #FAF0DE; --info-bg: #E7F0F6; --neutral-bg: #EBF1EE;
    --grid: #E1E9E5;
    --font-sans: -apple-system, "Segoe UI", "Segoe UI Variable", Roboto, sans-serif;
    --font-mono: ui-monospace, "Cascadia Mono", "Consolas", "SFMono-Regular", Menlo, monospace;
  }

  body { font-family: var(--font-sans); line-height: 1.6; }
  .wrap { max-width: 1680px; font-size: 1.05rem; }

  h1 { font-family: var(--font-sans); font-size: 3.4rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 0.6rem; }
  h2 { font-family: var(--font-sans); font-size: 2rem; font-weight: 750; border-bottom: none; padding-bottom: 0; margin-top: 3.75rem; letter-spacing: -0.01em; }
  h3 { font-size: 1.35rem; margin-top: 2.25rem; }
  p { font-size: 1.1rem; }
  .lede { font-size: 1.25rem; max-width: 92ch; }
  .muted { font-size: 1.02rem; }
  code { font-size: 0.85em; }

  /* Signature: a shell-prompt eyebrow above every section heading. */
  .eyebrow { display: inline-flex; align-items: center; gap: 0.35em; font-family: var(--font-mono); font-size: 1.05rem;
    font-weight: 600; letter-spacing: 0.01em; color: var(--accent); background: var(--accent-soft);
    border: 1px solid var(--accent); border-radius: 999px; padding: 0.3rem 1.1rem 0.3rem 0.9rem; }
  .eyebrow::before { content: "$"; opacity: 0.6; font-weight: 700; margin-right: 0.1em; }

  /* KPI scoreboard */
  .kpi-grid { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem; }
  .kpi { border-radius: 14px; padding: 1.5rem 1.6rem; }
  .kpi-label { font-family: var(--font-mono); font-size: 0.95rem; letter-spacing: 0.05em; }
  .kpi-values { margin: 0.55rem 0 0.2rem; }
  .kpi-before { font-size: 1.1rem; }
  .kpi-after { font-family: var(--font-mono); font-size: 2.75rem; font-weight: 700; }
  .kpi-delta { font-size: 0.95rem; }
  .kpi-meaning { font-size: 1.02rem; margin-top: 0.6rem; }

  /* Meta strip */
  .meta-grid { grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0.9rem; }
  .meta-item { border-radius: 12px; padding: 0.85rem 1.1rem; }
  .meta-item .label { font-family: var(--font-mono); font-size: 0.88rem; }
  .meta-item .value { font-size: 1.3rem; }
  .meta-item.wide .value { font-size: 1.05rem; }

  /* Callouts / explainers */
  .callout { font-size: 1.08rem; padding: 1.2rem 1.4rem; border-radius: 12px; max-width: none; }
  .explainer { padding: 1.6rem 1.85rem; border-radius: 14px; }
  .explainer h3 { font-size: 1.2rem; }
  .explainer p, .explainer li { font-size: 1.05rem; max-width: none; }
  .reading { font-size: 1.05rem; max-width: none; }

  /* Tables */
  table { font-size: 1.05rem; }
  th, td { padding: 0.7rem 1rem; }
  th { font-family: var(--font-mono); font-size: 0.88rem; letter-spacing: 0.03em; text-transform: uppercase; }
  .meaning-cell { font-size: 0.95rem; max-width: 48ch; }

  /* Chart wrapper text that lives outside the <svg> - legends and captions don't scale with .wrap. */
  .legend { font-size: 1.08rem; gap: 1.5rem; }
  .swatch { width: 15px; height: 15px; border-radius: 4px; }
  figcaption { font-size: 1rem; max-width: none; }
  .grid { stroke-width: 1.4; }
  .axis { stroke-width: 1.6; }

  details > summary { font-size: 1.05rem; }
  footer { font-size: 0.95rem; }
  footer p { max-width: none; }

  @media (max-width: 900px) {
    .wrap { max-width: 100%; font-size: 1rem; }
    h1 { font-size: 2.3rem; }
    h2 { font-size: 1.5rem; }
    .kpi-after { font-size: 2.1rem; }
  }
`;

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
  ${section('How steady is your usage?', steadinessSection(rd), { eyebrow: 'activity --hour-of-day', lede: 'Claude Code is a CLI, not a server, so "uptime" here means presence: how many days you used it, and at what hours.' })}
  ${section('Tokens and estimated spend', tokenSection(rd), { eyebrow: 'tokens --spend', lede: 'All-time totals from Claude Code’s own usage cache, weighted the same way --baseline/--compare weight theirs.' })}
  ${section('Git activity', gitSection(rd), { eyebrow: 'git log --stat', lede: 'From Bash and EnterWorktree tool calls in transcripts still on disk - subject to the ~30-day retention window described below.' })}
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
