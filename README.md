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
activity/hour-of-day pattern, total tokens, commits, worktrees created, and lines written.

Its HTML report is styled deliberately differently from `--baseline`/`--compare`'s: a wide, light,
large-type layout meant to be read from across a room (e.g. on a TV during a presentation), not just
at a desk. This styling is self-contained to `--visualise`/`--merge` output and never touches
`--baseline`/`--compare`'s report design.

It is deliberately isolated from `--baseline`/`--compare`:

- It never reads or writes `state.json`, so it cannot move, consume, or otherwise affect your
  baseline reference point or a `--compare` window.
- It writes only to its own `visualise/` subdirectory - never `baselines/` or `compares/`.
- It runs its own transcript walk (`src/scan/activityScanner.js`), independent of the
  usage/cost scanner and its dedupe/cursor state.

Because Claude Code's transcripts rotate after roughly 30 days, `--visualise` combines two sources
to cover the tool's whole history, not just what is still on disk:

- **`stats-cache.json`** (Claude Code's own usage cache, at the root of the scanned directory) -
  survives transcript rotation, so it is the source for all-time session/message counts.
- **A fresh transcript scan** - commits, pushes, worktree creations (both the `EnterWorktree` tool
  and raw `git worktree add`), an estimated line count from Write/Edit tool calls, and (see below)
  hour-of-day activity, daily activity, and any token/model usage newer than the cache. This part
  only sees the ~30-day retention window still on disk.

`stats-cache.json` is optional; a missing file degrades that section of the report rather than
failing the run.

**The lines-written/edited figures are an estimate, not a diff** - they count lines passed to the
Write/Edit tools, so they cannot see reverts, repeated rewrites of the same lines, or code changed
outside Claude Code.

**Pull-request metrics were tried and removed.** `gh-pr-status-cache.json` turned out to be a small
rolling status-poll cache (whatever PRs the status line last checked), not a ledger, and the `gh pr
create`/`gh pr review` command counts from transcripts were no more trustworthy (~30-day window,
only PRs actually raised through the gh CLI). Both signals silently and significantly understated
real PR history, so rather than keep an unreliable metric with caveats, it was removed outright.

**Hour-of-day and daily activity no longer come from `stats-cache.json`.** An earlier version read
its `hourCounts` field, which turned out to be a per-*session-start* histogram, not an activity
histogram (`sum(hourCounts) === totalSessions`, exactly) - a session left running unattended for
hours or days registered identically to a 30-second one, so genuinely long-running or overnight
sessions never showed up as overnight activity. Hour-of-day and the recent daily-activity chart are
now computed directly from transcript timestamps still on disk, counting two distinct kinds of
event: **"Claude working"** (any assistant turn, or any tool round-trip, across every tier - main
sessions, subagents, and workflow agents) and **"your prompts"** (genuine human-typed messages, main
sessions only). This is why the two are shown as separate series rather than one number: a
subagent's opening message is its parent's injected task text, not something you typed, and an
unattended multi-hour or multi-day run should show up as hours of Claude-working activity, not one
entry at whatever hour it was started.

**A stale cache blocks the run by default.** `/stats` inside Claude Code is the only known way to
force a recompute (see below), so `--visualise` checks `lastComputedDate` before scanning anything: if
the cache is more than `--max-cache-age` days old (default 2), it prompts to continue anyway when run
interactively, or refuses outright with a one-line error when not (e.g. in a script or CI). Pass
`--allow-stale-cache` to skip the check entirely, or a larger `--max-cache-age <days>` to raise the
threshold. This exists because the only fix for stale session/message *counts* (as opposed to token
totals, see below) is to actually refresh the cache - there's no live substitute for history older than
the ~30-day transcript retention window.

**`stats-cache.json` can be stale, and token/model totals are supplemented for it.** The cache is
recomputed by Claude Code itself on its own schedule, not on every run - `lastComputedDate` (shown at
the top of the report) can lag behind today by weeks, which previously hid any model adopted after
that date (e.g. a newly-released model) from the token/cost breakdown entirely. The report now
supplements the cached per-model token totals with anything computed live from transcripts dated
after `lastComputedDate` (deduplicated by message id, so nothing already in the cache is
double-counted), and discloses how stale the cache is and how many tokens were recovered this way. If
the gap between `lastComputedDate` and the oldest transcript still on disk is larger than one day,
that span is permanently unrecoverable and the report says so - session/message *counts* (which still
come only from the cache) are the one figure this does not fix.

### `--merge`: combining data from more than one machine

Each machine you use Claude Code on has its own `~/.claude`, so a single `--visualise` run only ever
sees that machine's history. `--merge` combines two or more `--visualise` JSON reports - typically one
dumped from each machine - into a single merged JSON+HTML report:

```
# On machine A:
node bin/claude-usage-baseliner.js --visualise
# -> ~/.claude/claude-usage-baseliner/visualise/visualise-<timestamp>.json

# On machine B:
node bin/claude-usage-baseliner.js --visualise
# -> ~/.claude/claude-usage-baseliner/visualise/visualise-<timestamp>.json

# Copy both JSON files to one machine, then:
node bin/claude-usage-baseliner.js --merge \
  --input machineA-visualise-<timestamp>.json \
  --input machineB-visualise-<timestamp>.json
```

`--input` may be repeated any number of times (two or more required), including a previously merged
report - merging a merge just extends its source list rather than nesting.

Fields are combined by whichever rule is actually correct for what they measure, not uniformly summed
or averaged:

- **Summed** - each source's activity is genuinely independent, so nothing here can double-count:
  sessions, messages, tokens, commits, pushes, lines written/edited, subagent/workflow counts,
  transcript files scanned.
- **Recomputed from combined raw data, not averaged** - the cached and recent daily-activity series
  are each merged date-by-date (kept separate from each other, since they measure different things -
  see above), then active-day coverage, streaks and gaps are recalculated from the union of active
  dates across both; the "Claude working" and "your prompts" hour-of-day series are each summed per
  hour across sources before percentages/shares are recalculated.
- **Deduplicated** - distinct project/worktree names are unioned rather than summed.
- **Not carried over** - per-source cache-staleness detail (each machine has its own
  `stats-cache.json` on its own recompute schedule) doesn't collapse into one meaningful figure, so a
  merged report doesn't show a staleness banner; check each source's own report for that.

The merged report is rendered with the same HTML as a single-machine `--visualise` report, with an
added panel listing every source it was built from. Like `--visualise` itself, `--merge` only reads
the files named by `--input` and writes its own JSON+HTML pair - it never touches `state.json`.

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
