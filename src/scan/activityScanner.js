import fs from 'node:fs';
import { walkTranscriptFiles } from './walker.js';
import { readLinesFrom } from './jsonlReader.js';
import { verbose } from '../util/log.js';

// Independent, read-only pass over the same transcript corpus scanner.js reads, but for a different
// question: not "what did requests cost", but "what did you actually do" - commits, worktrees, lines
// written, sessions, agents spawned. Deliberately its own walk rather than a second consumer of
// scanCorpus()'s output: it shares no state with the baseline/compare cursor or dedupe machinery
// (state/cursor.js, scan/dedupe.js), so nothing --visualise does can perturb what --baseline/--compare
// see or persist. It also does not require a completed usage record (a message with token usage) the
// way recordParser.js does, so it sees tool calls scanner.js would ignore.
//
// This is a single unbounded read of every transcript on disk every run - there is no cursor to
// resume from, because there is no state.json entry for this mode to advance. On the corpus this was
// built against (~1,400 files) that is the same ballpark cost as a cumulative --compare.
//
// Deliberately does NOT track `gh pr` commands - it was tried and removed. Counting `gh pr create`
// invocations only sees PRs raised through the gh CLI, within whatever ~30-day window of transcripts
// is still on disk, and reporting that alongside the (also unreliable) gh-pr-status-cache.json count
// as "pull requests raised" was misleading rather than merely approximate. See activityMetrics.js.
//
// Also builds the raw material for two things stats-cache.json cannot be trusted for (confirmed by
// audit against real data, not assumed):
//   - hour-of-day / daily activity: stats-cache.json's hourCounts turned out to be a per-SESSION-START
//     histogram (sum(hourCounts) === totalSessions, exactly), not an activity histogram - an 8-day
//     unattended run and a 30-second session both contribute exactly 1. This scanner instead counts
//     two distinct kinds of event per line, bucketed by local hour and by UTC calendar date:
//       "claude working"  - any assistant turn, or any user-role line carrying a tool_result (a tool
//                            round-trip), across every tier (main/subagent/workflow-agent) - this is
//                            what actually shows Claude active overnight/unattended.
//       "human prompt"     - a genuine human-authored user line (content is a plain string, or an
//                            array with no tool_result block), counted only in 'main' tier files -
//                            a subagent's opening "user" line is its parent's injected task text, not
//                            something a human typed, so subagent/workflow-agent tiers never count here.
//   - token/model totals: stats-cache.json's modelUsage is frozen as of lastComputedDate and does not
//     update again until Claude Code itself recomputes it (observed 44+ days stale on the machine this
//     was built against, hiding newer models entirely). report/activityMetrics.js supplements the
//     cached totals with dailyModelTokens computed here for any date after lastComputedDate, so newer
//     models show up. messageId is deduped max-wins (same rationale as scan/dedupe.js: a usage snapshot
//     can fill in progressively across multiple lines sharing one message.id).

const BASH_PATTERNS = {
  gitCommit: /\bgit\s+(?:-\S+\s+)*commit\b/i,
  gitPush: /\bgit\s+(?:-\S+\s+)*push\b/i,
  gitWorktreeAdd: /\bgit\s+worktree\s+add\b/i,
  gitWorktreeRemove: /\bgit\s+worktree\s+remove\b/i,
};

// Sanitized project directory names replace path separators with '-', so a cwd ending in
// .claude/worktrees/<name> (or .claude\worktrees\<name>) always leaves this substring behind, even
// after the worktree itself has been removed - the project directory is the durable trace.
const WORKTREE_PROJECT_RE = /-claude-worktrees-([^/]+)$/;

function countLines(str) {
  if (typeof str !== 'string' || str.length === 0) return 0;
  return str.split('\n').length;
}

