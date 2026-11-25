import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME, p, loadConfig, headcount, STAGE_ORDER, teamOf, holderOf, vendors, owners } from './config.mjs';
import * as T from './tracker.mjs';
import * as M from './memory.mjs';
import { runAgent, verdictSchema } from './worker.mjs';
import { council } from './council.mjs';
import { report } from './report.mjs';
import * as R from './repos.mjs';
import { recordAnswer } from './discovery.mjs';
import { decideDeploy, probeHealth } from './deploy-gate.mjs';

const now = () => new Date();
const sh = promisify(execFile);
// Faults in the harness or the account, not the agent's work: retried, never escalated, never a COE.
const INFRA = /agents file changed|ENOENT|EAGAIN|ECONNRESET|overloaded|rate.?limit|session limit|usage limit|spawn |^exit (137|143)$|SIGTERM|SIGKILL|connection reset|i\/o timeout|timed out|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|api\.github\.com|HTTP 50[0-9]|502 Bad Gateway|503 Service/i; // incl. runs killed by a stop or restart, and network/GitHub outages

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
  }

  // Extra verdict fields some stages must return.
  extra(stage) {
    const names = this.repos.map((r) => r.name);
    const pools = [...new Set((this.cfg.pipeline[stage]?.next ?? []).flatMap((s) => this.cfg.pipeline[s]?.pool ?? []))];
    const assignee = pools.length ? { next_assignee: { enum: pools, description: `Optional: route the next stage to a specialist. Pools: ${(this.cfg.pipeline[stage]?.next ?? []).filter((s) => this.cfg.pipeline[s]?.pool).map((s) => `${s} → ${this.cfg.pipeline[s].pool.join(', ')}`).join('; ')}` } } : {};
    return { ...assignee, ...({
      triage: { priority: { enum: ['P0', 'P1', 'P2', 'P3'] }, type: { enum: ['feature', 'bug', 'incident', 'tech-debt', 'chore'] } },
      build: {
        pr_draft: { type: 'boolean', description: 'true while anything is provisional or pending (e.g. a mirrored ADR awaiting security). The PR stays a draft and cannot merge.' },
        pr_body: { type: 'string', description: 'The PR description, used verbatim (prefixed with "Part of #n"). Put lines acceptance criteria check for here.' },
        no_code_change: { type: 'boolean', description: 'true only when the tech design explicitly calls for no product-repo change (e.g. a factory, memory or doc-only change). The issue then goes through review and security without a PR and closes at merge.' },
      },
      'tech-grooming': { risk_tier: { enum: ['low', 'medium', 'high'] }, repos: { type: 'array', items: { enum: names }, description: 'Every repo this change touches.' } },
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
  touched(state) { return state.repos?.length ? this.repos.filter((r) => state.repos.includes(r.name)) : this.repos; }

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
      if (this.running.has(n)) continue;
      const labels = T.labelsOf(issue);
      if (labels.includes(T.L.working)) await T.editLabels(this.repo, n, { remove: [T.L.working] }); // stale lock after a crash
      if (labels.includes('sf-waiting-vendor')) { await this.guard(n, () => this.checkVendor(issue)); continue; }
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
      if (state.holdUntil && new Date(state.holdUntil) > now()) continue;
      if (state.waitFor?.length) { // parked on planned dependencies: free until each has merged or closed
        const still = state.waitFor.filter((m) => open.has(m) && !Object.keys(M.issueState(m).merged ?? {}).length);
        if (still.length) continue;
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
        this.running.delete(n);
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
    let next = v.outcome === 'blocked' || v.outcome === 'wait' ? 'blocked' : v.next_stage; // `wait` without issues to wait for is a block
    // Council stages route rather than loop, and `forward` targets (verify → release = promote) are progress.
    const isLoop = !st.council && !(st.forward ?? []).includes(next) && order.includes(next) && order.indexOf(next) < order.indexOf(stage);

    // Repeated loop-backs: the agents involved discuss the route instead of one agent deciding alone.
    if (isLoop && !fromCouncil && state.loops + 1 >= (cfg.loops.council_after ?? 2)) {
      const target = cfg.pipeline[next];
      const members = [...new Set([role, target.role ?? target.council?.chair, 'product-manager'].filter(Boolean))];
      const c = await council({
        cfg, name: `issue-${n}/loop-${stage}-to-${next}-${Date.now()}`, topic: `#${n} keeps looping (${stage} → ${next}). What is the right route?`,
        context: `${this.context(issue, stage, state, cwd, { kb: 12, reviewing: true })}\n\n## The ${role}'s verdict that triggered this council\n${v.summary}\n\n${v.handoff}\n\nThis issue has looped ${state.loops} time(s): ${JSON.stringify(state.history.slice(-6))}`,
        chair: state.loops + 1 > cfg.loops.max_loops ? 'chief-of-staff' : 'architect', members, rounds: cfg.economy?.council_rounds ?? 2, nextOptions: st.next, issue: n, cwd, extraSchema: this.extra(stage),
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
    if (isLoop) {
      state.loops += 1;
      this.coe({ issue: n, kind: 'loop_back', from: stage, to: next, by: role, reason: `${v.summary}\n\nHandoff: ${v.handoff}` });
    }
    state.history.push({ ts: now().toISOString(), stage, to: next, outcome: v.outcome, by: role });
    state.lastHandoff = { from: stage, by: role, text: fromCouncil && res.thread ? `${v.handoff}\n\nThe council's discussion and decision: ${p(res.thread)}` : v.handoff };
    if (v.risk_tier) state.risk = v.risk_tier;
    if (v.next_assignee && (cfg.pipeline[next]?.pool ?? []).includes(v.next_assignee)) state.assign = { ...state.assign, [next]: v.next_assignee };
    if (v.repos?.length) state.repos = v.repos;
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
        if (state.loops > cfg.loops.max_loops) return this.escalate(n, state, 'build', 'CI keeps failing.');
        return this.move(issue, stage, 'build', state);
      }
      if (ci.status === 'timeout') M.record('ci_wait_timeout', { stage, table: ci.table.slice(0, 1000) }, { issue: n }); // merge still enforces green
    }
    if (stage === 'release' && next !== 'blocked') {
      // Deployed means the deploy step exited 0 AND the health URL answered 200 (feedback 2fa9b900: a repo with no deploy
      // config used to fall out of the loop, so staging was marked deployed and the issue moved to verify with nothing running).
      const env = v.environment ?? this.nextEnv(state);
      const d = await decideDeploy({ verdict: v, repos: this.touched(state), env, runDeploy: (r, e) => this.deploy(r, e), probe: (u) => probeHealth(u) });
      for (const [type, data] of d.events) M.record(type, { ...data, risk: state.risk }, { actor: type === 'deploy' ? role : 'deploy', issue: n });
      if (d.status === 'deployed') {
        state.deployed = { ...state.deployed, [env]: now().toISOString() };
        state.lastEnv = env;
        await T.comment(repo, n, `### 🚀 Deployed to \`${env}\` (deploy exited 0, health 200)\n${this.touched(state).map((r) => `- ${r.name}: ${r.health[env]}`).join('\n')}`);
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
      if (v.rollback) for (const r of this.touched(state)) await this.rollback(r, state.lastEnv, n);
      if (v.rollback || next === 'build') this.coe({ issue: n, kind: v.rollback ? 'rollback' : 'regression', from: 'verify', to: 'build', by: role, reason: `${v.summary}\n\n${v.handoff}` });
      else if (['done', 'release'].includes(next)) for (const r of this.touched(state)) this.markVerified(r, state.lastEnv, n);
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
    if (isLoop && state.loops > (cfg.loops.owner_after ?? 6)) return this.escalate(n, state, next, `Runaway: ${state.loops} loop-backs. Add \`${T.L.approved}\` to continue to \`${next}\`, or close the issue.`, owners(cfg));
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
    if (from !== to) await T.setStage(this.repo, n, from, to);
  }

  async escalate(n, state, pending, message, to = owners(this.cfg)) {
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
    if (state.pending === 'merge' && stage === 'merge') state.mergeApproved = true;
    else if (state.pending && state.pending !== stage) await this.move(issue, stage, state.pending, state);
    M.record('human_approved', { stage, to: state.pending }, { actor: 'human', issue: n });
    state.pending = null; state.loops = 0; state.failures = 0; state.personStage = null;
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
      if (state.loops > cfg.loops.max_loops) return this.escalate(n, state, 'build', 'Merge conflicts keep recurring.');
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
      if (state.loops > cfg.loops.max_loops) return this.escalate(n, state, 'build', 'CI keeps failing.');
      return this.move(issue, 'merge', 'build', state);
    }
    for (const r of this.repos) { // config order = dependency order
      const pr = state.prs[r.name];
      if (!pr || state.merged?.[r.name]) continue;
      await T.mergePr(r.repo, pr);
      state.merged = { ...state.merged, [r.name]: now().toISOString() };
      M.saveIssueState(n, state);
      const mergeSha = (await T.gh(['pr', 'view', String(pr), '-R', r.repo, '--json', 'mergeCommit', '--jq', '.mergeCommit.oid']).catch(() => '')) || null;
      M.record('merged', { repo: r.name, pr, risk: state.risk, checks: checks[r.name], head_sha: state.heads?.[r.name] ?? null, merge_sha: mergeSha }, { issue: n });
    }
    await T.comment(repo, n, `### ✅ Merged ${this.prList(state)} (risk: ${state.risk ?? 'n/a'})`);
    await R.dropWorktrees(n, this.repos);
    await this.move(issue, 'merge', 'release', state);
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

  repoByName(name) { return this.repos.find((r) => r.name === name); }
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
    if (!Object.keys(state.prs).length) { v.question_for_human = 'The engineer reported done, but no repo has commits on the branch.'; return false; }
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
    return [
      `# Back to you: #${issue.number} \`${stage}\``,
      `The work came back to you, so this continues your earlier session. Everything you read then still applies; don't re-read it.`,
      state.lastHandoff ? `\n## What must change (from ${state.lastHandoff.by}, ${state.lastHandoff.from})\n${state.lastHandoff.text}` : '',
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
          : '';
    return [
      `# Issue #${n}: ${issue.title}`, `Tracker: ${repo} · ${issue.url ?? ''}`, `Now: ${now().toString()}`, '',
      `## Your stage: \`${stage}\``, st.goal, '',
      `## Issue body`, issue.body || '_(empty)_', '',
      `## Factory state`,
      `priority=${T.priorityOf(issue)} risk=${state.risk ?? 'unset'} loops=${state.loops} repos=${this.touched(state).map((r) => r.name).join(',')} prs=${this.prList(state) || 'none'} deployed=${JSON.stringify(state.deployed ?? {})}`,
      this.spend ? `spend: today $${this.spend.today_usd} of $${this.spend.daily_budget_usd} daily budget${this.spend.release ? ` · Release ${this.spend.release} so far $${this.spend.release_usd}` : ''} (as of ${this.spend.at.slice(11, 16)} UTC; also in ${p('memory/state/spend.json')})` : '',
      ...(() => { const A = this.answersLatest ?? []; return A.length ? [`\n## Owner answers (newest first; these override answers.md and any earlier assumption)`,
        ...A.map((a) => `- **#${a.request}** (${a.ts.slice(0, 16).replace('T', ' ')} UTC): ${a.text.replace(/\s+/g, ' ').slice(0, 300)}`)] : []; })(),
      state.lastHandoff ? `\n## Handoff to you from ${state.lastHandoff.by} (${state.lastHandoff.from})\n${state.lastHandoff.text}` : '',
      people.length ? `\n## What people said on the issue (authoritative)\n${people.join('\n')}` : '',
      issue.ci ? `\n## CI on the PR right now (${issue.ci.status === 'timeout' ? 'some checks still running' : issue.ci.status})\n${issue.ci.table}\n` +
        `You can't advance while any check is red: the dispatcher sends red CI back to build automatically.` +
        (issue.ci.failures.length ? `\n${issue.ci.failures.map((f) => `\n**${f.repo}: ${f.name}** (failing log tail)\n\`\`\`\n${(f.log || '').slice(-2000)}\n\`\`\``).join('')}` : '') : '',
      history.length ? `\n## History of this issue\n${history.join('\n')}` : '',
      digest ? `\n## How your team works (digest of the operating model and the ${team} charter)\n${digest}` : '',
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
        `Deploy config for ${this.nextEnv(state)}:\n${this.touched(state).map((r) => `- ${r.name}: deploy ${r.deploy_command ? `\`${r.deploy_command}\`` : r.deploy_workflow || '(none configured)'}, health ${r.health?.[this.nextEnv(state)] || '(none configured)'}`).join('\n')}\n` +
        `The dispatcher marks the environment deployed only if every repo's deploy exits 0 and its health URL answers 200; otherwise the release is held whatever you choose. ` +
        `If the change has nothing to run (no build, no server, no bundle change), set \`no_runtime_surface: true\` with a \`no_runtime_note\` saying why, and no deploy or probe runs.\nRecent deploys:\n${this.touched(state).filter((r) => r.deploy_workflow).map((r) => `- \`gh run list -R ${r.repo} --workflow ${r.deploy_workflow} --limit 10\``).join('\n')}` : '',
      stage === 'verify' ? `\n## Validate ${state.lastEnv ?? 'the deploy'} (${state.deployed?.[state.lastEnv] ? `deployed ${state.deployed[state.lastEnv]}` : state.noRuntime?.[state.lastEnv] ? `not deployed: the release manager declared no runtime surface at ${state.noRuntime[state.lastEnv]}; confirm nothing needed to run` : 'deployed ?'})\n${this.profile(state.lastEnv) ? `You have read-only AWS access (profile \`${this.profile(state.lastEnv)}\`, region ${cfg.aws?.region}). Start with \`aws sts get-caller-identity --profile ${this.profile(state.lastEnv)}\`.` : 'This environment runs on the local machine. Use the health URLs and the deploy log.'}\n` +
        `Health URLs:\n${this.touched(state).map((r) => `- ${r.name}: ${r.health?.[state.lastEnv] || '(none configured)'}`).join('\n')}\nSignals:\n${this.signals(state.lastEnv, this.touched(state)).map((s) => `- \`${s}\``).join('\n')}\n` +
        `Environments: ${this.envs.join(' → ')}. If ${state.lastEnv} is healthy and it isn't the last environment, choose \`release\` to promote. If it is the last, choose \`done\`. A regression goes to \`build\`, and if users are impacted, say "rollback" in decisions.` : '',
      `\n## How to work`,
      `This brief already holds the digest, the product brief, the answers, the issue's comments and history, and the earlier artifacts. ` +
        `Don't re-read them or re-run \`gh issue view\` and \`sf memory issue\`. Spend your steps on the work itself; read the full documents only for a specific gap.`,
      lint,
      `\n## Choose next_stage from`, opts,
      `\nUse \`advance\` to move forward, \`loop_back\` to send work upstream (say exactly what must change in \`handoff\`), \`reject\` to close, \`wait\` with \`wait_for\` when the plan says this issue must wait for other issues (no council; it resumes by itself), and \`blocked\` only when a decision is needed.`,
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
