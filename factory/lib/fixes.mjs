// Fixes a person can apply from the request and complaint box with one click. The chief of staff proposes one; the owner
// applies or declines it. Only these kinds exist, each within hard limits, so a click can never grant more than read-only
// commands or writes inside this install's memory/ (or a role's own /tmp scratch folder). Anything else needs factory code.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { parseDocument, parse } from 'yaml';
import { p, loadConfig } from './config.mjs';

export const KINDS = ['grant_tools', 'scoped_write', 'lint_family', 'lesson', 'doc_edit', 'factory_code'];

/** Read-only tools a click may grant. Never git -C, cd, scripts, package installs or bare Bash. */
export const SAFE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  ...['git log:*', 'git diff:*', 'git show:*', 'git status:*', 'git branch -r', 'git branch -a', 'git rev-parse:*',
    'npm view:*', 'npm ls:*', 'gitleaks version', 'node --version', 'pip index versions:*',
    'gh issue view:*', 'gh issue list:*', 'gh pr view:*', 'gh pr diff:*', 'gh pr checks:*', 'gh run list:*', 'gh run view:*',
    'gh repo view:*', 'gh api -X GET:*', 'gh label list:*', 'gh search issues:*',
    'sf recall:*', 'sf memory:*', 'sf lint:*', 'sf contrast:*', 'ls:*'].map((c) => `Bash(${c})`)]);

// Writable places: this install's memory, except the records only the dispatcher may write; or a role's /tmp scratch folder.
const MEMORY_PATH = /^memory\/(?!ledger\/|state\/|hr\/|decisions\/|runs\/)[A-Za-z0-9_.*-]+(\/[A-Za-z0-9_.*-]+)*$/;
const TMP_PATH = /^\/tmp\/[a-z][a-z0-9-]{1,30}\/\*\*$/;
const DOC_PATH = /^(org\/charters\/[a-z0-9-]+\.md|org\/operating-model\.md|org\/policies\/[a-z0-9-]+\.md|library\/[a-z0-9-]+(\/[a-z0-9-]+)*\.md)$/;

/** The proposal's schema, for the chief of staff's structured output. */
export const FIX_SCHEMA = {
  type: 'object',
  description: 'Optional: one concrete fix the owner can apply with one click. Use factory_code when the fix needs new factory code.',
  properties: {
    kind: { enum: KINDS },
    role: { type: 'string', description: 'grant_tools / scoped_write / lesson: the role (lesson also takes "all")' },
    tools: { type: 'array', items: { type: 'string' }, description: `grant_tools: exact tool strings from this list only: ${[...SAFE_TOOLS].join(', ')}` },
    paths: { type: 'array', items: { type: 'string' }, description: 'scoped_write: paths relative to the factory, under memory/ (not ledger, state, hr, decisions or runs), e.g. "memory/specs/**"; or "/tmp/<name>/**"' },
    families: { type: 'array', items: { type: 'string' }, description: 'lint_family: new spec_lint family names (lowercase)' },
    text: { type: 'string', description: 'lesson: the checkable rule' },
    file: { type: 'string', description: 'doc_edit: org/charters/<team>.md, org/operating-model.md, org/policies/<name>.md or library/<folder>/<doc>.md' },
    find: { type: 'string', description: 'doc_edit: exact text that occurs once in the file' },
    replace: { type: 'string', description: 'doc_edit: the replacement text' },
    brief: { type: 'string', description: 'factory_code: a self-contained task for an engineer changing the factory: the problem, the evidence, the change wanted, how to test it' },
  },
  required: ['kind'],
};

