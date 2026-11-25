// The release gate (feedback 2fa9b900): staging was marked deployed and #1 moved to verify although no deploy ran.
// An environment is deployed only when the deploy step exits 0 and the health probe answers 200; anything else holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { decideDeploy, probeHealth } from '../factory/lib/deploy-gate.mjs';

const repo = (over = {}) => ({ name: 'enwallet', repo: 'acme/enwallet', default_branch: 'main', deploy_command: 'local-static.sh {name} {env} {port}',
  ports: { staging: 4401 }, health: { staging: 'http://127.0.0.1:4401/' }, ...over });
const deployVerdict = { outcome: 'advance', next_stage: 'verify', deploy_now: true, environment: 'staging' };
const spy = (impl) => { const f = async (...a) => { f.calls.push(a); return impl(...a); }; f.calls = []; return f; };
const ok = () => spy(() => ({ ok: true, log: '✓ live' }));
const status = (s) => spy(() => ({ status: s }));
const skipped = (d) => d.events.filter(([t]) => t === 'deploy_skipped').map(([, e]) => e);
const held = (d, reason) => {
  assert.equal(d.status, 'hold'); assert.equal(d.next, 'release', 'never advances to verify');
  assert.equal(d.deployedRepos.length, 0);
  assert.ok(!d.events.some(([t]) => t === 'deploy'), 'no deploy event, so reports never count it as a deploy');
  assert.equal(skipped(d).length, 1); assert.equal(skipped(d)[0].reason, reason); assert.equal(skipped(d)[0].held, true);
};

test('deploy verdict with no deploy config: hold, nothing runs, deploy_skipped names the reason (the #1 incident)', async () => {
  const runDeploy = ok(), probe = status(200);
  const d = await decideDeploy({ verdict: deployVerdict, repos: [{ name: 'enwallet', repo: 'acme/enwallet', default_branch: 'main' }], env: 'staging', runDeploy, probe });
  held(d, 'missing_config');
  assert.match(skipped(d)[0].detail, /no deploy_command or deploy_workflow/);
  assert.equal(runDeploy.calls.length, 0); assert.equal(probe.calls.length, 0);
});

test('a missing health URL for the target environment is missing config', async () => {
  const runDeploy = ok();
  const d = await decideDeploy({ verdict: deployVerdict, repos: [repo({ health: { production: 'http://x/' } })], env: 'staging', runDeploy, probe: status(200) });
  held(d, 'missing_config'); assert.match(skipped(d)[0].detail, /no health URL for staging/);
  assert.equal(runDeploy.calls.length, 0, 'config is checked before anything is deployed');
});

test('no repos in scope: hold, not a silent pass', async () => {
  held(await decideDeploy({ verdict: deployVerdict, repos: [], env: 'staging', runDeploy: ok(), probe: status(200) }), 'missing_config');
});

test('deploy runs but exits non-zero (or the script is missing): hold, reason failed, no probe', async () => {
  const probe = status(200);
  const d = await decideDeploy({ verdict: deployVerdict, repos: [repo()], env: 'staging', runDeploy: spy(() => ({ ok: false, log: 'bash: local-static.sh: command not found\nexit 127' })), probe });
  held(d, 'failed'); assert.match(skipped(d)[0].log, /command not found/); assert.equal(probe.calls.length, 0);
  const t = await decideDeploy({ verdict: deployVerdict, repos: [repo()], env: 'staging', runDeploy: spy(() => { throw new Error('ENOENT checkout'); }), probe });
  held(t, 'failed');
});

test('deploy exits 0 but the probe answers 503: hold, not deployed', async () => {
  const probe = status(503);
  const d = await decideDeploy({ verdict: deployVerdict, repos: [repo()], env: 'staging', runDeploy: ok(), probe });
  held(d, 'unhealthy'); assert.equal(skipped(d)[0].http, 503);
  assert.deepEqual(probe.calls, [['http://127.0.0.1:4401/']]);
});

test('deploy exits 0 and the probe answers 200: deployed, on to verify', async () => {
  const runDeploy = ok(), probe = status(200);
  const d = await decideDeploy({ verdict: deployVerdict, repos: [repo(), repo({ name: 'api', health: { staging: 'http://127.0.0.1:4402/health' } })], env: 'staging', runDeploy, probe });
  assert.equal(d.status, 'deployed'); assert.equal(d.next, 'verify');
  assert.deepEqual(d.deployedRepos, ['enwallet', 'api']);
  assert.deepEqual(d.events.map(([t, e]) => [t, e.repo, e.http]), [['deploy', 'enwallet', 200], ['deploy', 'api', 200]]);
  assert.equal(runDeploy.calls.length, 2); assert.equal(skipped(d).length, 0);
});

test('one unhealthy repo of two holds the whole environment', async () => {
  let i = 0;
  const d = await decideDeploy({ verdict: deployVerdict, repos: [repo(), repo({ name: 'api' })], env: 'staging', runDeploy: ok(), probe: spy(() => ({ status: i++ ? 500 : 200 })) });
  held(d, 'unhealthy'); assert.equal(skipped(d)[0].repo, 'api');
});

