// The product's repositories: base clones under workspaces/, one worktree per repo per issue.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { p, loadConfig } from './config.mjs';
const studio = () => { try { return loadConfig().company?.name ?? 'The studio'; } catch { return 'The studio'; } };
import { gh } from './tracker.mjs';

const exec = promisify(execFile);
export const git = async (args, cwd) => (await exec('git', args, { cwd, maxBuffer: 64 << 20 })).stdout.trim();

let lock = Promise.resolve();
const locked = (fn) => { const r = lock.then(fn, fn); lock = r.catch(() => {}); return r; };

export const baseDir = (r) => p('workspaces', r.repo.replace('/', '__'));
export const issueDir = (n) => p('workspaces/wt', `issue-${n}`);
export const branch = (n) => `sf/issue-${n}`;

/** Clone (or fetch) a repo's base checkout. Returns its path. */
export function ensureBase(r) {
  return locked(async () => {
    const base = baseDir(r);
    if (!existsSync(base)) { mkdirSync(p('workspaces'), { recursive: true }); await gh(['repo', 'clone', r.repo, base]); }
    // An empty repo has no branch to work from: make the first commit on the default branch (a README), so work can branch off it.
    if (!(await git(['ls-remote', '--heads', 'origin'], base))) {
      writeFileSync(`${base}/README.md`, `# ${r.name}\n\n${r.about || 'Client project'}\n\nBuilt by ${studio()}'s software factory. Work arrives as planned releases; see the GitHub milestones.\n`);
      const id = ['-c', `user.name=${studio()} factory`, '-c', 'user.email=factory@localhost'];
      await git(['checkout', '-q', '-B', r.default_branch], base);
      await git(['add', 'README.md'], base);
      await git([...id, 'commit', '-q', '-m', 'Initial commit'], base);
      await git(['push', '-q', '-u', 'origin', r.default_branch], base);
    }
    await git(['fetch', 'origin', '--prune'], base);
    await git(['checkout', '-q', '--detach', `origin/${r.default_branch}`], base);
    return base;
  });
}

/** workspaces/wt/issue-<n>/<repo name>/ for each repo, all on branch sf/issue-<n>. Returns the parent dir. */
export async function worktrees(n, repos) {
  for (const r of repos) {
    await ensureBase(r);
    await locked(async () => {
      const base = baseDir(r), wt = `${issueDir(n)}/${r.name}`, br = branch(n);
      if (existsSync(wt)) return;
      const remote = await git(['ls-remote', '--heads', 'origin', br], base);
      await git(['worktree', 'add', '-B', br, wt, remote ? `origin/${br}` : `origin/${r.default_branch}`], base);
    });
  }
  return issueDir(n);
}

export function dropWorktrees(n, repos) {
  return locked(async () => {
    for (const r of repos) {
      const wt = `${issueDir(n)}/${r.name}`;
      if (existsSync(wt)) await git(['worktree', 'remove', '--force', wt], baseDir(r)).catch(() => {});
    }
  });
}

export async function commitsAhead(n, r) {
  const wt = `${issueDir(n)}/${r.name}`;
  if (!existsSync(wt)) return 0;
  return Number(await git(['rev-list', '--count', `origin/${r.default_branch}..HEAD`], wt));
}

// Push the worktree's HEAD to the issue branch, whatever the local branch is called, so work can never be stranded on a side branch.
export const push = (n, r) => git(['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${branch(n)}`], `${issueDir(n)}/${r.name}`);
