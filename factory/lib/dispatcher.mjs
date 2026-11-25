import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { HOME, p, loadConfig, headcount, STAGE_ORDER, teamOf, holderOf, vendors, owners } from './config.mjs';
import * as T from './tracker.mjs';
import * as M from './memory.mjs';
import { runAgent, verdictSchema, DECISION } from './worker.mjs';
import { council } from './council.mjs';
import { report } from './report.mjs';
import * as R from './repos.mjs';
import { recordAnswer } from './discovery.mjs';
import { decideDeploy, probeHealth, deployProgram } from './deploy-gate.mjs';

const now = () => new Date();
const sh = promisify(execFile);

/**
 * The factory's own code repo, as a repo the pipeline can work in (feedback 21182531): from this install's git remote.
 * Engineers work in a separate clone of it under workspaces/, never in the running factory. null when there is no remote.
 */
export function factoryRepo() {
  try {
    const url = execFileSync('git', ['-C', HOME, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const slug = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)?.[1];
    const branch = execFileSync('git', ['-C', HOME, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'main';
    return slug ? { name: 'software-factory', repo: slug, default_branch: branch, factory: true, about: 'The factory itself' } : null;
  } catch { return null; }
}
/**
 * An issue's gate (owner request #105), from lines in its body: `spend_usd_max: 60` (the current release's agent spend, or
 * today's outside a release) and `not_after: 2026-11-25T21:30+05:30` (or `21:30`, today, local time). null when it has none.
 */
export function parseGates(body, today = new Date()) {
  const text = String(body ?? '');
  const spend = text.match(/spend_usd_max\s*[:=]\s*\$?\s*(\d+(?:\.\d+)?)/i)?.[1];
  const after = text.match(/not_after\s*[:=]\s*`?([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]+(?:Z|[+-][0-9]{2}:?[0-9]{2})?|[0-9]{1,2}:[0-9]{2})`?/i)?.[1];
  let notAfter = null;
  if (after) {
    if (/^\d{1,2}:\d{2}$/.test(after)) { const [h, m] = after.split(':').map(Number); const d = new Date(today); d.setHours(h, m, 0, 0); notAfter = d.toISOString(); }
    else if (!Number.isNaN(Date.parse(after))) notAfter = new Date(after).toISOString();
  }
  return spend || notAfter ? { spend_usd_max: spend ? Number(spend) : null, not_after: notAfter } : null;
}
/** Does the gate still hold? spend is { release_usd, today_usd, release } from spend.json. */
export function checkGate(gates, spend, inRelease, at = new Date()) {
  if (!gates) return { ok: true };
  const used = inRelease && spend?.release ? spend.release_usd : spend?.today_usd;
  if (gates.spend_usd_max != null && used != null && used >= gates.spend_usd_max)
    return { ok: false, reason: `spend $${used.toFixed(2)} has reached the gate of $${gates.spend_usd_max} (${inRelease && spend?.release ? `Release ${spend.release}` : 'today'})` };
  if (gates.not_after && at >= new Date(gates.not_after)) return { ok: false, reason: `it is past the gate's deadline (${gates.not_after})` };
  return { ok: true };
}
/**
 * Where a `reject` verdict goes (owner request #104): 'close' where the stage may route to `rejected`, otherwise 'ask' the
 * product owner, with `keepTo` the stage it continues to if kept. Never forward on the agent's say-so. null when not a cut.
 */
export function rejectRoute(stageNext, v, stage) {
  if (v.outcome !== 'reject' || v.next_stage === 'rejected') return null;
  if (stageNext.includes('rejected')) return { action: 'close' };
  return { action: 'ask', keepTo: v.next_stage && v.next_stage !== 'blocked' ? v.next_stage : stage };
}
/**
 * Is the change already on the default branch (owner request #122)? Each `done_when` check says a file contains a string exactly
 * `count` times once the change is in. `read(repo, file)` returns the file's text or null. No shell: files are read, never run.
 */
export function freshness(checks, read) {
  const results = checks.map((c) => {
    const text = read(c.repo ?? null, c.file);
    const found = text == null ? 0 : text.split(c.contains).length - 1;
    return { ...c, found, holds: found === c.count };
  });
  return { allHold: results.length > 0 && results.every((r) => r.holds), results };
}
/** Do two declared paths overlap? Equal, or one is a folder holding the other. */
const overlaps = (a, b) => a === b || a.startsWith(`${b.replace(/\/$/, '')}/`) || b.startsWith(`${a.replace(/\/$/, '')}/`);
/**
 * Which open issues already claim these paths (owner request #115)? index: { path: [issue, …] }. Pure, for the check and tests.
 */
export function clashes(n, paths, index) {
  const out = [];
  for (const x of paths) for (const [path, issues] of Object.entries(index)) for (const m of issues) if (m !== n && overlaps(x, path)) out.push({ issue: m, path, mine: x });
  return out;
}
/** Rebuild memory/state/claims.json from every open issue's declared factory_paths. */
export function claimsIndex() {
  const dir = p('memory/state'), index = {};
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => /^issue-\d+\.json$/.test(x)) : []) {
    const s = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')), n = Number(f.match(/\d+/)[0]);
    if (s.closed) continue;
    for (const x of s.factory?.paths ?? []) (index[x] ??= []).push(n);
  }
  writeFileSync(`${dir}/claims.json`, JSON.stringify(index, null, 2));
  return index;
}
/** Paths a factory change may declare: code in the factory repo, not this install's data (org/, memory/, library/). */
export function factoryPaths(paths) {
  const ok = [], refused = [];
  for (const raw of paths ?? []) {
    const x = String(raw).trim().replace(/^\.?\//, '');
    (x && !x.includes('..') && !/^(org|memory|library|workspaces|archive|\.factory|\.memory\.git|node_modules)(\/|$)/.test(x) ? ok : refused).push(x);
  }
  return { ok, refused };
}
const sha = (s) => createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 16);
/** Is `to` progress from `from`: later in the pipeline, closed, or a declared forward target (verify → release)? */
const isForward = (cfg, from, to) => {
  const order = STAGE_ORDER(cfg);
  return ['done', 'rejected'].includes(to) || (cfg.pipeline[from]?.forward ?? []).includes(to) || (order.includes(to) && order.indexOf(to) > order.indexOf(from));
};
/** Where an issue stood when the dispatcher moved it (feedback 0333ef04, #77): what a later dispatch of `from` is compared against. */
export function moveStamp(state, from, to, artifact, at = new Date().toISOString()) {
  return { from, to, at, heads: JSON.stringify(state.heads ?? {}), artifact: sha(artifact), handoff: sha(state.lastHandoff?.text), history: state.history?.length ?? 0 };
}
/**
 * Would running `stage` now repeat a forward advance (feedback 0333ef04, #77)? Returns the move when the issue last left `stage`
 * forward and nothing has changed since: same HEADs, artifact, handoff and history, and no loop, failed check or approval in
 * `events` (this issue's ledger since the move). null when the run is real work.
 */
export function repeatsAdvance(cfg, state, stage, artifact, events = []) {
  const m = state.moved;
  if (!m || m.from !== stage || m.to === stage || !isForward(cfg, stage, m.to)) return null;
  const changed = m.heads !== JSON.stringify(state.heads ?? {}) || m.artifact !== sha(artifact) || m.handoff !== sha(state.lastHandoff?.text) ||
    m.history !== (state.history?.length ?? 0) ||
    events.some((e) => e.ts > m.at && (e.loop === true || e.outcome === 'loop_back' || e.type === 'check_failed' || e.type === 'human_approved'));
  return changed ? null : m;
}
/**
 * Is this advance one the issue already made (owner request #141, #77 recorded review → security twice)? True when the last move
 * was exactly `stage` → `next`, so the issue is already at `next`. A real repeat always has a move in between (a loop-back, a rebuild).
 */
export function duplicateTransition(state, stage, next, outcome) {
  return outcome === 'advance' && stage !== next && state.moved?.from === stage && state.moved.to === next;
}
/**
 * How the brief shows the last handoff to `stage` (feedback 0333ef04, #77). "What must change" is only for work sent back: a loop-back
 * from a later stage, a failed check, CI, the artifact guard, an approver, a person. An agent's own handoff onward from this stage
 * is never shown to it as a change request. null when there is nothing to show.
 */
export function handoffFor(h, stage, cfg) {
  if (!h?.text) return null;
  if (h.from === stage && cfg.roles?.[h.by]) return null; // the stage's own verdict onward (a person's word at their stage still counts)
  if (/^consult:/.test(h.from)) return { kind: 'answer', title: `Answer from ${h.by}`, text: h.text };
  if (h.from === 'vendor') return { kind: 'answer', title: 'Delivered by the vendor', text: h.text };
  if (STAGE_ORDER(cfg).includes(h.from) && h.from !== stage && isForward(cfg, h.from, stage)) return { kind: 'handoff', title: `Handoff to you from ${h.by} (${h.from})`, text: h.text };
  return { kind: 'loop', title: `What must change (from ${h.by}, ${h.from})`, text: h.text };
}
// Faults in the harness or the account, not the agent's work: retried, never escalated, never a COE.
const INFRA = /agents file changed|ENOENT|EAGAIN|ECONNRESET|overloaded|rate.?limit|session limit|usage limit|spawn |^exit (137|143)$|SIGTERM|SIGKILL|connection reset|i\/o timeout|timed out|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|api\.github\.com|HTTP 50[0-9]|502 Bad Gateway|503 Service|not logged in|please run \/login|invalid api key|oauth token|authentication_error|gh auth login/i; // incl. runs killed by a stop or restart, network/GitHub outages, and a logged-out Claude or gh

function INCIDENT() {
  return { type: 'object', properties: { title: { type: 'string' }, severity: { enum: ['P0', 'P1', 'P2', 'P3'] },
    fingerprint: { type: 'string' }, evidence: { type: 'string' }, component: { type: 'string' } },
    required: ['title', 'severity', 'fingerprint', 'evidence'] };
}

export class Dispatcher {
  constructor(cfg) {
    this.cfg = cfg;
    this.repo = cfg.product.tracker; // issues live here; code lives in cfg.product.repos
    this.repos = cfg.product.repos;
    this.envs = cfg.environments ?? ['production'];
    this.running = new Map(); // issue number -> { role, stage }
    this.queue = {}; // role -> { since, issues } work waiting for a seat
    this.background = new Set(); // COEs and other async org work; a graceful stop waits for these
    this.factory = factoryRepo();
  }

  // Extra verdict fields some stages must return.
  extra(stage) {
    const names = this.repos.map((r) => r.name);
    const pools = [...new Set((this.cfg.pipeline[stage]?.next ?? []).flatMap((s) => this.cfg.pipeline[s]?.pool ?? []))];
    const assignee = pools.length ? { next_assignee: { enum: pools, description: `Optional: route the next stage to a specialist. Pools: ${(this.cfg.pipeline[stage]?.next ?? []).filter((s) => this.cfg.pipeline[s]?.pool).map((s) => `${s} → ${this.cfg.pipeline[s].pool.join(', ')}`).join('; ')}` } } : {};
    // Duplicates are routing facts, flagged early (owner request #113).
    const dup = ['triage', 'analysis', 'feature-grooming'].includes(stage) ? { duplicate_of: { type: 'number', description: 'The open issue this one duplicates. The product owner confirms before it closes; both issues get a back-link.' } } : {};
    return { ...assignee, ...dup, ...({
      triage: { priority: { enum: ['P0', 'P1', 'P2', 'P3'] }, type: { enum: ['feature', 'bug', 'incident', 'tech-debt', 'chore'] } },
      build: {
        pr_draft: { type: 'boolean', description: 'true while anything is provisional or pending (e.g. a mirrored ADR awaiting security). The PR stays a draft and cannot merge.' },
        pr_body: { type: 'string', description: 'The PR description, used verbatim (prefixed with "Part of #n"). Put lines acceptance criteria check for here.' },
        no_code_change: { type: 'boolean', description: 'true only when the tech design explicitly calls for no product-repo change (e.g. a factory, memory or doc-only change). The issue then goes through review and security without a PR and closes at merge.' },
      },
      'tech-grooming': { risk_tier: { enum: ['low', 'medium', 'high'] }, repos: { type: 'array', items: { enum: names }, description: 'Every product repo this change touches.' },
        all_repos: { type: 'boolean', description: 'true only if the change touches every product repo. An empty repos list is never read as "all".' },
        done_when: { type: 'array', description: 'Machine-checkable end state: after the change, `file` (in `repo`) contains `contains` exactly `count` times. ' +
          'Before each build the dispatcher checks these on the default branch; if all already hold, the work is already done and no build runs (owner request #122).',
          items: { type: 'object', properties: { repo: { enum: [...names, ...(this.factory ? [this.factory.name] : [])] }, file: { type: 'string' }, contains: { type: 'string' }, count: { type: 'number' } }, required: ['file', 'contains', 'count'] } },
        uses_factory_code: { type: 'boolean', description: 'true when the design runs or reads factory code (e.g. deploy\/local-node.sh) without changing it. Changing it needs factory_paths instead.' },
        delta_of: { type: 'number', description: 'The open issue whose change this one builds on, when both edit the same files. The claims check needs this, or wait/wait_for, or duplicate_of.' },
        duplicate_of: { type: 'number', description: 'The open issue this one duplicates. The product owner confirms before it closes.' },
        ...(this.factory ? { factory_paths: { type: 'array', items: { type: 'string' }, description: `Only for a change to the factory itself (${this.factory.repo}): ` +
          'the code paths it edits, e.g. deploy/local-node.sh or factory/lib/checks.mjs. The engineer gets a factory worktree on the issue branch; ' +
          'it is reviewed and security-checked like any change, never deployed, and merges only with the owner\'s approval. ' +
          'org/, memory/ and library/ are this install\'s data, not factory code: change those through process_proposal.' } } : {}) },
      release: { deploy_now: { type: 'boolean' }, environment: { enum: this.envs }, hold_minutes: { type: 'number' },
        no_runtime_surface: { type: 'boolean', description: 'true only when the touched repos have nothing to run in this environment (e.g. docs, design tokens with no build, lint config). Skips deploy and the health probe; requires no_runtime_note. Otherwise deploy_now must deploy and pass the health probe, or the release is held.' },
        no_runtime_note: { type: 'string', description: 'Required with no_runtime_surface: why this change has nothing to deploy or probe (at least 20 characters). Recorded in the ledger.' } },
      verify: { incidents: { type: 'array', items: INCIDENT() }, rollback: { type: 'boolean', description: 'true if users are affected now and the environment must go back to its last verified release' } },
      incident: { priority: { enum: ['P0', 'P1', 'P2', 'P3'] } },
    }[stage] ?? {}) };
  }

  /** The stage owner, or the specialist the previous stage assigned (if it is in this stage's pool). */
  pickRole(stage, st, state) {
    const a = state.assign?.[stage];
    // Independence: whoever built the change never reviews or audits it; the stage owner does.
    const authored = ['review', 'security'].includes(stage) && (state.history ?? []).some((h) => h.by === a && h.stage === 'build');
    return a && !authored && (st.pool ?? []).includes(a) && headcount(this.cfg, a) > 0 ? a : (st.role ?? st.council.chair); // released specialists fall back to the owner
  }

  /** The repos an issue touches (decided at tech-grooming); all of them until then. */
  /** The repos an issue works in: its product repos, plus the factory's own repo when tech-grooming declared factory_paths. */
  touched(state) {
    const isFactory = state.factory?.paths?.length && this.factory;
    // No product repos named: all of them, except for a factory-only change, which touches none.
    const product = state.repos?.length ? this.repos.filter((r) => state.repos.includes(r.name)) : isFactory ? [] : this.repos;
    return isFactory ? [...product, this.factory] : product;
  }
  /** Repos that are deployed and health-checked: never the factory itself (feedback 21182531). */
  deployable(state) { return this.touched(state).filter((r) => !r.factory); }

  // ── scheduling ──────────────────────────────────────────────────────────
  busy(role) { return [...this.running.values()].filter((r) => r.role === role).length; }

  spentToday() {
    const day = now().toISOString().slice(0, 10);
    return M.events({ since: day }).filter((e) => e.type === 'run_finished').reduce((s, e) => s + (e.cost_usd ?? 0), 0);
  }

  async tick() {
    // Hot-reload org.yaml so headcount, tools, gates and policy changes apply without a restart.
    try { this.cfg = loadConfig(); this.repo = this.cfg.product.tracker; this.repos = this.cfg.product.repos; this.envs = this.cfg.environments ?? ['production']; }
    catch (e) { console.error(`org.yaml not reloaded: ${e.message}`); }
    // Engagements: nothing is built until the client has approved the plan (phase "delivery"), and there must be a project repo.
    // (Checked after the reload above, so a project set up while the dispatcher runs is picked up.)
    const eng = (await import('./engagement.mjs')).state();
    if (!this.cfg.product?.tracker || (eng && eng.phase !== 'delivery')) { await this.syncMemory(); return; }
    const { cfg } = this;
    const budget = (await import('./budget.mjs')).status(cfg), budgetLeft = budget.left; // includes today's approved extra
    const listedAt = Date.now(); // a run that ends after this moment has made this list's labels stale for its issue
    const issues = await T.listIssues(this.repo, cfg.product.intake_label);
    const waitingNow = {};
    if (Date.now() - (this.answersAt ?? 0) > 120e3) { // owner answers on GitHub → answers.md (every 2 minutes)
      this.answersAt = Date.now();
      await import('./answers.mjs').then((A) => A.sync(cfg)).catch((e) => console.error('answers:', e.message));
    }
    // Agile delivery: one release at a time. Plan when none is active; close out when every scope issue is closed.
    const releaseMode = cfg.delivery?.mode === 'release';
    const rel = releaseMode ? (await import('./release.mjs')).current() : null;
    if (releaseMode && !this.draining && !cfg.delivery?.focus?.length) {
      const openNums = new Set(issues.map((i) => i.number));
      // A person putting an issue in the release milestone on GitHub pulls it into scope.
      if (rel?.status === 'active') for (const i of issues) {
        if (i.milestone?.title === rel.milestoneTitle && !rel.issues.includes(i.number)) {
          await import('./release.mjs').then((R) => R.addToRelease(cfg, i.number, `added to the ${rel.milestoneTitle} milestone on GitHub`));
          rel.issues.push(i.number);
        }
      }
      if (rel?.status === 'active' && rel.issues.length && rel.issues.every((n) => !openNums.has(n))) this.releaseJob('closeOut', () => import('./release.mjs').then((R) => R.closeOut(cfg)));
      else if ((!rel || rel.status === 'done') && budgetLeft > 0 && !eng?.releases) this.releaseJob('plan', () => import('./release.mjs').then((R) => R.plan(cfg, issues))); // with an engagement plan, releases come from the plan
    }
    // Current spend, where agents can read it (feedback d17f145f): spend-based rules in a plan can be checked, not guessed.
    const relIssues = new Set(rel?.issues ?? []);
    this.spend = { today_usd: budget.spent, daily_budget_usd: budget.limit, extra_today_usd: budget.extra,
      release: rel?.number ?? null, release_usd: +M.events().filter((e) => e.type === 'run_finished' && relIssues.has(Number(e.issue))).reduce((s, e) => s + (e.cost_usd ?? 0), 0).toFixed(2),
      at: now().toISOString() };
    M.kv('spend', this.spend);
    if (this.spend.today_usd !== this.spendLogged) { // history, so a COE can tell when a gate was crossed (owner request #105)
      this.spendLogged = this.spend.today_usd;
      appendFileSync(p('memory/state/spend-history.jsonl'), JSON.stringify(this.spend) + '\n');
    }
    const open = new Set(issues.map((i) => i.number));
    for (const f of existsSync(p('memory/state')) ? readdirSync(p('memory/state')).filter((f) => /^issue-\d+\.json$/.test(f)) : []) {
      const n = Number(f.match(/\d+/)[0]), st = M.issueState(n);
      if (!st.closed && !open.has(n) && !this.running.has(n) && st.history?.length) {
        st.closed = true; M.saveIssueState(n, st);
        M.record('closed', { to: 'closed', by: 'outside the factory' }, { issue: n });
      }
    }
    issues.sort((a, b) => T.priorityOf(a).localeCompare(T.priorityOf(b)) || a.createdAt.localeCompare(b.createdAt));

    for (const issue of issues) {
      const n = issue.number;
      if (this.running.has(n) || this.settledSince(n, listedAt)) continue;
      const labels = T.labelsOf(issue);
      if (labels.includes(T.L.working)) await T.editLabels(this.repo, n, { remove: [T.L.working] }); // stale lock after a crash
      // Held for a vendor by the label or by our own record (the label can lag; feedback dde2f5c7): never re-run the stage before the vendor acts.
      if (labels.includes('sf-waiting-vendor') || M.issueState(n).vendor) { await this.guard(n, () => this.checkVendor(issue)); continue; }
      if (labels.includes(T.L.human)) {
        if (labels.includes(T.L.approved)) await this.resolveGate(issue);
        continue;
      }
      if (this.draining) continue; // stopping: handle people's actions above, start no new work
      if (cfg.delivery?.focus?.length && !cfg.delivery.focus.includes(n)) continue; // CEO focus: only these issues move at all
      let stage = T.stageOf(issue);
      if (!stage) {
        stage = Object.keys(cfg.pipeline)[0];
        await T.setStage(this.repo, n, null, stage);
        M.record('intake', { title: issue.title, to: stage }, { issue: n });
      }
      const st = cfg.pipeline[stage];
      if (!st) continue; // done/rejected or a hand-applied label
      const state = M.issueState(n);
      if (this.repeatedAdvance(n, stage, state)) { await this.guard(n, () => this.restoreStage(issue, stage, state)); continue; }
      if (state.holdUntil && new Date(state.holdUntil) > now()) continue;
      if (state.waitFor?.length) { // parked on planned dependencies: free until each has merged or closed
        const still = state.waitFor.filter((m) => open.has(m) && !Object.keys(M.issueState(m).merged ?? {}).length);
        if (still.length) continue;
        // A dependency that closed without being done (not planned, superseded, duplicate) is a re-route, not a release (owner request #112).
        const gone = [];
        for (const m of state.waitFor.filter((x) => !open.has(x))) { const c = await this.closedReason(m); if (c.reason !== 'COMPLETED' || c.replacement) gone.push({ m, ...c }); }
        if (gone.length) {
          const repl = gone.map((g) => g.replacement).filter((r) => r && open.has(r));
          for (const g of gone) M.record('dependency_superseded', { parent: g.m, reason: g.reason, replacement: g.replacement ?? null }, { issue: n });
          state.waitFor = repl.length ? repl : null;
          const order = STAGE_ORDER(cfg), to = order.indexOf(stage) > order.indexOf('feature-grooming') ? 'feature-grooming' : stage;
          state.lastHandoff = { from: 'dependency', by: 'dispatcher', text: gone.map((g) => `Parent #${g.m} closed as ${g.reason.toLowerCase().replace('_', ' ')}${g.replacement ? ` (→ #${g.replacement})` : ''}.`).join(' ') +
            (repl.length ? ` Re-parent onto ${repl.map((r) => `#${r}`).join(', ')}: rework the spec against it; it waits for it again.` : ' Rework the spec without it, or cut the issue.') };
          M.saveIssueState(n, state);
          await T.comment(this.repo, n, `### ↪️ ${state.lastHandoff.text}${to !== stage ? `\nBack to \`${to}\`.` : ''}`);
          if (to !== stage) await this.move(issue, stage, to, state);
          continue;
        }
        M.record('dependency_ready', { stage, waited_for: state.waitFor }, { issue: n });
        state.waitFor = null; M.saveIssueState(n, state);
      }
      if (releaseMode) {
        const inScope = rel?.status === 'active' && rel.issues.includes(n);
        const expedite = (cfg.delivery.expedite ?? ['P0']).includes(T.priorityOf(issue));
        if (!inScope && !expedite && stage !== 'triage') { // backlog: triaged and ordered, but waits for its release
          if (state.waiting !== 'backlog') { state.waiting = 'backlog'; M.saveIssueState(n, state); M.record('waiting', { reason: 'backlog', stage, release: rel?.number ?? null }, { issue: n }); }
          continue;
        }
        if (state.waiting === 'backlog') { state.waiting = null; M.saveIssueState(n, state); }
      }
      // The issue's own gate (owner request #105): checked before every stage run, not just at build. A failed gate starts no
      // work; the product owner decides once whether to cut it or keep it (a kept issue isn't asked again for the same gate).
      const gates = parseGates(issue.body);
      if (JSON.stringify(gates) !== JSON.stringify(state.gates ?? null)) { state.gates = gates; M.saveIssueState(n, state); }
      if (gates && JSON.stringify(state.gateKept?.gates) !== JSON.stringify(gates)) {
        const g = checkGate(gates, this.spend, rel?.issues?.includes(n), now());
        if (!g.ok) {
          if (!state.gateFailed) { state.gateFailed = { at: now().toISOString(), reason: g.reason }; M.saveIssueState(n, state); M.record('gate_failed', { stage, reason: g.reason, gates }, { issue: n }); }
          if (!this.draining && budgetLeft > 0) {
            this.running.set(n, { role: 'product-owner', stage: 'cut', since: now().toISOString() });
            this.gateCut(issue, stage, state, g.reason).catch((e) => console.error(`✗ #${n} gate: ${e.message}`)).finally(() => this.settle(n)); // settle: a stale issue list can't re-dispatch it right after
          }
          continue;
        }
      }

      const freeze = ['merge', 'release'].includes(stage) && T.priorityOf(issue) !== 'P0' ? this.activeFreeze() : null;
      if (freeze) {
        if (state.waiting !== `freeze:${freeze}`) { state.waiting = `freeze:${freeze}`; M.saveIssueState(n, state); M.record('waiting', { reason: 'freeze', stage, freeze }, { issue: n }); }
        continue;
      }
      if (st.system === 'merge') { await this.guard(n, () => this.merge(issue, state)); continue; }

      const role = this.pickRole(stage, st, state);
      const person = holderOf(cfg, role);
      if (person) { await this.guard(n, () => this.toPerson(issue, stage, role, person, state)); continue; } // a person holds this role
      if (budgetLeft <= 0) { // out of budget: the owner approves more from "Waiting on you" and work continues on the next pass
        if (!this.budgetWarned) { console.log(`daily budget reached ($${budget.spent} of $${budget.limit}), no new work started`); (await import('./budget.mjs')).noteExhausted(budget); }
        this.budgetWarned = true; continue;
      }
      this.budgetWarned = false;
      if (this.running.size >= (cfg.capacity.max_parallel ?? 10)) continue;
      if (this.busy(role) >= headcount(cfg, role)) { // seats full: note the wait; long waits go to the CFO
        const q = (waitingNow[role] ??= this.queue[role] ?? { since: Date.now(), issues: [] });
        if (!q.issues.some((i) => i.n === n)) q.issues.push({ n, priority: T.priorityOf(issue) });
        continue;
      }
      this.start(issue, stage, role);
    }
    this.queue = waitingNow;
    if (!cfg.delivery?.focus?.length) this.staffingCheck(); // no hiring decisions while the CEO has the org focused
    await this.syncMemory();
  }

  /** Roles with work waiting longer than staffing.wait_minutes ask the CFO for seats (one request per cooldown). */
  staffingCheck() {
    const s = this.cfg.staffing ?? {};
    for (const [role, q] of Object.entries(this.queue)) {
      const waited = (Date.now() - q.since) / 60e3;
      const last = this.lastStaffing?.[role] ?? 0;
      if (waited < (s.wait_minutes ?? 20) || Date.now() - last < (s.cooldown_minutes ?? 60) * 60e3 || this.staffingBusy) continue;
      (this.lastStaffing ??= {})[role] = Date.now();
      this.staffingBusy = true;
      import('./staffing.mjs').then((S) => S.request(this.cfg, role, { waiting: q.issues.length, since: new Date(q.since).toISOString(), issues: q.issues }))
        .then((r) => console.log(`staffing ${role}: ${r.changed.length ? r.changed.map((c) => `${c.from}→${c.to}`).join(', ') : 'declined'} · ${r.summary?.slice(0, 160)}`))
        .catch((e) => console.error('staffing:', e.message)).finally(() => { this.staffingBusy = false; });
    }
  }

  /** Release planning and close-out run in the background, one at a time, and a graceful stop waits for them. */
  releaseJob(kind, fn) {
    if (this.releaseBusy) return;
    this.releaseBusy = kind;
    const job = fn().then(() => console.log(`release ${kind} done`)).catch((e) => console.error(`release ${kind}:`, e.message))
      .finally(() => { this.releaseBusy = null; this.background.delete(job); });
    this.background.add(job);
  }

  /** Investigate a failure (Correction of Errors) in the background. One per issue+kind+route per hour. */
  coe(ev) {
    if (this.cfg.quality?.coe === false || this.draining) return;
    if (this.cfg.delivery?.focus?.length && !this.cfg.delivery.focus.includes(ev.issue)) return; // focus: no COEs on paused work
    const key = `${ev.issue}|${ev.kind}|${ev.from}|${ev.to}`;
    this.coeSeen ??= new Map();
    if (Date.now() - (this.coeSeen.get(key) ?? 0) < 3600e3) return;
    this.coeSeen.set(key, Date.now());
    const job = import('./coe.mjs').then((C) => C.investigate(this.cfg, ev))
      .then((r) => r?.root_cause ? console.log(`COE ${r.id}: ${r.root_cause.slice(0, 140)}`) : r?.type && console.log(`COE ${r.type} for #${ev.issue}: ${r.reason ?? r.error ?? ''}`.slice(0, 200)))
      .catch((e) => console.error('coe:', e.message)).finally(() => this.background.delete(job));
    this.background.add(job);
  }

  start(issue, stage, role) {
    const n = issue.number;
    this.running.set(n, { role, stage, since: now().toISOString() });
    console.log(`▶ #${n} ${stage} → ${role}`);
    T.editLabels(this.repo, n, { add: [T.L.working] })
      .then(() => this.handle(issue, stage))
      .catch(async (err) => {
        if (INFRA.test(err.message)) { // a network or GitHub blip: retried next tick, never escalated
          M.record('infra_failure', { stage, error: err.message.slice(0, 300) }, { issue: n });
          return;
        }
        console.error(`✗ #${n} ${stage}: ${err.message}`);
        M.record('error', { stage, error: err.message.slice(0, 2000) }, { issue: n });
        await this.escalate(n, M.issueState(n), null, `Dispatcher error in **${stage}**:\n\`\`\`\n${err.message.slice(0, 1500)}\n\`\`\``).catch(() => {});
      })
      .finally(async () => {
        await T.editLabels(this.repo, n, { remove: [T.L.working] }).catch(() => {});
        this.settle(n);
      });
  }

  async guard(n, fn) {
    try { await fn(); } catch (err) {
      M.record('error', { error: err.message.slice(0, 2000) }, { issue: n });
      console.error(`✗ #${n}: ${err.message}`);
    }
  }

  // ── a stage run ─────────────────────────────────────────────────────────
  async handle(issue, stage) {
    this.answersLatest = await import('./answers.mjs').then((A) => A.latest()).catch(() => []);
    const { cfg } = this;
    const st = cfg.pipeline[stage];
    const n = issue.number;
    const state = M.issueState(n);
    const cwd = st.workspace ? await R.worktrees(n, this.touched(state)) : HOME;
    const schema = verdictSchema(st.next, this.extra(stage));
    issue.comments ??= await T.viewIssue(this.repo, n).then((i) => i.comments).catch(() => []); // people's words go in the brief
    // Already on main? (owner request #122) Read the done_when files on a fresh default-branch checkout; no build if all hold.
    if (stage === 'build' && state.doneWhen?.length && !state.freshKept) {
      const bases = {};
      for (const name of new Set(state.doneWhen.map((c) => c.repo ?? this.touched(state)[0]?.name))) {
        const r = this.repoByName(name); if (r) bases[name] = await R.ensureBase(r); // fetches and checks out origin/<default>
      }
      const read = (repoName, file) => {
        const base = bases[repoName ?? this.touched(state)[0]?.name]; if (!base) return null;
        const full = path.resolve(base, file);
        if (!full.startsWith(`${base}/`)) return null; // never outside the checkout
        try { return readFileSync(full, 'utf8'); } catch { return null; }
      };
      const f = freshness(state.doneWhen, read);
      if (f.allHold) {
        const shas = await Promise.all(Object.entries(bases).map(async ([k, b]) => `${k}@${(await R.git(['rev-parse', '--short', 'HEAD'], b)).trim()}`));
        M.record('already_satisfied', { checks: f.results.length, on: shas }, { issue: n });
        const d = await this.cutDecision(issue, stage, state, `Every done_when check in the tech design already holds on ${shas.join(', ')}: ` +
          `${f.results.map((x) => `${x.file} contains "${x.contains.slice(0, 60)}" ×${x.found}`).join('; ')}. Nothing is left to build. Cutting closes the issue as already done.`, 'build');
        if (d === 'waiting') return;
        if (d === 'rejected') {
          M.record('transition', { stage, to: 'rejected', outcome: 'reject', summary: `already satisfied on ${shas.join(', ')}`, kind: 'already_satisfied' }, { issue: n });
          return this.move(issue, stage, 'rejected', state);
        }
        state.freshKept = true; M.saveIssueState(n, state); // the product owner wants the build anyway: don't ask again
      }
    }
    M.snapshotArtifact(n, stage); // the agent may rewrite its artifact file during the run; keep the version it starts from
    const ownFile = p('memory/specs', `issue-${n}`, `${stage}.md`);
    (this.before ??= new Map()).set(`${n}:${stage}`, existsSync(ownFile) ? readFileSync(ownFile, 'utf8') : ''); // what the guard compares against
    if (['review', 'security'].includes(stage) && Object.keys(state.prs ?? {}).length) {
      // A parent PR merged (often squashed) under this one: rebase first, rather than review code that can't merge (feedback b81be2c4).
      const conflicts = [];
      for (const [name, pr] of Object.entries(state.prs)) {
        if (!state.merged?.[name] && (await T.prMergeable(this.repoByName(name).repo, pr).catch(() => null)) === 'CONFLICTING') conflicts.push(name);
      }
      if (conflicts.length) {
        state.lastHandoff = { from: stage, by: 'git', text: `The PR(s) now conflict with the default branch in: ${conflicts.join(', ')} (an earlier PR merged underneath). In each, run \`git fetch origin && git rebase origin/<default>\`, resolve the conflicts keeping both changes' intent, re-run all tests, commit and hand back to review.` };
        M.saveIssueState(n, state);
        M.record('transition', { stage, to: 'build', outcome: 'loop_back', loop: false, kind: 'rebase_needed', summary: `PR conflicts after a parent merge: ${conflicts}` }, { actor: 'git', issue: n });
        await T.comment(this.repo, n, `### 🔁 PR conflicts with the default branch (${conflicts.join(', ')}): back to \`build\` to rebase before \`${stage}\``);
        return this.move(issue, stage, 'build', state);
      }
      issue.ci = await this.ciGate(state, 0).catch(() => null); // owner request #50: reviewers see the PR's checks
    }
    const context = this.context(issue, stage, state, cwd);

    let res;
    if (st.council) {
      res = await council({ cfg, name: `issue-${n}/${stage}-${Date.now()}`, topic: `#${n} ${issue.title}`, context, issue: n, cwd,
        chair: st.council.chair, members: st.council.members, rounds: st.council.rounds ?? cfg.economy?.council_rounds ?? 2, nextOptions: st.next, extraSchema: this.extra(stage) });
    } else {
      const role = this.pickRole(stage, st, state);
      const meta = { stage, risk: state.risk ?? null, loops: state.loops };
      // The same role coming back to this issue and stage soon after (a loop-back, a failed check) continues its own session:
      // it already holds the brief and what it read, so it gets only what changed.
      const prev = state.sessions?.[`${role}:${stage}`];
      const fresh = prev && prev.cwd === cwd && Date.now() - new Date(prev.at) < (cfg.economy?.resume_minutes ?? 0) * 60e3;
      res = fresh ? await runAgent({ cfg, role, schema, cwd, issue: n, label: stage, meta, resume: prev.session, prompt: this.delta(issue, stage, state, prev.at) }) : null;
      if (!res?.ok) res = await runAgent({ cfg, role, prompt: context, schema, cwd, issue: n, label: stage, meta });
      // Machine checks fail fast in the same session: the agent fixes its own artifact instead of a fresh run next tick.
      for (let i = 0; res.ok && st.checks?.length && res.out.outcome === 'advance' && i < (cfg.economy?.check_retries ?? 0); i++) {
        const { runChecks } = await import('./checks.mjs');
        const c = runChecks(st.checks, this.artifactOf(n, stage, res), cfg, { issue: n });
        if (c.ok || !res.session) break;
        M.record('check_retry', { stage, attempt: i + 1, failures: c.failures.slice(0, 20) }, { actor: role, issue: n });
        const again = await runAgent({ cfg, role, schema, cwd, issue: n, label: stage, meta: { ...meta, check_retry: i + 1 }, resume: res.session,
          prompt: `Your ${stage} artifact failed ${st.checks.join(', ')}. Fix every item below, re-run the check, and hand in the corrected verdict with the full artifact:\n${c.failures.map((f) => `- ${f}`).join('\n')}` });
        if (!again.ok) break;
        res = { ...again, cost: res.cost + again.cost };
      }
      if (res.ok && res.session) {
        state.sessions = { ...(state.sessions ?? {}), [`${role}:${stage}`]: { session: res.session, at: now().toISOString(), cwd } };
        M.saveIssueState(n, state);
      }
    }

    if (!res.ok && INFRA.test(String(res.error))) {
      M.record('infra_failure', { stage, error: String(res.error).slice(0, 300) }, { issue: n }); // retried next tick; not the agent's fault
      return;
    }
    if (!res.ok) {
      state.failures = (state.failures ?? 0) + 1;
      M.saveIssueState(n, state);
      if (state.failures >= 2) {
        this.coe({ issue: n, kind: 'agent_failure', from: stage, to: stage, by: 'dispatcher', reason: String(res.error).slice(0, 2000) });
        await this.escalate(n, state, null, `The ${stage} agent failed twice:\n\`\`\`\n${res.error}\n\`\`\``);
      }
      return;
    }
    state.failures = 0;
    await this.apply(issue, stage, res, state, cwd);
  }

  async apply(issue, stage, res, state, cwd, { fromCouncil = false } = {}) {
    const { cfg, repo } = this;
    const st = cfg.pipeline[stage];
    const n = issue.number;
    const v = res.out;
    const role = st.council ? st.council.chair : this.pickRole(stage, st, state);
    const order = STAGE_ORDER(cfg);
    // A planned dependency (feedback 4ef8402c): park the issue at this stage until the named issues merge or close. No council.
    const deps = v.outcome === 'wait' ? [...new Set((v.wait_for ?? []).map(Number).filter((m) => m && m !== n))] : [];
    if (deps.length) {
      const ownFile = p('memory/specs', `issue-${n}`, `${stage}.md`), before = this.before?.get(`${n}:${stage}`) ?? (existsSync(ownFile) ? readFileSync(ownFile, 'utf8') : ''), md = this.artifactOf(n, stage, res);
      if (md?.trim() && !M.artifactRegression(before, md)) M.saveArtifact(n, stage, md);
      else if (before) writeFileSync(ownFile, before); // a waiting note never replaces the stage's work
      for (const d of v.decisions ?? []) M.decide(d, { actor: role, issue: n });
      state.waitFor = deps; state.lastHandoff = { from: stage, by: role, text: v.handoff };
      M.saveIssueState(n, state);
      M.record('waiting', { reason: 'dependency', stage, wait_for: deps, summary: v.summary?.slice(0, 500), cost_usd: res.cost }, { actor: role, issue: n });
      await T.comment(repo, n, `### ⏸️ ${role} · \`${stage}\` waits for ${deps.map((d) => `#${d}`).join(', ')}\n${v.summary}\n\nThis resumes at \`${stage}\` by itself once ${deps.length > 1 ? 'each has' : 'it has'} merged or closed.`);
      return;
    }
    // `reject` means cut (owner request #104, COE on #7). It never routes forward: it closes where `rejected` is an option,
    // and elsewhere the product owner decides the cut; keeping the issue sends it where the agent pointed.
    const cut = rejectRoute(st.next, v, stage);
    if (cut) {
      M.record('reject_rerouted', { stage, asked: v.next_stage, allowed: cut.action === 'close' }, { actor: role, issue: n });
      if (cut.action === 'close') v.next_stage = 'rejected';
      else {
        for (const d of v.decisions ?? []) M.decide(d, { actor: role, issue: n });
        const keepTo = cut.keepTo;
        const d = await this.cutDecision(issue, stage, state, `The ${role} asked to cut #${n} at \`${stage}\`: ${v.summary}`, keepTo);
        if (d === 'waiting') return;
        if (d === 'rejected') {
          M.record('transition', { stage, to: 'rejected', outcome: 'reject', summary: v.summary?.slice(0, 500), kind: 'cut' }, { actor: role, issue: n });
          return this.move(issue, stage, 'rejected', state);
        }
        v.outcome = st.next.indexOf(keepTo) >= 0 && STAGE_ORDER(cfg).indexOf(keepTo) < STAGE_ORDER(cfg).indexOf(stage) ? 'loop_back' : 'advance';
        v.next_stage = keepTo;
      }
    }
    // A duplicate is a routing fact (owner request #113): both issues get a back-link, and the product owner confirms before
    // it closes. Kept, it carries on as the agent routed it.
    const dup = Number(v.duplicate_of) || null;
    if (dup && dup !== n && ['triage', 'analysis', 'feature-grooming', 'tech-grooming'].includes(stage) && v.outcome !== 'reject') {
      M.record('duplicate_flagged', { of: dup, summary: v.summary?.slice(0, 300) }, { actor: role, issue: n });
      await T.comment(repo, dup, `### 🔗 #${n} may duplicate this issue\nThe ${role} flagged it at \`${stage}\`. The product owner decides whether #${n} closes.`).catch(() => {});
      const keepTo = v.next_stage && v.next_stage !== 'blocked' ? v.next_stage : stage;
      const d = await this.cutDecision(issue, stage, state, `The ${role} says #${n} duplicates #${dup}: ${v.summary} Cutting closes #${n} as a duplicate of #${dup}.`, keepTo);
      if (d === 'waiting') return;
      if (d === 'rejected') {
        M.record('transition', { stage, to: 'rejected', outcome: 'reject', summary: `duplicate of #${dup}`, kind: 'duplicate' }, { actor: role, issue: n });
        await T.comment(repo, n, `Closed as a duplicate of #${dup}.`);
        return this.move(issue, stage, 'rejected', state);
      }
    }
    // tech-grooming must say where the work happens (owner request #108): an empty repos list never silently means "all".
    if (stage === 'tech-grooming' && v.outcome === 'advance') {
      const text = this.artifactOf(n, stage, res), bad = [];
      if (!v.repos?.length && !v.factory_paths?.length && !v.all_repos) bad.push('Name the repos this change touches in `repos`, list `factory_paths` for a factory change, or set `all_repos: true`.');
      // The factory's code (not memory/ paths, which every design quotes): its repo slug, or a path into deploy/, factory/, templates/, bin/, tests/.
      if (this.factory && !v.factory_paths?.length && !v.uses_factory_code && new RegExp(`\\b${this.factory.repo.replace('/', '\\/')}\\b|software-factory\\/(deploy|factory|templates|bin|tests)\\/`, 'i').test(text))
        bad.push(`The design names the factory's code, but \`factory_paths\` is empty. List the factory files it edits there; if it only runs or reads factory code (e.g. deploy/local-node.sh) without changing it, set \`uses_factory_code: true\` instead.`);
      for (const r of this.repos) if (new RegExp(`^\\s*\\**\\s*repos?\\s*:?\\**\\s*:?.*\\b${r.name}\\b`, 'im').test(text) && v.repos?.length && !v.repos.includes(r.name))
        bad.push(`The design's Repo line names ${r.name}, but \`repos\` doesn't include it.`);
      // Two open issues editing the same files must say how they relate (owner request #115; #42 and #64 both wrote local-node.sh).
      const mine = factoryPaths(v.factory_paths).ok, clash = mine.length ? clashes(n, mine, claimsIndex()) : [];
      if (clash.length && !v.delta_of && !v.duplicate_of)
        bad.push(`Other open issues already claim these files: ${clash.map((c) => `#${c.issue} (${c.path})`).join(', ')}. Say how this issue relates: \`delta_of\` (it builds on that issue's change), ` +
          `outcome \`wait\` with \`wait_for\`, or \`duplicate_of\`.`);
      if (bad.length) {
        state.lastHandoff = { from: `checks:${stage}`, by: 'dispatcher', text: `The tech-grooming verdict's repo fields don't match the design. Fix and advance again:\n${bad.map((b) => `- ${b}`).join('\n')}` };
        M.saveIssueState(n, state);
        M.record('check_failed', { stage, checks: ['repo_fields'], failures: bad }, { actor: role, issue: n });
        await T.comment(repo, n, `### ✗ \`${stage}\` repo fields don't match the design, back to the ${role}\n${bad.map((b) => `- ${b}`).join('\n')}`);
        return;
      }
    }
    let next = v.outcome === 'blocked' || v.outcome === 'wait' ? 'blocked' : v.next_stage; // `wait` without issues to wait for is a block
    // Council stages route rather than loop, and `forward` targets (verify → release = promote) are progress.
    const isLoop = !st.council && !(st.forward ?? []).includes(next) && order.includes(next) && order.indexOf(next) < order.indexOf(stage);

    // Repeated loop-backs: the agents involved discuss the route instead of one agent deciding alone.
    if (isLoop && !fromCouncil && this.loopsSince(state) + 1 >= (cfg.loops.council_after ?? 2)) {
      const target = cfg.pipeline[next];
      const members = [...new Set([role, target.role ?? target.council?.chair, 'product-manager'].filter(Boolean))];
      const c = await council({
        cfg, name: `issue-${n}/loop-${stage}-to-${next}-${Date.now()}`, topic: `#${n} keeps looping (${stage} → ${next}). What is the right route?`,
        context: `${this.context(issue, stage, state, cwd, { kb: 12, reviewing: true })}\n\n## The ${role}'s verdict that triggered this council\n${v.summary}\n\n${v.handoff}\n\nThis issue has looped ${state.loops} time(s): ${JSON.stringify(state.history.slice(-6))}`,
        chair: this.loopsSince(state) + 1 > cfg.loops.max_loops ? 'chief-of-staff' : 'architect', members, rounds: cfg.economy?.council_rounds ?? 2, nextOptions: st.next, issue: n, cwd, extraSchema: this.extra(stage),
      });
      if (c.ok) {
        await T.comment(repo, n, `🗣️ **Council convened** on repeated loop-backs. The transcript is at \`${c.thread}\`.`);
        return this.apply(issue, stage, c, state, cwd, { fromCouncil: true });
      }
    }

    // An agent allowed to write its own artifact may have written the full document and returned only a summary:
    // the file it wrote during this run is the artifact, so it is never overwritten by the summary.
    // A council's decision is not the stage's artifact (feedback 118f8faf, #68): it goes into the council thread, the stage's
    // own artifact stays as it is, and the checks below run against that artifact.
    const own = p('memory/specs', `issue-${n}`, `${stage}.md`), prevText = this.before?.get(`${n}:${stage}`) ?? (existsSync(own) ? readFileSync(own, 'utf8') : '');
    let artifact;
    if (fromCouncil) {
      if (res.thread && v.artifact_markdown?.trim()) appendFileSync(p(res.thread), `\n## Chair's decision document\n${v.artifact_markdown.trim()}\n`);
      artifact = res.thread ?? null;
      if (prevText && existsSync(own) && readFileSync(own, 'utf8') !== prevText) writeFileSync(own, prevText); // no council member rewrites the stage's work
      v.artifact_markdown = prevText;
    } else {
      v.artifact_markdown = this.artifactOf(n, stage, res);
      const lost = M.artifactRegression(prevText, v.artifact_markdown);
      if (lost) { // keep the previous version; the new text is kept beside the issue's threads, never lost
        const kept = M.saveThread(`issue-${n}/${stage}-rejected-${Date.now()}`, `# ${stage} artifact not saved (${lost})\nBy ${role}, ${now().toISOString()}. The previous version was kept.\n\n${v.artifact_markdown}`);
        writeFileSync(own, prevText); // the agent may have overwritten the file during its run
        M.record('artifact_rejected', { stage, reason: lost, kept }, { actor: role, issue: n });
        if (v.outcome === 'advance') {
          state.lastHandoff = { from: `guard:${stage}`, by: 'dispatcher', text: `Your ${stage} artifact was not saved because ${lost}. The previous version is still in place (${own}). Revise that file in full and hand in again; what you returned is at ${p(kept)}.` };
          M.saveIssueState(n, state);
          await T.comment(repo, n, `### ✗ \`${stage}\` artifact not saved: ${lost}. The previous version was kept, so the ${role} revises it and hands in again.`);
          return;
        }
        v.artifact_markdown = prevText;
      } else M.saveArtifact(n, stage, v.artifact_markdown);
      artifact = path.relative(p(), own);
    }
    const adrs = (v.decisions ?? []).map((d) => M.decide(d, { actor: role, issue: n }));
    for (const l of v.learnings ?? []) M.learn(l, { actor: role, issue: n });
    for (const fb of v.feedback ?? []) { // the request and complaint box
      try { (await import('./hr.mjs')).file(fb, { by: role, issue: n }); }
      catch (e) { M.record('feedback_rejected', { reason: e.message.slice(0, 200) }, { actor: role, issue: n }); }
    }
    const published = [];
    for (const d of v.documents ?? []) { // the org's library: only folders the org decided on
      try { published.push(await import('./library.mjs').then((L) => L.publish(cfg, d, { actor: role, issue: n }))); }
      catch (e) { M.record('publish_rejected', { title: d.title, folder: d.folder, reason: e.message.slice(0, 300) }, { actor: role, issue: n }); }
    }
    if (v.process_proposal) { // org/factory process improvements go to governance, not the product pipeline
      M.writeDoc(`org/proposals/${now().toISOString().slice(0, 10)}-${role}-${Date.now()}.md`, `# Proposal from ${role} (#${n}, ${stage})\n\n${v.process_proposal}\n`);
      M.record('proposal', { text: v.process_proposal.slice(0, 300) }, { actor: role, issue: n });
    }
    const filed = [];
    for (const f of v.follow_up_issues ?? []) { // the org files its own work
      const m = await T.createIssue(repo, { title: f.title, labels: [cfg.product.intake_label, ...(f.priority ? [f.priority] : [])],
        body: `${f.body}\n\n---\nFiled by **${role}** while working on #${n} (${stage}): ${f.reason}` }).catch(() => null);
      if (m) {
        filed.push(m); M.record('issue_filed', { title: f.title, filed: m, from: n, blocking: !!f.blocking }, { actor: role, issue: m });
        if (f.blocking && cfg.delivery?.mode === 'release') await import('./release.mjs').then((R) => R.admit(cfg, m, { title: f.title, body: f.body, reason: `blocking prerequisite of #${n}: ${f.reason}` })).catch(() => {});
      }
    }
    if (duplicateTransition(state, stage, next, v.outcome)) { // the issue is already at `next` (owner request #141): record nothing twice
      M.record('duplicate_transition', { stage, to: next, outcome: v.outcome, moved_at: state.moved.at, summary: v.summary?.slice(0, 300), cost_usd: res.cost }, { actor: role, issue: n });
      return T.setStage(repo, n, stage, next); // a label that still said `stage` is what let it run again
    }
    if (isLoop) {
      state.loops += 1;
      this.coe({ issue: n, kind: 'loop_back', from: stage, to: next, by: role, reason: `${v.summary}\n\nHandoff: ${v.handoff}` });
    }
    state.history.push({ ts: now().toISOString(), stage, to: next, outcome: v.outcome, by: role });
    // A council's route is a decision for whoever runs next, the same stage included; an agent's own handoff is not shown back to it.
    state.lastHandoff = { from: fromCouncil ? `council:${stage}` : stage, by: role, text: fromCouncil && res.thread ?`${v.handoff}\n\nThe council's discussion and decision: ${p(res.thread)}` : v.handoff };
    if (v.risk_tier) state.risk = v.risk_tier;
    if (v.next_assignee && (cfg.pipeline[next]?.pool ?? []).includes(v.next_assignee)) state.assign = { ...state.assign, [next]: v.next_assignee };
    if (v.repos?.length) state.repos = v.repos;
    if (stage === 'tech-grooming' && Array.isArray(v.done_when)) { state.doneWhen = v.done_when.filter((c) => c.file && c.contains && Number.isInteger(c.count)); state.freshKept = false; }
    if (stage === 'tech-grooming' && v.factory_paths) { // a change to the factory itself: worktree, PR and an owner-gated merge
      const { ok, refused } = factoryPaths(v.factory_paths);
      state.factory = ok.length && this.factory ? { paths: ok } : null;
      if (refused.length) await T.comment(repo, n, `### ⚠️ Not factory code: ${refused.map((x) => `\`${x}\``).join(', ')}\nThese are this install's data (org/, memory/, library/) or not a code path. Change them through a process_proposal, not a factory PR.`);
      M.record('factory_change', { paths: ok, refused }, { actor: role, issue: n });
    }
    if (v.priority) {
      const old = T.labelsOf(issue).filter((l) => /^P[0-3]$/.test(l) && l !== v.priority);
      await T.editLabels(repo, n, { add: [v.priority], remove: old });
    }
    M.record('transition', { stage, to: next, outcome: v.outcome, loop: isLoop, loops: state.loops, summary: v.summary,
      artifact, adrs, cost_usd: res.cost, council: fromCouncil }, { actor: role, issue: n });

    await T.comment(repo, n, [
      `### 🤖 ${role} · \`${stage}\` → \`${next}\`${isLoop ? ` 🔁 loop ${state.loops}` : ''}${fromCouncil ? ' 🗣️ council' : ''}`,
      v.summary, '', `**Handoff:** ${v.handoff}`,
      v.question_for_human && next !== 'blocked' && v.outcome !== 'blocked' ? `\n❓ **Question (non-blocking, the default was assumed):** ${v.question_for_human}\nReply here and the answer is recorded in shared memory.` : '',
      filed.length ? `\n📝 **Filed:** ${filed.map((m) => `#${m}`).join(', ')}` : '',
      published.length ? `\n📚 **Published:** ${published.map((f) => `\`${f}\``).join(', ')}` : '',
      adrs.length ? `\n<details><summary>Decisions recorded (${adrs.length})</summary>\n\n${adrs.map((a) => `- \`${a}\``).join('\n')}\n</details>` : '',
      `\n<sub>artifact: \`${artifact}\` · cost $${res.cost.toFixed(2)} · ${Math.round(res.ms / 1000)}s</sub>`,
    ].join('\n'));

    // Stage side effects
    if (stage === 'build' && next === 'review' && !(await this.publish(issue, state, v))) {
      // No product-repo commits. Allowed when the tech design says so (feedback a612e8eb); otherwise the build is incomplete.
      if (v.no_code_change && !Object.keys(state.prs ?? {}).length) { state.noCode = true; M.saveIssueState(n, state); M.record('no_code_change', { summary: v.summary?.slice(0, 300) }, { actor: role, issue: n }); }
      else if (/does not declare/.test(v.question_for_human ?? '')) { // work in an undeclared repo: the design must name it, no council needed
        state.lastHandoff = { from: 'build', by: 'dispatcher', text: `${v.question_for_human} The engineer's commits are kept on the issue branch.` };
        M.saveIssueState(n, state);
        M.record('transition', { stage, to: 'tech-grooming', outcome: 'loop_back', loop: true, loops: state.loops, kind: 'undeclared_repo', summary: v.question_for_human.slice(0, 300) }, { actor: 'dispatcher', issue: n });
        await T.comment(repo, n, `### ↩️ Not published: ${v.question_for_human}\nBack to \`tech-grooming\` to declare it.`);
        return this.move(issue, stage, 'tech-grooming', state);
      }
      else next = 'blocked';
    }
    if (['review', 'security'].includes(stage)) {
      for (const [name, pr] of Object.entries(state.prs ?? {})) {
        await T.prComment(this.repoByName(name).repo, pr, `### ${role}: ${next === 'merge' || next === 'security' ? '✅' : '❌'}\n${v.summary}`);
      }
    }
    // CI gate (owner request #50): build, review and security may not advance while the PR's checks are red. Waits for
    // pending checks, then loops to build with the failing log, so CI failures are fixed before review instead of at merge.
    const FORWARD = { build: 'review', review: 'security', security: 'merge' };
    if (FORWARD[stage] === next && Object.keys(state.prs ?? {}).length) {
      const ci = await this.ciGate(state);
      if (ci.status === 'fail') {
        isLoop || (state.loops += 1);
        state.lastHandoff = { from: `ci:${stage}`, by: 'ci', text: `CI is red on the PR, so \`${stage}\` can't advance. Fix these failures on the branch, run the same checks locally, and commit:\n\n${ci.failures.map((f) => `### ${f.repo}: ${f.name}\n\`\`\`\n${f.log || '(no log available; see the check link)'}\n\`\`\`\n${f.link ?? ''}`).join('\n\n')}` };
        state.history.push({ ts: now().toISOString(), stage, to: 'build', outcome: 'loop_back', by: 'ci' });
        M.saveIssueState(n, state);
        M.record('transition', { stage, to: 'build', outcome: 'loop_back', loop: stage !== 'build', loops: state.loops, kind: 'ci_failure', summary: `CI failed: ${ci.failures.map((f) => `${f.repo}/${f.name}`).join(', ')}` }, { actor: 'ci', issue: n });
        await T.comment(repo, n, `### 🔁 CI is red, so \`${stage}\` can't advance: back to \`build\`\n${ci.table}\n\n<details><summary>Failing log excerpts</summary>\n\n${ci.failures.map((f) => `**${f.repo}: ${f.name}**\n\`\`\`\n${(f.log || '').slice(-3000)}\n\`\`\``).join('\n\n')}\n</details>`);
        if (this.loopsSince(state) > cfg.loops.max_loops) return this.escalate(n, state, 'build', 'CI keeps failing.');
        return this.move(issue, stage, 'build', state);
      }
      if (ci.status === 'timeout') M.record('ci_wait_timeout', { stage, table: ci.table.slice(0, 1000) }, { issue: n }); // merge still enforces green
    }
    if (stage === 'release' && next !== 'blocked') {
      // Deployed means the deploy step exited 0 AND the health URL answered 200 (feedback 2fa9b900: a repo with no deploy
      // config used to fall out of the loop, so staging was marked deployed and the issue moved to verify with nothing running).
      const env = v.environment ?? this.nextEnv(state);
      const d = await decideDeploy({ verdict: v, repos: this.deployable(state), env, runDeploy: (r, e) => this.deploy(r, e), probe: (u) => probeHealth(u), resolves: (prog, r) => this.resolvesProgram(prog, r) });
      for (const [type, data] of d.events) M.record(type, { ...data, risk: state.risk }, { actor: type === 'deploy' ? role : 'deploy', issue: n });
      if (d.status === 'deployed') {
        state.deployed = { ...state.deployed, [env]: now().toISOString() };
        state.lastEnv = env;
        await T.comment(repo, n, `### 🚀 Deployed to \`${env}\` (deploy exited 0, health 200)\n${this.deployable(state).map((r) => `- ${r.name}: ${r.health[env]}`).join('\n')}`);
      } else if (d.status === 'no_runtime') { // nothing to run: the env is passed, not deployed, so verify and promotion still work
        state.noRuntime = { ...state.noRuntime, [env]: now().toISOString() };
        state.lastEnv = env;
        await T.comment(repo, n, `### ⏭️ No deploy to \`${env}\`: the release manager declared no runtime surface\n> ${d.detail.replaceAll('\n', '\n> ')}`);
      } else { // a hold, whether the agent chose it or the gate forced it; never verify
        next = 'release';
        state.holdUntil = new Date(Date.now() + (v.hold_minutes ?? 60) * 60e3).toISOString();
        if (d.status === 'hold') {
          const text = `The release was held: nothing was deployed to ${env} (${d.reason}).\n${d.detail}${d.log ? `\n\`\`\`\n${d.log.slice(-2500)}\n\`\`\`` : ''}\n` +
            `If the deploy config is missing, file it as a blocking follow-up or a vendor request; if a deploy failed, route the log to build. ` +
            `If this change truly has nothing to run, return no_runtime_surface: true with a no_runtime_note that says why.`;
          state.lastHandoff = { from: 'release', by: 'deploy', text };
          if (d.next !== 'release') { // the verdict's transition is already on the record; this one overrides it
            state.history.push({ ts: now().toISOString(), stage, to: 'release', outcome: 'hold', by: 'deploy' });
            M.record('transition', { stage, to: 'release', outcome: 'hold', loop: false, loops: state.loops, kind: 'deploy_gate', summary: `Held at release: nothing deployed to ${env} (${d.reason})` }, { actor: 'deploy', issue: n });
          }
          await T.comment(repo, n, `### ⏸️ Release held: nothing was deployed to \`${env}\` (${d.reason})\n${d.detail}${d.log ? `\n\`\`\`\n${d.log.slice(-2500)}\n\`\`\`` : ''}`);
          if (['failed', 'unhealthy'].includes(d.reason)) this.coe({ issue: n, kind: 'deploy_failure', from: 'release', to: 'release', by: 'deploy', reason: text.slice(0, 3000) });
        }
      }
    }
    if (stage === 'verify') {
      for (const inc of v.incidents ?? []) await this.fileIncident(inc, n);
      if (v.rollback) for (const r of this.deployable(state)) await this.rollback(r, state.lastEnv, n);
      if (v.rollback || next === 'build') this.coe({ issue: n, kind: v.rollback ? 'rollback' : 'regression', from: 'verify', to: 'build', by: role, reason: `${v.summary}\n\n${v.handoff}` });
      else if (['done', 'release'].includes(next)) for (const r of this.deployable(state)) this.markVerified(r, state.lastEnv, n);
    }
    M.saveIssueState(n, state);

    // Something only a person can provide → a vendor request. Blocking requests pause this issue until fulfilled.
    if (v.vendor_request) {
      await this.vendorRequest(issue, stage, role, v.vendor_request, state, v.outcome === 'needs_vendor');
      if (v.outcome === 'needs_vendor') return;
    }
    // A question for one specialist → one consult run of that role (not a council, not a loop). The stage then re-runs with the answer.
    if (v.consult?.role && cfg.roles[v.consult.role] && (state.consults ?? 0) < 3) {
      state.consults = (state.consults ?? 0) + 1;
      const c = await runAgent({ cfg, role: v.consult.role, issue: n, label: `consult-${stage}`, cwd,
        schema: { type: 'object', properties: { answer: { type: 'string' }, decisions: { type: 'array', items: { type: 'object' } } }, required: ['answer'] },
        prompt: `${this.context(issue, stage, state, cwd, { kb: 12, reviewing: true })}\n\n# Consult\nThe ${role} working on \`${stage}\` asks you, as ${v.consult.role}:\n> ${v.consult.question}\n\nAnswer within your authority, precisely. Record any decision you make.` });
      if (c.ok) {
        for (const d of c.out.decisions ?? []) if (d.title && d.decision) M.decide({ rationale: '', ...d }, { actor: v.consult.role, issue: n });
        state.lastHandoff = { from: `consult:${v.consult.role}`, by: v.consult.role, text: `Answer to the ${role}'s question "${v.consult.question}":\n${c.out.answer}` };
        M.saveIssueState(n, state);
        M.record('consult', { stage, role: v.consult.role, question: v.consult.question.slice(0, 300), cost_usd: c.cost }, { actor: role, issue: n });
        await T.comment(repo, n, `### 💬 ${role} consulted ${v.consult.role}\n**Q:** ${v.consult.question}\n\n**A:** ${c.out.answer.slice(0, 3000)}`);
        return; // the stage re-runs next tick with the answer
      }
    }
    // A decision beyond this agent's authority → the org decides (council chaired by the chief of staff), not a person.
    if (next === 'blocked') {
      if (!fromCouncil) {
        const lead = cfg.teams[teamOf(cfg, role)]?.lead;
        const head = Object.values(cfg.departments ?? {}).find((d) => d.teams?.includes(teamOf(cfg, role)))?.head; // first escalation point
        const c = await council({ cfg, name: `issue-${n}/blocked-${stage}-${Date.now()}`, topic: `#${n}: the ${role} is blocked in ${stage}. Decide.`,
          context: `${this.context(issue, stage, state, cwd, { kb: 12, reviewing: true })}\n\n## What blocked the ${role}\n${v.summary}\n\n${v.question_for_human ?? ''}\n${v.handoff}`,
          chair: 'chief-of-staff', members: [...new Set([role, lead, head, 'product-owner'].filter(Boolean))], rounds: 2, nextOptions: st.next, issue: n, cwd, extraSchema: this.extra(stage) });
        if (c.ok) return this.apply(issue, stage, c, state, cwd, { fromCouncil: true });
      }
      return this.escalate(n, state, null, `The council could not decide.\n\n${v.question_for_human || v.summary}`, owners(cfg));
    }
    if (isLoop && this.loopsSince(state) > (cfg.loops.owner_after ?? 6)) return this.escalate(n, state, next, `Runaway: ${state.loops} loop-backs. Add \`${T.L.approved}\` to continue to \`${next}\`, or close the issue.`, owners(cfg));
    if (st.checks?.length && v.outcome === 'advance') { // machine checks first: the artifact must pass before anyone approves it
      const { runChecks } = await import('./checks.mjs');
      const c = runChecks(st.checks, v.artifact_markdown, cfg, { issue: n });
      if (!c.ok) {
        state.lastHandoff = { from: `checks:${stage}`, by: 'dispatcher', text: `The ${stage} artifact failed ${st.checks.join(', ')}. Fix every item and advance again:\n${c.failures.map((f) => `- ${f}`).join('\n')}` };
        M.saveIssueState(n, state);
        M.record('check_failed', { stage, checks: st.checks, failures: c.failures.slice(0, 30), loop_reason_class: 'missing-AC' }, { actor: role, issue: n });
        await T.comment(repo, n, `### ✗ \`${stage}\` failed ${st.checks.join(', ')} (${c.failures.length} item${c.failures.length > 1 ? 's' : ''}), back to the ${role}\n${c.failures.slice(0, 15).map((f) => `- ${f}`).join('\n')}${c.failures.length > 15 ? `\n- …and ${c.failures.length - 15} more` : ''}`);
        return; // same stage re-runs next tick with the failures as its handoff
      }
      M.record('check_passed', { stage, checks: st.checks }, { actor: role, issue: n });
    }
    if (st.approve && v.outcome === 'advance') {
      const a = await this.approval(issue, stage, st.approve, next, artifact, state);
      if (a === 'waiting') return;
      if (a.approved) return this.move(issue, stage, next, state);
      return this.move(issue, stage, a.route_to, state);
    }
    await this.move(issue, stage, next, state);
  }

  async move(issue, from, to, state) {
    const n = issue.number;
    if (to === 'done' || to === 'rejected') {
      await T.setStage(this.repo, n, from, to);
      await T.closeIssue(this.repo, n, to === 'done' ? 'completed' : 'not planned');
      await R.dropWorktrees(n, this.repos);
      M.record('closed', { to, loops: state.loops }, { issue: n });
      return;
    }
    if (from !== to) {
      await T.setStage(this.repo, n, from, to);
      state.moved = moveStamp(state, from, to, this.artifactText(n, from)); // what a stale re-dispatch of `from` is checked against
      M.saveIssueState(n, state);
    }
  }

  /** Did a run of this issue end after the issue list was fetched? Then the list's stage label may be the old one (feedback 0333ef04). */
  settledSince(n, listedAt) { return (this.settled?.get(n) ?? 0) >= listedAt; }
  settle(n) { (this.settled ??= new Map()).set(n, Date.now()); this.running.delete(n); }
  artifactText(n, stage) { try { return readFileSync(p('memory/specs', `issue-${n}`, `${stage}.md`), 'utf8'); } catch { return ''; } }

  /** The label says `stage`, but the issue already advanced from it and nothing changed since (feedback 0333ef04, #77). */
  repeatedAdvance(n, stage, state) {
    if (state.moved?.from !== stage) return null; // the common case: no ledger read
    return repeatsAdvance(this.cfg, state, stage, this.artifactText(n, stage), M.events({ since: state.moved.at }).filter((e) => e.issue === n));
  }
  /** Don't run the stage again: put the label back where the verdict sent it. */
  async restoreStage(issue, stage, state) {
    const m = state.moved;
    M.record('redispatch_blocked', { stage, to: m.to, moved_at: m.at, reason: 'already advanced, nothing changed (same HEAD, artifact and handoff; no loop)' }, { issue: issue.number });
    console.log(`⏭ #${issue.number} ${stage} already advanced to ${m.to} at ${m.at}; not re-running`);
    await T.setStage(this.repo, issue.number, stage, m.to);
  }

  /** Loop-backs since the owner last approved: what council, chair and runaway thresholds count (the full history is kept). */
  loopsSince(state) { return (state.loops ?? 0) - (state.loopBase ?? 0); }

  async escalate(n, state, pending, message, to = owners(this.cfg)) {
    // Never ask the owner twice about the same unchanged build (owner request #109): the second time with an identical
    // HEAD, it goes back to tech-grooming with the diagnosis instead.
    const stage = this.running.get(n)?.stage, heads = JSON.stringify(state.heads ?? {});
    if (stage === 'build' && state.escalations && state.lastEscalation?.stage === stage && state.lastEscalation.heads === heads) {
      state.lastHandoff = { from: 'escalation', by: 'dispatcher', text: `Identical HEAD resubmitted after the owner's approval, so the same failure would recur: ${message.replace(/\s+/g, ' ').slice(0, 600)} Fix the cause in the design (declared repos, factory_paths, scope) before build runs again.` };
      state.lastEscalation = null; M.saveIssueState(n, state);
      M.record('escalation_rerouted', { stage, to: 'tech-grooming', reason: message.slice(0, 300) }, { issue: n });
      await T.comment(this.repo, n, `### ↩️ Not asking the owner again: the build is unchanged since the last approval\n${state.lastHandoff.text}\nBack to \`tech-grooming\`.`);
      return this.move({ number: n }, stage, 'tech-grooming', state);
    }
    state.lastEscalation = { stage: stage ?? null, heads, at: now().toISOString() };
    state.pending = pending;
    state.escalatedAt = now().toISOString();
    M.saveIssueState(n, state);
    await T.editLabels(this.repo, n, { add: [T.L.human] });
    await T.assign(this.repo, n, to).catch(() => {});
    await T.comment(this.repo, n, `### 🙋 ${to.map((l) => `@${l}`).join(' ') || 'Human'}: over to you\n${message}`);
    M.record('escalated', { pending, message: message.slice(0, 500) }, { issue: n });
  }

  async resolveGate(issue) {
    const n = issue.number;
    const state = M.issueState(n);
    const stage = T.stageOf(issue);
    // Whatever the human wrote while the issue waited becomes shared knowledge and the next agent's handoff.
    const said = await T.humanComments(this.repo, n, state.escalatedAt).catch(() => []);
    if (said.length) {
      const text = said.map((c) => c.body).join('\n\n');
      if (state.personStage === stage) { // a person performed this stage: their comments are the artifact
        M.saveArtifact(n, stage, text);
        M.record('transition', { stage, to: state.pending, outcome: 'advance', summary: text.slice(0, 500), by_person: true }, { actor: said[0].by ?? 'human', issue: n });
      } else recordAnswer(`#${n} ${issue.title} (${stage})`, text, { issue: n, by: said[0].by ?? 'human' });
      state.lastHandoff = { from: stage, by: said[0].by ?? 'human', text };
    }
    await T.editLabels(this.repo, n, { remove: [T.L.human, T.L.approved] });
    if (state.pending === 'merge' && stage === 'merge') { state.mergeApproved = true; if (state.factoryGate) state.factoryApproved = true; } // a person approved the merge
    else if (state.pending && state.pending !== stage) await this.move(issue, stage, state.pending, state);
    M.record('human_approved', { stage, to: state.pending, escalations: (state.escalations ?? 0) + 1, loops: state.loops }, { actor: 'human', issue: n });
    // The loop history is kept (owner request #109): thresholds count loops since this approval, and approvals are counted.
    state.pending = null; state.loopBase = state.loops; state.escalations = (state.escalations ?? 0) + 1; state.failures = 0; state.personStage = null;
    M.saveIssueState(n, state);
  }

  // ── system stage: merge every PR of the issue, in repo order (requeue on CI failure) ──
  async merge(issue, state) {
    const { cfg, repo } = this;
    const n = issue.number;
    const prs = Object.entries(state.prs ?? {}).filter(([name]) => !state.merged?.[name]);
    if (!Object.keys(state.prs ?? {}).length) {
      if (state.noCode) { // reviewed and security-checked work with no product code to merge or deploy
        await T.comment(repo, n, `### ✅ No product code to merge: the change is outside the product repos, as the tech design planned. Closing.`);
        return this.move(issue, 'merge', 'done', state);
      }
      return this.escalate(n, state, 'build', 'Reached merge with no PRs recorded.');
    }
    const gate = cfg.gates?.merge_by_risk?.[state.risk ?? 'medium'] ?? 'auto';
    if (gate !== 'auto' && !state.mergeApproved) { // second-person approval by role
      const a = await this.approval(issue, 'merge', gate, 'release', null, state);
      if (a === 'waiting') return;
      if (!a.approved) return this.move(issue, 'merge', a.route_to, state);
      state.mergeApproved = true; M.saveIssueState(n, state);
    }
    // A change to the factory itself merges only with a person's approval (feedback 21182531): it alters the org's own rules.
    const fpr = this.factory && state.prs?.[this.factory.name];
    if (fpr && !state.merged?.[this.factory.name] && !state.factoryApproved) {
      state.factoryGate = true; M.saveIssueState(n, state);
      return this.escalate(n, state, 'merge', `**Factory change: your approval is needed to merge.** This issue changes the factory's own code: ` +
        `https://github.com/${this.factory.repo}/pull/${fpr}. It passed review and security. Read the diff, then click "Post & approve" ` +
        `(or add \`${T.L.approved}\`) to merge it, or reply with the changes needed. After it merges, the running factory changes only when ` +
        `you pull the code and restart the dispatcher.`, owners(cfg));
    }
    // A draft is not ready: provisional work goes back to build instead of merging.
    const drafts = [];
    for (const [name, pr] of prs) if (await T.isDraft(this.repoByName(name).repo, pr).catch(() => false)) drafts.push(name);
    if (drafts.length) {
      state.lastHandoff = { from: 'merge', by: 'dispatcher', text: `PR(s) are still drafts in: ${drafts.join(', ')}. Finish the provisional items, then publish with pr_draft=false.` };
      M.saveIssueState(n, state);
      M.record('transition', { stage: 'merge', to: 'build', outcome: 'loop_back', loop: false, summary: `draft PR: ${drafts}` }, { issue: n });
      await T.comment(repo, n, `### ↩️ PR still a draft (${drafts.join(', ')}), back to \`build\` to finish it`);
      return this.move(issue, 'merge', 'build', state);
    }
    // Another issue merged first and touched the same files → the engineer rebases.
    const conflicts = [];
    for (const [name, pr] of prs) if ((await T.prMergeable(this.repoByName(name).repo, pr)) === 'CONFLICTING') conflicts.push(name);
    if (conflicts.length) {
      state.loops += 1;
      state.lastHandoff = { from: 'merge', by: 'git', text: `PR(s) conflict with the default branch in: ${conflicts.join(', ')}. In each, run \`git fetch origin && git rebase origin/<default>\`, resolve the conflicts keeping both changes' intent, re-run all tests, and commit.` };
      M.saveIssueState(n, state);
      M.record('transition', { stage: 'merge', to: 'build', outcome: 'loop_back', loop: true, loops: state.loops, summary: `merge conflict: ${conflicts}` }, { issue: n });
      await T.comment(repo, n, `### 🔁 Merge conflict (${conflicts.join(', ')}), requeued to \`build\` to rebase`);
      this.coe({ issue: n, kind: 'merge_conflict', from: 'merge', to: 'build', by: 'git', reason: state.lastHandoff.text });
      if (this.loopsSince(state) > cfg.loops.max_loops) return this.escalate(n, state, 'build', 'Merge conflicts keep recurring.');
      return this.move(issue, 'merge', 'build', state);
    }
    const checks = {};
    for (const [name, pr] of prs) checks[name] = await T.prChecks(this.repoByName(name).repo, pr);
    if (Object.values(checks).includes('pending')) return;
    const failed = Object.entries(checks).filter(([, c]) => c === 'fail').map(([name]) => name);
    if (failed.length) {
      state.loops += 1;
      state.lastHandoff = { from: 'merge', by: 'ci', text: `CI is failing in: ${failed.map((f) => `${f} (gh pr checks ${state.prs[f]} -R ${this.repoByName(f).repo})`).join(', ')}. Fix the failures.` };
      M.saveIssueState(n, state);
      M.record('transition', { stage: 'merge', to: 'build', outcome: 'loop_back', loop: true, loops: state.loops, summary: `CI failed: ${failed}` }, { issue: n });
      await T.comment(repo, n, `### 🔁 CI failed (${failed.join(', ')}), requeued to \`build\``);
      this.coe({ issue: n, kind: 'ci_failure', from: 'merge', to: 'build', by: 'ci', reason: state.lastHandoff.text });
      if (this.loopsSince(state) > cfg.loops.max_loops) return this.escalate(n, state, 'build', 'CI keeps failing.');
      return this.move(issue, 'merge', 'build', state);
    }
    for (const r of [...this.repos, ...(this.factory ? [this.factory] : [])]) { // config order = dependency order; the factory last
      const pr = state.prs[r.name];
      if (!pr || state.merged?.[r.name]) continue;
      await T.mergePr(r.repo, pr);
      state.merged = { ...state.merged, [r.name]: now().toISOString() };
      M.saveIssueState(n, state);
      const mergeSha = (await T.gh(['pr', 'view', String(pr), '-R', r.repo, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']).catch(() => '')) || null;
      M.record(r.factory ? 'factory_merged' : 'merged', { repo: r.name, pr, risk: state.risk, checks: checks[r.name], head_sha: state.heads?.[r.name] ?? null, merge_sha: mergeSha }, { issue: n });
      if (r.factory) state.factoryMergeSha = mergeSha;
    }
    // The owner approved a factory change: bring the running factory up to it (owner request #132), or say why not.
    let factoryNote = '';
    if (state.merged?.[this.factory?.name] && !state.factorySynced) {
      const s = await this.syncFactory(state.factoryMergeSha);
      M.record('factory_synced', { merge_sha: state.factoryMergeSha ?? null, local_head: s.head, ok: s.ok, reason: s.reason ?? null }, { issue: n });
      if (!s.ok) {
        M.saveIssueState(n, state);
        return this.escalate(n, state, 'merge', `**Factory merged but not active.** ${this.factory.repo} has the change, but the running factory couldn't fast-forward to it: ${s.reason}. ` +
          `Bring the factory checkout up to date by hand (\`git -C <factory> pull --ff-only\`), restart the dispatcher, then approve to finish.`, owners(cfg));
      }
      state.factorySynced = true; M.saveIssueState(n, state);
      factoryNote = `\n\nThe factory change is merged into ${this.factory.repo}, and the running factory is now at ${s.head.slice(0, 7)}. The dispatcher restarts itself once running agents finish, so the change takes effect.`;
      this.restartSoon('factory updated to ' + s.head.slice(0, 7));
    }
    await T.comment(repo, n, `### ✅ Merged ${this.prList(state)} (risk: ${state.risk ?? 'n/a'})${factoryNote}`);
    await R.dropWorktrees(n, this.touched(state));
    // Only product repos are released; a factory-only change is finished once merged.
    await this.move(issue, 'merge', this.deployable(state).length ? 'release' : 'done', state);
  }

  /** The running factory's commit, for briefs (feedback 874e9459). Read-only; cached briefly. */
  factoryHead() {
    if (this.headCache && Date.now() - this.headCache.at < 60e3) return this.headCache.sha;
    let sha = 'unknown';
    try { sha = execFileSync('git', ['-C', HOME, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
    this.headCache = { sha, at: Date.now() };
    return sha;
  }

  /**
   * Fast-forward the running factory's checkout to a merged factory change. Fails closed: local changes, a diverged
   * history or a merge that isn't a fast-forward leave it untouched. Returns { ok, head, reason }.
   */
  async syncFactory(sha, dir = HOME) {
    const g = (args) => R.git(args, dir);
    try {
      const dirty = await g(['status', '--porcelain', '--untracked-files=no']);
      if (dirty) return { ok: false, head: await g(['rev-parse', 'HEAD']), reason: `the factory checkout has local changes:\n${dirty.split('\n').slice(0, 10).join('\n')}` };
      await g(['fetch', '-q', 'origin']);
      await g(['merge', '--ff-only', '-q', sha || `origin/${this.factory.default_branch}`]);
      const head = await g(['rev-parse', 'HEAD']);
      if (sha && !(await g(['merge-base', '--is-ancestor', sha, 'HEAD']).then(() => true, () => false))) return { ok: false, head, reason: `HEAD ${head.slice(0, 7)} doesn't contain ${sha.slice(0, 7)}` };
      return { ok: true, head };
    } catch (e) { return { ok: false, head: await g(['rev-parse', 'HEAD']).catch(() => ''), reason: e.message.split('\n')[0] }; }
  }

  /** Restart this dispatcher once running agents finish, so updated factory code loads. A detached waiter starts the new one. */
  restartSoon(why) {
    if (this.restarting || process.argv[2] !== 'run') return; // only the long-running dispatcher restarts itself
    this.restarting = true;
    console.log(`restart: ${why}; restarting once running agents finish`);
    spawn('/bin/sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; exec "$2" run', 'sh', String(process.pid), p('bin/sf')],
      { cwd: HOME, detached: true, stdio: 'ignore' }).unref();
    process.kill(process.pid, 'SIGTERM'); // the graceful drain in sf run: start nothing new, let running agents finish, then exit
  }

  profile(env) { const ro = this.cfg.aws?.readonly_profile ?? ''; return typeof ro === 'string' ? ro : ro[env] ?? ''; }
  // ── people and vendors ──────────────────────────────────────────────────
  /** A person holds this stage's role: assign it to them and wait. Their comments become the stage artifact. */
  async toPerson(issue, stage, role, login, state) {
    const st = this.cfg.pipeline[stage];
    state.personStage = stage;
    await this.escalate(issue.number, state, st.next[0], `You hold the **${role}** role, so \`${stage}\` is yours.\n\n**Goal:** ${st.goal}\n\n` +
      `${state.lastHandoff ? `**Handoff from ${state.lastHandoff.by}:** ${state.lastHandoff.text}\n\n` : ''}` +
      `Post your work as comments, then add \`${T.L.approved}\` to move to \`${st.next[0]}\`. To route elsewhere, swap the \`sf/${stage}\` label for another stage first.`, [login]);
  }

  /** Approval by a role: an agent reviews, or the person holding the role is asked. Returns 'waiting' | { approved, route_to }. */
  async approval(issue, stage, role, next, artifact, state) { // role may be replaced for independence
    const n = issue.number;
    // Independence: an agent role that designed or built this change does not approve it. The chief of staff steps in.
    const authored = (state.history ?? []).some((h) => h.by === role && ['tech-grooming', 'build', stage === 'merge' ? 'review' : stage].includes(h.stage));
    if (authored && !holderOf(this.cfg, role)) role = 'chief-of-staff';
    const person = holderOf(this.cfg, role);
    const what = stage === 'merge' ? `merging ${this.prList(state)} (risk ${state.risk})` : `\`${artifact}\` (${stage}) before \`${next}\``;
    if (person) {
      await this.escalate(n, state, next, `**Approval (${role})**: you hold this role. Review ${what}. Add \`${T.L.approved}\` to approve, or comment with the changes needed and move the label back.`, [person]);
      return 'waiting';
    }
    const back = stage === 'merge' ? ['build', 'tech-grooming'] : [stage, ...this.cfg.pipeline[stage].next.filter((s) => s !== next)];
    const res = await runAgent({ cfg: this.cfg, role, issue: n, label: `approve-${stage}`, cwd: HOME,
      schema: { type: 'object', properties: { approved: { type: 'boolean' }, route_to: { enum: back }, summary: { type: 'string' }, handoff: { type: 'string' },
        decisions: { type: 'array', items: { type: 'object' } } }, required: ['approved', 'summary', 'handoff'] },
      prompt: `${this.context(issue, stage, state, HOME, { reviewing: true })}\n\n# Approval\nYou are the approver (${role}) for ${what}. Hold it to your charter's bar. ` +
        `If you reject it, choose route_to (${back.join(', ')}) and give the exact changes in handoff.` +
        (stage === 'merge' ? ` Inspect the PRs with \`gh pr view\` / \`gh pr diff\` and the review and security artifacts.` : ''),
    });
    if (!res.ok && INFRA.test(String(res.error))) { M.record('infra_failure', { stage: `approve-${stage}`, error: String(res.error).slice(0, 300) }, { issue: n }); return 'waiting'; }
    if (!res.ok) { await this.escalate(n, state, next, `Approver ${role} failed: ${res.error}`); return 'waiting'; }
    const v = res.out;
    for (const d of v.decisions ?? []) if (d.title && d.decision) M.decide({ rationale: '', ...d }, { actor: role, issue: n });
    const route_to = v.route_to ?? back[0];
    if (!v.approved) {
      state.loops += 1; state.lastHandoff = { from: `approval:${stage}`, by: role, text: v.handoff };
      this.coe({ issue: n, kind: 'approval_rejected', from: stage, to: route_to, by: role, reason: `${v.summary}\n\n${v.handoff}` });
    }
    M.saveIssueState(n, state);
    M.record('approval', { stage, independent: true, approved: v.approved, to: v.approved ? next : route_to, summary: v.summary, cost_usd: res.cost }, { actor: role, issue: n });
    await T.comment(this.repo, n, `### ${v.approved ? '✅' : '↩️'} ${role} ${v.approved ? 'approved' : `sent back to \`${route_to}\``} · ${stage}\n${v.summary}${v.approved ? '' : `\n\n**Changes needed:** ${v.handoff}`}`);
    return { approved: v.approved, route_to };
  }

  /** File a vendor request: a separate issue assigned to the vendor(s). Blocking requests pause the original issue. */
  async vendorRequest(issue, stage, role, req, state, blocking) {
    const n = issue.number, to = vendors(this.cfg);
    const { n: m, duplicate } = await T.fileOnce(this.repo, { title: `[vendor] ${req.title}`, labels: ['sf-vendor-request'], body:
      `**Requested by:** ${role} for #${n} (${stage})${blocking ? ' · **blocking**' : ''}\n\n## What\n${req.what}\n\n## Why\n${req.why}\n\n## How to provide it\n${req.how_to_provide}\n\n` +
      `> ⚠️ Never paste secrets in this issue. Put them where it says above, then reply with *where* you put them (the name, not the value), and close this issue.` });
    if (!duplicate) await T.assign(this.repo, m, to).catch(() => {});
    M.record('vendor_request', { request: m, title: req.title, blocking, to, duplicate }, { actor: role, issue: n });
    if (blocking) {
      state.vendor = { issue: m, stage, since: now().toISOString() };
      M.saveIssueState(n, state);
      await T.editLabels(this.repo, n, { add: ['sf-waiting-vendor'] });
    }
    await T.comment(this.repo, n, `### 📦 Vendor request #${m}${blocking ? ': paused until it is fulfilled' : ' (non-blocking)'}\n${req.title}`);
  }

  async checkVendor(issue) {
    const n = issue.number, state = M.issueState(n);
    if (!state.vendor) return T.editLabels(this.repo, n, { remove: ['sf-waiting-vendor'] });
    const req = await T.viewIssue(this.repo, state.vendor.issue);
    if (req.state !== 'CLOSED') return;
    const said = req.comments.filter((c) => !c.body.includes(T.MARK)).map((c) => c.body).join('\n\n') || '(closed without a comment)';
    M.writeDoc(`memory/knowledge/vendor/${state.vendor.issue}.md`, `# ${req.title}\nFor #${n} (${state.vendor.stage}), fulfilled ${now().toISOString()}\n\n${said}\n`);
    M.record('vendor_fulfilled', { request: state.vendor.issue }, { issue: n });
    state.lastHandoff = { from: 'vendor', by: 'vendor', text: `Vendor request #${state.vendor.issue} fulfilled:\n${said}` };
    state.vendor = null;
    M.saveIssueState(n, state);
    await T.editLabels(this.repo, n, { remove: ['sf-waiting-vendor'] });
  }

  // ── freezes, verified releases, rollback, dependency scans ──────────────
  /** Active freeze from memory/knowledge/freezes.md lines like `2026-12-20 → 2027-01-02: holidays`. */
  activeFreeze() {
    const f = p('memory/knowledge/freezes.md');
    if (!existsSync(f)) return null;
    const today = now().toISOString().slice(0, 10);
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/(\d{4}-\d{2}-\d{2})\s*(?:→|->|to)\s*(\d{4}-\d{2}-\d{2})\s*:?\s*(.*)/);
      if (m && m[1] <= today && today <= m[2]) return `${m[1]}→${m[2]} ${m[3]}`.trim();
    }
    return null;
  }

  envRoot(r, env) { return `${process.env.SF_ENV_ROOT ?? `${process.env.HOME}/factory-envs`}/${r.name}/${env}`; }

  markVerified(r, env, n) {
    if (!r.deploy_command || !env) return;
    const root = this.envRoot(r, env);
    try {
      const sha = readFileSync(`${root}/VERSION`, 'utf8').trim();
      writeFileSync(`${root}/VERIFIED`, sha + '\n');
      M.record('verified', { repo: r.name, env, sha, verified_at: now().toISOString() }, { actor: 'sre', issue: n });
    } catch { /* not deployed locally */ }
  }

  async rollback(r, env, n) {
    if (!r.deploy_command || !env) return;
    const cmd = `${r.deploy_command.replaceAll('{name}', r.name).replaceAll('{env}', env).replaceAll('{port}', String(r.ports?.[env] ?? ''))} --rollback`;
    let out;
    try { out = (await sh('/bin/bash', ['-c', cmd], { cwd: HOME, env: { ...process.env, PATH: `${p('deploy')}:${process.env.PATH}` }, timeout: 120e3 })).stdout; }
    catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
    M.record('rollback', { repo: r.name, env, log: out.slice(-1500) }, { actor: 'sre', issue: n });
    await T.comment(this.repo, n, `### ↩️ Rolled back ${r.name} on \`${env}\` to its last verified release\n\`\`\`\n${out.slice(-1200)}\n\`\`\``);
  }

  /** Daily dependency and filesystem scan of each repo's default branch. Findings become incidents. */
  async scan() {
    for (const r of this.repos) {
      const base = await R.ensureBase(r);
      const found = [];
      try {
        const { stdout } = await sh('npm', ['audit', '--audit-level=moderate', '--json'], { cwd: base, maxBuffer: 32 << 20 }).catch((e) => e);
        const meta = JSON.parse(stdout || '{}').metadata?.vulnerabilities ?? {};
        const bad = ['moderate', 'high', 'critical'].filter((k) => meta[k]).map((k) => `${meta[k]} ${k}`);
        if (bad.length) found.push(`npm audit: ${bad.join(', ')}`);
      } catch { /* no package.json */ }
      try {
        const { stdout } = await sh('trivy', ['fs', '--quiet', '--format', 'json', '--severity', 'MEDIUM,HIGH,CRITICAL', '--skip-dirs', 'node_modules', base], { maxBuffer: 64 << 20, timeout: 600e3 });
        const ids = (JSON.parse(stdout).Results ?? []).flatMap((x) => (x.Vulnerabilities ?? []).map((v) => `${v.VulnerabilityID} ${v.Severity} ${v.PkgName}`));
        if (ids.length) found.push(`trivy: ${ids.slice(0, 20).join('; ')}`);
      } catch (e) { if (!/ENOENT/.test(e.message)) found.push(`trivy failed: ${e.message.slice(0, 200)}`); }
      M.record('scan', { repo: r.name, findings: found }, { actor: 'security' });
      if (found.length) await this.fileIncident({ title: `Dependency vulnerabilities in ${r.name}`, severity: 'P1', component: r.name,
        fingerprint: `deps-${r.name}-${found.join('|').replace(/[^A-Za-z0-9|-]/g, '').slice(0, 80)}`, evidence: found.join('\n') }, null);
    }
  }

  /** Deploy one repo to one environment: a GitHub Actions workflow (cloud) or a local command (this machine). */
  async deploy(r, env) {
    if (!r.deploy_command) { // dispatching only queues the run; the deploy has "exited 0" when the run concludes success
      const since = now();
      try { await T.runWorkflow(r.repo, r.deploy_workflow, r.default_branch, { environment: env }); }
      catch (e) { return { ok: false, log: `could not dispatch ${r.deploy_workflow} (${env}): ${e.message}` }; }
      const w = await T.waitWorkflow(r.repo, r.deploy_workflow, since);
      return { ok: w.ok, log: `${r.deploy_workflow} (${env}): ${w.conclusion}${w.url ? ` ${w.url}` : ''}` };
    }
    const base = await R.ensureBase(r); // fresh checkout of the default branch
    const cmd = r.deploy_command.replaceAll('{name}', r.name).replaceAll('{env}', env).replaceAll('{port}', String(r.ports?.[env] ?? ''));
    const env_ = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AWS_')));
    try {
      const { stdout, stderr } = await sh('/bin/bash', ['-c', cmd], { cwd: base, env: { ...env_, SF_HOME: HOME, PATH: `${p('deploy')}:${process.env.PATH}` }, timeout: 15 * 60e3, maxBuffer: 32 << 20 });
      return { ok: true, log: stdout + stderr };
    } catch (e) { return { ok: false, log: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}` }; }
  }

  /**
   * The product owner decides a requested cut (owner requests #104, #105): close the issue as not planned, or keep it going
   * to `keepTo`. Returns 'rejected' | keepTo | 'waiting'. A person holding the role gets it as an approval instead.
   */
  async cutDecision(issue, stage, state, why, keepTo) {
    const n = issue.number, person = holderOf(this.cfg, 'product-owner');
    if (person) {
      await this.escalate(n, state, 'rejected', `**Cut requested at \`${stage}\`.** ${why}\n\nApprove to close #${n} as not planned. To keep it, reply saying so and remove the label; it continues to \`${keepTo}\`.`, [person]);
      return 'waiting';
    }
    const res = await runAgent({ cfg: this.cfg, role: 'product-owner', issue: n, label: `cut-${stage}`, cwd: HOME,
      schema: { type: 'object', properties: { cut: { type: 'boolean' }, summary: { type: 'string', description: 'The decision and why, for the issue thread.' },
        decisions: { type: 'array', items: DECISION } }, required: ['cut', 'summary'] },
      prompt: `${this.context(issue, stage, state, HOME, { kb: 12, reviewing: true })}\n\n# Cut decision\n${why}\n\nYou own scope. Decide now: ` +
        `**cut** (#${n} closes as not planned, and you tell the client through the account executive if it was in their plan) or **keep** ` +
        `(it continues to \`${keepTo}\`). Weigh the release goal, the client's approved plan and spend. Record the decision.` });
    if (!res.ok) {
      if (!INFRA.test(String(res.error))) await this.escalate(n, state, null, `The product owner couldn't decide a requested cut: ${String(res.error).slice(0, 300)}`);
      return 'waiting';
    }
    for (const d of res.out.decisions ?? []) if (d.title && d.decision) M.decide({ rationale: '', ...d }, { actor: 'product-owner', issue: n });
    M.record('cut_decided', { stage, cut: res.out.cut, summary: res.out.summary.slice(0, 500), cost_usd: res.cost }, { actor: 'product-owner', issue: n });
    await T.comment(this.repo, n, `### ${res.out.cut ? '✂️ Cut' : '▶️ Kept'} · product-owner at \`${stage}\`\n${res.out.summary}`);
    return res.out.cut ? 'rejected' : keepTo;
  }

  /** How a closed issue ended: { reason: COMPLETED | NOT_PLANNED | …, replacement } (from "superseded by #M" / "duplicate of #M"). Cached. */
  async closedReason(m) {
    if (this.closedCache?.has(m)) return this.closedCache.get(m);
    const i = await T.gh(['issue', 'view', String(m), '-R', this.repo, '--json', 'stateReason,comments']).then(JSON.parse).catch(() => null);
    if (!i) return { reason: 'COMPLETED' }; // can't tell: treat as done, as before
    const said = (i.comments ?? []).slice(-3).map((c) => c.body).join('\n');
    const r = { reason: i.stateReason || 'COMPLETED', replacement: Number(said.match(/(?:superseded by|duplicate of)\s+#(\d+)/i)?.[1]) || null };
    (this.closedCache ??= new Map()).set(m, r);
    return r;
  }

  /** A failed gate: the product owner cuts the issue or keeps it; kept issues aren't asked again for the same gate. */
  async gateCut(issue, stage, state, reason) {
    const n = issue.number;
    const d = await this.cutDecision(issue, stage, state, `This issue's gate has failed: ${reason}. No work starts while it fails.`, stage);
    if (d === 'waiting') return;
    if (d === 'rejected') {
      M.record('transition', { stage, to: 'rejected', outcome: 'reject', summary: `gate failed: ${reason}`, kind: 'gate_cut' }, { actor: 'product-owner', issue: n });
      return this.move(issue, stage, 'rejected', state);
    }
    state.gateKept = { at: now().toISOString(), gates: state.gates, reason }; state.gateFailed = null;
    M.saveIssueState(n, state);
  }

  /**
   * Does a deploy program exist where deploy() will look (owner request #133)? A path is checked in the repo's checkout;
   * a bare name in the factory's deploy/ folder, then on PATH. The name is passed as an argument, never into the shell text.
   */
  resolvesProgram(prog, r) {
    if (!prog) return false;
    if (prog.includes('/')) return existsSync(path.isAbsolute(prog) ? prog : path.join(R.baseDir(r), prog));
    if (existsSync(p('deploy', prog))) return true;
    try { execFileSync('/bin/sh', ['-c', 'command -v "$1" >/dev/null', 'sh', prog], { stdio: 'ignore', env: { ...process.env, PATH: `${p('deploy')}:${process.env.PATH}` } }); return true; } catch { return false; }
  }

  repoByName(name) { return this.repos.find((r) => r.name === name) ?? (this.factory?.name === name ? this.factory : undefined); }
  prList(state) { return Object.entries(state.prs ?? {}).map(([name, pr]) => `${this.repoByName(name).repo}#${pr}`).join(', '); }
  // An environment passed with no_runtime_surface counts as done for promotion, without ever being marked deployed.
  nextEnv(state) { return this.envs.find((e) => !state.deployed?.[e] && !state.noRuntime?.[e]) ?? this.envs.at(-1); }

  /** Push each touched repo that has commits and open/update its PR. */
  async publish(issue, state, v) {
    const n = issue.number;
    const design = existsSync(p('memory/specs', `issue-${n}`, 'tech-grooming.md')) ? readFileSync(p('memory/specs', `issue-${n}`, 'tech-grooming.md'), 'utf8').slice(0, 20000) : '';
    state.prs ??= {};
    for (const r of this.touched(state)) {
      const ahead = await R.commitsAhead(n, r);
      if (!ahead) continue;
      await R.push(n, r);
      const pr = await T.findPr(r.repo, R.branch(n));
      const partOf = `Part of ${this.repo}#${n}${this.touched(state).length > 1 ? ` · one of ${this.touched(state).length} coordinated PRs, merged in order: ${this.touched(state).map((x) => x.name).join(' → ')}` : ''}`;
      // The builder's own PR body is used verbatim (owner request #38); otherwise a summary plus the tech design.
      const body = v.pr_body ? `${partOf}\n\n${v.pr_body}` : `${partOf}\n\n## Summary\n${v.summary}\n\n<details><summary>Tech design</summary>\n\n${design}\n</details>\n\n_Built by the software factory._`;
      const draft = !!v.pr_draft;
      if (pr?.state === 'OPEN') {
        state.prs[r.name] = pr.number;
        if (v.pr_body) await T.editPrBody(r.repo, pr.number, body);
        await T.setDraft(r.repo, pr.number, draft); // owner request #37: draft state follows the builder's verdict
      } else state.prs[r.name] = await T.createPr(r.repo, { head: R.branch(n), base: r.default_branch, title: `${issue.title} (${this.repo}#${n})`, body, draft });
      const head = await R.git(['rev-parse', 'HEAD'], `${R.issueDir(n)}/${r.name}`);
      state.heads = { ...state.heads, [r.name]: head };
      M.record('pr', { repo: r.name, pr: state.prs[r.name], commits: ahead, head_sha: head }, { issue: n });
    }
    // Commits in a worktree this issue doesn't own are never published (feedback 01406a6d): say exactly which, and how to declare it.
    const owned = new Set(this.touched(state).map((r) => r.name)), stray = [];
    for (const d of existsSync(R.issueDir(n)) ? readdirSync(R.issueDir(n)) : []) {
      if (owned.has(d) || !statSync(`${R.issueDir(n)}/${d}`).isDirectory()) continue;
      // Commits not on the repo's default branch, pushed or not (owner request #107): a pushed but undeclared branch is still stray.
      const dir = `${R.issueDir(n)}/${d}`;
      const base = (await R.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], dir).catch(() => '')) ||
        ((await R.git(['rev-parse', '--verify', '--quiet', 'origin/main'], dir).catch(() => '')) ? 'origin/main' : 'origin/master');
      const unpushed = Number(await R.git(['rev-list', '--count', `${base}..HEAD`], dir).catch(() => R.git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], dir).catch(() => '0')));
      if (unpushed) stray.push(`${d} (${unpushed} commit${unpushed > 1 ? 's' : ''})`);
    }
    if (stray.length) {
      v.question_for_human = `Commits in ${stray.join(', ')}, which this issue's tech design does not declare, so they were not published. ` +
        (stray.some((s) => s.startsWith(this.factory?.name ?? '\0')) ? 'For a change to the factory itself, tech-grooming must list factory_paths (merge then needs the owner\'s approval).' : 'Loop back to tech-grooming to add the repo, or move the work into a declared repo.');
      M.record('publish_refused', { stray }, { issue: n });
      return false;
    }
    if (!Object.keys(state.prs).length) { v.question_for_human = `The engineer reported done, but no declared repo (${[...owned].join(', ') || 'none'}) has commits on the branch.`; return false; }
    return true;
  }

  // ── context every stage agent gets ──────────────────────────────────────
  /**
   * The issue's PR checks: waits up to gates.ci_wait_minutes while any are pending, then reports
   * { status: pass | fail | none | timeout, table (markdown), failures: [{ repo, name, link, log }] }.
   */
  async ciGate(state, waitMinutes = this.cfg.gates?.ci_wait_minutes ?? 15) {
    const until = Date.now() + waitMinutes * 60e3;
    for (;;) {
      const rows = [];
      for (const [name, pr] of Object.entries(state.prs ?? {})) {
        const r = this.repoByName(name);
        for (const c of await T.prCheckList(r.repo, pr).catch(() => [])) rows.push({ repo: r.repo, name: c.name, bucket: c.bucket, link: c.link });
      }
      const table = rows.length ? `| Repo | Check | Result |\n|---|---|---|\n${rows.map((c) => `| ${c.repo} | ${c.name} | ${c.bucket} |`).join('\n')}` : '_No CI checks on the PR._';
      const failed = rows.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
      if (failed.length) {
        const failures = [];
        for (const c of failed) failures.push({ ...c, log: await T.failedLog(c.repo, c) });
        return { status: 'fail', table, failures };
      }
      if (!rows.some((c) => c.bucket === 'pending')) return { status: rows.length ? 'pass' : 'none', table, failures: [] };
      if (Date.now() > until) return { status: 'timeout', table, failures: [] };
      await new Promise((r) => setTimeout(r, 30e3));
    }
  }

  /** The artifact a verdict stands for: the file the agent wrote during the run when it is the fuller text, else artifact_markdown. */
  artifactOf(n, stage, res) {
    const own = p('memory/specs', `issue-${n}`, `${stage}.md`), md = res.out?.artifact_markdown ?? '';
    if (existsSync(own) && statSync(own).mtimeMs >= Date.now() - (res.ms ?? 0) - 2000) {
      const written = readFileSync(own, 'utf8');
      if (written.length > 2 * md.length) return written;
    }
    return md;
  }

  /** What a resumed agent needs: only what changed since its last run on this issue and stage. */
  delta(issue, stage, state, since) {
    const st = this.cfg.pipeline[stage];
    const people = (issue.comments ?? []).filter((c) => !c.body.includes(T.MARK) && c.createdAt > since)
      .map((c) => `- **${c.author?.login ?? 'person'}**: ${c.body.trim().slice(0, 1500)}`);
    const h = handoffFor(state.lastHandoff, stage, this.cfg);
    return [
      `# Back to you: #${issue.number} \`${stage}\``,
      `The work came back to you, so this continues your earlier session. Everything you read then still applies; don't re-read it.`,
      h ? `\n## ${h.title}\n${h.text}` : '',
      people.length ? `\n## New comments from people (authoritative)\n${people.join('\n')}` : '',
      `\nFactory state now: loops=${state.loops} risk=${state.risk ?? 'unset'} prs=${this.prList(state) || 'none'}`,
      `\nRevise your ${stage} work for exactly these changes, then hand in a complete verdict with the full artifact. Choose next_stage from: ${st.next.map((s) => `\`${s}\``).join(', ')}.`,
    ].filter(Boolean).join('\n');
  }

  /**
   * The brief for a stage run. It carries what agents used to spend their first steps reading (team digest, product brief,
   * current answers, earlier artifacts, people's comments, the issue's history), because every extra step re-reads the whole
   * conversation. Falls back to pointers when a digest doesn't exist yet.
   */
  context(issue, stage, state, cwd, { kb = null, reviewing = false } = {}) {
    const { cfg, repo } = this;
    const st = cfg.pipeline[stage];
    const role = st.role ?? st.council?.chair;
    const team = teamOf(cfg, role);
    const n = issue.number;
    const dossier = M.issueDossier(n);
    const opts = st.next.map((s) => `- \`${s}\`: ${cfg.pipeline[s]?.goal ?? (s === 'done' ? 'finished, close the issue' : 'close as not planned')}`).join('\n');
    const read = (f) => { try { return readFileSync(p(f), 'utf8'); } catch { return ''; } };
    const clip = (s, kb, file) => (s.length > kb * 1024 ? `${s.slice(0, kb * 1024)}\n\n…(truncated; the full file is ${p(file)})` : s);
    const digest = read(`org/digests/${team}.md`), brief = read('memory/product/brief.md');
    const answers = read('memory/product/answers.current.md') || read('memory/product/answers.md');

    // Earlier artifacts, most relevant first, inline up to brief_kb: this stage's own last version (a loop-back), then upstream.
    const UPSTREAM = { analysis: ['triage'], design: ['analysis'], 'feature-grooming': ['design', 'analysis'], 'tech-grooming': ['feature-grooming', 'design'],
      build: ['tech-grooming', 'feature-grooming'], review: ['tech-grooming', 'feature-grooming', 'build'], security: ['tech-grooming', 'review', 'build'],
      release: ['security', 'review'], verify: ['release', 'verify'], incident: ['verify'] };
    let room = (kb ?? cfg.economy?.brief_kb ?? 40) * 1024;
    const inline = [];
    for (const s of [stage, ...(UPSTREAM[stage] ?? [])]) {
      const f = `memory/specs/issue-${n}/${s}.md`, body = read(f);
      if (!body || room < 2048) continue;
      const text = clip(body, Math.min(s === stage ? 24 : 12, room / 1024), f);
      room -= text.length;
      inline.push(`\n### ${s !== stage ? s : reviewing ? `The ${s} artifact under review` : `Your last ${s} (revise it; don't start over)`} · ${p(f)}\n${text}`);
    }
    const people = (issue.comments ?? []).filter((c) => !c.body.includes(T.MARK)).slice(-8)
      .map((c) => `- **${c.author?.login ?? 'person'}** (${String(c.createdAt).slice(0, 16).replace('T', ' ')}): ${c.body.trim().slice(0, 1500)}`);
    const history = dossier.events.filter((e) => ['transition', 'check_failed', 'escalated', 'human_approved', 'vendor_request', 'loop_back', 'council_closed'].includes(e.type))
      .slice(-12).map((e) => `- ${e.ts.slice(0, 16).replace('T', ' ')} ${e.type}${e.stage ? ` ${e.stage}` : ''}${e.to ? ` → ${e.to}` : ''} (${e.actor})${e.summary ? `: ${e.summary.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
    const lint = reviewing ? ''
      : (st.checks ?? []).includes('spec_lint')
        ? `\n## Before you hand in\nWrite your draft to ${p('memory/specs', `issue-${n}`, `${stage}.md`)} and run \`sf lint spec ${n}\`. Fix every item it reports, then hand in. A spec that fails the lint comes straight back to you.`
        : (st.checks ?? []).includes('ac_evidence')
          ? `\n## Before you hand in\nYour artifact must have a full \`## AC → evidence\` table (| AC | Test | Status |) with a row for every AC in the spec, restated in full on every revision. ` +
            `Status is pass, or post-deploy (SRE) for checks that can only run after deploy. A partial, missing or failing AC means you don't advance: finish it, or loop back to tech-grooming. ` +
            `Write the artifact to ${p('memory/specs', `issue-${n}`, `${stage}.md`)} and run \`sf lint build ${n}\` before handing in (owner request #69).`
          : (st.checks ?? []).includes('design_lint')
            ? `\n## Before you hand in\nYour design needs a "Repo invariants honoured" section, and on a revision a "Delta impact" section (what changed and what it affects). ` +
              `Write numeric limits in §5 with their arithmetic (=, ≤). Write the design to ${p('memory/specs', `issue-${n}`, `${stage}.md`)} and run \`sf lint design ${n}\` before handing in (owner request #100).`
            : '';
    return [
      `# Issue #${n}: ${issue.title}`, `Tracker: ${repo} · ${issue.url ?? ''}`, `Now: ${now().toString()}`, '',
      `## Your stage: \`${stage}\``, st.goal, '',
      `## Issue body`, issue.body || '_(empty)_', '',
      `## Factory state`,
      `priority=${T.priorityOf(issue)} risk=${state.risk ?? 'unset'} loops=${state.loops} repos=${this.touched(state).map((r) => r.name).join(',')} prs=${this.prList(state) || 'none'} deployed=${JSON.stringify(state.deployed ?? {})}`,
      `factory: running at ${this.factoryHead()} (check a merged factory change with \`sf contains <sha>\`)`,
      this.spend ? `spend: today $${this.spend.today_usd} of $${this.spend.daily_budget_usd} daily budget${this.spend.release ? ` · Release ${this.spend.release} so far $${this.spend.release_usd}` : ''} (as of ${this.spend.at.slice(11, 16)} UTC; also in ${p('memory/state/spend.json')})` : '',
      ...(() => { const A = this.answersLatest ?? []; return A.length ? [`\n## Owner answers (newest first; these override answers.md and any earlier assumption)`,
        ...A.map((a) => `- **#${a.request}** (${a.ts.slice(0, 16).replace('T', ' ')} UTC): ${a.text.replace(/\s+/g, ' ').slice(0, 300)}`)] : []; })(),
      (({ title, text } = handoffFor(state.lastHandoff, stage, cfg) ?? {}) => title ? `\n## ${title}\n${text}` : '')(),
      people.length ? `\n## What people said on the issue (authoritative)\n${people.join('\n')}` : '',
      issue.ci ? `\n## CI on the PR right now (${issue.ci.status === 'timeout' ? 'some checks still running' : issue.ci.status})\n${issue.ci.table}\n` +
        `You can't advance while any check is red: the dispatcher sends red CI back to build automatically.` +
        (issue.ci.failures.length ? `\n${issue.ci.failures.map((f) => `\n**${f.repo}: ${f.name}** (failing log tail)\n\`\`\`\n${(f.log || '').slice(-2000)}\n\`\`\``).join('')}` : '') : '',
      history.length ? `\n## History of this issue\n${history.join('\n')}` : '',
      (() => { // other open issues editing the same factory files (owner request #115)
        if (!state.factory?.paths?.length || !['tech-grooming', 'build', 'review'].includes(stage)) return '';
        let index = {}; try { index = JSON.parse(read('memory/state/claims.json') || '{}'); } catch {}
        const c = clashes(n, state.factory.paths, index);
        return c.length ? `\n## ⚠️ Other open issues edit the same files\n${c.map((x) => `- #${x.issue}: ${x.path} (yours: ${x.mine})`).join('\n')}\nCoordinate: build on theirs (delta_of), wait for it, or mark a duplicate. Don't overwrite their work.` : '';
      })(),
      digest ? `\n## How your team works (digest of the operating model and the ${team} charter)\n${digest}` : '',
      // Each touched repo's invariants and conventions, verbatim, where specs and designs are written (owner request #135).
      ['analysis', 'feature-grooming', 'tech-grooming'].includes(stage) ? this.deployable(state).map((r) => {
        const doc = read(`memory/product/repos/${r.name}.md`);
        const parts = doc.split(/^(?=#{2,3}\s)/m).filter((s) => /^#{2,3}\s.*(invariant|convention)/i.test(s));
        return parts.length ? `\n## Repo invariants (authoritative): ${r.name}\nFrom ${p('memory/product/repos', `${r.name}.md`)}. A spec or design that breaks one of these is wrong unless an ADR changes it.\n${clip(parts.join('\n').trim(), 8, `memory/product/repos/${r.name}.md`)}` : '';
      }).join('') : '',
      brief ? `\n## The product (brief)\n${brief}` : '',
      answers ? `\n## Owner answers (current)\n${clip(answers, 8, 'memory/product/answers.current.md')}` : '',
      inline.length ? `\n## Earlier work on this issue\n${inline.join('\n')}` : '',
      `\n## More, only if this brief doesn't answer it`,
      `- Full documents: ${p('org/operating-model.md')}, ${p('org/charters', `${team}.md`)}, ${p('memory/product/overview.md')}, ${p('memory/product/answers.md')}`,
      ...this.repos.map((r) => `- ${p('memory/product/repos', `${r.name}.md`)}: ${r.name} (${r.repo})`),
      dossier.artifacts.length ? `- Every artifact (older versions too): ${dossier.artifacts.map((a) => p(a)).join(', ')}` : '',
      `- \`sf recall "<keywords>"\` for decisions and learnings from other issues.`,
      st.workspace ? `\n## Workspace (cwd: ${cwd})\nOne sub-folder per repo, each a git worktree on branch \`sf/issue-${n}\`:\n${this.touched(state).map((r) => `- \`${r.name}/\`: ${r.repo} (base \`origin/${r.default_branch}\`)`).join('\n')}\nOnly change repos the tech design names. If another repo must change, loop back to tech-grooming.` : '',
      stage === 'release' ? `\n## Go-live policy\n${cfg.release.policy}\nEnvironments in order: ${this.envs.join(' → ')}. Already deployed: ${JSON.stringify(state.deployed ?? {})}. The next one is **${this.nextEnv(state)}**.${Object.keys(state.noRuntime ?? {}).length ? ` Passed with no runtime surface: ${JSON.stringify(state.noRuntime)}.` : ''}\n` +
        `Deploy config for ${this.nextEnv(state)}:\n${this.deployable(state).map((r) => `- ${r.name}: deploy ${r.deploy_command ? `\`${r.deploy_command}\` (resolves: ${this.resolvesProgram(deployProgram(r.deploy_command), r) ? 'yes' : 'no'})` : r.deploy_workflow || '(none configured)'}, health ${r.health?.[this.nextEnv(state)] || '(none configured)'}`).join('\n')}\n` +
        `The dispatcher marks the environment deployed only if every repo's deploy exits 0 and its health URL answers 200; otherwise the release is held whatever you choose. ` +
        `If the change has nothing to run (no build, no server, no bundle change), set \`no_runtime_surface: true\` with a \`no_runtime_note\` saying why, and no deploy or probe runs.\nRecent deploys:\n${this.deployable(state).filter((r) => r.deploy_workflow).map((r) => `- \`gh run list -R ${r.repo} --workflow ${r.deploy_workflow} --limit 10\``).join('\n')}` : '',
      stage === 'verify' ? `\n## Validate ${state.lastEnv ?? 'the deploy'} (${state.deployed?.[state.lastEnv] ? `deployed ${state.deployed[state.lastEnv]}` : state.noRuntime?.[state.lastEnv] ? `not deployed: the release manager declared no runtime surface at ${state.noRuntime[state.lastEnv]}; confirm nothing needed to run` : 'deployed ?'})\n${this.profile(state.lastEnv) ? `You have read-only AWS access (profile \`${this.profile(state.lastEnv)}\`, region ${cfg.aws?.region}). Start with \`aws sts get-caller-identity --profile ${this.profile(state.lastEnv)}\`.` : 'This environment runs on the local machine. Use the health URLs and the deploy log.'}\n` +
        `Health URLs:\n${this.deployable(state).map((r) => `- ${r.name}: ${r.health?.[state.lastEnv] || '(none configured)'}`).join('\n')}\nSignals:\n${this.signals(state.lastEnv, this.deployable(state)).map((s) => `- \`${s}\``).join('\n')}\n` +
        `Environments: ${this.envs.join(' → ')}. If ${state.lastEnv} is healthy and it isn't the last environment, choose \`release\` to promote. If it is the last, choose \`done\`. A regression goes to \`build\`, and if users are impacted, say "rollback" in decisions.` : '',
      `\n## How to work`,
      `This brief already holds the digest, the product brief, the answers, the issue's comments and history, and the earlier artifacts. ` +
        `Don't re-read them or re-run \`gh issue view\` and \`sf memory issue\`. Spend your steps on the work itself; read the full documents only for a specific gap.`,
      lint,
      `\n## Choose next_stage from`, opts,
      `\nUse \`advance\` to move forward, \`loop_back\` to send work upstream (say exactly what must change in \`handoff\`), \`reject\` to cut the issue (it closes where \`rejected\` is one of your options; elsewhere the product owner decides the cut), \`wait\` with \`wait_for\` when the plan says this issue must wait for other issues (no council; it resumes by itself), and \`blocked\` only when a decision is needed.`,
      `Put the full stage artifact in \`artifact_markdown\`.`,
    ].join('\n');
  }

  signals(env = this.envs.at(-1), repos = this.repos) {
    const out = new Set();
    for (const r of repos) for (const s of this.cfg.observability?.signals ?? []) {
      if (s.includes('{deploy_workflow}') && !r.deploy_workflow) continue;
      if (s.includes('{health}') && !r.health?.[env]) continue;
      if (s.includes('{profile}') && !this.profile(env)) continue;
      out.add(s.replaceAll('{repo}', r.repo).replaceAll('{name}', r.name).replaceAll('{deploy_workflow}', r.deploy_workflow ?? '')
        .replaceAll('{env}', env).replaceAll('{region}', this.cfg.aws?.region ?? '').replaceAll('{profile}', this.profile(env))
        .replaceAll('{health}', r.health?.[env] ?? ''));
    }
    return [...out];
  }

  // ── observability → incidents → back into the pipeline ──────────────────
  async fileIncident(inc, source) {
    const open = await T.listIssues(this.repo, 'incident');
    const dupe = open.find((i) => i.body?.includes(`fingerprint: ${inc.fingerprint}`));
    if (dupe) { await T.comment(this.repo, dupe.number, `Seen again${source ? ` (from #${source})` : ''}:\n${inc.evidence}`); return dupe.number; }
    const n = await T.createIssue(this.repo, {
      title: `[incident] ${inc.title}`,
      body: `${inc.evidence}\n\n**Component:** ${inc.component ?? 'unknown'}\n${source ? `**Related:** #${source}\n` : ''}\n<!-- fingerprint: ${inc.fingerprint} -->\nfingerprint: ${inc.fingerprint}`,
      labels: [this.cfg.product.intake_label, 'incident', 'sf/incident', inc.severity],
    });
    M.record('incident_filed', { title: inc.title, severity: inc.severity, fingerprint: inc.fingerprint, from: source }, { actor: 'sre', issue: n });
    return n;
  }

  async observe() {
    const res = await runAgent({
      cfg: this.cfg, role: 'sre', label: 'observe',
      schema: { type: 'object', properties: { summary: { type: 'string' }, incidents: { type: 'array', items: INCIDENT() }, learnings: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'incidents'] },
      prompt: `# Observability sweep: ${this.cfg.product.name} (${this.envs.join(', ')})\nRead ${p('memory/product/overview.md')} for context. Run each signal command and analyse the output:\n${this.envs.flatMap((e) => this.signals(e)).filter((x, i, a) => a.indexOf(x) === i).map((s) => `- \`${s}\``).join('\n')}\n\n` +
        `Open incidents already filed (don't duplicate): \`gh issue list -R ${this.repo} --label incident\`.\n` +
        `Report only real, actionable problems. Give each one a stable fingerprint (e.g. workflow+job+error-class).\n` +
        `An environment that was never deployed (no ${process.env.HOME}/factory-envs/<repo>/<env>/VERSION) is "not deployed". That is expected before the first release and is never an incident. ` +
        `Problems with the factory itself (its config, signals, docs) are not product incidents. Put them in learnings.`,
    });
    if (!res.ok) return;
    for (const l of res.out.learnings ?? []) M.learn(l, { actor: 'sre' });
    for (const inc of res.out.incidents) await this.fileIncident(inc, null);
    M.record('observed', { summary: res.out.summary, incidents: res.out.incidents.length }, { actor: 'sre' });
  }

  async audit(days = 7) {
    const text = report({ days });
    const res = await runAgent({
      cfg: this.cfg, role: 'auditor', label: 'audit',
      schema: { type: 'object', properties: { report_markdown: { type: 'string' }, proposals_markdown: { type: 'string' },
        decisions: { type: 'array', items: { type: 'object' } }, learnings: { type: 'array', items: { type: 'string' } } },
        required: ['report_markdown', 'proposals_markdown'] },
      prompt: `# Weekly factory audit\n## Metrics (last ${days} days)\n${text}\n\nThe ledger is ${p('memory/ledger')}, ADRs are ${p('memory/decisions')}, and artifacts are ${p('memory/specs')}. ` +
        `Earlier audits are in ${p('memory/reports')}. Analyse, review, and propose changes.`,
    });
    if (!res.ok) return console.error(res.error);
    const day = now().toISOString().slice(0, 10);
    M.writeDoc(`memory/reports/audit-${day}.md`, res.out.report_markdown);
    M.writeDoc(`org/proposals/audit-${day}.md`, `# Proposals from audit ${day}\n\n${res.out.proposals_markdown}`);
    for (const d of res.out.decisions ?? []) if (d.title && d.decision) M.decide({ rationale: '', ...d }, { actor: 'auditor', scope: 'org' });
    for (const l of res.out.learnings ?? []) M.learn(l, { actor: 'auditor' });
    M.record('audited', { days, cost_usd: res.cost });
    console.log(`Audit written: memory/reports/audit-${day}.md, org/proposals/audit-${day}.md`);
  }

  // ── memory is versioned: every tick commits what changed ────────────────
  // This install's data (memory/, org/, library/) has its own history in .memory.git, separate from the factory's code repo,
  // which ignores those folders. -f because the code repo's .gitignore lists them.
  async syncMemory() {
    const data = ['--git-dir', p('.memory.git'), '--work-tree', HOME];
    try {
      if (!existsSync(p('.memory.git'))) await R.git([...data, 'init', '-q'], HOME);
      await R.git([...data, 'add', '-f', '-A', '--', 'memory', 'org', 'library', ':!memory/runs'], HOME);
      if (!(await R.git([...data, 'diff', '--cached', '--name-only'], HOME))) return;
      await R.git([...data, '-c', 'user.name=factory', '-c', 'user.email=factory@localhost', 'commit', '-q', '-m', `memory: ${now().toISOString()}`], HOME);
    } catch { /* memory history is best-effort; the files on disk are the source of truth */ }
  }
}
