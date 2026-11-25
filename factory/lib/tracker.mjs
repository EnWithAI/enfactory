// GitHub Issues + PRs via the gh CLI. To use Jira or Linear instead, implement the same exports.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const STAGE = 'sf/';
export const L = { working: 'sf-working', human: 'sf-needs-human', approved: 'sf-approved' };

export async function gh(args, { input, cwd } = {}) {
  if (input === undefined) {
    const { stdout } = await run('gh', args, { maxBuffer: 64 << 20, cwd });
    return stdout.trim();
  }
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { maxBuffer: 64 << 20, cwd }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()));
    child.stdin.end(input);
  });
}
const json = async (args) => JSON.parse((await gh(args)) || 'null');

export const labelsOf = (issue) => issue.labels.map((l) => l.name);
export const stageOf = (issue) => labelsOf(issue).find((l) => l.startsWith(STAGE))?.slice(STAGE.length) ?? null;
export const priorityOf = (issue) => labelsOf(issue).find((l) => /^P[0-3]$/.test(l)) ?? 'P2';

export const listIssues = (repo, label) =>
  json(['issue', 'list', '-R', repo, '--label', label, '--state', 'open', '--limit', '500',
    '--json', 'number,title,body,labels,createdAt,url,milestone']);

export const listAllOpen = (repo) =>
  json(['issue', 'list', '-R', repo, '--state', 'open', '--limit', '500', '--json', 'number,title,body,labels']);

export async function setStage(repo, n, from, to) {
  const args = ['issue', 'edit', String(n), '-R', repo, '--add-label', STAGE + to];
  if (from) args.push('--remove-label', STAGE + from);
  await gh(args);
}

export async function editLabels(repo, n, { add = [], remove = [] }) {
  const args = ['issue', 'edit', String(n), '-R', repo];
  for (const l of add) args.push('--add-label', l);
  for (const l of remove) args.push('--remove-label', l);
  if (add.length || remove.length) await gh(args);
}

// Every factory comment carries this marker so human comments can be told apart (both post as the same gh user).
export const MARK = '<!-- sf -->';
export const comment = (repo, n, body) => gh(['issue', 'comment', String(n), '-R', repo, '--body-file', '-'], { input: `${body}\n${MARK}` });
/** A person's comment (from the dashboard): no factory marker, so the org records it as human input. */
export const humanComment = (repo, n, body) => gh(['issue', 'comment', String(n), '-R', repo, '--body-file', '-'], { input: body });
export const prComment = (repo, pr, body) => gh(['pr', 'comment', String(pr), '-R', repo, '--body-file', '-'], { input: `${body}\n${MARK}` });

/** Human comments on an issue (factory comments filtered out), optionally only those after `since`. */
export async function humanComments(repo, n, since) {
  const { comments } = await json(['issue', 'view', String(n), '-R', repo, '--json', 'comments']);
  return comments.filter((c) => !c.body.includes(MARK) && (!since || c.createdAt > since))
    .map((c) => ({ at: c.createdAt, by: c.author?.login, body: c.body }));
}
export const assign = (repo, n, logins) => logins.length ? gh(['issue', 'edit', String(n), '-R', repo, ...logins.flatMap((l) => ['--add-assignee', l])]) : null;
export const viewIssue = (repo, n) => json(['issue', 'view', String(n), '-R', repo, '--json', 'state,comments,title,url']);
export const closeIssue = (repo, n, reason = 'completed') => gh(['issue', 'close', String(n), '-R', repo, '--reason', reason]);

