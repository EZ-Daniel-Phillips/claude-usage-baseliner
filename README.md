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

## Reading the report

The HTML report is built to answer one question directly: **did the change I made to my setup
actually reduce what Claude Code costs me, and how do I know?**

A compare report leads with a verdict (one number, plain English), then the findings that explain it,
then the evidence. Key ideas:

- **Everything is cost-weighted.** Raw token counts are typically ~96% cache reads, which cost a
  tenth of an input token, so a "total tokens" figure is mostly driven by the cheapest thing you buy.
  Each token is priced by class and by the model that produced it (cache read 0.1x input, cache write
  1.25x, output at that model's output rate).
- **Everything is a rate.** A baseline covers everything on disk; a compare covers only what happened
  since. Comparing totals would just measure which window was longer, so all headline figures are
  per request.
- **The mix check is not optional.** An apparent win can be manufactured by running more work on a
  cheaper model. The report decomposes the change into context re-read, fresh context, reply length
  and model mix - these reconcile exactly - and separately reports the mix-adjusted change, which
  holds the split of work across models at its baseline value. Aggregate and like-for-like figures
  that disagree are called out rather than quietly averaged.
- **Percentiles are explained inline**, and drawn: overlaid distribution curves show the whole
  distribution shifting, with each period's typical (P50) request marked.

The price table (`src/report/cost.js`) is deliberately frozen and versioned. Both sides of a
comparison must be priced identically, or the delta measures Anthropic's price changes rather than
your efficiency. Bump `PRICE_TABLE_VERSION` and re-baseline if you change a rate.

## Notes

- Dollar figures are **estimates at published API list rates, not billing data** - Claude Code
  transcripts record no cost signal, and subscription plans aren't billed per token. They exist to
  compare two periods on a consistent basis.
- Percentile comparisons are flagged low-confidence below 20 samples; significance testing
  (Mann-Whitney U) is skipped below 10 samples per side and a directional trend is reported instead.
- Local transcript retention is roughly 30 days; a baseline's own computed stats remain valid as a
  comparison reference indefinitely, but the exact historical window can't be re-scanned once source
  transcripts rotate out.
- The stored JSON has no per-day breakdown, so the report compares two periods as blocks rather than
  plotting a trend over time. Adding a daily series to the scan output is what a time-series view
  would need.
