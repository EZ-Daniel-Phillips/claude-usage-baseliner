// Inline-SVG chart primitives.
//
// Constraints inherited from html.js: the report must stay a single self-contained file that opens
// offline by double-click, with no <script> tags and no external requests. So every chart here is
// static SVG laid out server-side. Interactivity is limited to native <title> tooltips, which need
// no JS.
//
// Colours are emitted as var(--...) references, never literal hex, so the one stylesheet in html.js
// controls light/dark for every chart at once. Palette values are the validated defaults from the
// dataviz reference palette (categorical slots 1 and 2, which pass CVD and contrast checks in both
// modes).

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Compact token/number formatting for axis ticks and inline labels.
export function fmtCompact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function fmtUsd(n, { precise = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  if (precise || Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function percentileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

// ---------------------------------------------------------------------------
// Distribution comparison chart
// ---------------------------------------------------------------------------
// The centrepiece. Two overlaid density curves (baseline vs compare) over request size, with each
// series' median drawn as a labelled vertical rule. This is what makes percentiles legible: you can
// literally see the mass of requests shift left, rather than reading p50/p95 as bare numbers.
//
// Densities are normalized to "share of that series' own requests per bin", so a 5,000-value
// baseline sample and a 2,152-value compare sample are directly comparable despite different n.
export function distributionChart(series, { width = 860, height = 300, xLabel = 'Tokens per request', clipPercentile = 0.98 } = {}) {
  const live = series.filter((s) => s.values && s.values.length >= 2);
  if (live.length === 0) return '<p class="muted">Not enough data to plot a distribution.</p>';

  const prepared = live.map((s) => {
    const sorted = [...s.values].sort((a, b) => a - b);
    return {
      ...s,
      sorted,
      p50: percentileSorted(sorted, 0.5),
      p95: percentileSorted(sorted, 0.95),
    };
  });

  // Clip the long right tail so the bulk of the distribution isn't squashed into the first 10% of
  // the axis. The clipped tail is disclosed in the caption, never silently dropped.
  const xMax = Math.max(...prepared.map((s) => percentileSorted(s.sorted, clipPercentile)));
  const xMin = 0;
  const BINS = 44;
  const binWidth = (xMax - xMin) / BINS;

  const withDensity = prepared.map((s) => {
    const counts = new Array(BINS).fill(0);
    for (const v of s.sorted) {
      if (v > xMax) continue; // clipped tail: excluded from the curve, disclosed in the caption
      const idx = Math.min(BINS - 1, Math.max(0, Math.floor((v - xMin) / binWidth)));
      counts[idx] += 1;
    }
    // Normalize against the full sample, not just the plotted part, so the curves stay comparable
    // and the clipped mass shows up honestly as area missing from the right tail.
    const density = counts.map((c) => c / s.sorted.length);
    return { ...s, density };
  });

  const yMax = Math.max(...withDensity.flatMap((s) => s.density)) * 1.18 || 1;

  const padL = 52;
  const padR = 18;
  const padT = 48; // reserves a band above the plot for the median labels
  const padB = 52;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const sx = (v) => padL + ((v - xMin) / (xMax - xMin)) * plotW;
  const sy = (v) => padT + plotH - (v / yMax) * plotH;

  // Horizontal gridlines: solid hairlines, one shade off the surface (never dashed).
  const gridLines = [0.25, 0.5, 0.75, 1]
    .map((f) => `<line class="grid" x1="${padL}" y1="${sy(yMax * f).toFixed(1)}" x2="${padL + plotW}" y2="${sy(yMax * f).toFixed(1)}"/>`)
    .join('');

  const xTicks = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const val = xMin + (xMax - xMin) * f;
      const x = sx(val);
      return `<line class="grid" x1="${x.toFixed(1)}" y1="${padT + plotH}" x2="${x.toFixed(1)}" y2="${padT + plotH + 4}"/>
        <text class="tick" x="${x.toFixed(1)}" y="${padT + plotH + 18}" text-anchor="middle">${esc(fmtCompact(val))}</text>`;
    })
    .join('');

  const areas = withDensity
    .map((s) => {
      const pts = s.density.map((d, i) => {
        const x = sx(xMin + (i + 0.5) * binWidth);
        return `${x.toFixed(1)},${sy(d).toFixed(1)}`;
      });
      const first = sx(xMin + 0.5 * binWidth).toFixed(1);
      const last = sx(xMin + (BINS - 0.5) * binWidth).toFixed(1);
      const base = (padT + plotH).toFixed(1);
      return `<polygon class="dist-fill" points="${first},${base} ${pts.join(' ')} ${last},${base}" fill="var(--${s.colorVar})"/>
        <polyline class="dist-line" points="${pts.join(' ')}" stroke="var(--${s.colorVar})"/>`;
    })
    .join('');

  // Median rules, direct-labelled. Selective labelling only - never a number on every point.
  const medians = withDensity
    .map((s, i) => {
      const x = sx(Math.min(s.p50, xMax));
      const labelY = 16 + i * 14; // stacked inside the padT band, never inside the plot
      const anchor = x > padL + plotW * 0.72 ? 'end' : 'start';
      const dx = anchor === 'end' ? -6 : 6;
      return `<line class="median-rule" x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${padT + plotH}" stroke="var(--${s.colorVar})"/>
        <text class="median-label" x="${(x + dx).toFixed(1)}" y="${labelY}" text-anchor="${anchor}">${esc(s.label)} typical: ${esc(fmtCompact(s.p50))}</text>`;
    })
    .join('');

  const clippedNote = withDensity
    .map((s) => s.sorted.filter((v) => v > xMax).length)
    .reduce((a, b) => a + b, 0);

  // Say plainly when a curve is drawn from a subset - "n=5,000" beside a 71,544-request period
  // otherwise reads as the period only having 5,000 requests in it.
  const legend = withDensity
    .map((s) => {
      const drawn = s.sorted.length;
      const note =
        s.totalN && s.totalN > drawn
          ? `${drawn.toLocaleString('en-US')} sampled from ${s.totalN.toLocaleString('en-US')} requests`
          : `all ${drawn.toLocaleString('en-US')} requests`;
      return `<span class="legend-item"><span class="swatch" style="background:var(--${s.colorVar})"></span>${esc(s.label)} <span class="muted">(${note})</span></span>`;
    })
    .join('');

  return `<figure class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" width="100%" preserveAspectRatio="xMidYMid meet"
         aria-label="Distribution of ${esc(xLabel)}, baseline versus compare">
      ${gridLines}
      ${areas}
      ${medians}
      <line class="axis" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"/>
      <line class="axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}"/>
      ${xTicks}
      <text class="axis-title" x="${padL + plotW / 2}" y="${height - 8}" text-anchor="middle">${esc(xLabel)} &rarr;</text>
      <text class="axis-title" x="14" y="${padT + plotH / 2}" text-anchor="middle" transform="rotate(-90 14 ${padT + plotH / 2})">share of requests</text>
    </svg>
    <div class="legend">${legend}</div>
    ${clippedNote ? `<figcaption class="muted">Right tail clipped at ${fmtCompact(xMax)} so the bulk of the distribution stays readable; ${clippedNote.toLocaleString('en-US')} sampled request(s) sit beyond it and are still included in every statistic.</figcaption>` : ''}
  </figure>`;
}

// ---------------------------------------------------------------------------
// Paired before/after bars
// ---------------------------------------------------------------------------
// One row per metric, two bars each, scaled within the row (metrics have incomparable units, so a
// shared scale would be meaningless). Direction-aware status colouring is applied by the caller.
export function beforeAfterBars(rows, { width = 860, rowHeight = 54, labelW = 230 } = {}) {
  if (!rows.length) return '';
  const height = rows.length * rowHeight + 34;
  const padR = 120; // keeps the value labels clear of the right-anchored delta column
  const barW = width - labelW - padR;

  const body = rows
    .map((r, i) => {
      const y = 24 + i * rowHeight;
      const max = Math.max(r.baseline ?? 0, r.compare ?? 0) || 1;
      const wB = Math.max(2, ((r.baseline ?? 0) / max) * barW);
      const wC = Math.max(2, ((r.compare ?? 0) / max) * barW);
      const good = r.lowerIsBetter ? (r.compare ?? 0) < (r.baseline ?? 0) : (r.compare ?? 0) > (r.baseline ?? 0);
      const changed = (r.compare ?? 0) !== (r.baseline ?? 0);
      const deltaClass = !changed ? 'neutral' : good ? 'good' : 'bad';
      const pct = r.baseline ? (((r.compare ?? 0) - r.baseline) / Math.abs(r.baseline)) * 100 : null;
      return `<g>
        <text class="row-label" x="0" y="${y + 10}">${esc(r.label)}</text>
        <rect class="bar-a" x="${labelW}" y="${y}" width="${wB.toFixed(1)}" height="9" rx="4"><title>${esc(r.label)} — baseline: ${esc(r.baselineText)}</title></rect>
        <rect class="bar-b" x="${labelW}" y="${y + 15}" width="${wC.toFixed(1)}" height="9" rx="4"><title>${esc(r.label)} — after changes: ${esc(r.compareText)}</title></rect>
        <text class="bar-val" x="${labelW + Math.max(wB, wC) + 10}" y="${y + 8}">${esc(r.baselineText)}</text>
        <text class="bar-val" x="${labelW + Math.max(wB, wC) + 10}" y="${y + 23}">${esc(r.compareText)}</text>
        <text class="delta delta-${deltaClass}" x="${width}" y="${y + 16}" text-anchor="end">${pct === null ? '' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}</text>
      </g>`;
    })
    .join('');

  return `<figure class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" width="100%" preserveAspectRatio="xMidYMid meet" aria-label="Before and after comparison of key metrics">
      <text class="tick" x="${labelW}" y="12">upper bar = baseline &nbsp;&middot;&nbsp; lower bar = after your changes</text>
      ${body}
    </svg>
  </figure>`;
}

// ---------------------------------------------------------------------------
// Stacked share bar (token class mix)
// ---------------------------------------------------------------------------
// A 2px surface gap separates segments rather than a stroke around each one.
export function stackedShareBar(segments, { width = 860, height = 46 } = {}) {
  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  let x = 0;
  const parts = segments
    .map((s) => {
      const w = (s.value / total) * width;
      const rect = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - 2).toFixed(1)}" height="22" rx="3" fill="var(--${s.colorVar})"><title>${esc(s.label)}: ${esc(s.valueText)} (${((s.value / total) * 100).toFixed(1)}%)</title></rect>`;
      // Only label a segment when the text actually fits inside it; otherwise it goes to the legend.
      const label = w > 66 ? `<text class="seg-label" x="${(x + w / 2 - 1).toFixed(1)}" y="38" text-anchor="middle">${esc(s.label)} ${((s.value / total) * 100).toFixed(1)}%</text>` : '';
      x += w;
      return rect + label;
    })
    .join('');
  // Segments too narrow to hold their own label would otherwise be unidentifiable, so the legend is
  // always present rather than only when in-bar labels are dropped.
  const legend = segments
    .map(
      (s) =>
        `<span class="legend-item"><span class="swatch" style="background:var(--${s.colorVar})"></span>${esc(s.label)} <span class="muted">${((s.value / total) * 100).toFixed(1)}%</span></span>`
    )
    .join('');
  return `<figure class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" width="100%" preserveAspectRatio="xMidYMid meet" aria-label="Token class mix">${parts}</svg><div class="legend">${legend}</div></figure>`;
}

