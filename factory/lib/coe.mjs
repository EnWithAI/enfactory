// Correction of Errors. Every failure in the pipeline is investigated (5 Whys + fishbone), its action items are implemented
// across the team, lessons go into the memory each role reads on every run, and a role that keeps introducing defects is
// reviewed and, if needed, replaced by a new agent hired with the corrected memory.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { p, loadConfig, teamOf, owners, agentFile, agentTarget } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import { council } from './council.mjs';
import * as M from './memory.mjs';
import * as T from './tracker.mjs';

const read = (f) => (existsSync(p(f)) ? readFileSync(p(f), 'utf8') : '');
const ACTION_TYPES = ['memory_lesson', 'agent_prompt', 'charter_amendment', 'checklist', 'process_proposal', 'product_issue', 'factory_change'];

const COE_SCHEMA = (cfg) => {
  const roles = Object.keys(cfg.roles);
  return {
    type: 'object',
    properties: {
      title: { type: 'string' }, summary: { type: 'string' },
      impact: { type: 'string', description: 'Cost, time lost, and customer/user effect of this failure.' },
      timeline_markdown: { type: 'string' },
      five_whys: { type: 'array', items: { type: 'object', properties: { why: { type: 'string' }, because: { type: 'string' } }, required: ['why', 'because'] }, minItems: 3 },
      fishbone: { type: 'object', properties: Object.fromEntries(['people', 'process', 'tools', 'environment', 'inputs', 'measurement'].map((k) => [k, { type: 'array', items: { type: 'string' } }])) },
      root_cause: { type: 'string' },
      introduced_by_role: { enum: [...roles, 'none'], description: 'The role whose output contained the defect.' },
      escaped_by_roles: { type: 'array', items: { enum: roles }, description: 'Roles whose checks should have caught it earlier.' },
      detectable_earlier_at: { type: 'string', description: 'The earliest stage that could have caught this, and how.' },
      lessons: { type: 'array', items: { type: 'object', properties: { role: { enum: [...roles, 'all'] }, lesson: { type: 'string', description: 'A concrete, checkable rule for the future. Not a platitude.' } }, required: ['role', 'lesson'] } },
      actions: { type: 'array', items: { type: 'object', properties: {
        todo: { type: 'string' }, owner_role: { enum: roles }, type: { enum: ACTION_TYPES }, detail: { type: 'string', description: 'The exact text to add (rule, checklist item, prompt clause), or the issue/proposal body.' },
        priority: { enum: ['P0', 'P1', 'P2', 'P3'] } }, required: ['todo', 'owner_role', 'type', 'detail'] } },
      decisions: { type: 'array', items: DECISION },
    },
    required: ['title', 'summary', 'impact', 'five_whys', 'fishbone', 'root_cause', 'introduced_by_role', 'lessons', 'actions'],
  };
};

function lesson(role, text, coeId) {
  mkdirSync(p('memory/lessons'), { recursive: true });
  appendFileSync(p('memory/lessons', `${role}.md`), `- ${text} _(${coeId})_\n`);
}

