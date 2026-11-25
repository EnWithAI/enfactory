// Client engagements. Sales takes on the project from the client, the analyst clarifies requirements with them, compliance sets the
// regulatory scope, sales proposes (scope, timeline, team, cost), the org sets itself up for the project, and the product owner and
// architect plan the roadmap, releases and cycle. The client approves the proposal and the plan; then the team builds planned releases.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { p, loadConfig } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import * as M from './memory.mjs';

const STATE = p('memory/state/engagement.json'), THREAD = p('memory/engagement/thread.jsonl');
const read = (f) => (existsSync(p(f)) ? readFileSync(p(f), 'utf8') : '');
export const PHASES = ['intake', 'requirements', 'proposal', 'setup', 'planning', 'delivery'];
export const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null);
const save = (s) => { mkdirSync(p('memory/state'), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); };
export const thread = () => (existsSync(THREAD) ? readFileSync(THREAD, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
function say(from, text, extra = {}) {
  mkdirSync(p('memory/engagement'), { recursive: true });
  const m = { at: new Date().toISOString(), from, text, ...extra };
  appendFileSync(THREAD, JSON.stringify(m) + '\n');
  M.record('engagement_message', { from, text: text.slice(0, 300) }, { actor: from === 'client' ? 'client' : from });
  return m;
}
function doc(cfg, key, title, summary, markdown, by) {
  const L = { publish: null };
  return import('./library.mjs').then((lib) => lib.publish(cfg, { folder: 'engagement', title, summary, audience: 'client and delivery team', kind: key, markdown }, { actor: by }))
    .then((file) => { const s = state(); s.docs = { ...s.docs, [key]: file }; save(s); return file; }).catch(() => L.publish);
}
const transcript = () => thread().slice(-60).map((m) => `**${m.from === 'client' ? 'Client' : m.from}:** ${m.text}`).join('\n\n');
const docsText = (s) => Object.entries(s.docs ?? {}).map(([k, f]) => `## ${k}\n${read(f).replace(/^---[\s\S]*?---\n/, '').slice(0, 8000)}`).join('\n\n');

// ── conversational phases: the client talks to sales (intake) and the analyst (requirements) ──
const CONVO = {
  intake: { role: 'account-executive', doc: 'brief', title: 'Project brief',
    goal: `Take on the client's project. Understand the problem, users, product type, markets, regulatory picture, integrations, ` +
      `timeline (hard dates and why), budget envelope, what exists today, who decides, and the GitHub repo to build in (or that they want a new one). ` +
      `When you have enough for a solid brief, play it back, set phase_complete, and write the brief.` },
  requirements: { role: 'analyst', doc: 'requirements', title: 'Requirements',
    goal: `Clarify the requirements with the client, working from the approved brief. Cover users and roles, key journeys, business rules ` +
      `(amounts, limits, fees, currencies, cut-offs), data, integrations, non-functional needs, and the fintech baseline. Ask one or two precise ` +
      `questions at a time, offering a default. When every must-have is testable, play back the summary, set phase_complete, and write the ` +
      `requirements document: numbered requirements with priority (must/should/could), Given/When/Then acceptance criteria, and the source answer.` },
};
const TURN = { type: 'object', properties: {
  reply_markdown: { type: 'string', description: 'What you say to the client now. Plain words. At most two questions.' },
  phase_complete: { type: 'boolean', description: 'true only when you have everything this phase needs and have played it back.' },
  document_markdown: { type: 'string', description: 'Only when phase_complete: the full document for this phase.' },
  document_summary: { type: 'string' },
  project_name: { type: 'string' }, repo: { type: 'string', description: 'owner/name on GitHub, if the client gave one' },
  timeline: { type: 'string' }, budget: { type: 'string' },
  decisions: { type: 'array', items: DECISION },
}, required: ['reply_markdown', 'phase_complete'] };

async function turn(cfg, s) {
  const c = CONVO[s.phase];
  const r = await runAgent({ cfg, role: c.role, label: `engage-${s.phase}`, schema: TURN,
    prompt: `# Client engagement · ${s.phase}\nYou are talking with the client directly, in the Client room.\n\n## Your goal in this phase\n${c.goal}\n\n` +
      `## The fintech baseline we hold every product to\n${read('org/policies/fintech-baseline.md')}\n\n## Documents so far\n${docsText(s) || '(none yet)'}\n\n` +
      `## Conversation so far\n${transcript() || '(you are opening the conversation: introduce yourself in one line and ask your first question)'}`,
  });
  if (!r.ok) { say('system', `The ${c.role} couldn't respond (${String(r.error).slice(0, 160)}). Send your message again.`); return; }
  const v = r.out;
  Object.assign(s.project, Object.fromEntries(Object.entries({ name: v.project_name, timeline: v.timeline, budget: v.budget }).filter(([, x]) => x)));
  if (v.repo && /^[\w.-]+\/[\w.-]+$/.test(v.repo)) s.repo = v.repo;
  for (const d of v.decisions ?? []) M.decide(d, { actor: c.role, scope: 'engagement' });
  save(s);
  say(c.role, v.reply_markdown);
  if (v.phase_complete && v.document_markdown) {
    await doc(cfg, c.doc, `${c.title}${s.project.name ? `: ${s.project.name}` : ''}`, v.document_summary ?? '', v.document_markdown, c.role);
    await advance(cfg);
  }
}

// ── generated phases ──
async function proposal(cfg, s) {
  // Compliance sets the regulatory scope first; the proposal then includes it.
  const comp = await runAgent({ cfg, role: 'compliance-officer', label: 'engage-compliance',
    schema: { type: 'object', properties: { markdown: { type: 'string' }, summary: { type: 'string' } }, required: ['markdown', 'summary'] },
    prompt: `# Regulatory scope and controls\nWrite the regulatory scope for this engagement: what applies and what doesn't (PCI DSS, PSD2/SCA, KYC/AML, GDPR and residency, ` +
      `licensing), the risk register (likelihood, impact, owner, control), and the controls each requirement needs as testable acceptance criteria.\n\n` +
      `${read('org/policies/fintech-baseline.md')}\n\n${docsText(s)}` });
  if (comp.ok) await doc(cfg, 'compliance', `Regulatory scope and controls${s.project.name ? `: ${s.project.name}` : ''}`, comp.out.summary, comp.out.markdown, 'compliance-officer');
  const econ = await import('./staffing.mjs').then((S) => S.economics(cfg)).catch(() => ({}));
  const r = await runAgent({ cfg, role: 'account-executive', label: 'engage-proposal',
    schema: { type: 'object', properties: { markdown: { type: 'string' }, summary: { type: 'string' }, message: { type: 'string', description: 'A short note to the client presenting the proposal.' } }, required: ['markdown', 'summary', 'message'] },
    prompt: `# Write the proposal\nFrom the brief, requirements and regulatory scope below, write the proposal: scope in and out, phases, timeline with dates, ` +
      `the team you are assigning (roles from our org: ${Object.keys(cfg.roles).join(', ')}), a cost estimate (agent cost per run from these economics: ` +
      `${JSON.stringify(econ.roles ?? []).slice(0, 2500)}), assumptions, risks, and what we need from the client (repo, credentials, test accounts, decisions). ` +
      `Be honest about feasibility.\n\n${docsText(state())}` });
  if (!r.ok) return say('system', `The proposal couldn't be written (${String(r.error).slice(0, 160)}). Ask again in the room.`);
  await doc(cfg, 'proposal', `Proposal${s.project.name ? `: ${s.project.name}` : ''}`, r.out.summary, r.out.markdown, 'account-executive');
  const st = state(); st.awaiting = 'approval'; save(st);
  say('account-executive', `${r.out.message}\n\n**Please review the proposal and approve it, or tell me what to change.**`);
}

/** After the proposal is approved: point the factory at the project and set the org up for it (discovery, recruiting, genesis). */
async function setup(cfg, s) {
  if (!s.repo) { const st = state(); st.awaiting = 'reply'; save(st); return say('account-executive', 'To set the team up I need the GitHub repository to build in (owner/name), or tell me to ask you for a new one to be created. Which repo should we use?'); }
  const doc = (await import('yaml')).parseDocument(readFileSync(p('org/org.yaml'), 'utf8'));
  doc.setIn(['product', 'name'], s.project.name || 'Client project');
  doc.setIn(['product', 'tracker'], s.repo);
  doc.setIn(['product', 'repos'], doc.createNode([{ name: s.repo.split('/')[1], repo: s.repo, default_branch: 'main', about: (s.project.summary ?? '').slice(0, 200) }]));
  writeFileSync(p('org/org.yaml'), doc.toString());
  const fresh = loadConfig();
  say('chief-of-staff', `Setting the team up for **${s.project.name || 'the project'}** in \`${s.repo}\`: studying the repo, recruiting the specialists it needs, and writing our team charters for it. I'll tell you when planning starts.`);
  const steps = s.setupDone ?? {};
  const T = await import('./tracker.mjs');
  if (!steps.labels) { await T.ensureLabels(s.repo, fresh).catch(() => {}); steps.labels = true; }
  if (!steps.discover) { await import('./discovery.mjs').then((D) => D.discover(fresh, { interactive: false })).catch((e) => say('system', `Repo study failed: ${e.message.slice(0, 120)}`)); steps.discover = true; }
  if (!steps.recruit) { await import('./staffing.mjs').then((S) => S.recruit(loadConfig())).catch(() => {}); steps.recruit = true; }
  if (!steps.genesis) { await import('./genesis.mjs').then((G) => G.genesis(loadConfig())).catch(() => {}); steps.genesis = true; }
  const st = state(); st.setupDone = steps; save(st);
  await advance(loadConfig());
}

const PLAN = { type: 'object', properties: {
  roadmap_markdown: { type: 'string' }, release_plan_markdown: { type: 'string' }, release_cycle_markdown: { type: 'string' },
  releases: { type: 'array', items: { type: 'object', properties: {
    name: { type: 'string' }, goal: { type: 'string', description: 'One demoable outcome.' }, target_date: { type: 'string' },
    demo_markdown: { type: 'string', description: 'The steps the client follows to see it working.' },
    items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string', description: 'What to build, with the requirement IDs and acceptance criteria it covers.' }, priority: { enum: ['P0', 'P1', 'P2', 'P3'] } }, required: ['title', 'body'] } } },
    required: ['name', 'goal', 'demo_markdown', 'items'] } },
  message: { type: 'string' }, decisions: { type: 'array', items: DECISION },
}, required: ['roadmap_markdown', 'release_plan_markdown', 'release_cycle_markdown', 'releases', 'message'] };

async function planning(cfg, s, change = '') {
  const r = await runAgent({ cfg, role: 'product-owner', label: 'engage-planning', schema: PLAN,
    prompt: `# Plan the engagement\nWith the architect's view of the system (memory/product/, org/charters/engineering.md), plan delivery from the approved documents below.\n` +
      `1. **Roadmap**: the outcomes in order, through to the full scope.\n2. **Release plan**: releases, each ending in **one demoable piece** with a goal, target date, ` +
      `demo steps, and the work items it contains (each item cites the requirement IDs and acceptance criteria it delivers). Release 1 must be thin and ` +
      `visible, and meet the fintech baseline for what it contains (for example, authentication from the first release that holds user data).\n` +
      `3. **Release cycle**: cadence and ceremonies (planning, demo to the client, retrospective), and how scope changes are handled.\n` +
      `Fit the client's timeline and budget; say plainly if it doesn't fit.\n${change ? `\n## The client asked for these changes\n${change}\n` : ''}\n${docsText(s)}` });
  if (!r.ok) return say('system', `Planning failed (${String(r.error).slice(0, 160)}). Ask again in the room.`);
  const v = r.out;
  for (const d of v.decisions ?? []) M.decide(d, { actor: 'product-owner', scope: 'engagement/plan' });
  await doc(cfg, 'roadmap', 'Roadmap', 'The outcomes in order.', v.roadmap_markdown, 'product-owner');
  await doc(cfg, 'release_plan', 'Release plan', `${v.releases.length} releases, each ending in a demo.`, v.release_plan_markdown, 'product-owner');
  await doc(cfg, 'release_cycle', 'Release cycle', 'Cadence and ceremonies.', v.release_cycle_markdown, 'product-owner');
  const st = state(); st.releases = v.releases; st.awaiting = 'approval'; save(st);
  say('product-owner', `${v.message}\n\n**Please review the roadmap, release plan and release cycle, and approve them, or tell me what to change.**`);
}

/** Plan approved: file Release 1's items and start delivery. Later releases come from the same plan. */
export async function startRelease(cfg, number) {
  const s = state(), rel = s.releases?.[number - 1];
  if (!rel) return false;
  const T = await import('./tracker.mjs'), R = await import('./release.mjs');
  const ms = await T.gh(['api', '-X', 'POST', `repos/${cfg.product.tracker}/milestones`, '-f', `title=Release ${number}`, '-f', `description=${rel.goal.slice(0, 900)}`]).then((o) => JSON.parse(o).number).catch(() => null);
  const issues = [];
  for (const it of rel.items) {
    const n = await T.createIssue(cfg.product.tracker, { title: it.title, labels: [cfg.product.intake_label, it.priority ?? 'P1'], body: `${it.body}\n\n---\nRelease ${number}: ${rel.name}. Planned in the client-approved release plan (library/engagement).` }).catch(() => null);
    if (n) { issues.push(n); await T.gh(['issue', 'edit', String(n), '-R', cfg.product.tracker, '--milestone', `Release ${number}`]).catch(() => {}); }
  }
  R.adopt({ number, goal: rel.goal, demo: rel.demo_markdown, exit: [`Demo: ${rel.name}`], issues, status: 'active', started: new Date().toISOString(), milestone: ms, milestoneTitle: `Release ${number}`, target: rel.target_date ?? null, planned: true });
  say('product-owner', `**Release ${number} has started: ${rel.name}.** Goal: ${rel.goal}${rel.target_date ? ` Target: ${rel.target_date}.` : ''} Work items: ${issues.map((n) => `#${n}`).join(', ')}.`);
  return true;
}

/** Move to the next phase and do what it needs. */
async function advance(cfg) {
  const s = state();
  s.phase = PHASES[PHASES.indexOf(s.phase) + 1]; s.awaiting = null; save(s);
  M.record('engagement_phase', { phase: s.phase }, { actor: 'account-executive' });
  if (CONVO[s.phase]) return turn(cfg, s);
  if (s.phase === 'proposal') return proposal(cfg, s);
  if (s.phase === 'setup') return setup(cfg, s);
  if (s.phase === 'planning') return planning(loadConfig(), state());
  if (s.phase === 'delivery') return startRelease(loadConfig(), 1);
}

// ── what the client can do (dashboard or CLI) ──
let busy = false, followUp = false;
/** One team turn at a time. Client messages that arrive mid-turn queue a follow-up turn, so nothing the client adds is missed. */
const guarded = (fn) => {
  if (busy) throw new Error('The team is still working on a reply. Wait for it before approving.');
  busy = true;
  const run = async () => {
    try { await fn(); while (followUp) { followUp = false; await respond(); } }
    finally { busy = false; }
  };
  return run();
};
export const working = () => busy;

/** The team's response to the latest client messages, for the current phase. */
async function respond(cfg = loadConfig()) {
  const s = state(), last = thread().filter((m) => m.from === 'client').at(-1)?.text ?? '';
  if (CONVO[s.phase]) return turn(cfg, s);
  if (s.phase === 'proposal') return proposal(cfg, s); // revise with the client's comments in the thread
  if (s.phase === 'planning') return planning(cfg, s, last);
  if (s.phase === 'setup') { // the client is answering the repo question
    const m = last.match(/([\w.-]+\/[\w.-]+)/); if (m) { s.repo = m[1]; save(s); }
    return setup(cfg, state());
  }
}

export function start(cfg = loadConfig()) {
  if (state() && state().phase !== 'delivery') throw new Error('An engagement is already in progress.');
  save({ id: Date.now().toString(36), phase: 'intake', started: new Date().toISOString(), project: {}, docs: {}, awaiting: null });
  return guarded(() => turn(cfg, state()));
}
export function message(text, cfg = loadConfig()) {
  const s = state();
  if (!s) throw new Error('No engagement yet. Start one first.');
  if (!text?.trim()) throw new Error('Write a message first.');
  say('client', text.trim());
  if (busy) { followUp = true; return Promise.resolve({ queued: true }); } // the team answers it right after the current reply
  return guarded(() => respond(cfg));
}
export function approve(cfg = loadConfig()) {
  const s = state();
  if (!s || s.awaiting !== 'approval') throw new Error('Nothing is waiting for your approval.');
  say('client', `✓ Approved the ${s.phase === 'proposal' ? 'proposal' : 'roadmap, release plan and release cycle'}.`);
  M.decide({ title: `Client approved the ${s.phase}`, decision: `The client approved ${Object.entries(s.docs ?? {}).filter(([k]) => (s.phase === 'proposal' ? ['proposal', 'compliance'] : ['roadmap', 'release_plan', 'release_cycle']).includes(k)).map(([, f]) => f).join(', ')}.`, rationale: 'Client sign-off in the Client room.' }, { actor: 'client', scope: 'engagement' });
  return guarded(() => advance(cfg));
}
