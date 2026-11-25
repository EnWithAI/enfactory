// Machine checks a stage's artifact must pass before it may advance (pipeline.<stage>.checks). Rules live in org.yaml
// (quality.spec_lint), so the org changes the standard through governance, not code. Owner request #51 (COE on #35).
import { existsSync, readFileSync } from 'node:fs';
import { p } from './config.mjs';
import { events } from './memory.mjs';
const answeredRequests = () => new Map(events().filter((e) => e.type === 'answer_recorded').map((e) => [Number(e.request), e.text]));

const CMD = /`\s*(git|grep|rg|diff|npm|npx|node|test|ls|cat|jq|sed|awk|sh|bash|find|wc|head|tail|curl|sf)\b[^`]*`/;
const split = (v) => String(v ?? '').toLowerCase().split(/[+,|/]|\s+and\s+/).map((x) => x.replace(/[`*\[\]]/g, '').trim()).filter(Boolean);

/** Sections by their "## n." heading number (or name), with their text. */
function sections(md) {
  const out = {};
  let key = '_', buf = [];
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(?:§?(\d+[a-z]?)\.?\s*)?(.*)$/);
    if (h) { out[key] = buf.join('\n'); key = (h[1] ?? h[2]).toLowerCase().trim(); buf = []; } else buf.push(line);
  }
  out[key] = buf.join('\n');
  return out;
}

/** Acceptance criteria in either house format: table rows `| **AC-n-m** | text | family | verify |` or bullets with [family:]/[verify:] tags. */
function acs(md) {
  const rows = [];
  const lines = md.split('\n'), start = /^\s*(?:\||[-*])\s*\*{0,2}(AC-\d+-[0-9a-z]+)\b/i;
  // Only the AC registry defines ACs (owner request #24): self-checks, deltas and notes that mention an AC are not definitions.
  const reg = lines.findIndex((l) => /^#{1,3}\s.*(acceptance criteria|ac registry)/i.test(l));
  const lvl = reg >= 0 ? lines[reg].match(/^#+/)[0].length : 0;
  const end = reg >= 0 ? lines.findIndex((l, i) => i > reg && new RegExp(`^#{1,${lvl}}\\s`).test(l)) : -1;
  const [from, to] = reg >= 0 ? [reg + 1, end < 0 ? lines.length : end] : [0, lines.length];
  for (let i = from; i < to; i++) {
    const id = lines[i].match(start)?.[1];
    if (!id) continue;
    let line = lines[i];
    // A bullet AC runs on through its indented lines (blank lines included) until the next AC, a heading, or an unindented line.
    if (!line.trim().startsWith('|')) for (let j = i + 1; j < lines.length && !start.test(lines[j]) && !/^#{1,6}\s/.test(lines[j]) && (!lines[j].trim() || /^\s/.test(lines[j])); j++) line += `\n${lines[j]}`;
    let family = line.match(/\[family:\s*([^\]]+)\]/i)?.[1], verify = line.match(/\[verify:\s*([^\]]+)\]/i)?.[1], text = line;
    if (line.trim().startsWith('|') && (!family || !verify)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length >= 4) { text = cells[1]; family ??= cells[2]; verify ??= cells[3]; }
    }
    rows.push({ id, line, text, family: split(family), verify: split(verify), at: i + 1 });
  }
  return rows;
}

