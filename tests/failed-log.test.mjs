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

// #187: four CSP tickets in one day. Real titles from enwallet; distinct pairs share files but are different work.
test('#187: a follow-up that is the same work merges into the open issue; different work sharing a file does not', async () => {
  const { sameWork } = await import('../factory/lib/tracker.mjs');
  const i176 = { title: 'Add deploy/csp.txt and serve matching Content-Security-Policy header', body: 'At enwallet 144e4de, deploy/ does not exist and the server sends no CSP header.' };
  const i177 = { title: 'Add deploy/csp.txt and serve the CSP header on enwallet', body: 'SRE verify of #4 found deploy/csp.txt missing.' };
  const i27 = { title: 'CSP for enwallet Release 1: deploy/csp.txt plus emission on the static deploy', body: 'canonical CSP at deploy/csp.txt' };
  const i53 = { title: 'deploy/local-node.sh: ship src/shared/ with server/ in each release', body: 'deploy/local-node.sh copies dist and server' };
  const i110 = { title: 'local-node.sh (#64) must start #3\'s server with positional <port> <dataDir>', body: 'deploy/local-node.sh starts server/index.mjs' };
  assert.equal(sameWork(i177, i176), true);
  assert.equal(sameWork(i177, i27), true);
  assert.equal(sameWork(i110, i53), false, 'same file, different work');
  assert.equal(sameWork({ title: 'Add a CSP header', body: '' }, { title: 'Add a rate limit', body: '' }), false);
});
