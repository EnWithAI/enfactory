// #192: deploy/local-node.sh starts the server under a launchd LaunchAgent (deploy/env-run.sh), so it survives a signal to
// the deploying process group and comes back after kill -9; --stop and purge leave no job. Same fixture app and temp
// SF_ENV_ROOT shape as tests/local-node.test.mjs. Every root is stopped in after(). macOS only: without a launchd
// gui/ or user/ domain the suite skips with the reason printed (the build then pastes a local run).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopSupervised } from './fixtures/stop-supervised.mjs';
import { deployEnv, reprobe } from '../factory/lib/deploy-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CHECKOUT = join(here, '..');
const SCRIPT = join(CHECKOUT, 'deploy', 'local-node.sh');
const ENVRUN = join(CHECKOUT, 'deploy', 'env-run.sh');
const FIXTURE = join(here, 'fixtures', 'local-node-app');
const CUTOFF = 1796236200; // 2026-12-03T00:00:00+05:30
const uid = process.getuid?.() ?? 0;
const domain = process.platform !== 'darwin' ? null
  : [`gui/${uid}`, `user/${uid}`].find((d) => spawnSync('launchctl', ['print', d], { stdio: 'ignore' }).status === 0) ?? null;
const skip = domain ? false : 'no launchd gui/ or user/ domain on this runner (#192: paste a local macOS run instead)';
if (skip) console.log(`# local-node-supervisor skipped: ${skip}`);

const T = realpathSync(mkdtempSync(join(tmpdir(), 'local-node-sup-')));
const ENV_ROOT = join(T, 'envs');
const AGENTS = join(T, 'agents');
mkdirSync(AGENTS, { mode: 0o700 });
const roots = new Set(), cleanups = [];
const testEnv = { SF_ENV_ROOT: ENV_ROOT, SF_LAUNCHAGENTS_DIR: AGENTS, SF_LAUNCHD_DOMAIN: domain ?? '' };
after(() => {
  for (const R of roots) stopSupervised(R, { SF_LAUNCHAGENTS_DIR: AGENTS, SF_LAUNCHD_DOMAIN: domain ?? '' });
  for (const f of cleanups) try { f(); } catch {}
  rmSync(T, { recursive: true, force: true });
});

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const ok = (cmd, args, cwd) => { const r = sh(cmd, args, { cwd }); assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const freePort = () => new Promise((res) => { const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checkout = (label) => {
  const dir = join(T, `repo-${label}`);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, 'server', 'mode'), `ok\n// ${label}\n`.split('\n')[0] + '\n');
  writeFileSync(join(dir, 'label.txt'), label);
  ok('git', ['init', '-q'], dir); ok('git', ['add', '-A'], dir);
  ok('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', label], dir);
  return { dir, sha: ok('git', ['rev-parse', '--short', 'HEAD'], dir) };
};
const rootOf = (name) => { const R = join(ENV_ROOT, name, 'staging'); roots.add(R); return R; };
const run = (name, cwd, port, flag, extra = {}) => {
  const env = { ...process.env, ...testEnv, ...extra };
  delete env.HOST;
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  const args = [SCRIPT, name, 'staging', String(port), ...(flag ? [flag] : [])];
  const r = sh('bash', args, { cwd, env, timeout: 180_000 });
  return { ...r, out: r.stdout + r.stderr, R: rootOf(name) };
};
const label = (R, name) => `com.enwithai.sf.${name}.staging.${sh('/bin/sh', ['-c', 'printf %s "$1" | shasum -a 256 | cut -c1-8', 'sh', R]).stdout.trim()}`;
const loaded = (lbl) => sh('launchctl', ['print', `${domain}/${lbl}`]).status === 0;
const listening = (port) => sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).stdout;
const health = async (port) => { try { return await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })).json(); } catch { return null; } };
const until = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(250); } };
const pidOf = (R) => Number(readFileSync(join(R, 'server.pid'), 'utf8').trim());
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const plistKey = (p, key) => sh('plutil', ['-extract', key, 'raw', '-o', '-', p]);

const A = checkout('a'), B = checkout('b');
const P = await freePort();
const RS = rootOf('sup');
const PLIST = join(AGENTS, `${label(RS, 'sup')}.plist`);