/** spec_lint: requirement traceability, enum conformance, doc-check commands, and the AC-count exception. */
export function specLint(md, cfg) {
  const rules = cfg.quality?.spec_lint ?? {};
  const families = new Set(rules.families ?? []), verifies = new Set(rules.verify ?? []), max = rules.max_acs ?? 12;
  const sec = sections(md), list = acs(md), failures = [];
  if (!list.length) return { ok: false, failures: ['No acceptance criteria found. Use AC-<issue>-<nn> rows in the AC registry (§4).'] };

  // Duplicate AC ids, with line numbers (owner request #24)
  const byId = {};
  for (const a of list) (byId[a.id.toUpperCase()] ??= []).push(a.at);
  for (const [id, at] of Object.entries(byId)) if (at.length > 1) failures.push(`${id} is defined ${at.length} times, at lines ${at.join(' and ')}.`);
  // Premises: a vendor or owner request the owner has answered must not be cited as pending (owner request #22)
  const answered = answeredRequests();
  for (const l of md.split('\n')) {
    for (const [, n] of l.matchAll(/(?:vendor|owner)?\s*(?:request\s*)?#(\d+)/gi)) {
      const ans = answered.get(Number(n));
      if (ans && /(pending|open|awaiting|until|unresolved|not yet answered|tbd)/i.test(l)) failures.push(`cites #${n} as pending, but the owner answered it: "${ans.replace(/\s+/g, ' ').slice(0, 120)}". Update the premise.`);
    }
  }
  const trace = md.split('\n').filter((l) => /AC-\d+-/.test(l) && /US-\d+|`[^`]+`/.test(l) && !list.some((a) => a.line === l)); // §4a-style trace rows
  const thenText = list.map((a) => (a.text.split(/\*{0,2}then\*{0,2}/i).slice(1).join(' ') || a.text)).join('\n');
  const covered = (needle) => thenText.includes(needle) || list.some((a) => a.text.includes(needle)) || trace.some((l) => l.includes(needle) && /AC-\d+-[0-9a-z]+/i.test(l));

  // (1) every user story and every backticked §1 item is traced to an AC
  for (const us of new Set(md.match(/\bUS-\d+\b/g) ?? [])) if (!covered(us)) failures.push(`${us} is not referenced by any AC row or §4a trace row. Add an AC that covers it, or a trace row "${us} → AC-…".`);
  for (const line of (sec['1'] ?? '').split('\n').filter((l) => /^\s*[-*]\s/.test(l))) {
    for (const [, sym] of line.matchAll(/`([^`]+)`/g)) if (!covered(sym)) failures.push(`§1 item \`${sym}\` ("${line.trim().slice(0, 80)}") does not appear in any AC's Then clause or a §4a trace row.`);
  }
  // (2) family and verify values come from the org's lists
  for (const a of list) {
    if (!a.family.length) failures.push(`${a.id}: no family.`);
    for (const f of a.family) if (families.size && !families.has(f)) failures.push(`${a.id}: family "${f}" is not one of ${[...families].join(', ')}.`);
    if (!a.verify.length) failures.push(`${a.id}: no verify method.`);
    for (const v of a.verify) if (verifies.size && !verifies.has(v)) failures.push(`${a.id}: verify "${v}" is not one of ${[...verifies].join(', ')}.`);
    // (3) a doc check states the command that proves it
    if (a.verify.includes('doc') && !CMD.test(a.line)) failures.push(`${a.id}: verify doc needs the exact command in backticks (e.g. \`git show <S>:path | grep …\`).`);
  }
  // (5) every success metric names its data source (owner request #15)
  const lines = md.split('\n');
  const mStart = lines.findIndex((l) => /success metrics?/i.test(l) && (/^#{2,4}\s/.test(l) || /^\s*[-*]?\s*\*\*[^*]*success metrics?/i.test(l)));
  if (mStart >= 0) {
    for (let i = mStart + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^#{2,4}\s/.test(l) || /^\s*\*\*[^*]+\*\*\s*$/.test(l)) break; // next heading or label ends the metrics list
      if (/^\s*[-*]\s/.test(l) && !/source:/i.test(l) && !/`[^`]+`/.test(l)) failures.push(`§6 metric has no data source: "${l.trim().slice(0, 90)}". Add "source: <CI check, path or command>".`);
    }
  }
  // (6) a doc-grep alternation over AC IDs must list exactly the ACs in the §4c table
  const c4 = lines.findIndex((l) => /^#{2,4}\s*(§)?4c\b/i.test(l));
  if (c4 >= 0) {
    const set4c = new Set();
    for (let i = c4 + 1; i < lines.length && !/^#{2,4}\s/.test(lines[i]); i++) for (const [, id] of lines[i].matchAll(/^\|\s*\d+\s*\|\s*(AC-\d+-[0-9a-z]+)/gi)) set4c.add(id.toUpperCase());
    if (set4c.size) for (const a of list.filter((x) => x.verify.includes('doc'))) {
      for (const [, pre, alts] of a.line.matchAll(/(AC-\d+-)\(([^)]+)\)/g)) {
        const set = new Set(alts.split('|').map((x) => `${pre}${x}`.toUpperCase()));
        const missing = [...set4c].filter((x) => !set.has(x)), extra = [...set].filter((x) => !set4c.has(x));
        if (missing.length || extra.length) failures.push(`${a.id}: its grep lists ${[...set].join('|')} but §4c lists ${[...set4c].join('|')}${missing.length ? ` (missing ${missing.join(', ')})` : ''}${extra.length ? ` (not in §4c: ${extra.join(', ')})` : ''}.`);
      }
    }
  }
  // (7) a negative control states an exact count
  for (const a of list) if (/negative control/i.test(a.line) && /(≥|>=|at least)\s*\d+\s*(?:\w+\s+){0,2}hits?\b/i.test(a.line.split(/\*{0,2}then\*{0,2}/i).slice(1).join(' ') || a.line)) failures.push(`${a.id}: a negative control must state an exact count, not "≥" or "at least".`);
  // (4) more than max ACs needs a stated exception in §9
  if (list.length > max && !/exception|more than \d+|exceeds? \d+|>\s*\d+\s*ACs?/i.test(sec['9'] ?? '')) failures.push(`${list.length} ACs exceeds ${max}. Split the slice, or add a one-line exception with the reason in §9.`);
  return { ok: !failures.length, acs: list.length, failures };
}

export const CHECKS = { spec_lint: specLint };

/** Run a stage's declared checks against its artifact. */
export function runChecks(names, md, cfg) {
  const failures = [];
  for (const name of names ?? []) {
    const fn = CHECKS[name];
    if (!fn) { failures.push(`unknown check "${name}"`); continue; }
    const r = fn(md, cfg);
    if (!r.ok) failures.push(...r.failures.map((f) => `[${name}] ${f}`));
  }
  return { ok: !failures.length, failures };
}

/** For the CLI: lint the current artifact of a stage for an issue. */
export function lintIssue(n, stage, cfg) {
  const f = p('memory/specs', `issue-${n}`, `${stage}.md`);
  if (!existsSync(f)) throw new Error(`no ${stage} artifact for #${n}`);
  return runChecks(cfg.pipeline[stage]?.checks ?? ['spec_lint'], readFileSync(f, 'utf8'), cfg);
}
