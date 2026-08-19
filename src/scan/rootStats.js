import fs from 'node:fs';
import path from 'node:path';

// Reads the two files Claude Code itself maintains at the root of ~/.claude, alongside (not part
// of) the transcript corpus this tool otherwise scans. Both persist across the ~30-day transcript
// rotation window described in scan/walker.js, so they are the only source for usage history older
// than that - stats-cache.json's firstSessionDate routinely predates every transcript still on disk.
// Read-only and best-effort: a missing or corrupt file degrades to null rather than failing the run,
// since this data lives outside this tool's control and its shape is not contractual.

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
//   hourCounts: { [hour 0-23]: count }
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
    hourCounts: data.hourCounts && typeof data.hourCounts === 'object' ? data.hourCounts : {},
  };
}

// Shape: a map of PR URL -> { number, title, state, checks, review, additions, deletions }. This is
// gh's own PR-status poll cache (used elsewhere for status-line PR badges), keyed by URL rather than
// scoped to a repo, so it naturally spans every repo Claude Code has touched.
export function readGhPrCache(claudeDir) {
  const data = readJson(path.join(claudeDir, 'gh-pr-status-cache.json'));
  if (!data || typeof data !== 'object') return null;
  return Object.entries(data)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([url, v]) => ({
      url,
      number: v.number ?? null,
      title: v.title ?? null,
      state: v.state ?? 'UNKNOWN',
      review: v.review ?? null,
      additions: typeof v.additions === 'number' ? v.additions : 0,
      deletions: typeof v.deletions === 'number' ? v.deletions : 0,
      checks: v.checks ?? null,
    }));
}
