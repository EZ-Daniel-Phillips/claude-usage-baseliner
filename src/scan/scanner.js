import fs from 'node:fs';
import { walkTranscriptFiles, walkWorkflowDefinitions, readMetaJson } from './walker.js';
import { readLinesFrom } from './jsonlReader.js';
import { parseLine, totalTokens } from './recordParser.js';
import { Deduper } from './dedupe.js';
import {
  extractSkillInvocations,
  extractNestedMemory,
  extractCompactionEvent,
  ToolPayloadTracker,
  mergeToolStats,
} from './attachments.js';
import { parseWorkflowDefinition } from './workflows.js';
import { verbose, warn } from '../util/log.js';

const RING_BUFFER_SIZE = 20;

// Scans the whole transcript corpus under claudeDir, resuming per-file from `priorCursors` where
// present (see state/cursor.js for the cursor shape). Pass `priorCursors = {}` for a fresh --baseline.
//
// `sinceMs` (epoch ms, or null) windows the scan by CONTENT time rather than by read position: only
// activity stamped after it is collected. This is what lets --compare mean "everything since the
// baseline" and stay repeatable - a byte-offset cursor answers "what have I not read yet", which is
// a different question and consumes its own window on every run.
export async function scanCorpus(claudeDir, priorCursors = {}, { sinceMs = null } = {}) {
  const deduper = new Deduper();
  const skillInvocations = [];
  const nestedMemoryEvents = [];
  const compactionEvents = [];
  const toolPayloadStats = new Map();
  const fileCursors = {};

  let filesScanned = 0;
  let newFiles = 0;
  let corruptLineCount = 0;
  let boundaryReconciliations = 0;
  let outOfWindowLines = 0;
  let undatedLinesSkipped = 0;

  for (const fileDesc of walkTranscriptFiles(claudeDir)) {
    let stat;
    try {
      stat = fs.statSync(fileDesc.filePath);
    } catch {
      continue; // file disappeared between walk and stat - skip
    }

    const priorCursor = priorCursors[fileDesc.relPath];
    const isNew = !priorCursor;
    if (isNew) newFiles += 1;

    // A shrunk file relative to its recorded cursor is unexpected (rotation?) - treat as new/rescan
    // from 0 rather than trying to resume from a byte offset that may no longer exist.
    const startOffset = priorCursor && stat.size >= priorCursor.size ? priorCursor.byteOffset : 0;
    if (priorCursor && stat.size < priorCursor.size) {
      warn(`[scan] ${fileDesc.relPath} shrank since last scan - rescanning from 0`);
    }

    // Nothing new to read in this file.
    if (priorCursor && stat.size === priorCursor.byteOffset && stat.mtimeMs === priorCursor.mtimeMs) {
      fileCursors[fileDesc.relPath] = priorCursor;
      filesScanned += 1;
      continue;
    }

    const carryIn = new Map(
      (priorCursor?.lastMessageIds ?? []).map((id) => [id, priorCursor.lastMessageTokenTotals?.[id] ?? 0])
    );

    const meta = fileDesc.metaPath ? readMetaJson(fileDesc.metaPath) : null;
    const context = {
      tier: fileDesc.tier,
      project: fileDesc.project,
      sessionId: fileDesc.sessionId,
      agentId: fileDesc.agentId,
      meta,
    };

    const toolTracker = new ToolPayloadTracker();
    const recentRecords = [];
    let offsetAfterLastGoodLine = startOffset;

    for await (const { line, offsetAfter } of readLinesFrom(fileDesc.filePath, startOffset)) {
      let obj;
      const parsed = parseLine(line, context);

      if (parsed.kind === 'corrupt') {
        corruptLineCount += 1;
        continue; // do NOT advance offsetAfterLastGoodLine - this line stays unresolved for next scan
      }

      offsetAfterLastGoodLine = offsetAfter;
      obj = parsed.obj;

      // Is this line inside the requested time window? Undated lines cannot be attributed to a
      // period, so they are excluded (and counted) rather than silently credited to this one.
      let inWindow = true;
      if (sinceMs !== null && obj) {
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        if (Number.isNaN(ts)) {
          inWindow = false;
          undatedLinesSkipped += 1;
        } else if (ts <= sinceMs) {
          inWindow = false;
          outOfWindowLines += 1;
        }
      }

      if (obj) {
        // Always observed, so a tool_use is still paired with its tool_result across the window
        // boundary; only in-window results are counted.
        toolTracker.observe(obj, inWindow);
        if (inWindow) {
          for (const skill of extractSkillInvocations(obj)) {
            skillInvocations.push({ sessionId: fileDesc.sessionId, project: fileDesc.project, ...skill });
          }
          const nm = extractNestedMemory(obj);
          if (nm) nestedMemoryEvents.push({ sessionId: fileDesc.sessionId, project: fileDesc.project, ...nm });
          const compaction = extractCompactionEvent(obj);
          if (compaction) compactionEvents.push({ sessionId: fileDesc.sessionId, project: fileDesc.project, ...compaction });
        }
      }

      if (parsed.kind !== 'record') continue;
      if (!inWindow) continue;

      const { record } = parsed;

      if (carryIn.has(record.messageId)) {
        // This message.id was already attributed to a prior scan period (baseline or an earlier
        // compare) - it reappeared only because its usage snapshot was still filling in across the
        // resume boundary. Do not count it again in this period's own stats.
        boundaryReconciliations += 1;
      } else {
        deduper.add(record);
      }

      recentRecords.push({ messageId: record.messageId, total: totalTokens(record) });
      if (recentRecords.length > RING_BUFFER_SIZE) recentRecords.shift();
    }

    mergeToolStats(toolPayloadStats, toolTracker.flush());

    const lastMessageIds = recentRecords.map((r) => r.messageId);
    const lastMessageTokenTotals = {};
    for (const r of recentRecords) lastMessageTokenTotals[r.messageId] = r.total;

    fileCursors[fileDesc.relPath] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      byteOffset: offsetAfterLastGoodLine,
      lastMessageIds,
      lastMessageTokenTotals,
    };

    filesScanned += 1;
    verbose(`[scan] ${fileDesc.tier.padEnd(14)} ${fileDesc.relPath}`);
  }

  const workflowDefinitions = [];
  for (const wfDesc of walkWorkflowDefinitions(claudeDir)) {
    const parsed = parseWorkflowDefinition(wfDesc.filePath);
    if (parsed) workflowDefinitions.push({ relPath: wfDesc.relPath, ...parsed });
  }

  return {
    generatedAt: new Date().toISOString(),
    filesScanned,
    newFiles,
    corruptLineCount,
    boundaryReconciliations,
    outOfWindowLines,
    undatedLinesSkipped,
    sinceMs,
    records: deduper.values(),
    skillInvocations,
    nestedMemoryEvents,
    compactionEvents,
    toolPayloadStats,
    workflowDefinitions,
    fileCursors,
  };
}
