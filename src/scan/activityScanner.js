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
      if (!Number.isNaN(ts)) {
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
  };
}

function getOrCreateSession(sessions, sessionId, project) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { project, firstTs: null, lastTs: null, messageLines: 0, toolCalls: 0 });
  }
  return sessions.get(sessionId);
}
