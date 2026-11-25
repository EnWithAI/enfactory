// Live view of the organisation, served on this machine only. Reads memory/ and org/ (no GitHub calls), so it works
// for anything that writes to the ledger: the dispatcher, genesis, discovery, councils.
import http from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, openSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { p, loadConfig, configured, paused, setPaused, agentFile, headcount, holderOf, teamOf } from './config.mjs';
import { events, record, writeDoc, decide } from './memory.mjs';
import { runAgent } from './worker.mjs';
import { createIssue, gh, humanComment, editLabels, closeIssue, MARK } from './tracker.mjs';
import { tree as libraryTree } from './library.mjs';
import { list as feedbackList } from './hr.mjs';

export const DEFAULT_PORT = 4340;
const list = (dir, ext = '.md') => (existsSync(p(dir)) ? readdirSync(p(dir)).filter((f) => f.endsWith(ext)).sort() : []);

function adrs(limit = 60) {
  return list('memory/decisions').reverse().slice(0, limit).map((f) => {
    const src = readFileSync(p('memory/decisions', f), 'utf8');
    const g = (k) => src.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1]?.replace(/^"|"$/g, '') ?? '';
    return { file: `memory/decisions/${f}`, title: g('title'), by: g('by'), issue: g('issue'), scope: g('scope'), date: g('date') };
  });
}

