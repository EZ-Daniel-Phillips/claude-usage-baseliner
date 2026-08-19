# claude-usage-baseliner

Baselines Claude Code token usage from local `~/.claude` session transcripts and measures efficiency
change over time.

## Usage

```
node bin/claude-usage-baseliner.js --baseline   [--claude-dir <path>]
node bin/claude-usage-baseliner.js --compare    [--claude-dir <path>]
node bin/claude-usage-baseliner.js --visualise  [--claude-dir <path>]
```

`--baseline` scans everything currently available under the target `.claude` directory (default:
`~/.claude`) and establishes a fresh reference point.

`--compare` measures **all activity since that baseline** and compares it against it. It is
repeatable: run it twice in a row and you get the same answer, and the request count only grows as
you do more work. The reference distribution is always the last explicit `--baseline`, never a
previous `--compare`, so the yardstick only moves when you deliberately move it.

`--compare --since-last` answers the narrower question "what happened since I last looked". That
window is **consumed** by reading it - the next run starts from where this one stopped - so it is
opt-in rather than the default. Prefer plain `--compare` for "how am I doing against my baseline?".

A cumulative compare reads the whole corpus and filters by timestamp, so it depends on no stored
cursor state and works against a baseline taken at any time. On a corpus of ~1,400 transcript files
that takes roughly 20 seconds.

All output - the scan state, and every baseline/compare JSON+HTML report pair - is written under
`~/.claude/claude-usage-baseliner/`, independent of where this repo lives, so it survives across
clones/reinstalls of this tool.

```
~/.claude/claude-usage-baseliner/
  state.json
  baselines/baseline-<timestamp>.json + .html
  compares/compare-<timestamp>.json + .html
  visualise/visualise-<timestamp>.json + .html
```

See `--help` for all options (`--since-last`, `--min-n`, `--bootstrap-samples`, `--quiet`,
`--verbose`).

## `--visualise`: what you did with Claude

A third, independent mode: not "what did it cost", but "what did you actually do" - sessions, an
"uptime" pattern (active days and hour-of-day spread, since Claude Code is a CLI with no process to
ask "was it running 24/7"), total tokens, commits, worktrees created, lines written, and pull
requests raised/reviewed.

It is deliberately isolated from `--baseline`/`--compare`:

- It never reads or writes `state.json`, so it cannot move, consume, or otherwise affect your
  baseline reference point or a `--compare` window.
- It writes only to its own `visualise/` subdirectory - never `baselines/` or `compares/`.
- It runs its own transcript walk (`src/scan/activityScanner.js`), independent of the
  usage/cost scanner and its dedupe/cursor state.

Because Claude Code's transcripts rotate after roughly 30 days (see below), `--visualise` combines
three sources to cover the tool's whole history, not just what is still on disk:

- **`stats-cache.json`** (Claude Code's own usage cache, at the root of the scanned directory) -
  survives transcript rotation, so it is the source for all-time sessions, messages, hour-of-day
  activity, daily activity, and token totals by model.
- **`gh-pr-status-cache.json`** (Claude Code's gh PR status-poll cache) - pull requests it has
  tracked, their state, review outcome, and GitHub's own additions/deletions count.
- **A fresh transcript scan** - commits, pushes, worktree creations (both the `EnterWorktree` tool
  and raw `git worktree add`), `gh pr` command usage, and an estimated line count from Write/Edit
  tool calls. This part only sees the ~30-day retention window still on disk.

Both cache files are optional; a missing one degrades that section of the report rather than
failing the run.

**The lines-written/edited figures are an estimate, not a diff** - they count lines passed to the
Write/Edit tools, so they cannot see reverts, repeated rewrites of the same lines, or code changed
outside Claude Code. Where a PR exists, its GitHub-computed additions/deletions are the more
trustworthy figure.

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

### Cheaper is not the same as better

Cost is an **input** metric. Nothing in a Claude Code transcript records whether the work was any
good, so the report is careful never to present a saving as a success on its own:

- **Tool failure rate** is tracked as a first-class metric with a two-proportion z-test. It is the
  only outcome-shaped signal the transcripts carry, and it catches the specific failure mode of
  trimming context too far - with less context Claude works from stale paths and line numbers,
  retries, and burns tokens doing it.
- **A quality guardrail overrides the verdict.** If cost falls while the failure rate rises
  significantly, the headline reads "cheaper, but not clearly better" rather than claiming a win.
- **Workload overlap is disclosed.** Cost per request is only a fair before/after if both windows ran
  comparable jobs. When the agent types barely overlap, the report says so and points you at the
  per-job table instead of the headline.
- **Per-job like-for-like** compares each agent type against itself - the closest this data gets to
  "did that specific campaign improve?". Shown in tokens, since the stored breakdown carries no model
  attribution per agent type.

To actually measure *better*, you need an outcome signal from outside the transcripts: review
rejections, rework counts, CI pass rates, regenerations per artifact. The metric that answers it is
**cost per accepted piece of work**, not cost per request.

The price table (`src/report/cost.js`) is deliberately frozen and versioned. Both sides of a
comparison must be priced identically, or the delta measures Anthropic's price changes rather than
your efficiency. Bump `PRICE_TABLE_VERSION` and re-baseline if you change a rate.

Cache writes are billed by how long they are held - 1.25x the input rate at 5 minutes, 2x at 1 hour -
and the scan records that split. The same symmetry rule applies: if either side of a comparison lacks
the breakdown (a baseline captured before it was recorded), **both** sides fall back to the flat 1.25x
rate, and the report discloses it. Otherwise a ~2.5% cost rise would appear that is purely a change in
metering. Re-run `--baseline` to start pricing exactly.

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
- Every report records the period it covers (`window.start` / `window.end` / `window.mode`) and shows
  it at the top, so a stored report can always be read back without guessing what it measured.
- Lines carrying no timestamp cannot be attributed to a period and are excluded from a cumulative
  compare rather than silently credited to it; the count is disclosed in the report footer.
