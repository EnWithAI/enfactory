// Regression test for COE-2026-11-24-1: concurrent runs must never see the agents file change underneath them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { compileAgents } from '../factory/lib/config.mjs';

test('compileAgents is content-addressed and immutable under concurrency', async () => {
  const paths = await Promise.all(Array.from({ length: 50 }, () => Promise.resolve().then(compileAgents)));
  assert.equal(new Set(paths).size, 1, 'same definitions → same file');
  const before = statSync(paths[0]).mtimeMs;
  for (let i = 0; i < 20; i++) compileAgents();
  assert.equal(statSync(paths[0]).mtimeMs, before, 'an existing file is never rewritten');
  assert.ok(Object.keys(JSON.parse(readFileSync(paths[0], 'utf8'))).length > 5, 'file is complete JSON');
});
