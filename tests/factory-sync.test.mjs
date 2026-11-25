// Owner request #132: after an owner-approved factory merge, the running checkout fast-forwards to it, and fails closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Dispatcher } from '../factory/lib/dispatcher.mjs';

const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd: dir, encoding: 'utf8' }).trim();
const cfg = { product: { tracker: 'o/t', repos: [] }, environments: ['staging'], pipeline: {} };

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sf-sync-')), origin = path.join(root, 'origin.git'), running = path.join(root, 'running'), dev = path.join(root, 'dev');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, dev]);
  writeFileSync(path.join(dev, 'a.txt'), 'one\n'); git(dev, 'add', '.'); git(dev, 'commit', '-q', '-m', 'one'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
  execFileSync('git', ['clone', '-q', origin, running]);
  writeFileSync(path.join(dev, 'a.txt'), 'two\n'); git(dev, 'commit', '-q', '-am', 'two (the merged factory change)'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
  return { root, running, sha: git(dev, 'rev-parse', 'HEAD') };
}

test('#132: the running checkout fast-forwards to the merge', async () => {
  const f = fixture(), d = new Dispatcher(cfg);
  d.factory = { name: 'software-factory', repo: 'o/f', default_branch: 'main', factory: true };
  const s = await d.syncFactory(f.sha, f.running);
  assert.equal(s.ok, true, s.reason);
  assert.equal(s.head, f.sha, 'local HEAD is the merge');
  rmSync(f.root, { recursive: true, force: true });
});

test('#132: local changes fail closed and leave the checkout untouched', async () => {
  const f = fixture(), d = new Dispatcher(cfg);
  d.factory = { name: 'software-factory', repo: 'o/f', default_branch: 'main', factory: true };
  const before = git(f.running, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.running, 'a.txt'), 'edited by hand\n');
  const s = await d.syncFactory(f.sha, f.running);
  assert.equal(s.ok, false);
  assert.match(s.reason, /local changes/);
  assert.equal(git(f.running, 'rev-parse', 'HEAD'), before, 'no false "done": HEAD did not move');
  rmSync(f.root, { recursive: true, force: true });
});