test('no_runtime_surface with a note: no deploy or probe, recorded, proceeds to the chosen stage', async () => {
  const runDeploy = ok(), probe = status(200);
  const note = 'Design tokens and lint config only; nothing is built or served.';
  const d = await decideDeploy({ verdict: { ...deployVerdict, no_runtime_surface: true, no_runtime_note: note }, repos: [{ name: 'enwallet' }], env: 'staging', runDeploy, probe });
  assert.equal(d.status, 'no_runtime'); assert.equal(d.next, 'verify');
  assert.equal(runDeploy.calls.length, 0); assert.equal(probe.calls.length, 0);
  assert.equal(skipped(d).length, 1); assert.equal(skipped(d)[0].reason, 'no_runtime_surface'); assert.equal(skipped(d)[0].note, note); assert.equal(skipped(d)[0].held, false);
  assert.ok(!d.events.some(([t]) => t === 'deploy'));
});

test('no_runtime_surface without a (real) note: rejected, hold', async () => {
  for (const no_runtime_note of [undefined, '', '   ', 'n/a']) {
    const runDeploy = ok();
    const d = await decideDeploy({ verdict: { ...deployVerdict, no_runtime_surface: true, no_runtime_note }, repos: [repo()], env: 'staging', runDeploy, probe: status(200) });
    held(d, 'no_runtime_note_missing'); assert.equal(runDeploy.calls.length, 0);
  }
});

test('no deploy_now and no flag: nothing happens here (the caller holds as before)', async () => {
  const runDeploy = ok();
  const d = await decideDeploy({ verdict: { outcome: 'advance', next_stage: 'release', deploy_now: false }, repos: [repo()], env: 'staging', runDeploy, probe: status(200) });
  assert.equal(d.status, 'none'); assert.equal(d.events.length, 0); assert.equal(runDeploy.calls.length, 0);
});

test('probeHealth: 200 is healthy, 503 and an unreachable port are not, and each attempt times out', async () => {
  const srv = createServer((req, res) => { if (req.url === '/slow') return; res.statusCode = req.url === '/down' ? 503 : 200; res.end('x'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await probeHealth(`${base}/`, { attempts: 1 })).status, 200);
    assert.equal((await probeHealth(`${base}/down`, { attempts: 2, gapMs: 1 })).status, 503);
    const slow = await probeHealth(`${base}/slow`, { attempts: 1, timeoutMs: 200 });
    assert.equal(slow.status, 0); assert.match(slow.error, /timed out/);
  } finally { srv.closeAllConnections(); srv.close(); }
  const dead = await probeHealth(base, { attempts: 1 });
  assert.equal(dead.status, 0);
});

// Owner request #133: a deploy_command whose program doesn't resolve holds the release before anything runs.
test('#133: an unresolvable deploy program holds with missing_config and runs nothing', async () => {
  const { decideDeploy, deployProgram } = await import('../factory/lib/deploy-gate.mjs');
  assert.equal(deployProgram('local-node.sh {name} {env} {port}'), 'local-node.sh');
  assert.equal(deployProgram('NODE_ENV=production bash deploy/local-node.sh enwallet staging'), 'deploy/local-node.sh', 'skips env vars and a bash wrapper');
  let ran = false;
  const d = await decideDeploy({ verdict: { deploy_now: true, next_stage: 'verify' }, env: 'staging',
    repos: [{ name: 'enwallet', deploy_command: 'nope.sh {name} {env}', health: { staging: 'http://127.0.0.1:4310/' } }],
    runDeploy: async () => { ran = true; return { ok: true }; }, probe: async () => ({ status: 200 }), resolves: (prog) => prog !== 'nope.sh' });
  assert.equal(d.status, 'hold'); assert.equal(d.reason, 'missing_config');
  assert.match(d.detail, /executable nope\.sh not found/);
  assert.equal(ran, false, 'no deploy is attempted');
});

// Owner request #149 (COE on #81): rehearse the deploy in a scratch environment; a failed rehearsal never touches the real one.
test('#149: a failed scratch deploy makes no real deploy call, and is cleaned up', async () => {
  const { deployWithPreflight, decideDeploy } = await import('../factory/lib/deploy-gate.mjs');
  let real = false, cleaned = false;
  const out = await deployWithPreflight({ runScratch: async () => ({ ok: false, log: 'Error: Cannot find module server/money.mjs' }),
    runReal: async () => { real = true; return { ok: true }; }, cleanup: async () => { cleaned = true; } });
  assert.equal(real, false, 'the live environment is not touched');
  assert.equal(cleaned, true, 'the scratch server and folder are cleaned up');
  assert.equal(out.preflight, true);
  assert.match(out.log, /Cannot find module/);
  const d = await decideDeploy({ verdict: { deploy_now: true, next_stage: 'verify' }, env: 'staging',
    repos: [{ name: 'enwallet', deploy_command: 'local-node.sh {name} {env} {port}', health: { staging: 'http://127.0.0.1:4310/' } }],
    runDeploy: async () => out, probe: async () => ({ status: 200 }) });
  assert.equal(d.status, 'hold'); assert.equal(d.reason, 'preflight_failed');
});

test('#149: a passing scratch deploy goes on to the real one', async () => {
  const { deployWithPreflight } = await import('../factory/lib/deploy-gate.mjs');
  let real = false;
  const out = await deployWithPreflight({ runScratch: async () => ({ ok: true }), runReal: async () => { real = true; return { ok: true, log: 'live' }; } });
  assert.equal(real, true); assert.equal(out.ok, true);
});