// ---------------------------------------------------------------------------
// Horizontal bars (per-model, per-tool rankings)
// ---------------------------------------------------------------------------
export function horizontalBars(rows, { width = 860, labelW = 220, rowHeight = 26, valueW = 130 } = {}) {
  if (!rows.length) return '<p class="muted">No data.</p>';
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const barW = width - labelW - valueW;
  const height = rows.length * rowHeight + 8;
  const body = rows
    .map((r, i) => {
      const y = i * rowHeight + 4;
      const w = Math.max(2, (r.value / max) * barW);
      return `<g>
        <text class="row-label" x="0" y="${y + 13}">${esc(r.label)}</text>
        <rect class="bar-a" x="${labelW}" y="${y + 5}" width="${w.toFixed(1)}" height="10" rx="4" fill="var(--${r.colorVar ?? 'series-1'})"><title>${esc(r.label)}: ${esc(r.valueText)}</title></rect>
        <text class="bar-val" x="${labelW + barW + 10}" y="${y + 14}">${esc(r.valueText)}</text>
      </g>`;
    })
    .join('');
  return `<figure class="chart"><svg viewBox="0 0 ${width} ${height}" role="img" width="100%" preserveAspectRatio="xMidYMid meet" aria-label="Ranked comparison">${body}</svg></figure>`;
}

