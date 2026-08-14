// Compact ISO-8601 UTC timestamp suitable for filenames/ids, e.g. "20260814T090512Z".
export function compactIsoTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
