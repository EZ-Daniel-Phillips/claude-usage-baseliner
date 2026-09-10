// Renders a single self-contained HTML report (no CDN deps, no external fonts, no <script> tags -
// collapsible sections use native <details>/<summary>, charts are server-rendered inline SVG - so the
// file is safe to double-click open offline on any machine). Used for both --baseline and --compare.
//
// Reading order is deliberate and top-down: the verdict first, then what changed and what that means,
// then where the change came from, then the evidence, then the raw tables. A reader who stops after
// the first screen should still have the correct answer.
//
// STYLE + TV_STYLE together are this tool's one visual language, shared by every report it generates
// (--baseline, --compare, --visualise, --merge) - see TV_STYLE's own header comment further down for
// why it is light/high-contrast and legible from across a room regardless of viewing device.

import { distributionChart, beforeAfterBars, stackedShareBar, horizontalBars, waterfallChart, fmtCompact } from './charts.js';

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

// A share that rounds to 0% but isn't actually zero reads as "none at all", which is wrong. Show it
// as a below-threshold value instead.
function fmtShare(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  if (n === 0) return '0%';
  const floor = 1 / 10 ** digits;
  if (n < floor) return `&lt;${floor}%`;
  return `${fmtNum(n, digits)}%`;
}

function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function usd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

// ISO timestamps are precise but unreadable at a glance; show a human date and keep the exact
// value available on hover.
function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const date = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `<span title="${esc(iso)}">${esc(date)}, ${esc(time)}</span>`;
}

// Fixed 2-dp so a column of rates lines up; fmtNum would render 0 as "0" beside "2.98%".
function fmtRate(fraction) {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return 'n/a';
  return `${(fraction * 100).toFixed(2)}%`;
}

function badge(text, kind = 'default') {
  return `<span class="badge badge-${kind}">${esc(text)}</span>`;
}

function lowConfBadge(isLow) {
  return isLow ? badge('low confidence (fewer than 20 samples)', 'warn') : '';
}

// `eyebrow` renders as a shell-prompt-styled tag above the heading (e.g. "verdict --answer") - the
// same signature device visualiseHtml.js uses, so a baseline/compare report and a --visualise report
// read as one consistent product rather than two different tools.
function section(title, bodyHtml, { id, lede, eyebrow } = {}) {
  return `<section${id ? ` id="${esc(id)}"` : ''}>
  ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
  <h2>${esc(title)}</h2>
  ${lede ? `<p class="lede">${lede}</p>` : ''}
  ${bodyHtml}
</section>`;
}

// Status is never carried by colour alone - every status pairs a glyph and a word with the hue.
const STATUS_GLYPH = { good: '&#9660;', bad: '&#9650;', warn: '&#9679;', neutral: '&#9679;' };
const STATUS_WORD = { good: 'Improved', bad: 'Worse', warn: 'Watch', neutral: 'Flat' };

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function verdictSection(reportData) {
  const cmp = reportData.comparison;
  const ins = cmp.insights;
  const d = ins.deltas.costDelta;
  const sig = ins.significance;

  const rawDirection = d === null ? 'neutral' : Math.abs(d) < 2 ? 'neutral' : d < 0 ? 'good' : 'bad';
  const heroText = d === null ? 'n/a' : `${d > 0 ? '+' : ''}${d.toFixed(1)}%`;
  const heroCaption =
    d === null
      ? 'Not enough data to judge.'
      : d < -2
        ? 'cheaper per request than your baseline'
        : d > 2
          ? 'more expensive per request than your baseline'
          : 'essentially unchanged versus your baseline';

  const qw = ins.qualityWarning;
  const overlap = ins.overlap;
  const notComparable = overlap && !overlap.comparable;

  // A cost saving bought with a higher failure rate, or measured on different work, is not a clean
  // success - the headline must say so rather than leaving the caveat to a section further down.
  const answer =
    d === null
      ? 'There is not enough new activity yet to answer this.'
      : d < -2
        ? qw
          ? `<strong>Cheaper, but not clearly better.</strong> The same unit of work costs measurably less &mdash; and tool calls now fail more often, so some of that saving may have been bought with mistakes and retries.`
          : notComparable
            ? `<strong>Cheaper, but on different work.</strong> Cost per request fell, but this window ran largely different jobs from your baseline, so this is not yet a controlled before/after.`
            : `<strong>Yes.</strong> Since your baseline, the same unit of work costs measurably less.`
        : d > 2
          ? `<strong>No.</strong> Since your baseline, the same unit of work costs measurably more.`
          : `<strong>No measurable change.</strong> Cost per request is within a couple of percent of your baseline.`;

  const direction = rawDirection === 'good' && (ins.qualityWarning || (ins.overlap && !ins.overlap.comparable)) ? 'warn' : rawDirection;

  return `<div class="verdict verdict-${direction}">
    <div class="verdict-hero">
      <div class="hero-number">${esc(heroText)}</div>
      <div class="hero-caption">${esc(heroCaption)}</div>
    </div>
    <div class="verdict-body">
      <p class="verdict-answer">${answer}</p>
      <p>Cost per request went from <strong>${esc(usd(cmp.baselineProfile.costPerRequest))}</strong> at baseline to
         <strong>${esc(usd(cmp.compareProfile.costPerRequest))}</strong> across
         ${esc(fmtInt(cmp.compareProfile.requests))} new requests.</p>
      ${qw ? `<p class="quality-warn"><strong>Quality warning.</strong> ${esc(qw.text)} Cost is an input measure &mdash; it cannot tell you whether the work was any good, so do not read the number on the left as &ldquo;better&rdquo;.</p>` : ''}
      ${
        sig
          ? `<p class="sig sig-${sig.status}"><strong>${esc(sig.short)}.</strong> ${esc(sig.text)}</p>`
          : ''
      }
    </div>
  </div>`;
}

