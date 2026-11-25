// Staffing. The product owner designs the org's skills from the product; the CFO approves hires within the owner's
// budget envelope; hires become real agents (a definition file + org.yaml entry) that work immediately.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { p, loadConfig, headcount, agentTarget } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import { council } from './council.mjs';
import * as M from './memory.mjs';

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const read = (f) => (existsSync(p(f)) ? readFileSync(p(f), 'utf8') : '');

const ROLE = (cfg) => ({
  type: 'object',
  properties: {
    name: { type: 'string', description: 'kebab-case role name, e.g. storage-engineer' },
    team: { type: 'string', description: `existing team (${Object.keys(cfg.teams).join(', ')}) or a new team name` },
    mission: { type: 'string' }, skills: { type: 'array', items: { type: 'string' } },
    stages: { type: 'array', items: { enum: Object.keys(cfg.pipeline).filter((s) => !cfg.pipeline[s].system) }, description: 'Stages this specialist can be assigned to (joins the stage pool).' },
    profile: { enum: Object.keys(cfg.tool_profiles ?? { read: 1 }), description: 'read = read-only, verify = can run checks, build = can change code' },
    model: { enum: MODELS }, headcount: { type: 'number' },
    prompt_markdown: { type: 'string', description: "The agent's system prompt: who they are, the standard they work to, what they check, and how they hand off. Specific to this product." },
    justification: { type: 'string', description: 'Why this product needs this skill, with evidence from the product docs.' },
  },
  required: ['name', 'team', 'mission', 'skills', 'stages', 'profile', 'model', 'headcount', 'prompt_markdown', 'justification'],
});

/** Facts the CFO decides on: spend, budget, and per-role cost and utilisation from the ledger. */
export function economics(cfg, hours = 24 * 7) {
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const runs = M.events({ since }).filter((e) => e.type === 'run_finished');
  const day = new Date().toISOString().slice(0, 10);
  const byRole = {};
  for (const r of runs) {
    const x = (byRole[r.actor] ??= { runs: 0, cost: 0, busy_min: 0 });
    x.runs++; x.cost += r.cost_usd ?? 0; x.busy_min += (r.ms ?? 0) / 60e3;
  }
  const rows = Object.keys(cfg.roles).map((role) => {
    const x = byRole[role] ?? { runs: 0, cost: 0, busy_min: 0 };
    const seats = headcount(cfg, role);
    return { role, seats, model: cfg.roles[role].model, runs: x.runs, avg_cost: x.runs ? +(x.cost / x.runs).toFixed(2) : null,
      avg_min: x.runs ? +(x.busy_min / x.runs).toFixed(1) : null, utilisation_pct: +((x.busy_min / (seats * hours * 60)) * 100).toFixed(1) };
  });
  return {
    envelope: { daily_budget_usd: cfg.capacity.daily_budget_usd, max_parallel: cfg.capacity.max_parallel, max_headcount_per_role: cfg.staffing?.max_headcount_per_role ?? 8 },
    spend_today_usd: +runs.filter((r) => r.ts >= day).reduce((s, r) => s + (r.cost_usd ?? 0), 0).toFixed(2),
    spend_window_usd: +runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0).toFixed(2), window_hours: hours,
    defaults_when_no_data: { 'claude-opus-5-5': '~$0.8/run', 'claude-sonnet-5-5': '~$0.25/run', 'claude-haiku-5-5': '~$0.05/run' },
    roles: rows,
  };
}

const CFO_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    hires: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, approve: { type: 'boolean' }, headcount: { type: 'number' }, model: { enum: MODELS }, reason: { type: 'string' } }, required: ['name', 'approve', 'reason'] } },
    headcount: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, headcount: { type: 'number' }, reason: { type: 'string' } }, required: ['role', 'headcount', 'reason'] } },
    decisions: { type: 'array', items: DECISION },
  },
  required: ['summary', 'hires', 'headcount'],
};

