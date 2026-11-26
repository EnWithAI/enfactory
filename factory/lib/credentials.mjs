// Which Claude credential each agent runs on: an org default plus optional per-role overrides.
// Secrets live outside the repo (~/.config/enfactory/credentials.json, mode 600) and never reach the ledger, the
// dashboard or an issue: the dashboard only ever sees a label, the kind and the last four characters.
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// token: a Claude subscription token (`claude setup-token`); api_key: an Anthropic Console API key.
export const KINDS = { token: 'CLAUDE_CODE_OAUTH_TOKEN', api_key: 'ANTHROPIC_API_KEY' };
const AUTH_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/;

export const file = () => process.env.SF_CREDENTIALS_FILE ?? path.join(homedir(), '.config', 'enfactory', 'credentials.json');

export function load() {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8'));
    return { profiles: j.profiles ?? {}, default: j.default ?? null, agents: j.agents ?? {} };
  } catch { return { profiles: {}, default: null, agents: {} }; }
}

function save(c) {
  const f = file();
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  renameSync(tmp, f); chmodSync(f, 0o600);
}

/** What the dashboard may show: never the secret. */
export function view(c = load()) {
  return {
    default: c.default, agents: c.agents,
    profiles: Object.entries(c.profiles).map(([id, x]) => ({ id, label: x.label, kind: x.kind, hint: `…${String(x.secret).slice(-4)}`, added: x.added })),
  };
}

/** The profile a role runs on: its own if set, else the org default, else null (the claude login on this machine). */
export function profileFor(role, c = load()) {
  const id = c.agents[role] ?? c.default;
  return id && c.profiles[id] ? { id, ...c.profiles[id] } : null;
}

/** Set the auth variables for one run. With no profile the run keeps the machine's own login, unchanged. */
export function applyTo(env, prof) {
  if (!prof) return env;
  for (const k of Object.keys(env)) if (AUTH_ENV.test(k)) delete env[k]; // the CLI prefers an API key over a token, so clear both first
  env[KINDS[prof.kind]] = prof.secret;
  return env;
}

/** Changes from the dashboard. Each returns the new view. */
export function change(a, roles = []) {
  const c = load();
  if (a.action === 'add') {
    const label = String(a.label ?? '').trim().slice(0, 60), secret = String(a.secret ?? '').trim();
    if (!label) throw new Error('Give it a name, e.g. "Team subscription" or "Console key".');
    if (!KINDS[a.kind]) throw new Error('Choose subscription token or API key.');
    if (secret.length < 20 || /\s/.test(secret)) throw new Error('That does not look like a token or key.');
    if (a.kind === 'api_key' && !secret.startsWith('sk-ant-api')) throw new Error('An Anthropic API key starts with sk-ant-api.');
    if (a.kind === 'token' && !secret.startsWith('sk-ant-oat')) throw new Error('A subscription token (from `claude setup-token`) starts with sk-ant-oat.');
    const id = randomUUID().slice(0, 8);
    c.profiles[id] = { label, kind: a.kind, secret, added: new Date().toISOString() };
    if (a.makeDefault || !c.default) c.default = id;
    save(c); return { ...view(c), added: id };
  }
  const known = (id) => id == null || id === '' || c.profiles[id];
  if (a.action === 'remove') {
    if (!c.profiles[a.id]) throw new Error('No such credential.');
    delete c.profiles[a.id];
    if (c.default === a.id) c.default = null;
    for (const [r, id] of Object.entries(c.agents)) if (id === a.id) delete c.agents[r]; // those roles fall back to the default
  } else if (a.action === 'default') {
    if (!known(a.id)) throw new Error('No such credential.');
    c.default = a.id || null;
  } else if (a.action === 'assign') {
    if (!roles.includes(a.role)) throw new Error(`There is no role called ${a.role}.`);
    if (!known(a.id)) throw new Error('No such credential.');
    if (a.id) c.agents[a.role] = a.id; else delete c.agents[a.role];
  } else throw new Error('Unknown action.');
  save(c); return view(c);
}
