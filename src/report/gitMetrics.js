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
    identityCount: (harvest.identityKeys ?? harvest.authorEmails ?? []).length,
    // Hashed identities, so --merge can tell "one person on two machines" from "two people" without
    // any report file carrying an email address.
    identityKeys: harvest.identityKeys ?? [],
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
      // The individual root commits, not only the joined key. --merge matches on any SHARED root
      // rather than on set equality, because `rev-list --all` only sees the refs a given machine has
      // fetched - two machines can compute different joined keys for one repository.
      rootCommits: r.rootCommits ?? [],
      claudeCommits: r.claudeCommits,
      authoredCommits: r.authoredCommits,
      claudeSharePct: r.authoredCommits ? (r.claudeCommits / r.authoredCommits) * 100 : null,
      insertions: r.insertions,
      deletions: r.deletions,
      // Carried per repo so a merge can re-derive the totals from the DEDUPLICATED repo list. These
      // were previously summed per source, which doubled them whenever two machines held the same
      // repository - the totals above deduplicated correctly while these three did not.
      filesChanged: r.filesChanged ?? 0,
      binaryFiles: r.binaryFiles ?? 0,
      claudeMerges: r.claudeMerges ?? 0,
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

  // Every key that could identify this repository. A repo is the same repo as another if they share
  // ANY of these - not if some single canonical key happens to agree:
  //   - the remote, which is the most stable signal across machines and survives shallow and partial
  //     clones that would change which root commits are locally visible;
  //   - any individual root commit. Set equality is NOT safe here: `rev-list --max-parents=0 --all`
  //     only reports roots reachable from refs the machine has actually fetched, and a repo with more
  //     than one root (a subtree merge - one of the repos this was developed against has two) will
  //     yield different sets on two machines with different refs, which would defeat the dedupe and
  //     double every figure derived from it.
  const keysFor = (r) => {
    const keys = [];
    if (r.remote) keys.push(`remote:${r.remote}`);
    for (const root of r.rootCommits ?? []) keys.push(`root:${root}`);
    if (!keys.length && r.rootCommitKey) keys.push(`rootkey:${r.rootCommitKey}`);
    if (!keys.length && r.path) keys.push(`path:${r.path}`);
    return keys;
  };

  // Same-repo figures are a property of the repository, so the larger view wins rather than the sum:
  // whichever machine had more refs fetched simply saw more of the same history.
  const foldInto = (cur, r) => {
    cur.claudeCommits = Math.max(cur.claudeCommits ?? 0, r.claudeCommits ?? 0);
    cur.authoredCommits = Math.max(cur.authoredCommits ?? 0, r.authoredCommits ?? 0);
    cur.insertions = Math.max(cur.insertions ?? 0, r.insertions ?? 0);
    cur.deletions = Math.max(cur.deletions ?? 0, r.deletions ?? 0);
    cur.filesChanged = Math.max(cur.filesChanged ?? 0, r.filesChanged ?? 0);
    cur.binaryFiles = Math.max(cur.binaryFiles ?? 0, r.binaryFiles ?? 0);
    cur.claudeMerges = Math.max(cur.claudeMerges ?? 0, r.claudeMerges ?? 0);
    cur.claudeSharePct = cur.authoredCommits ? (cur.claudeCommits / cur.authoredCommits) * 100 : null;
    cur.fullName = cur.fullName ?? r.fullName ?? null;
    cur.remote = cur.remote ?? r.remote ?? null;
    if (!cur.fullName && r.name && r.name.length > (cur.name ?? '').length) cur.name = r.name;
    cur.rootCommits = [...new Set([...(cur.rootCommits ?? []), ...(r.rootCommits ?? [])])];
    // Paths are machine-specific, so every checkout of this repo on any machine is true at once.
    cur.aliasPaths = [...new Set([...(cur.aliasPaths ?? []), ...(r.aliasPaths ?? []), r.path].filter(Boolean))].filter(
      (ap) => ap !== cur.path
    );
    if (r.firstClaudeCommitAt && (!cur.firstClaudeCommitAt || r.firstClaudeCommitAt < cur.firstClaudeCommitAt)) {
      cur.firstClaudeCommitAt = r.firstClaudeCommitAt;
    }
    if (r.lastClaudeCommitAt && (!cur.lastClaudeCommitAt || r.lastClaudeCommitAt > cur.lastClaudeCommitAt)) {
      cur.lastClaudeCommitAt = r.lastClaudeCommitAt;
    }
    return cur;
  };

  const byKey = new Map(); // any key -> the entry it belongs to
  const entries = new Set();
  const skipped = [];
  const markers = new Set();
  const identityKeys = new Set();
  let identityCountFallback = 0;
  let reposDiscovered = 0;

  for (const rd of withGit) {
    const g = rd.gitActivity;
    for (const m of g.markers ?? []) markers.add(m);
    for (const k of g.identityKeys ?? []) identityKeys.add(k);
    if (!(g.identityKeys ?? []).length) identityCountFallback = Math.max(identityCountFallback, g.identityCount ?? 0);
    reposDiscovered += g.reposDiscovered ?? 0;
    for (const sk of g.skipped ?? []) skipped.push(sk);

    for (const r of g.repos ?? []) {
      const keys = keysFor(r);
      // A new repo can match several existing entries at once (machine A knew it by remote, machine B
      // by a root commit, and this one carries both) - those entries were the same repository all
      // along and are collapsed together here rather than left as duplicates.
      const matched = [...new Set(keys.map((k) => byKey.get(k)).filter(Boolean))];
      let entry;
      if (!matched.length) {
        entry = { ...r, rootCommits: [...(r.rootCommits ?? [])], aliasPaths: [...(r.aliasPaths ?? [])] };
        entries.add(entry);
      } else {
        entry = matched[0];
        for (const other of matched.slice(1)) {
          foldInto(entry, other);
          entries.delete(other);
          for (const [k, v] of byKey) if (v === other) byKey.set(k, entry);
        }
        foldInto(entry, r);
      }
      for (const k of [...keys, ...keysFor(entry)]) byKey.set(k, entry);
    }
  }

  const repos = [...entries].sort((a, b) => (b.claudeCommits ?? 0) - (a.claudeCommits ?? 0));
  const sum = (f) => repos.reduce((a, r) => a + (f(r) ?? 0), 0);

  const claudeCommits = sum((r) => r.claudeCommits);
  const authoredCommits = sum((r) => r.authoredCommits);
  const insertions = sum((r) => r.insertions);
  const deletions = sum((r) => r.deletions);
  const firsts = repos.map((r) => r.firstClaudeCommitAt).filter(Boolean).sort();
  const lasts = repos.map((r) => r.lastClaudeCommitAt).filter(Boolean).sort();
  const firstClaudeCommitAt = firsts[0] ?? null;
  const lastClaudeCommitAt = lasts[lasts.length - 1] ?? null;

  // Report JSON carries only a combined daily series per source, not a per-repo breakdown, so the
  // merged series is folded date-by-date, max-wins. This is the one figure here that stays an
  // approximation: two machines holding entirely different repos that both saw commits on the same
  // date will report the larger of the two rather than their sum. It errs downward, which is the
  // right direction for a number already presented as a floor, and the per-repo totals above - which
  // are exact - are what every headline is built from.
  const daily = mergeDailyMaxByDate(withGit.map((rd) => rd.gitActivity.daily ?? []));

  return {
    available: true,
    gitVersion: withGit.map((rd) => rd.gitActivity.gitVersion).find(Boolean) ?? null,
    markers: [...markers],
    // Hashed, so the same person on two machines counts once instead of twice.
    identityCount: identityKeys.size || identityCountFallback,
    identityKeys: [...identityKeys],
    reposDiscovered,
    reposHarvested: repos.length,
    reposWithClaudeCommits: repos.filter(isInteresting).length,
    skipped,
    claudeCommits,
    // All three are now derived from the deduplicated repo list, not summed per source. Summing them
    // doubled each one whenever two machines held the same repository, while the commit and line
    // totals beside them deduplicated correctly - a silent inconsistency inside one section.
    claudeMergesExcluded: sum((r) => r.claudeMerges),
    filesChanged: sum((r) => r.filesChanged),
    binaryFiles: sum((r) => r.binaryFiles),
    authoredCommits,
    claudeSharePct: authoredCommits ? (claudeCommits / authoredCommits) * 100 : null,
    insertions,
    deletions,
    netLines: insertions - deletions,
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