async function cfo(cfg, label, ask) {
  const r = await runAgent({ cfg, role: 'cfo', label, schema: CFO_SCHEMA,
    prompt: `${ask}\n\n## Economics\n\`\`\`json\n${JSON.stringify(economics(cfg), null, 1)}\n\`\`\`\n` +
      `Decide every item. Keep total seats sensible for max_parallel=${cfg.capacity.max_parallel}. Record decisions with their numbers.` });
  if (!r.ok) throw new Error(`CFO: ${r.error}`);
  for (const d of r.out.decisions ?? []) M.decide(d, { actor: 'cfo', scope: 'org/staffing' });
  return r.out;
}

/** Apply approved hires and headcount changes to org.yaml and .claude/agents, then validate. */
function apply(cfg, specs, verdict) {
  const before = readFileSync(p('org/org.yaml'), 'utf8');
  const doc = parseDocument(before);
  const cap = cfg.staffing?.max_headcount_per_role ?? 8;
  const hired = [], changed = [];
  for (const h of verdict.hires ?? []) {
    const spec = specs.find((s) => s.name === h.name);
    if (!h.approve || !spec || !/^[a-z][a-z0-9-]{2,40}$/.test(spec.name) || cfg.roles[spec.name]) continue;
    const n = Math.max(1, Math.min(cap, Math.round(h.headcount ?? spec.headcount ?? 1)));
    const model = MODELS.includes(h.model) ? h.model : spec.model;
    writeFileSync(agentTarget(spec.name), [
      '---', `name: ${spec.name}`, `description: ${JSON.stringify(spec.mission)}`, '---', spec.prompt_markdown.trim(), '',
      `## Onboarding`, `You were hired by the ${'product-owner'} and approved by the CFO for these skills: ${spec.skills.join(', ')}.`,
      `Your team is **${spec.team}**. Before acting, read your team charter (org/charters/${spec.team}.md), org/operating-model.md and memory/product/.`, '',
    ].join('\n'));
    doc.setIn(['roles', spec.name], doc.createNode({ headcount: n, model, profile: spec.profile }, { flow: true }));
    if (doc.hasIn(['teams', spec.team])) doc.getIn(['teams', spec.team, 'roles']).add(spec.name);
    else doc.setIn(['teams', spec.team], doc.createNode({ lead: spec.name, roles: [spec.name] }, { flow: true }));
    for (const st of spec.stages) {
      if (!cfg.pipeline[st] || cfg.pipeline[st].system) continue;
      if (doc.hasIn(['pipeline', st, 'pool'])) doc.getIn(['pipeline', st, 'pool']).add(spec.name);
      else doc.setIn(['pipeline', st, 'pool'], doc.createNode([spec.name], { flow: true }));
    }
    hired.push({ ...spec, headcount: n, model });
  }
  for (const c of verdict.headcount ?? []) {
    if (!cfg.roles[c.role]) continue;
    const ownsStage = Object.values(cfg.pipeline).some((s) => s.role === c.role || s.council?.chair === c.role);
    const n = Math.max(ownsStage ? 1 : 0, Math.min(cap, Math.round(c.headcount)));
    if (n === cfg.roles[c.role].headcount) continue;
    doc.setIn(['roles', c.role, 'headcount'], n);
    changed.push({ role: c.role, from: cfg.roles[c.role].headcount, to: n, reason: c.reason });
  }
  if (!hired.length && !changed.length) return { hired, changed };
  writeFileSync(p('org/org.yaml'), doc.toString());
  try { loadConfig(); } catch (e) { writeFileSync(p('org/org.yaml'), before); throw new Error(`staffing change reverted, org.yaml invalid: ${e.message}`); }
  for (const h of hired) {
    M.record('hired', { role: h.name, team: h.team, headcount: h.headcount, model: h.model, stages: h.stages, skills: h.skills }, { actor: 'cfo' });
    M.decide({ title: `Hired ${h.name} ×${h.headcount} (${h.team})`, decision: `${h.mission}. Skills: ${h.skills.join(', ')}. Stages: ${h.stages.join(', ')}. Model ${h.model}, profile ${h.profile}.`, rationale: h.justification }, { actor: 'cfo', scope: 'org/staffing' });
  }
  for (const c of changed) M.record(c.to > c.from ? 'hired' : 'released', { role: c.role, from: c.from, to: c.to, reason: c.reason }, { actor: 'cfo' });
  return { hired, changed };
}

