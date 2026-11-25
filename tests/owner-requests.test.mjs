// Owner requests #100, #108, #109, #113 and #115: pure parts of each, without GitHub or the live memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, clashes } from '../factory/lib/dispatcher.mjs';
import { designLint } from '../factory/lib/checks.mjs';

const cfg = {
  product: { tracker: 'acme/wallet', repos: [{ name: 'enwallet', repo: 'acme/enwallet', default_branch: 'main' }] },
  environments: ['staging'],
  pipeline: { triage: { next: ['analysis', 'rejected'] }, analysis: { next: ['feature-grooming'] }, 'feature-grooming': { next: ['tech-grooming'] }, 'tech-grooming': { next: ['build'] }, build: { next: ['review'] }, review: {} },
};

test('#115: overlapping claims are found, the issue\'s own are not', () => {
  const index = { 'deploy/local-node.sh': [53, 64], 'deploy/check-import-closure.mjs': [53], 'tests/fixtures/local-node-app': [64] };
  assert.deepEqual(clashes(64, ['deploy/local-node.sh'], index).map((c) => c.issue), [53]);
  assert.deepEqual(clashes(70, ['deploy/'], index).map((c) => c.issue).sort(), [53, 53, 64], 'a folder claim overlaps the files in it');
  assert.deepEqual(clashes(70, ['tests/fixtures/local-node-app/server/index.mjs'], index).map((c) => c.issue), [64], 'a file inside a claimed folder');
  assert.deepEqual(clashes(70, ['deploy/local-static.sh'], index), [], 'a different file in the same folder is fine');
});

test('#113 / #108 / #115: the verdict fields exist where they are needed', () => {
  const d = new Dispatcher(cfg);
  for (const s of ['triage', 'analysis', 'feature-grooming']) assert.equal(d.extra(s).duplicate_of.type, 'number', s);
  assert.equal(d.extra('build').duplicate_of, undefined, 'not offered once the work is being built');
  const tg = d.extra('tech-grooming');
  assert.equal(tg.all_repos.type, 'boolean');
  assert.equal(tg.delta_of.type, 'number');
  assert.equal(tg.duplicate_of.type, 'number');
});

test('#109: thresholds count loops since the last approval; the history is kept', () => {
  const d = new Dispatcher(cfg);
  assert.equal(d.loopsSince({ loops: 7 }), 7);
  assert.equal(d.loopsSince({ loops: 7, loopBase: 6 }), 1, 'after an approval at 6 loops, one more loop counts as one');
  assert.equal(d.loopsSince({}), 0);
});

test('#100: design_lint asks for repo invariants, and a delta on revisions', () => {
  const base = '# Tech design\n## 1. Scope\nx\n## Repo invariants honoured\n| invariant | how |\n';
  assert.deepEqual(designLint(base, {}).failures, []);
  assert.match(designLint('# Tech design\n## 1. Scope\n', {}).failures[0], /Repo invariants honoured/);
  const s5 = `${base}\n## 5. Test plan\n| AC | input |\n|---|---|\n| AC-5-03 | a 280-character note |\n| AC-5-04 | 280 chars = 4 × 70 |\n`;
  const w = designLint(s5, {}).warnings;
  assert.equal(w.length, 1, 'only the boundary without arithmetic warns');
  assert.match(w[0], /280-character/);
});

test('#122: the build is skipped only when every done_when check already holds', async () => {
  const { freshness } = await import('../factory/lib/dispatcher.mjs');
  const files = { 'package.json': '"@types/node": "26.6.10"', 'package-lock.json': 'node-26.6.10.tgz "@types/node": "26.6.10"' };
  const read = (_repo, f) => files[f] ?? null;
  const done = [{ file: 'package.json', contains: '"@types/node": "26.6.10"', count: 1 }, { file: 'package-lock.json', contains: 'node-26.6.10.tgz', count: 1 }];
  assert.equal(freshness(done, read).allHold, true, '#68: the pin was already on main');
  assert.equal(freshness([...done, { file: 'package.json', contains: '"26.6.9"', count: 0 }], read).allHold, true, 'a count of 0 means "gone"');
  assert.equal(freshness([{ file: 'package.json', contains: '"@types/node": "26.6.11"', count: 1 }], read).allHold, false, 'not there yet: build');
  assert.equal(freshness([{ file: 'missing.txt', contains: 'x', count: 1 }], read).results[0].found, 0, 'a missing file has no matches');
  assert.equal(freshness([], read).allHold, false, 'no checks never skips a build');
});


test('feedback 80bf4988: a design may use factory code without declaring it changes it', () => {
  const tg = new Dispatcher(cfg).extra('tech-grooming');
  assert.equal(tg.uses_factory_code.type, 'boolean');
  assert.match(tg.uses_factory_code.description, /without changing it/);
});
