import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HOME, p, compileAgents } from './config.mjs';
import { record, saveRun } from './memory.mjs';
import { save as saveUsage } from './usage.mjs';

const constitution = () => readFileSync(p('CLAUDE.md'), 'utf8');
const readIf = (f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
/** Lessons from Corrections of Errors for this role (and everyone), so a failure is never repeated. */
function lessons(role, max = 6000) {
  const own = readIf(p('memory/lessons', `${role}.md`)), all = readIf(p('memory/lessons/all.md'));
  const text = [own && `### For ${role}\n${own}`, all && `### For everyone\n${all}`].filter(Boolean).join('\n');
  return text ? `\n\n## Lessons from Corrections of Errors (do not repeat these failures)\n${text.length > max ? '…' + text.slice(-max) : text}` : '';
}

const DECISION = {
  type: 'object',
  properties: {
    title: { type: 'string' }, decision: { type: 'string' }, rationale: { type: 'string' },
    alternatives: { type: 'string' }, supersedes: { type: 'string' },
  },
  required: ['title', 'decision', 'rationale'],
};

/** The verdict every stage agent returns. The dispatcher, not the agent, applies it. */
export function verdictSchema(nextOptions, extra = {}) {
  return {
    type: 'object',
    properties: {
      outcome: { enum: ['advance', 'loop_back', 'reject', 'blocked', 'needs_vendor', 'wait', 'already_satisfied'] },
      // One loop-back classification (governance decision, owner request #155): why work went back, and where the defect began.
      loop_cause: { enum: ['requirement', 'design', 'code', 'test', 'premise', 'format', 'environment', 'dependency', 'other'],
        description: 'With outcome loop_back: the kind of defect that sends this back.' },
      origin_stage: { type: 'string', description: 'With outcome loop_back: the stage where the defect was introduced (e.g. feature-grooming).' },
      satisfied_by: { type: 'string', description: 'With outcome `already_satisfied`: the evidence that the work is already done, as file:lines or a commit sha. ' +
        'The product owner confirms and the issue closes as completed, with nothing built.' },
      wait_for: { type: 'array', items: { type: 'number' }, description: 'With outcome `wait`: the issue numbers this one depends on, as the plan already says. ' +
        'The issue is parked, with no council, and resumes at this stage once each one has merged or closed.' },
      next_stage: { enum: [...nextOptions, 'blocked'] },
      summary: { type: 'string', description: 'What you did and found, for the issue thread (markdown, concise).' },
      handoff: { type: 'string', description: 'Exact instructions for the agent that receives this next.' },
      artifact_markdown: { type: 'string', description: 'The full artifact this stage produces (analysis, spec, design, review, ...).' },
      decisions: { type: 'array', items: DECISION },
      learnings: { type: 'array', items: { type: 'string' } },
      question_for_human: { type: 'string', description: 'Non-blocking: something you assumed that a person may want to correct.' },
      documents: { type: 'array', description: 'Durable documents for the library (guides, runbooks, architecture, policies). Use an org-defined folder and follow library/STANDARD.md.',
        items: { type: 'object', properties: { folder: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string', description: 'TL;DR in 2-3 plain sentences.' },
          audience: { type: 'string' }, kind: { type: 'string' }, markdown: { type: 'string' } }, required: ['folder', 'title', 'summary', 'markdown'] } },
      feedback: { type: 'array', description: 'The request and complaint box: a complaint about another role or the org, or a request for something you need. Include evidence (issue numbers, ADR ids, artifact paths). Not for venting.',
        items: { type: 'object', properties: { about: { type: 'string', description: 'a role name, or "org"' }, kind: { enum: ['complaint', 'request'] }, text: { type: 'string' }, evidence: { type: 'string' } }, required: ['about', 'kind', 'text'] } },
      consult: { type: 'object', description: 'Ask one specialist role a question you need answered to finish this stage (e.g. security for an ADR). One run of that role, not a council. Use with outcome blocked.',
        properties: { role: { type: 'string' }, question: { type: 'string' } }, required: ['role', 'question'] },
      process_proposal: { type: 'string', description: 'A change to how the org/factory works (process, signals, roles, config, docs). Goes to the governance council, never to the product pipeline.' },
      follow_up_issues: {
        type: 'array', description: 'New work the org should take on: slices split off this issue, prerequisites, tech debt. Each one enters the pipeline at triage.',
        items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, priority: { enum: ['P0', 'P1', 'P2', 'P3'] }, reason: { type: 'string' },
          blocking: { type: 'boolean', description: 'true only if THIS issue cannot ship without it. Blocking prerequisites join the current release; everything else goes to the backlog.' } }, required: ['title', 'body', 'reason'] },
      },
      vendor_request: {
        type: 'object', description: 'Something no agent can do (credentials, accounts, integrations, purchases). Blocking only with outcome needs_vendor.',
        properties: { title: { type: 'string' }, what: { type: 'string' }, why: { type: 'string' },
          how_to_provide: { type: 'string', description: 'Where to put it. NEVER ask for secrets in comments: name a GitHub secret, env var, or keychain item.' } },
        required: ['title', 'what', 'why', 'how_to_provide'],
      },
      ...extra,
    },
    required: ['outcome', 'next_stage', 'summary', 'handoff', 'artifact_markdown', 'decisions'],
  };
}
export { DECISION };

