// Rate/ratio normalization helpers. Cumulative totals must never be compared directly across windows
// of different length (a 30-day baseline vs a 3-day compare) - always normalize to a rate first.

export function totalTokensOf(record) {
  const u = record.usage;
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

// tokens-per-request distribution: one value per request, no grouping needed.
export function tokensPerRequest(records) {
  return records.map(totalTokensOf);
}

export function groupSum(records, keyFn, valueFn) {
  const groups = new Map();
  for (const r of records) {
    const key = keyFn(r);
    groups.set(key, (groups.get(key) || 0) + valueFn(r));
  }
  return groups;
}

// tokens-per-session distribution: sum tokens within each sessionId, one value per session.
export function tokensPerSession(records) {
  const groups = groupSum(records, (r) => r.sessionId, totalTokensOf);
  return [...groups.values()];
}

// tokens-per-active-hour distribution: bucket by wall-clock hour (only hours with >=1 request count),
// sum tokens per bucket, one value per active hour.
export function tokensPerActiveHour(records) {
  const groups = groupSum(
    records,
    (r) => {
      const d = new Date(r.timestamp);
      return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
    },
    totalTokensOf
  );
  return [...groups.values()];
}

export function requestCountByTier(records) {
  const groups = new Map();
  for (const r of records) {
    groups.set(r.tier, (groups.get(r.tier) || 0) + 1);
  }
  return groups;
}