/** At setup: the product owner designs the skills this product needs; the CFO approves; hires join the org. */
export async function recruit(cfg = loadConfig()) {
  console.log('Product owner is designing the team from the product…');
  const po = await runAgent({ cfg, role: 'product-owner', label: 'recruit',
    schema: { type: 'object', properties: { plan_summary: { type: 'string' }, hires: { type: 'array', items: ROLE(cfg) },
      headcount_changes: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, headcount: { type: 'number' }, reason: { type: 'string' } }, required: ['role', 'headcount', 'reason'] } },
      decisions: { type: 'array', items: DECISION } }, required: ['plan_summary', 'hires', 'headcount_changes'] },
    prompt: `# Build the team for this product\nYou are the product owner. Before the org starts work, decide which skills this product needs and recruit for them.\n\n` +
      `## Product\n${read('memory/product/overview.md')}\n\n## Owner answers and decisions\n${read('memory/product/answers.md')}\n\n` +
      `## Repo docs\n${cfg.product.repos.map((r) => read(`memory/product/repos/${r.name}.md`).slice(0, 12000)).join('\n---\n')}\n\n` +
      `## Current org\nTeams: ${JSON.stringify(cfg.teams)}\nRoles: ${JSON.stringify(Object.fromEntries(Object.entries(cfg.roles).map(([k, v]) => [k, { headcount: v.headcount, model: v.model }])))}\n` +
      `Stages: ${Object.entries(cfg.pipeline).map(([k, v]) => `${k} (owner ${v.role ?? v.council?.chair ?? 'system'}${v.pool ? `, pool ${v.pool}` : ''})`).join('; ')}\n` +
      `Tool profiles: ${Object.keys(cfg.tool_profiles).join(', ')}\n\n` +
      `Do this:\n1. Analyse the domain and the technical surface. What expertise does doing this product well at a top company require?\n` +
      `2. Compare that with the generalist roles above. Hire specialists only where a generalist would miss things that matter (domain rules, regulation, a hard technical area, accessibility, data integrity…). ` +
      `Each hire joins the pool of the stages where that skill applies, and the previous stage can then route work to them.\n` +
      `3. Right-size the generalist headcounts for the expected inflow. Smaller is fine.\n` +
      `4. Write each hire's prompt as a seasoned practitioner's operating manual for THIS product. Be concrete.\nThe CFO will approve within budget, so justify each hire.`,
  });
  if (!po.ok) throw new Error(`product owner: ${po.error}`);
  for (const d of po.out.decisions ?? []) M.decide(d, { actor: 'product-owner', scope: 'org/staffing' });
  console.log(`Plan: ${po.out.hires.length} hire(s), ${po.out.headcount_changes.length} headcount change(s). Asking the CFO…`);
  const v = await cfo(cfg, 'recruit-approval', `# Hiring plan from the product owner\n${po.out.plan_summary}\n\n## Proposed hires\n` +
    po.out.hires.map((h) => `- **${h.name}** ×${h.headcount} (${h.team}, ${h.model}, ${h.profile}): ${h.mission}. Skills: ${h.skills.join(', ')}. Stages: ${h.stages.join(', ')}.\n  Why: ${h.justification}`).join('\n') +
    `\n\n## Proposed headcount changes\n${po.out.headcount_changes.map((c) => `- ${c.role} → ${c.headcount}: ${c.reason}`).join('\n') || '(none)'}`);
  const res = apply(cfg, po.out.hires, v);
  M.writeDoc(`memory/reports/staffing-${new Date().toISOString().slice(0, 10)}-${Date.now()}.md`, [
    '# Recruiting', '', `**Product owner:** ${po.out.plan_summary}`, '', `**CFO:** ${v.summary}`, '', '## Hired',
    ...res.hired.map((h) => `- **${h.name}** ×${h.headcount} on ${h.team} (${h.model}): ${h.mission}`), res.hired.length ? '' : '_none_',
    '## Declined', ...(v.hires ?? []).filter((h) => !h.approve).map((h) => `- ${h.name}: ${h.reason}`), '',
    '## Headcount', ...res.changed.map((c) => `- ${c.role}: ${c.from} → ${c.to} (${c.reason})`)].join('\n'));
  console.log(`CFO: ${v.summary}\nHired: ${res.hired.map((h) => `${h.name}×${h.headcount}`).join(', ') || 'none'} · headcount changes: ${res.changed.length}`);
  return res;
}

