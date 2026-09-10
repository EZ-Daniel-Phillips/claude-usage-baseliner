// Turns the raw output of scan/gitHarvest.js into the shape the report renders and --merge combines.
//
// The one editorial rule this file enforces, everywhere: these numbers are a FLOOR, never a total.
// A commit only counts as Claude-assisted if its message carries an attribution marker, which is a
// convention rather than a guarantee - commits from a session that did not emit one, or from before
// the convention was adopted, are invisible to this and always will be. Every derived figure here is
// named and captioned so that a reader cannot mistake it for a complete count.
//
// The second rule: author email addresses never leave this file. gitHarvest resolves them because the
// git queries genuinely need them (a shared repo contains other people's Claude commits - five
// different authors in one real repo here - so an unfiltered count would report the team's usage as
// yours), and --merge needs them to tell one machine's identity from another's. But the rendered HTML
// is the artifact that gets shared, so it gets a count of identities and never an address.

// A repo has to have at least one Claude-attributed commit to be worth a row - a repository you use
// but have never committed to with Claude is noise in a table about Claude usage, and there are
// typically many of them.
function isInteresting(repo) {
  return (repo.claudeCommits ?? 0) > 0;
}

function daysBetweenIso(firstIso, lastIso) {
  if (!firstIso || !lastIso) return null;
  const a = Date.parse(firstIso);
  const b = Date.parse(lastIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(1, Math.round((b - a) / 86400000));
}

// Merges per-repo daily rows into one series. Dates are summed rather than deduplicated: two commits
// on the same day in two different repos are two commits, not one.
function mergeDaily(repos) {
  const byDate = new Map();
  for (const r of repos) {
    for (const d of r.daily ?? []) {
      const row = byDate.get(d.date) ?? { date: d.date, commits: 0, insertions: 0, deletions: 0 };
      row.commits += d.commits ?? 0;
      row.insertions += d.insertions ?? 0;
      row.deletions += d.deletions ?? 0;
      byDate.set(d.date, row);
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Rolls the daily series up to calendar months. The daily series is too sparse to read as a bar chart
// over a multi-month lifetime (most days have no commits at all), and the question this answers -
// "is my Claude-assisted commit volume growing?" - is a monthly-shaped question.
function monthlyFromDaily(daily) {
  const byMonth = new Map();
  for (const d of daily) {
    const month = d.date.slice(0, 7);
    const row = byMonth.get(month) ?? { month, commits: 0, insertions: 0, deletions: 0 };
    row.commits += d.commits;
    row.insertions += d.insertions;
    row.deletions += d.deletions;
    byMonth.set(month, row);
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

export function buildGitActivity(harvest) {
  if (!harvest || !harvest.available) {
    return {
      available: false,
      reason: harvest?.reason ?? 'git harvest not run',
      reposDiscovered: harvest?.reposDiscovered ?? 0,
      skipped: harvest?.skipped ?? [],
    };
  }

  const repos = (harvest.repos ?? []).slice().sort((a, b) => (b.claudeCommits ?? 0) - (a.claudeCommits ?? 0));
  const contributing = repos.filter(isInteresting);

  const claudeCommits = repos.reduce((a, r) => a + (r.claudeCommits ?? 0), 0);
  const claudeMerges = repos.reduce((a, r) => a + (r.claudeMerges ?? 0), 0);
  const authoredCommits = repos.reduce((a, r) => a + (r.authoredCommits ?? 0), 0);
  const insertions = repos.reduce((a, r) => a + (r.insertions ?? 0), 0);
  const deletions = repos.reduce((a, r) => a + (r.deletions ?? 0), 0);
  const filesChanged = repos.reduce((a, r) => a + (r.filesChanged ?? 0), 0);
  const binaryFiles = repos.reduce((a, r) => a + (r.binaryFiles ?? 0), 0);

  const firsts = repos.map((r) => r.firstClaudeCommitAt).filter(Boolean).sort();
  const lasts = repos.map((r) => r.lastClaudeCommitAt).filter(Boolean).sort();
  const firstClaudeCommitAt = firsts[0] ?? null;
  const lastClaudeCommitAt = lasts[lasts.length - 1] ?? null;

  const daily = mergeDaily(repos);
  const monthly = monthlyFromDaily(daily);

  return {
    available: true,
    gitVersion: harvest.gitVersion ?? null,
    markers: harvest.markers ?? [],
    // Count only - the addresses themselves stay out of the report shape that gets rendered. See the
    // header note; gitHarvest keeps the raw list for --merge, which reads it from the scan, not here.
    identityCount: (harvest.authorEmails ?? []).length,
    reposDiscovered: harvest.reposDiscovered ?? repos.length,
    reposHarvested: repos.length,
    reposWithClaudeCommits: contributing.length,
    skipped: harvest.skipped ?? [],

    claudeCommits,
    // Merge commits are excluded from the headline because a merge carrying the trailer would
    // double-count the branch commits underneath it. Surfaced separately so the report can say what
    // was left out rather than leaving a reader to wonder why two counts disagree.
    claudeMergesExcluded: claudeMerges,
    authoredCommits,
    // "Of the commits you wrote, this share was Claude-assisted." Both numerator and denominator are
    // restricted to your own author identity, so this is not diluted by a shared repo's other authors.
    claudeSharePct: authoredCommits ? (claudeCommits / authoredCommits) * 100 : null,

    // Real diff numbers from the commits themselves - not the Write/Edit tool-call estimate reported
    // in the "Code written" section, which cannot see reverts, rewrites, or anything done by other
    // means. These two will not agree, and are not meant to.
    insertions,
    deletions,
    netLines: insertions - deletions,
    filesChanged,
    binaryFiles,

    firstClaudeCommitAt,
    lastClaudeCommitAt,
    spanDays: daysBetweenIso(firstClaudeCommitAt, lastClaudeCommitAt),

    repos: contributing.map((r) => ({
      name: r.name,
      // "owner/repo" from the remote when there is one - what a person actually calls the repository,
      // as opposed to the name of whatever directory it is checked out into.
      fullName: r.fullName ?? null,
      remote: r.remote ?? null,
      path: r.path,
      // Linked worktrees and second clones that were folded into this row.
      aliasPaths: r.aliasPaths ?? [],
      rootCommitKey: r.rootCommitKey ?? null,
      claudeCommits: r.claudeCommits,
      authoredCommits: r.authoredCommits,
      claudeSharePct: r.authoredCommits ? (r.claudeCommits / r.authoredCommits) * 100 : null,
      insertions: r.insertions,
      deletions: r.deletions,
      firstClaudeCommitAt: r.firstClaudeCommitAt,
      lastClaudeCommitAt: r.lastClaudeCommitAt,
    })),
    daily,
    monthly,
  };
}

// --merge: two machines can legitimately hold the same repository (two clones of one project), so
// repos are combined by rootCommitKey - the hash of the root commit, which is identical in every
// clone everywhere - rather than by path, which is machine-specific. Summing by path would count a
// shared repo twice; summing by name would collide two unrelated repos that happen to share a
// directory name.
//
// Within one repo key the per-day rows are summed rather than max-ed: the same commit cannot appear
// on two machines' harvest of the same repo unless both machines have it, which is exactly when
// summing WOULD be wrong. That case is handled by taking the maximum per calendar date instead - a
// commit is a fact about the repository, not about the machine that read it.
export function mergeGitActivity(list) {
  const withGit = list.filter((rd) => rd.gitActivity?.available);
  if (!withGit.length) {
    const anyReason = list.map((rd) => rd.gitActivity?.reason).find(Boolean);
    return { available: false, reason: anyReason ?? 'no source reported git activity', reposDiscovered: 0, skipped: [] };
  }

  const byRepo = new Map();
  const skipped = [];
  const markers = new Set();
  let identityCount = 0;
  let reposDiscovered = 0;

  for (const rd of withGit) {
    const g = rd.gitActivity;
    for (const m of g.markers ?? []) markers.add(m);
    identityCount += g.identityCount ?? 0;
    reposDiscovered += g.reposDiscovered ?? 0;
    for (const s of g.skipped ?? []) skipped.push(s);

    for (const r of g.repos ?? []) {
      // Falls back to the path when a root-commit key is missing (an empty repo, or a source report
      // written before this field existed) - a path is still better than merging unrelated repos.
      const key = r.rootCommitKey || `path:${r.path}`;
      const cur = byRepo.get(key);
      if (!cur) {
        byRepo.set(key, { ...r, aliasPaths: [...(r.aliasPaths ?? [])], daily: [] });
        continue;
      }
      // Identity fields: keep the most specific one any source managed to resolve. A machine whose
      // clone has no remote configured still contributes its counts, but should not overwrite a
      // canonical "owner/repo" that another machine did resolve.
      cur.fullName = cur.fullName ?? r.fullName ?? null;
      cur.remote = cur.remote ?? r.remote ?? null;
      if (!cur.fullName && r.name && r.name.length > (cur.name ?? '').length) cur.name = r.name;
      // Alias paths are machine-specific, so they union rather than replace - the same repo can sit
      // at a different path on each machine, and all of them are true.
      cur.aliasPaths = [...new Set([...(cur.aliasPaths ?? []), ...(r.aliasPaths ?? []), r.path].filter(Boolean))]
        .filter((ap) => ap !== cur.path);
      // Same repository seen from two machines. Commit counts are a property of the repo, so take the
      // larger view rather than adding them - whichever machine had more refs fetched saw more.
      cur.claudeCommits = Math.max(cur.claudeCommits ?? 0, r.claudeCommits ?? 0);
      cur.authoredCommits = Math.max(cur.authoredCommits ?? 0, r.authoredCommits ?? 0);
      cur.insertions = Math.max(cur.insertions ?? 0, r.insertions ?? 0);
      cur.deletions = Math.max(cur.deletions ?? 0, r.deletions ?? 0);
      cur.claudeSharePct = cur.authoredCommits ? (cur.claudeCommits / cur.authoredCommits) * 100 : null;
      if (r.firstClaudeCommitAt && (!cur.firstClaudeCommitAt || r.firstClaudeCommitAt < cur.firstClaudeCommitAt)) {
        cur.firstClaudeCommitAt = r.firstClaudeCommitAt;
      }
      if (r.lastClaudeCommitAt && (!cur.lastClaudeCommitAt || r.lastClaudeCommitAt > cur.lastClaudeCommitAt)) {
        cur.lastClaudeCommitAt = r.lastClaudeCommitAt;
      }
    }
  }

  // Report JSON carries only the combined daily series per source, not a per-repo breakdown, so the
  // merged series is folded date-by-date with the same max-wins rule the totals above use.
  const daily = mergeDailyMaxByDate(withGit.map((rd) => rd.gitActivity.daily ?? []));
  const repos = [...byRepo.values()].sort((a, b) => (b.claudeCommits ?? 0) - (a.claudeCommits ?? 0));

  const claudeCommits = repos.reduce((a, r) => a + (r.claudeCommits ?? 0), 0);
  const authoredCommits = repos.reduce((a, r) => a + (r.authoredCommits ?? 0), 0);
  const insertions = repos.reduce((a, r) => a + (r.insertions ?? 0), 0);
  const deletions = repos.reduce((a, r) => a + (r.deletions ?? 0), 0);
  const firsts = repos.map((r) => r.firstClaudeCommitAt).filter(Boolean).sort();
  const lasts = repos.map((r) => r.lastClaudeCommitAt).filter(Boolean).sort();
  const firstClaudeCommitAt = firsts[0] ?? null;
  const lastClaudeCommitAt = lasts[lasts.length - 1] ?? null;

  return {
    available: true,
    gitVersion: withGit.map((rd) => rd.gitActivity.gitVersion).find(Boolean) ?? null,
    markers: [...markers],
    identityCount,
    reposDiscovered,
    reposHarvested: repos.length,
    reposWithClaudeCommits: repos.filter(isInteresting).length,
    skipped,
    claudeCommits,
    claudeMergesExcluded: withGit.reduce((a, rd) => a + (rd.gitActivity.claudeMergesExcluded ?? 0), 0),
    authoredCommits,
    claudeSharePct: authoredCommits ? (claudeCommits / authoredCommits) * 100 : null,
    insertions,
    deletions,
    netLines: insertions - deletions,
    filesChanged: withGit.reduce((a, rd) => a + (rd.gitActivity.filesChanged ?? 0), 0),
    binaryFiles: withGit.reduce((a, rd) => a + (rd.gitActivity.binaryFiles ?? 0), 0),
    firstClaudeCommitAt,
    lastClaudeCommitAt,
    spanDays: daysBetweenIso(firstClaudeCommitAt, lastClaudeCommitAt),
    repos,
    daily,
    monthly: monthlyFromDaily(daily),
  };
}

// Max-wins per calendar date across sources. Two machines that both hold the same repo report the
// same commits on the same day; summing would double them. Two machines holding entirely different
// repos is the case this under-counts, and it is the safer direction to err in for a figure already
// presented as a floor.
function mergeDailyMaxByDate(series) {
  const byDate = new Map();
  for (const rows of series) {
    for (const d of rows) {
      const cur = byDate.get(d.date);
      if (!cur || (d.commits ?? 0) > (cur.commits ?? 0)) byDate.set(d.date, { ...d });
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
