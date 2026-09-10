import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verbose } from '../util/log.js';

// Reads real git history out of the repositories you actually work in, rather than inferring it from
// transcripts. This is the only part of the tool that looks outside ~/.claude.
//
// Why it exists: an earlier version of the report counted `git commit` and `git push` shell
// invocations found in transcripts and presented them as commits and pushes. That was wrong three
// ways over - it counted attempts rather than commits that landed (a rejected pre-commit hook, an
// --amend, or a retry after a conflict each scored one), it was blind to every commit made outside a
// Claude Code session, and transcript rotation capped it at ~30 days on a page framed as all-time. On
// the corpus this was built against it read 645 "commits" for a month against 1,681 real
// Claude-attributed commits in the underlying repositories since January. Rather than footnote a
// number that wrong, the transcript-derived figures were removed and replaced with this.
//
// STRICTLY READ-ONLY. Every git invocation here is a query - `rev-parse`, `rev-list`, `log`, `var`.
// Nothing writes, checks out, fetches, or touches the index or the working tree, so running this
// cannot disturb a repo you have work in progress in. Commands are run through execFileSync with an
// argument array and never through a shell, so a repository path can never be interpreted as a
// command. `-c core.fsmonitor=false` and the --no-optional-locks flag keep git from taking even the
// incidental locks a read command would normally take.
//
// Four problems this has to solve, all of which were confirmed against real data rather than assumed:
//
//   1. WORKTREES SHARE HISTORY. A `git worktree` checkout reports its parent repository's entire
//      history, so harvesting per directory double-counts. Two of the directories discovered on the
//      machine this was built against, two directories with unrelated-looking names reported an
//      identical 7,998 commits / 1,224 Claude commits for exactly this reason - one was a linked
//      worktree of the other. Deduped on the identity of the history rather than the path.
//
//   2. SHARED REPOS CONTAIN OTHER PEOPLE'S CLAUDE COMMITS. In one team repo here, the 392 commits
//      carrying a Claude trailer were authored by at least five different people. Counting them all
//      would report the whole team's Claude usage as yours - a worse error than the one this replaces.
//      Every query is therefore constrained to your own author identity (see resolveAuthorIdentity).
//
//   3. IDENTITY IS NOT ALWAYS IN A CONFIG FILE. `git config user.email` returned nothing on this
//      machine even though every commit carries an author - the identity was coming from somewhere
//      else in git's resolution chain. `git var GIT_AUTHOR_IDENT` asks git to resolve the effective
//      identity the same way a real commit would, which is the only reliable way to ask.
//
//   4. ATTRIBUTION IS A CONVENTION, NEVER A GUARANTEE. A commit is counted as Claude-assisted only if
//      its message carries one of the markers below. Commits from a session that did not emit one, or
//      from before the convention was adopted, are invisible. Every figure this produces is therefore
//      a FLOOR, and is labelled as one everywhere it is displayed. It is never presented as a total.

// Matched case-insensitively against the commit message (subject + body, so trailers count).
// Deliberately two markers, not one: the Co-Authored-By trailer is the common case, but the
// "Generated with Claude Code" footer appears on commits whose trailer was stripped by a squash or a
// rebase, and both were present in real history here (392 and 10 respectively in one repo).
export const ATTRIBUTION_MARKERS = ['Co-Authored-By: Claude', 'Generated with [Claude Code]'];

const GIT_TIMEOUT_MS = 30000;
const MAX_BUFFER = 64 * 1024 * 1024; // a 26k-commit `git log` is a few MB; this is deliberate headroom
const RS = '\x1e'; // record separator - cannot occur in a commit hash, ISO date or email
const FS = '\x1f'; // field separator

// Global read-only hardening applied to every invocation. --no-optional-locks stops git taking the
// index lock it would otherwise grab to refresh stat information, so this can never contend with an
// editor or a build running in the same repo.
const GIT_BASE_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0'];