// Records: raw org memory, made readable. Every record gets a human title, a date, and (where known) an author and issue.
const headOf = (rel) => {
  try {
    const fd = readFileSync(p(rel), 'utf8').slice(0, 1500);
    const fm = fd.match(/^---\n([\s\S]*?)\n---/);
    const t = fm?.[1].match(/^title:\s*(.*)$/m)?.[1]?.replace(/^"|"$/g, '');
    const by = fm?.[1].match(/^(?:by|author):\s*(.*)$/m)?.[1]?.replace(/^"|"$/g, '');
    const h1 = fd.replace(/^---[\s\S]*?---\n/, '').match(/^#\s+(.+)$/m)?.[1];
    return { title: (t || h1 || '').replace(/\*\*/g, '').trim(), by: by || '' };
  } catch { return { title: '', by: '' }; }
};
const pretty = (s) => s.replace(/[-_]/g, ' ').replace(/\b\w/, (c) => c.toUpperCase());
const STAGE_ORDER_HINT = ['triage', 'analysis', 'design', 'feature-grooming', 'tech-grooming', 'build', 'review', 'security', 'release', 'verify', 'incident'];
function docs() {
  const out = [];
  const item = (tab, rel, extra = {}) => {
    const h = headOf(rel);
    out.push({ tab, file: rel, title: extra.title ?? (h.title || pretty(path.basename(rel, '.md'))), by: extra.by ?? h.by, updated: statSync(p(rel)).mtime.toISOString(), ...extra });
  };
  const add = (tab, dir, extra) => list(dir).forEach((f) => item(tab, `${dir}/${f}`, extra?.(f)));
  if (existsSync(p('org/operating-model.md'))) item('org', 'org/operating-model.md', { title: 'Operating model', by: 'chief-of-staff' });
  add('org', 'org/charters', (f) => ({ title: `${pretty(f.replace('.md', ''))} team charter` }));
  for (const [f, t] of [['overview', 'Product overview'], ['answers', 'Product answers and decisions']]) if (existsSync(p(`memory/product/${f}.md`))) item('org', `memory/product/${f}.md`, { title: t });
  add('org', 'memory/product/repos', (f) => ({ title: `Repo guide: ${f.replace('.md', '')}`, by: 'architect' }));
  add('org', 'memory/lessons', (f) => ({ title: `Lessons for ${f.replace('.md', '')}`, by: 'auditor' }));
  add('org', 'org/alumni', (f) => ({ title: `Alumni: ${f.replace('.md', '')}` }));
  add('proposals', 'org/proposals', (f) => ({ status: 'open' }));
  add('proposals', 'org/proposals/decided', (f) => ({ status: 'decided' }));
  add('coe', 'memory/coe', () => ({ by: 'auditor' }));
  add('reports', 'memory/reports');
  const ceo = 'memory/threads/ceo';
  if (existsSync(p(ceo))) add('ceo', ceo, () => ({ by: 'chief-of-staff' }));
  const walk = (dir) => existsSync(p(dir)) && readdirSync(p(dir)).forEach((f) => {
    const rel = `${dir}/${f}`;
    if (statSync(p(rel)).isDirectory()) { if (rel !== ceo) walk(rel); }
    else if (f.endsWith('.md')) item('discussions', rel, { issue: rel.match(/issue-(\d+)/)?.[1] ?? null });
  });
  walk('memory/threads');
  for (const d of list('memory/specs', '').filter((d) => statSync(p('memory/specs', d)).isDirectory())) {
    const issue = d.match(/\d+/)?.[0];
    list(`memory/specs/${d}`).forEach((f) => {
      const m = f.match(/^(.*?)(?:\.v(\d+))?\.md$/);
      item('work', `memory/specs/${d}/${f}`, { issue, stage: m[1], version: m[2] ? Number(m[2]) : null, order: STAGE_ORDER_HINT.indexOf(m[1]) });
    });
  }
  return out;
}

// ── spend: where the org's money and tokens go, and whether the economy rules are working ──
const taskOf = (label) => String(label ?? '').replace(/-[0-9a-f]{8}$/, '').replace(/-\d+$/, '').replace(/#\d+$/, '');
function spend(evs) {
  const runs = evs.filter((e) => e.type === 'run_finished');
  const since = (ms) => runs.filter((e) => Date.now() - new Date(e.ts) < ms);
  const switched = evs.find((e) => e.type === 'economy_enabled')?.ts ?? null;
  const tokens = (e) => (e.cache_read ?? 0) + (e.cache_write ?? 0) + (e.input ?? 0) + (e.output ?? 0);
  const group = (list, key) => {
    const g = {};
    for (const e of list) {
      const k = key(e), x = (g[k] ??= { key: k, runs: 0, cost: 0, tokens: 0, turns: 0, measured: 0, capped: 0, resumed: 0 });
      x.runs++; x.cost += e.cost_usd ?? 0; x.capped += e.capped ? 1 : 0; x.resumed += e.resumed ? 1 : 0;
      if (e.turns != null) { x.measured++; x.tokens += tokens(e); x.turns += e.turns; }
    }
    return Object.values(g).map((x) => ({ ...x, avgCost: x.cost / x.runs, avgTurns: x.measured ? x.turns / x.measured : null, avgTokens: x.measured ? x.tokens / x.measured : null }))
      .sort((a, b) => b.cost - a.cost);
  };
  // Rework: every run after the first of the same role on the same issue and task, plus councils and check retries.
  const seen = new Set();
  let rework = 0;
  for (const e of runs) {
    const k = `${e.actor}|${e.issue}|${taskOf(e.label)}`;
    if (e.issue && (seen.has(k) || /^council-/.test(e.label) || e.check_retry)) rework += e.cost_usd ?? 0;
    seen.add(k);
  }
  const window = (list) => ({ runs: list.length, cost: list.reduce((s, e) => s + (e.cost_usd ?? 0), 0) });
  // Before and after the economy rules, per task: the fair comparison is the average cost of the same kind of run.
  const compare = switched ? (() => {
    const before = group(runs.filter((e) => e.ts < switched), (e) => taskOf(e.label)), after = group(runs.filter((e) => e.ts >= switched), (e) => taskOf(e.label));
    return after.map((a) => ({ task: a.key, after: a.avgCost, afterRuns: a.runs, before: before.find((b) => b.key === a.key)?.avgCost ?? null }))
      .filter((r) => r.before != null).sort((a, b) => b.afterRuns - a.afterRuns).slice(0, 12);
  })() : [];
  return {
    today: window(since(864e5)), week: window(since(7 * 864e5)), all: window(runs), rework,
    byRole: group(runs, (e) => e.actor).slice(0, 20), byTask: group(runs, (e) => taskOf(e.label)).slice(0, 20),
    switched, compare,
  };
}

function state() {
  const cfg = loadConfig();
  const evs = events();
  const today = new Date().toISOString().slice(0, 10);

  // Running = run_started with no matching run_finished yet.
  const open = new Map();
  for (const e of evs) {
    const k = `${e.actor}|${e.label}|${e.issue}`;
    if (e.type === 'run_started') (open.get(k) ?? open.set(k, []).get(k)).push(e);
    if (e.type === 'run_finished') open.get(k)?.shift();
  }
  // Prefer the live files the worker streams to (they carry what the agent is doing). Fall back to ledger pairing.
  // Alive = the PID exists AND is still a Claude agent run (PIDs get reused by unrelated processes).
  const alive = (pid) => { try { return /claude/.test(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })); } catch { return false; } };
  const liveDir = p('.factory/live');
  const live = existsSync(liveDir) ? readdirSync(liveDir).flatMap((f) => {
    try { const j = JSON.parse(readFileSync(path.join(liveDir, f), 'utf8')); return alive(j.pid) ? [j] : []; } catch { return []; }
  }) : [];
  const running = live.length || !open.size
    ? live.map((j) => ({ role: j.role, label: j.label, issue: j.issue, since: j.since, actions: j.actions ?? [] }))
    : [...open.values()].flat().filter((e) => Date.now() - new Date(e.ts) < 3 * 3600e3).map((e) => ({ role: e.actor, label: e.label, issue: e.issue, since: e.ts, actions: [] }));

  // Issues from intake/transition events and per-issue state.
  const issues = {};
  for (const e of evs) {
    if (!e.issue) continue;
    const i = (issues[e.issue] ??= { n: e.issue, title: '', stage: null, loops: 0, cost: 0 });
    if (e.type === 'intake') { i.title = e.title; i.stage = e.to; }
    if (e.type === 'transition') { i.stage = e.to; i.loops = e.loops ?? i.loops; i.last = e.summary?.slice(0, 220); i.by = e.actor; }
    if (e.type === 'closed') i.stage = e.to;
    if (e.type === 'run_finished') i.cost += e.cost_usd ?? 0;
    if (e.type === 'escalated') i.waiting = e.message?.split('\n')[0];
    if (e.type === 'human_approved') i.waiting = null;
    if (e.type === 'vendor_request' && e.blocking) i.vendor = e.request;
    if (e.type === 'vendor_fulfilled') i.vendor = null;
    if (e.type === 'waiting' && e.reason === 'backlog') i.backlog = true;
    if (e.type === 'run_started' || e.type === 'transition') i.backlog = false;
  }
  for (const i of Object.values(issues)) {
    const f = p('memory/state', `issue-${i.n}.json`);
    if (existsSync(f)) { const s = JSON.parse(readFileSync(f, 'utf8')); Object.assign(i, { risk: s.risk, prs: s.prs, deployed: s.deployed }); }
    i.working = running.find((r) => String(r.issue) === String(i.n))?.role ?? null;
  }

  const teams = Object.entries(cfg.teams).map(([name, t]) => ({
    name, lead: t.lead,
    roles: t.roles.map((r) => ({ role: r, holder: holderOf(cfg, r), headcount: headcount(cfg, r), model: cfg.roles[r]?.model?.replace('claude-', ''),
      busy: running.filter((x) => x.role === r).length })),
  }));
  const runs = evs.filter((e) => e.type === 'run_finished');
  const handoffs = evs.filter((e) => e.type === 'transition').slice(-20).map((e) => ({ id: e.id, issue: e.issue, from: e.stage, to: e.to, by: e.actor, loop: e.loop }));
  const feed = evs.filter((e) => !['run_started'].includes(e.type)).slice(-200).reverse().map((e) => ({
    ts: e.ts, type: e.type, actor: e.actor, issue: e.issue,
    text: e.type === 'coe' ? `${e.title} · introduced by ${e.introduced_by}${e.escaped_by?.length ? `, escaped ${e.escaped_by.join(', ')}` : ''} · ${e.actions} action item(s)`
      : e.type === 'replaced' ? `${e.role} let go after ${e.defects} defects; generation ${e.gen} hired with corrected memory. ${e.reason ?? ''}`
      : e.summary ?? e.title ?? e.text ?? e.message ?? (e.type === 'run_finished' ? `${e.label} ${e.ok ? 'finished' : 'failed'} · $${(e.cost_usd ?? 0).toFixed(2)} · ${Math.round((e.ms ?? 0) / 1000)}s` : '') ??
      '',
    extra: e.to ? `→ ${e.to}` : e.adr ? e.adr : '',
    ok: e.ok, loop: e.loop,
  }));
  return {
    company: cfg.company?.name, product: cfg.product.name, tracker: cfg.product.tracker, repos: cfg.product.repos.map((r) => r.repo),
    build: statSync(new URL('./dashboard.html', import.meta.url)).mtimeMs,
    delivery: cfg.delivery ?? null, release: existsSync(p('memory/state/release.json')) ? JSON.parse(readFileSync(p('memory/state/release.json'), 'utf8')) : null, departments: cfg.departments ?? {}, stages: Object.keys(cfg.pipeline), stageRoles: Object.fromEntries(Object.entries(cfg.pipeline).map(([k, v]) => [k, v.role ?? v.council?.chair ?? 'dispatcher'])), handoffs, people: cfg.people ?? [], teams, running, issues: Object.values(issues), feed,
    feedback: (() => { const open = feedbackList().filter((i) => i.status === 'open'); return { open: open.length, proposed: open.filter((i) => i.proposal).length }; })(),
    spend: spend(evs), decisions: adrs(), docs: docs(), library: (() => { try { return libraryTree(); } catch { return []; } })(), generations: existsSync(p('memory/state/generations.json')) ? JSON.parse(readFileSync(p('memory/state/generations.json'), 'utf8')) : {},
    hiredRoles: [...new Set(evs.filter((e) => e.type === 'hired' && e.team).map((e) => e.role))],
    stats: {
      costToday: runs.filter((e) => e.ts >= today).reduce((s, e) => s + (e.cost_usd ?? 0), 0),
      costTotal: runs.reduce((s, e) => s + (e.cost_usd ?? 0), 0), budget: cfg.capacity.daily_budget_usd,
      runs: runs.length, decisions: evs.filter((e) => e.type === 'decision').length, learnings: evs.filter((e) => e.type === 'learning').length,
      genesis: evs.some((e) => e.type === 'genesis_finished') ? 'done' : evs.some((e) => e.type === 'genesis_started') ? 'running' : 'not run',
    },
  };
}