/** During the run: work is waiting on a full role. The team lead asks the CFO for more agents. */
export async function request(cfg, role, { waiting, since, issues }) {
  const lead = Object.values(cfg.teams).find((t) => t.roles.includes(role))?.lead ?? 'chief-of-staff';
  M.record('staffing_request', { role, waiting, since, issues, by: lead }, { actor: lead });
  const v = await cfo(cfg, `staffing-${role}`, `# Staffing request from ${lead}\n` +
    `${waiting} issue(s) (${issues.map((i) => `#${i.n} ${i.priority}`).join(', ')}) have been waiting for **${role}** since ${since}. All ${headcount(cfg, role)} seat(s) are busy.\n` +
    `Decide whether to add seats to ${role} (return it in headcount with the new total), or decline (return no change) and say why.`);
  const res = apply(cfg, [], { hires: [], headcount: (v.headcount ?? []).filter((c) => c.role === role) });
  if (!res.changed.length) M.record('staffing_declined', { role, reason: v.summary }, { actor: 'cfo' });
  return { ...res, summary: v.summary };
}

/**
 * Daily: the CFO and the product owner discuss the roster. The CFO brings the numbers, the product owner brings the roadmap
 * (what work is coming and which skills it needs). The CFO decides. Seats can be released, and a specialist role can be
 * let go entirely (0 seats) when the work no longer needs it. Stage-owning roles always keep one seat.
 */
export async function review(cfg) {
  const issues = M.events({ since: new Date(Date.now() - 14 * 864e5).toISOString() }).filter((e) => e.type === 'intake' || e.type === 'issue_filed').length;
  const r = await council({ cfg, name: `staffing/review-${new Date().toISOString().slice(0, 10)}-${Date.now()}`, rounds: 2, chair: 'cfo', members: ['cfo', 'product-owner'],
    topic: 'Is the org right-sized? Which seats or roles should we release, and which do we need?',
    context: `## Economics\n\`\`\`json\n${JSON.stringify(economics(cfg), null, 1)}\n\`\`\`\n\n## Inflow\n${issues} issue(s) entered or were filed in the last 14 days.\n\n` +
      `## Roster\n${Object.entries(cfg.teams).map(([t, x]) => `- ${t}: ${x.roles.map((r) => `${r}×${cfg.roles[r]?.headcount ?? 0}`).join(', ')}`).join('\n')}\n` +
      `Stage owners: ${[...new Set(Object.values(cfg.pipeline).map((s) => s.role ?? s.council?.chair).filter(Boolean))].join(', ')} (they keep at least 1 seat).\n` +
      `Specialist pools: ${Object.entries(cfg.pipeline).filter(([, s]) => s.pool).map(([k, s]) => `${k}: ${s.pool.join(', ')}`).join('; ') || 'none'}\n\n` +
      `The CFO argues from cost and utilisation, and the product owner argues from the roadmap and the skills it needs. ` +
      `Releasing a specialist role entirely means headcount 0, and its work falls back to the stage owner. It can be rehired later.`,
    extraSchema: { headcount: CFO_SCHEMA.properties.headcount, decisions: { type: 'array', items: DECISION } },
  });
  if (!r.ok) throw new Error(`staffing review: ${r.error}`);
  for (const d of r.out.decisions ?? []) if (d.title && d.decision) M.decide({ rationale: '', ...d }, { actor: 'cfo', scope: 'org/staffing' });
  const res = apply(cfg, [], { hires: [], headcount: r.out.headcount ?? [] });
  M.record('staffing_review', { summary: r.out.summary?.slice(0, 500), changed: res.changed.length, thread: r.thread, cost_usd: r.cost }, { actor: 'cfo' });
  return { ...res, summary: r.out.summary, thread: r.thread };
}
