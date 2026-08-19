import { estimateCostByModel, COST_MODEL_NOTES } from './cost.js';
import { buildCoverage, buildHourOfDay, buildPrSummary } from './activityMetrics.js';

// Combines two or more --visualise report-data objects (the JSON --visualise writes) into one, so
// activity from separate machines - each with its own ~/.claude, its own stats-cache.json, its own
// transcripts - can be viewed as a single history. This operates purely on already-built report JSON,
// not on raw ~/.claude data, so it has no path to state.json and cannot affect --baseline/--compare
// on any machine it touches.
//
// Every field is combined by the rule that is actually correct for what it measures, not uniformly
// summed or averaged - see each block's comment. The two load-bearing distinctions:
//   - SUM when two sources' activity is genuinely independent (their own sessions, their own commits,
//     their own token usage - nothing here can appear on more than one machine).
//   - DEDUPE/RECOMPUTE when two sources could observe the *same* real-world thing (the same PR
//     checked from both machines; two overlapping calendar dates; the derived streak/gap statistics,
//     which are path-dependent and would be wrong if merged by averaging).

function sumBy(list, fn) {
  return list.reduce((a, x) => a + (fn(x) ?? 0), 0);
}

// Like sumBy, but stays null when every source is null (e.g. no stats-cache.json anywhere), instead
// of reporting a misleading 0.
function sumOrNull(list, fn) {
  const vals = list.map(fn);
  if (vals.every((v) => v === null || v === undefined)) return null;
  return vals.reduce((a, v) => a + (v ?? 0), 0);
}

function unionArrays(arrays) {
  return [...new Set(arrays.flat())];
}

function minString(values) {
  return values.length ? values.reduce((a, b) => (a < b ? a : b)) : null;
}

function maxString(values) {
  return values.length ? values.reduce((a, b) => (a > b ? a : b)) : null;
}

// A source that is itself already a merge carries its own `sources` list - flatten those in so
// re-merging a previously-merged report keeps every original machine visible in one flat table,
// rather than nesting "merge of a merge" provenance.
function flattenSources(rd) {
  if (Array.isArray(rd.sources) && rd.sources.length) return rd.sources;
  return [{ claudeDir: rd.claudeDir, generatedAt: rd.generatedAt, id: rd.id, filesScanned: rd.scan?.filesScanned ?? 0 }];
}

