// The org governs its own process. Open proposals (from genesis, audits, agents) go to a council chaired by the
// chief of staff. Accepted changes within the org's authority are applied to org.yaml and recorded as ADRs.
// Resources and safety (budgets, permissions, people, environments) stay with the owner and become owner requests.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { p, loadConfig, owners } from './config.mjs';
import { council } from './council.mjs';
import * as M from './memory.mjs';
import { fileOnce, assign } from './tracker.mjs';

/** Paths in org.yaml the org may change itself. Everything else is reserved for the owner. */
export function allowed(cfg, path) {
  const [a, b, c, d] = path.split('.');
  if (a === 'pipeline') return !!cfg.pipeline[b] && ['goal', 'next', 'approve', 'forward'].includes(c) && !d;
  if (a === 'roles') return !!cfg.roles[b] && ['headcount', 'model'].includes(c) && !d;
  return ['release.policy', 'observability.signals', 'observability.interval_minutes', 'gates.merge_by_risk.low',
    'gates.merge_by_risk.medium', 'gates.merge_by_risk.high', 'loops.max_loops', 'loops.council_after',
    'discovery.refresh_days', 'audit.interval_days', 'library.folders', 'quality.spec_lint.max_acs', 'quality.spec_lint.families', 'quality.spec_lint.verify'].includes(path) || (a === 'departments' && !!b);
}

const CHANGE = { type: 'object', properties: {
  proposal: { type: 'string' }, path: { type: 'string', description: 'Dotted org.yaml path, e.g. pipeline.security.next' },
  value_json: { type: 'string', description: 'The new value as JSON, e.g. ["merge","build"] or "text" or 2' }, reason: { type: 'string' } },
  required: ['proposal', 'path', 'value_json', 'reason'] };

export async function govern(cfg = loadConfig()) {
  const dir = p('org/proposals');
  const open = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  if (!open.length) return console.log('No open proposals.');
  const text = open.map((f) => `\n---\n# ${f}\n${readFileSync(p('org/proposals', f), 'utf8')}`).join('\n');
  const yaml = readFileSync(p('org/org.yaml'), 'utf8');
  console.log(`Governance council on ${open.length} proposal file(s)…`);

  const r = await council({
    cfg, name: `governance/${new Date().toISOString().slice(0, 10)}-${Date.now()}`, rounds: 1,
    topic: 'Which process changes should the org adopt?', chair: 'chief-of-staff', members: ['product-owner', 'architect', 'security', 'sre'],
    context: `## Open proposals\n${text}\n\n## Current org/org.yaml\n\`\`\`yaml\n${yaml}\n\`\`\`\n\n` +
      `## Authority\nThe org may change only: pipeline.<existing stage>.{goal,next,approve,forward}, roles.<existing role>.{headcount,model}, ` +
      `release.policy, observability.{signals,interval_minutes}, gates.merge_by_risk.*, loops.{max_loops,council_after}, discovery.refresh_days, audit.interval_days, library.folders (the whole list: path, title, purpose, owner, doc_types).\n` +
      `Everything else (budgets, capacity, tools and permissions, AWS, people, product repos, environments, deploy commands, owner_after) is the owner's. ` +
      `Request those as owner_requests only when clearly worth it. A proposal that needs code changes to the factory itself is an owner request too.\n` +
      `Adopt what improves flow or quality with evidence. Reject what adds cost without a clear gain, and say why.`,
    extraSchema: {
      changes: { type: 'array', items: CHANGE },
      rejected: { type: 'array', items: { type: 'object', properties: { proposal: { type: 'string' }, reason: { type: 'string' } }, required: ['proposal', 'reason'] } },
      owner_requests: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, what: { type: 'string' }, why: { type: 'string' } }, required: ['title', 'what', 'why'] } },
      decisions: { type: 'array', items: { type: 'object' } },
    },
  });
  if (!r.ok) throw new Error(r.error);
  const v = r.out;

  // Apply only what is within authority, and keep the file valid.
  copyFileSync(p('org/org.yaml'), p('.factory/org.yaml.bak'));
  const doc = parseDocument(yaml);
  const applied = [], refused = [];
  for (const c of v.changes ?? []) {
    if (!allowed(cfg, c.path)) { refused.push({ ...c, why: 'outside the org\'s authority' }); continue; }
    let value; try { value = JSON.parse(c.value_json); } catch { refused.push({ ...c, why: 'value is not JSON' }); continue; }
    const node = doc.createNode(value);
    if (Array.isArray(value) && value.every((x) => typeof x !== 'object')) node.flow = true;
    doc.setIn(c.path.split('.'), node);
    applied.push(c);
  }
  if (applied.length) {
    writeFileSync(p('org/org.yaml'), doc.toString());
    try { loadConfig(); } catch (e) {
      copyFileSync(p('.factory/org.yaml.bak'), p('org/org.yaml'));
      throw new Error(`governance changes made org.yaml invalid and were reverted: ${e.message}`);
    }
  }

  for (const c of applied) M.decide({ title: `Org change: ${c.path}`, decision: `Set \`${c.path}\` to \`${c.value_json}\` (from ${c.proposal}).`, rationale: c.reason }, { actor: 'chief-of-staff', scope: 'org' });
  for (const d of v.decisions ?? []) if (d.title && d.decision) M.decide({ rationale: '', ...d }, { actor: 'chief-of-staff', scope: 'org' });
  const requests = [];
  for (const o of v.owner_requests ?? []) {
    const { n } = await fileOnce(cfg.product.tracker, { title: `[owner] ${o.title}`, labels: ['sf-owner-request'],
      body: `The org's governance council requests a change only the owner can make.\n\n## What\n${o.what}\n\n## Why\n${o.why}\n\nTranscript: \`${r.thread}\`` }).catch(() => null);
    if (n) { await assign(cfg.product.tracker, n, owners(cfg)).catch(() => {}); requests.push(n); }
  }

  const day = new Date().toISOString().slice(0, 10);
  M.writeDoc(`memory/reports/governance-${day}-${Date.now()}.md`, [
    `# Governance ${day}`, '', v.summary ?? '', '', '## Applied',
    ...applied.map((c) => `- \`${c.path}\` = \`${c.value_json}\` (${c.proposal}): ${c.reason}`), applied.length ? '' : '_none_',
    '## Rejected', ...(v.rejected ?? []).map((x) => `- ${x.proposal}: ${x.reason}`),
    ...refused.map((x) => `- ${x.proposal} (\`${x.path}\`): refused by the dispatcher, ${x.why}`), '',
    '## Owner requests', ...requests.map((n) => `- #${n}`), requests.length ? '' : '_none_', '', `Transcript: \`${r.thread}\``,
  ].join('\n'));
  mkdirSync(p('org/proposals/decided'), { recursive: true });
  for (const f of open) renameSync(p('org/proposals', f), p('org/proposals/decided', f));
  M.record('governance', { applied: applied.length, rejected: (v.rejected ?? []).length + refused.length, owner_requests: requests.length, cost_usd: r.cost }, { actor: 'chief-of-staff' });
  console.log(`Applied ${applied.length}, rejected ${(v.rejected ?? []).length + refused.length}, owner requests ${requests.length}.`);
  return { applied, rejected: v.rejected, refused, requests };
}