/**
 * The economy rule for one run: the first `economy.tasks` entry whose `task` is a prefix of the run label (and whose `role`,
 * if set, matches) picks the model, effort and budget cap. Roles keep their own model otherwise.
 */
export function taskPolicy(cfg, role, label) {
  const rule = (cfg.economy?.tasks ?? []).find((t) => String(label).startsWith(t.task) && (!t.role || t.role === role)) ?? {};
  return {
    model: rule.model ?? cfg.roles[role]?.model ?? 'claude-opus-5-5',
    effort: rule.effort ?? cfg.roles[role]?.effort ?? null,
    budget: rule.budget_usd ?? cfg.capacity?.budget_usd_per_run ?? 5,
  };
}

const FINISH = 'You have reached the spending limit for this stage. Stop exploring. Using what you already know, hand in your result now ' +
  'with the fewest further steps. If the work is genuinely not finished, say exactly what remains in the summary and handoff ' +
  '(for a stage verdict, choose outcome `blocked`) rather than claiming it is done.';

/**
 * Run one agent headlessly. Resolves with { ok, out, cost, ms, session, error, usage }.
 * Every run's full result is saved to memory/runs and summarised in the ledger (cost, tokens, steps).
 * `resume` continues an earlier session of this role (its context is kept, so it doesn't re-read what it already knows).
 * A run that hits its budget cap is continued once with a "finish now" turn instead of being thrown away.
 */
export async function runAgent(opts) {
  const first = await runOnce(opts);
  if (first.ok || !first.capped || !first.session || opts.noFinish) return first;
  const pol = taskPolicy(opts.cfg, opts.role, opts.label ?? opts.role);
  const fin = await runOnce({ ...opts, resume: first.session, prompt: FINISH, label: `${opts.label ?? opts.role}`, budget: Math.max(0.5, pol.budget / 2), meta: { ...opts.meta, finish: true } });
  return { ...fin, cost: first.cost + fin.cost, ms: first.ms + fin.ms, finished_after_cap: true };
}

