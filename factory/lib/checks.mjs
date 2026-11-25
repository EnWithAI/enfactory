// Machine checks a stage's artifact must pass before it may advance (pipeline.<stage>.checks). Rules live in org.yaml
// (quality.spec_lint), so the org changes the standard through governance, not code. Owner request #51 (COE on #35).
import { existsSync, readFileSync } from 'node:fs';
import { p } from './config.mjs';
import { events } from './memory.mjs';
const answeredRequests = () => new Map(events().filter((e) => e.type === 'answer_recorded').map((e) => [Number(e.request), e.text]));

// gh counts only in read-only forms (feedback ae04a2f3): the ones read-only roles may run, so a doc AC can be dry-run exactly as
// written. A mutating command (gh issue close, gh pr merge…) is never a verify step.
const GH_READ = String.raw`gh\s+(?:(?:issue|pr|run|repo|release)\s+(?:view|list|checks|diff)|api\s+-X\s+GET)\b`;
const CMD = new RegExp(String.raw`\`\s*(?:(?:git|grep|rg|diff|npm|npx|node|test|ls|cat|jq|sed|awk|sh|bash|find|wc|head|tail|curl|sf)\b|${GH_READ})[^\`]*\``);
const GH_ANY = /`\s*gh\s[^`]*`/;
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

/** A `key: value` tag on an AC, in any of the forms specs use: `[family: a11y]`, `(verify: e2e, family: a11y)`,
 *  `` `family: ux` · ``. The value ends at a bracket, backtick, middle dot, semicolon, newline, ". " or the next `, key:`.
 *  Only the bracket form was read before, so 45 well-formed ACs failed "no family" (rework review, 2026-11-25). */
function tag(line, key) {
  const m = line.match(new RegExp(String.raw`\b${key}:\s*([^\]\)\`·;\n]+)`, 'i'));
  return m ? m[1].split(/,\s*(?=[a-z][\w-]*:|§)/i)[0].replace(/\.(\s.*)?$/, '').trim() || undefined : undefined;
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
    // A bold `**AC-…**` header owns everything under it (its Given/When/Then bullets are not indented) until the next AC or heading.
    const header = /^\s*\*\*AC-/i.test(line);
    if (!line.trim().startsWith('|')) for (let j = i + 1; j < lines.length && !start.test(lines[j]) && !/^#{1,6}\s/.test(lines[j]) && (header || !lines[j].trim() || /^\s/.test(lines[j])); j++) line += `\n${lines[j]}`;
    let family = tag(line, 'family'), verify = tag(line, 'verify'), text = line;
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
    // Each #N is judged by its own clause, from the previous #M (or 40 characters back) to the next #M or a clause break,
    // so "#9 answered; #61 pending" doesn't flag #9 (owner request #156).
    const refs = [...l.matchAll(/(?:vendor|owner)?\s*(?:request\s*)?#(\d+)/gi)];
    refs.forEach((m, k) => {
      const ans = answered.get(Number(m[1]));
      if (!ans) return;
      const from = k ? refs[k - 1].index + refs[k - 1][0].length : Math.max(0, m.index - 40);
      let clause = l.slice(from, k + 1 < refs.length ? refs[k + 1].index : l.length);
      clause = clause.split(/[;|]|\.\s/).find((c) => c.includes(`#${m[1]}`)) ?? clause;
      if (/(pending|open|awaiting|until|unresolved|not yet answered|tbd)/i.test(clause)) failures.push(`cites #${m[1]} as pending, but the owner answered it: "${ans.replace(/\s+/g, ' ').slice(0, 120)}". Update the premise.`);
    });
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
    if (!a.family.length) failures.push(`${a.id}: no family. Tag it on the AC's own line, e.g. \`(verify: e2e, family: a11y)\`.`);
    for (const f of a.family) if (families.size && !families.has(f)) failures.push(`${a.id}: family "${f}" is not one of ${[...families].join(', ')}.`);
    if (!a.verify.length) failures.push(`${a.id}: no verify method. Tag it on the AC's own line, e.g. \`(verify: e2e, family: a11y)\`.`);
    for (const v of a.verify) if (verifies.size && !verifies.has(v)) failures.push(`${a.id}: verify "${v}" is not one of ${[...verifies].join(', ')}.`);
    // (3) a doc check states the command that proves it
    if (a.verify.includes('doc') && !CMD.test(a.line)) failures.push(GH_ANY.test(a.line)
      ? `${a.id}: verify doc uses a gh command that isn't read-only. Use gh issue|pr|run|repo|release view|list|checks|diff, or gh api -X GET.`
      : `${a.id}: verify doc needs the exact command in backticks (e.g. \`git show <S>:path | grep …\` or \`gh issue view <n> --comments\`).`);
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
  // (8, 9) Grounded in the repo docs (owner request #134, COE on #53). Only for repos that have an engineering doc.
  const docs = (cfg.product?.repos ?? []).filter((r) => existsSync(p('memory/product/repos', `${r.name}.md`)) && new RegExp(`\\b${r.name}\\b`, 'i').test(md));
  if (docs.length) {
    const sectionBy = (re) => { const i = lines.findIndex((l) => /^#{2,4}\s/.test(l) && re.test(l)); if (i < 0) return null; const j = lines.findIndex((l, k) => k > i && /^#{2,4}\s/.test(l)); return lines.slice(i + 1, j < 0 ? lines.length : j).join('\n'); };
    // (8) A closed-set AC ("exactly", "only", an allowed list of roots) says where the set comes from: the repo doc or origin/main.
    const closed = list.filter((a) => /\b(exactly|only)\b|allowed[- ]roots?/i.test(a.text));
    const provenance = sectionBy(/provenance/i);
    if (closed.length && !(provenance && /memory\/product\/repos\/|origin\/main:/.test(provenance)))
      failures.push(`${closed.map((a) => a.id).join(', ')} state a closed set ("exactly", "only" or allowed roots). Add a "Path provenance" section that cites memory/product/repos/<repo>.md or origin/main:<path> for it.`);
    // (9) §4a traces the repo's invariants, or says none apply.
    const trace4a = sectionBy(/^#{2,4}\s*§?4a\b/i) ?? '';
    if (!/repo invariant/i.test(trace4a))
      failures.push(`§4a has no "Repo invariant" row. Trace each invariant in ${docs.map((r) => `memory/product/repos/${r.name}.md`).join(', ')} that this spec touches, or add "Repo invariants: none apply (checked §n)".`);
  }
  // (4) more than max ACs needs a stated exception in §9
  if (list.length > max && !/exception|more than \d+|exceeds? \d+|>\s*\d+\s*ACs?/i.test(sec['9'] ?? '')) failures.push(`${list.length} ACs exceeds ${max}. Split the slice, or add a one-line exception with the reason in §9.`);
  return { ok: !failures.length, acs: list.length, failures };
}

/**
 * ac_evidence (owner request #69, COE on #3): a build may advance only when its "## AC → evidence" table proves every AC.
 * Each row's Status (or Result) cell must start with pass or post-deploy (verified after deploy by design). A revision restates
 * the whole table; "unchanged from the previous build" doesn't count. With the issue's spec on hand, every spec AC needs a row.
 */
export function acEvidence(md, cfg, { issue = null } = {}) {
  const lines = md.split('\n'), failures = [];
  const start = lines.findIndex((l) => /^#{2,3}\s+AC\s*(→|->|to)\s*(evidence|tests?)\b/i.test(l));
  if (start < 0) return { ok: false, failures: ['No "## AC → evidence" table. Add one row per AC: | AC | Test | Status |, with Status pass or post-deploy.'] };
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end), table = body.filter((l) => /^\s*\|/.test(l));
  if (/unchanged from the previous|same as (the )?previous|as in the previous build|as before/i.test(body.join(' ')))
    failures.push('The AC table refers to a previous build instead of restating it. Restate every row with its current test and status.');
  if (table.length < 3) return { ok: false, failures: [...failures, 'The AC → evidence section has no table rows. One row per AC: | AC | Test | Status |.'] };
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(table[0]).map((h) => h.toLowerCase()), col = head.findIndex((h) => /^(status|result)$/.test(h));
  if (col < 0) return { ok: false, failures: [...failures, 'The AC table needs a Status column (pass or post-deploy per AC), so its state is explicit.'] };
  const rows = table.slice(1).filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l)).map(cells);
  const norm = (id) => String(id).replace(/[*`]/g, '').replace(/^AC-/i, '').trim().toUpperCase();
  // pass, or explicitly verified after deploy by design; never a known gap dressed up ("partial", "fail", "missing"…).
  const GAP = /\b(partial|fail(s|ed|ing)?|missing|not (added|run|done|tested)|todo|to do|skipped?|tbd|wip|blocked)\b/i;
  const proven = (cell) => { const s = cell.replace(/[*_`]/g, '').trim(); return /^(pass(ed|es)?|done|met|✅)\b/i.test(s) || (/\bpost-deploy\b/i.test(s) && !GAP.test(s)); };
  const bad = rows.filter((r) => !proven(r[col] ?? ''));
  for (const r of bad) failures.push(`AC-${norm(r[0])} is "${(r[col] || 'blank').slice(0, 80)}", not pass. Finish it; if it can only be proven after deploy, write "post-deploy (SRE)"; if it can't be met as designed, loop back to tech-grooming.`);
  // Every AC in the spec has a row: a known gap can't disappear by leaving its row out.
  const spec = issue ? p('memory/specs', `issue-${issue}`, 'feature-grooming.md') : null;
  if (spec && existsSync(spec)) {
    const have = new Set(rows.map((r) => norm(r[0])));
    const missing = acs(readFileSync(spec, 'utf8')).map((a) => norm(a.id)).filter((id) => !have.has(id));
    if (missing.length) failures.push(`No row for ${missing.map((m) => `AC-${m}`).join(', ')}. Every AC in the spec needs a row in the table.`);
  }
  return { ok: !failures.length, failures };
}

/**
 * design_lint (owner request #100, COE on #5): a tech design states what a revision changed and which repo invariants it
 * keeps; numeric limits in §5 come with their arithmetic. The last is a warning, not a failure.
 */
export function designLint(md, cfg, { issue = null } = {}) {
  const failures = [], warnings = [];
  const revision = issue && existsSync(p('memory/specs', `issue-${issue}`, 'tech-grooming.v1.md'));
  if (revision && !/^#{1,4}\s.*delta impact/im.test(md)) failures.push('This is a revision of the design: add a "Delta impact" section saying what changed since the last version and what it affects.');
  if (!/^#{1,4}\s.*repo invariants honou?red/im.test(md)) failures.push('Add a "Repo invariants honoured" section: the invariants from the repo docs this design keeps (or the ADR that changes one).');
  const lines = md.split('\n'), s5 = lines.findIndex((l) => /^#{2,4}\s*§?5\b/.test(l));
  if (s5 >= 0) for (let i = s5 + 1; i < lines.length && !/^#{2,4}\s/.test(lines[i]); i++) {
    if (/^\s*\|/.test(lines[i]) && /\d+[- ](code[- ]?points?|chars?|characters?|emoji|bytes?|digits?|ms|seconds?)\b/i.test(lines[i]) && !/[=≤≥<>]/.test(lines[i]))
      warnings.push(`§5 line ${i + 1} states a numeric boundary without its arithmetic (=, ≤): "${lines[i].trim().slice(0, 90)}"`);
  }
  return { ok: !failures.length, failures, warnings };
}

export const CHECKS = { spec_lint: specLint, ac_evidence: acEvidence, design_lint: designLint };

/** Run a stage's declared checks against its artifact. `ctx.issue` lets a check read the issue's other artifacts. */
export function runChecks(names, md, cfg, ctx = {}) {
  const failures = [], warnings = [];
  for (const name of names ?? []) {
    const fn = CHECKS[name];
    if (!fn) { failures.push(`unknown check "${name}"`); continue; }
    const r = fn(md, cfg, ctx);
    if (!r.ok) failures.push(...r.failures.map((f) => `[${name}] ${f}`));
    warnings.push(...(r.warnings ?? []).map((w) => `[${name}] ${w}`));
  }
  return { ok: !failures.length, failures, warnings };
}

/** For the CLI: lint the current artifact of a stage for an issue. */
export function lintIssue(n, stage, cfg) {
  const f = p('memory/specs', `issue-${n}`, `${stage}.md`);
  if (!existsSync(f)) throw new Error(`no ${stage} artifact for #${n}`);
  return runChecks(cfg.pipeline[stage]?.checks ?? { build: ['ac_evidence'], 'tech-grooming': ['design_lint'] }[stage] ?? ['spec_lint'], readFileSync(f, 'utf8'), cfg, { issue: n });
}
