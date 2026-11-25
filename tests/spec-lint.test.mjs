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

test('v3 passes', () => {
  const r = specLint(fixture('v3'), cfg);
  assert.deepEqual(r.failures, []);
});
