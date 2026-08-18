// Turns the raw comparison numbers into plain-English findings.
//
// The design goal is that somebody who has never heard of a percentile or a Mann-Whitney U test can
// open the report and correctly answer one question: "did the change I made to my setup actually
// reduce what Claude Code costs me, and how do I know?"
//
// Every finding carries a `meaning` - not what the number is, but what it tells you and what you'd
// do about it.

import { contextTokens, cacheHitRate, estimateCostByModel, mixAdjustedCostPerRequest, priceFor } from './cost.js';

const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

function pctChange(from, to) {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  if (from === 0) return to === 0 ? 0 : null;
  return ((to - from) / Math.abs(from)) * 100;
}

function safeDiv(a, b) {
  return b ? a / b : null;
}

// Per-token $ rate for each token class, for one specific model.
function ratesForModel(model) {
  const price = priceFor(model) ?? { input: 5, output: 25 };
  const input = price.input / 1e6;
  return {
    inputTokens: input,
    outputTokens: price.output / 1e6,
    cacheCreationTokens: input * CACHE_WRITE_MULTIPLIER,
    cacheReadTokens: input * CACHE_READ_MULTIPLIER,
  };
}

// Per-request token counts by class, plus the derived aggregates the report headlines.
export function perRequestProfile(totals, requests, byModel) {
  const t = totals;
  const costing = estimateCostByModel(byModel);
  return {
    requests,
    cost: costing.total,
    costPerRequest: safeDiv(costing.total, requests),
    perModel: costing.perModel,
    unpricedRequests: costing.unpricedRequests,
    tokensPerRequest: safeDiv(t.total, requests),
    contextPerRequest: safeDiv(contextTokens(t), requests),
    outputPerRequest: safeDiv(t.outputTokens, requests),
    cacheHitRate: cacheHitRate(t),
    classPerRequest: {
      inputTokens: safeDiv(t.inputTokens, requests),
      outputTokens: safeDiv(t.outputTokens, requests),
      cacheCreationTokens: safeDiv(t.cacheCreationTokens, requests),
      cacheReadTokens: safeDiv(t.cacheReadTokens, requests),
    },
  };
}

// Exact additive decomposition of the change in cost per request, as a model-level shift-share.
//
// Writing cost per request as C = SUM_m (share_m x costPerRequest_m), the change splits into three
// exact terms:
//
//   mix         SUM_m (d share_m) x costPerRequest_m^base   - running work on a different blend
//   efficiency  SUM_m share_m^base x (d costPerRequest_m)   - each model doing the same work cheaper
//   interaction SUM_m (d share_m) x (d costPerRequest_m)    - the cross term
//
// The efficiency term is further split by token class using each model's OWN rates, which is what
// makes the buckets trustworthy: a saving is only ever credited to "less context" if that model
// genuinely carried less context, never because the work moved to a cheaper model.
//
// Mix and interaction are reported together, because separately they are large and opposite (moving
// work to a cheap model shows up as a big negative mix term and a big positive interaction term) and
// quoting either alone badly misstates how much the model switch was really worth. Their sum is the
// honest answer, and it agrees exactly with mixAdjustedCostPerRequest() by construction.
//
// A model seen on only one side has no measurable efficiency change, so it contributes to mix alone -
// an unmeasurable model can never be credited as an efficiency win.
export function decomposeCostChange(base, comp) {
  if (base.costPerRequest === null || comp.costPerRequest === null) return null;
  const baseReq = base.perModel.reduce((a, m) => a + m.requests, 0);
  if (!baseReq) return null;

  const compByModel = new Map(comp.perModel.map((m) => [m.model, m]));
  const classes = ['cacheReadTokens', 'cacheCreationTokens', 'inputTokens', 'outputTokens'];
  const efficiency = Object.fromEntries(classes.map((c) => [c, 0]));

  for (const b of base.perModel) {
    const c = compByModel.get(b.model);
    if (!c || !b.requests || !c.requests) continue; // only-one-side: falls through to the mix bucket
    const shareBase = b.requests / baseReq;
    const rates = ratesForModel(b.model);
    for (const cls of classes) {
      const qBase = b.tokens[cls] / b.requests;
      const qComp = c.tokens[cls] / c.requests;
      efficiency[cls] += shareBase * (qComp - qBase) * rates[cls];
    }
  }

  const actualDelta = comp.costPerRequest - base.costPerRequest;
  const efficiencyTotal = classes.reduce((a, c) => a + efficiency[c], 0);
  const mixAndInteraction = actualDelta - efficiencyTotal;

  return {
    start: base.costPerRequest,
    end: comp.costPerRequest,
    actualDelta,
    efficiencyTotal,
    mixAndInteraction,
    steps: [
      {
        key: 'contextReRead',
        label: 'Context re-read',
        value: efficiency.cacheReadTokens,
        meaning:
          'The conversation and setup Claude re-reads on every single request, served from cache at a tenth of the price. Shrinks when your CLAUDE.md, always-on tools and skills get leaner, or when sessions stay shorter.',
      },
      {
        key: 'freshContext',
        label: 'Fresh context',
        value: efficiency.cacheCreationTokens + efficiency.inputTokens,
        meaning:
          'New material written into the cache, plus anything read at full price. Rises when your prompt prefix keeps changing and the cache has to be rebuilt.',
      },
      {
        key: 'outputLength',
        label: 'Reply length',
        value: efficiency.outputTokens,
        meaning:
          'What Claude writes back. The most expensive token class per token, so verbosity costs more than it looks. Falls when you ask for terser output or lower reasoning effort.',
      },
      {
        key: 'modelMix',
        label: 'Model mix',
        value: mixAndInteraction,
        meaning:
          'The net effect of running your work on a different blend of models. This is NOT an efficiency gain - it is what the model switch alone was worth, even if nothing else had changed.',
      },
    ],
  };
}