// ── an agent's record: everything this role has done ──
function agentProfile(role) {
  const cfg = loadConfig();
  if (!cfg.roles[role]) return null;
  const evs = events().filter((e) => e.actor === role || (e.type === 'coe' && (e.introduced_by === role || e.escaped_by?.includes(role))));
  const runs = evs.filter((e) => e.type === 'run_finished' && e.actor === role);
  const def = existsSync(agentFile(role)) ? readFileSync(agentFile(role), 'utf8') : '';
  const gens = existsSync(p('memory/state/generations.json')) ? JSON.parse(readFileSync(p('memory/state/generations.json'), 'utf8')) : {};
  const lessons = existsSync(p('memory/lessons', `${role}.md`)) ? readFileSync(p('memory/lessons', `${role}.md`), 'utf8').split('\n').filter(Boolean) : [];
  return {
    role, team: teamOf(cfg, role), model: cfg.roles[role].model, seats: headcount(cfg, role), holder: holderOf(cfg, role),
    generation: gens[role]?.gen ?? 1, description: def.match(/^description: (.*)$/m)?.[1]?.replace(/^"|"$/g, '') ?? '',
    stats: { runs: runs.length, failed: runs.filter((r) => !r.ok).length, cost: runs.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
      minutes: runs.reduce((s, r) => s + (r.ms ?? 0), 0) / 60e3, decisions: evs.filter((e) => e.type === 'decision' && e.actor === role).length,
      handoffs: evs.filter((e) => e.type === 'transition' && e.actor === role).length, loopsSent: evs.filter((e) => e.type === 'transition' && e.actor === role && e.loop).length,
      defects: evs.filter((e) => e.type === 'coe' && e.introduced_by === role).length, escapes: evs.filter((e) => e.type === 'coe' && e.escaped_by?.includes(role)).length },
    lessons: lessons.slice(-30),
    timeline: evs.filter((e) => e.type !== 'run_started').slice(-300).reverse().map((e) => ({ ts: e.ts, type: e.type, issue: e.issue, to: e.to, stage: e.stage ?? e.label,
      text: e.type === 'coe' ? `${e.introduced_by === role ? 'Introduced' : 'Escaped'}: ${e.title}` : e.summary ?? e.title ?? e.text ?? e.reason ??
        (e.type === 'run_finished' ? `${e.label} ${e.ok ? 'finished' : `failed: ${e.error ?? ''}`} · $${(e.cost_usd ?? 0).toFixed(2)} · ${Math.round((e.ms ?? 0) / 1000)}s` : ''),
      adr: e.adr ? `memory/decisions/${e.adr}.md` : null, artifact: e.artifact ?? null, coe: e.coe ? `memory/coe/${e.coe}.md` : null, ok: e.ok, loop: e.loop })),
  };
}

