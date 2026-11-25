// Analytics over the ledger. Used by `sf report` and fed to the auditor.
import { events } from './memory.mjs';

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
    '', '## Escalations',
    escalations.map((e) => `- #${e.issue}: ${e.message?.split('\n')[0]}`).join('\n') || '_none_',
    '', '## Most expensive issues',
    Object.entries(costPerIssue).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `- #${n}: $${c.toFixed(2)}`).join('\n') || '_none_',
  ].join('\n');
}
