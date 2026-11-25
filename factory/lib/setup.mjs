// First-run setup. A fresh install has code only: no org/org.yaml, memory or library. Setup checks this machine has what the
// agents need, then creates the install's org from templates/org with the owner's company, GitHub login and budget.
// The dashboard runs it in the browser; `sf setup` runs it in the terminal. After setup, work starts in the Client room.
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDocument } from 'yaml';
import { p, configured, loadConfig, compileAgents } from './config.mjs';

const exec = promisify(execFile);
const run = (cmd, args) => exec(cmd, args, { timeout: 15e3 }).then((r) => (r.stdout || r.stderr).trim(), (e) => { throw new Error((e.stderr || e.message).trim().split('\n')[0]); });

/** What this machine has, and what to do about anything missing. `ok: false` on a required check blocks setup. */
export async function check() {
  const out = [];
  const add = (name, required, fn, fix) => fn().then((detail) => out.push({ name, required, ok: true, detail }), (e) => out.push({ name, required, ok: false, detail: e.message.slice(0, 160), fix }));
  const major = Number(process.versions.node.split('.')[0]);
  out.push({ name: 'Node.js 22+', required: true, ok: major >= 22, detail: `v${process.versions.node}`, fix: 'Install Node.js 22 or newer from https://nodejs.org' });
  await Promise.all([
    add('git', true, () => run('git', ['--version']), 'Install git: https://git-scm.com/downloads'),
    add('Claude Code', true, () => run('claude', ['--version']), 'Install Claude Code (https://claude.com/claude-code), then run `claude` once and log in.'),
    add('GitHub CLI', true, () => run('gh', ['--version']).then((v) => v.split('\n')[0]), 'Install the GitHub CLI: https://cli.github.com'),
    add('GitHub login', true, () => run('gh', ['api', 'user', '-q', '.login']).then((l) => `signed in as ${l}`), 'Run `gh auth login` in a terminal (scopes: repo, workflow).'),
    add('python3', false, () => run('python3', ['--version']), 'Needed only to run staging/production on this computer (deploy/local-static.sh).'),
  ]);
  const order = ['Node.js 22+', 'git', 'Claude Code', 'GitHub CLI', 'GitHub login', 'python3'];
  return out.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

/** The form's starting values: the signed-in GitHub user as owner, and the template's company and budget. */
export async function defaults() {
  const t = parseDocument(readFileSync(p('templates/org/org.yaml'), 'utf8'));
  const login = await run('gh', ['api', 'user', '-q', '.login']).catch(() => '');
  return { company: t.getIn(['company', 'name']), mission: t.getIn(['company', 'mission']), owner: login, budget: t.getIn(['capacity', 'daily_budget_usd']) };
}

export async function status() {
  const checks = await check();
  return { configured: configured(), ready: checks.every((c) => c.ok || !c.required), checks, defaults: configured() ? null : await defaults() };
}

/** Create this install's org. Refuses to overwrite an existing one. */
export async function apply({ company, mission, owner, budget }) {
  if (configured()) throw new Error('This factory is already set up (org/org.yaml exists).');
  company = String(company ?? '').trim(); owner = String(owner ?? '').trim().replace(/^@/, ''); budget = Number(budget);
  if (!company) throw new Error('Give your company a name.');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new Error('The owner must be a GitHub login, e.g. octocat.');
  if (!(budget > 0 && budget <= 10000)) throw new Error('Set a daily budget in US dollars, between 1 and 10000.');
  const missing = (await check()).filter((c) => c.required && !c.ok);
  if (missing.length) throw new Error(`Fix these first: ${missing.map((c) => c.name).join(', ')}.`);
  await run('gh', ['api', `users/${owner}`, '-q', '.login']).catch(() => { throw new Error(`GitHub has no user "${owner}".`); });

  const doc = parseDocument(readFileSync(p('templates/org/org.yaml'), 'utf8'));
  doc.setIn(['company', 'name'], company);
  if (String(mission ?? '').trim()) doc.setIn(['company', 'mission'], String(mission).trim());
  doc.setIn(['capacity', 'daily_budget_usd'], budget);
  doc.setIn(['people'], doc.createNode([{ login: owner, roles: [], vendor: true, owner: true }]));
  mkdirSync(p('org'), { recursive: true });
  cpSync(p('templates/org/policies'), p('org/policies'), { recursive: true });
  writeFileSync(p('org/org.yaml'), doc.toString());
  for (const d of ['memory/product', 'memory/decisions', 'memory/ledger', 'library']) mkdirSync(p(d), { recursive: true });
  const cfg = loadConfig(); // validates
  compileAgents();
  const M = await import('./memory.mjs');
  M.record('setup', { company, owner, budget }, { actor: owner });
  (await import('./library.mjs')).reindex(cfg);
  return { ok: true, company, owner, budget };
}