// ── the CEO asks the org ──
const asks = new Map(); // id -> { question, status, answer, started, cost } for questions this server process is answering
const ASK_DIR = p('.factory/asks');
const saveAsk = (job) => { mkdirSync(ASK_DIR, { recursive: true }); writeFileSync(path.join(ASK_DIR, `${job.id}.json`), JSON.stringify(job)); };
/** A question's state, from memory or disk. A question left "running" by a previous server process was cut off by a restart. */
function askState(id) {
  if (asks.has(id)) return asks.get(id);
  const f = path.join(ASK_DIR, `${path.basename(id)}.json`);
  if (!existsSync(f)) return { id, status: 'unknown', answer: 'This question is not known to the dashboard. Ask it again.' };
  const job = JSON.parse(readFileSync(f, 'utf8'));
  return job.status === 'running' ? { ...job, status: 'lost', answer: 'The dashboard restarted while the chief of staff was answering, so this answer was lost. Ask again.' } : job;
}
function recentAsks(limit = 15) {
  if (!existsSync(ASK_DIR)) return [];
  return readdirSync(ASK_DIR).filter((f) => f.endsWith('.json')).map((f) => askState(f.replace('.json', '')))
    .sort((a, b) => String(b.started).localeCompare(String(a.started))).slice(0, limit);
}
const ASK_SCHEMA = {
  type: 'object',
  properties: {
    answer_markdown: { type: 'string', description: 'The answer for the CEO: lead with the direct answer, then details, numbers, and sources (file paths, issue/PR numbers, ADR ids).' },
    follow_up_issues: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, priority: { enum: ['P0', 'P1', 'P2', 'P3'] } }, required: ['title', 'body'] },
      description: 'Only if the CEO asked for product work to be done.' },
    process_proposal: { type: 'string', description: 'Only if the CEO asked for a change to how the org works.' },
    pull_into_release: { type: 'array', items: { type: 'number' }, description: 'Existing backlog issue numbers the CEO asked to be done now. They join the current release.' },
  },
  required: ['answer_markdown'],
};
function ask(question) {
  const cfg = loadConfig();
  const id = randomUUID().slice(0, 8);
  const job = { id, question, status: 'running', started: new Date().toISOString(), answer: null, cost: 0 };
  asks.set(id, job); saveAsk(job);
  record('ceo_question', { question: question.slice(0, 500), ask: id }, { actor: 'ceo' });
  runAgent({ cfg, role: 'chief-of-staff', label: `ceo-${id}`, schema: ASK_SCHEMA,
    prompt: `# A question from the CEO\n> ${question}\n\nYou are the chief of staff briefing the CEO. Research before answering. Everything the org knows is on disk: ` +
      `the ledger (${p('memory/ledger')}: every run, transition, cost, decision, COE), decisions (${p('memory/decisions')}), COEs (${p('memory/coe')}), ` +
      `lessons (${p('memory/lessons')}), issue artifacts (${p('memory/specs')}), product knowledge (${p('memory/product')}), charters and the operating model (${p('org')}), ` +
      `reports (${p('memory/reports')}), and the issue tracker (gh issue/pr view and list on ${cfg.product.tracker}). Use \`sf report\`, \`sf recall\` and \`sf memory issue <n>\`.\n` +
      `Answer like a top chief of staff: direct answer first, then the supporting detail with real numbers and sources. Say plainly what you don't know. ` +
      `If the CEO asks for work, file it (follow_up_issues for product work, process_proposal for how the org works). If they ask for existing backlog work to be done now, ` +
      `list it in pull_into_release. Both join the current release automatically, so never tell the CEO to edit files. Don't do anything else.`,
  }).then(async (r) => {
    if (!r.ok) { Object.assign(job, { status: 'failed', answer: `The chief of staff could not answer: ${r.error}. Ask again; if it keeps failing, check the factory log.` }); saveAsk(job); return; }
    const filed = [];
    for (const f of r.out.follow_up_issues ?? []) {
      const n = await createIssue(cfg.product.tracker, { title: f.title, labels: [cfg.product.intake_label, ...(f.priority ? [f.priority] : [])], body: `${f.body}\n\n---\nRequested by the CEO: "${question.slice(0, 300)}"` }).catch(() => null);
      if (n) filed.push(n);
    }
    // The CEO's requests are scope decisions: filed work, and backlog work they ask for now, join the current release.
    const pulled = [];
    if (cfg.delivery?.mode === 'release') {
      const R = await import('./release.mjs');
      for (const n of [...filed, ...(r.out.pull_into_release ?? [])]) {
        if (R.current()?.status === 'active') { await R.addToRelease(cfg, n, `requested by the CEO: "${question.slice(0, 120)}"`); pulled.push(n); }
      }
    }
    if (r.out.process_proposal) writeDoc(`org/proposals/${new Date().toISOString().slice(0, 10)}-ceo-${id}.md`, `# From the CEO\n> ${question}\n\n${r.out.process_proposal}\n`);
    const answer = r.out.answer_markdown + (filed.length ? `\n\n**Filed:** ${filed.map((n) => `#${n}`).join(', ')}` : '') +
      (pulled.length ? `\n\n**Added to the current release:** ${pulled.map((n) => `#${n}`).join(', ')}. The team starts on ${pulled.length > 1 ? 'them' : 'it'} on the next pass.` : '') + (r.out.process_proposal ? '\n\n**Proposed to governance:** a process change (org/proposals).' : '');
    writeDoc(`memory/threads/ceo/${job.started.slice(0, 10)}-${id}.md`, `# CEO: ${question}\n_${job.started}_\n\n${answer}\n`);
    record('ceo_answer', { ask: id, cost_usd: r.cost, filed }, { actor: 'chief-of-staff' });
    Object.assign(job, { status: 'done', answer, cost: r.cost }); saveAsk(job);
  }).catch((e) => { Object.assign(job, { status: 'failed', answer: `Something went wrong: ${e.message}. Ask again.` }); saveAsk(job); });
  return job;
}
// ── waiting on a person: escalations, vendor requests, owner requests, with what to do ──
let waiting = { at: 0, items: [], error: null };
const section = (body, name) => body?.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |\\n> |$)`))?.[1]?.trim() ?? '';
async function loadWaiting(force = false) {
  if (!force && Date.now() - waiting.at < 60e3) return waiting;
  const cfg = loadConfig(), repo = cfg.product.tracker;
  try {
    const list = async (label) => JSON.parse(await gh(['issue', 'list', '-R', repo, '--state', 'open', '--label', label, '--limit', '50', '--json', 'number,title,url,body,createdAt,labels']) || '[]');
    const [esc, ven, own] = await Promise.all(['sf-needs-human', 'sf-vendor-request', 'sf-owner-request'].map(list));
    const items = [];
    for (const i of esc) {
      const { comments } = JSON.parse(await gh(['issue', 'view', String(i.number), '-R', repo, '--json', 'comments']));
      const ask = [...comments].reverse().find((c) => /over to you|Human needed/.test(c.body));
      const text = (ask?.body ?? '').replace(MARK, '').replace(/^### .*\n/, '').trim();
      const approval = /Approval|approval|holds this role|second-person/i.test(text), role = /You hold the \*\*(.+?)\*\* role/.exec(text)?.[1];
      items.push({ kind: 'escalation', n: i.number, title: i.title, url: i.url, since: ask?.createdAt ?? i.createdAt, why: text,
        done: i.labels?.some((l) => l.name === 'sf-approved') ? 'approved' : null,
        steps: role ? [`Do the ${role} work described above and post it as a comment.`, 'Click "Post & approve" (or add the sf-approved label) to move it on.']
          : approval ? ['Review what is linked above.', 'If it is right, click "Post & approve". If not, write the changes needed and click "Reply only"; the agents pick it up.']
          : ['Read why the org stopped above.', 'Write your decision or answer in the box. It is saved to shared memory and handed to the next agent.', 'Click "Post & approve" to continue.'],
        actions: ['approve', 'reply'] });
    }
    for (const i of ven) items.push({ kind: 'vendor', n: i.number, title: i.title.replace(/^\[vendor\]\s*/, ''), url: i.url, since: i.createdAt,
      why: [section(i.body, 'What'), section(i.body, 'Why') && `**Why:** ${section(i.body, 'Why')}`].filter(Boolean).join('\n\n') || i.body?.slice(0, 600),
      steps: [section(i.body, 'How to provide it') || 'Provide what is described above.', 'Never paste a secret here. Say only where you put it (secret name, env var or keychain item).',
        'Click "Mark fulfilled". The request closes and the paused work resumes.'], actions: ['fulfil', 'decline'] });
    for (const i of own) items.push({ kind: 'owner', n: i.number, title: i.title.replace(/^\[owner\]\s*/, ''), url: i.url, since: i.createdAt,
      why: [section(i.body, 'What'), section(i.body, 'Why') && `**Why:** ${section(i.body, 'Why')}`].filter(Boolean).join('\n\n') || i.body?.slice(0, 600),
      steps: ['Decide whether the org should get this change (budgets, permissions, people, environments or factory code are yours).',
        'If you make the change, click "Mark done" with a note. If not, click "Decline" with the reason, so the org records why.'], actions: ['done', 'decline'] });
    const E = await import('./engagement.mjs'), es = E.state(), last = E.thread().at(-1);
    if (es && !E.working() && es.phase !== 'delivery' && (es.awaiting || (last && last.from !== 'client' && last.from !== 'system'))) {
      items.push({ kind: 'engagement', n: 0, title: es.awaiting === 'approval' ? `Approve the ${es.phase === 'proposal' ? 'proposal' : 'plan'} in the Client room` : 'The team is waiting for your reply in the Client room',
        url: '#client', since: last?.at ?? es.started, why: (last?.text ?? '').slice(0, 600), steps: ['Open the Client room (header button).', es.awaiting === 'approval' ? 'Read the document, then Approve, or reply with the changes you want.' : 'Answer the question.'], actions: [] });
    }
    waiting = { at: Date.now(), items: items.sort((a, b) => String(a.since).localeCompare(String(b.since))), error: null };
  } catch (e) { waiting = { ...waiting, at: Date.now(), error: `Couldn't read GitHub: ${e.message.slice(0, 160)}` }; }
  return waiting;
}
/** A person acts on a waiting item from the dashboard. Their text is a human comment (no factory marker), so the org records it. */
async function act({ n, action, text }) {
  const cfg = loadConfig(), repo = cfg.product.tracker, t = String(text ?? '').trim();
  if (/(-----BEGIN|AKIA[0-9A-Z]{12}|ghp_[A-Za-z0-9]{20}|sk-[A-Za-z0-9]{20}|xox[bp]-)/.test(t)) throw new Error('That looks like a secret. Put it in the named secret store and only say where it is.');
  if (t) await humanComment(repo, n, t);
  if (action === 'approve') await editLabels(repo, n, { add: ['sf-approved'] });
  else if (action === 'fulfil' || action === 'done') {
    if (!t) throw new Error(action === 'fulfil' ? 'Say what you did or found (e.g. "PASS on iPhone 15, iOS 18" or where you put the credential), so the org can act on it.' : 'Add a short note on what you changed.');
    await closeIssue(repo, n, 'completed');
  }
  else if (action === 'decline') { if (!t) throw new Error('Say why you are declining, so the org can record it.'); await closeIssue(repo, n, 'not planned'); }
  else if (action === 'pull') {
    const R = await import('./release.mjs');
    if (R.current()?.status !== 'active') throw new Error('There is no active release to pull it into.');
    await R.addToRelease(cfg, n, 'pulled into the release from the dashboard');
  }
  else if (action !== 'reply') throw new Error('unknown action');
  record('person_action', { action, request: n, text: t.slice(0, 300) }, { actor: 'person', issue: n });
  await import('./answers.mjs').then((A) => A.sync(cfg)).catch(() => {}); // the answer reaches answers.md now, not on the next sweep
  return loadWaiting(true);
}
// ── the request and complaint box: the owner acts on items here ──
const handling = new Map(); // item id -> started, while the chief of staff reviews it on request
async function feedbackAct({ id, action, text, outcome }) {
  const H = await import('./hr.mjs');
  const by = loadConfig().people?.find((x) => x.owner)?.login ?? 'owner';
  if (action === 'handle') {
    if (handling.has(id)) return { handling: true };
    handling.set(id, Date.now());
    H.review(loadConfig(), { ids: [id] }).catch((e) => record('feedback_review_failed', { item: id, error: e.message.slice(0, 300) }, { actor: 'chief-of-staff' }))
      .finally(() => handling.delete(id));
    return { handling: true };
  }
  if (action === 'apply') return H.applyProposal(id, { by, reply: text ?? '' });
  if (action === 'decline') return H.decline(id, { by, reason: text });
  if (action === 'resolve') return H.resolve(id, { by, outcome, reply: text });
  throw new Error('unknown action');
}

