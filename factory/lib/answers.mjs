// Owner answers. People answer on GitHub (vendor and owner request issues) or from the dashboard; agents read memory/product/answers.md.
// This keeps the two in step (owner requests #22/#23): every person's answer is appended to answers.md, earlier assumptions that
// depended on it are marked STALE, and the latest answers are recorded in the ledger for every stage prompt.
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { p } from './config.mjs';
import * as M from './memory.mjs';
import * as T from './tracker.mjs';

const FILE = p('memory/product/answers.md');

/** Record one answer from a person on request #n. Returns the lines marked stale. */
export function record({ n, title, text, by = 'owner', at = new Date().toISOString() }) {
  mkdirSync(p('memory/product'), { recursive: true });
  const day = at.slice(0, 10);
  appendFileSync(FILE, `\n## Request #${n}: ${title.replace(/^\[(vendor|owner)\]\s*/, '')}\n${text.trim()}\n<sub>${by}, #${n}, ${day}. This answer overrides any earlier assumption about #${n}.</sub>\n`);
  // Earlier lines that assumed something "until #n" are now stale.
  const lines = readFileSync(FILE, 'utf8').split('\n'), stale = [];
  const pat = new RegExp(`(assumed until (vendor request )?#${n}\\b|assumed-until:#${n}\\b|vendor (request )?#${n}\\b)`, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (pat.test(lines[i]) && !lines[i].includes('[STALE') && !lines[i].startsWith(`## Request #${n}:`)) {
      lines[i] += ` **[STALE: owner answered #${n} on ${day}: "${text.trim().replace(/\s+/g, ' ').slice(0, 120)}". The product owner amends this.]**`;
      stale.push(i + 1);
    }
  }
  if (stale.length) writeFileSync(FILE, lines.join('\n'));
  current();
  M.record('answer_recorded', { request: n, title: title.slice(0, 160), text: text.trim().slice(0, 600), stale_lines: stale }, { actor: by });
  return stale;
}

/**
 * answers.md without the assumptions people have since overridden (lines marked STALE). Agents read this one: the full
 * file is the audit trail, and its stale lines cost every reader tokens and invite the wrong answer.
 */
export function current() {
  const src = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
  const out = src.split('\n').filter((l) => !l.includes('[STALE')).join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(p('memory/product/answers.current.md'), `<!-- Generated from answers.md without superseded (STALE) lines. Edit answers.md, not this file. -->\n${out}`);
  return out;
}

/** The latest owner answers, newest first, for stage prompts and checks. */
export function latest(limit = 12) {
  return M.events().filter((e) => e.type === 'answer_recorded').reverse().slice(0, limit);
}
export function answered() { return new Map(M.events().filter((e) => e.type === 'answer_recorded').map((e) => [Number(e.request), e.text])); }

/**
 * Pull people's answers from GitHub into answers.md: every human comment on a vendor or owner request that hasn't been recorded yet.
 * Covers answers given in the dashboard and directly on GitHub. Idempotent (tracks the last recorded comment per issue).
 */
export async function sync(cfg) {
  if (!cfg.product?.tracker) return 0;
  const seen = M.kv('answers-sync');
  let n = 0;
  for (const label of ['sf-vendor-request', 'sf-owner-request']) {
    const list = await T.gh(['issue', 'list', '-R', cfg.product.tracker, '--state', 'all', '--label', label, '--limit', '100', '--json', 'number,title,comments,state,stateReason,closedAt'])
      .then((o) => JSON.parse(o || '[]')).catch(() => []);
    for (const i of list) {
      const human = (i.comments ?? []).filter((c) => !c.body.includes(T.MARK) && !/^\*\*Also requested\*\*/.test(c.body) && c.createdAt > (seen[i.number] ?? ''));
      // Closed with no comment still answers it (owner request #155): "assumed until #N" lines go stale when #N closes.
      if (!human.length && i.state === 'CLOSED' && !seen[i.number] && i.closedAt) {
        record({ n: i.number, title: i.title, text: `Closed as ${String(i.stateReason || 'completed').toLowerCase().replace('_', ' ')} without a comment.`, by: 'owner', at: i.closedAt });
        seen[i.number] = i.closedAt; n++;
        continue;
      }
      if (!human.length) continue;
      record({ n: i.number, title: i.title, text: human.map((c) => c.body).join('\n\n'), by: human.at(-1).author?.login ?? 'owner', at: human.at(-1).createdAt });
      seen[i.number] = human.at(-1).createdAt; n++;
    }
  }
  if (n) M.kv('answers-sync', seen);
  return n;
}
