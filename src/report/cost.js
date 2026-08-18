// Cost weighting for token counts.
//
// Why this exists: raw token totals are dominated by cache reads (typically >95% of every count in
// this corpus), and a cache-read token costs a tenth of an input token. Summing the four token
// classes with equal weight therefore produces a "total" that is ~95% driven by the cheapest thing
// you buy, which makes it useless as an efficiency signal. Everything user-facing should be weighted.
//
// IMPORTANT - the price table is deliberately a frozen constant, not a live lookup. A baseline and a
// compare must be priced with the SAME table or the delta between them measures Anthropic's pricing
// changes rather than your own efficiency. Bump PRICE_TABLE_VERSION when you change a rate, and
// re-baseline afterwards.

export const PRICE_TABLE_VERSION = '2026-06-24';

// USD per 1,000,000 tokens, published Claude API list rates.
// Cache multipliers are relative to the model's own input rate.
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute TTL. 1h TTL is 2x, but transcripts don't break it out.
const CACHE_READ_MULTIPLIER = 0.1;

const PRICES = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  // Sonnet 5 carries a promotional $2/$10 rate through 2026-08-31. We deliberately price at the
  // standard rate: a price that changes partway through the measurement period would show up as a
  // fake efficiency gain (or loss) on the day the promo ends.
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// Unknown/unmapped models are priced at the Opus tier so a costing gap shows up as an over-estimate
// rather than silently vanishing. Every such record is counted so the report can disclose it.
const FALLBACK_PRICE = { input: 5, output: 25 };

// Claude Code writes dated model ids for some models (e.g. claude-haiku-4-5-20251001). Strip a
// trailing -YYYYMMDD so those still price correctly.
function normalizeModelId(model) {
  if (!model) return null;
  return String(model).replace(/-\d{8}$/, '');
}

export function priceFor(model) {
  const key = normalizeModelId(model);
  return PRICES[key] ?? null;
}

export function isPricedModel(model) {
  return priceFor(model) !== null;
}

// Estimated USD for one bundle of token-class counts attributed to a single model.
export function estimateCost(model, tokens) {
  const price = priceFor(model) ?? FALLBACK_PRICE;
  const inRate = price.input / 1e6;
  const outRate = price.output / 1e6;
  return (
    tokens.inputTokens * inRate +
    tokens.outputTokens * outRate +
    tokens.cacheCreationTokens * inRate * CACHE_WRITE_MULTIPLIER +
    tokens.cacheReadTokens * inRate * CACHE_READ_MULTIPLIER
  );
}

// Total estimated USD across a byModel-shaped array ([{ key, requests, tokens }]). Also reports how
// much of the spend had to fall back to an assumed price, so the HTML can disclose it.
export function estimateCostByModel(byModel) {
  let total = 0;
  let unpricedRequests = 0;
  const perModel = [];
  for (const row of byModel) {
    const cost = estimateCost(row.key, row.tokens);
    const priced = isPricedModel(row.key);
    if (!priced) unpricedRequests += row.requests;
    total += cost;
    perModel.push({
      model: row.key,
      requests: row.requests,
      tokens: row.tokens,
      cost,
      costPerRequest: row.requests ? cost / row.requests : null,
      tokensPerRequest: row.requests ? row.tokens.total / row.requests : null,
      priced,
    });
  }
  perModel.sort((a, b) => b.cost - a.cost);
  return { total, perModel, unpricedRequests };
}

// "Context tokens" = everything Claude had to re-read to answer, regardless of how it was billed.
// This is the number your setup (CLAUDE.md, MCP servers, always-on skills, tool output size) most
// directly controls, so it is the headline diagnostic for a setup change.
export function contextTokens(tokens) {
  return tokens.inputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
}

// Share of re-read context that was served from cache at 1/10th price. Near-1 is normal and good;
// a drop means something is invalidating the cached prefix.
export function cacheHitRate(tokens) {
  const ctx = contextTokens(tokens);
  return ctx ? tokens.cacheReadTokens / ctx : null;
}

// Mix-adjusted cost per request: what the compare window WOULD have cost per request if the split of
// work across models had stayed exactly as it was at baseline. Comparing this against the baseline's
// own cost per request isolates genuine efficiency from "we just ran more work on a cheaper model".
// Models absent from the compare window keep their baseline rate (no evidence they changed).
export function mixAdjustedCostPerRequest(baselinePerModel, comparePerModel) {
  const compareByModel = new Map(comparePerModel.map((m) => [m.model, m]));
  const baselineRequests = baselinePerModel.reduce((acc, m) => acc + m.requests, 0);
  if (!baselineRequests) return null;

  let baselineWeighted = 0;
  let adjustedWeighted = 0;
  for (const b of baselinePerModel) {
    if (b.costPerRequest === null) continue;
    const share = b.requests / baselineRequests;
    const c = compareByModel.get(b.model);
    baselineWeighted += share * b.costPerRequest;
    adjustedWeighted += share * (c && c.costPerRequest !== null ? c.costPerRequest : b.costPerRequest);
  }
  return { baselineWeighted, adjustedWeighted };
}

export const COST_MODEL_NOTES = {
  cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER,
  cacheReadMultiplier: CACHE_READ_MULTIPLIER,
  priceTableVersion: PRICE_TABLE_VERSION,
};
