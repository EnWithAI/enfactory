// Product discovery. The org studies every repo, builds one shared picture of the product,
// and asks the human only what the code can't answer. The result lives in memory/product/.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { p } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import * as M from './memory.mjs';
import { ensureBase, git } from './repos.mjs';
import { gh, createIssue, assign } from './tracker.mjs';
import { holderOf, vendors } from './config.mjs';

const QUESTION = {
  type: 'object',
  properties: {
    question: { type: 'string' }, why: { type: 'string', description: 'What decision this unblocks.' },
    default: { type: 'string', description: 'What the org will assume if nobody answers.' }, repo: { type: 'string' },
    owner_role: { type: 'string', description: 'The org role whose job it is to decide this (e.g. product-owner, architect, security, sre).' },
    kind: { enum: ['decision', 'vendor'], description: 'decision = a role in the org decides it. vendor = needs something that only exists outside the org (credentials, accounts, contracts, money).' },
  },
  required: ['question', 'why', 'default'],
};
const STUDY = {
  type: 'object',
  properties: {
    doc_markdown: { type: 'string' },
    summary: { type: 'string', description: 'Two sentences: what this repo is and does.' },
    questions: { type: 'array', items: QUESTION },
    decisions: { type: 'array', items: DECISION },
    learnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['doc_markdown', 'summary', 'questions'],
};
const SYNTH = {
  type: 'object',
  properties: {
    overview_markdown: { type: 'string' },
    questions: { type: 'array', items: QUESTION, description: 'Consolidated, deduplicated, most important first. At most 15.' },
    decisions: { type: 'array', items: DECISION },
    learnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['overview_markdown', 'questions'],
};

const doc = (name) => p('memory/product/repos', `${name}.md`);
const QFILE = p('memory/product/questions.json');
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');

async function study(cfg, r, prev) {
  const base = await ensureBase(r);
  const sha = await git(['rev-parse', 'HEAD'], base);
  if (prev && prev === sha) return { r, sha, skipped: true };
  const delta = prev ? await git(['log', '--stat', '--oneline', `${prev}..${sha}`], base).catch(() => '') : '';
  const res = await runAgent({
    cfg, role: 'architect', cwd: base, label: `discover-${r.name}`, schema: STUDY,
    prompt: `# Product discovery: study the \`${r.name}\` repo (${r.repo})\nYou are in its checkout (read-only). Hint from the owner: ${r.about || '(none)'}\n\n` +
      (prev ? `## Update mode\nThe existing doc is below. It changed since ${prev.slice(0, 8)}:\n\`\`\`\n${delta.slice(0, 15000)}\n\`\`\`\nUpdate the doc for these changes only.\n\n${read(doc(r.name))}\n\n` : '') +
      `Write the definitive engineering doc for this repo. Every agent will read it before touching the code. Cite file paths for every claim.\n` +
      `1. **Purpose.** What it does, who uses it, and its place in the product.\n2. **Stack.** Languages, frameworks, and key dependencies with versions.\n` +
      `3. **Architecture.** Modules, entry points, request and data flow, and the domain model and its main entities.\n` +
      `4. **Interfaces.** APIs it exposes and consumes, events and queues, and its contracts with the other repos (${cfg.product.repos.map((x) => x.name).join(', ')}).\n` +
      `5. **Data.** Stores, schemas, and migrations.\n6. **Build, test, and run.** Exact commands, test layout, and coverage gaps.\n` +
      `7. **CI/CD and infrastructure.** Workflows, IaC (Terraform, CDK, CloudFormation, Serverless), AWS services used, environments, and how it deploys today.\n` +
      `8. **Conventions.** Code style, error handling, logging, feature flags, and config and secrets handling.\n` +
      `9. **Risks.** Hotspots, tech debt, security-sensitive areas, and areas without tests.\n\n` +
      `Then list the open questions the code can't answer (business intent, users, SLAs, environments, constraints). ` +
      `Don't ask anything you can find in the code. Give each one a proposed default, the org role that owns the decision, and its kind.`,
  });
  return { r, sha, res };
}

export async function discover(cfg, { refresh = false, interactive = process.stdin.isTTY } = {}) {
  mkdirSync(p('memory/product/repos'), { recursive: true });
  const known = M.kv('discovery');
  const repos = cfg.product.repos;
  console.log(`Studying ${repos.length} repo(s)…`);
  const studied = await Promise.all(repos.map((r) => study(cfg, r, refresh ? known.repos?.[r.name] : null)));

  const shas = { ...(known.repos ?? {}) };
  let questions = [];
  for (const { r, sha, res, skipped } of studied) {
    if (skipped) { console.log(`  = ${r.name} unchanged`); continue; }
    if (!res.ok) { console.error(`  ✗ ${r.name}: ${res.error}`); continue; }
    writeFileSync(doc(r.name), `<!-- ${r.repo}@${sha} -->\n${res.out.doc_markdown}`);
    for (const d of res.out.decisions ?? []) M.decide(d, { actor: 'architect', scope: `product/${r.name}` });
    for (const l of res.out.learnings ?? []) M.learn(l, { actor: 'architect' });
    questions.push(...res.out.questions.map((q) => ({ ...q, repo: r.name })));
    shas[r.name] = sha;
    console.log(`  ✓ ${r.name}: ${res.out.summary} ($${res.cost.toFixed(2)})`);
  }
  if (refresh && Object.keys(shas).every((k) => shas[k] === known.repos?.[k])) return console.log('Nothing changed.');

  const issues = await gh(['issue', 'list', '-R', cfg.product.tracker, '--state', 'all', '--limit', '60', '--json', 'number,title,state,labels'])
    .catch(() => '[]');
  const synth = await runAgent({
    cfg, role: 'product-manager', label: 'discover-overview', schema: SYNTH,
    prompt: `# Product discovery: the whole product\nRepo docs written by the architect:\n` +
      repos.map((r) => `\n---\n## ${r.name} (${r.repo})\n${read(doc(r.name))}`).join('\n') +
      `\n\n## Client-approved engagement documents (the contract: brief, requirements, compliance, proposal, roadmap, release plan)\n` +
      ['brief', 'requirements', 'compliance', 'proposal', 'roadmap', 'release_plan', 'release_cycle'].map((k) => { const f = JSON.parse(read('memory/state/engagement.json') || '{}').docs?.[k]; return f ? `### ${k}\n${read(f).replace(/^---[\s\S]*?---\n/, '').slice(0, 7000)}` : ''; }).join('\n') +
      `\n\n## Recent issues in ${cfg.product.tracker}\n${issues}\n\n## Human answers so far\n${read(p('memory/product/answers.md')) || '(none)'}\n\n` +
      `## Existing overview\n${read(p('memory/product/overview.md')) || '(none)'}\n\n` +
      `Write memory/product/overview.md, the product's single source of truth for every agent. Include:\n` +
      `- What the product is, who the users and customers are, the jobs to be done, and the business model if visible.\n` +
      `- A system map: how the repos fit together (mermaid diagram), cross-repo contracts, and shared data.\n` +
      `- Environments and deployment on AWS: services, accounts and regions if known, and the promotion path.\n` +
      `- A domain glossary. Quality attributes (performance, availability, compliance) observed or assumed.\n` +
      `- Known gaps and risks.\n\nThen consolidate the open questions. Merge the repo-level ones below, drop any the answers already cover, and keep the 15 that matter most. ` +
      `Give each one owner_role (one of: ${Object.keys(cfg.roles).join(', ')}) and kind. Most questions are decisions the org's roles own. Use kind vendor only for things that exist outside the org.\n` +
      JSON.stringify(questions, null, 1),
  });
  if (!synth.ok) return console.error(synth.error);
  writeFileSync(p('memory/product/overview.md'), synth.out.overview_markdown);
  for (const d of synth.out.decisions ?? []) M.decide(d, { actor: 'product-manager', scope: 'product' });
  for (const l of synth.out.learnings ?? []) M.learn(l, { actor: 'product-manager' });
  writeFileSync(QFILE, JSON.stringify(synth.out.questions, null, 2));
  M.kv('discovery', { at: new Date().toISOString(), repos: shas });
  M.record('discovered', { repos: Object.keys(shas), questions: synth.out.questions.length });
  console.log(`\nWrote memory/product/overview.md. The org has ${synth.out.questions.length} question(s) for you.`);
  if (synth.out.questions.length) await delegate(cfg, { interactive });
}

/**
 * Route open questions to whoever owns them. Agent-held roles decide (with an ADR each). Questions for roles a person
 * holds wait for that person. Questions only a vendor can answer become vendor requests.
 */
export async function delegate(cfg, { interactive = false } = {}) {
  let qs = existsSync(QFILE) ? JSON.parse(readFileSync(QFILE, 'utf8')) : [];
  if (!qs.length) return console.log('No open questions.');
  const roles = Object.keys(cfg.roles);
  if (qs.some((q) => !roles.includes(q.owner_role) || !q.kind)) { // classify questions from older runs
    const c = await runAgent({ cfg, role: 'chief-of-staff', label: 'route-questions',
      schema: { type: 'object', properties: { routes: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' }, owner_role: { enum: roles }, kind: { enum: ['decision', 'vendor'] } }, required: ['n', 'owner_role', 'kind'] } } }, required: ['routes'] },
      prompt: `Assign each question to the org role whose job it is to decide it, and set its kind. Roles: ${roles.join(', ')}. ` +
        `Agents decide everything within their role. kind=vendor only when the answer exists solely outside the org (credentials, accounts, contracts, money, legal).\n\n` +
        qs.map((q, i) => `${i + 1}. ${q.question}`).join('\n') });
    if (!c.ok) throw new Error(c.error);
    for (const r of c.out.routes) if (qs[r.n - 1]) Object.assign(qs[r.n - 1], { owner_role: r.owner_role, kind: r.kind });
  }
  const left = [];
  const byRole = {};
  for (const q of qs) {
    if (q.kind === 'vendor') {
      const m = await createIssue(cfg.product.tracker, { title: `[vendor] ${q.question.slice(0, 80)}`, labels: ['sf-vendor-request'],
        body: `**Raised during product discovery.**\n\n${q.question}\n\n**Why:** ${q.why}\n**Assumed meanwhile:** ${q.default}\n\n> ⚠️ Never paste secrets here. Reply with where you put them, and close this issue.` });
      await assign(cfg.product.tracker, m, vendors(cfg)).catch(() => {});
      recordAnswer(q.question, `${q.default} (assumed until vendor request #${m} is fulfilled)`, { why: q.why, by: 'chief-of-staff' });
      console.log(`  → vendor request #${m}: ${q.question.slice(0, 70)}`);
    } else if (holderOf(cfg, q.owner_role)) left.push(q);
    else (byRole[q.owner_role] ??= []).push(q);
  }
  await Promise.all(Object.entries(byRole).map(async ([role, list]) => {
    const r = await runAgent({ cfg, role, label: `decide-questions`,
      schema: { type: 'object', properties: { answers: { type: 'array', items: { type: 'object', properties: { n: { type: 'number' }, answer: { type: 'string' }, rationale: { type: 'string' } }, required: ['n', 'answer', 'rationale'] } } }, required: ['answers'] },
      prompt: `# Decisions for you (${role})\nThese open product questions fall within your role. Decide each one, as your role would at a top company. ` +
        `Use the product brief (${p('memory/product/overview.md')}), the repo docs, earlier answers (${p('memory/product/answers.md')}), and your judgement. ` +
        `Prefer the smallest sound decision you can revisit later. The default is a suggestion, not a requirement.\n\n` +
        list.map((q, i) => `${i + 1}. ${q.question}\n   why it matters: ${q.why}\n   suggested default: ${q.default}`).join('\n\n') });
    if (!r.ok) { console.error(`  ✗ ${role}: ${r.error}`); left.push(...list); return; }
    for (const a of r.out.answers) {
      const q = list[a.n - 1];
      if (q) { recordAnswer(q.question, a.answer, { why: a.rationale, by: role }); console.log(`  ✓ ${role} decided: ${q.question.slice(0, 70)}`); }
    }
  }));
  writeFileSync(QFILE, JSON.stringify(left, null, 2));
  if (left.length) {
    console.log(`\n${left.length} question(s) belong to roles that people hold:`);
    if (interactive) await interview(cfg); else console.log('Answer them with: sf answer');
  }
  await refreshOverview(cfg);
}

/** Ask the human the pending questions in the terminal. Each answer becomes an ADR and shared knowledge. */
export async function interview(cfg) {
  const qs = existsSync(QFILE) ? JSON.parse(readFileSync(QFILE, 'utf8')) : [];
  if (!qs.length) return console.log('No open questions.');
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  console.log('\nPress Enter to accept the default, type "skip" to leave a question open, or type your answer.\n');
  const left = [];
  let answered = 0;
  for (const [i, q] of qs.entries()) {
    process.stdout.write(`\n[${i + 1}/${qs.length}]${q.repo ? ` (${q.repo})` : ''} ${q.question}\n  why: ${q.why}\n  default: ${q.default}\n> `);
    const { value, done } = await lines.next();
    if (done) { left.push(...qs.slice(i)); break; } // input ended, so keep the rest for next time
    const a = value.trim();
    if (a === 'skip') left.push(q);
    else { recordAnswer(q.question, a || q.default, { why: q.why, defaulted: !a }); answered++; }
    writeFileSync(QFILE, JSON.stringify([...left, ...qs.slice(i + 1)], null, 2)); // progress survives Ctrl-C
  }
  rl.close();
  writeFileSync(QFILE, JSON.stringify(left, null, 2));
  console.log(`\nRecorded ${answered} answer(s) in memory/product/answers.md. ${left.length} still open.`);
  if (answered) await refreshOverview(cfg);
}

/** Non-interactive answering: list open questions, answer one by index, or accept all defaults. */
export async function answer(cfg, { index, text, defaults = false } = {}) {
  const qs = existsSync(QFILE) ? JSON.parse(readFileSync(QFILE, 'utf8')) : [];
  if (defaults) { for (const q of qs) recordAnswer(q.question, q.default, { why: q.why, defaulted: true }); writeFileSync(QFILE, '[]'); }
  else if (index) {
    const q = qs[index - 1];
    if (!q) throw new Error(`no open question #${index}`);
    recordAnswer(q.question, text || q.default, { why: q.why, defaulted: !text });
    writeFileSync(QFILE, JSON.stringify(qs.filter((_, i) => i !== index - 1), null, 2));
  } else {
    qs.forEach((q, i) => console.log(`${i + 1}. ${q.repo ? `(${q.repo}) ` : ''}${q.question}\n   why: ${q.why}\n   default: ${q.default}\n`));
    return console.log(qs.length ? 'Answer with: sf answer <n> "<text>" · sf answer <n> (accept default) · sf answer --defaults · then sf answer --done' : 'No open questions.');
  }
}
export { refreshOverview };

export function recordAnswer(question, answer, { why = '', defaulted = false, issue = null, by = 'human' } = {}) {
  mkdirSync(p('memory/product'), { recursive: true });
  appendFileSync(p('memory/product/answers.md'), `\n## ${question}\n${answer}${defaulted ? ' _(accepted default)_' : ''}\n<sub>${by}${issue ? `, #${issue}` : ''}, ${new Date().toISOString().slice(0, 10)}</sub>\n`);
  M.decide({ title: question, decision: answer, rationale: why || 'Answered by the product owner.' }, { actor: by, issue, scope: 'product' });
}

async function refreshOverview(cfg) {
  const res = await runAgent({
    cfg, role: 'product-manager', label: 'discover-answers',
    schema: { type: 'object', properties: { overview_markdown: { type: 'string' } }, required: ['overview_markdown'] },
    prompt: `Update the product overview with the human's answers. Where an answer contradicts an assumption, the answer wins.\n\n## Overview\n${read(p('memory/product/overview.md'))}\n\n## Answers\n${read(p('memory/product/answers.md'))}`,
  });
  if (res.ok) { writeFileSync(p('memory/product/overview.md'), res.out.overview_markdown); console.log('Overview updated with your answers.'); }
}