// ---------------------------------------------------------------------------
// Vertical time-series bars (daily activity over the whole usage history)
// ---------------------------------------------------------------------------
// Built for a few dozen to a few hundred points (one per active day), so bars are thin and only a
// sparse subset of dates gets an axis label - labelling every bar would be illegible at that count.
export function timeSeriesBars(rows, { width = 860, height = 220, valueLabel = 'value', maxLabels = 10 } = {}) {
  if (!rows.length) return '<p class="muted">No data.</p>';
  const padL = 46;
  const padR = 10;
  const padT = 14;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const gap = rows.length > 120 ? 0.5 : 1.5;
  const barW = Math.max(0.6, plotW / rows.length - gap);
  const sy = (v) => padT + plotH - (v / max) * plotH;

  const labelEvery = Math.max(1, Math.ceil(rows.length / maxLabels));
  const bars = rows
    .map((r, i) => {
      const x = padL + i * (plotW / rows.length);
      const h = Math.max(0.5, (r.value / max) * plotH);
      const showLabel = i % labelEvery === 0 || i === rows.length - 1;
      return `<g>
        <rect class="bar-a" x="${x.toFixed(2)}" y="${sy(r.value).toFixed(1)}" width="${barW.toFixed(2)}" height="${h.toFixed(1)}"><title>${esc(r.label)}: ${esc(r.valueText ?? String(r.value))}</title></rect>
        ${showLabel ? `<text class="tick" x="${(x + barW / 2).toFixed(1)}" y="${padT + plotH + 16}" text-anchor="middle">${esc(r.label)}</text>` : ''}
      </g>`;
    })
    .join('');

  const yTicks = [0, 0.5, 1]
    .map((f) => {
      const v = max * f;
      const y = sy(v);
      return `<line class="grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}"/>
        <text class="tick" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${esc(fmtCompact(v))}</text>`;
    })
    .join('');

  return `<figure class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" width="100%" preserveAspectRatio="xMidYMid meet" aria-label="${esc(valueLabel)} over time">
      ${yTicks}
      ${bars}
      <line class="axis" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"/>
    </svg>
  </figure>`;
}