function mergeDailyActivity(list) {
  const byDate = new Map();
  for (const rd of list) {
    for (const d of rd.dailyActivity ?? []) {
      const cur = byDate.get(d.date) ?? { date: d.date, messageCount: 0, sessionCount: 0, toolCallCount: 0 };
      cur.messageCount += d.messageCount ?? 0;
      cur.sessionCount += d.sessionCount ?? 0;
      cur.toolCallCount += d.toolCallCount ?? 0;
      byDate.set(d.date, cur);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function mergeHourOfDay(list) {
  if (!list.some((rd) => rd.hourOfDay)) return null;
  const hourCounts = {};
  for (let h = 0; h < 24; h++) hourCounts[String(h)] = 0;
  for (const rd of list) {
    for (const entry of rd.hourOfDay?.hours ?? []) hourCounts[String(entry.hour)] += entry.count;
  }
  return buildHourOfDay(hourCounts);
}

function mergeTokens(list) {
  const byModel = new Map();
  for (const rd of list) {
    for (const m of rd.tokens?.byModel ?? []) {
      const key = m.key;
      const cur = byModel.get(key) ?? { key, requests: 0, tokens: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } };
      cur.tokens.inputTokens += m.tokens.inputTokens ?? 0;
      cur.tokens.outputTokens += m.tokens.outputTokens ?? 0;
      cur.tokens.cacheCreationTokens += m.tokens.cacheCreationTokens ?? 0;
      cur.tokens.cacheReadTokens += m.tokens.cacheReadTokens ?? 0;
      byModel.set(key, cur);
    }
  }
  const byModelArr = [...byModel.values()].map((m) => ({
    ...m,
    tokens: { ...m.tokens, total: m.tokens.inputTokens + m.tokens.outputTokens + m.tokens.cacheCreationTokens + m.tokens.cacheReadTokens },
  }));
  byModelArr.sort((a, b) => b.tokens.total - a.tokens.total);

  const totals = byModelArr.length
    ? byModelArr.reduce(
        (acc, m) => ({
          inputTokens: acc.inputTokens + m.tokens.inputTokens,
          outputTokens: acc.outputTokens + m.tokens.outputTokens,
          cacheCreationTokens: acc.cacheCreationTokens + m.tokens.cacheCreationTokens,
          cacheReadTokens: acc.cacheReadTokens + m.tokens.cacheReadTokens,
          total: acc.total + m.tokens.total,
        }),
        { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, total: 0 }
      )
    : null;

  const cost = byModelArr.length ? estimateCostByModel(byModelArr) : null;
  return { totals, byModel: byModelArr, cost, costModelNotes: COST_MODEL_NOTES };
}

// Pull requests are the one entity that can genuinely be observed by more than one machine (the same
// PR, checked from both) - a plain sum would double-count it, so this dedupes by URL instead. Where
// sources disagree on a PR's cached state (stale poll on one side), the source that was generated
// most recently wins, since its cache read is the freshest.
function mergePrs(list) {
  const withGeneratedAt = [...list].sort((a, b) => (a.generatedAt < b.generatedAt ? -1 : a.generatedAt > b.generatedAt ? 1 : 0));
  const byUrl = new Map();
  for (const rd of withGeneratedAt) {
    for (const pr of rd.github?.prs?.all ?? []) byUrl.set(pr.url, pr); // later (fresher) source overwrites
  }
  return byUrl.size ? [...byUrl.values()] : null;
}

function mergeTools(list) {
  const byTool = new Map();
  for (const rd of list) {
    for (const t of rd.tools?.topTools ?? []) byTool.set(t.tool, (byTool.get(t.tool) ?? 0) + t.calls);
  }
  return [...byTool.entries()].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls);
}

export function mergeActivityReportData(reportDataList, { id, generatedAt } = {}) {
  const valid = reportDataList.filter(Boolean);
  if (valid.length < 2) {
    throw new Error(`mergeActivityReportData requires at least 2 report-data objects, got ${valid.length}`);
  }
  for (const rd of valid) {
    if (rd.mode !== 'visualise') {
      throw new Error(`Cannot merge a "${rd.mode}" report (id: ${rd.id}) - --merge only accepts --visualise output.`);
    }
  }

  const sources = valid.flatMap(flattenSources);

  const dailyActivity = mergeDailyActivity(valid);
  const recentSessionCount = sumBy(valid, (rd) => rd.sessions?.recentWindow?.count);
  const recentTotalDurationMs = sumBy(valid, (rd) => rd.sessions?.recentWindow?.totalDurationMs);
  const mergedPrsRaw = mergePrs(valid);
  const worktreeLabels = unionArrays(valid.map((rd) => rd.worktrees?.projectTraceLabels ?? []));
  const projectList = unionArrays(valid.map((rd) => rd.projects?.list ?? []));

  return {
    mode: 'visualise',
    id,
    generatedAt,
    claudeDir: valid.map((rd) => rd.claudeDir).join(' + '),
    sources,
    dataAvailability: {
      hasStatsCache: valid.some((rd) => rd.dataAvailability?.hasStatsCache),
      hasGhPrCache: valid.some((rd) => rd.dataAvailability?.hasGhPrCache),
    },
    period: {
      firstSessionDate: minString(valid.map((rd) => rd.period?.firstSessionDate).filter(Boolean)),
      lastComputedDate: maxString(valid.map((rd) => rd.period?.lastComputedDate).filter(Boolean)),
      recentWindowStart: minString(valid.map((rd) => rd.period?.recentWindowStart).filter(Boolean)),
      recentWindowEnd: maxString(valid.map((rd) => rd.period?.recentWindowEnd).filter(Boolean)),
    },
    coverage: dailyActivity.length ? buildCoverage(dailyActivity) : null,
    hourOfDay: mergeHourOfDay(valid),
    dailyActivity,
    sessions: {
      totalAllTime: sumOrNull(valid, (rd) => rd.sessions?.totalAllTime),
      totalMessagesAllTime: sumOrNull(valid, (rd) => rd.sessions?.totalMessagesAllTime),
      // The single longest session across every source, not a sum - "longest" is a max, not a total.
      longestSession:
        valid
          .map((rd) => rd.sessions?.longestSession)
          .filter(Boolean)
          .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0] ?? null,
      recentWindow: {
        count: recentSessionCount,
        totalDurationMs: recentTotalDurationMs,
        avgDurationMs: recentSessionCount ? recentTotalDurationMs / recentSessionCount : null,
      },
    },
    tokens: mergeTokens(valid),
    worktrees: {
      createdViaTool: sumBy(valid, (rd) => rd.worktrees?.createdViaTool),
      enteredViaTool: sumBy(valid, (rd) => rd.worktrees?.enteredViaTool),
      // Approximate when merged: summed across sources with no cross-machine dedupe, since only the
      // per-machine *count* of distinct tool-given names survives into report JSON, not the names
      // themselves. Overcounts if the identical worktree name was used on more than one machine.
      distinctToolNames: sumBy(valid, (rd) => rd.worktrees?.distinctToolNames),
      projectTraceCount: worktreeLabels.length,
      projectTraceLabels: worktreeLabels,
      gitWorktreeAddCommands: sumBy(valid, (rd) => rd.worktrees?.gitWorktreeAddCommands),
      gitWorktreeRemoveCommands: sumBy(valid, (rd) => rd.worktrees?.gitWorktreeRemoveCommands),
    },
    git: {
      commits: sumBy(valid, (rd) => rd.git?.commits),
      pushes: sumBy(valid, (rd) => rd.git?.pushes),
    },
    github: {
      prCreateCommands: sumBy(valid, (rd) => rd.github?.prCreateCommands),
      prMergeCommands: sumBy(valid, (rd) => rd.github?.prMergeCommands),
      prReviewCommands: sumBy(valid, (rd) => rd.github?.prReviewCommands),
      prCommentCommands: sumBy(valid, (rd) => rd.github?.prCommentCommands),
      prs: buildPrSummary(mergedPrsRaw),
    },
    code: {
      linesWritten: sumBy(valid, (rd) => rd.code?.linesWritten),
      editLinesAdded: sumBy(valid, (rd) => rd.code?.editLinesAdded),
      editLinesRemoved: sumBy(valid, (rd) => rd.code?.editLinesRemoved),
    },
    projects: {
      distinctCount: projectList.length,
      list: projectList,
      workflowRunsSeen: sumBy(valid, (rd) => rd.projects?.workflowRunsSeen),
      subagentFiles: sumBy(valid, (rd) => rd.projects?.subagentFiles),
      workflowAgentFiles: sumBy(valid, (rd) => rd.projects?.workflowAgentFiles),
    },
    tools: { topTools: mergeTools(valid) },
    skillInvocations: sumBy(valid, (rd) => rd.skillInvocations),
    scan: { filesScanned: sumBy(valid, (rd) => rd.scan?.filesScanned) },
  };
}
