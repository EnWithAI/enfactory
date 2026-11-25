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

// Release 1: #2 and #3 each filed an iPhone test of the same build 144e4de; the owner would have been asked 7 times.
test('a device test of the same build is one request, whichever issue asks', async () => {
  const { sameBuildCheck } = await import('../factory/lib/tracker.mjs');
  const a = '[vendor] iPhone smoke test of enwallet staging (#2) The build is at 144e4de, on the laptop.';
  const b = '[vendor] iPhone smoke test of enwallet staging at 144e4de. Run demo steps 1 to 6.';
  assert.equal(sameBuildCheck(a, b), true);
  assert.equal(sameBuildCheck(a, b.replace('144e4de', '9f4359f')), false, 'another build is another test');
  assert.equal(sameBuildCheck(a, '[vendor] Enable Actions PR creation (144e4de)'), false, 'not a device check');
  assert.equal(sameBuildCheck('smoke test 1234567', 'smoke test 1234567'), false, 'digits only are not a sha');
});