function findingsSection(findings) {
  if (!findings.length) return '<p class="muted">No individual metric moved enough to call out.</p>';
  return `<ul class="findings">
    ${findings
      .map(
        (f) => `<li class="finding finding-${f.status}">
      <div class="finding-head"><span class="finding-glyph">${STATUS_GLYPH[f.status]}</span><span class="finding-tag">${esc(STATUS_WORD[f.status])}</span><span class="finding-title">${esc(f.title)}</span></div>
      <p class="finding-meaning">${esc(f.meaning)}</p>
    </li>`
      )
      .join('')}
  </ul>`;
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

function kpiSection(kpis) {
  const cards = kpis
    .map(
      (k) => `<div class="kpi kpi-${k.status}">
      <div class="kpi-label">${esc(k.label)}</div>
      <div class="kpi-values">
        <span class="kpi-before">${esc(k.baselineText)}</span>
        <span class="kpi-arrow">&rarr;</span>
        <span class="kpi-after">${esc(k.compareText)}</span>
      </div>
      <div class="kpi-delta kpi-delta-${k.status}">${STATUS_GLYPH[k.status]} ${esc(fmtPct(k.pctChange))} <span class="kpi-word">${esc(STATUS_WORD[k.status])}</span></div>
      <p class="kpi-meaning">${esc(k.meaning)}</p>
    </div>`
    )
    .join('');

  const chart = beforeAfterBars(
    kpis.map((k) => ({
      label: k.label,
      baseline: k.baseline,
      compare: k.compare,
      baselineText: k.baselineText,
      compareText: k.compareText,
      lowerIsBetter: k.lowerIsBetter,
    }))
  );

  return `${chart}<div class="kpi-grid">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Decomposition
// ---------------------------------------------------------------------------

function decompositionSection(decomp) {
  if (!decomp) return '';
  const chart = waterfallChart(
    decomp.start,
    decomp.steps.map((s) => ({ label: s.label, value: s.value })),
    decomp.end
  );
  const rows = decomp.steps
    .map((s) => {
      const good = s.value < 0;
      const status = Math.abs(s.value) < Math.abs(decomp.actualDelta) * 0.02 ? 'neutral' : good ? 'good' : 'bad';
      const share = decomp.actualDelta ? (s.value / decomp.actualDelta) * 100 : null;
      const netIsSaving = decomp.actualDelta < 0;
      const helped = share !== null && share > 0; // same direction as the net change
      const shareText =
        share === null || decomp.actualDelta === 0
          ? 'n/a'
          : helped
            ? `${Math.abs(share).toFixed(0)}% of the ${netIsSaving ? 'saving' : 'increase'}`
            : `gave back ${Math.abs(share).toFixed(0)}%`;
      return `<tr>
        <td><strong>${esc(s.label)}</strong></td>
        <td class="num delta-${status}">${s.value > 0 ? '+' : ''}${esc(usd(s.value))}</td>
        <td class="num">${esc(shareText)}</td>
        <td class="meaning-cell">${esc(s.meaning)}</td>
      </tr>`;
    })
    .join('');

  return `${chart}
  <table class="decomp">
    <thead><tr><th>Driver</th><th class="num">Effect on cost per request</th><th class="num">Contribution</th><th>What it means</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th>Net change</th><th class="num">${decomp.actualDelta > 0 ? '+' : ''}${esc(usd(decomp.actualDelta))}</th><th class="num">${decomp.actualDelta < 0 ? 'total saving' : 'total increase'}</th><th></th></tr></tfoot>
  </table>
  <p class="muted">These four drivers add up exactly to the observed change. "Model mix" is computed as the part the other three cannot explain, so a saving that really came from switching to a cheaper model can never be misreported as a setup improvement.</p>`;
}

// ---------------------------------------------------------------------------
// Like-for-like by model
// ---------------------------------------------------------------------------

function modelComparisonSection(cmp) {
  const base = new Map(cmp.baselineProfile.perModel.map((m) => [m.model, m]));
  const comp = new Map(cmp.compareProfile.perModel.map((m) => [m.model, m]));
  const keys = [...new Set([...base.keys(), ...comp.keys()])];

  const rows = keys
    .map((k) => {
      const b = base.get(k);
      const c = comp.get(k);
      const pct = b && c && b.costPerRequest ? ((c.costPerRequest - b.costPerRequest) / b.costPerRequest) * 100 : null;
      const status = pct === null ? 'neutral' : Math.abs(pct) < 2 ? 'neutral' : pct < 0 ? 'good' : 'bad';
      return {
        k,
        b,
        c,
        pct,
        html: `<tr>
        <td>${esc(k)}</td>
        <td class="num">${b ? fmtInt(b.requests) : '&mdash;'}</td>
        <td class="num">${c ? fmtInt(c.requests) : '&mdash;'}</td>
        <td class="num">${b ? esc(usd(b.costPerRequest)) : '&mdash;'}</td>
        <td class="num">${c ? esc(usd(c.costPerRequest)) : '&mdash;'}</td>
        <td class="num delta-${status}">${pct === null ? '&mdash;' : `${STATUS_GLYPH[status]} ${esc(fmtPct(pct))}`}</td>
      </tr>`,
      };
    })
    .sort((a, b) => (b.c?.cost ?? 0) - (a.c?.cost ?? 0));

  const mix = cmp.insights.mix;
  const mixWarning =
    mix && mix.tvdPoints >= 15
      ? `<p class="callout callout-warn"><strong>Workload mix moved a lot.</strong> ${mix.tvdPoints.toFixed(0)}% of your requests shifted between models compared with baseline
         (${mix.rows
           .slice(0, 3)
           .map((r) => `${esc(r.model)} ${r.deltaPoints > 0 ? '+' : ''}${r.deltaPoints.toFixed(0)}pp`)
           .join(', ')}).
         The two windows are not perfectly like-for-like, so read the per-model rows below rather than the headline alone &mdash; they compare each model only against itself.</p>`
      : `<p class="callout callout-ok"><strong>Workload mix is broadly comparable.</strong> Only ${mix ? mix.tvdPoints.toFixed(0) : '0'}% of requests shifted between models, so the headline number is a fair like-for-like read.</p>`;

  return `${mixWarning}
  <table>
    <thead><tr><th>Model</th><th class="num">Baseline requests</th><th class="num">New requests</th><th class="num">Baseline $/request</th><th class="num">New $/request</th><th class="num">Change</th></tr></thead>
    <tbody>${rows.map((r) => r.html).join('')}</tbody>
  </table>
  <p class="muted">Each row compares a model only against itself, so nothing here can be explained away by having run more work on a cheaper model.</p>`;
}

// ---------------------------------------------------------------------------
// Quality: did it actually get better, or just cheaper?
// ---------------------------------------------------------------------------

function qualitySection(cmp) {
  const ins = cmp.insights;
  const f = ins.failure;
  const o = f.overall;
  const pTxt = (p) => (p < 0.001 ? '&lt;0.001' : p.toFixed(3));

  const headline = o.skipped
    ? `<p class="callout callout-warn"><strong>Not enough tool calls to judge.</strong> ${esc(o.reason)}. Keep working and re-run &mdash; this is the one quality signal available, so it is worth waiting for.</p>`
    : o.significant
      ? o.direction === 'up'
        ? `<p class="callout callout-warn"><strong>Failure rate rose, and the rise is real.</strong> ${fmtNum(o.rate1 * 100, 2)}% of tool calls errored at baseline versus ${fmtNum(o.rate2 * 100, 2)}% now (p=${pTxt(o.pValue)}). Retries cost tokens as well as quality, so this can erode the saving it appears to sit alongside.</p>`
        : `<p class="callout callout-ok"><strong>Failure rate fell, and the fall is real.</strong> ${fmtNum(o.rate1 * 100, 2)}% of tool calls errored at baseline versus ${fmtNum(o.rate2 * 100, 2)}% now (p=${pTxt(o.pValue)}). Fewer retries is both a quality and a cost win.</p>`
      : `<p class="callout callout-ok"><strong>No detectable change in failure rate.</strong> ${fmtNum(o.rate1 * 100, 2)}% versus ${fmtNum(o.rate2 * 100, 2)}% is within normal variation (p=${pTxt(o.pValue)}), so the saving does not appear to have cost you reliability.</p>`;

  const rows = f.perTool
    .map((t) => {
      const status = t.skipped || !t.significant ? 'neutral' : t.direction === 'up' ? 'bad' : 'good';
      const verdict = t.skipped
        ? '<span class="muted">too few calls</span>'
        : t.significant
          ? `${STATUS_GLYPH[status]} ${t.direction === 'up' ? 'worse' : 'better'} (p=${pTxt(t.pValue)})`
          : '<span class="muted">no real change</span>';
      return `<tr>
        <td>${esc(t.tool)}</td>
        <td class="num">${fmtRate(t.rate1)}</td>
        <td class="num">${fmtRate(t.rate2)}</td>
        <td class="num">${fmtInt(t.compErrors)} / ${fmtInt(t.compCalls)}</td>
        <td class="num delta-${status}">${verdict}</td>
      </tr>`;
    })
    .join('');

  return `${headline}
  <table>
    <thead><tr><th>Tool</th><th class="num">Baseline error rate</th><th class="num">New error rate</th><th class="num">Errors / calls now</th><th class="num">Verdict</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">no tool data on both sides</td></tr>'}</tbody>
  </table>
  <div class="explainer">
    <h3>Why this is the only quality number here</h3>
    <p>Everything else on this page measures <strong>what you spent</strong>. Nothing in a Claude Code transcript records whether the answer was <em>right</em> &mdash; whether a spec passed review, whether the code worked, whether anyone had to redo it. Tool failure rate is the closest available proxy, and it only catches a narrow class of problem: calls that came back an error.</p>
    <p>To actually answer &ldquo;did it get better?&rdquo; you need an outcome signal this tool cannot see &mdash; review rejections, rework counts, test or CI pass rates, regenerations per artifact. Once you have one, the number worth tracking is <strong>cost per accepted piece of work</strong>, not cost per request: a run that is 20% cheaper but needs one artifact in six redone has not improved.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Per-job like-for-like
// ---------------------------------------------------------------------------

function agentTypeSection(cmp) {
  const ins = cmp.insights;
  const o = ins.overlap;
  const rows = ins.agentTypes ?? [];

  const overlapNote = !o
    ? ''
    : o.comparable
      ? `<p class="callout callout-ok"><strong>The two windows ran comparable work.</strong> ${fmtNum(o.overlapPct, 0)}% of new requests use an agent type that also appears at baseline (${fmtInt(o.sharedTypes)} of ${fmtInt(o.compTypes)} types), so the headline is a reasonable before/after.</p>`
      : `<p class="callout callout-warn"><strong>These two windows are largely different work.</strong> Your baseline ran ${fmtInt(o.baseTypes)} agent types and this window ran ${fmtInt(o.compTypes)}, sharing only ${fmtInt(o.sharedTypes)}. Just ${fmtNum(o.overlapPct, 0)}% of new requests run a job that also existed at baseline. The overall cost figure is therefore not a controlled before/after &mdash; the table below is, because each row compares one job against itself.</p>`;

  const body = rows.length
    ? `<table>
      <thead><tr><th>Job (agent type)</th><th class="num">Baseline requests</th><th class="num">New requests</th><th class="num">Baseline tokens/request</th><th class="num">New tokens/request</th><th class="num">Change</th></tr></thead>
      <tbody>${rows
        .map((r) => {
          const status = r.pctChange === null ? 'neutral' : Math.abs(r.pctChange) < 2 ? 'neutral' : r.pctChange < 0 ? 'good' : 'bad';
          const thin = r.compRequests < 50;
          return `<tr>
          <td>${esc(r.agentType)}${thin ? ' ' + badge('small sample', 'warn') : ''}</td>
          <td class="num">${fmtInt(r.baseRequests)}</td>
          <td class="num">${fmtInt(r.compRequests)}</td>
          <td class="num">${fmtInt(r.baseTokensPerRequest)}</td>
          <td class="num">${fmtInt(r.compTokensPerRequest)}</td>
          <td class="num delta-${status}">${STATUS_GLYPH[status]} ${esc(fmtPct(r.pctChange))}</td>
        </tr>`;
        })
        .join('')}</tbody>
    </table>
    <p class="muted">Shown in tokens rather than dollars: the stored breakdown records no model attribution per agent type, so a per-job dollar figure would need a model mix this data cannot supply. Only jobs with at least 20 requests in the new window are listed.</p>`
    : `<p class="callout callout-warn"><strong>No job ran enough in both windows to compare.</strong> Nothing here appears at baseline and again since, with enough volume to be meaningful. To measure a specific campaign, re-run it and compare it against its own baseline figures.</p>`;

  return `${overlapNote}${body}`;
}

// ---------------------------------------------------------------------------
// Distribution + the percentile explainer
// ---------------------------------------------------------------------------

const PERCENTILE_EXPLAINER = `<div class="explainer">
  <h3>What P50 and P95 actually mean</h3>
  <p>Line every request up from smallest to largest. A <strong>percentile</strong> is just "where in that line do I stand".</p>
  <ul>
    <li><strong>P50 &mdash; the middle request.</strong> Half your requests are smaller, half are bigger. This is your <em>typical</em> request. It is the same thing as the median. Watch this to answer &ldquo;did normal work get cheaper?&rdquo;</li>
    <li><strong>P75 / P85 &mdash; the heavier end of normal.</strong> Three quarters, then roughly six in seven, of requests are smaller than this.</li>
    <li><strong>P95 &mdash; your worst 1-in-20.</strong> Only one request in twenty is bigger. These are the runaway calls near the top of a long session. Watch this to answer &ldquo;did I stop the blowouts?&rdquo;</li>
  </ul>
  <p>Averages are misleading here because a handful of enormous requests drag the average far above what you actually experience most of the time. P50 and P95 together tell you what the average cannot: whether the <em>typical</em> case improved, and whether the <em>worst</em> case did.</p>
</div>`;

function distributionSection(reportData) {
  const cmp = reportData.comparison;
  const compareDist = reportData.distributions.tokensPerRequest;

  const series = [];
  if (cmp) {
    const baseDist = cmp.distributions.tokensPerRequest.baseline;
    if (baseDist.sample?.length) series.push({ label: 'Baseline', values: baseDist.sample, colorVar: 'series-1', totalN: baseDist.n });
  }
  if (compareDist.sample?.length) {
    series.push({
      label: cmp ? 'After changes' : 'All requests',
      values: compareDist.sample,
      colorVar: cmp ? 'series-2' : 'series-1',
      totalN: compareDist.n,
    });
  }

  const chart = distributionChart(series);

  const reading = cmp
    ? (() => {
        const pd = cmp.distributions.tokensPerRequest.percentileDeltas;
        const p50 = pd.p50;
        const p95 = pd.p95;
        const typicalMoved = p50.pctChange !== null && p50.pctChange < -2;
        const tailMoved = p95.pctChange !== null && p95.pctChange < -2;
        let verdict;
        if (typicalMoved && tailMoved) {
          verdict = 'Both curves moved left: your typical request got smaller <em>and</em> your worst requests got smaller. That is the strongest possible shape for this chart &mdash; the whole distribution shifted, not just one end.';
        } else if (typicalMoved) {
          verdict = 'The typical request got smaller, but the worst 1-in-20 did not improve much. Everyday work is leaner; the long-session blowouts are still there.';
        } else if (tailMoved) {
          verdict = 'The worst requests got smaller but the typical one did not. You have capped the blowouts without making everyday work leaner.';
        } else {
          verdict = 'Neither the typical request nor the worst 1-in-20 moved meaningfully left. The distribution is broadly where it was.';
        }
        return `<p class="reading"><strong>How to read this chart:</strong> each curve shows what share of requests land at each size. A curve that sits further <em>left</em> means requests are smaller; a curve that is <em>taller and narrower</em> means they are more consistent. The vertical rules mark each period&rsquo;s typical (P50) request.</p>
        <p class="reading">${verdict}</p>`;
      })()
    : `<p class="reading"><strong>How to read this chart:</strong> the curve shows what share of your requests land at each size. The vertical rule marks the typical (P50) request. After you change your setup, run <code>--compare</code> and a second curve appears here &mdash; if it sits to the left of this one, you used fewer tokens for the same work.</p>`;

  const table = cmp ? percentileTable(cmp.distributions.tokensPerRequest) : baselinePercentileTable(compareDist);

  return `${chart}${reading}${table}${PERCENTILE_EXPLAINER}`;
}

function percentileTable(cd) {
  const labels = {
    p50: 'P50 &mdash; typical request',
    p75: 'P75 &mdash; heavier than normal',
    p85: 'P85 &mdash; heavy',
    p95: 'P95 &mdash; worst 1 in 20',
  };
  const rows = ['p50', 'p75', 'p85', 'p95']
    .map((k) => {
      const d = cd.percentileDeltas[k];
      const status = d.pctChange === null ? 'neutral' : Math.abs(d.pctChange) < 2 ? 'neutral' : d.pctChange < 0 ? 'good' : 'bad';
      return `<tr>
        <td>${labels[k]}</td>
        <td class="num">${fmtInt(d.baseline)}</td>
        <td class="num">${fmtInt(d.compare)}</td>
        <td class="num delta-${status}">${STATUS_GLYPH[status]} ${esc(fmtPct(d.pctChange))}</td>
        <td>${lowConfBadge(d.lowConfidence)}</td>
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr><th>Where in the line</th><th class="num">Baseline tokens</th><th class="num">New tokens</th><th class="num">Change</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function baselinePercentileTable(dist) {
  const labels = [
    ['P50 &mdash; typical request', dist.percentiles.p50],
    ['P75 &mdash; heavier than normal', dist.percentiles.p75],
    ['P85 &mdash; heavy', dist.percentiles.p85],
    ['P95 &mdash; worst 1 in 20', dist.percentiles.p95],
  ];
  return `<table>
    <thead><tr><th>Where in the line</th><th class="num">Tokens per request</th></tr></thead>
    <tbody>${labels.map(([l, v]) => `<tr><td>${l}</td><td class="num">${fmtInt(v)}</td></tr>`).join('')}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// Token economics explainer
// ---------------------------------------------------------------------------

function tokenClassExplainer(reportData) {
  const t = reportData.totals.tokens;
  const share = reportData.totals.tokenShare;
  const bar = stackedShareBar([
    { label: 'Cache read', value: t.cacheReadTokens, valueText: fmtInt(t.cacheReadTokens), colorVar: 'series-1' },
    { label: 'Cache write', value: t.cacheCreationTokens, valueText: fmtInt(t.cacheCreationTokens), colorVar: 'series-2' },
    { label: 'Output', value: t.outputTokens, valueText: fmtInt(t.outputTokens), colorVar: 'series-3' },
    { label: 'Input', value: t.inputTokens, valueText: fmtInt(t.inputTokens), colorVar: 'series-4' },
  ]);

  const costRows = [
    ['Cache read', t.cacheReadTokens, share.cacheRead, '0.1x', 'Context Claude has seen before, served from cache. The cheapest thing you buy - and almost always the biggest count.'],
    ['Cache write', t.cacheCreationTokens, share.cacheCreation, '1.25x', 'New material being written into the cache so later requests can read it cheaply.'],
    ['Input', t.inputTokens, share.input, '1x', 'Context paid for at full price because it was not cacheable.'],
    ['Output', t.outputTokens, share.output, '5x', 'What Claude writes back. The most expensive token class by a wide margin.'],
  ];

  return `${bar}
  <table>
    <thead><tr><th>Token class</th><th class="num">Count</th><th class="num">Share of tokens</th><th class="num">Relative price</th><th>What it is</th></tr></thead>
    <tbody>
      ${costRows
        .map(
          ([label, val, pct, mult, desc]) => `<tr>
        <td><strong>${esc(label)}</strong></td>
        <td class="num">${fmtInt(val)}</td>
        <td class="num">${fmtShare(pct)}</td>
        <td class="num">${esc(mult)}</td>
        <td class="meaning-cell">${esc(desc)}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>
  <p class="callout callout-info"><strong>This is why raw token counts mislead.</strong> Cache reads are ${fmtNum(share.cacheRead)}% of your token count but cost a tenth of an input token, while output is only ${fmtNum(share.output)}% of the count at five times the price of input. A &ldquo;total tokens&rdquo; figure is therefore roughly ${fmtNum(share.cacheRead, 0)}% driven by the cheapest thing you buy. Every headline number on this page is weighted by what each class actually costs.</p>`;
}

// ---------------------------------------------------------------------------
// Detail tables (kept, collapsed)
// ---------------------------------------------------------------------------

function tierBreakdownTable(byTier) {
  const rows = Object.entries(byTier);
  const totalTokens = rows.reduce((acc, [, v]) => acc + v.tokens.total, 0) || 1;
  const labels = {
    main: 'Main conversation (you talking to Claude directly)',
    subagent: 'Subagents (Task/Agent tool)',
    'workflow-agent': 'Workflow agents (orchestrated fan-out)',
  };
  return `<table>
    <thead><tr><th>Tier</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Share</th></tr></thead>
    <tbody>
      ${rows
        .map(
          ([tier, v]) => `<tr>
        <td>${esc(labels[tier] ?? tier)}</td>
        <td class="num">${fmtInt(v.requests)}</td>
        <td class="num">${fmtInt(v.tokens.total)}</td>
        <td class="num">${fmtNum((v.tokens.total / totalTokens) * 100)}%</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

function groupedTotalsTable(rows, keyLabel, limit = 20) {
  const shown = rows.slice(0, limit);
  return `<table>
    <thead><tr><th>${esc(keyLabel)}</th><th class="num">Requests</th><th class="num">Total tokens</th></tr></thead>
    <tbody>
      ${shown
        .map(
          (r) => `<tr>
        <td>${esc(r.key)}</td>
        <td class="num">${fmtInt(r.requests)}</td>
        <td class="num">${fmtInt(r.tokens.total)}</td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>${rows.length > limit ? `<p class="muted">Showing top ${limit} of ${rows.length}.</p>` : ''}`;
}

function distributionTable(dist) {
  const p = dist.percentiles;
  return `<h3>${esc(dist.metric)}</h3><table>
    <thead><tr><th class="num">n</th><th class="num">mean</th><th class="num">P50</th><th class="num">P75</th><th class="num">P85</th><th class="num">P95</th><th class="num">min</th><th class="num">max</th><th></th></tr></thead>
    <tbody>
      <tr>
        <td class="num">${fmtInt(dist.n)}</td>
        <td class="num">${fmtInt(dist.mean)}</td>
        <td class="num">${fmtInt(dist.median)}</td>
        <td class="num">${fmtInt(p.p75)}</td>
        <td class="num">${fmtInt(p.p85)}</td>
        <td class="num">${fmtInt(p.p95)}</td>
        <td class="num">${fmtInt(dist.min)}</td>
        <td class="num">${fmtInt(dist.max)}</td>
        <td>${lowConfBadge(dist.lowConfidencePercentiles)}${dist.sampled ? badge(`sampled from ${fmtInt(dist.n)}`, 'info') : ''}</td>
      </tr>
    </tbody>
  </table>`;
}

function compactionSection(compaction, requests) {
  const per1k = requests ? compaction.count / (requests / 1000) : null;
  return `<p class="lede">A compaction happens when a session fills its context window and has to be summarized down. It costs tokens and loses detail, so fewer is better.</p>
  <table>
    <tbody>
      <tr><th>Compactions</th><td class="num">${fmtInt(compaction.count)}</td></tr>
      <tr><th>Per 1,000 requests</th><td class="num">${per1k === null ? 'n/a' : fmtNum(per1k)}</td></tr>
      <tr><th>Manual / automatic</th><td class="num">${fmtInt(compaction.byTrigger.manual ?? 0)} / ${fmtInt(compaction.byTrigger.auto ?? 0)}</td></tr>
      <tr><th>Tokens dropped in total</th><td class="num">${fmtInt(compaction.totalDroppedTokens)}</td></tr>
      <tr><th>Average context before / after</th><td class="num">${fmtInt(compaction.avgPreTokens)} / ${fmtInt(compaction.avgPostTokens)}</td></tr>
    </tbody>
  </table>`;
}

function attachmentsSection(attachments) {
  const topSkillsRows = attachments.topSkills
    .map((s) => `<tr><td>${esc(s.key)}</td><td class="num">${fmtInt(s.count)}</td><td class="num">${fmtInt(s.totalBytes)}</td></tr>`)
    .join('');
  const topMemRows = attachments.topNestedMemory
    .map((s) => `<tr><td>${esc(s.key)}</td><td class="num">${fmtInt(s.count)}</td><td class="num">${fmtInt(s.totalBytes)}</td></tr>`)
    .join('');
  return `<p class="lede">Skills and <code>CLAUDE.md</code> files are injected into context when they load, and then re-read on every subsequent request in that session. Large entries here are among the easiest things to trim.</p>
  <h3>Skills by injected bytes</h3>
  <table><thead><tr><th>Skill</th><th class="num">Invocations</th><th class="num">Total bytes</th></tr></thead><tbody>${topSkillsRows || '<tr><td colspan="3" class="muted">none observed</td></tr>'}</tbody></table>
  <h3>CLAUDE.md injections by bytes</h3>
  <table><thead><tr><th>Path</th><th class="num">Injections</th><th class="num">Total bytes</th></tr></thead><tbody>${topMemRows || '<tr><td colspan="3" class="muted">none observed</td></tr>'}</tbody></table>`;
}

function toolPayloadSection(toolPayload, requests) {
  const chart = toolPayload.length
    ? horizontalBars(
        toolPayload.slice(0, 8).map((t) => ({
          label: t.tool,
          value: t.totalBytes,
          valueText: `${fmtCompact(t.totalBytes)} B`,
          colorVar: 'series-1',
        }))
      )
    : '';
  const rows = toolPayload
    .map(
      (t) => `<tr>
      <td>${esc(t.tool)}</td>
      <td class="num">${fmtInt(t.calls)}</td>
      <td class="num">${fmtInt(t.totalBytes)}</td>
      <td class="num">${fmtInt(t.meanBytes)}</td>
      <td class="num">${fmtInt(t.maxBytes)}</td>
      <td class="num">${fmtInt(t.errors)}</td>
    </tr>`
    )
    .join('');
  const totalBytes = toolPayload.reduce((a, t) => a + t.totalBytes, 0);
  return `<p class="lede">Everything a tool returns stays in context for the rest of the session, so it is paid for again on every later request. Across this window tool results contributed ${fmtInt(totalBytes)} bytes, about ${requests ? fmtInt(totalBytes / requests) : 'n/a'} bytes per request. Trimming large reads and noisy command output is one of the most direct levers you have.</p>
  ${chart}
  <table>
    <thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Total bytes</th><th class="num">Mean bytes</th><th class="num">Max bytes</th><th class="num">Errors</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">no tool-result data attributable</td></tr>'}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// Baseline-mode "where you stand"
// ---------------------------------------------------------------------------

function baselineStanding(reportData) {
  const merged = Array.isArray(reportData.sources) && reportData.sources.length > 0;
  const p = reportData.profile;
  const cards = [
    ['Estimated spend in this window', usd(reportData.cost.total), 'What the scanned activity would have cost at published API list rates.'],
    ['Cost per request', usd(p.costPerRequest), merged ? 'Combined across every merged source - see the sources table above.' : 'The number to beat. Re-run --compare after your changes and this is what moves.'],
    ['Context re-read per request', fmtInt(p.contextPerRequest), 'How much Claude re-reads before answering anything. The metric your setup most directly controls.'],
    ['Output per request', fmtInt(p.outputPerRequest), 'How much Claude writes back, in tokens.'],
    ['Cache hit rate', `${(p.cacheHitRate * 100).toFixed(1)}%`, 'Share of re-read context served from cache at a tenth of the price. Higher is better.'],
    ['Requests captured', fmtInt(reportData.totals.requests), merged ? `Across ${fmtInt(reportData.sources.length)} merged source report(s).` : `Across ${fmtInt(reportData.scan.filesScanned)} transcript files.`],
  ];
  return `<div class="kpi-grid">
    ${cards
      .map(
        ([label, value, meaning]) => `<div class="kpi kpi-neutral">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-values"><span class="kpi-after">${esc(value)}</span></div>
      <p class="kpi-meaning">${esc(meaning)}</p>
    </div>`
      )
      .join('')}
  </div>
  ${
    merged
      ? `<p class="callout callout-info"><strong>This is a combined snapshot, not a reference point.</strong> It was assembled with <code>--merge</code> from several separate reports and cannot be fed to <code>--compare</code> - it never touches any machine's <code>state.json</code>. See the sources table above and &ldquo;How to read this report&rdquo; below for exactly how the figures were combined.</p>`
      : `<p class="callout callout-info"><strong>This is your reference point.</strong> Nothing here is good or bad on its own &mdash; it is the line everything gets measured against. Make your setup changes now, keep working normally for a few days, then run <code>--compare</code>. That report will answer &ldquo;did it work?&rdquo; directly.</p>`
  }`;
}

// ---------------------------------------------------------------------------
// Merged-report sources panel
// ---------------------------------------------------------------------------
// Rendered right under the meta strip, mirroring visualiseHtml.js's own sourcesPanel - the one place
// a reader can see what actually went into a merged report and judge for themselves whether combining
// these particular windows was a like-for-like thing to do.
const SOURCE_ROLE_LABEL = { 'baseline-side': 'fed the "before" side', 'compare-side': 'fed the "after" side', snapshot: 'combined snapshot' };

function mergedSourcesPanel(reportData) {
  const sources = reportData.sources;
  if (!Array.isArray(sources) || !sources.length) return '';
  return `<div class="explainer">
    <h3>Sources merged into this report</h3>
    <table>
      <thead><tr><th>Report</th><th>Mode</th><th>Role in this merge</th><th>Claude directory</th><th>Generated</th><th class="num">Requests</th><th>Window covered</th></tr></thead>
      <tbody>${sources
        .map(
          (s) => `<tr>
        <td>${esc(s.id)}</td>
        <td>${esc(s.mode)}</td>
        <td>${esc(SOURCE_ROLE_LABEL[s.role] ?? s.role)}</td>
        <td>${esc(s.claudeDir)}</td>
        <td>${fmtWhen(s.generatedAt)}</td>
        <td class="num">${fmtInt(s.requests)}</td>
        <td>${esc(s.windowDescription)}</td>
      </tr>`
        )
        .join('')}</tbody>
    </table>
    <p class="muted">See &ldquo;How to read this report&rdquo; below for exactly how figures from each source were combined.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Method explainer
// ---------------------------------------------------------------------------

function methodExplainer(reportData) {
  const merged = Array.isArray(reportData.sources) && reportData.sources.length > 0;
  const mergedVerdict = merged && reportData.comparison !== null;
  const mergedSnapshot = merged && reportData.comparison === null;
  const m = reportData.cost.model;
  // 'flat' means at least one side lacked the cache-write TTL breakdown, so both were priced
  // with the conservative multiplier. Disclosed rather than silently applied.
  const ttlMode = reportData.comparison?.ttlMode ?? reportData.cost.ttlMode ?? 'flat';
  return `<div class="explainer">
    <h3>What period this covers</h3>
    ${
      mergedVerdict
        ? `<p class="callout callout-info"><strong>This report merges every --baseline source into one combined &ldquo;before&rdquo; and every --compare source into one combined &ldquo;after&rdquo;</strong>, then compares those two combined windows exactly the way a single-machine --compare compares its baseline against itself. See the sources table above for which report fed which side and what period each one covers.</p>`
        : mergedSnapshot
          ? `<p class="callout callout-info"><strong>This report combines several separate --baseline/--compare reports</strong>, assembled with <code>--merge</code> - it is not one continuous window. See the sources table above for exactly what period each one covers; mixing windows of very different lengths (or that do not overlap in time) is allowed, but makes the combined figures a sum of activity across those windows rather than a single like-for-like period.</p>`
          : reportData.window?.mode === 'since-last-scan'
            ? `<p class="callout callout-warn"><strong>This report covers only what was new since the previous scan.</strong> That window is now consumed &mdash; running <code>--compare --since-last</code> again will report only what arrives from here on, not this period again. For a stable, repeatable answer to &ldquo;how am I doing against my baseline?&rdquo;, run <code>--compare</code> without <code>--since-last</code>: it measures everything since the baseline every time, so the number only grows as you work.</p>`
            : `<p>This report covers <strong>everything recorded since your baseline was taken</strong>. Re-running <code>--compare</code> measures the same period again plus whatever is new, so the answer is stable and the request count only grows. Nothing is consumed by reading it.</p>`
    }
    ${
      merged
        ? `<h3>How the merged sources were combined</h3>
    <p>Figures were combined per field, not simply concatenated:</p>
    <ul>
      <li><strong>Summed exactly</strong> (each source's activity is genuinely independent, so nothing here can double-count): requests, all token counts and cost, per-model/per-agent-type/per-tier totals, tool-payload bytes, compaction counts, transcript files scanned.</li>
      <li><strong>Recomputed from the merged totals</strong>, not averaged: estimated cost and the per-request profile are re-derived from the summed byModel breakdown, so they price exactly rather than blending two already-derived rates.</li>
      <li><strong>Estimated from a combined sample</strong>: the median, percentiles and confidence intervals for request/session/hour size, and (in a combined verdict) the significance test. Each source's report only ever stored a bounded random sample (not every raw value), so these are recomputed from a sample drawn from each source in proportion to its true size - see &ldquo;which numbers are exact&rdquo; below for what stays exact regardless.</li>
      ${
        mergedVerdict
          ? `<li><strong>A genuine combined verdict</strong>, not an approximation: because every --baseline source keeps its own full raw per-agent-type/tool-payload/compaction/distribution data (unlike a --compare report's own embedded baseline reference, which keeps only already-derived findings), merging --baseline sources together and --compare sources together gives two real, complete windows to compare - so this report runs the exact same decomposition, quality-guardrail and significance-testing logic a single-machine --compare does, just fed from the merged windows either side.</li>`
          : `<li><strong>Not attempted</strong>: a combined before/after verdict. This merge's sources are all one mode (all --baseline, or all --compare), so there is only one window's worth of raw data here, not a &ldquo;before&rdquo; and an &ldquo;after&rdquo; to compare. This report is therefore a standing snapshot, never a verdict. Include at least one --baseline report alongside at least one --compare report in the same --merge run to get a real combined verdict instead.</li>`
      }
    </ul>`
        : ''
    }

    <h3>Why rates, not totals</h3>
    <p>A baseline covers everything on disk (often a month); a compare covers only what happened since. Comparing those totals directly would just tell you which window was longer. So every headline figure is a <strong>rate</strong> &mdash; per request, per session, per active hour &mdash; which stays comparable no matter how long each window ran.</p>

    <h3>How the cost estimate is built</h3>
    <p>Each token is priced by its class and the model that produced it, using published Claude API list rates: cache reads at <strong>${m.cacheReadMultiplier}&times;</strong> the model&rsquo;s input rate${
      (m.cacheReadMultiplierExceptions ?? []).length
        ? ` (except ${m.cacheReadMultiplierExceptions.map((x) => `<code>${esc(x.model)}</code> at <strong>${x.cacheReadMultiplier}&times;</strong>`).join(' and ')})`
        : ''
    }, output at that model&rsquo;s own output rate, and cache writes by how long they were held &mdash; <strong>${m.cacheWrite5mMultiplier}&times;</strong> for a 5-minute cache and <strong>${m.cacheWrite1hMultiplier}&times;</strong> for a 1-hour one. The price table is frozen (version <code>${esc(m.priceTableVersion)}</code>) and identical on both sides of every comparison &mdash; otherwise a price change by Anthropic would show up as your efficiency win.</p>
    ${
      ttlMode === 'flat'
        ? `<p class="callout callout-info"><strong>Cache writes here are costed at the flat ${m.cacheWriteFallbackMultiplier}&times; rate.</strong> The 5-minute/1-hour breakdown is missing from at least one side of this comparison, and pricing one side exactly while the other is estimated would show up as a cost change that is really just a change in measurement. Both sides therefore use the cheaper flat rate, which understates true spend a little &mdash; on this corpus, by roughly 2.5%. Re-run <code>--baseline</code> to capture the breakdown and both sides will price exactly.</p>`
        : `<p class="callout callout-ok"><strong>Cache writes are costed exactly.</strong> Both sides of this comparison record the 5-minute/1-hour split, so 1-hour cache writes are billed at ${m.cacheWrite1hMultiplier}&times; rather than assumed to be the cheaper 5-minute kind.</p>`
    }
    <p class="callout callout-warn"><strong>This is an estimate, not your bill.</strong> Claude Code transcripts contain no billing signal, and on a subscription plan you are not charged per token at all. Treat the dollar figures as a consistently-weighted way to compare two periods against each other, not as an amount anybody invoiced you.${
      reportData.cost.unpricedTokens || reportData.cost.unpricedRequests
        ? ` ${fmtInt(reportData.cost.unpricedTokens ?? 0)} token(s)${reportData.cost.unpricedRequests ? ` across ${fmtInt(reportData.cost.unpricedRequests)} request(s)` : ''} ran on a model with no entry in the price table (${(reportData.cost.unpricedModels ?? []).map((mm) => `<code>${esc(mm)}</code>`).join(', ')}) and were costed at the Opus tier, which may over- or under-state their true rate.`
        : ''
    }</p>

    <h3>Which numbers are exact, and which use a sample</h3>
    <p>A period can hold hundreds of thousands of requests, and storing every value in every report would make these files unusable. So each distribution keeps a <strong>random sample of up to 5,000 values</strong> alongside its statistics.</p>
    ${
      merged
        ? `<p><strong>Exact, even after merging:</strong> all totals, costs, averages, and every count on this page - each source's report already stored these exactly, and summing exact numbers stays exact.</p>
    <p><strong>Estimated once a report is merged:</strong> the median, every percentile, the distribution curve, and the confidence intervals. A single-source report computes these exactly, but a merged one only has each source's bounded sample to work from, combined in proportion to each source's true size (see &ldquo;how the merged sources were combined&rdquo; above) - representative, but no longer exact.</p>`
        : `<p><strong>Exact, computed from every single request:</strong> all totals, costs, averages, the median and every percentile, and the confidence intervals. Nothing on this page that carries a number is estimated from the sample.</p>
    <p><strong>Drawn from the sample:</strong> the shape of the distribution curve, and the significance test. The sample is drawn at random, so it is representative &mdash; but where a figure comes from it, the report says so rather than quoting the sample size as if it were the request count.</p>`
    }

    <h3>What &ldquo;statistically significant&rdquo; means here</h3>
    <p>Any two periods will differ a bit by luck. The report runs a Mann-Whitney U test, which asks: if nothing had really changed, how often would a difference this large turn up anyway? Below a 1-in-20 chance, the result is called real. Below 10 samples on either side the test is skipped entirely and only a direction is reported &mdash; never treat that as a result.</p>

    <h3>What this tool can and cannot see</h3>
    <ul>
      <li>It reads local transcript files only. Anything not written to <code>~/.claude</code> is invisible to it.</li>
      <li>Local transcripts rotate after roughly 30 days. A baseline&rsquo;s stored statistics stay valid as a reference forever, but that exact historical window can never be re-scanned once the source files age out.</li>
      <li>There is no per-day breakdown in the stored data, so this report compares two periods as blocks rather than plotting a trend line over time.</li>
    </ul>
  </div>`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Exported so visualiseHtml.js can build a second report page in the same visual language without
// duplicating the palette/typography - purely a shared read-only constant, not a functional
// dependency on baseline/compare behaviour.
export const STYLE = `
  :root {
    color-scheme: light;
    --bg: #ffffff; --surface: #fcfcfb; --fg: #1b1f24; --muted: #5b6470; --border: #dfe3e8;
    --accent: #2a78d6;
    --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a; --series-4: #eda100;
    --good: #0ca30c; --bad: #d03b3b; --warn: #fab219; --neutral: #5b6470;
    --good-bg: #eefaee; --bad-bg: #fdeeee; --warn-bg: #fff8e6; --info-bg: #eef4fd; --neutral-bg: #f3f5f7;
    --grid: #ebeef2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #14171c; --surface: #1a1a19; --fg: #e6e9ee; --muted: #9aa4b2; --border: #2b3038;
      --accent: #3987e5;
      --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70; --series-4: #c98500;
      --good: #0ca30c; --bad: #d03b3b; --warn: #fab219; --neutral: #9aa4b2;
      --good-bg: #10240f; --bad-bg: #2c1416; --warn-bg: #2d2510; --info-bg: #131f31; --neutral-bg: #1e232b;
      --grid: #262b33;
    }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 2rem 1rem 4rem; line-height: 1.55; }
  .wrap { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
  h2 { font-size: 1.25rem; border-bottom: 1px solid var(--border); padding-bottom: 0.45rem; margin-top: 3rem; letter-spacing: -0.01em; }
  h3 { font-size: 0.98rem; margin: 1.5rem 0 0.5rem; }
  p { margin: 0.6rem 0; }
  code { background: var(--neutral-bg); padding: 0.08em 0.35em; border-radius: 4px; font-size: 0.88em; white-space: nowrap; }
  .lede { color: var(--muted); max-width: 74ch; }
  .muted { color: var(--muted); font-size: 0.86rem; max-width: 80ch; }

  table { border-collapse: collapse; width: 100%; margin: 0.75rem 0 1rem; font-size: 0.9rem; }
  th, td { border-bottom: 1px solid var(--border); padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .meaning-cell { color: var(--muted); font-size: 0.85rem; max-width: 42ch; }
  .table-scroll { overflow-x: auto; }

  /* Verdict */
  .verdict { display: grid; grid-template-columns: minmax(190px, 250px) 1fr; gap: 1.75rem; align-items: center;
             border: 1px solid var(--border); border-left: 5px solid var(--neutral); border-radius: 12px; padding: 1.5rem; margin: 1.5rem 0 0; background: var(--surface); }
  .verdict-good { border-left-color: var(--good); }
  .verdict-bad { border-left-color: var(--bad); }
  .verdict-neutral { border-left-color: var(--neutral); }
  .hero-number { font-size: 3.4rem; font-weight: 700; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .verdict-good .hero-number { color: var(--good); }
  .verdict-bad .hero-number { color: var(--bad); }
  .hero-caption { color: var(--muted); font-size: 0.88rem; margin-top: 0.5rem; }
  .verdict-answer { font-size: 1.08rem; margin-top: 0; }
  .sig { font-size: 0.88rem; color: var(--muted); border-top: 1px solid var(--border); padding-top: 0.6rem; margin-bottom: 0; }
  .quality-warn { font-size: 0.9rem; background: var(--warn-bg); border-radius: 8px; padding: 0.7rem 0.9rem; margin: 0.75rem 0 0; }
  .verdict-warn { border-left-color: var(--warn); }
  .verdict-warn .hero-number { color: var(--warn); }

  /* Findings */
  .findings { list-style: none; padding: 0; margin: 1rem 0; display: grid; gap: 0.65rem; }
  .finding { border: 1px solid var(--border); border-left: 4px solid var(--neutral); border-radius: 9px; padding: 0.8rem 1rem; background: var(--surface); }
  .finding-good { border-left-color: var(--good); }
  .finding-bad { border-left-color: var(--bad); }
  .finding-warn { border-left-color: var(--warn); }
  .finding-head { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
  .finding-glyph { font-size: 0.8rem; }
  .finding-good .finding-glyph, .finding-good .finding-tag { color: var(--good); }
  .finding-bad .finding-glyph, .finding-bad .finding-tag { color: var(--bad); }
  .finding-warn .finding-glyph, .finding-warn .finding-tag { color: var(--warn); }
  .finding-tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .finding-title { font-weight: 650; font-size: 1rem; }
  .finding-meaning { color: var(--muted); font-size: 0.89rem; margin: 0.35rem 0 0; max-width: 82ch; }

  /* KPI cards */
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(270px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
  .kpi { border: 1px solid var(--border); border-radius: 10px; padding: 0.85rem 1rem; background: var(--surface); }
  .kpi-label { color: var(--muted); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .kpi-values { display: flex; align-items: baseline; gap: 0.5rem; margin: 0.4rem 0 0.15rem; flex-wrap: wrap; }
  .kpi-before { color: var(--muted); font-size: 1rem; text-decoration: line-through; text-decoration-thickness: 1px; font-variant-numeric: tabular-nums; }
  .kpi-arrow { color: var(--muted); }
  .kpi-after { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .kpi-delta { font-size: 0.82rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .kpi-word { font-weight: 500; opacity: 0.75; }
  .kpi-delta-good { color: var(--good); } .kpi-delta-bad { color: var(--bad); }
  .kpi-delta-warn { color: var(--warn); } .kpi-delta-neutral { color: var(--muted); }
  .kpi-meaning { color: var(--muted); font-size: 0.83rem; margin: 0.5rem 0 0; }

  .delta-good { color: var(--good); } .delta-bad { color: var(--bad); } .delta-neutral { color: var(--muted); }

  /* Callouts + explainers */
  .callout { border-radius: 9px; padding: 0.8rem 1rem; font-size: 0.89rem; margin: 1rem 0; border: 1px solid var(--border); max-width: 88ch; }
  .callout-warn { background: var(--warn-bg); }
  .callout-info { background: var(--info-bg); }
  .callout-ok { background: var(--good-bg); }
  .explainer { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; margin: 1.25rem 0; }
  .explainer h3 { margin-top: 1.1rem; font-size: 0.95rem; color: var(--fg); }
  .explainer h3:first-child { margin-top: 0; }
  .explainer p, .explainer li { font-size: 0.89rem; color: var(--muted); max-width: 84ch; }
  .explainer strong { color: var(--fg); }
  .explainer ul { padding-left: 1.15rem; }
  .explainer li { margin: 0.3rem 0; }
  .reading { font-size: 0.9rem; color: var(--muted); max-width: 84ch; }
  .reading strong, .reading em { color: var(--fg); }

  /* Charts */
  .chart { margin: 1.25rem 0; padding: 0; overflow-x: auto; }
  .chart svg { display: block; min-width: 460px; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  /* Reference lines that mean "here is the neutral/expected value", not "here is a gridline" - dashed
     so they read as annotation rather than as chart furniture even at TV-presentation sizes. */
  .grid-dash { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 5 4; opacity: 0.75; }
  .axis { stroke: var(--border); stroke-width: 1; }
  .tick, .axis-title, .row-label, .bar-val, .seg-label, .median-label, .wf-val {
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif; fill: var(--muted); font-size: 11px; }
  .axis-title { font-size: 11px; }
  .row-label { fill: var(--fg); font-size: 12px; }
  .bar-val { font-variant-numeric: tabular-nums; }
  .seg-label { fill: var(--fg); font-size: 11px; font-weight: 600; }
  .median-label { font-size: 11px; font-weight: 650; }
  .wf-val { fill: var(--fg); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .dist-fill { opacity: 0.16; }
  .dist-line { fill: none; stroke-width: 2; stroke-linejoin: round; }
  .median-rule { stroke-width: 2; opacity: 0.85; }
  .bar-a { fill: var(--series-1); }
  .bar-b { fill: var(--series-2); }
  .delta { font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; fill: var(--muted); }
  .delta-good { fill: var(--good); } .delta-bad { fill: var(--bad); } .delta-neutral { fill: var(--muted); }
  .wf-total { fill: var(--neutral); opacity: 0.55; }
  .wf-down { fill: var(--series-1); }
  .wf-up { fill: var(--series-2); }
  .wf-connector { stroke: var(--border); stroke-width: 1; }
  .legend { display: flex; gap: 1.1rem; flex-wrap: wrap; font-size: 0.85rem; color: var(--fg); margin-top: 0.4rem; }
  .legend-item { display: inline-flex; align-items: center; gap: 0.4rem; }
  .swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
  figcaption { font-size: 0.8rem; color: var(--muted); margin-top: 0.5rem; max-width: 84ch; }

  /* Meta + misc */
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0.6rem; margin: 1rem 0; }
  .meta-item { border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.7rem; background: var(--surface); }
  .meta-item .label { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .meta-item .value { font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; word-break: break-word; }
  .meta-item.wide { grid-column: 1 / -1; }
  .meta-item.wide .value { font-size: 0.88rem; font-weight: 500; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.72rem; margin-right: 0.3rem; background: var(--neutral-bg); color: var(--muted); }
  .badge-warn { background: var(--warn-bg); color: var(--fg); }
  .badge-info { background: var(--info-bg); color: var(--fg); }
  details { border: 1px solid var(--border); border-radius: 9px; padding: 0.5rem 1rem; margin: 0.6rem 0; background: var(--surface); }
  details > summary { cursor: pointer; font-weight: 600; font-size: 0.94rem; padding: 0.3rem 0; }
  footer { margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.83rem; }
  footer p { max-width: 88ch; }

  @media (max-width: 720px) {
    .verdict { grid-template-columns: 1fr; gap: 1rem; }
    body { padding: 1.25rem 0.85rem 3rem; }
  }
`;

// ---------------------------------------------------------------------------
// Presentation stylesheet (TV / large-screen viewing)
// ---------------------------------------------------------------------------
// Appended after STYLE in every report this tool generates (--baseline, --compare, --visualise,
// --merge), so all of them share one signature look rather than reading as different tools. Every
// rule here is a deliberate override: variables redeclared in a later, unconditional :root block win
// over both STYLE's light AND (should the viewing device prefer it) dark-mode :root blocks, which is
// what keeps every report light no matter what the TV/browser's own theme is set to.
//
// Relies on one mechanical fact about the existing charts: every chart's <svg> sets width="100%" and
// a fixed viewBox with no CSS height, so the whole chart - bars, gaps, and every piece of text inside
// it - already scales up uniformly as its container grows. Widening .wrap below is therefore most of
// the "make this legible from across a room" work; the rest is bumping the HTML (non-SVG) text that
// doesn't live inside an <svg> - headings, KPI numbers, table cells, legends, captions, and (for
// --baseline/--compare specifically) the verdict hero number and findings list.
export const TV_STYLE = `
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
  .grid-dash { stroke-width: 1.6; }
  .axis { stroke-width: 1.6; }

  details > summary { font-size: 1.05rem; }
  footer { font-size: 0.95rem; }
  footer p { max-width: none; }

  /* Verdict hero (--compare only) - the single biggest number on any report this tool generates,
     so it gets the largest type treatment on the page. */
  .verdict { border-radius: 16px; padding: 2rem 2.25rem; gap: 2.25rem; grid-template-columns: minmax(240px, 320px) 1fr; }
  .hero-number { font-family: var(--font-mono); font-size: 4.5rem; }
  .hero-caption { font-size: 1.12rem; margin-top: 0.65rem; }
  .verdict-answer { font-size: 1.35rem; }
  .sig { font-size: 1.05rem; padding-top: 0.9rem; }
  .quality-warn { font-size: 1.05rem; padding: 1rem 1.25rem; }

  /* Findings list */
  .findings { gap: 0.9rem; }
  .finding { padding: 1.1rem 1.3rem; border-radius: 12px; }
  .finding-tag { font-size: 0.78rem; }
  .finding-title { font-size: 1.15rem; }
  .finding-meaning { font-size: 1rem; max-width: none; }

  .badge { font-size: 0.82rem; padding: 0.15rem 0.65rem; }

  @media (max-width: 900px) {
    .wrap { max-width: 100%; font-size: 1rem; }
    h1 { font-size: 2.3rem; }
    h2 { font-size: 1.5rem; }
    .kpi-after { font-size: 2.1rem; }
    .hero-number { font-size: 3.2rem; }
    .verdict { grid-template-columns: 1fr; }
  }
`;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderHtmlReport(reportData) {
  const isCompare = reportData.mode === 'compare';
  const cmp = reportData.comparison;
  const merged = Array.isArray(reportData.sources) && reportData.sources.length > 0;

  const metaItems = [
    ['Generated', fmtWhen(reportData.generatedAt), false, true],
    ['Requests measured', fmtInt(reportData.totals.requests)],
    ['Transcript files', fmtInt(reportData.scan.filesScanned)],
    ['Estimated spend', usd(reportData.cost.total)],
  ];
  if (isCompare && reportData.window) {
    const w = reportData.window;
    metaItems.push([
      'Period measured',
      w.mode === 'since-baseline'
        ? `everything since the baseline (${fmtWhen(w.start)} &rarr; ${fmtWhen(w.end)})`
        : `since the previous scan only (${fmtWhen(w.start)} &rarr; ${fmtWhen(w.end)})`,
      true,
      true,
    ]);
  }
  if (isCompare) metaItems.push(['Compared against', reportData.baselineRef, true]);
  metaItems.push(merged ? ['Merged from', `${fmtInt(reportData.sources.length)} source report(s)`, true] : ['Scanned directory', reportData.claudeDir, true]);

  const title = isCompare ? 'Did the changes work?' : merged ? 'Combined usage across machines' : 'Your usage baseline';
  const subtitle = isCompare
    ? merged
      ? 'Combines every --baseline source into one "before" and every --compare source into one "after", then compares them the same way a single-machine --compare does - see the sources table and methodology below for exactly how. Independent of any single machine\'s <code>state.json</code>.'
      : 'Everything below compares activity since your baseline against the baseline itself, normalized so the two periods are directly comparable.'
    : merged
      ? 'Assembled with <code>--merge</code> from several separate --baseline/--compare reports into one combined view - see the sources table and methodology below for exactly how figures were combined. Independent of any single machine\'s <code>state.json</code>.'
      : 'A reference point for everything you measure from here. Make your changes, then run <code>--compare</code>.';

  const body = `<div class="wrap">
  <h1>${esc(title)}</h1>
  <p class="lede">${subtitle}</p>
  <div class="meta-grid">
    ${metaItems
      .map(
        ([label, value, wide, isHtml]) =>
          `<div class="meta-item${wide ? ' wide' : ''}"><div class="label">${esc(label)}</div><div class="value">${isHtml ? value : esc(value)}</div></div>`
      )
      .join('')}
  </div>
  ${mergedSourcesPanel(reportData)}

  ${
    isCompare && cmp
      ? `${verdictSection(reportData)}
  ${section('What changed, and what it means', findingsSection(cmp.insights.findings), {
    eyebrow: 'changes --findings',
    lede: 'Each item below is a metric that moved enough to be worth your attention, with what it actually tells you about your setup.',
  })}
  ${section('The numbers behind that verdict', kpiSection(cmp.insights.kpis), {
    eyebrow: 'kpi --before-after',
    lede: 'Every figure is per request, so the two periods stay comparable even though one covers far more activity than the other.',
  })}
  ${section('Where the change came from', decompositionSection(cmp.decomposition), {
    eyebrow: 'cost --decompose',
    lede: 'Splitting the change in cost per request into the things that actually caused it. Bars below the line saved you money; bars above it cost you money.',
  })}
  ${section('Did it actually get better, or just cheaper?', qualitySection(cmp), {
    eyebrow: 'quality --check',
    lede: 'Cost tells you what you spent, not whether the work was any good. This is the only quality signal the transcripts carry.',
  })}
  ${section('Like-for-like, job by job', agentTypeSection(cmp), {
    eyebrow: 'jobs --by-agent-type',
    lede: 'Each row is one agent type compared against itself. This is the closest this data gets to &ldquo;did that specific campaign improve?&rdquo;',
  })}
  ${section('Like-for-like, model by model', modelComparisonSection(cmp), {
    eyebrow: 'models --by-model',
    lede: 'The honesty check. An overall improvement can be manufactured simply by running more work on a cheaper model, so this section compares each model only against itself.',
  })}`
      : `${section('Where you stand today', baselineStanding(reportData), { eyebrow: 'baseline --standing' })}`
  }

  ${section('How big is a typical request?', distributionSection(reportData), {
    eyebrow: 'requests --distribution',
    lede: 'This is the chart that makes percentiles concrete. Everything else on this page is a summary of what you can see here directly.',
  })}

  ${section('Where your tokens actually go', tokenClassExplainer(reportData), {
    eyebrow: 'tokens --classes',
    lede: 'Not all tokens cost the same. Understanding this is the difference between a number that looks alarming and one that matters.',
  })}

  ${section('Your biggest levers', toolPayloadSection(reportData.toolPayload, reportData.totals.requests), {
    eyebrow: 'tools --levers',
    lede: 'Concrete, actionable places where context gets consumed - ranked so you know what to trim first.',
  })}

  ${section('How to read this report', methodExplainer(reportData), { eyebrow: '--help' })}

  <h2>Full detail</h2>
  <details><summary>Breakdown by tier</summary>${tierBreakdownTable(reportData.byTier)}</details>
  <details><summary>Breakdown by agent type (${reportData.byAgentType.length})</summary><div class="table-scroll">${groupedTotalsTable(reportData.byAgentType, 'Agent type')}</div></details>
  <details><summary>Breakdown by model</summary><div class="table-scroll">${groupedTotalsTable(reportData.byModel, 'Model')}</div></details>
  <details><summary>Skill and CLAUDE.md injection cost</summary><div class="table-scroll">${attachmentsSection(reportData.attachments)}</div></details>
  <details><summary>Compaction events</summary>${compactionSection(reportData.compaction, reportData.totals.requests)}</details>
  <details><summary>Raw distribution statistics</summary><div class="table-scroll">${Object.values(reportData.distributions)
    .map((d) => distributionTable(d))
    .join('')}</div></details>

  <footer>
    <p><strong>Data quality:</strong> ${fmtInt(reportData.scan.corruptLineCount)} corrupt or partial transcript lines were skipped and left for the next scan to re-read. ${fmtInt(reportData.scan.boundaryReconciliations ?? 0)} messages already counted in an earlier period were excluded so nothing is double-counted.${
      reportData.scan.undatedLinesSkipped
        ? ` ${fmtInt(reportData.scan.undatedLinesSkipped)} lines carried no timestamp and could not be attributed to this period, so they were left out.`
        : ''
    }</p>
    <p><strong>Dollar figures are estimates at published API list rates, not billing data.</strong> Claude Code transcripts contain no cost signal, and subscription plans are not billed per token. Use them to compare two periods on a consistent basis, nothing more.</p>
    <p>Generated by claude-usage-baseliner &middot; price table ${esc(reportData.cost.model.priceTableVersion)}.</p>
  </footer>
</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(reportData.id)}</title>
<style>${STYLE}${TV_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}
