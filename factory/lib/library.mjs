// The documents library. The organisation decides the folder structure (org.yaml → library.folders, amendable by governance);
// agents publish readable documents into those folders; every folder keeps an index and every document follows the standard.
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseDocument, parse } from 'yaml';
import { p, loadConfig } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import * as M from './memory.mjs';

const LIB = 'library';

/** Front-matter + body. */
export function parseDoc(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { meta: parse(m[1]) ?? {}, body: m[2] } : { meta: {}, body: src };
}

/** Publish one document into an org-defined folder. Returns the relative path, or throws if the folder isn't in the structure. */
export function publish(cfg, { folder, title, summary, audience, markdown, kind }, { actor, issue = null }) {
  const folders = (cfg.library?.folders ?? []).map((f) => f.path);
  if (!folders.includes(folder)) throw new Error(`"${folder}" is not a library folder (${folders.join(', ')}). Propose new folders via process_proposal.`);
  const file = `${LIB}/${folder}/${M.slug(title)}.md`;
  const prev = existsSync(p(file)) ? parseDoc(readFileSync(p(file), 'utf8')).meta : null;
  const meta = { title, summary, audience: audience ?? '', kind: kind ?? '', author: actor, issue: issue ?? '', updated: new Date().toISOString(),
    created: prev?.created ?? new Date().toISOString(), version: (prev?.version ?? 0) + 1, contributors: [...new Set([...(prev?.contributors ?? []), actor])] };
  mkdirSync(p(LIB, folder), { recursive: true });
  const fm = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  writeFileSync(p(file), `---\n${fm}\n---\n${markdown.trim()}\n`);
  reindex(cfg);
  M.record('published', { doc: file, title, folder, version: meta.version }, { actor, issue });
  return file;
}

/** Regenerate every folder's README index and the library INDEX.md from the documents on disk. */
export function reindex(cfg = loadConfig()) {
  const folders = cfg.library?.folders ?? [];
  const rows = [];
  for (const f of folders) {
    const dir = p(LIB, f.path);
    mkdirSync(dir, { recursive: true });
    const docs = readdirSync(dir).filter((x) => x.endsWith('.md') && !['README.md', '_TEMPLATE.md'].includes(x))
      .map((x) => ({ file: x, ...parseDoc(readFileSync(path.join(dir, x), 'utf8')).meta })).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    writeFileSync(path.join(dir, 'README.md'), [`# ${f.title}`, '', f.purpose ?? '', '', `**Owner:** ${f.owner ?? '—'} · **Holds:** ${(f.doc_types ?? []).join(', ') || '—'}`, '',
      docs.length ? '| Document | Summary | Author | Updated |\n|---|---|---|---|' : '_No documents yet._',
      ...docs.map((d) => `| [${d.title ?? d.file}](${d.file}) | ${(d.summary ?? '').replace(/\|/g, '/')} | ${d.author ?? ''} | ${String(d.updated ?? '').slice(0, 10)} |`), ''].join('\n'));
    rows.push(`- **[${f.title}](${f.path}/README.md)**: ${f.purpose ?? ''} (${docs.length} doc${docs.length === 1 ? '' : 's'})`);
  }
  writeFileSync(p(LIB, 'INDEX.md'), `# Library\n\nThe organisation's documents, filed by the folders it decided on. Every document follows [STANDARD.md](STANDARD.md).\n\n${rows.join('\n')}\n`);
}