function git(repoDir, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return execFileSync('git', ['-C', repoDir, ...GIT_BASE_ARGS, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Returns null rather than throwing - almost every call site treats "this repo could not be read" as
// a skip with a recorded reason, not as a failed run.
function gitOrNull(repoDir, args, opts) {
  try {
    return git(repoDir, args, opts).trim();
  } catch {
    return null;
  }
}

export function isGitAvailable() {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

export function gitVersion() {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// The effective author identity git would stamp on a commit made right now, resolved through the full
// config chain (system -> global -> repo -> environment). Parsed out of `git var GIT_AUTHOR_IDENT`,
// whose format is "Name <email> <unix-ts> <tz>".
//
// Asked per repo rather than once globally, because a repo-local user.email is exactly how someone
// separates a work identity from a personal one, and collapsing them would silently attribute one
// to the other. The caller keeps the resulting set.
export function resolveAuthorIdentity(repoDir) {
  const raw = gitOrNull(repoDir, ['var', 'GIT_AUTHOR_IDENT']);
  if (!raw) return null;
  const m = /<([^>]*)>/.exec(raw);
  const email = m?.[1]?.trim();
  return email ? email.toLowerCase() : null;
}

// A repository's stable identity, independent of where it happens to be checked out. The hash of the
// root (parentless) commit is the same in every clone on every machine, which is what makes it the
// right dedupe key when --merge combines reports from two machines that both have the same repo.
// A repo with several root commits (grafted/subtree history) yields several; they are sorted and
// joined so the key is deterministic.
export function rootCommitKey(repoDir) {
  const raw = gitOrNull(repoDir, ['rev-list', '--max-parents=0', '--all']);
  if (!raw) return null;
  const roots = raw.split('\n').map((l) => l.trim()).filter(Boolean).sort();
  return roots.length ? roots.join(',') : null;
}

// A remote URL can legitimately carry credentials (https://user:token@host/owner/repo.git), and this
// string ends up in a report file that gets shared and merged. Userinfo is stripped before the URL is
// ever stored. Both URL shapes git accepts are handled: the https form and the scp-like SSH form
// (git@host:owner/repo.git), which is not a parseable URL and has to be matched directly.
function sanitizeRemoteUrl(url) {
  if (!url) return null;
  const scp = /^([^@/]+@)?([^:/]+):(.+)$/.exec(url);
  if (scp && !url.includes('://')) return `${scp[2]}/${scp[3].replace(/\.git$/, '')}`;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\.git$/, '')}`;
  } catch {
    return url.replace(/^[^@]*@/, '').replace(/\.git$/, '');
  }
}

// "owner/repo" out of a sanitized remote, which is what a person actually calls the repository -
// far more recognisable than the name of whatever directory it happens to be checked out into.
function ownerRepoFromRemote(sanitized) {
  if (!sanitized) return null;
  const parts = sanitized.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join('/');
}

// The MAIN worktree of a repository - the checkout that owns the real .git directory. `git worktree
// list --porcelain` always lists it first, whichever worktree the question is asked from.
//
// This is what a repository should be identified and named by. Naming it after whichever directory
// the scan happened to reach first is how a linked worktree ends up standing in for the repository -
// on the machine this was built against, two of the three rows in the report came out labelled with a
// worktree's directory name instead of the repo it belonged to. The commit counts were right, since
// those directories share one history and that is the whole point of the dedupe, but the labels named
// the wrong thing, which is its own kind of wrong answer.
function mainWorktree(dir) {
  const raw = gitOrNull(dir, ['worktree', 'list', '--porcelain']);
  if (!raw) return null;
  const first = raw.split('\n').find((l) => l.startsWith('worktree '));
  return first ? path.resolve(first.slice('worktree '.length).trim()) : null;
}

// Resolves one candidate directory to the repository that owns it, or null if it is not in a repo.
// The dedupe key is the *common* git dir: for a worktree that is the parent repo's .git, which is
// precisely how two directories that share history collapse into one entry.
function resolveRepo(dir) {
  const toplevel = gitOrNull(dir, ['rev-parse', '--show-toplevel']);
  if (!toplevel) return null;
  const commonRaw = gitOrNull(dir, ['rev-parse', '--git-common-dir']);
  if (!commonRaw) return null;
  // --git-common-dir answers relatively ('.git') in the main checkout and absolutely in a worktree,
  // so it has to be resolved against the directory it was asked from before it can be a dedupe key.
  const commonDir = normalizeKey(path.resolve(toplevel, commonRaw));

  // The identity that actually matters. A path-based key alone is not enough: on the machine this was
  // built against it let the same repository through three times, because separate clones, junctions
  // and differently-cased drive letters all present as distinct paths while sharing one history. The
  // root commit's hash is a property of the history itself, so it is identical in every clone of a
  // repo on every machine - two directories with the same root commit hold the same commits, and
  // counting both would double every figure derived from them.
  const rootKey = rootCommitKey(toplevel);

  // Everything downstream - harvesting, naming, the path shown in the report - keys off the main
  // worktree rather than the directory that happened to be discovered, so a linked worktree can never
  // stand in for the repository it belongs to. Falls back to the discovered path if the main worktree
  // has been deleted out from under its linked ones.
  const main = mainWorktree(toplevel);
  const canonicalPath = main && fs.existsSync(main) ? main : path.resolve(toplevel);
  const remote = sanitizeRemoteUrl(gitOrNull(canonicalPath, ['config', '--get', 'remote.origin.url']));
  const ownerRepo = ownerRepoFromRemote(remote);

  return {
    toplevel: path.resolve(toplevel),
    canonicalPath,
    isLinkedWorktree: normalizeKey(canonicalPath) !== normalizeKey(path.resolve(toplevel)),
    remote,
    // The remote's own name for the repository wins over the directory name: a checkout can be called
    // anything, but "owner/repo" from the remote is what the repository actually is.
    name: ownerRepo ? ownerRepo.split('/').pop() : path.basename(canonicalPath),
    fullName: ownerRepo,
    commonDir,
    rootKey,
    dedupeKey: rootKey || commonDir,
  };
}

// Windows reports the same directory with either drive-letter case and either separator depending on
// which git subcommand answered, so paths are folded before being compared.
function normalizeKey(p) {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Parses `git log --numstat` output emitted with our RS/FS record format. Each record is
//   RS <hash> FS <author-date> FS <author-email>
// followed by blank line and then zero or more "<added>\t<removed>\t<path>" lines. Binary files
// report '-' for both counts and contribute a changed file but no line counts, which is correct -
// invented line numbers for a PNG would be worse than none.
function parseNumstatLog(raw) {
  const commits = [];
  if (!raw) return commits;
  for (const chunk of raw.split(RS)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split('\n');
    const [hash, date, email] = (lines[0] ?? '').split(FS);
    if (!hash) continue;
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;
    let binaryFiles = 0;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      filesChanged += 1;
      if (parts[0] === '-' || parts[1] === '-') {
        binaryFiles += 1;
        continue;
      }
      insertions += Number.parseInt(parts[0], 10) || 0;
      deletions += Number.parseInt(parts[1], 10) || 0;
    }
    commits.push({
      hash,
      date: date ?? null,
      email: (email ?? '').toLowerCase(),
      insertions,
      deletions,
      filesChanged,
      binaryFiles,
    });
  }
  return commits;
}

function grepArgs() {
  // Multiple --grep terms are OR-ed by git. -i because the trailer's casing varies between the
  // "Co-Authored-By" and "Co-authored-by" spellings in real history. --fixed-strings so a marker
  // containing regex metacharacters ('[Claude Code]') matches literally rather than as a character class.
  return ['--fixed-strings', '-i', ...ATTRIBUTION_MARKERS.flatMap((m) => ['--grep', m])];
}

// Harvests one repository, constrained to the given set of author identities.
//
// --all so work that only ever lived on a branch still counts; --no-merges because a merge commit
// that carries the trailer would double-count the branch commits underneath it (47 such merges in one
// repo here). The merge count is collected separately rather than silently dropped, so the report can
// say what was excluded instead of leaving a reader to wonder.
function harvestRepo(repo, authorEmails, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const authorArgs = [...authorEmails].flatMap((e) => ['--author', e]);
  if (!authorArgs.length) return null;
  const opts = { timeoutMs };

  const claudeRaw = gitOrNull(repo.canonicalPath, [
    'log', '--all', '--no-merges', ...authorArgs, ...grepArgs(),
    '--numstat', `--format=${RS}%H${FS}%aI${FS}%ae`,
  ], opts);
  if (claudeRaw === null) return null;
  const claudeCommits = parseNumstatLog(claudeRaw);

  // Denominator: every non-merge commit you authored in this repo, Claude-assisted or not. This is
  // what makes the headline share meaningful - "X% of the commits you wrote here were Claude-assisted"
  // - rather than a bare count with nothing to scale it against.
  const allRaw = gitOrNull(repo.canonicalPath, ['log', '--all', '--no-merges', ...authorArgs, '--format=%aI'], opts);
  const authoredDates = allRaw ? allRaw.split('\n').map((l) => l.trim()).filter(Boolean) : [];

  const mergeRaw = gitOrNull(repo.canonicalPath, ['log', '--all', '--merges', ...authorArgs, ...grepArgs(), '--format=%H'], opts);
  const claudeMerges = mergeRaw ? mergeRaw.split('\n').filter((l) => l.trim()).length : 0;

  const insertions = claudeCommits.reduce((a, c) => a + c.insertions, 0);
  const deletions = claudeCommits.reduce((a, c) => a + c.deletions, 0);
  const filesChanged = claudeCommits.reduce((a, c) => a + c.filesChanged, 0);
  const binaryFiles = claudeCommits.reduce((a, c) => a + c.binaryFiles, 0);
  const dates = claudeCommits.map((c) => c.date).filter(Boolean).sort();

  // Per-day counts, keyed by the commit's own local calendar date as git reported it (%aI carries the
  // author's timezone offset, so slicing the date off it gives the day it was local to the author -
  // consistent with the local-time bucketing the hour-of-day and day-of-week charts use).
  const daily = new Map();
  for (const c of claudeCommits) {
    if (!c.date) continue;
    const day = c.date.slice(0, 10);
    const row = daily.get(day) ?? { date: day, commits: 0, insertions: 0, deletions: 0 };
    row.commits += 1;
    row.insertions += c.insertions;
    row.deletions += c.deletions;
    daily.set(day, row);
  }

  return {
    name: repo.name,
    fullName: repo.fullName ?? null,
    remote: repo.remote ?? null,
    path: repo.canonicalPath,
    // Other checkouts of this same repository that were discovered and folded in - linked worktrees,
    // or a second clone. Reported rather than hidden, because "why isn't the directory I work in
    // listed?" is the obvious question a deduplicated table provokes.
    aliasPaths: [...(repo.aliases ?? [])],
    rootCommitKey: repo.rootKey ?? null,
    claudeCommits: claudeCommits.length,
    claudeMerges,
    authoredCommits: authoredDates.length,
    insertions,
    deletions,
    filesChanged,
    binaryFiles,
    firstClaudeCommitAt: dates[0] ?? null,
    lastClaudeCommitAt: dates[dates.length - 1] ?? null,
    daily: [...daily.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

// Candidate directories come from the `cwd` recorded on transcript lines - an exact path, unlike the
// sanitized project directory names under ~/.claude/projects, which replace every path separator with
// a hyphen and so cannot be decoded back unambiguously when a directory name legitimately contains one.
//
// This does mean DISCOVERY is bounded by the ~30-day transcript window even though the HISTORY read
// out of each discovered repo is complete: a repo you worked in months ago but not recently will not
// be found. That is a far weaker limitation than the one it replaces (which bounded the data itself),
// and it is disclosed in the report rather than papered over. --git-repo adds paths by hand.
export function harvestGitActivity({ cwds = [], extraRepos = [], timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (!isGitAvailable()) {
    return { available: false, reason: 'git is not on PATH', repos: [], skipped: [] };
  }

  const candidates = [...new Set([...cwds, ...extraRepos].filter((d) => typeof d === 'string' && d))];
  const byCommonDir = new Map();
  const skipped = [];
  const authorEmails = new Set();

  for (const dir of candidates) {
    let exists = false;
    try {
      exists = fs.statSync(dir).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) {
      skipped.push({ path: dir, reason: 'directory no longer exists' });
      continue;
    }
    const repo = resolveRepo(dir);
    if (!repo) {
      skipped.push({ path: dir, reason: 'not a git repository' });
      continue;
    }
    // First directory to claim a given history wins; any later one holds the same commits - as a
    // worktree of it, a second clone of it, or the same path seen through a junction - and is recorded
    // as such rather than silently dropped or, worse, counted twice.
    if (byCommonDir.has(repo.dedupeKey)) {
      const owner = byCommonDir.get(repo.dedupeKey);
      if (normalizeKey(owner.canonicalPath) !== normalizeKey(repo.toplevel)) {
        const kind = owner.commonDir === repo.commonDir ? 'worktree of' : 'shares history with';
        skipped.push({ path: repo.toplevel, reason: `${kind} ${owner.name}` });
        owner.aliases.add(path.resolve(repo.toplevel));
      }
      continue;
    }
    // Recorded so the report can say "harvested once, via N checkouts" instead of leaving a reader to
    // wonder why a directory they work in every day is missing from the table.
    repo.aliases = new Set(repo.isLinkedWorktree ? [path.resolve(repo.toplevel)] : []);
    byCommonDir.set(repo.dedupeKey, repo);
    const email = resolveAuthorIdentity(repo.canonicalPath);
    if (email) authorEmails.add(email);
  }

  if (!authorEmails.size) {
    return {
      available: false,
      reason: 'could not resolve your git author identity (git var GIT_AUTHOR_IDENT returned nothing)',
      repos: [],
      skipped,
      reposDiscovered: byCommonDir.size,
    };
  }

  const repos = [];
  for (const repo of byCommonDir.values()) {
    let harvested = null;
    try {
      harvested = harvestRepo(repo, authorEmails, { timeoutMs });
    } catch (err) {
      skipped.push({ path: repo.canonicalPath, reason: `git read failed: ${err.message}` });
      continue;
    }
    if (!harvested) {
      skipped.push({ path: repo.canonicalPath, reason: 'git log returned nothing readable' });
      continue;
    }
    verbose(`Harvested ${harvested.name}: ${harvested.claudeCommits} Claude-attributed of ${harvested.authoredCommits} authored commit(s).`);
    repos.push(harvested);
  }

  return {
    available: true,
    gitVersion: gitVersion(),
    markers: ATTRIBUTION_MARKERS,
    // Kept for --merge to dedupe identities across machines, and so the report can say how many
    // identities were involved. The addresses themselves are never rendered into the HTML - see
    // report/gitMetrics.js.
    authorEmails: [...authorEmails],
    reposDiscovered: byCommonDir.size,
    repos,
    skipped,
  };
}