function runOnce({ cfg, role, prompt, schema, cwd = HOME, issue = null, label = role, meta = {}, resume = null, budget = null }) {
  const agentsFile = compileAgents(); // per run: newly hired roles are available immediately (immutable, content-addressed)
  const r = cfg.roles[role];
  const pol = taskPolicy(cfg, role, label);
  const args = [
    '-p', '--agent', role, '--agents', agentsFile,
    ...(resume ? ['--resume', resume] : []),
    '--model', pol.model,
    ...(pol.effort ? ['--effort', pol.effort] : []),
    '--output-format', 'stream-json', '--verbose', // stream so the dashboard can show what the agent is doing
    '--json-schema', JSON.stringify(schema),
    '--permission-mode', 'dontAsk',
    '--allowedTools', (r.tools ?? []).join(','),
    '--add-dir', HOME,
    // Read access to the project's local clone(s); write access still depends on the role's tools.
    ...(cfg.product?.repos ?? []).flatMap((r) => { const b = p('workspaces', r.repo.replace('/', '__')); return existsSync(b) ? ['--add-dir', b] : []; }),
    '--append-system-prompt', constitution() + lessons(role),
    '--exclude-dynamic-system-prompt-sections', // keeps the system prompt identical across runs, so the prompt cache is reused
    '--max-budget-usd', String(budget ?? pol.budget),
    '--name', `sf:${label}${issue ? `#${issue}` : ''}`,
  ];
  // Least privilege: no agent inherits cloud credentials, except roles marked aws: true, which get the read-only profile.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AWS_|AZURE_|GOOGLE_|GCLOUD_)/.test(k)));
  Object.assign(env, { PATH: `${p('bin')}:${process.env.PATH}`, SF_HOME: HOME, SF_ROLE: role, SF_ISSUE: String(issue ?? '') });
  const ro = cfg.aws?.readonly_profile;
  if (r.aws && ro) Object.assign(env, { AWS_PROFILE: typeof ro === 'string' ? ro : Object.values(ro).at(-1), AWS_REGION: cfg.aws.region ?? '' });
  else Object.assign(env, { AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' }); // defence in depth, not a boundary
  const started = Date.now();
  record('run_started', { role, label, ...meta }, { actor: role, issue });

  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const live = liveFile({ role, label, issue, pid: child.pid, since: new Date(started).toISOString() });
    let buf = '', stderr = '', res = null;
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') res = ev;
        else if (ev.type === 'rate_limit_event') { try { saveUsage(ev.rate_limit_info); } catch { /* usage is advisory */ } }
        else if (ev.type === 'assistant') for (const b of ev.message?.content ?? []) live.push(describe(b));
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(prompt);
    child.on('close', (code) => {
      live.done();
      if (!res) try { res = JSON.parse(buf); } catch { /* fall through */ }
      const out = res?.structured_output ?? null;
      // modelUsage is per model and stays accurate when a run ends on an error (where `usage` can read zero).
      const mu = Object.values(res?.modelUsage ?? {}), u = res?.usage ?? {};
      const sum = (k) => mu.reduce((s, m) => s + (m[k] ?? 0), 0);
      const usage = mu.length
        ? { cache_read: sum('cacheReadInputTokens'), cache_write: sum('cacheCreationInputTokens'), input: sum('inputTokens'), output: sum('outputTokens'), turns: res?.num_turns ?? 0 }
        : { cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, turns: res?.num_turns ?? 0 };
      const error = out ? null : (res?.result || res?.subtype || stderr || `exit ${code}`).slice(0, 2000);
      const result = {
        ok: !!out && !res?.is_error, out, cost: res?.total_cost_usd ?? 0, ms: Date.now() - started,
        session: res?.session_id, error, usage, denials: res?.permission_denials ?? [],
        capped: !out && /budget/i.test(`${res?.subtype ?? ''} ${error ?? ''}`),
      };
      saveRun(issue, label, { role, cwd, prompt, result: res, actions: live.all, stderr: stderr.slice(-4000) });
      record('run_finished', { role, label, ...meta, ok: result.ok, cost_usd: result.cost, ms: result.ms, session: result.session,
        model: pol.model, effort: pol.effort, resumed: !!resume, capped: result.capped, ...usage,
        error: result.error, denials: result.denials.length }, { actor: role, issue });
      resolve(result);
    });
  });
}

// ── live view: one small JSON file per running agent, read by the dashboard ──
const short = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const base = (f) => String(f ?? '').split('/').slice(-2).join('/');

/** Turn one assistant content block into a human line: what the agent is saying or doing. */
function describe(b) {
  if (b.type === 'text' && b.text?.trim()) return { kind: 'say', text: short(b.text, 220) };
  if (b.type === 'thinking' && b.thinking?.trim()) return { kind: 'think', text: short(b.thinking, 220) };
  if (b.type !== 'tool_use') return null;
  const i = b.input ?? {};
  const map = {
    Read: () => `Reading ${base(i.file_path)}`, Edit: () => `Editing ${base(i.file_path)}`, Write: () => `Writing ${base(i.file_path)}`,
    Grep: () => `Searching for “${short(i.pattern, 50)}”`, Glob: () => `Looking for ${short(i.pattern, 50)}`,
    Bash: () => `$ ${short(i.command, 120)}`, WebSearch: () => `Searching the web: ${short(i.query, 80)}`, WebFetch: () => `Reading ${short(i.url, 80)}`,
    StructuredOutput: () => (i.outcome ? `Verdict: ${i.outcome}${i.next_stage ? ` → ${i.next_stage}` : ''}` : 'Handing in the result'),
  };
  return { kind: b.name === 'StructuredOutput' ? 'done' : 'do', text: (map[b.name] ?? (() => `${b.name}`))() };
}

function liveFile(meta) {
  const dir = p('.factory/live');
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${randomUUID()}.json`;
  const all = [];
  let timer = null;
  const flush = () => { timer = null; try { writeFileSync(file, JSON.stringify({ ...meta, actions: all.slice(-8) })); } catch { /* best effort */ } };
  flush();
  return {
    all,
    push(a) { if (!a) return; all.push({ ts: new Date().toISOString(), ...a }); timer ??= setTimeout(flush, 300); },
    done() { clearTimeout(timer); rmSync(file, { force: true }); },
  };
}