// ---------------------------------------------------------------------------
// Hour-of-day bars (24 bars, when work actually happens across the day)
// ---------------------------------------------------------------------------
export function hourOfDayChart(hours, { width = 860, height = 200, businessStart = 9, businessEnd = 17 } = {}) {
  if (!hours.length) return '<p class="muted">No data.</p>';
  const padL = 46;
  const padR = 10;
  const padT = 14;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const max = Math.max(...hours.map((h) => h.count)) || 1;
  const barW = plotW / hours.length - 3;
  const sy = (v) => padT + plotH - (v / max) * plotH;
  const pad2 = (n) => String(n).padStart(2, '0');

  const bars = hours
    .map((h, i) => {
      const x = padL + i * (plotW / hours.length);
      const barH = Math.max(0.5, (h.count / max) * plotH);
      const business = h.hour >= businessStart && h.hour < businessEnd;
      return `<g>
        <rect class="${business ? 'bar-a' : 'bar-b'}" x="${x.toFixed(2)}" y="${sy(h.count).toFixed(1)}" width="${barW.toFixed(2)}" height="${barH.toFixed(1)}" rx="2"><title>${pad2(h.hour)}:00 &ndash; ${fmtCompact(h.count)} tool/message events (${h.pct.toFixed(1)}%)</title></rect>
        <text class="tick" x="${(x + barW / 2).toFixed(1)}" y="${padT + plotH + 14}" text-anchor="middle">${h.hour % 3 === 0 ? h.hour : ''}</text>
      </g>`;
    })
    .join('');

  return `<figure class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" width="100%" preserveAspectRatio="xMidYMid meet" aria-label="Activity by hour of day">
      ${bars}
      <line class="axis" x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"/>
    </svg>
    <div class="legend">
      <span class="legend-item"><span class="swatch" style="background:var(--series-1)"></span>Business hours (${pad2(businessStart)}:00&ndash;${pad2(businessEnd)}:00)</span>
      <span class="legend-item"><span class="swatch" style="background:var(--series-2)"></span>Outside business hours</span>
    </div>
  </figure>`;
}