// How far the split of work across models moved, as total variation distance in percentage points.
// A large move means the two windows are not really like-for-like workloads.
export function modelMixShift(basePerModel, compPerModel) {
  const bReq = basePerModel.reduce((a, m) => a + m.requests, 0);
  const cReq = compPerModel.reduce((a, m) => a + m.requests, 0);
  if (!bReq || !cReq) return null;
  const keys = new Set([...basePerModel.map((m) => m.model), ...compPerModel.map((m) => m.model)]);
  const bMap = new Map(basePerModel.map((m) => [m.model, m.requests / bReq]));
  const cMap = new Map(compPerModel.map((m) => [m.model, m.requests / cReq]));
  let tvd = 0;
  const rows = [];
  for (const k of keys) {
    const b = bMap.get(k) ?? 0;
    const c = cMap.get(k) ?? 0;
    tvd += Math.abs(c - b);
    rows.push({ model: k, baselineShare: b, compareShare: c, deltaPoints: (c - b) * 100 });
  }
  rows.sort((a, b) => Math.abs(b.deltaPoints) - Math.abs(a.deltaPoints));
  return { tvdPoints: (tvd / 2) * 100, rows };
}

function significanceEnglish(mw) {
  if (!mw) return null;
  if (mw.skipped) {
    return {
      status: 'warn',
      short: 'Not enough data to be sure',
      text: `There were too few requests on one side to run a proper test (${mw.reason}). Treat the direction as a hint, not a result - collect more activity before drawing a conclusion.`,
    };
  }
  if (mw.pValue < 0.05) {
    const strength =
      Math.abs(mw.rankBiserial) >= 0.5
        ? 'a large, unmistakable shift'
        : Math.abs(mw.rankBiserial) >= 0.3
          ? 'a moderate shift'
          : 'a small but consistent shift';
    // Quote the odds only while they stay meaningful to a reader. Past a millionth, an exact figure
    // is spurious precision - "vanishingly unlikely" is both truer and easier to act on.
    const odds =
      mw.pValue < 1e-6
        ? 'the chance of seeing it by luck alone is vanishingly small'
        : `roughly a 1-in-${Math.max(2, Math.round(1 / mw.pValue)).toLocaleString('en-US')} chance of seeing it by luck alone`;
    return {
      status: 'good',
      short: 'Real change, not noise',
      text: `Comparing ${mw.n1.toLocaleString('en-US')} baseline requests against ${mw.n2.toLocaleString('en-US')} new ones, this is ${strength} that is very unlikely to be normal day-to-day variation - ${odds}.`,
    };
  }
  return {
    status: 'warn',
    short: 'Could still be normal variation',
    text: `The difference is within the range you would expect from ordinary week-to-week variation (${mw.n1.toLocaleString('en-US')} vs ${mw.n2.toLocaleString('en-US')} requests). Do not bank this one yet.`,
  };
}

