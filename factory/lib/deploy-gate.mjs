// The release gate (feedback 2fa9b900): an environment counts as deployed only when every touched repo's deploy step
// exited 0 AND its health URL for that environment answered HTTP 200. Anything less holds the release, with a reason.
// Before this, a repo with no deploy config was filtered out of the loop, so "no deploys ran" read as "every deploy passed".
// Pure apart from the injected runDeploy/probe, so it is tested without GitHub, a shell or a live environment.

const MIN_NOTE = 20; // "n/a" is not a reason; the note is what the verify stage and auditors read

/**
 * Deploy with a dress rehearsal (owner request #149, COE on #81): run the same deploy into a scratch environment on a free
 * port first, and touch the real environment only if that passes. A broken release never stops the live server.
 * runScratch / runReal: async () => { ok, log }; cleanup: async () => void, always called after the scratch run.
 */
export async function deployWithPreflight({ runScratch, runReal, cleanup = async () => {} }) {
  let s;
  try { s = await runScratch(); } catch (e) { s = { ok: false, log: e.message }; } finally { await cleanup().catch(() => {}); }
  if (!s?.ok) return { ok: false, preflight: true, log: `preflight_failed: the scratch deploy failed, so the real environment was not touched.\n${String(s?.log ?? '').slice(-2500)}` };
  return runReal();
}

/** The program a deploy_command runs: its first word, skipping VAR=value assignments and a `bash`/`sh` wrapper. */
export function deployProgram(cmd) {
  const words = String(cmd).trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return /^(ba)?sh$/.test(words[0] ?? '') && words[1] && !words[1].startsWith('-') ? words[1] : words[0] ?? '';
}

/**
 * Decide what a release verdict does to one environment.
 * @param verdict  the release verdict (deploy_now, no_runtime_surface, no_runtime_note, next_stage)
 * @param repos    the repos the issue touches
 * @param env      the target environment
 * @param runDeploy async (repo, env) => { ok, log }: ok means the deploy step exited 0
 * @param probe    async (url) => { status, error? }
 * @returns { status: 'deployed'|'no_runtime'|'hold'|'none', next, reason?, events: [[type, data]], deployedRepos, log }
 *   The caller records the events, and writes state.deployed only for 'deployed'.
 */
export async function decideDeploy({ verdict: v, repos, env, runDeploy, probe, resolves = () => true }) {
  const next = v.next_stage;
  const hold = (reason, detail, extra = {}) => ({ status: 'hold', next: 'release', reason, detail, events: [['deploy_skipped', { env, reason, detail: detail.slice(0, 1500), held: true, ...extra }]], deployedRepos: [], log: extra.log ?? '' });
  if (v.no_runtime_surface) { // nothing to run, so nothing to deploy or probe; the claim and its note are on the record
    const note = (v.no_runtime_note ?? '').trim();
    if (note.length < MIN_NOTE) return hold('no_runtime_note_missing', `no_runtime_surface needs no_runtime_note (at least ${MIN_NOTE} characters) saying why this change has nothing to deploy to ${env}.`);
    const configured = repos.filter((r) => r.deploy_command || r.deploy_workflow).map((r) => r.name); // the auditor sees if a deployable repo was skipped
    return { status: 'no_runtime', next, reason: 'no_runtime_surface', detail: note, deployedRepos: [], log: '',
      events: [['deploy_skipped', { env, reason: 'no_runtime_surface', note: note.slice(0, 1500), held: false, configured }]] };
  }
  if (!v.deploy_now) return { status: 'none', next, events: [], deployedRepos: [], log: '' };
  if (!repos.length) return hold('missing_config', `No repo is in scope, so nothing can be deployed to ${env}.`);
  // Check every repo's config before running anything, so a gap never leaves the environment half-deployed.
  const gaps = repos.flatMap((r) => [
    ...(r.deploy_command || r.deploy_workflow ? [] : [`${r.name}: no deploy_command or deploy_workflow in org.yaml product.repos[]`]),
    ...(r.health?.[env] ? [] : [`${r.name}: no health URL for ${env} (product.repos[].health.${env})`]),
    // The command's program must exist where the deploy will look for it (owner request #133), checked before anything runs.
    ...(r.deploy_command && !resolves(deployProgram(r.deploy_command), r) ? [`${r.name}: deploy_command executable ${deployProgram(r.deploy_command)} not found in the factory's deploy/ or PATH`] : []),
  ]);
  if (gaps.length) return hold('missing_config', `Deploy config is missing, so nothing was deployed to ${env}:\n${gaps.map((g) => `- ${g}`).join('\n')}`, { gaps });
  const events = [], logs = [];
  for (const r of repos) {
    let out;
    try { out = await runDeploy(r, env); } catch (e) { out = { ok: false, log: e.message }; }
    const log = String(out?.log ?? '');
    logs.push(`${r.name}:\n${log.slice(-2500)}`);
    if (!out?.ok && out?.preflight) return hold('preflight_failed', `The scratch deploy of ${r.name} for ${env} failed, so the real ${env} was not touched.`, { repo: r.name, log: log.slice(-1500) });
    if (!out?.ok) return hold('failed', `The deploy step for ${r.name} to ${env} failed (non-zero exit or missing script).`, { repo: r.name, log: log.slice(-1500) });
    let h;
    try { h = await probe(r.health[env]); } catch (e) { h = { status: 0, error: e.message }; }
    if (h?.status !== 200) return hold('unhealthy', `${r.name} deployed to ${env}, but ${r.health[env]} answered ${h?.status || h?.error || 'nothing'} instead of 200.`, { repo: r.name, url: r.health[env], http: h?.status ?? 0, log: log.slice(-1500) });
    events.push(['deploy', { repo: r.name, env, via: r.deploy_command ? 'local' : 'workflow', ok: true, health: r.health[env], http: 200, log: log.slice(-1500) }]);
  }
  return { status: 'deployed', next, events, deployedRepos: repos.map((r) => r.name), log: logs.join('\n') };
}

/** Health probe: one GET per attempt, each with its own timeout; a slow start gets a few tries before it counts as down. */
export async function probeHealth(url, { attempts = 5, timeoutMs = 10e3, gapMs = 3e3 } = {}) {
  let last = { status: 0, error: 'not probed' };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      await res.body?.cancel();
      last = { status: res.status };
      if (res.status === 200) return last;
    } catch (e) { last = { status: 0, error: e.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : e.message }; }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return last;
}