// ── the dispatcher: is the org working, and start it from here so nobody needs a terminal ──
function dispatcher() {
  const lock = p('.factory/dispatcher.pid');
  const pid = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : 0;
  let running = false;
  if (pid) try { process.kill(pid, 0); running = true; } catch {}
  return { running, pid: running ? pid : null, paused: paused(), log: '.factory/dispatcher.log' };
}
/** start | pause | resume. Pausing stops new work and background jobs; agents already running finish their stage. */
function controlDispatcher(action) {
  if (action === 'pause') { setPaused(true); record('paused', {}, { actor: 'person' }); return dispatcher(); }
  if (action === 'resume') { setPaused(false); record('resumed', {}, { actor: 'person' }); return dispatcher().running ? dispatcher() : startDispatcher(); }
  if (action === 'start' || !action) return startDispatcher();
  throw new Error('unknown action');
}
function startDispatcher() {
  if (dispatcher().running) return dispatcher();
  mkdirSync(p('.factory'), { recursive: true });
  const out = openSync(p('.factory/dispatcher.log'), 'a');
  spawn(process.execPath, [p('factory/sf.mjs'), 'run'], { cwd: p(), detached: true, stdio: ['ignore', out, out] }).unref();
  record('dispatcher_started', {}, { actor: 'person' });
  return { running: true, starting: true };
}

