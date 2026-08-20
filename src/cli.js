import { parseArgs } from 'node:util';
import { resolveConfig } from './config.js';
import { runBaseline } from './commands/baselineCommand.js';
import { runCompare, NoBaselineError } from './commands/compareCommand.js';
import { runVisualise, StaleCacheError } from './commands/visualiseCommand.js';
import { runMerge, MergeInputError } from './commands/mergeCommand.js';
import { setVerbosity, error } from './util/log.js';

const HELP = `claude-usage-baseliner

Baselines Claude Code token usage from local ~/.claude transcripts and measures efficiency change
over time. Output (JSON + HTML reports, and scan state) is always written under
~/.claude/claude-usage-baseliner/, regardless of where this tool is installed or run from.

Usage:
  claude-usage-baseliner --baseline [options]
  claude-usage-baseliner --compare [options]
  claude-usage-baseliner --visualise [options]
  claude-usage-baseliner --merge --input <path> --input <path> [--input <path> ...]

Options:
  --baseline              Scan everything available and establish a fresh reference point.
  --compare               Measure all activity since the last baseline and compare against it.
  --visualise             Build a dashboard of what you've done with Claude over its whole usage
                          history (sessions, activity/hour-of-day pattern, tokens, commits,
                          worktrees, lines written). Independent of --baseline/--compare: never reads
                          or writes state.json, and writes its own report under
                          claude-usage-baseliner/visualise/.
  --merge                 Combine two or more --visualise JSON reports (e.g. one dumped from each of
                          several machines) into a single merged JSON+HTML report. Pass each file with
                          its own --input.
  --input <path>          A --visualise JSON report to fold into --merge. Repeat for each source
                          machine; at least two are required.
  --since-last            With --compare, measure only what is new since the previous scan instead
                          of everything since the baseline. Consumes that window: the next run will
                          not see it again.
  --max-cache-age <days>  With --visualise, how many days stale stats-cache.json may be before the
                          run prompts (interactive) or refuses (non-interactive) to continue. Run
                          /stats in Claude Code to refresh it. Default: 2.
  --allow-stale-cache     With --visualise, skip the stale-cache prompt/check entirely and proceed
                          no matter how old stats-cache.json is.
  --plan-cost <usd>       Your flat monthly plan/seat cost (Pro, Max, Team, Enterprise). When set,
                          --visualise/--merge show an estimated actual spend alongside the
                          token/API-rate estimate, prorating this figure over the days the report
                          covers. Omit if you're on pay-as-you-go API billing - the token estimate
                          already is your actual spend in that case.
  --claude-dir <path>     Directory to scan (default: ~/.claude).
  --min-n <int>           Minimum sample size per side before running significance tests (default: 10).
  --bootstrap-samples <n> Resample count for percentile bootstrap CIs (default: 1500).
  --quiet                 Suppress non-essential output.
  --verbose               Print each file as it is scanned.
  --help                  Show this help.
`;

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        baseline: { type: 'boolean' },
        compare: { type: 'boolean' },
        visualise: { type: 'boolean' },
        merge: { type: 'boolean' },
        input: { type: 'string', multiple: true },
        'since-last': { type: 'boolean' },
        'claude-dir': { type: 'string' },
        'min-n': { type: 'string' },
        'bootstrap-samples': { type: 'string' },
        'max-cache-age': { type: 'string' },
        'allow-stale-cache': { type: 'boolean' },
        'plan-cost': { type: 'string' },
        quiet: { type: 'boolean' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    });
  } catch (e) {
    error(`Argument error: ${e.message}`);
    console.log(HELP);
    return 1;
  }

  if (parsed.values.help) {
    console.log(HELP);
    return 0;
  }

  const modes = ['baseline', 'compare', 'visualise', 'merge'].filter((m) => parsed.values[m]);
  if (modes.length !== 1) {
    error('Exactly one of --baseline, --compare, --visualise, or --merge is required.');
    console.log(HELP);
    return 1;
  }

  setVerbosity(parsed.values.quiet ? 'quiet' : parsed.values.verbose ? 'verbose' : 'normal');
  const config = resolveConfig(parsed);

  try {
    if (parsed.values.baseline) {
      await runBaseline(config);
    } else if (parsed.values.compare) {
      await runCompare(config);
    } else if (parsed.values.visualise) {
      await runVisualise(config);
    } else {
      await runMerge({ inputs: parsed.values.input, planCostPerMonth: config.planCostPerMonth });
    }
    return 0;
  } catch (e) {
    if (e instanceof NoBaselineError || e instanceof MergeInputError || e instanceof StaleCacheError) {
      error(e.message);
      return 1;
    }
    error(e.stack || e.message);
    return 1;
  }
}
