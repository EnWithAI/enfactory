// Rework review (2026-11-25): 53% of the day's spend was counted as rework. The metric now names causes and separates
// continuation; councils are capped per stage; a sound but unfinished stage continues instead of blocking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rework } from '../factory/lib/rework.mjs';
import { mayContinue, mayConvene } from '../factory/lib/dispatcher.mjs';
import { verdictSchema } from '../factory/lib/worker.mjs';

let t = 0;
const at = () => `2026-11-25T10:${String(t++).padStart(2, '0')}:00Z`;
const run = (actor, label, cost, extra = {}) => ({ ts: at(), type: 'run_finished', actor, issue: 6, label, cost_usd: cost, ok: true, ...extra });
const ev = (type, extra = {}) => ({ ts: at(), type, issue: 6, ...extra });

test('a repeat run is classified by what sent it back; picking up after an answer is continuation', () => {
  t = 0;
  const r = rework([
    run('engineer', 'build', 10), // first run: not rework
    ev('check_failed'), run('engineer', 'build', 1),
    ev('transition', { loop: true }), run('engineer', 'build', 2),
    ev('escalated'), run('engineer', 'build', 3),
    ev('answer_recorded'), run('engineer', 'build', 4),
    ev('continued'), run('engineer', 'build', 5),
    run('architect', 'council-architect', 6),
    run('engineer', 'build', 7, { check_retry: 1 }),
    run('engineer', 'build', 8), // a rerun with nothing in between
  ]);
  assert.equal(r.cost, 46);
  assert.deepEqual(r.causes, { council: 6, check: 8, loop: 2, failed: 0, blocked: 3, repeat: 8 });
  assert.equal(r.rework, 27);
  assert.equal(r.continuation, 9);
});

test('runs before the window are history, not counted', () => {
  t = 0;
  const evs = [run('engineer', 'build', 10), ev('transition', { loop: true }), run('engineer', 'build', 2)];
  assert.equal(rework(evs, { since: '2026-11-25T10:02' }).rework, 2);
  assert.equal(rework(evs, { since: '2026-11-25T11:00' }).cost, 0);
});

test('#6: "continue" is an outcome, allowed economy.continue_runs times per stage', () => {
  assert.ok(verdictSchema(['review']).properties.outcome.enum.includes('continue'));
  const cfg = { economy: { continue_runs: 2 } };
  assert.equal(mayContinue(cfg, {}, 'build').ok, true);
  assert.equal(mayContinue(cfg, { continues: { build: 1 } }, 'build').ok, true);
  assert.equal(mayContinue(cfg, { continues: { build: 2 } }, 'build').ok, false, 'then it is a block');
  assert.equal(mayContinue(cfg, { continues: { build: 2 } }, 'review').ok, true, 'per stage');
});

test('#20 / #42: one council per issue and stage until a person approves', () => {
  const cfg = { economy: { councils_per_stage: 1 } };
  assert.equal(mayConvene(cfg, {}, 'build'), true);
  assert.equal(mayConvene(cfg, { councils: { build: 1 } }, 'build'), false, 'the second block goes to the owner');
  assert.equal(mayConvene(cfg, { councils: { build: 1 } }, 'loop:build'), true, 'loop and block councils are counted apart');
  assert.equal(mayConvene(cfg, { councils: {} }, 'build'), true, 'reset by a person\'s approval');
});