const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => resolve(b)); });

/**
 * Serve the dashboard. A port the person chose is used or refused; the default port falls through to the next free one,
 * so a fresh install never fails because something else already uses 4340.
 */
export function serve(port = DEFAULT_PORT, { explicit = false } = {}) {
  // Paid agent runs and GitHub actions: accept only JSON requests from this dashboard itself, on any of its local addresses.
  const local = () => new RegExp(`^http://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`); // port is final once bound
  const trusted = (req) => req.headers['x-factory-ask'] === '1' && String(req.headers['content-type']).startsWith('application/json') && (!req.headers.origin || local().test(req.headers.origin));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    try {
      // First run: nothing but setup works until the org exists.
      if (url.pathname === '/api/setup' && req.method === 'GET') return json(await (await import('./setup.mjs')).status());
      if (url.pathname === '/api/setup' && req.method === 'POST') {
        if (!trusted(req)) return json({ error: 'Refused: setup can only be done from this dashboard.' }, 403);
        return body(req).then(async (b) => json(await (await import('./setup.mjs')).apply({ ...JSON.parse(b || '{}'), port })))
          .catch((e) => json({ error: e.message }, 400));
      }
      if (url.pathname.startsWith('/api/') && !configured()) return json({ error: 'not set up', setup: true }, 409);
      if (url.pathname === '/api/dispatcher' && req.method === 'GET') return json(dispatcher());
      if (url.pathname === '/api/dispatcher' && req.method === 'POST') {
        if (!trusted(req)) return json({ error: 'Refused: only this dashboard can start or pause the org.' }, 403);
        return body(req).then((b) => json(controlDispatcher(JSON.parse(b || '{}').action))).catch((e) => json({ error: e.message }, 400));
      }
      if (url.pathname === '/api/agent') {
        const prof = agentProfile(url.searchParams.get('role') ?? '');
        if (!prof) { res.statusCode = 404; return res.end('{}'); }
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(prof));
      }
      if (url.pathname === '/api/ask' && req.method === 'POST') {
        // Paid agent runs: accept only same-origin JSON requests from this dashboard (a cross-site page can't send these).
        if (!trusted(req)) { res.statusCode = 403; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: 'Refused: questions can only be asked from this dashboard.' })); }
        return body(req).then((b) => {
          const q = String(JSON.parse(b || '{}').question ?? '').trim();
          if (!q) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Type a question first.' })); }
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(ask(q.slice(0, 4000))));
        }).catch(() => { res.statusCode = 400; res.end('{}'); });
      }
      if (url.pathname === '/api/engagement' && req.method === 'GET') {
        const E = await import('./engagement.mjs');
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ state: E.state(), thread: E.thread().slice(-200), working: E.working(), phases: E.PHASES }));
      }
      if (url.pathname === '/api/engagement' && req.method === 'POST') {
        if (!trusted(req)) { res.statusCode = 403; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: 'Refused: only this dashboard can talk to the team.' })); }
        return body(req).then(async (b) => {
          const { action, text } = JSON.parse(b || '{}');
          const E = await import('./engagement.mjs');
          const queued = action === 'message' && E.working();
          const job = action === 'start' ? E.start() : action === 'approve' ? E.approve() : E.message(text); // throws straight away on bad input
          job.catch((e) => console.error('engagement:', e.message)); // the reply arrives in the thread; the page polls
          res.statusCode = 202; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, queued }));
        }).catch((e) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.message })); });
      }
      if (url.pathname === '/api/feedback' && req.method === 'GET') {
        const H = await import('./hr.mjs');
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ items: H.list(), roles: Object.keys(loadConfig().roles), handling: [...handling.keys()] }));
      }
      if (url.pathname === '/api/feedback/act' && req.method === 'POST') {
        if (!trusted(req)) return json({ error: 'Refused: only this dashboard can act on the box.' }, 403);
        return body(req).then(async (b) => json(await feedbackAct(JSON.parse(b || '{}')))).catch((e) => json({ error: e.message }, 400));
      }
      if (url.pathname === '/api/feedback' && req.method === 'POST') {
        if (!trusted(req)) { res.statusCode = 403; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: 'Refused: only this dashboard can file feedback.' })); }
        return body(req).then(async (b) => {
          const { about, kind, text, evidence } = JSON.parse(b || '{}');
          const item = (await import('./hr.mjs')).file({ about, kind, text, evidence }, { by: 'person' });
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(item));
        }).catch((e) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.message })); });
      }
      if (url.pathname === '/api/waiting') {
        return loadWaiting().then((w) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(w)); });
      }
      if (url.pathname === '/api/act' && req.method === 'POST') {
        if (!trusted(req)) { res.statusCode = 403; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: 'Refused: actions can only come from this dashboard.' })); }
        return body(req).then((b) => act(JSON.parse(b || '{}'))).then((w) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(w)); })
          .catch((e) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: e.message })); });
      }
      if (url.pathname === '/api/asks') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(recentAsks())); }
      if (url.pathname.startsWith('/api/ask/')) {
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(askState(url.pathname.split('/').pop())));
      }
      if (url.pathname === '/api/state') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(state())); }
      if (url.pathname === '/api/doc') {
        const rel = path.normalize(url.searchParams.get('path') ?? '');
        if (!/^(memory|org|library)\//.test(rel) || rel.includes('..') || !rel.endsWith('.md') || !existsSync(p(rel))) { res.statusCode = 404; return res.end('not found'); }
        res.setHeader('content-type', 'text/plain; charset=utf-8'); return res.end(readFileSync(p(rel), 'utf8'));
      }
      res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8'));
    } catch (e) { res.statusCode = 500; res.end(String(e.message)); }
  });
  // Refuse to share a port with another service (e.g. a Docker container bound to *:port would shadow us).
  const first = port;
  const busy = () => {
    if (!explicit && port < first + 20) { port++; return tryPort(); }
    console.error(explicit ? `Port ${port} is already used by another service. Pick a free one: sf dashboard --port <n>`
      : `Ports ${first}-${port} are all in use. Pick a free one: sf dashboard --port <n>`);
    process.exit(1);
  };
  // Both binds must succeed: all interfaces catches wildcard listeners (a Docker container on *:port), 127.0.0.1 catches loopback-only ones.
  const tryPort = () => {
    const probe = http.createServer().once('error', busy).once('listening', () => probe.close(() => {
      server.once('error', busy);
      server.listen(port, '127.0.0.1');
    }));
    probe.listen(port);
  };
  server.once('listening', () => {
    server.removeListener('error', busy);
    console.log(`Dashboard: http://127.0.0.1:${port}${port !== first ? ` (port ${first} was busy)` : ''}`);
  });
  tryPort();
}