/** Check a proposal against the limits. Returns { ok, error, summary }. */
export function validate(fix, cfg = loadConfig()) {
  const bad = (error) => ({ ok: false, error });
  if (!fix || !KINDS.includes(fix.kind)) return bad('No fix to apply.');
  const role = fix.role;
  switch (fix.kind) {
    case 'grant_tools': {
      if (!cfg.roles[role]) return bad(`"${role}" is not a role.`);
      const off = (fix.tools ?? []).filter((t) => !SAFE_TOOLS.has(t));
      if (!fix.tools?.length) return bad('No tools named.');
      if (off.length) return bad(`Not on the read-only list, so it can't be granted from the dashboard: ${off.join(', ')}`);
      return { ok: true, summary: `Grant ${role}: ${fix.tools.join(', ')}` };
    }
    case 'scoped_write': {
      if (!cfg.roles[role]) return bad(`"${role}" is not a role.`);
      const off = (fix.paths ?? []).filter((x) => x.includes('..') || !(MEMORY_PATH.test(x) || TMP_PATH.test(x)));
      if (!fix.paths?.length) return bad('No paths named.');
      if (off.length) return bad(`Outside what the dashboard may grant (memory/ except ledger, state, hr, decisions, runs; or /tmp/<name>/**): ${off.join(', ')}`);
      return { ok: true, summary: `Let ${role} write and edit: ${fix.paths.join(', ')}` };
    }
    case 'lint_family': {
      const off = (fix.families ?? []).filter((f) => !/^[a-z][a-z-]{1,20}$/.test(f));
      if (!fix.families?.length || off.length) return bad(`Family names must be lowercase words: ${off.join(', ')}`);
      return { ok: true, summary: `Add spec_lint families: ${fix.families.join(', ')}` };
    }
    case 'lesson': {
      if (role !== 'all' && !cfg.roles[role]) return bad(`"${role}" is not a role (or "all").`);
      if (!fix.text?.trim() || fix.text.length > 1200) return bad('A lesson needs a rule of at most 1200 characters.');
      return { ok: true, summary: `Lesson for ${role === 'all' ? 'every role' : role}` };
    }
    case 'doc_edit': {
      if (!DOC_PATH.test(fix.file ?? '') || !existsSync(p(fix.file))) return bad(`Not an editable document: ${fix.file}`);
      const src = readFileSync(p(fix.file), 'utf8'), hits = fix.find ? src.split(fix.find).length - 1 : 0;
      if (hits !== 1) return bad(`The text to replace occurs ${hits} times in ${fix.file}; it must occur exactly once.`);
      if ((fix.replace ?? '').length > 4000) return bad('The replacement is too long for a one-click edit.');
      return { ok: true, summary: `Edit ${fix.file}` };
    }
    case 'factory_code': return bad('This needs a change to the factory code. Copy the brief for Claude Code.');
  }
}

/** Apply a validated fix. Config changes are checked by loading the org again and undone if invalid. Returns the summary. */
export function apply(fix, { by = 'owner', item = '' } = {}) {
  const cfg = loadConfig();
  const v = validate(fix, cfg);
  if (!v.ok) throw new Error(v.error);
  const note = `_(feedback ${item})_`;
  if (fix.kind === 'lesson') {
    mkdirSync(p('memory/lessons'), { recursive: true });
    appendFileSync(p('memory/lessons', `${fix.role}.md`), `- ${fix.text.trim().replace(/\n+/g, ' ')} ${note}\n`);
    return v.summary;
  }
  if (fix.kind === 'doc_edit') {
    const src = readFileSync(p(fix.file), 'utf8');
    writeFileSync(p(fix.file), src.replace(fix.find, fix.replace));
    return v.summary;
  }
  const raw = readFileSync(p('org/org.yaml'), 'utf8');
  const doc = parseDocument(raw);
  if (fix.kind === 'lint_family') {
    const seq = doc.getIn(['quality', 'spec_lint', 'families']);
    for (const f of fix.families) if (!seq.items.some((i) => (i.value ?? i) === f)) seq.add(f);
  } else {
    // The role's current list, resolved from an alias or a tool profile, with {FACTORY} kept as written.
    const plain = parse(raw, { merge: true }), r = plain.roles[fix.role];
    const current = r.profile ? plain.tool_profiles?.[r.profile] ?? [] : r.tools ?? [];
    const add = fix.kind === 'grant_tools' ? fix.tools
      : fix.paths.flatMap((x) => (x.startsWith('/tmp/') ? [`Write(/${x})`, `Edit(/${x})`, `Write(//private${x})`, `Edit(//private${x})`] : [`Write(/{FACTORY}/${x})`, `Edit(/{FACTORY}/${x})`]));
    doc.setIn(['roles', fix.role, 'tools'], doc.createNode([...new Set([...current, ...add])]));
    if (r.profile) doc.deleteIn(['roles', fix.role, 'profile']);
  }
  writeFileSync(p('org/org.yaml'), doc.toString());
  try { loadConfig(); } catch (e) { writeFileSync(p('org/org.yaml'), raw); throw new Error(`Undone, the org config would be invalid: ${e.message}`); }
  return v.summary;
}
