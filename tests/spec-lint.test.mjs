// Owner request #15 (COE-2026-11-25-2): #2's v2 spec carried defects the product owner caught; spec_lint must now catch them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { specLint } from '../factory/lib/checks.mjs';
import { loadConfig } from '../factory/lib/config.mjs';

const cfg = loadConfig();
const fixture = (v) => readFileSync(new URL(`./fixtures/spec-issue-2-${v}.md`, import.meta.url), 'utf8');

test('v2 fails the new rules: §4c grep mismatch and an "at least" negative control', () => {
  const r = specLint(fixture('v2'), cfg);
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /§4c lists/.test(f)), 'grep alternation vs §4c');
  assert.ok(r.failures.some((f) => /negative control must state an exact count/.test(f)), 'negative control count');
});

// Feedback ae04a2f3 (#18 AC-18-08): read-only gh commands are valid verify steps; mutating ones are not.
const ghSpec = (cmd) => `# Spec\n## 3. Acceptance criteria\n- **AC-9-01** Given issue 18, When \`${cmd}\` runs, Then the count is 1. [verify: doc] [family: doc]\n`;
const verifyFailures = (cmd) => specLint(ghSpec(cmd), cfg).failures.filter((f) => f.startsWith('AC-9-01: verify doc'));

test('a read-only gh command is a valid doc verify step', () => {
  for (const cmd of ['gh issue view 18 --repo o/r --comments', 'gh pr checks 38 -R o/r', 'gh run view 123 --log-failed', 'gh api -X GET repos/o/r/issues/18/comments'])
    assert.deepEqual(verifyFailures(cmd), [], cmd);
});

test('a mutating gh command is rejected as a verify step, with a reason', () => {
  for (const cmd of ['gh issue close 18', 'gh pr merge 38', 'gh api repos/o/r/issues -f title=x']) {
    const f = verifyFailures(cmd);
    assert.equal(f.length, 1, cmd);
    assert.match(f[0], /isn't read-only/, cmd);
  }
});

// The #2 v3 fixture predates the repo-doc rules of owner request #134 (2026-11-25); it passes every rule it was written against.
const predates134 = (f) => !/closed set \("exactly"|§4a has no "Repo invariant" row/.test(f);
test('v3 passes', () => {
  const r = specLint(fixture('v3'), cfg);
  assert.deepEqual(r.failures.filter(predates134), []);
});