/** Investigate one failure and implement its action items. */
export async function investigate(cfg, ev) {
  const today = new Date().toISOString().slice(0, 10);
  const n = ev.issue;
  const state = M.issueState(n);
  const dossier = M.issueDossier(n);
  const recent = M.events({ since: new Date(Date.now() - 864e5).toISOString() }).filter((e) => e.type === 'coe');
  if (recent.length >= (cfg.quality?.coe_max_per_day ?? 20)) return M.record('coe_skipped', { reason: 'daily COE limit', kind: ev.kind }, { issue: n });

  const id = `COE-${today}-${n}-${Date.now().toString(36)}`;
  const r = await runAgent({ cfg, role: 'auditor', issue: n, label: 'coe', schema: COE_SCHEMA(cfg), meta: { kind: ev.kind },
    prompt: `# Correction of Errors: ${id}\nYou are leading a blameless but rigorous COE (Amazon format) on a pipeline failure. Find the real root cause, ` +
      `not the proximate one, and produce action items that make this class of failure impossible or caught earlier.\n\n` +
      `## The failure\n- Kind: **${ev.kind}**\n- Issue: #${n}\n- Stage: ${ev.from} → sent to ${ev.to}\n- Detected by: ${ev.by}\n- What they said:\n${ev.reason}\n\n` +
      `## Issue history\n\`\`\`json\n${JSON.stringify(state.history?.slice(-15) ?? [], null, 1)}\n\`\`\`\n` +
      `## Artifacts (read the ones involved)\n${dossier.artifacts.map((a) => `- ${p(a)}`).join('\n')}\n` +
      `Ledger events for this issue: \`sf memory issue ${n}\`. Raw agent runs: ${p('memory/runs')} (files named ${n}-<stage>-*.json).\n` +
      `Existing lessons (don't duplicate; strengthen if this is a repeat): ${p('memory/lessons')}\nPrevious COEs: ${p('memory/coe')}\n\n` +
      `Method: 1) timeline; 2) 5 Whys to the root cause; 3) fishbone across people (which agent/role), process, tools, environment, inputs, measurement; ` +
      `4) attribute introduced_by_role and escaped_by_roles; 5) lessons as checkable rules per role; 6) action items, each of a type the org can implement now: ` +
      `${ACTION_TYPES.join(', ')}. agent_prompt/memory_lesson change what a role does on its next run; charter_amendment/checklist change the team's standard; ` +
      `process_proposal goes to governance; product_issue files work; factory_change is for the factory's code (the owner builds it).`,
  });
  if (!r.ok) return M.record(/session limit|usage limit|rate.?limit|overloaded/i.test(String(r.error)) ? 'coe_deferred' : 'coe_failed', { error: r.error?.slice(0, 300), kind: ev.kind }, { issue: n });
  const v = r.out;

  // Implement the action items across the team.
  const done = [];
  for (const l of v.lessons ?? []) lesson(l.role, l.lesson, id);
  for (const a of v.actions ?? []) {
    let status = 'implemented';
    const team = teamOf(cfg, a.owner_role);
    if (a.type === 'memory_lesson' || a.type === 'agent_prompt') lesson(a.owner_role, a.detail, id);
    else if (a.type === 'charter_amendment' || a.type === 'checklist') {
      const f = p('org/charters', `${team}.md`);
      const head = a.type === 'checklist' ? '## Checklists from COEs' : '## Amendments from COEs';
      const cur = existsSync(f) ? readFileSync(f, 'utf8') : `# ${team}\n`;
      writeFileSync(f, cur.includes(head) ? cur.replace(head, `${head}\n- [${id}] ${a.detail}`) : `${cur.trimEnd()}\n\n${head}\n- [${id}] ${a.detail}\n`);
    } else if (a.type === 'process_proposal') {
      M.writeDoc(`org/proposals/${today}-${id}.md`, `# ${a.todo}\nFrom ${id} (#${n}).\n\n${a.detail}\n`); status = 'proposed to governance';
    } else if (a.type === 'product_issue') {
      const m = await T.createIssue(cfg.product.tracker, { title: a.todo, labels: [cfg.product.intake_label, ...(a.priority ? [a.priority] : [])], body: `${a.detail}\n\n---\nAction item from ${id} on #${n}.` }).catch(() => null);
      status = m ? `filed #${m}` : 'failed to file';
    } else if (a.type === 'factory_change') {
      const f = await T.fileOnce(cfg.product.tracker, { title: `[owner] ${a.todo}`, labels: ['sf-owner-request'], body: `${a.detail}\n\n---\nFactory change requested by ${id} on #${n}.` }).catch(() => null);
      if (f && !f.duplicate) await T.assign(cfg.product.tracker, f.n, owners(cfg)).catch(() => {});
      status = f ? `owner request #${f.n}${f.duplicate ? ' (merged into the existing request)' : ''}` : 'failed to file';
    }
    done.push({ ...a, status });
  }
  for (const d of v.decisions ?? []) M.decide(d, { actor: 'auditor', issue: n, scope: 'quality/coe' });

  const fb = v.fishbone ?? {};
  M.writeDoc(`memory/coe/${id}.md`, [
    `# ${id}: ${v.title}`, '', `**Issue:** #${n} · **Kind:** ${ev.kind} · **Stage:** ${ev.from} → ${ev.to} · **Detected by:** ${ev.by}`,
    `**Introduced by:** ${v.introduced_by_role} · **Escaped:** ${(v.escaped_by_roles ?? []).join(', ') || 'none'} · **Detectable earlier at:** ${v.detectable_earlier_at ?? '—'}`, '',
    '## Summary', v.summary, '', '## Impact', v.impact, '', '## Timeline', v.timeline_markdown ?? '', '',
    '## 5 Whys', ...(v.five_whys ?? []).map((w, i) => `${i + 1}. **Why ${w.why}** Because ${w.because}`), '', `**Root cause:** ${v.root_cause}`, '',
    '## Fishbone', ...Object.entries(fb).map(([k, xs]) => `- **${k}:** ${(xs ?? []).join('; ') || '—'}`), '',
    '## Lessons (now in role memory)', ...(v.lessons ?? []).map((l) => `- **${l.role}:** ${l.lesson}`), '',
    '## Action items', '| Todo | Owner | Type | Status |', '|---|---|---|---|', ...done.map((a) => `| ${a.todo} | ${a.owner_role} | ${a.type} | ${a.status} |`), '',
  ].join('\n'));
  M.record('coe', { coe: id, kind: ev.kind, title: v.title, introduced_by: v.introduced_by_role, escaped_by: v.escaped_by_roles ?? [], actions: done.length, cost_usd: r.cost }, { actor: 'auditor', issue: n });
  await T.comment(cfg.product.tracker, n, `### 🔎 Correction of Errors: ${v.title}\n**Root cause:** ${v.root_cause}\n\n` +
    `Introduced by **${v.introduced_by_role}**${v.escaped_by_roles?.length ? `, escaped ${v.escaped_by_roles.join(', ')}` : ''}. ` +
    `${(v.lessons ?? []).length} lesson(s) added to role memory, ${done.length} action item(s): ${done.map((a) => `${a.type} → ${a.status}`).join('; ')}.\n<sub>\`memory/coe/${id}.md\`</sub>`).catch(() => {});

  if (v.introduced_by_role && v.introduced_by_role !== 'none') await maybeReview(cfg, v.introduced_by_role);
  return { id, ...v, done };
}

