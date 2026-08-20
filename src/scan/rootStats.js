import fs from 'node:fs';
import path from 'node:path';

// Reads stats-cache.json, which Claude Code itself maintains at the root of ~/.claude, alongside
// (not part of) the transcript corpus this tool otherwise scans. It persists across the ~30-day
// transcript rotation window described in scan/walker.js, so it is the only source for usage history
// older than that - its firstSessionDate routinely predates every transcript still on disk.
// Read-only and best-effort: a missing or corrupt file degrades to null rather than failing the run,
// since this data lives outside this tool's control and its shape is not contractual.
//
// gh-pr-status-cache.json was read here too, but was removed: it turned out to be a small rolling
// status-poll cache (whatever PRs the status line last checked), not a ledger, so PR counts read from
// it silently understated real history rather than merely approximating it.

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Shape (Claude Code's own usage cache, version 4 observed):
//   dailyActivity: [{ date, messageCount, sessionCount, toolCallCount }]
//   dailyModelTokens: [{ date, tokensByModel: { [model]: tokens } }]
//   modelUsage: { [model]: { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, ... } }
//   totalSessions, totalMessages, firstSessionDate, lastComputedDate
//   longestSession: { sessionId, duration (ms), messageCount, timestamp }
//
// Also carries an hourCounts field, deliberately not read here: an audit against real data proved it
// is a per-session-start histogram (sum(hourCounts) === totalSessions, exactly), not an activity
// histogram, so it cannot answer "what hour did work happen" - see report/activityMetrics.js, which
// computes that instead from live transcript timestamps.
export function readStatsCache(claudeDir) {
  const data = readJson(path.join(claudeDir, 'stats-cache.json'));
  if (!data || typeof data !== 'object') return null;
  return {
    lastComputedDate: data.lastComputedDate ?? null,
    dailyActivity: Array.isArray(data.dailyActivity) ? data.dailyActivity : [],
    dailyModelTokens: Array.isArray(data.dailyModelTokens) ? data.dailyModelTokens : [],
    modelUsage: data.modelUsage && typeof data.modelUsage === 'object' ? data.modelUsage : {},
    totalSessions: typeof data.totalSessions === 'number' ? data.totalSessions : null,
    totalMessages: typeof data.totalMessages === 'number' ? data.totalMessages : null,
    firstSessionDate: data.firstSessionDate ?? null,
    longestSession: data.longestSession ?? null,
  };
}
