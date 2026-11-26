// Feedback 0333ef04 (#77): review re-ran 28s after it advanced to security. The tick's issue list still had sf/review, and the
// resumed brief quoted the reviewer's own forward handoff as "What must change". Pure parts, without GitHub or the live memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, moveStamp, repeatsAdvance, handoffFor, duplicateTransition } from '../factory/lib/dispatcher.mjs';

const cfg = {
  product: { tracker: 'acme/wallet', repos: [{ name: 'enwallet', repo: 'acme/enwallet', default_branch: 'main' }] },
  environments: ['staging'],
  roles: { engineer: {}, reviewer: {}, security: {}, sre: {}, 'release-manager': {} },
  teams: { eng: { roles: ['engineer', 'reviewer', 'security', 'sre', 'release-manager'] } },
  pipeline: { build: { role: 'engineer', next: ['review'] }, review: { role: 'reviewer', next: ['security', 'build'] },
    security: { role: 'security', next: ['merge', 'build'] }, merge: { system: 'merge', next: ['release'] },
    release: { role: 'release-manager', next: ['verify'] }, verify: { role: 'sre', next: ['release', 'done', 'build'], forward: ['release'] } },
};
const N = 999_977; // no ledger events or artifacts exist for this issue
const forwardHandoff = 'Security: confirm the deps-bump workflow token scope. PR #127 is ready.';
// The state #77 was in right after review advanced to security.
const advanced = () => {
  const state = { loops: 0, heads: { enwallet: '3928976' }, history: [{ stage: 'review', to: 'security', outcome: 'advance', by: 'reviewer' }],
    lastHandoff: { from: 'review', by: 'reviewer', text: forwardHandoff } };
  state.moved = moveStamp(state, 'review', 'security', '# Review of #77\nAPPROVE', '2026-11-25T10:42:04.700Z');
  return state;
};

test('0333ef04: a run that ended after the issue list was fetched is not started again from that list', () => {
  const d = new Dispatcher(cfg);
  const listedAt = Date.now();
  d.running.set(77, { role: 'reviewer', stage: 'review' });
  d.settle(77); // the review run finishes (and moves the label) while the tick is still walking its old list
  assert.equal(d.running.has(77), false);
  assert.equal(d.settledSince(77, listedAt), true, 'the old list says sf/review: skip #77 this tick');
  assert.equal(d.settledSince(77, Date.now() + 1), false, 'the next tick lists the issue afresh');
  assert.equal(d.settledSince(78, listedAt), false, 'other issues are unaffected');
});

test('0333ef04: an advance followed by a re-dispatch of the same stage, with nothing changed, starts no run', () => {
  const state = advanced(), artifact = '# Review of #77\nAPPROVE';
  assert.equal(repeatsAdvance(cfg, state, 'review', artifact, [])?.to, 'security', 'same HEAD, artifact and handoff: blocked');
  assert.equal(repeatsAdvance(cfg, state, 'security', artifact, []), null, 'the stage it advanced to runs normally');
  const d = new Dispatcher(cfg);
  assert.equal(d.repeatedAdvance(N, 'review', advanced()), null, 'a changed artifact (none on disk for this issue) is a change');
  assert.equal(d.repeatedAdvance(N, 'review', { ...advanced(), moved: moveStamp(advanced(), 'review', 'security', '') })?.to, 'security', 'dispatcher guard blocks the re-run');
  assert.equal(d.repeatedAdvance(N, 'security', advanced()), null);
});

test('0333ef04: any real change lets the stage run again', () => {
  const artifact = '# Review of #77\nAPPROVE';
  const changed = (f) => { const s = advanced(); f(s); return repeatsAdvance(cfg, s, 'review', artifact, []); };
  assert.equal(changed((s) => { s.heads = { enwallet: 'abc1234' }; }), null, 'new commit');
  assert.equal(changed((s) => { s.lastHandoff = { from: 'security', by: 'security', text: 'Scope the token.' }; }), null, 'a new handoff');
  assert.equal(changed((s) => { s.history.push({ stage: 'security', to: 'review', outcome: 'loop_back' }); }), null, 'history moved on');
  assert.equal(repeatsAdvance(cfg, advanced(), 'review', '# Review v2', []), null, 'the artifact changed');
  for (const e of [{ type: 'transition', loop: true }, { type: 'transition', outcome: 'loop_back' }, { type: 'check_failed', stage: 'review' }, { type: 'human_approved' }])
    assert.equal(repeatsAdvance(cfg, advanced(), 'review', artifact, [{ ts: '2026-11-25T10:42:10Z', ...e }]), null, `${e.type} after the move`);
  assert.equal(repeatsAdvance(cfg, advanced(), 'review', artifact, [{ ts: '2026-11-25T10:41:00Z', type: 'transition', loop: true }])?.to, 'security', 'a loop before the move is not a change');
  const back = { ...advanced() }; back.moved = moveStamp(back, 'security', 'build', '');
  assert.equal(repeatsAdvance(cfg, back, 'security', '', []), null, 'a loop-back move is never guarded');
  const promote = { ...advanced() }; promote.moved = moveStamp(promote, 'verify', 'release', '');
  assert.equal(repeatsAdvance(cfg, promote, 'verify', '', [])?.to, 'release', 'a declared forward target (promote) counts as an advance');
});