const KPI_MEANINGS = {
  costPerRequest:
    'The single number to watch. What one request to Claude costs on average, weighted by what each kind of token actually costs. Everything else on this page is an explanation of this line.',
  contextPerRequest:
    'How much conversation and setup Claude has to re-read before it can answer anything. This is the number your setup most directly controls - CLAUDE.md size, how many MCP servers and skills load, how much tool output you keep in context, and how long you let sessions run.',
  outputPerRequest:
    'How much Claude writes back per request. Output is the priciest token class, so trimming verbosity or dropping reasoning effort shows up here first.',
  cacheHitRate:
    'The share of re-read context that came from cache at a tenth of the price, instead of being paid for in full. This should sit very high. A fall means something is changing near the start of your prompt and forcing the cache to be rebuilt.',
  tokensPerRequest:
    'Raw token count with every class weighted the same. Shown for continuity only - it is roughly 96% cache reads, so it understates changes that matter and overstates ones that do not. Prefer cost per request.',
};

// Builds the ordered list of headline findings for a compare report.
export function buildInsights({ base, comp, comparison, decomposition, baseCompaction, compCompaction, baseToolPayload, compToolPayload }) {
  const findings = [];

  const costDelta = pctChange(base.costPerRequest, comp.costPerRequest);
  const contextDelta = pctChange(base.contextPerRequest, comp.contextPerRequest);
  const outputDelta = pctChange(base.outputPerRequest, comp.outputPerRequest);
  const cacheDelta =
    base.cacheHitRate !== null && comp.cacheHitRate !== null ? (comp.cacheHitRate - base.cacheHitRate) * 100 : null;

  const mix = modelMixShift(base.perModel, comp.perModel);
  const adjusted = mixAdjustedCostPerRequest(base.perModel, comp.perModel);
  const adjustedDelta = adjusted ? pctChange(adjusted.baselineWeighted, adjusted.adjustedWeighted) : null;

  if (costDelta !== null) {
    const better = costDelta < 0;
    findings.push({
      status: Math.abs(costDelta) < 2 ? 'neutral' : better ? 'good' : 'bad',
      title: better
        ? `A typical request now costs ${Math.abs(costDelta).toFixed(0)}% less`
        : `A typical request now costs ${Math.abs(costDelta).toFixed(0)}% more`,
      meaning: better
        ? `Doing the same amount of work costs about ${Math.abs(costDelta).toFixed(0)}% less than it did at baseline. At the volume in your baseline window, that rate would have saved roughly ${usd(base.requests * (base.costPerRequest - comp.costPerRequest))}.`
        : `The same amount of work now costs about ${Math.abs(costDelta).toFixed(0)}% more than at baseline. Something added to your setup, or your sessions are running longer before they reset.`,
    });
  }

  if (adjustedDelta !== null && costDelta !== null) {
    const mixPortion = costDelta - adjustedDelta;
    const mixIsMaterial = Math.abs(mixPortion) >= 2;
    findings.push({
      status: mixIsMaterial ? 'warn' : 'good',
      title: mixIsMaterial
        ? `${Math.abs(mixPortion).toFixed(0)} of those ${Math.abs(costDelta).toFixed(0)} points came from changing models, not efficiency`
        : `The saving is genuine efficiency, not a cheaper-model effect`,
      meaning: mixIsMaterial
        ? `Holding the split of work across models exactly as it was at baseline, the change is ${fmtSigned(adjustedDelta)} rather than ${fmtSigned(costDelta)}. The rest is explained by running more (or less) of your work on cheaper models - worth doing, but it is a different lever from making your setup leaner.`
        : `Holding the split of work across models exactly as it was at baseline still gives ${fmtSigned(adjustedDelta)}, essentially the same as the headline ${fmtSigned(costDelta)}. So this is not just an artefact of running more work on a cheaper model.`,
    });
  }

  if (contextDelta !== null) {
    const better = contextDelta < 0;
    findings.push({
      status: Math.abs(contextDelta) < 2 ? 'neutral' : better ? 'good' : 'bad',
      title: better
        ? `Claude re-reads ${Math.abs(contextDelta).toFixed(0)}% less context per request`
        : `Claude re-reads ${Math.abs(contextDelta).toFixed(0)}% more context per request`,
      meaning: `Average context carried per request went from ${Math.round(base.contextPerRequest).toLocaleString('en-US')} to ${Math.round(comp.contextPerRequest).toLocaleString('en-US')} tokens. ${
        better
          ? 'This is the clearest evidence a setup change worked: there is simply less material being dragged into every single call.'
          : 'Something is being loaded into context that was not there before - check newly added CLAUDE.md content, MCP servers, always-on skills, or large tool outputs.'
      }`,
    });
  }

  if (outputDelta !== null && Math.abs(outputDelta) >= 3) {
    const better = outputDelta < 0;
    // The aggregate can disagree with the like-for-like view: if work moved to a model that
    // answers more briefly, replies look shorter overall even though every individual model got
    // more verbose. The decomposition's reply-length term is computed per model, so it is the
    // honest signal - say so plainly rather than reporting a mix artefact as a win.
    const likeForLike = decomposition?.steps.find((x) => x.key === 'outputLength')?.value ?? null;
    const contradicts = likeForLike !== null && (likeForLike > 0) === better && Math.abs(likeForLike) > 1e-6;
    findings.push({
      status: contradicts ? 'warn' : better ? 'good' : 'warn',
      title: contradicts
        ? `Replies look ${Math.abs(outputDelta).toFixed(0)}% shorter, but only because the work moved models`
        : better
          ? `Replies got ${Math.abs(outputDelta).toFixed(0)}% shorter`
          : `Replies got ${Math.abs(outputDelta).toFixed(0)}% longer`,
      meaning: contradicts
        ? `Average output fell from ${Math.round(base.outputPerRequest).toLocaleString('en-US')} to ${Math.round(comp.outputPerRequest).toLocaleString('en-US')} tokens per request, but comparing each model only against itself, reply length actually went the other way and added ${usd(likeForLike)} per request. The overall drop comes from running more work on a model that answers more briefly, not from Claude becoming less verbose. If shorter replies were one of your goals, this one has not landed yet.`
        : `Average output went from ${Math.round(base.outputPerRequest).toLocaleString('en-US')} to ${Math.round(comp.outputPerRequest).toLocaleString('en-US')} tokens per request. Output is the most expensive token class, so this moves cost more than the token count suggests.`,
    });
  }

  if (cacheDelta !== null && Math.abs(cacheDelta) >= 0.5) {
    const better = cacheDelta > 0;
    findings.push({
      status: better ? 'good' : 'warn',
      title: better
        ? `Cache is working ${cacheDelta.toFixed(1)} points harder`
        : `Cache hit rate slipped ${Math.abs(cacheDelta).toFixed(1)} points`,
      meaning: `${(base.cacheHitRate * 100).toFixed(1)}% of re-read context came from cache at baseline, versus ${(comp.cacheHitRate * 100).toFixed(1)}% now. ${
        better
          ? 'More of your context is being served at a tenth of the price.'
          : 'A slip usually means something near the start of your prompt is changing between requests and invalidating the cached prefix - a timestamp, a rotating tool list, or newly reordered setup content.'
      }`,
    });
  }

  // Per-model regressions hide inside a good headline: an overall win can conceal one model getting
  // materially worse. Only flag models with enough traffic on both sides to mean anything.
  const compByModel = new Map(comp.perModel.map((m) => [m.model, m]));
  for (const b of base.perModel) {
    const c = compByModel.get(b.model);
    if (!c || c.requests < 30 || b.requests < 30) continue;
    const d = pctChange(b.costPerRequest, c.costPerRequest);
    if (d !== null && d > 10) {
      findings.push({
        status: 'warn',
        title: `${b.model} got ${d.toFixed(0)}% more expensive per request`,
        meaning: `Every other model may have improved, but work running on ${b.model} costs more per request than it did (${usd(b.costPerRequest)} to ${usd(c.costPerRequest)}). Since the overall headline is an average, a regression like this can hide inside a good result. Check whether the kind of work you send to this model changed.`,
      });
    }
  }

  // Compaction rate: how often a session ran out of room. Normalized per 1,000 requests so the two
  // windows are comparable despite very different sizes.
  const baseCompactionRate = safeDiv(baseCompaction?.count ?? 0, base.requests / 1000);
  const compCompactionRate = safeDiv(compCompaction?.count ?? 0, comp.requests / 1000);
  if (baseCompactionRate !== null && compCompactionRate !== null && (baseCompaction?.count ?? 0) + (compCompaction?.count ?? 0) >= 5) {
    const d = pctChange(baseCompactionRate, compCompactionRate);
    if (d !== null && Math.abs(d) >= 15) {
      const better = d < 0;
      findings.push({
        status: better ? 'good' : 'warn',
        title: better ? 'You are hitting the context limit less often' : 'You are hitting the context limit more often',
        meaning: `Compactions per 1,000 requests went from ${baseCompactionRate.toFixed(1)} to ${compCompactionRate.toFixed(1)}. Every compaction means a session filled up and had to be summarized - it costs tokens and loses detail, so fewer is better.`,
      });
    }
  }

  // Tool output is a direct, actionable lever and is fully attributable in the existing data.
  const baseToolBytes = (baseToolPayload ?? []).reduce((a, t) => a + t.totalBytes, 0);
  const compToolBytes = (compToolPayload ?? []).reduce((a, t) => a + t.totalBytes, 0);
  const baseToolPerReq = safeDiv(baseToolBytes, base.requests);
  const compToolPerReq = safeDiv(compToolBytes, comp.requests);
  if (baseToolPerReq && compToolPerReq) {
    const d = pctChange(baseToolPerReq, compToolPerReq);
    if (d !== null && Math.abs(d) >= 10) {
      const better = d < 0;
      findings.push({
        status: better ? 'good' : 'warn',
        title: better
          ? `Tool results are feeding ${Math.abs(d).toFixed(0)}% fewer bytes into context`
          : `Tool results are feeding ${Math.abs(d).toFixed(0)}% more bytes into context`,
        meaning: `Tool output per request went from ${Math.round(baseToolPerReq).toLocaleString('en-US')} to ${Math.round(compToolPerReq).toLocaleString('en-US')} bytes. Everything a tool returns stays in context for the rest of the session, so large file reads and unfiltered command output compound.`,
      });
    }
  }

  const significance = significanceEnglish(comparison?.distributions?.tokensPerRequest?.mannWhitney);

  return {
    findings,
    significance,
    mix,
    adjustedDelta,
    deltas: { costDelta, contextDelta, outputDelta, cacheDelta },
    kpis: [
      kpi('Cost per request', base.costPerRequest, comp.costPerRequest, usd, true, KPI_MEANINGS.costPerRequest),
      kpi('Context re-read per request', base.contextPerRequest, comp.contextPerRequest, tok, true, KPI_MEANINGS.contextPerRequest),
      outputKpi(base, comp, decomposition),
      // Null-safe: a window with no context tokens at all has no hit rate. Multiplying null by 100
      // would silently yield 0 and render as a false "-100%" regression.
      kpi('Cache hit rate', asPercent(base.cacheHitRate), asPercent(comp.cacheHitRate), (v) => (v === null ? 'n/a' : `${v.toFixed(1)}%`), false, KPI_MEANINGS.cacheHitRate),
      kpi('Raw tokens per request', base.tokensPerRequest, comp.tokensPerRequest, tok, true, KPI_MEANINGS.tokensPerRequest),
    ],
  };
}

