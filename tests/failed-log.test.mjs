import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorTail } from '../factory/lib/tracker.mjs';

// #6: the CI loop-back showed an empty excerpt, so the engineer never saw "vitest: current 5.1.1 != latest 5.1.2".
const LOG = [
  '﻿2026-11-25T11:53:31.6886036Z > node scripts/check-deps.mjs',
  '2026-11-25T11:53:32.6262187Z vitest: current 5.1.1 != latest 5.1.2',
  '2026-11-25T11:53:32.6263770Z check-deps: problems=1',
  '2026-11-25T11:53:32.6351168Z ##[error]Process completed with exit code 1.',
  '2026-11-25T11:53:32.6503844Z Post job cleanup.',
  '2026-11-25T11:53:32.7427420Z [command]/usr/bin/git version',
].join('\n');

test('#6: a job log is cut at the last error, without timestamps or cleanup noise', () => {
  const tail = errorTail(LOG);
  assert.match(tail, /^vitest: current 5\.1\.1 != latest 5\.1\.2$/m);
  assert.match(tail, /##\[error\]Process completed with exit code 1\.$/);
  assert.doesNotMatch(tail, /Post job cleanup|2026-11-25T/);
});

test('a log with no error marker keeps its tail', () => {
  assert.equal(errorTail('a\nb\nc', 2), 'b\nc');
});
