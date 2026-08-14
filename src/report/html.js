// Renders a single self-contained HTML report (no CDN deps, no external fonts, no <script> tags -
// collapsible sections use native <details>/<summary> - so the file is safe to double-click open
// offline on any machine). Used for both --baseline and --compare reports.

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

function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function badge(text, kind = 'default') {
  return `<span class="badge badge-${kind}">${esc(text)}</span>`;
}

function lowConfBadge(isLow) {
  return isLow ? badge('low-confidence (n<20)', 'warn') : '';
}

function section(title, bodyHtml, { id } = {}) {
  return `<section${id ? ` id="${esc(id)}"` : ''}>
  <h2>${esc(title)}</h2>
  ${bodyHtml}
</section>`;
}

function tokenClassBreakdownTable(tokens, share) {
  const rows = [
    ['Input', tokens.inputTokens, share.input],
    ['Output', tokens.outputTokens, share.output],
    ['Cache create', tokens.cacheCreationTokens, share.cacheCreation],
    ['Cache read', tokens.cacheReadTokens, share.cacheRead],
  ];
  return `<table>
    <thead><tr><th>Class</th><th>Tokens</th><th>Share</th><th></th></tr></thead>
    <tbody>
      ${rows
        .map(
          ([label, val, pct]) => `<tr>
        <td>${esc(label)}</td>
        <td class="num">${fmtInt(val)}</td>
        <td class="num">${fmtNum(pct)}%</td>
        <td class="bar-cell"><div class="bar" style="width:${Math.max(0, Math.min(100, pct))}%"></div></td>
      </tr>`
        )
        .join('')}
    </tbody>
  </table>`;
}

function tierBreakdownTable(byTier) {
  const rows = Object.entries(byTier);
  const totalTokens = rows.reduce((acc, [, v]) => acc + v.tokens.total, 0) || 1;
  return `<table>
    <thead><tr><th>Tier</th><th>Requests</th><th>Tokens</th><th>Share</th></tr></thead>
    <tbody>
      ${rows
        .map(
          ([tier, v]) => `<tr>
        <td>${esc(tier)}</td>
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
    <thead><tr><th>${esc(keyLabel)}</th><th>Requests</th><th>Total tokens</th></tr></thead>
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
  return `<table>
    <thead><tr><th>n</th><th>mean</th><th>median</th><th>p75</th><th>p85</th><th>p95</th><th>min</th><th>max</th><th></th></tr></thead>
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

function distributionsSection(distributions) {
  return Object.values(distributions)
    .map((dist) => `<h3>${esc(dist.metric)}</h3>${distributionTable(dist)}`)
    .join('');
}

function comparisonSection(comparison) {
  if (!comparison) return '';
  const rows = Object.values(comparison.distributions)
    .map((cmp) => {
      const mw = cmp.mannWhitney;
      const mwCell = mw.skipped
        ? `${badge('insufficient data', 'warn')} <span class="muted">${esc(mw.reason)}</span>, trend ${esc(mw.directionalTrend)}`
        : `${esc(mw.effectSizeLabel)} effect (r=${fmtNum(mw.rankBiserial, 2)}), p=${fmtNum(mw.pValue, 3)}`;
      return `<div class="cmp-metric">
        <h3>${esc(cmp.metric)}</h3>
        <p class="verdict">${esc(cmp.verdict)}</p>
        <table>
          <thead><tr><th>Percentile</th><th>Baseline</th><th>Compare</th><th>% change</th><th></th></tr></thead>
          <tbody>
            ${['p50', 'p75', 'p85', 'p95']
              .map((k) => {
                const d = cmp.percentileDeltas[k];
                return `<tr>
                <td>${k}</td>
                <td class="num">${fmtInt(d.baseline)}</td>
                <td class="num">${fmtInt(d.compare)}</td>
                <td class="num">${fmtPct(d.pctChange)}</td>
                <td>${lowConfBadge(d.lowConfidence)}</td>
              </tr>`;
              })
              .join('')}
          </tbody>
        </table>
        <p class="muted">Significance: ${mwCell}</p>
        ${
          cmp.compare.bootstrapCI
            ? `<p class="muted">Approx 90% CI on compare median: ${fmtInt(cmp.compare.bootstrapCI.median?.low)}–${fmtInt(cmp.compare.bootstrapCI.median?.high)} (${cmp.compare.bootstrapCI.median?.resamples} resamples)</p>`
            : ''
        }
      </div>`;
    })
    .join('');
  return `<p class="headline">${esc(comparison.headlineVerdict)}</p>${rows}`;
}

function compactionSection(compaction) {
  return `<table>
    <tbody>
      <tr><th>Compaction events</th><td class="num">${fmtInt(compaction.count)}</td></tr>
      <tr><th>Manual / Auto</th><td class="num">${fmtInt(compaction.byTrigger.manual ?? 0)} / ${fmtInt(compaction.byTrigger.auto ?? 0)}</td></tr>
      <tr><th>Total dropped tokens</th><td class="num">${fmtInt(compaction.totalDroppedTokens)}</td></tr>
      <tr><th>Avg pre / post tokens</th><td class="num">${fmtInt(compaction.avgPreTokens)} / ${fmtInt(compaction.avgPostTokens)}</td></tr>
      <tr><th>Avg duration (ms)</th><td class="num">${fmtInt(compaction.avgDurationMs)}</td></tr>
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
  return `<h3>Top skills by injected bytes</h3>
  <table><thead><tr><th>Skill</th><th>Invocations</th><th>Total bytes</th></tr></thead><tbody>${topSkillsRows || '<tr><td colspan="3" class="muted">none observed</td></tr>'}</tbody></table>
  <h3>Top nested-memory (CLAUDE.md) injections by bytes</h3>
  <table><thead><tr><th>Path</th><th>Injections</th><th>Total bytes</th></tr></thead><tbody>${topMemRows || '<tr><td colspan="3" class="muted">none observed</td></tr>'}</tbody></table>`;
}