test('AC-a server survives SIGKILL of the deploying process group', { skip }, async () => {
  const child = spawn('bash', [SCRIPT, 'sup', 'staging', String(P)], { cwd: A.dir, detached: true, stdio: 'ignore', env: (() => { const e = { ...process.env, ...testEnv }; delete e.HOST; return e; })() });
  const G = child.pid;
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0);
  for (const sig of ['SIGTERM', 'SIGKILL']) try { process.kill(-G, sig); } catch {}
  const h = await until(() => health(P), 10_000);
  assert.deepEqual(h, { ok: true, db: true, sha: A.sha });
  const pid = pidOf(RS);
  assert.notEqual(Number(ok('ps', ['-o', 'pgid=', '-p', String(pid)])), G);
  assert.equal(Number(ok('ps', ['-o', 'ppid=', '-p', String(pid)])), 1, 'parent is launchd');
});

test('AC-d binds 127.0.0.1 only', { skip }, () => {
  const l = listening(P);
  assert.match(l, new RegExp(`127\\.0\\.0\\.1:${P} \\(LISTEN\\)`));
  assert.doesNotMatch(l, new RegExp(`\\*:${P}`));
});

test('AC-d plist is 0600 and has no EnvironmentVariables secrets', { skip }, () => {
  assert.equal(statSync(PLIST).mode & 0o777, 0o600);
  assert.notEqual(plistKey(PLIST, 'EnvironmentVariables').status, 0);
  assert.equal(plistKey(PLIST, 'KeepAlive.PathState').status, 0);
  assert.equal(plistKey(PLIST, 'ThrottleInterval').stdout.trim(), '2');
  assert.equal(plistKey(PLIST, 'ExitTimeOut').stdout.trim(), '5');
});

test('AC-d plist Program is the install env-run.sh', { skip }, () => {
  assert.equal(realpathSync(plistKey(PLIST, 'ProgramArguments.0').stdout.trim()), realpathSync(ENVRUN));
  // Outside test mode, a checkout that is not SF_HOME never registers a supervisor.
  const name = `sf-test-${process.pid}-s5`;
  const r = run(name, A.dir, P, undefined, { SF_ENV_ROOT: undefined, SF_LAUNCHAGENTS_DIR: undefined, SF_LAUNCHD_DOMAIN: undefined, SF_HOME: T });
  cleanups.push(() => rmSync(join(homedir(), 'factory-envs', name), { recursive: true, force: true }));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✗ supervisor program must be the installed factory's deploy\/env-run\.sh/);
});

test('AC-b kill -9 of the node pid recovers within 10s', { skip }, async () => {
  const old = pidOf(RS);
  process.kill(old, 'SIGKILL');
  const t0 = Date.now();
  const h = await until(async () => { const x = await health(P); return x?.ok && existsSync(join(RS, 'server.pid')) && pidOf(RS) !== old ? x : null; }, 10_000);
  assert.ok(h, 'healthy again within 10 s');
  assert.ok(Date.now() - t0 <= 10_000);
  assert.notEqual(pidOf(RS), old);
});