// The aggregate output figure and its per-model equivalent can disagree when work moves between
// models. When they do, the card must not show a green "Improved" while the finding above it
// explains that the drop is a mix artefact.
function outputKpi(base, comp, decomposition) {
  const card = kpi('Output per request', base.outputPerRequest, comp.outputPerRequest, tok, true, KPI_MEANINGS.outputPerRequest);
  const likeForLike = decomposition?.steps.find((x) => x.key === 'outputLength')?.value ?? null;
  const improvedOverall = card.pctChange !== null && card.pctChange < 0;
  if (likeForLike !== null && likeForLike > 1e-6 && improvedOverall) {
    card.status = 'warn';
    card.meaning += ' Note: this drop comes from work moving to a model that answers more briefly. Compared model-for-model, reply length actually rose.';
  }
  return card;
}

function kpi(label, baseline, compare, fmt, lowerIsBetter, meaning) {
  const pct = pctChange(baseline, compare);
  const improved = pct === null ? null : lowerIsBetter ? pct < 0 : pct > 0;
  return {
    label,
    baseline,
    compare,
    baselineText: fmt(baseline),
    compareText: fmt(compare),
    pctChange: pct,
    lowerIsBetter,
    status: pct === null || Math.abs(pct) < 2 ? 'neutral' : improved ? 'good' : 'bad',
    meaning,
  };
}

function asPercent(fraction) {
  return fraction === null || fraction === undefined ? null : fraction * 100;
}

function usd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  if (Math.abs(n) < 1) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1000) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function tok(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return `${Math.round(n).toLocaleString('en-US')}`;
}

function fmtSigned(p) {
  if (p === null || p === undefined) return 'n/a';
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
}

export { pctChange, significanceEnglish };
