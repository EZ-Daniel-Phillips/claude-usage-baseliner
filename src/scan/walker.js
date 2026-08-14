import fs from 'node:fs';
import path from 'node:path';

// Classifies every scannable transcript file under ~/.claude/projects by explicit structural descent
// (main -> subagents/ -> subagents/workflows/wf_*/), never by a shallow "does a dir named X exist
// anywhere" check - that kind of check would double count or miss workflow-agent files, which sit one
// level deeper than direct subagent files but under a directory that is *also* named "subagents".
// tool-results/*.txt is plain text (not JSONL) and is skipped by construction (matches neither branch).

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function toRelPath(baseDir, fullPath) {
  return path.relative(baseDir, fullPath).split(path.sep).join('/');
}

function* walkWorkflowAgents(claudeDir, project, sessionId, workflowsDir) {
  for (const entry of safeReaddir(workflowsDir)) {
    if (!entry.isDirectory() || !entry.name.startsWith('wf_')) continue;
    const runId = entry.name;
    const wfDir = path.join(workflowsDir, runId);
    for (const wfEntry of safeReaddir(wfDir)) {
      if (wfEntry.isFile() && wfEntry.name.startsWith('agent-') && wfEntry.name.endsWith('.jsonl')) {
        const agentId = wfEntry.name.slice('agent-'.length, -'.jsonl'.length);
        yield {
          filePath: path.join(wfDir, wfEntry.name),
          relPath: toRelPath(claudeDir, path.join(wfDir, wfEntry.name)),
          tier: 'workflow-agent',
          project,
          sessionId,
          agentId,
          runId,
          metaPath: path.join(wfDir, `agent-${agentId}.meta.json`),
        };
      }
      // journal.jsonl and anything else under wf_<runId>/ is not a per-request transcript - skip.
    }
  }
}

function* walkSessionSubagents(claudeDir, project, sessionId, sessionDir) {
  const subagentsDir = path.join(sessionDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return;

  for (const entry of safeReaddir(subagentsDir)) {
    if (entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
      const agentId = entry.name.slice('agent-'.length, -'.jsonl'.length);
      yield {
        filePath: path.join(subagentsDir, entry.name),
        relPath: toRelPath(claudeDir, path.join(subagentsDir, entry.name)),
        tier: 'subagent',
        project,
        sessionId,
        agentId,
        metaPath: path.join(subagentsDir, `agent-${agentId}.meta.json`),
      };
    } else if (entry.isDirectory() && entry.name === 'workflows') {
      yield* walkWorkflowAgents(claudeDir, project, sessionId, path.join(subagentsDir, 'workflows'));
    }
    // 'tool-results' directory (plain .txt, not JSONL) and anything else: skip.
  }
}

// Yields a flat stream of { filePath, relPath, tier, project, sessionId, agentId, metaPath? } for every
// scannable transcript file under `${claudeDir}/projects`.
export function* walkTranscriptFiles(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  if (!fs.existsSync(projectsDir)) return;

  for (const projectEntry of safeReaddir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const project = projectEntry.name;
    const projectDir = path.join(projectsDir, project);

    for (const entry of safeReaddir(projectDir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        yield {
          filePath: path.join(projectDir, entry.name),
          relPath: toRelPath(claudeDir, path.join(projectDir, entry.name)),
          tier: 'main',
          project,
          sessionId: entry.name.slice(0, -'.jsonl'.length),
          agentId: null,
        };
      } else if (entry.isDirectory()) {
        const sessionId = entry.name;
        yield* walkSessionSubagents(claudeDir, project, sessionId, path.join(projectDir, sessionId));
      }
    }
  }
}

// Yields { filePath, relPath } for every ~/.claude/workflows/wf_<runId>.json run-definition file
// (sibling of projects/, holds an embedded `.script` field that must be stripped before use).
export function* walkWorkflowDefinitions(claudeDir) {
  const workflowsDir = path.join(claudeDir, 'workflows');
  if (!fs.existsSync(workflowsDir)) return;
  for (const entry of safeReaddir(workflowsDir)) {
    if (entry.isFile() && entry.name.startsWith('wf_') && entry.name.endsWith('.json')) {
      yield {
        filePath: path.join(workflowsDir, entry.name),
        relPath: toRelPath(claudeDir, path.join(workflowsDir, entry.name)),
      };
    }
  }
}

export function readMetaJson(metaPath) {
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
