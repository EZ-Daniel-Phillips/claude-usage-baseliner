import { parseArgs } from 'node:util';
import { resolveConfig } from './config.js';
import { runBaseline } from './commands/baselineCommand.js';
import { runCompare, NoBaselineError } from './commands/compareCommand.js';
import { setVerbosity, error } from './util/log.js';

const HELP = `claude-usage-baseliner

Baselines Claude Code token usage from local ~/.claude transcripts and measures efficiency change
over time. Output (JSON + HTML reports, and scan state) is always written under
~/.claude/claude-usage-baseliner/, regardless of where this tool is installed or run from.

Usage:
  claude-usage-baseliner --baseline [options]
  claude-usage-baseliner --compare [options]

Options:
  --baseline              Scan everything available and establish a fresh reference point.
  --compare               Measure all activity since the last baseline and compare against it.
  --since-last            With --compare, measure only what is new since the previous scan instead
                          of everything since the baseline. Consumes that window: the next run will
                          not see it again.
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
        'since-last': { type: 'boolean' },
        'claude-dir': { type: 'string' },
        'min-n': { type: 'string' },
        'bootstrap-samples': { type: 'string' },
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

  if (parsed.values.baseline === parsed.values.compare) {
    error('Exactly one of --baseline or --compare is required.');
    console.log(HELP);
    return 1;
  }

  setVerbosity(parsed.values.quiet ? 'quiet' : parsed.values.verbose ? 'verbose' : 'normal');
  const config = resolveConfig(parsed);

  try {
    if (parsed.values.baseline) {
      await runBaseline(config);
    } else {
      await runCompare(config);
    }
    return 0;
  } catch (e) {
    if (e instanceof NoBaselineError) {
      error(e.message);
      return 1;
    }
    error(e.stack || e.message);
    return 1;
  }
}
