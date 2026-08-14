import { totalTokens } from './recordParser.js';

// Corpus-wide dedupe by message.id, max-wins (usage fields fill in progressively across multiple
// lines sharing one message.id; the version with the highest total token count is kept). This
// operates on the small normalized records, not raw file bytes, so memory stays bounded even across
// a 1000+ file corpus. Rule 2 (never drop isSidechain:true) is structural here: nothing in this class
// ever filters on isSidechain - both main and subagent/workflow-agent records flow through the same
// unconditional max-wins path. Do not "fix" this into ccusage's replay-dedup heuristic - this corpus's
// subagent transcripts are entirely isSidechain:true, and dropping them deletes all subagent cost.
export class Deduper {
  constructor() {
    this.byMessageId = new Map();
  }

  add(record) {
    const existing = this.byMessageId.get(record.messageId);
    if (!existing || totalTokens(record) > totalTokens(existing)) {
      this.byMessageId.set(record.messageId, record);
    }
  }

  values() {
    return [...this.byMessageId.values()];
  }

  get size() {
    return this.byMessageId.size;
  }
}