function toolPayloadSection(toolPayload) {
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
  return `<table>
    <thead><tr><th>Tool</th><th>Calls</th><th>Total bytes</th><th>Mean bytes</th><th>Max bytes</th><th>Errors</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="muted">no tool-result data attributable</td></tr>'}</tbody>
  </table>`;
}

const STYLE = `
  :root {
    --bg: #ffffff; --fg: #1b1f24; --muted: #5b6470; --border: #dfe3e8; --accent: #2f6fed;
    --warn-bg: #fff3cd; --warn-fg: #7a5a00; --info-bg: #e7f1ff; --info-fg: #1f4e9c;
    --bar-bg: #eef2f7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171c; --fg: #e6e9ee; --muted: #9aa4b2; --border: #2b3038; --accent: #6ea1ff;
      --warn-bg: #3a3117; --warn-fg: #f0d27a; --info-bg: #17263d; --info-fg: #9cc2ff;
      --bar-bg: #1e232b;
    }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.2rem; border-bottom: 1px solid var(--border); padding-bottom: 0.4rem; margin-top: 2.5rem; }
  h3 { font-size: 1rem; margin-top: 1.5rem; margin-bottom: 0.5rem; color: var(--muted); }
  table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; font-size: 0.92rem; }
  th, td { border-bottom: 1px solid var(--border); padding: 0.35rem 0.6rem; text-align: left; }
  th { color: var(--muted); font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bar-cell { width: 30%; }
  .bar { height: 0.6rem; background: var(--accent); border-radius: 3px; background-clip: padding-box; }
  .bar-cell { background: var(--bar-bg); border-radius: 3px; }
  .muted { color: var(--muted); font-size: 0.85rem; }
  .headline { font-size: 1.05rem; font-weight: 600; margin: 0.5rem 0 1.5rem; }
  .verdict { margin: 0.25rem 0 0.75rem; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px; font-size: 0.75rem; margin-right: 0.3rem; }
  .badge-warn { background: var(--warn-bg); color: var(--warn-fg); }
  .badge-info { background: var(--info-bg); color: var(--info-fg); }
  .badge-default { background: var(--bar-bg); color: var(--muted); }
  .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
  .meta-item { border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.8rem; }
  .meta-item .label { color: var(--muted); font-size: 0.78rem; }
  .meta-item .value { font-size: 1.1rem; font-weight: 600; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; }
  .cmp-metric { margin-bottom: 2rem; }
`;

export function renderHtmlReport(reportData) {
  const modeLabel = reportData.mode === 'baseline' ? 'Baseline' : 'Compare';
  const metaItems = [
    ['Mode', modeLabel],
    ['Generated', reportData.generatedAt],
    ['Scanned dir', reportData.claudeDir],
    ['Files scanned', fmtInt(reportData.scan.filesScanned)],
    ['New files', fmtInt(reportData.scan.newFiles)],
    ['Corrupt lines skipped', fmtInt(reportData.scan.corruptLineCount)],
    ['Deduped requests', fmtInt(reportData.totals.requests)],
  ];
  if (reportData.mode === 'compare') metaItems.push(['Baseline ref', reportData.baselineRef]);

  const body = `<div class="wrap">
  <h1>Claude Code usage ${esc(modeLabel.toLowerCase())} report</h1>
  <div class="meta-grid">
    ${metaItems.map(([label, value]) => `<div class="meta-item"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`).join('')}
  </div>

  ${reportData.comparison ? section('Compare vs baseline', comparisonSection(reportData.comparison)) : ''}

  ${section('Token breakdown by class', tokenClassBreakdownTable(reportData.totals.tokens, reportData.totals.tokenShare))}
  ${section('Token breakdown by tier', tierBreakdownTable(reportData.byTier))}
  ${section('Token breakdown by agent type', groupedTotalsTable(reportData.byAgentType, 'Agent type'))}
  ${section('Token breakdown by model', groupedTotalsTable(reportData.byModel, 'Model'))}
  ${section('Distributions', distributionsSection(reportData.distributions))}
  ${section('Compaction events', compactionSection(reportData.compaction))}
  ${section('Skill / memory injection cost', attachmentsSection(reportData.attachments))}
  ${section('Tool payload cost', toolPayloadSection(reportData.toolPayload))}

  <footer>
    <p><strong>Data-quality notes:</strong> ${fmtInt(reportData.scan.corruptLineCount)} corrupt/partial JSONL lines were skipped and safely left for the next scan to re-read. ${fmtInt(reportData.scan.boundaryReconciliations ?? 0)} boundary reconciliations (messages already attributed to a prior scan period) were excluded from this report's own totals.</p>
    <p>All figures are <strong>token-count proxies</strong>, not billing data - no reliable USD cost signal exists in local Claude Code transcripts on subscription plans.</p>
    <p>Local transcript retention is roughly 30 days; a baseline computed today cannot be regenerated for this exact historical window once source transcripts rotate out. This report's own stored stats remain valid indefinitely as a comparison reference regardless.</p>
    <p>Generated by claude-usage-baseliner.</p>
  </footer>
</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Usage ${esc(modeLabel)} Report - ${esc(reportData.id)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}
