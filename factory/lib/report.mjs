// Analytics over the ledger. Used by `sf report` and fed to the auditor.
import { events } from './memory.mjs';
import { rework } from './rework.mjs';

const fmt = (ms) => (ms < 3600e3 ? `${Math.round(ms / 60e3)}m` : `${(ms / 3600e3).toFixed(1)}h`);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

export function report({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const evs = events({ since });
  const runs = evs.filter((e) => e.type === 'run_finished');
  const trans = evs.filter((e) => e.type === 'transition');

  const byRole = {};
  for (const r of runs) {
    const x = (byRole[r.actor] ??= { runs: 0, fail: 0, cost: 0, ms: 0 });
    x.runs++; x.cost += r.cost_usd ?? 0; x.ms += r.ms ?? 0; if (!r.ok) x.fail++;
  }
  const byStage = {};
  for (const t of trans) {
    const x = (byStage[t.stage] ??= { out: 0, loops: 0, to: {} });
    x.out++; if (t.loop) x.loops++; x.to[t.to] = (x.to[t.to] ?? 0) + 1;
  }
  // Cycle time from intake to close, per issue.
  const opened = {}, closed = {};
  for (const e of events()) { if (e.type === 'intake') opened[e.issue] = e.ts; if (e.type === 'closed') closed[e.issue] = e; }
  const done = Object.entries(closed).filter(([n, e]) => opened[n] && e.ts >= since && e.to === 'done');
  const cycles = done.map(([n, e]) => new Date(e.ts) - new Date(opened[n])).sort((a, b) => a - b);
  const costPerIssue = {};
  for (const r of runs) if (r.issue) costPerIssue[r.issue] = (costPerIssue[r.issue] ?? 0) + (r.cost_usd ?? 0);
  const deploys = evs.filter((e) => e.type === 'deploy').length;
  const incidents = evs.filter((e) => e.type === 'incident_filed');
  const escalations = evs.filter((e) => e.type === 'escalated');
  const totalCost = runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0);

  return [
    `## Summary (${days}d)`,
    `- Agent runs: ${runs.length} (${runs.filter((r) => !r.ok).length} failed) · Cost: $${totalCost.toFixed(2)}`,
    `- Issues shipped: ${done.length} · Median cycle time: ${cycles.length ? fmt(cycles[Math.floor(cycles.length / 2)]) : 'n/a'}`,
    `- Deploys: ${deploys} · Incidents filed: ${incidents.length} · Change-fail ratio: ${deploys ? (incidents.filter((i) => i.from).length / deploys).toFixed(2) : 'n/a'}`,
    `- Human escalations: ${escalations.length} · Decisions recorded: ${evs.filter((e) => e.type === 'decision').length} · Learnings: ${evs.filter((e) => e.type === 'learning').length}`,
    `- Loop-backs: ${trans.filter((t) => t.loop).length} of ${trans.length} transitions`,
    '', '## By role',
    table(['role', 'runs', 'failed', 'cost', 'avg time'], Object.entries(byRole).map(([k, x]) => [k, x.runs, x.fail, `$${x.cost.toFixed(2)}`, fmt(x.ms / x.runs)])),
    '', '## By stage',
    table(['stage', 'transitions', 'loop-backs', 'routed to'], Object.entries(byStage).map(([k, x]) => [k, x.out, x.loops, Object.entries(x.to).map(([a, b]) => `${a}×${b}`).join(' ')])),
    '', '## First-pass rate per gate',
    // Of the issues that reached a gate this period, how many passed it on their first attempt (owner request #155).
    table(['gate', 'issues', 'passed first time', 'rate'], (() => {
      const first = {};
      for (const e of evs) {
        const gate = e.type === 'approval' ? `approve ${e.stage}` : ['check_passed', 'check_failed'].includes(e.type) ? `${(e.checks ?? []).join('+')} at ${e.stage}` : null;
        if (!gate || !e.issue) continue;
        const k = `${gate}|${e.issue}`;
        if (!(k in first)) first[k] = e.type === 'approval' ? !!e.approved : e.type === 'check_passed';
      }
      const by = {};
      for (const [k, ok] of Object.entries(first)) { const g = k.split('|')[0]; (by[g] ??= [0, 0])[0]++; if (ok) by[g][1]++; }
      return Object.entries(by).map(([g, [n, ok]]) => [g, n, ok, `${Math.round((100 * ok) / n)}%`]);
    })()),
    '', '## Loop-backs by cause',
    table(['cause', 'origin stage', 'count'], (() => {
      const c = {};
      for (const t of trans.filter((x) => x.loop)) { const k = `${t.loop_cause ?? 'unclassified'}|${t.origin_stage ?? '–'}`; c[k] = (c[k] ?? 0) + 1; }
      return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => [...k.split('|'), n]);
    })()),
    '', '## Rework (target 10% of spend)',
    // Repeat work by cause; picking up after an answer or a dependency is continuation, not rework (rework review, 2026-11-25).
    (() => {
      const r = rework(events(), { since });
      const pct = (v) => (r.cost ? `${Math.round((100 * v) / r.cost)}%` : '–');
      return `${table(['cause', 'cost', 'share of spend'], [...Object.entries(r.causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, `$${v.toFixed(2)}`, pct(v)]),
        ['**rework total**', `$${r.rework.toFixed(2)}`, pct(r.rework)]])}\n\nContinuation (new work after an answer, a dependency or a planned continue): $${r.continuation.toFixed(2)}.`;
    })(),
    '', '## Waste signals (target 0)',
    // Runs and stages that produced nothing (owner request #145): what the economy and pipeline fixes should drive to zero.
    table(['signal', 'count', 'issues'], [
      ['advance with every AC already satisfied (noop_advance)', 'noop_advance'],
      ['vendor request asked again for the same thing (needs_vendor_repeat)', 'needs_vendor_repeat'],
      ['found already done before build (already_satisfied)', 'already_satisfied'],
      ['stage re-run blocked after an advance (redispatch_blocked)', 'redispatch_blocked'],
      ['duplicate transition ignored (duplicate_transition)', 'duplicate_transition'],
      ['second council on the same stage, sent to the owner instead (council_skipped)', 'council_skipped'],
      ['release re-check avoided: held and nothing changed (hold_skipped; each one is a run not paid for)', 'hold_skipped'],
      ['held release re-checked because something changed (hold_woken)', 'hold_woken'],
    ].map(([label, type]) => { const xs = evs.filter((e) => e.type === type); return [label, xs.length, [...new Set(xs.map((e) => `#${e.issue}`))].join(' ') || '–']; })),
    '', '## Escalations',
    escalations.map((e) => `- #${e.issue}: ${e.message?.split('\n')[0]}`).join('\n') || '_none_',
    '', '## Most expensive issues',
    Object.entries(costPerIssue).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `- #${n}: $${c.toFixed(2)}`).join('\n') || '_none_',
  ].join('\n');
}