/** Defects attributed to a role since its current generation was hired. */
export function generations() { return M.kv('generations'); }
function defectsSinceHire(cfg, role) {
  const gen = generations()[role];
  const days = cfg.quality?.window_days ?? 7;
  const since = [gen?.since, new Date(Date.now() - days * 864e5).toISOString()].filter(Boolean).sort().at(-1);
  return M.events({ since }).filter((e) => e.type === 'coe' && e.introduced_by === role);
}

/** Repeated defects from one role trigger a performance review: coach, upgrade the model, or replace the agent. */
/** A review triggered by something other than COE count (e.g. an upheld complaint from the feedback box). */
export function performanceReview(cfg, role, reason) { return maybeReview(cfg, role, { force: true, reason }); }

async function maybeReview(cfg, role, { force = false, reason = '' } = {}) {
  const defects = defectsSinceHire(cfg, role);
  if (!force && defects.length < (cfg.quality?.replace_after_defects ?? 3)) return;
  const lead = cfg.teams[teamOf(cfg, role)]?.lead;
  const members = [...new Set(['cfo', lead && lead !== role ? lead : 'product-owner'])];
  const current = readFileSync(agentFile(role), 'utf8');
  const lessons = read(`memory/lessons/${role}.md`) + read('memory/lessons/all.md');
  const r = await council({ cfg, name: `performance/${role}-${Date.now()}`, rounds: 1, chair: 'chief-of-staff', members,
    topic: `Performance review: ${role}${force ? ` (${reason.slice(0, 120)})` : ` introduced ${defects.length} defects since it was hired`}`,
    context: `${force ? `## Why this review\n${reason}\n\n` : ''}## Defects (COEs)\n${defects.map((d) => `- ${d.coe} (#${d.issue}, ${d.kind}): ${d.title}`).join('\n')}\n\nCOE docs: ${p('memory/coe')}\n\n` +
      `## Current agent definition\n${current}\n\n## Lessons already in its memory\n${lessons || '(none)'}\n\n## Role config\n${JSON.stringify(cfg.roles[role])}\n\n` +
      `Options: **coach** (the lessons are enough; keep the agent), **upgrade_model** (the work needs a stronger model; the CFO weighs the cost), ` +
      `**replace** (let this agent go and hire a new one whose definition is rewritten from scratch around the corrected memory). ` +
      `Replace when the failures show a pattern in how the role works, not just missing facts.`,
    extraSchema: {
      action: { enum: ['coach', 'upgrade_model', 'replace'] },
      model: { enum: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
      new_prompt_markdown: { type: 'string', description: 'For replace: the complete new agent prompt, with the lessons built into how the role works.' },
      decisions: { type: 'array', items: DECISION },
    },
  });
  if (!r.ok) return;
  const v = r.out;
  for (const d of v.decisions ?? []) if (d.title && d.decision) M.decide({ rationale: '', ...d }, { actor: 'chief-of-staff', scope: 'org/performance' });
  const gens = generations();
  const gen = gens[role]?.gen ?? 1;
  if (v.action === 'replace' && v.new_prompt_markdown) {
    mkdirSync(p('org/alumni'), { recursive: true });
    copyFileSync(agentFile(role), p('org/alumni', `${role}-gen${gen}-${new Date().toISOString().slice(0, 10)}.md`));
    const fm = current.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? `---\nname: ${role}\ndescription: ${role}\n---\n`;
    writeFileSync(agentTarget(role),`${fm}${v.new_prompt_markdown.trim()}\n\n## Hired with corrected memory (generation ${gen + 1})\n` +
      `You replace an agent that was let go after ${defects.length} defects. Its lessons are now yours:\n${lessons}\n`);
    M.kv('generations', { ...gens, [role]: { gen: gen + 1, since: new Date().toISOString(), replaced: defects.map((d) => d.coe) } });
    M.record('replaced', { role, gen: gen + 1, defects: defects.length, reason: v.summary?.slice(0, 400), thread: r.thread }, { actor: 'chief-of-staff' });
  } else if (v.action === 'upgrade_model' && v.model && v.model !== cfg.roles[role].model) {
    const doc = parseDocument(read('org/org.yaml'));
    doc.setIn(['roles', role, 'model'], v.model);
    writeFileSync(p('org/org.yaml'), doc.toString());
    try { loadConfig(); } catch { return; }
    M.kv('generations', { ...gens, [role]: { gen, since: new Date().toISOString() } }); // a fresh window after the change
    M.record('model_upgraded', { role, model: v.model, reason: v.summary?.slice(0, 400) }, { actor: 'chief-of-staff' });
  } else {
    M.kv('generations', { ...gens, [role]: { gen, since: new Date().toISOString() } });
    M.record('coached', { role, reason: v.summary?.slice(0, 400) }, { actor: 'chief-of-staff' });
  }
}

/** Lessons injected into a role's system prompt on every run. */
export function lessonsFor(role, max = 6000) {
  const own = read(`memory/lessons/${role}.md`), all = read('memory/lessons/all.md');
  const text = [own && `### For ${role}\n${own}`, all && `### For everyone\n${all}`].filter(Boolean).join('\n');
  if (!text) return '';
  return `\n\n## Lessons from Corrections of Errors (do not repeat these failures)\n${text.length > max ? '…' + text.slice(-max) : text}`;
}
