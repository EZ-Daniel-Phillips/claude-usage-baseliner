# claude-usage-baseliner

Baselines Claude Code token usage from local `~/.claude` session transcripts and measures efficiency
change over time.

## Usage

```
node bin/claude-usage-baseliner.js --baseline [--claude-dir <path>]
node bin/claude-usage-baseliner.js --compare  [--claude-dir <path>]
```

`--baseline` scans everything currently available under the target `.claude` directory (default:
`~/.claude`) and establishes a fresh reference point. `--compare` scans only the activity since the
last scan and statistically compares it against the last `--baseline` (never a previous `--compare` -
the reference distribution only moves when you explicitly re-baseline).

All output - the scan state, and every baseline/compare JSON+HTML report pair - is written under
`~/.claude/claude-usage-baseliner/`, independent of where this repo lives, so it survives across
clones/reinstalls of this tool.

```
~/.claude/claude-usage-baseliner/
  state.json
  baselines/baseline-<timestamp>.json + .html
  compares/compare-<timestamp>.json + .html
```

See `--help` for all options (`--min-n`, `--bootstrap-samples`, `--quiet`, `--verbose`).

## Notes

- All figures are token-count proxies, not billing data - Claude Code subscription plans don't record
  a local USD cost signal.
- Percentile comparisons are flagged low-confidence below 20 samples; significance testing
  (Mann-Whitney U) is skipped below 10 samples per side and a directional trend is reported instead.
- Local transcript retention is roughly 30 days; a baseline's own computed stats remain valid as a
  comparison reference indefinitely, but the exact historical window can't be re-scanned once source
  transcripts rotate out.
