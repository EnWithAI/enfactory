// Agile delivery: the org works on one release at a time, and every release ends in something demoable.
// The product owner plans a release (goal, scope, demo script) from the backlog; only its issues move through the pipeline
// (P0 is expedited); when all of them are closed the release is closed out with notes, a demo and a retrospective.
import { existsSync, readFileSync } from 'node:fs';
import { p } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import * as M from './memory.mjs';
import * as T from './tracker.mjs';

const read = (f) => (existsSync(p(f)) ? readFileSync(p(f), 'utf8') : '');
export const current = () => { const r = M.kv('release'); return r?.number ? r : null; }; // kv returns {} when nothing is stored
const save = (r) => M.kv('release', r);

async function milestone(repo, title, description) {
  const out = await T.gh(['api', '-X', 'POST', `repos/${repo}/milestones`, '-f', `title=${title}`, '-f', `description=${description.slice(0, 1000)}`])
    .catch((e) => { M.record('error', { error: `milestone not created: ${e.message.slice(0, 200)}` }); return null; });
  return out ? JSON.parse(out).number : null;
}
const toMilestone = (repo, n, title) => T.gh(['issue', 'edit', String(n), '-R', repo, '--milestone', title]).catch(() => null);

/** The product owner plans the next release: one demoable outcome, the smallest scope that delivers it. */
export async function plan(cfg, openIssues, { replan = false } = {}) {
  const prev = current();
  const replacing = replan && prev?.status === 'active' ? prev : null; // re-plan the active release in place (same number, milestone, record)
  const number = replacing ? prev.number : (prev?.number ?? 0) + 1;
  const backlog = openIssues.map((i) => `- #${i.number} [${T.priorityOf(i)}] [${T.stageOf(i) ?? 'new'}] ${i.title}${i.body ? ` — ${i.body.replace(/\s+/g, ' ').slice(0, 240)}` : ''}`).join('\n');
  const repoEnv = cfg.product.repos.map((r) => `${r.name}: ${Object.entries(r.health ?? {}).map(([e, u]) => `${e} ${u}`).join(', ')}`).join('; ');
  const r = await runAgent({ cfg, role: 'product-owner', label: `release-plan-${number}`,
    schema: { type: 'object', properties: {
      goal: { type: 'string', description: 'One sentence: what a user can do at the end of this release that they could not before. Demoable.' },
      demo_script_markdown: { type: 'string', description: 'Numbered steps the CEO follows on staging to see the goal working, with what they should see at each step.' },
      exit_criteria: { type: 'array', items: { type: 'string' } },
      issues: { type: 'array', items: { type: 'number' }, description: 'Existing issue numbers in scope.' },
      new_issues: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, priority: { enum: ['P0', 'P1', 'P2', 'P3'] } }, required: ['title', 'body'] },
        description: 'Missing slices or prerequisites the goal needs that have no issue yet. They are filed into this release.' },
      deferred: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' }, reason: { type: 'string' } }, required: ['n', 'reason'] } },
      decisions: { type: 'array', items: DECISION },
    }, required: ['goal', 'demo_script_markdown', 'exit_criteria', 'issues'] },
    prompt: `# ${replacing ? `Re-plan release ${number}` : `Plan release ${number}`}\n` +
      (replacing ? `The CEO set new directives after this release was planned. Re-plan it so it complies. Current goal: ${replacing.goal}. Current scope: ${replacing.issues.map((n) => `#${n}`).join(', ')}.\n` : '') + `The org works in agile releases: one release at a time, and every release ends in **one demoable piece** the CEO can try on staging. ` +
      `Nothing outside the release moves until it ships (P0 excepted).\n\n` +
      `Pick the single most valuable demoable outcome, then the **smallest** set of issues that delivers it end to end: a vertical slice through domain, storage and UI, ` +
      `not a horizontal layer. Include prerequisites it truly needs. File missing slices as new_issues. Defer everything else, with a reason.\n` +
      `The demo script must work on staging (${repoEnv}) and say what the CEO should see at each step.\n\n` +
      `## CEO directives (these win over charters and earlier decisions)\n${read('memory/product/ceo-directives.md') || '(none)'}\n\n` +
      `## Backlog (open issues)\n${backlog}\n\n## Product\n${read('memory/product/overview.md').slice(0, 5000)}\n\n## Roadmap and product rules\n${read('org/charters/product.md').slice(0, 5000)}\n\n` +
      (prev?.number ? `## Previous release\nRelease ${prev.number}: ${prev.goal} (${prev.status}). Retro: ${prev.retro ?? 'n/a'}\n` : ''),
  });
  if (!r.ok) throw new Error(`release planning: ${r.error}`);
  const v = r.out;
  const repo = cfg.product.tracker, title = `Release ${number}`; // short: GitHub milestone titles are short; the goal goes in the description
  const open = new Set(openIssues.map((i) => i.number));
  const issues = [...new Set(v.issues.filter((n) => open.has(n)))];
  for (const ni of v.new_issues ?? []) {
    const n = await T.createIssue(repo, { title: ni.title, labels: [cfg.product.intake_label, ...(ni.priority ? [ni.priority] : [])], body: `${ni.body}\n\n---\nFiled by the product owner for release ${number}.` }).catch(() => null);
    if (n) issues.push(n);
  }
  let ms = replacing?.milestone ?? null;
  if (replacing) {
    if (ms) await T.gh(['api', '-X', 'PATCH', `repos/${repo}/milestones/${ms}`, '-f', `description=${v.goal.slice(0, 1000)}`]).catch(() => {});
    for (const n of replacing.issues.filter((x) => !issues.includes(x))) await T.gh(['issue', 'edit', String(n), '-R', repo, '--milestone', '']).catch(() => {}); // back to the backlog
  } else ms = await milestone(repo, title, v.goal);
  for (const n of issues) await toMilestone(repo, n, title);
  const body = `## Goal\n${v.goal}\n\n## Demo (on staging)\n${v.demo_script_markdown}\n\n## Exit criteria\n${v.exit_criteria.map((c) => `- [ ] ${c}`).join('\n')}\n\n` +
    `## Scope\n${issues.map((n) => `- #${n}`).join('\n')}\n\n## Deferred to the backlog\n${(v.deferred ?? []).map((d) => `- #${d.n}: ${d.reason}`).join('\n') || '_none_'}\n\n_Planned by the product owner. Only these issues move until this release ships (P0 excepted)._`;
  let recordIssue = replacing?.recordIssue ?? null;
  if (recordIssue) {
    await T.gh(['issue', 'edit', String(recordIssue), '-R', repo, '--title', `🚀 ${title}: ${v.goal}`.slice(0, 250), '--body-file', '-'], { input: `${body}\n\n_Re-planned under the CEO directives._` }).catch(() => {});
    await T.comment(repo, recordIssue, `### Re-planned under the CEO directives\nRemoved from scope: ${replacing.issues.filter((x) => !issues.includes(x)).map((x) => `#${x}`).join(', ') || 'none'}. Added: ${issues.filter((x) => !replacing.issues.includes(x)).map((x) => `#${x}`).join(', ') || 'none'}.`).catch(() => {});
  } else recordIssue = await T.createIssue(repo, { title: `🚀 ${title}: ${v.goal}`.slice(0, 250), labels: ['sf-release'], body }).catch(() => null);
  for (const d of v.decisions ?? []) M.decide(d, { actor: 'product-owner', scope: `release/${number}` });
  M.decide({ title: `Release ${number} scope`, decision: `Goal: ${v.goal}. Scope: ${issues.map((n) => `#${n}`).join(', ')}.`,
    rationale: `Smallest set that delivers one demoable outcome. Deferred: ${(v.deferred ?? []).map((d) => `#${d.n}`).join(', ') || 'none'}.` }, { actor: 'product-owner', scope: `release/${number}` });
  const rel = { number, goal: v.goal, demo: v.demo_script_markdown, exit: v.exit_criteria, issues, status: 'active', started: replacing?.started ?? new Date().toISOString(), milestone: ms, milestoneTitle: title, recordIssue };
  save(rel);
  M.record(replacing ? 'release_replanned' : 'release_planned', { release: number, goal: v.goal, issues, deferred: (v.deferred ?? []).map((d) => d.n), cost_usd: r.cost }, { actor: 'product-owner' });
  return rel;
}

/**
 * Scope has an owner: an agent's "blocking" follow-up joins the release only if the product owner agrees the demo needs it
 * (judged against the CEO directives). Otherwise it stays in the backlog, with the reason on the issue.
 */
export async function admit(cfg, n, { title, body, reason }) {
  const rel = current();
  if (rel?.status !== 'active' || rel.issues.includes(n)) return false;
  const r = await runAgent({ cfg, role: 'product-owner', label: `scope-${n}`, issue: n,
    schema: { type: 'object', properties: { admit: { type: 'boolean' }, reason: { type: 'string' } }, required: ['admit', 'reason'] },
    prompt: `# Scope check for release ${rel.number}\nGoal: ${rel.goal}\nCurrent scope: ${rel.issues.map((x) => `#${x}`).join(', ')}\n\n` +
      `An agent filed #${n} as a blocking prerequisite and wants it added to this release.\n**${title ?? ''}**\n${(body ?? '').slice(0, 1500)}\nWhy: ${reason}\n\n` +
      `## CEO directives\n${read('memory/product/ceo-directives.md') || '(none)'}\n\n` +
      `Admit it only if the release's demo cannot work without it. Documentation, process, ADR follow-ups and tooling go to the backlog unless the demo truly depends on them. Say why.` });
  const ok = r.ok && r.out.admit;
  if (ok) await addToRelease(cfg, n, `${reason} (admitted by the product owner: ${r.out.reason})`);
  else {
    M.record('release_scope_declined', { release: rel.number, issue: n, reason: r.ok ? r.out.reason : `scope check failed: ${r.error}` }, { actor: 'product-owner', issue: n });
    await T.comment(cfg.product.tracker, n, `### Not in release ${rel.number}\n${r.ok ? r.out.reason : 'The scope check could not run, so this stays in the backlog.'}\nIt stays in the backlog for a later release.`).catch(() => {});
  }
  return ok;
}

/** Take an issue out of the active release (back to the backlog). */
export async function removeFromRelease(cfg, n, reason) {
  const rel = current();
  if (rel?.status !== 'active' || !rel.issues.includes(n)) return;
  rel.issues = rel.issues.filter((x) => x !== n); save(rel);
  await T.gh(['issue', 'edit', String(n), '-R', cfg.product.tracker, '--milestone', '']).catch(() => {});
  M.record('release_scope_changed', { release: rel.number, removed: n, reason }, { actor: 'product-owner', issue: n });
  await T.comment(cfg.product.tracker, n, `### Moved out of release ${rel.number}\n${reason}\nIt stays in the backlog for a later release.`).catch(() => {});
}

/** Adopt a release from the client-approved release plan (engagements), instead of planning one ad hoc. */
export function adopt(rel) {
  save(rel);
  M.record('release_planned', { release: rel.number, goal: rel.goal, issues: rel.issues, from_plan: true }, { actor: 'product-owner' });
}

/** A blocking prerequisite filed from an in-release issue joins the release. */
export async function addToRelease(cfg, n, reason) {
  const rel = current();
  if (rel?.status !== 'active' || rel.issues.includes(n)) return;
  rel.issues.push(n); save(rel);
  await toMilestone(cfg.product.tracker, n, rel.milestoneTitle);
  M.record('release_scope_changed', { release: rel.number, added: n, reason }, { actor: 'product-owner' });
}

/** All scope issues closed: release notes with the demo, a retrospective, then the next release can be planned. */
export async function closeOut(cfg) {
  const rel = current();
  if (rel?.status !== 'active') return;
  rel.status = 'closing'; save(rel);
  const evs = M.events({ since: rel.started });
  const facts = {
    issues: rel.issues, runs: evs.filter((e) => e.type === 'run_finished').length,
    cost_usd: +evs.filter((e) => e.type === 'run_finished').reduce((s, e) => s + (e.cost_usd ?? 0), 0).toFixed(2),
    loop_backs: evs.filter((e) => e.type === 'transition' && e.loop).length, coes: evs.filter((e) => e.type === 'coe').map((e) => e.title),
    deploys: evs.filter((e) => e.type === 'deploy').length, days: +((Date.now() - new Date(rel.started)) / 864e5).toFixed(1),
  };
  const notes = await runAgent({ cfg, role: 'product-owner', label: `release-notes-${rel.number}`,
    schema: { type: 'object', properties: { notes_markdown: { type: 'string', description: 'Release notes for users and the CEO: what is new, how to try it (the demo), known limits.' } }, required: ['notes_markdown'] },
    prompt: `# Release ${rel.number} is complete\nGoal: ${rel.goal}\nScope: ${rel.issues.map((n) => `#${n}`).join(', ')}\nPlanned demo:\n${rel.demo}\n\nWrite the release notes. Check what actually shipped (memory/specs, sf memory issue <n>, gh). ` +
      `Lead with what a user can now do, then the demo steps on staging (correct them to what really shipped), then known limits.` });
  const retro = await runAgent({ cfg, role: 'auditor', label: `retro-${rel.number}`,
    schema: { type: 'object', properties: { retro_markdown: { type: 'string' }, lessons: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, lesson: { type: 'string' } }, required: ['role', 'lesson'] } },
      process_proposal: { type: 'string' } }, required: ['retro_markdown'] },
    prompt: `# Retrospective: release ${rel.number}\nGoal: ${rel.goal}\nFacts: ${JSON.stringify(facts)}\nCOEs this release: ${p('memory/coe')}. Ledger: ${p('memory/ledger')}.\n` +
      `Run the retro: what went well, what didn't (with numbers), and the 3 changes that would make the next release faster or safer. Lessons go to role memory; process changes to process_proposal.` });
  const day = new Date().toISOString().slice(0, 10);
  if (notes.ok) {
    try { (await import('./library.mjs')).publish(cfg, { folder: (cfg.library?.folders ?? []).find((f) => f.path === 'product')?.path ?? cfg.library?.folders?.[0]?.path, title: `Release ${rel.number} notes`, summary: rel.goal, audience: 'CEO, users', markdown: notes.out.notes_markdown }, { actor: 'product-owner' }); } catch { /* library optional */ }
    if (rel.recordIssue) await T.comment(cfg.product.tracker, rel.recordIssue, `## Release notes\n${notes.out.notes_markdown}`).catch(() => {});
  }
  if (retro.ok) {
    M.writeDoc(`memory/reports/retro-release-${rel.number}-${day}.md`, `# Retrospective: release ${rel.number}\n\n${retro.out.retro_markdown}\n`);
    for (const l of retro.out.lessons ?? []) M.learn(`[retro R${rel.number}] ${l.role}: ${l.lesson}`, { actor: 'auditor' });
    if (retro.out.process_proposal) M.writeDoc(`org/proposals/${day}-retro-release-${rel.number}.md`, `# From the release ${rel.number} retro\n\n${retro.out.process_proposal}\n`);
    if (rel.recordIssue) await T.comment(cfg.product.tracker, rel.recordIssue, `## Retrospective\n${retro.out.retro_markdown}`).catch(() => {});
  }
  if (rel.milestone) await T.gh(['api', '-X', 'PATCH', `repos/${cfg.product.tracker}/milestones/${rel.milestone}`, '-f', 'state=closed']).catch(() => {});
  if (rel.recordIssue) await T.closeIssue(cfg.product.tracker, rel.recordIssue, 'completed').catch(() => {});
  Object.assign(rel, { status: 'done', finished: new Date().toISOString(), facts, retro: retro.ok ? retro.out.retro_markdown.slice(0, 400) : null });
  save(rel);
  const history = M.kv('releases'); M.kv('releases', { ...history, [rel.number]: rel });
  M.record('release_done', { release: rel.number, goal: rel.goal, ...facts }, { actor: 'product-owner' });
  // Engagements: the next release comes from the client-approved plan, not from ad-hoc planning.
  const E = await import('./engagement.mjs');
  if (E.state()?.releases?.[rel.number]) await E.startRelease(cfg, rel.number + 1);
}
