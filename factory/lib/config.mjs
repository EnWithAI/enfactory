import { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, existsSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const p = (...parts) => path.join(HOME, ...parts);

/** Paused by a person: the dispatcher starts no new work and runs no background jobs until resumed. Running agents finish. */
export const paused = () => { try { return JSON.parse(readFileSync(p('.factory/paused.json'), 'utf8')); } catch { return null; } };
export function setPaused(on, by = 'person', extra = {}) {
  mkdirSync(p('.factory'), { recursive: true });
  if (on) writeFileSync(p('.factory/paused.json'), JSON.stringify({ since: new Date().toISOString(), by, ...extra }));
  else rmSync(p('.factory/paused.json'), { force: true });
}

/** Set up yet? A fresh install has no org/org.yaml until setup copies the template in. */
export const configured = () => existsSync(p('org/org.yaml'));

export function loadConfig() {
  if (!configured()) throw new Error('This factory is not set up yet. Open the dashboard (sf dashboard) or run: sf setup');
  // {FACTORY} in tool rules is this install's directory, so scoped Write/Edit grants work on any machine: "Write(/{FACTORY}/memory/**)".
  const cfg = parse(readFileSync(p('org/org.yaml'), 'utf8').replaceAll('{FACTORY}', HOME), { merge: true });
  const errors = [];
  for (const [name, r] of Object.entries(cfg.roles)) { // hired roles name a tool profile instead of listing tools
    if (r.profile) { if (cfg.tool_profiles?.[r.profile]) r.tools = cfg.tool_profiles[r.profile]; else errors.push(`role ${name}: unknown profile ${r.profile}`); }
  }
  for (const [stage, st] of Object.entries(cfg.pipeline)) for (const r of st.pool ?? []) if (!cfg.roles[r]) errors.push(`stage ${stage}: unknown pool role ${r}`);
  for (const [stage, st] of Object.entries(cfg.pipeline)) {
    if (!st.role && !st.system && !st.council) errors.push(`stage ${stage}: needs role, system or council`);
    if (st.role && !cfg.roles[st.role]) errors.push(`stage ${stage}: unknown role ${st.role}`);
    for (const n of st.next ?? []) {
      if (!cfg.pipeline[n] && !['done', 'rejected'].includes(n)) errors.push(`stage ${stage}: unknown next ${n}`);
    }
  }
  for (const person of cfg.people ?? []) for (const r of person.roles ?? []) if (!cfg.roles[r]) errors.push(`people.${person.login}: unknown role ${r}`);
  if (errors.length) throw new Error('org/org.yaml invalid:\n  ' + errors.join('\n  '));
  return cfg;
}

export function headcount(cfg, role) {
  const h = cfg.roles[role]?.headcount ?? 1;
  return h <= 0 ? 0 : Math.max(1, Math.round(h * (cfg.capacity?.scale ?? 1))); // 0 = released (no seats)
}

/** The person holding a role, or null when an agent holds it. */
export const holderOf = (cfg, role) => (cfg.people ?? []).find((x) => (x.roles ?? []).includes(role))?.login ?? null;
export const vendors = (cfg) => (cfg.people ?? []).filter((x) => x.vendor).map((x) => x.login);
export const owners = (cfg) => (cfg.people ?? []).filter((x) => x.owner).map((x) => x.login);

export const STAGE_ORDER = (cfg) => Object.keys(cfg.pipeline);

export function teamOf(cfg, role) {
  return Object.entries(cfg.teams).find(([, t]) => t.roles.includes(role))?.[0];
}

// Agent definitions: the stock roles ship in .claude/agents (code); hires and replacements belong to this install (org/agents) and win.
export const AGENTS_DIRS = ['.claude/agents', 'org/agents'];
export const agentFile = (role) => (existsSync(p('org/agents', `${role}.md`)) ? p('org/agents', `${role}.md`) : p('.claude/agents', `${role}.md`));
/** Where this install writes a hired or replaced agent's definition. */
export const agentTarget = (role) => { mkdirSync(p('org/agents'), { recursive: true }); return p('org/agents', `${role}.md`); };

/** Compile the agent definitions into the JSON that `claude --agents <file>` takes, so agents resolve from any cwd. */
export function compileAgents() {
  const out = {};
  for (const f of AGENTS_DIRS.flatMap((d) => (existsSync(p(d)) ? readdirSync(p(d)).filter((f) => f.endsWith('.md')).map((f) => p(d, f)) : []))) {
    const src = readFileSync(f, 'utf8');
    const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) throw new Error(`agent ${f}: missing frontmatter`);
    const fm = parse(m[1]);
    out[fm.name] = { description: fm.description, prompt: m[2].trim() };
  }
  // Content-addressed and immutable: an agent starting up never sees its definitions file change underneath it.
  mkdirSync(p('.factory'), { recursive: true });
  const json = JSON.stringify(out, null, 2);
  const file = p(`.factory/agents-${createHash('sha256').update(json).digest('hex').slice(0, 16)}.json`);
  if (!existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, json); renameSync(tmp, file);
    for (const f of readdirSync(p('.factory'))) { // prune superseded definitions older than a day (no running agent still reads them)
      const full = p('.factory', f);
      if (/^agents-[0-9a-f]{16}\.json$/.test(f) && full !== file && Date.now() - statSync(full).mtimeMs > 864e5) rmSync(full, { force: true });
    }
  }
  return file;
}
