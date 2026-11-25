// Digests: short versions of the long documents every agent would otherwise read on every run. The operating model (~40 KB)
// and team charters become one digest per team, and the product overview becomes a product brief. Stage briefs carry the
// digest inline; the full documents stay the source of truth. Regenerated only when a source changes (content hash).
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { p } from './config.mjs';
import { runAgent } from './worker.mjs';
import * as M from './memory.mjs';

const read = (f) => (existsSync(p(f)) ? readFileSync(p(f), 'utf8') : '');
const charters = () => (existsSync(p('org/charters')) ? readdirSync(p('org/charters')).filter((f) => f.endsWith('.md')).sort() : []);
const sources = () => ['org/operating-model.md', 'memory/product/overview.md', ...charters().map((f) => `org/charters/${f}`)];
const hash = () => createHash('sha256').update(sources().map((f) => `${f}\n${read(f)}`).join('\n')).digest('hex').slice(0, 16);

export const teamDigest = (team) => read(`org/digests/${team}.md`);
export const productBrief = () => read('memory/product/brief.md');
export const stale = () => !!read('org/operating-model.md') && M.kv('digests').hash !== hash();

let running = null;
/** Write the digests if a source changed. One run covers every team, so the cost is paid once per change. */
export function ensure(cfg) {
  if (running || !stale()) return running;
  const teams = Object.keys(cfg.teams);
  const KB = 4;
  running = runAgent({ cfg, role: 'chief-of-staff', label: 'digest',
    schema: { type: 'object', properties: {
      teams: { type: 'array', items: { type: 'object', properties: { team: { enum: teams }, markdown: { type: 'string' } }, required: ['team', 'markdown'] } },
      product_brief: { type: 'string' } }, required: ['teams', 'product_brief'] },
    prompt: `# Write the digests\nEvery agent run starts by reading the operating model, its team charter and the product overview. They are long, ` +
      `so each run spends steps and tokens re-reading them. Write short digests that agents read instead. The full documents remain the source of truth.\n\n` +
      `For each team (${teams.join(', ')}): at most ${KB} KB of markdown with the rules that change how that team works a stage. Include its responsibilities, ` +
      `bars and definitions of done, hand-off rules, and the org-wide rules every role must follow (decision rights, loops, evidence, releases). ` +
      `Keep rule ids (e.g. OM-10.7) so agents can look up the full text. Leave out history, rationale essays and other teams' details.\n\n` +
      `Also write a product brief: at most ${KB} KB from the product overview with what the product is, its users, the system map, environments and current constraints.\n\n` +
      `Use plain, dense bullet points. No preamble.\n\n## Operating model\n${read('org/operating-model.md')}\n\n## Team charters\n` +
      charters().map((f) => `### ${f}\n${read(`org/charters/${f}`)}`).join('\n\n') + `\n\n## Product overview\n${read('memory/product/overview.md')}`,
  }).then((r) => {
    if (!r.ok) throw new Error(r.error);
    mkdirSync(p('org/digests'), { recursive: true });
    const note = (src) => `<!-- Digest generated from ${src}. Read the full document when this one doesn't answer your question. -->\n`;
    for (const t of r.out.teams) writeFileSync(p('org/digests', `${t.team}.md`), note(`org/operating-model.md and org/charters/${t.team}.md`) + t.markdown.trim() + '\n');
    writeFileSync(p('memory/product/brief.md'), note('memory/product/overview.md') + r.out.product_brief.trim() + '\n');
    M.kv('digests', { hash: hash(), at: new Date().toISOString(), cost_usd: r.cost });
    M.record('digests_written', { teams: r.out.teams.map((t) => t.team), cost_usd: r.cost }, { actor: 'chief-of-staff' });
  }).catch((e) => console.error('digest:', e.message)).finally(() => { running = null; });
  return running;
}
