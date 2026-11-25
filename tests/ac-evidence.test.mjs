// Owner request #69 (COE on #3): a build may not advance while its AC → evidence table shows a known gap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acEvidence } from '../factory/lib/checks.mjs';

const cfg = {};
const build = (rows, { head = '| AC | Test | Status |', extra = '' } = {}) =>
  `# Build\n## What changed\nstuff\n\n## AC → evidence\n${head}\n|---|---|---|\n${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}\n${extra}\n## Deviations\nnone\n`;

test('every row pass, done or post-deploy passes', () => {
  const r = acEvidence(build([['3-01', 'auth.test', 'pass'], ['3-02', 'e2e', '**pass** (was partial)'], ['3-03', 'README', 'done'],
    ['3-04', 'deploy probe', 'post-deploy (SRE)'], ['3-05', 'hsts', 'pre-check pass; post-deploy pending (SRE)']]), cfg);
  assert.deepEqual(r.failures, []);
});

test('a known gap blocks the build: partial, pending, failing or blank', () => {
  const r = acEvidence(build([['3-20', 'x', 'pass'], ['3-21', 'egress.spec', 'partial: full-flow extension not added'],
    ['2-06', 'probe', 'pending (SRE)'], ['3-22', 'y', 'post-deploy, partial'], ['3-23', 'z', '']]), cfg);
  assert.equal(r.ok, false);
  for (const id of ['AC-3-21', 'AC-2-06', 'AC-3-22', 'AC-3-23']) assert.ok(r.failures.some((f) => f.startsWith(id)), id);
  assert.ok(!r.failures.some((f) => f.startsWith('AC-3-20')));
});

test('a revision must restate the table, not refer to the previous build', () => {
  const md = '# Build\n## AC → evidence\nThis is unchanged from the previous build.md table. All 23 ACs pass.\n\n## Deviations\n';
  const r = acEvidence(md, cfg);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /refers to a previous build/.test(f)));
});

test('the table must exist and carry a Status column', () => {
  assert.match(acEvidence('# Build\n## What changed\nx\n', cfg).failures[0], /No "## AC → evidence" table/);
  assert.match(acEvidence(build([['1-01', 'all pass']], { head: '| AC | Evidence |' }).replace('|---|---|---|', '|---|---|'), cfg).failures[0], /Status column/);
});