function bumpMap(map, key, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

// UTC calendar date for day-bucketing (dates, unlike hours, don't need local-time correction - a few
// hours of boundary drift doesn't change which day a burst of activity mostly belongs to).
function utcDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function bumpDaily(map, date, key, by = 1) {
  const row = map.get(date) ?? { claudeEvents: 0, humanPrompts: 0 };
  row[key] += by;
  map.set(date, row);
}

export async function scanActivity(claudeDir) {
  const sessions = new Map(); // sessionId -> { project, firstTs, lastTs, messageLines, toolCalls }
  const projects = new Set();
  const worktreeProjects = new Map(); // worktree label -> project name it appeared under
  const workflowRuns = new Set();
  const toolCallCounts = new Map(); // toolName -> calls
  const bashCounts = { gitCommit: 0, gitPush: 0, gitWorktreeAdd: 0, gitWorktreeRemove: 0 };
  let worktreesCreatedViaTool = 0;
  let worktreesEnteredViaTool = 0;
  const worktreeToolNames = new Set();
  let subagentFiles = 0;
  let workflowAgentFiles = 0;
  let linesWritten = 0; // Write tool: full file content
  let editLinesAdded = 0; // Edit tool: new_string line count (approximate, not a true diff)
  let editLinesRemoved = 0; // Edit tool: old_string line count
  let skillInvocations = 0;
  let filesScanned = 0;
  let oldestTs = null;
  let newestTs = null;

  // Hour-of-day, in LOCAL time (per the audit: stats-cache.json's own hour buckets correlate with
  // local hour, not UTC) - two independent 24-slot histograms, not one, so the report can show the
  // contrast between "Claude was working" and "you typed something" instead of conflating them.
  const hourClaudeWorking = new Array(24).fill(0);
  const hourHumanPrompts = new Array(24).fill(0);
  const dailyEvents = new Map(); // UTC date -> { claudeEvents, humanPrompts }
  const dailySessionsStarted = new Map(); // UTC date -> Set<sessionId>, main tier only

  // Per-model, per-day token totals, deduped max-wins by message.id (a usage snapshot can fill in
  // progressively across lines sharing one id - see scan/dedupe.js for the same rule applied to
  // --baseline/--compare). Only populated for real, priced turns: skips '<synthetic>' model ids and
  // lines with no usage at all, same exclusions recordParser.js applies for --baseline/--compare.
  const tokenDedup = new Map(); // messageId -> { date, model, tokens, total }

  for (const fileDesc of walkTranscriptFiles(claudeDir)) {
    try {
      fs.statSync(fileDesc.filePath);
    } catch {
      continue; // file disappeared between walk and stat - skip
    }

    projects.add(fileDesc.project);
    const wtMatch = WORKTREE_PROJECT_RE.exec(fileDesc.project);
    if (wtMatch) worktreeProjects.set(wtMatch[1], fileDesc.project);

    if (fileDesc.tier === 'subagent') subagentFiles += 1;
    if (fileDesc.tier === 'workflow-agent') {
      workflowAgentFiles += 1;
      if (fileDesc.runId) workflowRuns.add(fileDesc.runId);
    }

    const session = fileDesc.tier === 'main' ? getOrCreateSession(sessions, fileDesc.sessionId, fileDesc.project) : null;

    for await (const { line } of readLinesFrom(fileDesc.filePath, 0)) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      const tsValid = !Number.isNaN(ts);
      if (tsValid) {
        if (oldestTs === null || ts < oldestTs) oldestTs = ts;
        if (newestTs === null || ts > newestTs) newestTs = ts;
        if (session) {
          if (session.firstTs === null || ts < session.firstTs) session.firstTs = ts;
          if (session.lastTs === null || ts > session.lastTs) session.lastTs = ts;
        }
      }
      if (session) session.messageLines += 1;

      if (obj?.attachment?.type === 'invoked_skills' && Array.isArray(obj.attachment.skills)) {
        skillInvocations += obj.attachment.skills.length;
      }

      // "Claude working" vs "human prompt" classification - see the file header for the definitions
      // and why hourCounts/dailyActivity from stats-cache.json cannot be used for this instead.
      if (tsValid) {
        const localHour = new Date(ts).getHours();
        const date = utcDate(ts);
        if (obj.type === 'assistant') {
          hourClaudeWorking[localHour] += 1;
          bumpDaily(dailyEvents, date, 'claudeEvents');
        } else if (obj.type === 'user') {
          const userContent = obj.message?.content;
          const isToolResult = Array.isArray(userContent) && userContent.some((b) => b?.type === 'tool_result');
          if (isToolResult) {
            hourClaudeWorking[localHour] += 1;
            bumpDaily(dailyEvents, date, 'claudeEvents');
          } else if (fileDesc.tier === 'main') {
            // A subagent/workflow-agent's opening "user" line is its parent's injected task text, not
            // something a human typed - restricting to 'main' excludes that by construction.
            hourHumanPrompts[localHour] += 1;
            bumpDaily(dailyEvents, date, 'humanPrompts');
          }
        }
      }

      // Per-model token totals, independent of the "claude working" event classification above -
      // only lines with real, priced usage contribute here (see the file header).
      if (tsValid && obj.type === 'assistant' && obj.message?.usage && obj.message.id) {
        const model = obj.message.model;
        if (model && model !== '<synthetic>') {
          const u = obj.message.usage;
          const tokens = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
          };
          const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheCreationTokens + tokens.cacheReadTokens;
          const existing = tokenDedup.get(obj.message.id);
          if (!existing || total > existing.total) {
            tokenDedup.set(obj.message.id, { date: utcDate(ts), model, tokens, total });
          }
        }
      }

      const content = obj?.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block?.type !== 'tool_use' || !block.name) continue;
        bumpMap(toolCallCounts, block.name);
        if (session) session.toolCalls += 1;

        if (block.name === 'Bash' && typeof block.input?.command === 'string') {
          const cmd = block.input.command;
          for (const [key, re] of Object.entries(BASH_PATTERNS)) {
            if (re.test(cmd)) bashCounts[key] += 1;
          }
        } else if (block.name === 'Write' && typeof block.input?.content === 'string') {
          linesWritten += countLines(block.input.content);
        } else if (block.name === 'Edit') {
          if (typeof block.input?.new_string === 'string') editLinesAdded += countLines(block.input.new_string);
          if (typeof block.input?.old_string === 'string') editLinesRemoved += countLines(block.input.old_string);
        } else if (block.name === 'EnterWorktree') {
          if (block.input?.name) {
            worktreesCreatedViaTool += 1;
            worktreeToolNames.add(String(block.input.name));
          } else if (block.input?.path) {
            worktreesEnteredViaTool += 1;
          }
        }
      }
    }

    // Bucketed by the session's true start (min timestamp across the whole file), not by whichever
    // line happened to be read first - a resumed/branched session can carry an early line with a
    // later timestamp than the file's actual minimum.
    if (session && session.firstTs !== null) {
      const date = utcDate(session.firstTs);
      if (!dailySessionsStarted.has(date)) dailySessionsStarted.set(date, new Set());
      dailySessionsStarted.get(date).add(fileDesc.sessionId);
    }

    filesScanned += 1;
    verbose(`[activity] ${fileDesc.tier.padEnd(14)} ${fileDesc.relPath}`);
  }

  return {
    filesScanned,
    oldestTs,
    newestTs,
    projects: [...projects],
    worktreeProjectsSeen: worktreeProjects.size,
    worktreeProjectLabels: [...worktreeProjects.keys()],
    workflowRunsSeen: workflowRuns.size,
    subagentFiles,
    workflowAgentFiles,
    sessions: [...sessions.values()].map((s) => ({
      project: s.project,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      durationMs: s.firstTs !== null && s.lastTs !== null ? s.lastTs - s.firstTs : null,
      messageLines: s.messageLines,
      toolCalls: s.toolCalls,
    })),
    toolCallCounts: [...toolCallCounts.entries()].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls),
    bash: bashCounts,
    worktreeTool: {
      created: worktreesCreatedViaTool,
      entered: worktreesEnteredViaTool,
      distinctNames: worktreeToolNames.size,
    },
    loc: {
      linesWritten,
      editLinesAdded,
      editLinesRemoved,
    },
    skillInvocations,
    hourOfDay: {
      claudeWorking: hourClaudeWorking,
      humanPrompts: hourHumanPrompts,
    },
    // One row per UTC date actually seen in transcripts still on disk - i.e. only the retained
    // window, never a substitute for stats-cache.json's longer (but frozen) history.
    dailyActivity: [...dailyEvents.entries()]
      .map(([date, row]) => ({
        date,
        claudeEvents: row.claudeEvents,
        humanPrompts: row.humanPrompts,
        sessionsStarted: dailySessionsStarted.get(date)?.size ?? 0,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    // Same shape as stats-cache.json's own dailyModelTokens, so activityMetrics.js can splice the two
    // together by date without a format translation.
    dailyModelTokens: (() => {
      const byDate = new Map();
      for (const rec of tokenDedup.values()) {
        const bucket = byDate.get(rec.date) ?? new Map();
        const cur = bucket.get(rec.model) ?? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
        cur.inputTokens += rec.tokens.inputTokens;
        cur.outputTokens += rec.tokens.outputTokens;
        cur.cacheCreationTokens += rec.tokens.cacheCreationTokens;
        cur.cacheReadTokens += rec.tokens.cacheReadTokens;
        bucket.set(rec.model, cur);
        byDate.set(rec.date, bucket);
      }
      return [...byDate.entries()]
        .map(([date, models]) => ({ date, tokensByModel: Object.fromEntries(models) }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    })(),
  };
}

function getOrCreateSession(sessions, sessionId, project) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { project, firstTs: null, lastTs: null, messageLines: 0, toolCalls: 0 });
  }
  return sessions.get(sessionId);
}
