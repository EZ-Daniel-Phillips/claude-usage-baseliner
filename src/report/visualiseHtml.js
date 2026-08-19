// Renders the self-contained --visualise dashboard: "what did you actually do with Claude over the
// period this machine has data for". Same offline-safe, no-<script>, inline-SVG constraints as
// html.js (see that file's header) - this is a second, unrelated report page reusing its STYLE
// constant and the shared chart primitives, not a variant of the baseline/compare report itself.

import { STYLE } from './html.js';
import { horizontalBars, stackedShareBar, timeSeriesBars, hourOfDayChart, fmtCompact } from './charts.js';

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

function section(title, bodyHtml, { lede } = {}) {
  return `<section>
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
    kpiCard('Pull requests raised', rd.github.prs ? fmtInt(rd.github.prs.total) : fmtInt(rd.github.prCreateCommands), rd.github.prs ? 'Distinct PR URLs Claude Code has status-checked for you.' : '`gh pr create` invocations seen in transcripts still on disk.'),
    kpiCard('Reviews submitted', fmtInt(rd.github.prReviewCommands), '`gh pr review` invocations - PRs you (via Claude) reviewed, not ones you raised.'),
  ];
  return `<div class="kpi-grid">${cards.join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Steadiness of usage ("uptime")
// ---------------------------------------------------------------------------

function steadinessSection(rd) {
  const cov = rd.coverage;
  const hod = rd.hourOfDay;
  if (!cov || !hod) {
    return '<p class="callout callout-warn"><strong>No usage-cache data available.</strong> This machine has no <code>stats-cache.json</code> under the scanned directory, so activity history and hour-of-day patterns cannot be shown. Everything else on this page still comes from transcripts.</p>';
  }

  const dailyRows = rd.dailyActivity.map((d) => ({
    label: d.date,
    value: d.messageCount,
    valueText: `${fmtInt(d.messageCount)} messages, ${fmtInt(d.sessionCount)} session(s)`,
  }));

  // Plain em dashes here, not &mdash; - this string is passed through kpiCard(), which escapes its
  // meaning text (correctly, since most callers pass plain text), so an HTML entity here would come
  // out double-encoded as the literal text "&mdash;" instead of a dash.
  const spreadVerdict =
    hod.hourSpreadPct >= 90
      ? `Activity has been logged in ${hod.hoursWithActivity} of the 24 hours of the day at some point — usage is spread around the clock rather than confined to a shift.`
      : hod.hourSpreadPct >= 60
        ? `Activity has been logged in ${hod.hoursWithActivity} of 24 hours — a wide spread, but with a clear quiet stretch.`
        : `Activity is concentrated in just ${hod.hoursWithActivity} of the 24 hours — this looks like a working-hours pattern, not round-the-clock use.`;

  return `<p class="callout callout-info"><strong>What &ldquo;uptime&rdquo; means here.</strong> Claude Code is an interactive CLI, not a server, so there is no process to ask &ldquo;was it running 24/7&rdquo;. The closest honest signal transcripts and the usage cache can give is <em>presence</em>: on how many days did you actually use it, and at what hours. That is what this section shows.</p>
  <div class="kpi-grid">
    ${kpiCard('Active-day coverage', cov.coveragePct === null ? 'n/a' : `${fmtNum(cov.coveragePct, 1)}%`, `${fmtInt(cov.activeDays)} active day(s) out of ${fmtInt(cov.totalCalendarDays)} calendar days between ${cov.firstActiveDate} and ${cov.lastActiveDate}.`)}
    ${kpiCard('Longest streak', `${fmtInt(cov.longestStreakDays)} day(s)`, 'The longest unbroken run of consecutive active days.')}
    ${kpiCard('Longest quiet gap', `${fmtInt(cov.longestGapDays)} day(s)`, 'The longest run of consecutive days with no recorded activity at all.')}
    ${kpiCard('Hour-of-day spread', `${fmtInt(hod.hoursWithActivity)} / 24 hours`, spreadVerdict)}
  </div>
  <h3>Messages per active day, over the full history</h3>
  ${timeSeriesBars(dailyRows, { valueLabel: 'messages per day' })}
  <p class="muted">One bar per day that had any recorded activity (${dailyRows.length} days). Gaps in the axis are days with zero activity, not zero-height bars.</p>
  <h3>What hour of day work happens</h3>
  ${hourOfDayChart(hod.hours)}
  <p class="muted">${fmtNum(hod.businessHoursSharePct, 1)}% of all recorded activity fell inside a conventional 08:00&ndash;18:00 workday.</p>`;
}

// ---------------------------------------------------------------------------
// Tokens & cost
// ---------------------------------------------------------------------------

function tokenSection(rd) {
  const t = rd.tokens;
  if (!t.totals) return '<p class="callout callout-warn">No token-usage cache available on this machine.</p>';
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

  return `${bar}
  <h3>Estimated spend by model</h3>
  ${modelChart}
  <table>
    <thead><tr><th>Model</th><th class="num">Total tokens</th><th class="num">Estimated cost</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="muted">no per-model data</td></tr>'}</tbody>
  </table>
  <p class="muted">Priced with the same list-rate table <code>--baseline</code>/<code>--compare</code> use (version ${esc(t.costModelNotes.priceTableVersion)}), applied here to Claude Code's own all-time token cache rather than to a scanned transcript window. No per-model TTL cache-write split is recorded in that cache, so cache writes are costed at the flat ${t.costModelNotes.cacheWriteFallbackMultiplier}&times; rate throughout (see <code>--help</code> report for the exact/flat distinction).</p>`;
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

function prSection(rd) {
  const gh = rd.github;
  const prs = gh.prs;
  const cmdCards = [
    kpiCard('`gh pr create`', fmtInt(gh.prCreateCommands), 'PRs raised via the gh CLI.'),
    kpiCard('`gh pr review`', fmtInt(gh.prReviewCommands), 'Reviews submitted on others’ PRs via the gh CLI.'),
    kpiCard('`gh pr merge`', fmtInt(gh.prMergeCommands), 'Merges performed via the gh CLI.'),
    kpiCard('`gh pr comment`', fmtInt(gh.prCommentCommands), 'PR comments posted via the gh CLI.'),
  ];

  if (!prs) {
    return `<div class="kpi-grid">${cmdCards.join('')}</div>
    <p class="callout callout-warn">No <code>gh-pr-status-cache.json</code> found, so PR state, review outcome and lines-changed detail below are unavailable on this machine. The gh-CLI command counts above still come from transcripts.</p>`;
  }

  const stateRows = Object.entries(prs.byState)
    .map(([state, count]) => `<tr><td>${esc(state)}</td><td class="num">${fmtInt(count)}</td></tr>`)
    .join('');
  const reviewRows = Object.entries(prs.byReview)
    .map(([review, count]) => `<tr><td>${esc(review === 'none' ? 'No review recorded' : review)}</td><td class="num">${fmtInt(count)}</td></tr>`)
    .join('');
  const topRows = prs.top
    .map(
      (pr) => `<tr>
      <td>${pr.number ? `#${esc(pr.number)} ` : ''}${esc(pr.title ?? pr.url)}</td>
      <td>${esc(pr.state)}</td>
      <td>${pr.review ? esc(pr.review) : '&mdash;'}</td>
      <td class="num">+${fmtInt(pr.additions)}</td>
      <td class="num">-${fmtInt(pr.deletions)}</td>
    </tr>`
    )
    .join('');

  return `<div class="kpi-grid">${cmdCards.join('')}</div>
  <div class="kpi-grid">
    ${kpiCard('PRs tracked', fmtInt(prs.total), 'Distinct PR URLs in the gh PR status cache - this is a personal status-poll cache, so it reflects PRs you have checked on, which in practice means ones you raised.')}
    ${kpiCard('Lines changed across those PRs', `+${fmtInt(prs.additions)} / -${fmtInt(prs.deletions)}`, 'Additions and deletions as reported by GitHub for each tracked PR.')}
    ${kpiCard('Received a review', fmtInt(prs.reviewedCount), 'Of the tracked PRs, how many have any review recorded against them.')}
  </div>
  <h3>By state</h3>
  <table><thead><tr><th>State</th><th class="num">Count</th></tr></thead><tbody>${stateRows}</tbody></table>
  <h3>By review outcome</h3>
  <table><thead><tr><th>Review</th><th class="num">Count</th></tr></thead><tbody>${reviewRows}</tbody></table>
  <h3>Largest tracked PRs</h3>
  <table><thead><tr><th>PR</th><th>State</th><th>Review</th><th class="num">Additions</th><th class="num">Deletions</th></tr></thead><tbody>${topRows || '<tr><td colspan="5" class="muted">none tracked</td></tr>'}</tbody></table>`;
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
  <p class="callout callout-warn"><strong>This is an estimate, not a diff.</strong> It counts lines passed to the Write/Edit tools in transcripts still on disk - it cannot see whether an edit was reverted, whether the same lines were rewritten several times in one session, or code changed by any other means. Treat it as a sense of volume, not an audit trail. The <a href="#pr-detail">pull request</a> additions/deletions above are the more trustworthy figure where a PR exists, since GitHub computed those from the actual diff.</p>`;
}

function toolsSection(rd) {
  const chart = rd.tools.topTools.length
    ? horizontalBars(rd.tools.topTools.map((t) => ({ label: t.tool, value: t.calls, valueText: fmtInt(t.calls), colorVar: 'series-1' })))
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
  return `<div class="explainer">
    <h3>Where this data comes from</h3>
    <ul>
      <li><strong>All-time figures</strong> (sessions, messages, hour-of-day, daily activity, token totals) come from Claude Code's own <code>stats-cache.json</code>, last computed <strong>${esc(rd.period.lastComputedDate ?? 'unknown')}</strong>. It persists across transcript rotation, so it is the only source here with a history longer than about 30 days.</li>
      <li><strong>Pull request figures</strong> come from <code>gh-pr-status-cache.json</code>, a status-poll cache keyed by PR URL. It only contains PRs that cache has ever checked the status of, so it is a floor, not a guaranteed complete count.</li>
      <li><strong>Commits, pushes, worktrees, gh-CLI commands and lines written/edited</strong> come from a fresh read of every transcript file still on disk under <code>${esc(rd.claudeDir)}</code> (${fmtInt(rd.scan.filesScanned)} files this run). Local transcripts rotate after roughly 30 days, so these figures only cover recent activity even though the page is titled by the tool's full lifetime.</li>
    </ul>
    <h3>What this page does not touch</h3>
    <p>This mode reads <code>stats-cache.json</code>, <code>gh-pr-status-cache.json</code> and the transcript corpus, and writes only its own JSON/HTML pair under <code>claude-usage-baseliner/visualise/</code>. It never reads or writes <code>state.json</code>, so it cannot move, consume or otherwise affect your <code>--baseline</code> reference point or any <code>--compare</code> window.</p>
    <h3>Dollar figures are estimates, not a bill</h3>
    <p>As with <code>--baseline</code>/<code>--compare</code>, cost figures here are computed at published Claude API list rates and are not billing data - useful for a consistent sense of scale, not as an amount anyone invoiced you.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderVisualiseHtml(rd) {
  // Every value here is either already a safe fmt*/esc() result or genuine inline HTML (fmtWhen's
  // <span title>), so this renders each value as-is rather than escaping it a second time.
  const metaItems = [
    ['Generated', fmtWhen(rd.generatedAt)],
    ['Usage cache since', rd.period.firstSessionDate ? fmtWhen(rd.period.firstSessionDate) : 'n/a'],
    ['Usage cache last computed', esc(rd.period.lastComputedDate ?? 'n/a')],
    ['Transcripts scanned', fmtInt(rd.scan.filesScanned)],
    ['Scanned directory', esc(rd.claudeDir)],
  ];

  const body = `<div class="wrap">
  <h1>What you did with Claude</h1>
  <p class="lede">Everything this machine's Claude Code usage cache and local transcripts can tell you about how you have actually used it - independent of, and without affecting, your <code>--baseline</code>/<code>--compare</code> data.</p>
  <div class="meta-grid">
    ${metaItems.map(([label, value]) => `<div class="meta-item"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>`).join('')}
  </div>

  ${section('At a glance', headlineKpis(rd))}
  ${section('How steady is your usage?', steadinessSection(rd), { lede: 'Claude Code is a CLI, not a server, so "uptime" here means presence: how many days you used it, and at what hours.' })}
  ${section('Tokens and estimated spend', tokenSection(rd), { lede: 'All-time totals from Claude Code’s own usage cache, weighted the same way --baseline/--compare weight theirs.' })}
  ${section('Git activity', gitSection(rd), { lede: 'From Bash and EnterWorktree tool calls in transcripts still on disk - subject to the ~30-day retention window described below.' })}
  <section id="pr-detail">
    <h2>Pull requests</h2>
    <p class="lede">Raised, reviewed and merged, from the gh-CLI commands Claude Code has run plus GitHub's own PR status cache.</p>
    ${prSection(rd)}
  </section>
  ${section('Code written', codeSection(rd))}
  ${section('Tools, subagents and skills', toolsSection(rd))}
  ${section('How to read this page', methodSection(rd))}

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
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}
