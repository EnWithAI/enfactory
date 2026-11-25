// Owner requests #104 and #105 (COE on #7): a `reject` verdict is a cut, never a forward route; an issue's own gate is
// parsed from its body and checked before every stage run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectRoute, parseGates, checkGate } from '../factory/lib/dispatcher.mjs';

test('#104: reject with a forward next_stage never routes forward', () => {
  const r = rejectRoute(['tech-grooming', 'design', 'analysis'], { outcome: 'reject', next_stage: 'tech-grooming' }, 'feature-grooming');
  assert.deepEqual(r, { action: 'ask', keepTo: 'tech-grooming' }, 'the product owner decides; tech-grooming only if kept');
});

test('#104: reject closes directly where rejected is an option', () => {
  assert.deepEqual(rejectRoute(['feature-grooming', 'design', 'triage', 'rejected'], { outcome: 'reject', next_stage: 'design' }, 'analysis'), { action: 'close' });
});

test('#104: a blocked or missing route stays at the stage if kept; other outcomes are untouched', () => {
  assert.equal(rejectRoute(['build'], { outcome: 'reject', next_stage: 'blocked' }, 'tech-grooming').keepTo, 'tech-grooming');
  assert.equal(rejectRoute(['build'], { outcome: 'advance', next_stage: 'build' }, 'tech-grooming'), null);
  assert.equal(rejectRoute(['rejected'], { outcome: 'reject', next_stage: 'rejected' }, 'triage'), null, 'already routed to rejected');
});

test('#105: gates are read from the issue body', () => {
  assert.deepEqual(parseGates('Camera QR.\nspend_usd_max: 60\nnot_after: 2026-11-25T21:30:00+05:30\n'),
    { spend_usd_max: 60, not_after: '2026-11-25T16:00:00.000Z' });
  assert.equal(parseGates('spend_usd_max = $45.5').spend_usd_max, 45.5);
  const local = parseGates('not_after: 21:30', new Date('2026-11-25T08:00:00Z'));
  assert.equal(new Date(local.not_after).getHours(), 21, 'HH:MM is today, local time');
  assert.equal(parseGates('No gate here. Spend is fine.'), null);
});

test('#105: a gate fails on spend or deadline, and holds otherwise', () => {
  const g = { spend_usd_max: 60, not_after: '2026-11-25T16:00:00.000Z' };
  const before = new Date('2026-11-25T10:00:00Z'), after = new Date('2026-11-25T16:00:01Z');
  assert.equal(checkGate(g, { release: 1, release_usd: 59.99, today_usd: 200 }, true, before).ok, true, 'release spend under the gate');
  assert.match(checkGate(g, { release: 1, release_usd: 60, today_usd: 1 }, true, before).reason, /\$60\.00 has reached the gate of \$60 \(Release 1\)/);
  assert.match(checkGate(g, { release: null, today_usd: 75 }, false, before).reason, /today/, 'outside a release, today\'s spend counts');
  assert.match(checkGate(g, { release: 1, release_usd: 1 }, true, after).reason, /deadline/);
  assert.equal(checkGate(null, {}, true, after).ok, true, 'no gate, no stop');
});
