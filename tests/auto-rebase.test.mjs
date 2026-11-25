// Rework review (2026-11-25): a parent PR merging underneath sent #20, #3 and #5 back to a full build run only to rebase.
// The dispatcher now rebases when git can do it cleanly, and leaves everything else to the engineer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { autoRebase, issueDir, branch } from '../factory/lib/repos.mjs';

const N = 999_983; // no such issue: its worktree folder is created here and removed after each test
const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
const r = { name: 'demo', repo: 'o/demo', default_branch: 'main' };

/** origin with main (a.txt, b.txt) and the issue branch (edits b.txt), checked out as the issue's worktree. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sf-rebase-')), origin = path.join(root, 'origin.git'), dev = path.join(root, 'dev');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, dev]);
  writeFileSync(path.join(dev, 'a.txt'), 'a\n'); writeFileSync(path.join(dev, 'b.txt'), 'b\n');
  git(dev, 'add', '.'); git(dev, 'commit', '-q', '-m', 'base'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
  git(dev, 'checkout', '-q', '-b', branch(N)); writeFileSync(path.join(dev, 'b.txt'), 'b from the issue\n');
  git(dev, 'commit', '-q', '-am', 'issue work'); git(dev, 'push', '-q', 'origin', `HEAD:${branch(N)}`);
  const wt = path.join(issueDir(N), r.name);
  execFileSync('git', ['clone', '-q', '-b', branch(N), origin, wt]);
  const parent = (file, text) => { // another PR merges into main underneath
    git(dev, 'checkout', '-q', 'main'); writeFileSync(path.join(dev, file), text); git(dev, 'commit', '-q', '-am', `parent edits ${file}`); git(dev, 'push', '-q', 'origin', 'HEAD:main');
    return git(dev, 'rev-parse', 'HEAD');
  };
  const done = () => { rmSync(root, { recursive: true, force: true }); rmSync(issueDir(N), { recursive: true, force: true }); };
  return { origin, wt, parent, done };
}

test('a clean rebase is done and pushed, leased on the PR head', async () => {
  const f = fixture();
  try {
    const main = f.parent('a.txt', 'a from the parent\n');
    const res = await autoRebase(N, r);
    assert.equal(res.result, 'rebased');
    assert.notEqual(res.to, res.from);
    assert.equal(git(f.origin, 'rev-parse', branch(N)), res.to, 'the PR branch now holds the rebased commit');
    assert.equal(git(f.origin, 'rev-parse', `${branch(N)}~1`), main, 'on top of the new default branch');
    assert.equal(git(f.wt, 'show', 'HEAD:b.txt'), 'b from the issue', 'the issue\'s change is kept');
  } finally { f.done(); }
});

test('a real conflict is left to the engineer: aborted, nothing pushed', async () => {
  const f = fixture();
  try {
    const before = git(f.origin, 'rev-parse', branch(N));
    f.parent('b.txt', 'b from the parent\n');
    const res = await autoRebase(N, r);
    assert.equal(res.result, 'conflict');
    assert.equal(git(f.wt, 'rev-parse', 'HEAD'), before, 'worktree back where it was');
    assert.ok(!existsSync(path.join(f.wt, '.git', 'rebase-merge')), 'no rebase left in progress');
    assert.equal(git(f.origin, 'rev-parse', branch(N)), before, 'PR branch untouched');
  } finally { f.done(); }
});

test('uncommitted or unpushed work is never rebased', async () => {
  const f = fixture();
  try {
    f.parent('a.txt', 'a from the parent\n');
    writeFileSync(path.join(f.wt, 'b.txt'), 'half-done\n');
    assert.equal((await autoRebase(N, r)).result, 'dirty');
    git(f.wt, 'commit', '-q', '-am', 'local only');
    assert.equal((await autoRebase(N, r)).result, 'diverged', 'the worktree must hold exactly what the PR holds');
  } finally { f.done(); }
});

test('no worktree: nothing to do', async () => {
  assert.equal((await autoRebase(N, r)).result, 'missing');
});