// ---------------------------------------------------------------------------
// Waterfall (where the saving came from)
// ---------------------------------------------------------------------------
// Steps are signed contributions in USD-per-request. Diverging encoding: one hue per direction plus
// neutral endpoints, which is the correct job here (polarity, not identity).
export function waterfallChart(start, steps, end, { width = 860, height = 250, fmt = fmtUsd } = {}) {
  const padL = 8;
  const padR = 8;
  const padT = 26;
  const padB = 62;
  const cols = steps.length + 2;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const colW = plotW / cols;
  const barW = Math.min(78, colW * 0.56);

  // Track the running total so each floating bar sits at the right height.
  let running = start;
  const nodes = [{ label: 'Baseline', from: 0, to: start, kind: 'total' }];
  for (const s of steps) {
    const from = running;
    running += s.value;
    nodes.push({ label: s.label, from, to: running, kind: s.value <= 0 ? 'down' : 'up', value: s.value });
  }
  nodes.push({ label: 'After changes', from: 0, to: end, kind: 'total' });

  const maxVal = Math.max(start, end, ...nodes.map((n) => Math.max(n.from, n.to))) * 1.1 || 1;
  const sy = (v) => padT + plotH - (v / maxVal) * plotH;

  const body = nodes
    .map((n, i) => {
      const cx = padL + colW * i + colW / 2;
      const x = cx - barW / 2;
      const yTop = sy(Math.max(n.from, n.to));
      const h = Math.max(2, Math.abs(sy(n.from) - sy(n.to)));
      const cls = n.kind === 'total' ? 'wf-total' : n.kind === 'down' ? 'wf-down' : 'wf-up';
      const valText = n.kind === 'total' ? fmt(n.to, { precise: true }) : `${n.value > 0 ? '+' : ''}${fmt(n.value, { precise: true })}`;
      const connector =
        i < nodes.length - 1
          ? `<line class="wf-connector" x1="${(cx + barW / 2).toFixed(1)}" y1="${sy(n.to).toFixed(1)}" x2="${(padL + colW * (i + 1) + colW / 2 - barW / 2).toFixed(1)}" y2="${sy(n.to).toFixed(1)}"/>`
          : '';
      // Wrap long step labels onto two lines rather than letting them collide.
      const words = String(n.label).split(' ');
      const mid = Math.ceil(words.length / 2);
      const l1 = words.length > 2 ? words.slice(0, mid).join(' ') : n.label;
      const l2 = words.length > 2 ? words.slice(mid).join(' ') : '';
      return `<g>
        ${connector}
        <rect class="${cls}" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${esc(n.label)}: ${esc(valText)}</title></rect>
        <text class="wf-val" x="${cx.toFixed(1)}" y="${(yTop - 7).toFixed(1)}" text-anchor="middle">${esc(valText)}</text>
        <text class="tick" x="${cx.toFixed(1)}" y="${padT + plotH + 18}" text-anchor="middle">${esc(l1)}</text>
        ${l2 ? `<text class="tick" x="${cx.toFixed(1)}" y="${padT + plotH + 31}" text-anchor="middle">${esc(l2)}</text>` : ''}
      </g>`;
    })
    .join('');

  return `<figure class="chart">
    <svg viewBox="0 0 ${width} ${height}" role="img" width="100%" preserveAspectRatio="xMidYMid meet" aria-label="Decomposition of the change in cost per request">
      <line class="axis" x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}"/>
      ${body}
    </svg>
  </figure>`;
}