test('AC-c pid file is replaced atomically and removed on stop', { skip }, () => {
  const pid = pidOf(RS);
  assert.ok(alive(pid));
  assert.equal(statSync(join(RS, 'server.pid')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(RS).filter((f) => f.startsWith('server.pid.tmp')), []);
  assert.match(ok('ps', ['-o', 'command=', '-p', String(pid)]), new RegExp(`${RS}/current/server/index\\.mjs`));
});

test('AC-f --status is read-only and reports health', { skip }, () => {
  const snap = () => readdirSync(RS).map((f) => `${f}:${statSync(join(RS, f)).mtimeMs}`).join('|');
  const before = snap();
  const s = run('sup', A.dir, P, '--status');
  assert.equal(s.status, 0, s.out);
  assert.match(s.out, new RegExp(`✓ sup@${A.sha} healthy`));
  assert.equal(snap(), before);
});

test('AC-e rollback swaps the agent to VERIFIED', { skip }, async () => {
  writeFileSync(join(RS, 'VERIFIED'), `${A.sha}\n`);
  const d = run('sup', B.dir, P);
  assert.equal(d.status, 0, d.out);
  assert.equal((await health(P))?.sha, B.sha);
  const r = run('sup', A.dir, P, '--rollback');
  assert.equal(r.status, 0, r.out);
  assert.equal((await health(P))?.sha, A.sha);
  assert.equal(plistKey(PLIST, 'ProgramArguments.2').stdout.trim(), A.sha);
  assert.ok(loaded(label(RS, 'sup')));
  assert.match(readFileSync(join(RS, 'deploy.log'), 'utf8'), /· supervisor bootout .*\n[\s\S]*· supervisor bootstrap /);
});

test('AC-e --stop leaves no launchd job and frees the port', { skip }, async () => {
  const r = run('sup', A.dir, P, '--stop');
  assert.equal(r.status, 0, r.out);
  assert.equal(loaded(label(RS, 'sup')), false);
  assert.equal(listening(P), '');
  assert.equal(existsSync(PLIST), false);
  assert.equal(existsSync(join(RS, 'server.pid')), false, 'AC-c: removed on stop');
  assert.equal(existsSync(join(RS, '.supervise')), false);
  await sleep(3000); // longer than ThrottleInterval: nothing relaunches
  assert.equal(listening(P), '');
  assert.equal(run('sup', A.dir, P, '--status').status, 1);
  assert.ok(existsSync(join(RS, 'releases', A.sha)) && existsSync(join(RS, 'data')), 'releases and data kept');
});

test('AC-c stale pid file pointing at a foreign process is never killed', { skip }, () => {
  const s = spawn('sleep', ['300'], { stdio: 'ignore' }); s.unref();
  cleanups.push(() => s.kill('SIGKILL'));
  writeFileSync(join(RS, 'server.pid'), `${s.pid}\n`);
  const r = run('sup', A.dir, P, '--stop');
  assert.equal(r.status, 0, r.out);
  assert.ok(alive(s.pid));
});

test('AC-e legacy nohup server is stopped on first supervised deploy', { skip }, async () => {
  const port = await freePort();
  const R = rootOf('legacy');
  assert.equal(run('legacy', A.dir, port).status, 0);
  assert.equal(run('legacy', A.dir, port, '--stop').status, 0);
  // The pre-#192 way: nohup from a shell that exits, so the old server is reparented (and reaped) like the real one.
  const env = { ...process.env, HOST: '127.0.0.1', SF_RELEASE_SHA: A.sha };
  const pid = Number(ok('bash', ['-c', 'nohup node "$1/current/server/index.mjs" "$2" "$1/data" </dev/null >/dev/null 2>&1 & echo $!', 'sh', R, String(port)]));
  const old = { pid };
  cleanups.push(() => process.kill(pid, 'SIGKILL'));
  writeFileSync(join(R, 'server.pid'), `${old.pid}\n`);
  assert.ok(await until(() => health(port), 5000));
  const r = run('legacy', B.dir, port);
  assert.equal(r.status, 0, r.out);
  assert.equal(alive(old.pid), false);
  assert.notEqual(pidOf(R), old.pid);
  assert.equal((await health(port))?.sha, B.sha);
});

test('AC-e purge flow: --stop then delete root leaves no job', { skip }, async () => {
  const port = await freePort();
  const R = rootOf('purge');
  const lbl = label(R, 'purge');
  assert.equal(run('purge', A.dir, port).status, 0);
  assert.equal(run('purge', A.dir, port, '--stop').status, 0);
  rmSync(R, { recursive: true, force: true });
  assert.equal(existsSync(R), false);
  assert.equal(loaded(lbl), false);
  assert.equal(existsSync(join(AGENTS, `${lbl}.plist`)), false);
  assert.equal(listening(port), '');
  assert.equal(await health(port), null, 'endpoint refuses connections');
});

test('AC-d invalid arg stops relaunch', { skip }, async () => {
  const port = await freePort();
  const R = rootOf('s1');
  assert.equal(run('s1', A.dir, port).status, 0);
  rmSync(join(R, 'releases', A.sha), { recursive: true, force: true }); // the release goes missing under a live job
  process.kill(pidOf(R), 'SIGKILL');
  await sleep(10_000);
  assert.equal(existsSync(join(R, '.supervise')), false);
  assert.equal(listening(port), '');
  const lines = readFileSync(join(R, 'server.log'), 'utf8').split('\n').filter((l) => l.startsWith('env-run:'));
  assert.ok(lines.length >= 1 && lines.length <= 2, lines.join('\n'));
  assert.match(lines[0], /release missing/);
});

test('AC-d invalid root sleeps instead of looping', { skip: process.platform !== 'darwin' }, async () => {
  const c = spawn('bash', [ENVRUN, 'relative/path', A.sha, '4400', process.execPath], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  await sleep(3000);
  assert.equal(c.exitCode, null, 'still sleeping after 3 s');
  process.kill(-c.pid, 'SIGKILL'); // bash and its sleep, so the stderr pipe closes
  c.stderr.destroy();
  assert.equal(err.trim().split('\n').length, 1);
  assert.match(err, /env-run: invalid root/);
});

test('AC-d env-run.sh refuses invalid args and exits 0', { skip: process.platform !== 'darwin' }, () => {
  const R = join(T, 'envrun');
  mkdirSync(R, { recursive: true });
  for (const [args, why] of [
    [[R, 'NOT-A-SHA', '4400', process.execPath], /invalid sha/],
    [[R, A.sha, '80', process.execPath], /invalid port/],
    [[R, A.sha, '4400', 'node'], /not an absolute executable/],
    [[R, A.sha, '4400', process.execPath], /release missing/],
    [[R, A.sha, '4400', process.execPath, `--test-now=${CUTOFF}`], /waiver expired/],
  ]) {
    writeFileSync(join(R, '.supervise'), 'x\n');
    const r = sh('bash', [ENVRUN, ...args]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, why);
    assert.equal(existsSync(join(R, '.supervise')), false, `sentinel deleted (${why})`);
  }
});

test('AC-d start refused after waiver expiry', { skip }, async () => {
  const port = await freePort();
  const R = rootOf('waiver');
  const r = run('waiver', A.dir, port, undefined, { SF_NOW_EPOCH: String(CUTOFF) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✗ waiver expired \(ADR 20261125-061043\)/);
  assert.equal(existsSync(join(AGENTS, `${label(R, 'waiver')}.plist`)), false);
  assert.equal(listening(port), '');
  const s = run('waiver', A.dir, port, undefined, { SF_NOW_EPOCH: String(CUTOFF - 1) });
  assert.equal(s.status, 0, s.out);
  assert.equal(plistKey(join(AGENTS, `${label(R, 'waiver')}.plist`), 'ProgramArguments.5').stdout.trim(), `--test-now=${CUTOFF - 1}`);
});

test('AC-d test overrides ignored outside test mode', { skip }, async () => {
  const name = `sf-test-${process.pid}`, port = await freePort();
  const R = join(homedir(), 'factory-envs', name, 'staging');
  const real = { SF_ENV_ROOT: undefined, SF_HOME: CHECKOUT, SF_LAUNCHAGENTS_DIR: AGENTS, SF_LAUNCHD_DOMAIN: `user/${uid}`, SF_NOW_EPOCH: String(CUTOFF) };
  cleanups.push(() => {
    run(name, A.dir, port, '--stop', real);
    rmSync(join(homedir(), 'factory-envs', name), { recursive: true, force: true });
  });
  const r = run(name, A.dir, port, undefined, real);
  assert.equal(r.status, 0, r.out);
  for (const v of ['SF_LAUNCHD_DOMAIN', 'SF_LAUNCHAGENTS_DIR', 'SF_NOW_EPOCH']) assert.match(r.out, new RegExp(`· ignoring ${v} \\(test-only; SF_ENV_ROOT unset\\)`));
  const lbl = label(R, name);
  assert.ok(existsSync(join(homedir(), 'Library', 'LaunchAgents', `${lbl}.plist`)));
  assert.equal(existsSync(join(AGENTS, `${lbl}.plist`)), false);
  assert.ok(sh('launchctl', ['print', `gui/${uid}/${lbl}`]).status === 0);
  const s = run(name, A.dir, port, '--stop', real);
  assert.equal(s.status, 0, s.out);
  assert.equal(existsSync(join(homedir(), 'Library', 'LaunchAgents', `${lbl}.plist`)), false);
  assert.notEqual(sh('launchctl', ['print', `gui/${uid}/${lbl}`]).status, 0);
});

test('AC-d agents dir override rejects symlink or group-writable dir', { skip: process.platform !== 'darwin' }, async () => {
  const link = join(T, 'agents-link'); symlinkSync(AGENTS, link);
  const gw = join(T, 'agents-gw'); mkdirSync(gw); chmodSync(gw, 0o770);
  for (const dir of [link, gw]) {
    const r = run('agentsdir', A.dir, await freePort(), undefined, { SF_LAUNCHAGENTS_DIR: dir });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /✗ invalid SF_LAUNCHAGENTS_DIR/);
  }
});

test('AC-d rejects node from node_modules/.bin', { skip: process.platform !== 'darwin' }, async () => {
  const port = await freePort();
  for (const sub of ['node_modules/.bin', 'tmpbin']) { // tmpbin: a node under $TMPDIR is rejected too
    const bin = join(T, sub); mkdirSync(bin, { recursive: true });
    if (!existsSync(join(bin, 'node'))) symlinkSync(process.execPath, join(bin, 'node'));
    const r = run('nodepin', A.dir, port, undefined, { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /✗ untrusted node binary/);
    assert.doesNotMatch(r.out, /· build|· stop|· supervisor/, 'nothing built or stopped');
  }
});

test('AC-a bootstrap failure fails deploy', { skip: process.platform !== 'darwin' }, async () => {
  const port = await freePort();
  const R = rootOf('s6');
  const fake = join(T, 'fake-launchctl'); mkdirSync(fake);
  writeFileSync(join(fake, 'launchctl'), '#!/bin/sh\necho "fake launchctl: Bootstrap failed: 5: Input/output error" >&2\nexit 5\n', { mode: 0o755 });
  const r = run('s6', A.dir, port, undefined, { PATH: `${fake}:${process.env.PATH}` });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✗ supervisor bootstrap failed/);
  assert.match(readFileSync(join(R, 'deploy.log'), 'utf8'), /fake launchctl: Bootstrap failed: 5/);
  assert.equal(listening(port), '', 'no nohup fallback');
  assert.equal(existsSync(join(R, '.supervise')), false);
  assert.equal(existsSync(join(AGENTS, `${label(R, 's6')}.plist`)), false);
});

test('AC-f re-probe runs after deploy and at +60s', async () => {
  const calls = [], reports = [];
  let timer;
  const first = await reprobe({
    status: async () => { calls.push(calls.length + 1); return { ok: calls.length === 1, log: 'x' }; },
    report: async (attempt, s) => { reports.push([attempt, s.ok]); },
    timer: (fn, ms) => { timer = { fn, ms }; return { unref() {} }; },
  });
  assert.equal(first.ok, true);
  assert.deepEqual(reports, [[1, true]]);
  assert.equal(timer.ms, 60_000);
  await timer.fn();
  await sleep(10);
  assert.deepEqual(reports, [[1, true], [2, false]]);
  const src = readFileSync(join(CHECKOUT, 'factory', 'lib', 'dispatcher.mjs'), 'utf8');
  assert.match(src, /reprobe\(\{ status: \(\) => run\(`\$\{expand\(r\.ports\?\.\[env\]\)\} --status`\)/);
  assert.match(src, /deploy_reprobe_failed/);
  assert.doesNotMatch(src.slice(src.indexOf('async reportReprobe'), src.indexOf('async reportReprobe') + 900), /rollback\(/, 'never rolls back');
});

test('AC-d dispatcher strips SF_LAUNCHD_*/SF_NOW_EPOCH from real deploy env', () => {
  const e = deployEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x', SF_LAUNCHD_DOMAIN: 'user/1', SF_LAUNCHAGENTS_DIR: '/tmp/a', SF_NOW_EPOCH: '1', SF_HOME: '/h' });
  assert.deepEqual(e, { PATH: '/bin', SF_HOME: '/h' });
  const src = readFileSync(join(CHECKOUT, 'factory', 'lib', 'dispatcher.mjs'), 'utf8');
  assert.match(src, /const env_ = deployEnv\(process\.env\)/);
  assert.match(src, /await run\(`\$\{expand\(port\)\} --stop`, \{ SF_ENV_ROOT: scratch \}\)/);
});