test('0333ef04: the brief never shows a stage its own forward handoff as "What must change"', () => {
  const d = new Dispatcher(cfg), issue = { number: N, title: 'deps bump', body: 'x', labels: [], comments: [] };
  const state = advanced();
  assert.equal(handoffFor(state.lastHandoff, 'review', cfg), null);
  const resumed = d.delta(issue, 'review', state, '2026-11-25T10:42:04Z');
  assert.doesNotMatch(resumed, /What must change/);
  assert.ok(!resumed.includes(forwardHandoff), 'the reviewer\'s own handoff is not quoted back');
  const fresh = d.context(issue, 'review', state, '/tmp');
  assert.ok(!fresh.includes(forwardHandoff), 'nor in a fresh brief');
  // The stage it was meant for gets it as a plain handoff, not a change request.
  assert.equal(handoffFor(state.lastHandoff, 'security', cfg).title, 'Handoff to you from reviewer (review)');
  assert.match(d.context(issue, 'security', state, '/tmp'), /## Handoff to you from reviewer \(review\)\nSecurity: confirm/);
});

test('0333ef04: a real loop-back shows the receiving stage what must change', () => {
  const d = new Dispatcher(cfg), issue = { number: N, title: 'deps bump', body: 'x', labels: [], comments: [] };
  const loop = { ...advanced(), lastHandoff: { from: 'security', by: 'security', text: 'Pin the workflow token to contents: read.' } };
  assert.match(d.delta(issue, 'build', loop, '2026-11-25T10:42:04Z'), /## What must change \(from security, security\)\nPin the workflow token/);
  assert.match(d.context(issue, 'build', loop, '/tmp'), /## What must change \(from security, security\)\nPin the workflow token/);
  // A failed check, CI and a person's word at their own stage are changes too.
  assert.equal(handoffFor({ from: 'checks:review', by: 'dispatcher', text: 'x' }, 'review', cfg).kind, 'loop');
  assert.equal(handoffFor({ from: 'ci:review', by: 'ci', text: 'x' }, 'build', cfg).kind, 'loop');
  assert.equal(handoffFor({ from: 'review', by: 'maathavan', text: 'x' }, 'review', cfg).kind, 'loop', 'a person, not a role');
  assert.equal(handoffFor({ from: 'council:review', by: 'reviewer', text: 'x' }, 'review', cfg).kind, 'loop', 'a council route back to the same stage');
  assert.equal(handoffFor({ from: 'consult:security', by: 'security', text: 'x' }, 'review', cfg).kind, 'answer');
  assert.equal(handoffFor(null, 'review', cfg), null);
});

test('#141: a second review → security while the issue is already at security is a duplicate, not a transition', () => {
  const state = advanced(); // review → security moved at 10:42:04
  assert.equal(duplicateTransition(state, 'review', 'security', 'advance'), true, 'the 10:43:21 verdict is ignored and logged');
  assert.equal(duplicateTransition(state, 'review', 'build', 'loop_back'), false, 'a different route is real');
  assert.equal(duplicateTransition(state, 'security', 'merge', 'advance'), false, 'the next stage advancing is real');
  const again = advanced(); again.moved = moveStamp(again, 'build', 'review', ''); // security looped back, build rebuilt
  assert.equal(duplicateTransition(again, 'review', 'security', 'advance'), false, 'a repeat after a move in between is real');
  assert.equal(duplicateTransition({ loops: 0, history: [] }, 'review', 'security', 'advance'), false, 'first time through');
});

// #5: merged and held at release for a parent's fix; a superseded dependency sent it back to feature-grooming (5 wasted runs).
test('#5: a superseded dependency never sends merged code back to re-spec', async () => {
  const { supersededRoute } = await import('../factory/lib/dispatcher.mjs');
  const c = { ...cfg, pipeline: { 'feature-grooming': { role: 'engineer', next: ['tech-grooming'] }, 'tech-grooming': { role: 'engineer', next: ['build'] }, ...cfg.pipeline } };
  assert.equal(supersededRoute(c, { merged: { enwallet: '2026-11-25T10:42:01Z' } }, 'release'), 'release', 'merged: stays and waits');
  assert.equal(supersededRoute(c, {}, 'build'), 'feature-grooming', 'unmerged past feature-grooming: rework the spec');
  assert.equal(supersededRoute(c, {}, 'feature-grooming'), 'feature-grooming');
});

// #83: waited on #4, whose code had merged while the issue stayed open; triage re-ran every minute.
test('#83: a dependency whose code has merged is not waited on again', async () => {
  const { pendingDeps } = await import('../factory/lib/dispatcher.mjs');
  const states = { 4: { merged: { enwallet: '2026-11-25T08:01:00Z' } }, 7: {}, 9: null };
  const of = (m) => states[m];
  assert.deepEqual(pendingDeps([4], of), [], 'merged code: the wait is over');
  assert.deepEqual(pendingDeps([4, 7, 9], of), [7, 9], 'unmerged ones are still waited on');
});

// #180/#182 (COE on #6): verify bounced #6 to build over the release-wide CSP header; its design says csp=n.
test('#6: a verify bounce over the release-wide CSP header is not the issue\'s defect when its design says csp=n', async () => {
  const { touchesOf, offScopeCsp, rulingsOn } = await import('../factory/lib/dispatcher.mjs');
  assert.deepEqual(touchesOf('Risk tier: medium\nTouches: ui=y storage=y schemaVersion 2→3 csp=n\n'), { ui: true, storage: true, csp: false });
  assert.deepEqual(touchesOf('no header'), { ui: null, storage: null, csp: null });
  const bounce = { summary: "Staging is healthy, but I can't verify it because no CSP is served and deploy/csp.txt doesn't exist." };
  assert.equal(offScopeCsp(bounce, { csp: false }, 'build'), true);
  assert.equal(offScopeCsp(bounce, { csp: true }, 'build'), false, 'an issue that owns CSP is sent back');
  assert.equal(offScopeCsp(bounce, { csp: null }, 'build'), false, 'unknown scope: leave it to the verdict');
  assert.equal(offScopeCsp({ summary: 'No CSP served, and the pay button regressed: 500 on submit.' }, { csp: false }, 'build'), false, 'a real regression still goes to build');
  assert.equal(offScopeCsp(bounce, { csp: false }, 'release'), false);
  const evs = [
    { ts: '2026-11-25T17:10:00Z', type: 'transition', stage: 'verify', issue: 1, to: 'build', summary: 'before this deploy' },
    { ts: '2026-11-25T17:17:32Z', type: 'deploy', env: 'staging', ok: true, log: '── deploy enwallet@144e4de → staging' },
    { ts: '2026-11-25T17:18:45Z', type: 'transition', stage: 'verify', issue: 3, to: 'release', summary: 'No CSP; #27 owns it.' },
  ];
  const r = rulingsOn(evs, 'staging');
  assert.equal(r.sha, '144e4de');
  assert.deepEqual(r.verdicts.map((t) => t.issue), [3], 'only rulings on the deployed build');
  assert.equal(rulingsOn(evs, 'production'), null);
});

// Release 1: the release manager re-ran 56 times in a day to say "still held", on a timer, so a cleared blocker (the owner's
// iPhone PASS, the soak ending) waited for the next re-check. A hold now wakes only when something it could wait for changes.
test('a held release wakes on a change, not on a timer', async () => {
  const { holdWake, holdWatch } = await import('../factory/lib/dispatcher.mjs');
  const since = '2026-11-26T02:31:00Z', at = (m) => new Date(Date.parse(since) + m * 60e3);
  const open = new Set([2, 27, 177]);
  const h = { since, until: null, watch: holdWatch({ summary: 'Held: waits for #27 (CSP) and the iPhone smoke on #177.', handoff: '' }, 177), base: null };
  assert.deepEqual(h.watch, [27], 'its own number is not watched');
  const first = holdWake(h, { updatedAt: 'u1', open, heads: { enwallet: 'aaa1111' }, now: at(1) });
  assert.equal(first.wake, null, 'the first look only records the baseline');
  h.base = first.base;
  const same = { updatedAt: 'u1', open, heads: { enwallet: 'aaa1111' } };
  assert.equal(holdWake(h, { ...same, now: at(59) }).wake, null);
  assert.equal(holdWake(h, { ...same, now: at(180) }).wake, null, 'three hours, nothing changed: no run');
  assert.match(holdWake(h, { ...same, updatedAt: 'u2', now: at(5) }).wake, /new activity/, 'a comment or label');
  assert.match(holdWake(h, { ...same, open: new Set([2, 177]), now: at(5) }).wake, /#27 is now closed/);
  assert.match(holdWake(h, { ...same, heads: { enwallet: 'bbb2222' }, now: at(5) }).wake, /new code merged on enwallet/);
  assert.match(holdWake(h, { ...same, people: 1, now: at(5) }).wake, /person or vendor/);
  assert.match(holdWake(h, { ...same, now: at(361) }).wake, /six hours/, 'a routine re-check at most every 6 hours');
  const timed = { ...h, until: at(29).toISOString() };
  assert.equal(holdWake(timed, { ...same, now: at(20) }).wake, null);
  assert.match(holdWake(timed, { ...same, now: at(30) }).wake, /time it asked/, 'a soak it asked to wait for');
});
