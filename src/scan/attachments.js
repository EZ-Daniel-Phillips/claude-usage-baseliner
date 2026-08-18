// Extracts the secondary signals that live alongside request-usage lines in the same JSONL streams:
// skill/nested-memory injection costs, compaction events, and tool call/result payload sizes. Runs in
// the same per-line streaming pass as recordParser.js - no second read of any file.

export function extractSkillInvocations(obj) {
  if (obj?.attachment?.type !== 'invoked_skills') return [];
  const skills = obj.attachment.skills;
  if (!Array.isArray(skills)) return [];
  return skills.map((s) => ({
    skillName: s.name ?? null,
    path: s.path ?? null,
    bytes: typeof s.content === 'string' ? s.content.length : 0,
  }));
}

export function extractNestedMemory(obj) {
  if (obj?.attachment?.type !== 'nested_memory') return null;
  const att = obj.attachment;
  const content = att.content?.content;
  return {
    path: att.path ?? att.content?.path ?? null,
    bytes: typeof content === 'string' ? content.length : 0,
  };
}

export function extractCompactionEvent(obj) {
  if (obj?.type !== 'system' || obj?.subtype !== 'compact_boundary') return null;
  const meta = obj.compactMetadata ?? {};
  return {
    trigger: meta.trigger ?? 'unknown',
    preTokens: meta.preTokens ?? null,
    postTokens: meta.postTokens ?? null,
    cumulativeDroppedTokens: meta.cumulativeDroppedTokens ?? null,
    durationMs: meta.durationMs ?? null,
  };
}

// LSP is tracked because documentSymbol-first navigation is a deliberate token-reduction
// measure — leaving it out made the very tool the guidance promotes invisible to the baseline.
const TRACKED_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Edit', 'Write', 'Glob', 'Task', 'LSP']);

// Stateful within a single file (tool_use ids are only meaningful inside one transcript). Call
// .observe(obj) for every parsed line, then .flush() once per file to get { toolName -> stats }.
export class ToolPayloadTracker {
  constructor() {
    this.pending = new Map(); // tool_use id -> tool name
    this.stats = new Map(); // tool name -> { calls, totalBytes, maxBytes, errors }
  }

  _bump(name, bytes, isError) {
    if (!this.stats.has(name)) {
      this.stats.set(name, { calls: 0, totalBytes: 0, maxBytes: 0, errors: 0 });
    }
    const s = this.stats.get(name);
    s.calls += 1;
    s.totalBytes += bytes;
    if (bytes > s.maxBytes) s.maxBytes = bytes;
    if (isError) s.errors += 1;
  }

  // `inWindow` gates COUNTING only. Pending tool_use ids are always recorded, so a call issued just
  // before a window boundary still pairs with its result just after it.
  observe(obj, inWindow = true) {
    const content = obj?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && TRACKED_TOOLS.has(block.name)) {
          this.pending.set(block.id, block.name);
        }
      }
    }

    // tool_result blocks show up on user-role lines carrying the paired output.
    const userContent = obj?.type === 'user' ? obj?.message?.content : null;
    if (Array.isArray(userContent)) {
      for (const block of userContent) {
        if (block?.type !== 'tool_result') continue;
        const name = this.pending.get(block.tool_use_id);
        if (!name) continue;
        const payload = block.content;
        const bytes =
          typeof payload === 'string'
            ? payload.length
            : Array.isArray(payload)
              ? payload.reduce((acc, p) => acc + (typeof p?.text === 'string' ? p.text.length : 0), 0)
              : 0;
        if (inWindow) this._bump(name, bytes, block.is_error === true);
        this.pending.delete(block.tool_use_id);
      }
    }
  }

  flush() {
    return this.stats;
  }
}

export function mergeToolStats(target, source) {
  for (const [name, s] of source.entries()) {
    if (!target.has(name)) target.set(name, { calls: 0, totalBytes: 0, maxBytes: 0, errors: 0 });
    const t = target.get(name);
    t.calls += s.calls;
    t.totalBytes += s.totalBytes;
    t.maxBytes = Math.max(t.maxBytes, s.maxBytes);
    t.errors += s.errors;
  }
  return target;
}
