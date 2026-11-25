#!/usr/bin/env node
// sf: the software factory CLI. Humans use it to run the org. Agents use `sf recall` / `sf memory`.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { execFileSync } from 'node:child_process';
import { HOME, p, loadConfig, headcount, paused, setPaused } from './lib/config.mjs';
import * as M from './lib/memory.mjs';
import * as T from './lib/tracker.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : dflt; };
const flags = (name) => rest.flatMap((a, i) => (a === `--${name}` ? [rest[i + 1]] : []));
const has = (name) => rest.includes(`--${name}`);
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lazy = async () => new (await import('./lib/dispatcher.mjs')).Dispatcher(loadConfig());

const commands = {
  async setup() {
    // sf setup [--company "Acme Fintech"] [--owner <github-login>] [--budget 50] [--mission "…"]
    // The dashboard does the same on first open; this is for terminals and scripts.
    const S = await import('./lib/setup.mjs');
    const st = await S.status();
    for (const c of st.checks) console.log(`${c.ok ? '✓' : c.required ? '✗' : '!'} ${c.name.padEnd(14)} ${c.detail ?? ''}${!c.ok && c.fix ? `\n    → ${c.fix}` : ''}`);
    if (st.configured) return console.log('\nAlready set up. Start with: sf dashboard   (then "Start an engagement" in the Client room)');
    if (!st.ready) { process.exitCode = 1; return console.log('\nFix the items marked ✗ and run sf setup again.'); }
    const d = st.defaults;
    const r = await S.apply({ company: flag('company', d.company), mission: flag('mission', d.mission), owner: flag('owner', d.owner), budget: flag('budget', d.budget) });
    console.log(`\n✓ ${r.company} is set up. Owner: ${r.owner}. Daily budget: $${r.budget}.\n\nNext:\n  sf dashboard   # open http://127.0.0.1:4340, click "Org stopped · Start", then "Client room" → "Start an engagement"\n  (or: sf run in a second terminal)`);
  },

  async init() {
    // sf init --name "Acme" --tracker acme/issues --repo web=acme/web --repo api=acme/api [--branch main]
    const repos = flags('repo').map((x) => { const [name, repo] = x.includes('=') ? x.split('=') : [x.split('/')[1], x]; return { name, repo }; });
    if (!repos.length) throw new Error('usage: sf init --tracker owner/issues-repo --repo name=owner/repo [--repo name=owner/repo …] [--name "Product"]');
    const f = p('org/org.yaml');
    const doc = parseDocument(readFileSync(f, 'utf8'));
    const tracker = flag('tracker', repos[0].repo);
    doc.setIn(['product', 'tracker'], tracker);
    if (flag('name')) doc.setIn(['product', 'name'], flag('name'));
    const old = doc.getIn(['product', 'repos'])?.toJSON() ?? [];
    doc.setIn(['product', 'repos'], repos.map(({ name, repo }) => ({
      name, repo, default_branch: flag('branch', 'main'), about: old.find((o) => o.name === name)?.about ?? '',
      deploy_workflow: 'deploy.yml', health: Object.fromEntries((doc.get('environments')?.toJSON() ?? ['production']).map((e) => [e, ''])),
    })));
    writeFileSync(f, doc.toString());
    const cfg = loadConfig();
    for (const r of repos) await T.gh(['repo', 'view', r.repo, '--json', 'name']).catch(() => { throw new Error(`cannot access ${r.repo} with gh`); });
    console.log(`Creating labels in ${tracker}…`);
    await T.ensureLabels(tracker, cfg);
    console.log(`\n✓ ${cfg.product.name}: tracker ${tracker}, repos ${repos.map((r) => `${r.name}=${r.repo}`).join(', ')}` +
      `\n  Edit org/org.yaml to set each repo's "about", deploy_workflow, and health URLs; drop deploy_workflow for libraries.` +
      `\n\nNext:\n  1. sf discover   # agents study every repo, write memory/product/, then ask you questions\n  2. sf genesis    # agents found the org around this product\n  3. sf run        # start; label issues "${cfg.product.intake_label}" in ${tracker}` +
      `\n  AWS deploys: see templates/aws/README.md`);
  },

  async discover() {
    const D = await import('./lib/discovery.mjs');
    const cfg = loadConfig();
    if (has('answer')) await D.interview(cfg);
    else await D.discover(cfg, { refresh: has('refresh') });
    await (await lazy()).syncMemory();
  },

  async answer() {
    const D = await import('./lib/discovery.mjs');
    const cfg = loadConfig();
    if (has('done')) await D.refreshOverview(cfg); // fold the recorded answers into the overview
    else if (has('delegate')) await D.delegate(cfg); // the owning roles decide
    else await D.answer(cfg, { defaults: has('defaults'), index: Number(rest[0]) || 0, text: rest.slice(1).join(' ') });
    await (await lazy()).syncMemory();
  },

  async genesis() {
    const { genesis } = await import('./lib/genesis.mjs');
    await genesis(loadConfig(), { only: flag('teams')?.split(',') });
    await (await lazy()).syncMemory();
  },

  async run() {
    // One dispatcher only: two would start the same stage twice. The lock is the running dispatcher's PID.
    loadConfig(); // not set up yet: say so before anything else
    mkdirSync(p('.factory'), { recursive: true });
    const lock = p('.factory/dispatcher.pid');
    const other = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : 0;
    if (other && other !== process.pid && (() => { try { process.kill(other, 0); return true; } catch { return false; } })()) {
      throw new Error(`a dispatcher is already running (PID ${other}). Stop it first: kill -TERM ${other}`);
    }
    writeFileSync(lock, String(process.pid));
    process.on('exit', () => { try { if (Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock); } catch {} });
    const d = await lazy();
    const cfg = d.cfg;
    // Graceful stop (Ctrl-C / kill): start nothing new, let running agents finish and apply their verdicts, then exit.
    const drain = () => {
      if (d.draining) return process.exit(1); // second signal: stop now
      d.draining = true;
      console.log(`Stopping: waiting for ${d.running.size} running agent(s) to finish. Press Ctrl-C again to force.`);
      const wait = setInterval(async () => { if (!d.running.size && !d.ticking && !d.background.size) { clearInterval(wait); await d.syncMemory(); console.log('Stopped.'); process.exit(0); } }, 1000);
    };
    process.on('SIGINT', drain); process.on('SIGTERM', drain);
    console.log(cfg.product.tracker ? `Factory running on ${cfg.product.name}: ${cfg.product.repos.map((r) => r.repo).join(", ")} (scale ×${cfg.capacity.scale}, max ${cfg.capacity.max_parallel} parallel). Ctrl-C to stop.`
      : `${cfg.company.name} is running with no project yet. Start one in the dashboard Client room (or: sf engage --start). Ctrl-C to stop.`);
    if (paused()) console.log("Paused: no new work starts until you resume (dashboard, or sf resume).");
    for (;;) {
      try { (await import('./lib/usage.mjs')).check(loadConfig()); } catch (e) { console.error('usage:', e.message); } // pause near the Claude usage limit; resume after it resets
      if (paused() && !d.draining) { await sleep(5000); continue; } // paused (by a person, or for the usage limit): start nothing, check again soon
      if (d.draining) { // people's approvals and vendor deliveries still go through while agents finish
        try { d.ticking = true; await d.tick(); } catch (e) { console.error('tick:', e.message); } finally { d.ticking = false; }
        await sleep(cfg.capacity.poll_seconds * 1000); continue;
      }
      try {
        d.ticking = true;
        await d.tick();
        if (d.cfg.delivery?.focus?.length || !d.cfg.product?.tracker) { await sleep(cfg.capacity.poll_seconds * 1000); continue; } // focus, or no project yet: no background jobs
        const sched = M.kv('scheduler');
        const due = (k, ms) => !sched[k] || Date.now() - new Date(sched[k]) > ms;
        if (due('observe', cfg.observability.interval_minutes * 60e3)) { sched.observe = new Date().toISOString(); M.kv('scheduler', sched); d.observe().catch((e) => console.error('observe:', e.message)); }
        if (cfg.discovery?.refresh_days && due('discover', cfg.discovery.refresh_days * 864e5)) {
          sched.discover = new Date().toISOString(); M.kv('scheduler', sched);
          import('./lib/discovery.mjs').then((D) => D.discover(cfg, { refresh: true, interactive: false })).catch((e) => console.error('discover:', e.message));
        }
        const openProposals = existsSync(p('org/proposals')) && readdirSync(p('org/proposals')).some((f) => f.endsWith('.md'));
        if (openProposals && due('govern', 6 * 3600e3)) {
          sched.govern = new Date().toISOString(); M.kv('scheduler', sched);
          import('./lib/governance.mjs').then((G) => G.govern(loadConfig())).catch((e) => console.error('govern:', e.message));
        }
        if (due('cfo', (cfg.staffing?.review_hours ?? 24) * 3600e3) && sched.audit) {
          sched.cfo = new Date().toISOString(); M.kv('scheduler', sched);
          import('./lib/staffing.mjs').then((S) => S.review(loadConfig())).catch((e) => console.error('cfo-review:', e.message));
        }
        if (due('feedback', 6 * 3600e3) && (await import('./lib/hr.mjs')).list().some((i) => i.status === 'open')) {
          sched.feedback = new Date().toISOString(); M.kv('scheduler', sched);
          import('./lib/hr.mjs').then((H) => H.review(loadConfig())).then((r) => r.resolved && console.log(`feedback: ${r.resolved} resolved`)).catch((e) => console.error('feedback:', e.message));
        }
        import('./lib/digest.mjs').then((D) => D.ensure(loadConfig())).catch((e) => console.error('digest:', e.message)); // only when a source changed
        if (due('scan', 864e5)) { sched.scan = new Date().toISOString(); M.kv('scheduler', sched); d.scan().catch((e) => console.error('scan:', e.message)); }
        if (due('audit', cfg.audit.interval_days * 864e5)) { sched.audit = new Date().toISOString(); M.kv('scheduler', sched); d.audit().catch((e) => console.error('audit:', e.message)); }
      } catch (e) { console.error('tick:', e.message); M.record('error', { error: e.message }); }
      finally { d.ticking = false; }
      await sleep(cfg.capacity.poll_seconds * 1000);
    }
  },

  async pause() { setPaused(true); M.record('paused', {}, { actor: 'person' }); console.log('Paused. No new work starts; agents already running finish. Resume with: sf resume'); },
  async resume() { setPaused(false); M.record('resumed', {}, { actor: 'person' }); console.log('Resumed. The dispatcher picks up work on its next pass.'); },

  async tick() { const d = await lazy(); await d.tick(); while (d.running.size) await sleep(2000); await d.syncMemory(); },
  async scan() { const d = await lazy(); await d.scan(); await d.syncMemory(); },
  async observe() { const d = await lazy(); await d.observe(); await d.syncMemory(); },
  async audit() { const d = await lazy(); await d.audit(Number(flag('days', 7))); await d.syncMemory(); },

  async council() {
    const cfg = loadConfig();
    const { council } = await import('./lib/council.mjs');
    const members = (flag('members') ?? 'architect,product-manager,security,sre').split(',');
    const chair = flag('chair', 'chief-of-staff');
    const r = await council({ cfg, name: `adhoc/${M.slug(positional)}-${Date.now()}`, topic: positional, chair, members,
      context: flag('context', 'Ad-hoc council called by a human. Use org/, memory/ and the product repo as needed.'),
      extraSchema: { decisions: { type: 'array', items: (await import('./lib/worker.mjs')).DECISION } } });
    for (const d of r.out?.decisions ?? []) M.decide(d, { actor: chair, scope: 'org' });
    console.log(`\n${r.out?.summary ?? r.error}\n\nTranscript: ${r.thread}`);
    await (await lazy()).syncMemory();
  },

  async new() {
    const cfg = loadConfig();
    const n = await T.createIssue(cfg.product.tracker, { title: positional, body: flag('body', ''), labels: [cfg.product.intake_label] });
    console.log(`Created #${n}. The factory picks it up on the next tick.`);
  },

  async approve() {
    const cfg = loadConfig();
    await T.editLabels(cfg.product.tracker, Number(positional), { add: [T.L.approved] });
    console.log(`Approved #${positional}.`);
  },

  async status() {
    const cfg = loadConfig();
    const issues = await T.listIssues(cfg.product.tracker, cfg.product.intake_label);
    const by = {};
    for (const i of issues) (by[T.stageOf(i) ?? '(new)'] ??= []).push(i);
    console.log(`${cfg.product.name} (${cfg.product.tracker}): ${issues.length} open\n`);
    for (const stage of ['(new)', ...Object.keys(cfg.pipeline)]) {
      const list = by[stage] ?? [];
      const st = cfg.pipeline[stage];
      const who = st ? (st.role ? `${st.role} ×${headcount(cfg, st.role)}` : st.system ? 'system' : 'council') : '';
      console.log(`${stage.padEnd(18)} ${String(list.length).padStart(3)}  ${who}`);
      for (const i of list) {
        const ls = T.labelsOf(i);
        console.log(`    #${i.number} ${T.priorityOf(i)} ${ls.includes(T.L.working) ? '⚙️ ' : ''}${ls.includes(T.L.human) ? '🙋 ' : ''}${i.title.slice(0, 70)}`);
      }
    }
  },

  async recruit() {
    await (await import('./lib/staffing.mjs')).recruit(loadConfig());
    await (await lazy()).syncMemory();
  },
  async 'cfo-review'() {
    const r = await (await import('./lib/staffing.mjs')).review(loadConfig());
    console.log(r.changed.map((c) => `${c.role}: ${c.from} → ${c.to} (${c.reason})`).join('\n') || 'No changes.');
    await (await lazy()).syncMemory();
  },

  async departments() {
    const deps = await (await import('./lib/departments.mjs')).design(loadConfig());
    for (const d of deps) console.log(`${d.title.padEnd(22)} head: ${d.head} (${d.head_title}) · teams: ${d.teams.join(', ')}`);
    await (await lazy()).syncMemory();
  },

  async library() {
    const L = await import('./lib/library.mjs');
    if (has('reindex')) L.reindex(loadConfig()); else await L.init(loadConfig());
    await (await lazy()).syncMemory();
  },

  async feedback() {
    // sf feedback                                   → list the box
    // sf feedback --file <role|org> complaint|request "text" [--evidence "..."]
    // sf feedback --review                          → the chief of staff handles open items now
    const H = await import('./lib/hr.mjs');
    if (has('review')) { const r = await H.review(loadConfig()); console.log(`${r.resolved} item(s) resolved`); return (await lazy()).syncMemory(); }
    if (flag('file')) {
      const [kind, ...words] = rest.slice(rest.indexOf('--file') + 2).filter((x, i, a) => !x.startsWith('--') && a[i - 1] !== '--evidence');
      const item = H.file({ about: flag('file'), kind, text: words.join(' '), evidence: flag('evidence', '') }, { by: 'person' });
      return console.log(`Filed ${item.kind} ${item.id} about ${item.about}.`);
    }
    for (const i of H.list()) console.log(`${i.id} ${i.status.padEnd(8)} ${i.kind.padEnd(9)} about ${i.about.padEnd(16)} from ${i.by}: ${i.text.slice(0, 80)}${i.reply ? `\n   → ${i.outcome}: ${i.reply.slice(0, 120)}` : ''}`);
  },

  async govern() {
    await (await import('./lib/governance.mjs')).govern(loadConfig());
    await (await lazy()).syncMemory();
  },

  async dashboard() {
    // Port: --port, then SF_DASHBOARD_PORT, then dashboard.port in org/org.yaml, then 4340 (the next free port if 4340 is taken).
    const D = await import('./lib/dashboard.mjs');
    const saved = (() => { try { return loadConfig().dashboard?.port; } catch { return undefined; } })();
    const chosen = flag('port') ?? process.env.SF_DASHBOARD_PORT ?? saved;
    const port = Number(chosen ?? D.DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Not a usable port: ${chosen}. Use a number from 1024 to 65535.`);
    D.serve(port, { explicit: (flag('port') ?? process.env.SF_DASHBOARD_PORT) != null }); // a saved port may fall through to the next free one
  },

  async report() {
    const { report } = await import('./lib/report.mjs');
    console.log(report({ days: Number(flag('days', 7)) }));
  },

  // ── agent-facing utilities (safe for read-only roles) ──
  /** WCAG 2.x contrast ratio between two colours: sf contrast "#1e293b" "#f4f2ee" */
  async contrast() {
    const lum = (hex) => {
      const h = hex.replace('#', ''), f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      if (!/^[0-9a-f]{6}$/i.test(f)) throw new Error(`not a hex colour: ${hex}`);
      return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
    };
    const [a, b] = rest.filter((x) => !x.startsWith('--'));
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    const r = (l1 + 0.05) / (l2 + 0.05);
    console.log(`${a} on ${b}: ${r.toFixed(2)}:1 · normal text AA ${r >= 4.5 ? 'pass' : 'FAIL'} / AAA ${r >= 7 ? 'pass' : 'FAIL'} · large text AA ${r >= 3 ? 'pass' : 'FAIL'} · UI components ${r >= 3 ? 'pass' : 'FAIL'}`);
  },

  // ── agent-facing memory commands ──
  async release() {
    // sf release            → show the current release
    // sf release --replan   → re-plan the active release under the current CEO directives
    // sf release --add <n>  → pull a backlog issue into the active release
    const R = await import('./lib/release.mjs');
    if (flag('add')) {
      const n = Number(flag('add'));
      if (R.current()?.status !== 'active') throw new Error('no active release to add to');
      await R.addToRelease(loadConfig(), n, 'added by a person with sf release --add');
      console.log(`#${n} added to Release ${R.current().number}. The team picks it up on the next pass.`);
      return (await lazy()).syncMemory();
    }
    if (has('replan')) {
      const cfg = loadConfig();
      const r = await R.plan(cfg, await T.listIssues(cfg.product.tracker, cfg.product.intake_label), { replan: true });
      console.log(`Release ${r.number}: ${r.goal}\nScope: ${r.issues.map((n) => `#${n}`).join(', ')}`);
      await (await lazy()).syncMemory();
    } else console.log(JSON.stringify(R.current(), null, 2));
  },

  async engage() {
    // sf engage                → show the engagement (phase, documents, last messages)
    // sf engage --start        → sales opens the conversation with you
    // sf engage --say "text"   → reply in the Client room
    // sf engage --approve      → approve the proposal or the plan
    const E = await import('./lib/engagement.mjs');
    if (has('start')) await E.start();
    else if (flag('say')) await E.message(flag('say'));
    else if (has('approve')) await E.approve();
    const s = E.state();
    if (!s) return console.log('No engagement yet. Start one with: sf engage --start');
    console.log(`Phase: ${s.phase}${s.awaiting ? ` (waiting for your ${s.awaiting})` : ''} · project: ${s.project?.name ?? '—'} · repo: ${s.repo ?? '—'}`);
    for (const [k, f] of Object.entries(s.docs ?? {})) console.log(`  doc ${k}: ${f}`);
    for (const m of E.thread().slice(-4)) console.log(`\n${m.from === 'client' ? 'You' : m.from}: ${m.text}`);
    await (await lazy()).syncMemory();
  },

  async lint() {
    // sf lint spec <issue>   → the checks declared on feature-grooming, against that issue's spec
    // sf lint build <issue>  → the checks declared on build (the AC → evidence table), against its build.md
    const [kind, n] = rest;
    const stage = { spec: 'feature-grooming', build: 'build', design: 'tech-grooming' }[kind];
    if (!stage || !n) throw new Error('usage: sf lint spec|build|design <issue> [--file <draft.md> | --stdin]');
    const C = await import('./lib/checks.mjs'), cfg = loadConfig();
    const checks = cfg.pipeline[stage]?.checks ?? { build: ['ac_evidence'], 'tech-grooming': ['design_lint'] }[stage] ?? ['spec_lint'];
    // A draft before handing it in: --file <path> (works where pipes are denied, owner request #156) or --stdin < draft.md
    const r = flag('file') ? C.runChecks(checks, readFileSync(flag('file'), 'utf8'), cfg, { issue: Number(n) })
      : has('stdin')
      ? C.runChecks(checks, await new Promise((res) => { let b = ''; process.stdin.on('data', (d) => (b += d)).on('end', () => res(b)); }), cfg, { issue: Number(n) })
      : C.lintIssue(Number(n), stage, cfg);
    console.log(r.ok ? `✓ #${n} ${kind} passes` : `✗ #${n} ${kind}: ${r.failures.length} problem(s)\n${r.failures.map((f) => `  - ${f}`).join('\n')}`);
    if (r.warnings?.length) console.log(`! ${r.warnings.length} warning(s)\n${r.warnings.map((w) => `  - ${w}`).join('\n')}`);
    if (!r.ok) process.exitCode = 1;
  },

  // sf contains <sha> → is that commit in the running factory? (feedback 874e9459: read roles can't run git -C, which can write)
  async contains() {
    const sha = rest[0] ?? '';
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error('usage: sf contains <commit sha>');
    const head = execFileSync('git', ['-C', HOME, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    let yes = false;
    try { execFileSync('git', ['-C', HOME, 'merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' }); yes = true; } catch {}
    console.log(`${yes ? '✓' : '✗'} ${sha} is ${yes ? '' : 'not '}in the running factory (HEAD ${head.slice(0, 12)})`);
    if (!yes) process.exitCode = 1;
  },

  async recall() {
    // sf recall --path deploy/local-node.sh → which open issues claim that file (owner request #115)
    if (flag('path')) {
      const D = await import('./lib/dispatcher.mjs'), x = flag('path').replace(/^\.?\//, '');
      const c = D.clashes(0, [x], D.claimsIndex());
      return console.log(c.length ? c.map((m) => `#${m.issue} claims ${m.path}`).join('\n') : `No open issue claims ${x}.`);
    }
    for (const h of M.recall(positional, Number(flag('limit', 15)))) console.log(`── ${h.file}\n${h.text}\n`);
  },
  async memory() {
    const [sub, arg] = rest;
    if (sub === 'issue') return console.log(JSON.stringify(M.issueDossier(arg), null, 2));
    if (sub === 'decisions') {
      const files = readdirSync(p('memory/decisions')).sort().reverse().slice(0, Number(arg ?? 20));
      return files.forEach((f) => console.log(readFileSync(p('memory/decisions', f), 'utf8').match(/^title: (.*)$/m)?.[1] ?? f, ` (${f})`));
    }
    if (sub === 'learnings') return console.log(existsSync(p('memory/knowledge/learnings.md')) ? readFileSync(p('memory/knowledge/learnings.md'), 'utf8') : '');
    console.log('usage: sf memory issue <n> | decisions [count] | learnings');
  },
};

const help = `sf: software factory

  Setup:    setup [--company "Name"] [--owner login] [--budget 50] (first run; the dashboard does this too) · init --tracker o/r --repo name=o/r [--repo …] · discover [--refresh | --answer] · answer [n "text" | --defaults | --delegate | --done]
  Org:      feedback [--file <role|org> complaint|request "text" | --review] · departments (org picks department heads) · library [--reindex] (org designs the documents library) · recruit (PO designs skills, CFO approves hires) · cfo-review · govern (council decides open proposals) · genesis [--teams a,b] · council "<topic>" [--members a,b] [--chair r]
  Run:      run · pause · resume · tick · observe · audit [--days 7]
  Watch:    dashboard [--port n]  (or SF_DASHBOARD_PORT, or dashboard.port in org.yaml; default 4340, next free port if taken)
  Work:     new "<title>" [--body ..] · approve <issue> · status · report [--days 7]
  Tools:    lint spec|build <n> · contrast "#fg" "#bg"  (WCAG ratio)
  Memory:   recall "<query>" · memory issue <n> | decisions | learnings`;

if (!commands[cmd]) { console.log(help); process.exit(cmd ? 1 : 0); }
commands[cmd]().catch((e) => { console.error(e.message); process.exit(1); });
