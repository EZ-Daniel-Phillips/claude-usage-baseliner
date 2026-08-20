import path from 'node:path';
import fs from 'node:fs';
import { mergeActivityReportData } from '../report/mergeActivity.js';
import { mergeReportData } from '../report/mergeReportData.js';
import { writeJsonReport } from '../report/json.js';
import { renderVisualiseHtml } from '../report/visualiseHtml.js';
import { renderHtmlReport } from '../report/html.js';
import { getVisualiseDir, getMergedReportsDir } from '../state/paths.js';
import { compactIsoTimestamp } from '../util/time.js';
import { info } from '../util/log.js';

export class MergeInputError extends Error {}

// A --baseline/--compare report JSON always carries a `mode` of one of these two values; a
// --visualise report JSON never sets `mode` at all. That is enough to tell the two report families
// apart without asking the user to say which kind they are passing in.
function isBaselineCompareShaped(raw) {
  return raw.mode === 'baseline' || raw.mode === 'compare';
}

// Combines two or more report JSON files of the SAME family - either --visualise reports, or
// --baseline/--compare reports (any mix of the two, e.g. one machine's --baseline with another's
// --compare) - typically one dumped from each of several machines. Reads only the files named by
// --input; touches nothing else under ~/.claude on this machine, so it is exactly as isolated from
// state.json as --visualise itself (a merged --baseline/--compare report is never state.json's
// lastBaseline and can never be passed to --compare as a reference point - see getMergedReportsDir()).
export async function runMerge({ inputs, minN = 10, bootstrapSamples = 1500 }) {
  if (!inputs || inputs.length < 2) {
    throw new MergeInputError(`--merge needs at least 2 --input <path> files, got ${inputs?.length ?? 0}.`);
  }

  const rawReports = inputs.map((inputPath) => {
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

  const families = new Set(rawReports.map((r) => (isBaselineCompareShaped(r) ? 'baseline-compare' : 'visualise')));
  if (families.size > 1) {
    throw new MergeInputError(
      'Cannot mix --visualise reports with --baseline/--compare reports in a single --merge run. Pass all --input files from the same report family.'
    );
  }

  return families.has('baseline-compare') ? mergeBaselineCompare(rawReports, { minN, bootstrapSamples }) : mergeVisualise(rawReports);
}

async function mergeVisualise(reportDataList) {
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

async function mergeBaselineCompare(reportDataList, { minN, bootstrapSamples }) {
  info(`Merging ${reportDataList.length} --baseline/--compare report(s) ...`);

  const id = `report-merged-${compactIsoTimestamp()}`;
  const generatedAt = new Date().toISOString();
  let reportData;
  try {
    reportData = mergeReportData(reportDataList, { id, generatedAt, minN, bootstrapSamples });
  } catch (e) {
    throw new MergeInputError(e.message);
  }

  const mergedDir = getMergedReportsDir();
  fs.mkdirSync(mergedDir, { recursive: true });
  const jsonPath = path.join(mergedDir, `${id}.json`);
  const htmlPath = path.join(mergedDir, `${id}.html`);

  writeJsonReport(jsonPath, reportData);
  fs.writeFileSync(htmlPath, renderHtmlReport(reportData), 'utf8');

  info(
    reportData.comparison
      ? `Merge complete: combined verdict from ${reportData.sources.length} source(s), ${reportData.totals.requests.toLocaleString('en-US')} requests in the compared window.`
      : `Merge complete: combined snapshot from ${reportData.sources.length} source(s), ${reportData.totals.requests.toLocaleString('en-US')} requests.`
  );
  info(`  JSON: ${jsonPath}`);
  info(`  HTML: ${htmlPath}`);

  return { reportData, jsonPath, htmlPath };
}
