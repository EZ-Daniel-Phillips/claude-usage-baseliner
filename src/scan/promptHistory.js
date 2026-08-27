import fs from 'node:fs';
import path from 'node:path';
import { readLinesFrom } from './jsonlReader.js';
import { verbose } from '../util/log.js';

// Reads ~/.claude/history.jsonl - Claude Code's own log of every prompt you have actually typed into
// the prompt box - and buckets it by local hour of day.
//
// Why this file exists at all, when scan/activityScanner.js already builds an hour-of-day histogram:
// that one is computed from transcripts, and transcripts rotate after roughly 30 days (see
// scan/walker.js). On the corpus this was built against, the oldest surviving transcript was exactly
// 30.0 days old, while history.jsonl reached back 227 days to the first-ever session - and the
// difference was not cosmetic: 528 prompts fell in the 22:00-01:59 band across the full lifetime
// versus 13 inside the retained window, i.e. the transcript-only chart was under-representing
// late-night work by more than an order of magnitude. This file is the only on-disk source that can
// answer "what hours do I actually prompt at" over the tool's whole history.
//
// What it can and cannot answer:
//   - CAN: "your prompts" (human-typed input), full lifetime, one entry per submitted prompt. This is
//     the source the report's single hour-of-day chart draws that series from.
//   - CANNOT: "Claude working" (assistant turns + tool round-trips). history.jsonl contains only your
//     side of the conversation, so the unattended/overnight working signal older than the retention
//     window is genuinely unrecoverable - it is not reconstructed or estimated, and the chart's other
//     series stays limited to transcripts still on disk. The chart does not distinguish the two
//     sources; the differing reach is documented in the report's method section instead.
//
// Read-only and best-effort in the same way as scan/rootStats.js: this file is Claude Code's, not
// ours, its shape is not contractual, and a missing or unreadable file degrades this one section of
// the report rather than failing the run.
//
// Observed shape (one JSON object per line):
//   { display: "<the typed text>", pastedContents: {...}, timestamp: <epoch ms>, project: "<cwd>",
//     sessionId: "<uuid>" }
//
// Deliberately NOT deduplicated: two identical `display` strings are two separate times you typed
// the same thing, which is exactly what this histogram is counting. And deliberately NOT filtered to
// exclude slash commands - typing `/clear` at 23:40 is still you at the keyboard at 23:40 - but they
// are counted separately so the report can disclose how much of the total they are.
export const HISTORY_FILENAME = 'history.jsonl';

const LATE_HOUR_NOTE = 'local hour, DST-correct per entry (each timestamp is converted individually)';

// Slash commands are typed input like any other, but are worth counting separately: they are cheap
// keystrokes rather than work being requested, so a reader comparing this total against a message or
// request count elsewhere in the report needs to know how many of these are in it.
function isSlashCommand(display) {
  return typeof display === 'string' && display.startsWith('/');
}

export async function readPromptHistory(claudeDir) {
  const filePath = path.join(claudeDir, HISTORY_FILENAME);
  if (!fs.existsSync(filePath)) {
    verbose(`No ${HISTORY_FILENAME} under ${claudeDir} - skipping full-lifetime prompt history.`);
    return null;
  }

  const hours = new Array(24).fill(0);
  const monthly = new Map();
  const sessions = new Set();
  const projects = new Set();
  let entries = 0;
  let malformed = 0;
  let slashCommands = 0;
  let firstTs = null;
  let lastTs = null;

  try {
    for await (const { line } of readLinesFrom(filePath, 0)) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      const ts = typeof obj?.timestamp === 'number' ? obj.timestamp : NaN;
      if (!Number.isFinite(ts)) {
        malformed += 1;
        continue;
      }
      const when = new Date(ts);
      const hour = when.getHours();
      if (hour < 0 || hour > 23) {
        malformed += 1;
        continue;
      }

      entries += 1;
      hours[hour] += 1;
      if (firstTs === null || ts < firstTs) firstTs = ts;
      if (lastTs === null || ts > lastTs) lastTs = ts;
      // UTC month key, matching the UTC date-bucketing activityScanner.js uses for daily activity -
      // a few hours of boundary drift cannot change which month a prompt mostly belongs to.
      const month = when.toISOString().slice(0, 7);
      monthly.set(month, (monthly.get(month) ?? 0) + 1);
      if (isSlashCommand(obj.display)) slashCommands += 1;
      if (typeof obj.sessionId === 'string' && obj.sessionId) sessions.add(obj.sessionId);
      if (typeof obj.project === 'string' && obj.project) projects.add(obj.project);
    }
  } catch (err) {
    // An unreadable/locked file is a degraded section, not a failed run - same contract as
    // readStatsCache().
    verbose(`Could not read ${filePath}: ${err.message}`);
    return null;
  }

  if (entries === 0) return null;

  verbose(`Read ${entries} typed prompts from ${filePath} (${malformed} unparseable line(s)).`);

  return {
    filePath,
    hourBasis: LATE_HOUR_NOTE,
    entries,
    malformed,
    slashCommands,
    distinctSessions: sessions.size,
    distinctProjects: projects.size,
    firstTs,
    lastTs,
    hours,
    monthly: [...monthly.entries()]
      .map(([month, prompts]) => ({ month, prompts }))
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)),
  };
}
