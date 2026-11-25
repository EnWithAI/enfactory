// The request and complaint box. Agents (and people) file complaints about another role or the org, and requests for what they
// need, with evidence. The chief of staff reviews them in batches, checks the evidence, decides, and acts: a lesson in the named
// role's memory, a process proposal to governance, a performance review, or an owner request. Everything is recorded.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { p, loadConfig, owners } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import * as M from './memory.mjs';
import * as T from './tracker.mjs';

const DIR = p('memory/hr');
const fileOf = (id) => path.join(DIR, `${id}.json`);

/** File one item. `about` is a role name or "org". Returns the item. */
export function file({ about, kind, text, evidence = '' }, { by, issue = null }) {
  const cfg = loadConfig();
  if (!text?.trim()) throw new Error('Say what the problem or request is.');
  if (about !== 'org' && !cfg.roles[about]) throw new Error(`"${about}" is not a role. Use a role name or "org".`);
  if (!['complaint', 'request'].includes(kind)) throw new Error('kind must be complaint or request');
  mkdirSync(DIR, { recursive: true });
  const same = list().find((i) => i.status === 'open' && i.about === about && i.kind === kind && T.similar(i.text, text));
  if (same) { // one item per need: record who else hit it and their evidence
    same.seconded = [...(same.seconded ?? []), { by, issue, at: new Date().toISOString(), text: text.trim().slice(0, 600), evidence: String(evidence).slice(0, 600) }];
    writeFileSync(fileOf(same.id), JSON.stringify(same, null, 2));
    M.record('feedback_seconded', { item: same.id, about, by }, { actor: by, issue });
    return same;
  }
  const item = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), by, about, kind, text: text.trim().slice(0, 3000), evidence: String(evidence).slice(0, 1500), issue, status: 'open' };
  writeFileSync(fileOf(item.id), JSON.stringify(item, null, 2));
  M.record(kind === 'complaint' ? 'complaint_filed' : 'request_filed', { item: item.id, about, text: item.text.slice(0, 300) }, { actor: by, issue });
  return item;
}

export function list() {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The chief of staff reviews open items, checks evidence, decides and acts. */
export async function review(cfg = loadConfig()) {
  const open = list().filter((i) => i.status === 'open');
  if (!open.length) return { resolved: 0 };
  const roles = Object.keys(cfg.roles);
  const r = await runAgent({ cfg, role: 'chief-of-staff', label: 'feedback-review',
    schema: { type: 'object', properties: {
      resolutions: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, outcome: { enum: ['upheld', 'partly upheld', 'dismissed', 'request accepted', 'request declined'] },
        action: { enum: ['none', 'lesson', 'process_proposal', 'performance_review', 'owner_request'] },
        detail: { type: 'string', description: 'For lesson: the checkable rule for the named role. For process_proposal / owner_request: what should change.' },
        reply: { type: 'string', description: 'The answer to whoever filed it: what was found and what happens now.' } }, required: ['id', 'outcome', 'action', 'reply'] } },
      decisions: { type: 'array', items: DECISION } }, required: ['resolutions'] },
    prompt: `# The request and complaint box\nYou handle the org's complaints and requests, like a fair, rigorous HR partner. For each item:\n` +
      `1. Check the evidence yourself: the ledger (${p('memory/ledger')}), artifacts (${p('memory/specs')}), decisions, COEs, and \`sf memory issue <n>\`.\n` +
      `2. Decide: a complaint is upheld only if the evidence shows it. A request is accepted if it helps the org do its job and fits the CEO directives (${p('memory/product/ceo-directives.md')}).\n` +
      `3. Act: **lesson** (a concrete rule written into the named role's memory), **process_proposal** (an org rule or process should change; governance decides), ` +
      `**performance_review** (only for a pattern of upheld complaints about one role), **owner_request** (needs a factory or resource change), or **none**.\n` +
      `Be fair to both sides; a complaint about a role that was following its charter is a process problem, not a people problem.\n\n` +
      `## Open items\n${open.map((i) => `- **${i.id}** · ${i.kind} about **${i.about}** from ${i.by}${i.issue ? ` (#${i.issue})` : ''}: ${i.text}${i.evidence ? `\n  Evidence: ${i.evidence}` : ''}`).join('\n')}\n\n` +
      `Upheld complaints already on record against roles: ${JSON.stringify(Object.fromEntries(roles.map((x) => [x, list().filter((i) => i.about === x && /upheld/.test(i.outcome ?? '')).length]).filter(([, n]) => n)))}`,
  });
  if (!r.ok) throw new Error(`feedback review: ${r.error}`);
  const day = new Date().toISOString().slice(0, 10);
  let resolved = 0;
  for (const res of r.out.resolutions) {
    const item = open.find((i) => i.id === res.id);
    if (!item) continue;
    let done = res.action;
    if (res.action === 'lesson' && res.detail && item.about !== 'org') {
      mkdirSync(p('memory/lessons'), { recursive: true });
      writeFileSync(p('memory/lessons', `${item.about}.md`), `${existsSync(p('memory/lessons', `${item.about}.md`)) ? readFileSync(p('memory/lessons', `${item.about}.md`), 'utf8') : ''}- ${res.detail} _(feedback ${item.id})_\n`);
    } else if (res.action === 'process_proposal' && res.detail) {
      M.writeDoc(`org/proposals/${day}-feedback-${item.id}.md`, `# From the feedback box (${item.id})\n${item.kind} from ${item.by} about ${item.about}: ${item.text}\n\n${res.detail}\n`);
    } else if (res.action === 'owner_request' && res.detail) {
      const f = await T.fileOnce(cfg.product.tracker, { title: `[owner] ${res.detail.slice(0, 80)}`, labels: ['sf-owner-request'], body: `${res.detail}\n\n---\nFrom feedback item ${item.id} (${item.kind} from ${item.by} about ${item.about}).` }).catch(() => null);
      if (f) { if (!f.duplicate) await T.assign(cfg.product.tracker, f.n, owners(cfg)).catch(() => {}); done = `owner request #${f.n}${f.duplicate ? ' (merged)' : ''}`; }
    } else if (res.action === 'performance_review' && item.about !== 'org') {
      await import('./coe.mjs').then((C) => C.performanceReview(cfg, item.about, `upheld complaint ${item.id}: ${item.text.slice(0, 300)}`)).catch((e) => { done = `review failed: ${e.message.slice(0, 80)}`; });
    }
    Object.assign(item, { status: 'resolved', outcome: res.outcome, action: done, reply: res.reply, resolvedAt: new Date().toISOString() });
    writeFileSync(fileOf(item.id), JSON.stringify(item, null, 2));
    M.record('feedback_resolved', { item: item.id, about: item.about, outcome: res.outcome, action: done }, { actor: 'chief-of-staff', issue: item.issue });
    resolved++;
  }
  for (const d of r.out.decisions ?? []) if (d.title && d.decision) M.decide({ rationale: '', ...d }, { actor: 'chief-of-staff', scope: 'org/feedback' });
  return { resolved, cost: r.cost };
}
