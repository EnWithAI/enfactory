// The economy rules decide each run's model, effort and budget cap. A wrong match silently moves money around, so pin it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { taskPolicy } from '../factory/lib/worker.mjs';

const cfg = parse(readFileSync(new URL('../templates/org/org.yaml', import.meta.url), 'utf8'), { merge: true });

test('task rules pick model, effort and cap by run label', () => {
  assert.deepEqual(taskPolicy(cfg, 'prioritizer', 'triage'), { model: 'claude-haiku-5-5', effort: 'low', budget: 0.5 });
  assert.equal(taskPolicy(cfg, 'product-owner', 'approve-feature-grooming').model, 'claude-sonnet-5-5');
  assert.equal(taskPolicy(cfg, 'architect', 'council-chair').model, 'claude-sonnet-5-5');
  assert.equal(taskPolicy(cfg, 'engineer', 'build').budget, 5);
});

test('a role-scoped rule does not catch other roles with the same label prefix', () => {
  assert.equal(taskPolicy(cfg, 'release-manager', 'release').budget, 1);
  const plan = taskPolicy(cfg, 'product-owner', 'release-plan-2');
  assert.equal(plan.model, cfg.roles['product-owner'].model, 'release planning keeps the product owner model');
  assert.equal(plan.budget, cfg.capacity.budget_usd_per_run);
});

test('unmatched work falls back to the role model and the per-run cap', () => {
  assert.deepEqual(taskPolicy(cfg, 'compliance-officer', 'engage-compliance'),
    { model: cfg.roles['compliance-officer'].model, effort: null, budget: cfg.capacity.budget_usd_per_run });
});

test('every rule is well formed', () => {
  const models = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
  for (const r of cfg.economy.tasks) {
    assert.ok(r.task, 'task prefix');
    if (r.model) assert.ok(models.has(r.model), `${r.task}: model ${r.model}`);
    if (r.effort) assert.ok(['low', 'medium', 'high', 'xhigh', 'max'].includes(r.effort), `${r.task}: effort ${r.effort}`);
    if (r.budget_usd != null) assert.ok(r.budget_usd > 0 && r.budget_usd <= cfg.capacity.budget_usd_per_run, `${r.task}: budget ${r.budget_usd}`);
    if (r.role) assert.ok(cfg.roles[r.role], `${r.task}: role ${r.role}`);
  }
});
