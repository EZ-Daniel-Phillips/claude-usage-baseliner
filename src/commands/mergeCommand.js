import path from 'node:path';
import fs from 'node:fs';
import { mergeActivityReportData } from '../report/mergeActivity.js';
import { writeJsonReport } from '../report/json.js';
import { renderVisualiseHtml } from '../report/visualiseHtml.js';
import { getVisualiseDir } from '../state/paths.js';
import { compactIsoTimestamp } from '../util/time.js';
import { info } from '../util/log.js';

export class MergeInputError extends Error {}

// Combines two or more --visualise JSON reports - typically one dumped from each of several
// machines - into a single report-data object and renders it with the same HTML the single-machine
// --visualise mode uses. Reads only the files named by --input; touches nothing else under ~/.claude
// on this machine, so it is exactly as isolated from state.json/--baseline/--compare as --visualise
// itself.
export async function runMerge({ inputs }) {
  if (!inputs || inputs.length < 2) {
    throw new MergeInputError(`--merge needs at least 2 --input <path> files, got ${inputs?.length ?? 0}.`);
  }

  const reportDataList = inputs.map((inputPath) => {
    const resolved = path.resolve(inputPath);
    let raw;
    try {
      raw = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      throw new MergeInputError(`Could not read --input "${inputPath}": ${e.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new MergeInputError(`--input "${inputPath}" is not valid JSON: ${e.message}`);
    }
  });

  info(`Merging ${reportDataList.length} --visualise report(s) ...`);

  const id = `visualise-merged-${compactIsoTimestamp()}`;
  const generatedAt = new Date().toISOString();
  let reportData;
  try {
    reportData = mergeActivityReportData(reportDataList, { id, generatedAt });
  } catch (e) {
    // Re-thrown as MergeInputError so the CLI prints a clean message instead of a stack trace - this
    // is a bad/mismatched input file, the same class of problem as an unreadable path above.
    throw new MergeInputError(e.message);
  }

  const visualiseDir = getVisualiseDir();
  fs.mkdirSync(visualiseDir, { recursive: true });
  const jsonPath = path.join(visualiseDir, `${id}.json`);
  const htmlPath = path.join(visualiseDir, `${id}.html`);

  writeJsonReport(jsonPath, reportData);
  fs.writeFileSync(htmlPath, renderVisualiseHtml(reportData), 'utf8');

  info(`Merge complete: ${reportData.sources.length} source(s), ${reportData.scan.filesScanned.toLocaleString('en-US')} transcript files combined.`);
  info(`  JSON: ${jsonPath}`);
  info(`  HTML: ${htmlPath}`);

  return { reportData, jsonPath, htmlPath };
}
