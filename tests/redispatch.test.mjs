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
