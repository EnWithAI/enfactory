// Departments: teams grouped under a head chosen from the existing agents, so only department heads report to the CEO.
// The org designs it (chief of staff); governance can change it later (org.yaml → departments).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { p, loadConfig } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import * as M from './memory.mjs';

/** The department a team (or a role) belongs to. */
export const departmentOf = (cfg, team) => Object.entries(cfg.departments ?? {}).find(([, d]) => d.teams?.includes(team))?.[0] ?? null;
export const headOf = (cfg, team) => cfg.departments?.[departmentOf(cfg, team)]?.head ?? null;

export async function design(cfg = loadConfig()) {
  const read = (f) => (existsSync(p(f)) ? readFileSync(p(f), 'utf8') : '');
  const teams = Object.keys(cfg.teams), roles = Object.keys(cfg.roles);
  const r = await runAgent({ cfg, role: 'chief-of-staff', label: 'departments',
    schema: { type: 'object', properties: {
      departments: { type: 'array', items: { type: 'object', properties: {
        name: { type: 'string', description: 'kebab-case, e.g. engineering' }, title: { type: 'string', description: 'e.g. Engineering' },
        head: { enum: roles, description: 'The agent role that owns this department and reports to the CEO.' },
        head_title: { type: 'string', description: 'e.g. VP Engineering' }, teams: { type: 'array', items: { enum: teams } },
        mandate: { type: 'string', description: 'What this department owns end to end, in one or two sentences.' } },
        required: ['name', 'title', 'head', 'head_title', 'teams', 'mandate'] } },
      decisions: { type: 'array', items: DECISION } }, required: ['departments'] },
    prompt: `# Design the departments\nToday every team reports straight to the CEO. Group the teams into a few departments, the way a well-run FAANG org does, ` +
      `and give each department a head chosen from the existing agent roles. Only department heads report to the CEO. ` +
      `Heads own their department's outcomes, are the first escalation point for its teams, and speak for it in councils.\n\n` +
      `Rules: every team belongs to exactly one department. A head must be a role that already exists, usually the lead of one of the department's teams ` +
      `(or an exec role such as chief-of-staff, cfo or product-owner). Prefer 3–5 departments. Keep independent checks independent: ` +
      `say so if quality or security should not report to the people whose work they check.\n\n` +
      `## Teams\n${Object.entries(cfg.teams).map(([t, x]) => `- ${t} (lead ${x.lead}): ${x.roles.join(', ')}`).join('\n')}\n\n` +
      `## Operating model\n${read('org/operating-model.md').slice(0, 8000)}`,
  });
  if (!r.ok) throw new Error(r.error);
  const deps = r.out.departments;
  const covered = deps.flatMap((d) => d.teams);
  const missing = teams.filter((t) => !covered.includes(t)), dupes = covered.filter((t, i) => covered.indexOf(t) !== i);
  if (missing.length || dupes.length) throw new Error(`invalid departments: missing ${missing.join(',') || 'none'}, duplicated ${dupes.join(',') || 'none'}`);
  const doc = parseDocument(readFileSync(p('org/org.yaml'), 'utf8'));
  doc.set(doc.createNode('departments'), doc.createNode(Object.fromEntries(deps.map((d) => [d.name, { title: d.title, head: d.head, head_title: d.head_title, teams: d.teams, mandate: d.mandate }]))));
  const key = doc.contents.items.find((i) => (i.key?.value ?? i.key) === 'departments')?.key;
  if (key && typeof key === 'object') key.commentBefore = ' Departments. Teams grouped under a head (an agent role) who reports to the CEO and is the first escalation point. Governance can change this.';
  writeFileSync(p('org/org.yaml'), doc.toString());
  loadConfig();
  for (const d of r.out.decisions ?? []) M.decide(d, { actor: 'chief-of-staff', scope: 'org/structure' });
  M.decide({ title: 'Department structure', decision: deps.map((d) => `${d.title}: head ${d.head} (${d.head_title}), teams ${d.teams.join(', ')}`).join('; '),
    rationale: 'Only department heads report to the CEO; they own outcomes and are the first escalation point for their teams.' }, { actor: 'chief-of-staff', scope: 'org/structure' });
  M.record('departments_designed', { departments: deps.map((d) => ({ name: d.name, head: d.head })) }, { actor: 'chief-of-staff' });
  return deps;
}
