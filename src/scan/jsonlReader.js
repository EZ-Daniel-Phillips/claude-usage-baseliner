import fs from 'node:fs';

// Streams a JSONL file line-by-line starting at `startOffset` bytes, never loading the whole file into
// memory (required at this corpus's scale - files run from a few KB to 70MB+). Yields
// { line, offsetAfter } for each complete (newline-terminated) line only; a trailing partial line
// (process crashed mid-write, or the file is still being appended to) is intentionally never yielded,
// so the caller's cursor never advances past a line it hasn't actually seen a complete copy of.
export async function* readLinesFrom(filePath, startOffset = 0) {
  const stream = fs.createReadStream(filePath, { start: startOffset, encoding: 'utf8' });
  let buffer = '';
  let offset = startOffset;

  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        offset += Buffer.byteLength(line, 'utf8') + 1; // +1 for the newline itself
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          yield { line, offsetAfter: offset };
        }
      }
    }
  } finally {
    stream.close?.();
  }
}
