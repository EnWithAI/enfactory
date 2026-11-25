// The shared brain. Every agent reads it, and only the dispatcher writes it (single writer = no races).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { p } from './config.mjs';

const month = () => new Date().toISOString().slice(0, 7);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** Append one event to the ledger. Everything that happens in the factory goes through here. */
export function record(type, data = {}, { actor = 'dispatcher', issue = null } = {}) {
  const ev = { id: randomUUID(), ts: new Date().toISOString(), type, actor, issue, ...data };
  mkdirSync(p('memory/ledger'), { recursive: true });
  appendFileSync(p('memory/ledger', `${month()}.jsonl`), JSON.stringify(ev) + '\n');
  return ev;
}

export function events({ since } = {}) {
  const dir = p('memory/ledger');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()
    .flatMap((f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => !since || e.ts >= since);
}

/** Write an ADR. IDs are timestamps, not sequence numbers, so parallel runs never collide. */
export function decide({ title, decision, rationale, alternatives = '', supersedes = '' }, { actor, issue = null, scope = 'issue' } = {}) {
  const id = `${stamp()}-${slug(title)}`;
  const file = write(p('memory/decisions', `${id}.md`), [
    '---', `id: ${id}`, `title: ${JSON.stringify(title)}`, `status: accepted`, `by: ${actor}`,
    `issue: ${issue ?? ''}`, `scope: ${scope}`, `supersedes: ${supersedes}`, `date: ${new Date().toISOString()}`, '---',
    `# ${title}`, '', '## Decision', decision, '', '## Rationale', rationale, '',
    '## Alternatives considered', alternatives || '_none recorded_', '',
  ].join('\n'));
  record('decision', { adr: id, title }, { actor, issue });
  return path.relative(p(), file);
}

export function learn(text, { actor, issue = null } = {}) {
  appendFileSync(p('memory/knowledge/learnings.md'), `- ${text} _(${actor}${issue ? `, #${issue}` : ''}, ${new Date().toISOString().slice(0, 10)})_\n`);
  record('learning', { text }, { actor, issue });
}

/** Save a stage artifact. An existing version is kept as <stage>.v<N>.md, so a later run never destroys earlier work. */
export function saveArtifact(issue, stage, markdown) {
  const file = p('memory/specs', `issue-${issue}`, `${stage}.md`);
  if (existsSync(file)) {
    let v = 1;
    while (existsSync(p('memory/specs', `issue-${issue}`, `${stage}.v${v}.md`))) v++;
    renameSync(file, p('memory/specs', `issue-${issue}`, `${stage}.v${v}.md`));
  }
  return path.relative(p(), write(file, markdown));
}

export function writeDoc(rel, markdown) { return path.relative(p(), write(p(rel), markdown)); }

export function saveThread(name, markdown) {
  return path.relative(p(), write(p('memory/threads', `${name}.md`), markdown));
}

export function saveRun(issue, role, result) {
  return write(p('memory/runs', new Date().toISOString().slice(0, 10), `${issue ?? 'org'}-${role}-${stamp()}.json`),
    JSON.stringify(result, null, 2));
}

// Per-issue working state (pr number, risk tier, loop count, pending gate). Lives with memory so it is versioned.
export function issueState(n) {
  const f = p('memory/state', `issue-${n}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { loops: 0, history: [] };
}
export function saveIssueState(n, s) { write(p('memory/state', `issue-${n}.json`), JSON.stringify(s, null, 2)); }
export function kv(name, value) {
  const f = p('memory/state', `${name}.json`);
  if (value === undefined) return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  write(f, JSON.stringify(value, null, 2));
}

/** Keyword search across every markdown and jsonl file in memory. Used by agents through `sf recall`. */
export function recall(query, limit = 15) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const hits = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir)) {
      const full = path.join(dir, f);
      if (statSync(full).isDirectory()) { if (!['runs', 'state'].includes(f)) walk(full); continue; }
      if (!/\.(md|jsonl)$/.test(f)) continue;
      const chunks = f.endsWith('.jsonl') ? readFileSync(full, 'utf8').split('\n') : readFileSync(full, 'utf8').split(/\n(?=#{1,3} |- )/);
      for (const c of chunks) {
        const lc = c.toLowerCase();
        const score = terms.reduce((s, t) => s + (lc.includes(t) ? 1 : 0), 0);
        if (score) hits.push({ score, file: path.relative(p(), full), text: c.trim().slice(0, 400) });
      }
    }
  };
  walk(p('memory'));
  if (existsSync(p('org'))) walk(p('org'));
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function issueDossier(n) {
  const dir = p('memory/specs', `issue-${n}`);
  const artifacts = existsSync(dir) ? readdirSync(dir).map((f) => `memory/specs/issue-${n}/${f}`) : [];
  const evs = events().filter((e) => String(e.issue) === String(n));
  return { state: issueState(n), artifacts, events: evs.map(({ ts, type, actor, stage, to, outcome, summary, adr, title }) =>
    ({ ts, type, actor, stage, to, outcome, adr, title, summary: summary?.slice(0, 300) })) };
}