/** The organisation designs its library: folders, owners, templates, and the writing standard. */
export async function init(cfg = loadConfig()) {
  const read = (f) => (existsSync(p(f)) ? readFileSync(p(f), 'utf8') : '');
  const charters = readdirSync(p('org/charters')).filter((f) => f.endsWith('.md')).map((f) => `### ${f}\n${read(`org/charters/${f}`).slice(0, 3000)}`).join('\n');
  const r = await runAgent({ cfg, role: 'chief-of-staff', label: 'library-design',
    schema: { type: 'object', properties: {
      folders: { type: 'array', items: { type: 'object', properties: {
        path: { type: 'string', description: 'kebab-case, at most one level of nesting, e.g. engineering/runbooks' }, title: { type: 'string' }, purpose: { type: 'string' },
        owner: { enum: Object.keys(cfg.roles) }, doc_types: { type: 'array', items: { type: 'string' } },
        template_markdown: { type: 'string', description: 'The skeleton every document in this folder starts from.' } }, required: ['path', 'title', 'purpose', 'owner', 'doc_types', 'template_markdown'] } },
      standard_markdown: { type: 'string', description: 'The writing standard every document must meet.' },
      decisions: { type: 'array', items: DECISION } }, required: ['folders', 'standard_markdown'] },
    prompt: `# Design the organisation's documents library\nThe org needs one library where every role files the documents people read and come back to. ` +
      `Design it the way a great FAANG knowledge team would: few folders, obvious places, one owner each, and no overlap.\n\n` +
      `It is not for raw records. Decisions (memory/decisions), COEs (memory/coe), per-issue stage artifacts (memory/specs) and the ledger already exist and stay where they are. ` +
      `The library holds durable, curated documents: product vision and guides, architecture overviews, runbooks, policies, how-tos, onboarding, postmortem summaries, and similar.\n\n` +
      `## Product\n${read('memory/product/overview.md').slice(0, 6000)}\n\n## Operating model\n${read('org/operating-model.md').slice(0, 6000)}\n\n## Charters\n${charters}\n\n` +
      `Also write STANDARD.md, the writing standard every document must meet. It must make documents clear and easy to understand for a busy reader: ` +
      `a summary first (TL;DR in 2-3 sentences), who it is for, plain words with jargon defined, short sections with descriptive headings, ` +
      `concrete examples, tables for comparisons, links to sources (issue numbers, ADR ids), and an "owner and last reviewed" line. Keep it short.`,
  });
  if (!r.ok) throw new Error(r.error);
  const v = r.out;
  const doc = parseDocument(readFileSync(p('org/org.yaml'), 'utf8'));
  const node = doc.createNode(v.folders.map(({ path: fp, title, purpose, owner, doc_types }) => ({ path: fp, title, purpose, owner, doc_types })));
  doc.set(doc.createNode('library'), doc.createNode({ folders: node }));
  const key = doc.contents.items.find((i) => (i.key?.value ?? i.key) === 'library')?.key;
  if (key && typeof key === 'object') key.commentBefore = ' Documents library. The org decides these folders (governance can change them); agents publish into them, never elsewhere.';
  writeFileSync(p('org/org.yaml'), doc.toString());
  const next = loadConfig();
  mkdirSync(p(LIB), { recursive: true });
  writeFileSync(p(LIB, 'STANDARD.md'), v.standard_markdown.trim() + '\n');
  for (const f of v.folders) { mkdirSync(p(LIB, f.path), { recursive: true }); writeFileSync(p(LIB, f.path, '_TEMPLATE.md'), f.template_markdown.trim() + '\n'); }
  reindex(next);
  for (const d of v.decisions ?? []) M.decide(d, { actor: 'chief-of-staff', scope: 'org/library' });
  M.record('library_designed', { folders: v.folders.map((f) => f.path) }, { actor: 'chief-of-staff' });
  console.log(`Library: ${v.folders.map((f) => f.path).join(', ')}`);
  return v.folders;
}

/** The library tree for the dashboard. */
export function tree(cfg = loadConfig()) {
  return (cfg.library?.folders ?? []).map((f) => {
    const dir = p(LIB, f.path);
    const docs = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.md') && !['README.md', '_TEMPLATE.md'].includes(x))
      .map((x) => { const { meta } = parseDoc(readFileSync(path.join(dir, x), 'utf8')); return { file: `${LIB}/${f.path}/${x}`, title: meta.title ?? x, summary: meta.summary ?? '', author: meta.author ?? '', updated: meta.updated ?? '', version: meta.version ?? 1 }; })
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated))) : [];
    return { ...f, docs, readme: `${LIB}/${f.path}/README.md`, template: `${LIB}/${f.path}/_TEMPLATE.md` };
  });
}
