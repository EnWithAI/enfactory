// The daily budget, and what happens when it runs out. The dispatcher stops starting work; the dashboard shows it under
// "Waiting on you"; the owner approves more (for today, or as the new daily budget) and work continues on the next pass,
// with no restart. Today's extra allowance is kept apart from the daily budget in org.yaml, so it ends at midnight UTC.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { p, loadConfig } from './config.mjs';
import * as M from './memory.mjs';

const today = () => new Date().toISOString().slice(0, 10);

export function spentToday() {
  return M.events({ since: today() }).filter((e) => e.type === 'run_finished').reduce((s, e) => s + (e.cost_usd ?? 0), 0);
}

/** { spent, base, extra, limit, left, exhausted, since } for today (UTC). */
export function status(cfg = loadConfig()) {
  const base = cfg.capacity?.daily_budget_usd ?? Infinity;
  const extra = M.kv('budget-topups')[today()] ?? 0;
  const spent = spentToday(), limit = base + extra;
  const since = M.kv('budget-exhausted')[today()] ?? null;
  return { spent: +spent.toFixed(2), base, extra, limit, left: +(limit - spent).toFixed(2), exhausted: spent >= limit, since };
}

/** The dispatcher calls this when it stops for the budget: records when, once per day and limit, for the dashboard and the ledger. */
export function noteExhausted(st) {
  const k = M.kv('budget-exhausted');
  if (k[today()] && k[`${today()}:limit`] === st.limit) return;
  M.kv('budget-exhausted', { [today()]: new Date().toISOString(), [`${today()}:limit`]: st.limit });
  M.record('budget_exhausted', { spent_usd: st.spent, limit_usd: st.limit });
}

/**
 * The owner approves more spend. `permanent`: the amount is added to the daily budget in org.yaml (every day from now);
 * otherwise it is extra for today only. Returns the new status.
 */
export function approve(amount, { permanent = false, by = 'owner' } = {}) {
  amount = Number(amount);
  if (!(amount > 0 && amount <= 1000)) throw new Error('Approve an amount between $1 and $1000.');
  const cfg = loadConfig();
  if (permanent) {
    const raw = readFileSync(p('org/org.yaml'), 'utf8'), doc = parseDocument(raw);
    const next = +((cfg.capacity.daily_budget_usd ?? 0) + amount).toFixed(2);
    doc.setIn(['capacity', 'daily_budget_usd'], next);
    writeFileSync(p('org/org.yaml'), doc.toString());
    try { loadConfig(); } catch (e) { writeFileSync(p('org/org.yaml'), raw); throw new Error(`Budget unchanged, the org config would be invalid: ${e.message}`); }
    M.decide({ title: `Daily budget raised to $${next}`, decision: `The owner raised the daily budget by $${amount} to $${next}.`, rationale: 'Approved from the dashboard when the budget ran out.' }, { actor: by, scope: 'org/budget' });
  } else {
    const t = M.kv('budget-topups');
    M.kv('budget-topups', { ...t, [today()]: +((t[today()] ?? 0) + amount).toFixed(2) });
  }
  M.record('budget_approved', { amount_usd: amount, permanent }, { actor: by });
  return status();
}