const STOP = new Set('the a an and or of to for in on with by from is are be it this that as at not no can cannot need needs needed make must should only owner vendor request factory change'.split(' '));
const words = (t) => new Set(String(t).toLowerCase().replace(/\[(owner|vendor)\]/g, '').match(/[a-z0-9][a-z0-9._/-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? []);
/** Two texts ask for the same thing (word overlap). */
export function similar(a, b, threshold = 0.25) { // tuned on real duplicate requests: 3/3 caught, 0/5 false merges
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  const inter = [...x].filter((w) => y.has(w)).length;
  return inter / Math.min(x.size, y.size) >= threshold && inter / Math.max(x.size, y.size) >= threshold * 0.6;
}
/**
 * File a request once: if an open issue with the same label asks for the same thing, add this as a comment ("+1, with evidence")
 * instead of opening a duplicate. Returns { n, duplicate }.
 */
export async function fileOnce(repo, { title, body, labels }) {
  const open = await json(['issue', 'list', '-R', repo, '--state', 'open', '--label', labels[0], '--limit', '100', '--json', 'number,title,body']).catch(() => []);
  const dup = (open ?? []).find((i) => similar(`${i.title} ${i.body ?? ''}`.slice(0, 1500), `${title} ${body}`.slice(0, 1500)));
  if (dup) { await comment(repo, dup.number, `**Also requested** (merged as a duplicate):\n${title}\n\n${body}`); return { n: dup.number, duplicate: true }; }
  return { n: await createIssue(repo, { title, body, labels }), duplicate: false };
}

export async function createIssue(repo, { title, body, labels }) {
  const url = await gh(['issue', 'create', '-R', repo, '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])], { input: body });
  return Number(url.split('/').pop());
}

export async function ensureLabels(repo, cfg) {
  const want = [
    [cfg.product.intake_label, '0e8a16', 'Enters the software factory'],
    ...Object.keys(cfg.pipeline).map((s) => [STAGE + s, 'c5def5', `Factory stage: ${s}`]),
    [L.working, 'fbca04', 'An agent is working on this'],
    [L.human, 'd93f0b', 'Waiting for a human decision'],
    [L.approved, '0e8a16', 'Human approved the pending gate'],
    ['P0', 'b60205', 'Critical'], ['P1', 'd93f0b', 'High'], ['P2', 'fbca04', 'Normal'], ['P3', 'c2e0c6', 'Low'],
    ['incident', 'b60205', 'Filed by observability'],
    ['sf-vendor-request', '5319e7', 'An agent needs something only a person can provide'],
    ['sf-waiting-vendor', 'd4c5f9', 'Paused until a vendor request is fulfilled'],
    ['sf-owner-request', 'b60205', 'The org asks the owner for a resource or safety change'],
    ['sf-release', '1d76db', 'Release record: goal, scope, demo and retro'],
    [STAGE + 'done', 'ededed', 'Shipped'], [STAGE + 'rejected', 'ededed', 'Closed by the factory'],
  ];
  for (const [name, color, description] of want) {
    await gh(['label', 'create', name, '-R', repo, '--color', color, '--description', description, '--force']);
  }
}

// ── Pull requests ──
export async function findPr(repo, branch) {
  const prs = await json(['pr', 'list', '-R', repo, '--head', branch, '--state', 'all', '--json', 'number,state,url']);
  return prs.find((x) => x.state === 'OPEN') ?? prs[0] ?? null;
}
export async function createPr(repo, { head, base, title, body, draft = false }) {
  const url = await gh(['pr', 'create', '-R', repo, '--head', head, '--base', base, '--title', title, '--body-file', '-', ...(draft ? ['--draft'] : [])], { input: body });
  return Number(url.split('/').pop());
}
/** Set a PR's draft state: draft=true marks it a draft, false marks it ready for review. */
export const setDraft = (repo, pr, draft) => gh(['pr', 'ready', String(pr), '-R', repo, ...(draft ? ['--undo'] : [])]).catch((e) => { if (!/already|is not a draft|is a draft/i.test(e.message)) throw e; });
export const editPrBody = (repo, pr, body) => gh(['pr', 'edit', String(pr), '-R', repo, '--body-file', '-'], { input: body });
export async function isDraft(repo, pr) { return JSON.parse(await gh(['pr', 'view', String(pr), '-R', repo, '--json', 'isDraft'])).isDraft; }
/** Returns 'pass' | 'fail' | 'pending' | 'none'. */
export async function prChecks(repo, pr) {
  // gh exits non-zero while checks are pending or failing, but still prints the JSON.
  let out;
  try { out = (await run('gh', ['pr', 'checks', String(pr), '-R', repo, '--json', 'bucket'])).stdout; }
  catch (e) { if (/no checks/i.test(e.stderr ?? '')) return 'none'; if (!e.stdout) throw e; out = e.stdout; }
  const checks = JSON.parse(out || '[]');
  if (!checks?.length) return 'none';
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'fail';
  if (checks.some((c) => c.bucket === 'pending')) return 'pending';
  return 'pass';
}
/** Every check on a PR: [{ name, bucket, state, link }]. [] when the repo has no checks. */
export async function prCheckList(repo, pr) {
  let out;
  try { out = (await run('gh', ['pr', 'checks', String(pr), '-R', repo, '--json', 'name,bucket,state,link'])).stdout; }
  catch (e) { if (/no checks/i.test(e.stderr ?? '')) return []; if (!e.stdout) throw e; out = e.stdout; }
  return JSON.parse(out || '[]');
}
/** The failing steps' log lines for a failed check, from its Actions run (tail only: that's where the error is). */
export async function failedLog(repo, check, lines = 60) {
  const run = String(check.link ?? '').match(/\/actions\/runs\/(\d+)/)?.[1];
  if (!run) return '';
  const log = await gh(['run', 'view', run, '-R', repo, '--log-failed']).catch(() => '');
  return log.split('\n').slice(-lines).join('\n');
}
export async function prMergeable(repo, pr) {
  const { mergeable } = await json(['pr', 'view', String(pr), '-R', repo, '--json', 'mergeable']);
  return mergeable; // MERGEABLE | CONFLICTING | UNKNOWN
}
export const mergePr = (repo, pr) => gh(['pr', 'merge', String(pr), '-R', repo, '--squash', '--delete-branch']);
export const runWorkflow = (repo, wf, ref, inputs = {}) =>
  gh(['workflow', 'run', wf, '-R', repo, '--ref', ref, ...Object.entries(inputs).flatMap(([k, v]) => ['-f', `${k}=${v}`])]);
