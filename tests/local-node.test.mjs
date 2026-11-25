// deploy/local-node.sh (#64): integration tests against a fixture Node app in a temp SF_ENV_ROOT on free ports.
// Tests run in file order and share one staging root (main), so each step builds on the last: A live → B live → C fails …
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { get } from 'node:http';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { lstatSync, symlinkSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'deploy', 'local-node.sh');
const FIXTURE = join(here, 'fixtures', 'local-node-app');
const T = mkdtempSync(join(tmpdir(), 'local-node-'));
const ENV_ROOT = join(T, 'envs');
const roots = [];

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const freePort = () => new Promise((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const baseEnv = (over = {}) => {
  const env = { ...process.env, SF_ENV_ROOT: ENV_ROOT, ...over };
  if (!('HOST' in over)) delete env.HOST;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
};
// A git checkout of the fixture app. mode: ok | 500 | badsha. Every call makes a new commit, so a new sha.
const checkout = (label, { mode = 'ok', drop = [], pkg } = {}) => {
  const dir = join(T, `repo-${label}`);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, 'server', 'mode'), `${mode}\n`);
  writeFileSync(join(dir, 'label.txt'), `${label}\n`);
  for (const f of drop) rmSync(join(dir, f), { force: true });
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  sh('git', ['init', '-q'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', label], dir);
  return { dir, sha: sh('git', ['rev-parse', '--short', 'HEAD'], dir) };
};
const rootOf = (name = 'enwallet', env = 'staging') => join(ENV_ROOT, name, env);
const logOf = (R) => (existsSync(join(R, 'deploy.log')) ? readFileSync(join(R, 'deploy.log'), 'utf8') : '');
const audits = [];
// Runs the script and records what it appended to deploy.log (AC-64-12 checks every record).
const run = (args, { cwd, env = {}, R = rootOf() } = {}) => {
  const before = logOf(R);
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: cwd ?? T, env: baseEnv(env), encoding: 'utf8', timeout: 180_000 });
  const afterLog = logOf(R);
  audits.push({ args, before, after: afterLog, status: r.status });
  return { ...r, out: r.stdout + r.stderr, appended: afterLog.slice(before.length) };
};
const current = (R) => { try { return readlinkSync(join(R, 'current')).split('/').pop(); } catch { return null; } };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null);
// A fresh connection per call (agent: false): a pooled keep-alive socket to a server the script just stopped would reset.
const health = (port) => new Promise((res, rej) => {
  get({ host: '127.0.0.1', port, path: '/api/health', agent: false }, (r) => {
    let s = '';
    r.on('data', (d) => { s += d; }).on('end', () => res(JSON.parse(s)));
  }).on('error', rej);
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const releases = (R) => readdirSync(join(R, 'releases')).sort();

after(() => {
  for (const R of roots) {
    const pid = Number(read(join(R, 'server.pid')));
    if (pid && alive(pid)) process.kill(pid, 'SIGTERM');
  }
  rmSync(T, { recursive: true, force: true });
});

const R = rootOf();
roots.push(R);
let port, A, B;
const dbHashes = [];
const db = () => join(R, 'data', 'enwallet.db');

test('AC-64-01 deploy builds, creates releases/<sha> with dist, server, src/shared, points current at it, creates data/', async () => {
  port = await freePort();
  A = checkout('A');
  const r = run(['enwallet', 'staging', String(port)], { cwd: A.dir });
  assert.equal(r.status, 0, r.out);
  for (const p of ['dist/index.html', 'dist/assets/app.js', 'server/index.mjs', 'src/shared/README']) {
    assert.ok(existsSync(join(R, 'releases', A.sha, p)), p);
  }
  assert.equal(readlinkSync(join(R, 'current')), join(R, 'releases', A.sha));
  assert.ok(statSync(join(R, 'data')).isDirectory());
  assert.match(r.appended, /· build: npm ci --ignore-scripts/);
  // Seed the demo store with known bytes for AC-64-10.
  writeFileSync(db(), 'SQLite format 3\0 fixture ledger bytes');
  dbHashes.push(['seed', sha256(db())]);
});

test('AC-64-01 an empty <port> defaults to 4310 for staging and 4311 for production', () => {
  // A scratch root and HOST=0.0.0.0 stop the run right after the port is resolved, so the real 4310/4311 are never bound.
  const scratch = join(T, 'scratch-envs');
  for (const [env, want] of [['staging', 4310], ['production', 4311]]) {
    const r = spawnSync('bash', [SCRIPT, 'enwallet', env, ''], { cwd: T, env: baseEnv({ SF_ENV_ROOT: scratch, HOST: '0.0.0.0' }), encoding: 'utf8' });
    assert.equal(r.status, 2, r.stdout);
    assert.match(r.stdout, new RegExp(`^· port ${want}$`, 'm'));
    assert.deepEqual(readdirSync(join(scratch, 'enwallet', env, 'releases')), []);
  }
});

test('AC-64-02 one listener on 127.0.0.1:<port>, started from current/server/index.mjs with the env contract; pid in server.pid', () => {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim().split('\n').slice(1);
  assert.equal(lsof.length, 1, lsof.join('\n'));
  assert.match(lsof[0], new RegExp(`127\\.0\\.0\\.1:${port} \\(LISTEN\\)`));
  // Re-deploy the same sha with a trace file to read the server's own view of its environment.
  const trace = join(T, 'trace.json');
  const r = run(['enwallet', 'staging', String(port)], { cwd: A.dir, env: { FIXTURE_TRACE: trace } });
  assert.equal(r.status, 0, r.out);
  const t = JSON.parse(readFileSync(trace, 'utf8'));
  assert.deepEqual(
    { argv1: t.argv1, HOST: t.HOST, PORT: t.PORT, ENWALLET_DB: t.ENWALLET_DB, ENWALLET_SHA: t.ENWALLET_SHA },
    { argv1: join(R, 'current', 'server', 'index.mjs'), HOST: '127.0.0.1', PORT: String(port), ENWALLET_DB: join(R, 'data', 'enwallet.db'), ENWALLET_SHA: A.sha },
  );
  assert.equal(Number(read(join(R, 'server.pid'))), t.pid);
  assert.ok(alive(t.pid));
  dbHashes.push(['redeploy A', sha256(db())]);
});

test('AC-64-04 probe passes (health ok+sha, index, asset) ignoring http_proxy → VERSION written, VERIFIED never written', async () => {
  B = checkout('B');
  const proxy = 'http://127.0.0.1:9';
  const r = run(['enwallet', 'staging', String(port)], { cwd: B.dir, env: { http_proxy: proxy, HTTP_PROXY: proxy, all_proxy: proxy, ALL_PROXY: proxy } });
  assert.equal(r.status, 0, r.out);
  assert.equal(read(join(R, 'VERSION')), B.sha);
  assert.equal(existsSync(join(R, 'VERIFIED')), false);
  assert.match(r.appended, new RegExp(`^✓ enwallet@${B.sha} live on staging at http://127\\.0\\.0\\.1:${port}/$`, 'm'));
  assert.equal((await health(port)).sha, B.sha);
  dbHashes.push(['deploy B (pass)', sha256(db())]);
});

for (const [mode, label] of [['500', 'C'], ['badsha', 'D']]) {
  test(`AC-64-05 failed probe (health ${mode}) restores the previous release, VERSION unchanged, nothing pruned, exit 1`, async () => {
    const X = checkout(label, { mode });
    const before = releases(R);
    const r = run(['enwallet', 'staging', String(port)], { cwd: X.dir });
    assert.equal(r.status, 1, r.out);
    assert.equal(current(R), B.sha);
    assert.equal(read(join(R, 'VERSION')), B.sha);
    assert.match(r.appended, new RegExp(`✗ health check failed for enwallet@${X.sha}`));
    assert.match(r.appended, new RegExp(`↩ restored ${B.sha}`));
    for (const e of before) assert.ok(releases(R).includes(e), `pruned ${e}`);
    assert.equal((await health(port)).sha, B.sha);
    dbHashes.push([`deploy ${label} (fail)`, sha256(db())]);
  });
}

const missing = [
  ['server/index.mjs', { drop: ['server/index.mjs'] }],
  ['package.json scripts.build', { pkg: { name: 'local-node-fixture', version: '1.0.0', private: true, scripts: {} } }],
  ['dist/index.html', { pkg: { name: 'local-node-fixture', version: '1.0.0', private: true, scripts: { build: 'node -e 0' } } }],
];
for (const [item, opts] of missing) {
  test(`AC-64-06 missing precondition ${item} → exit 1 before stopping the live release`, async () => {
    const pid = Number(read(join(R, 'server.pid')));
    const X = checkout(`miss-${item.replace(/\W+/g, '-')}`, opts);
    const r = run(['enwallet', 'staging', String(port)], { cwd: X.dir });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`^✗ missing precondition: ${item.replace(/\./g, '\\.')}$`, 'm'));
    assert.equal(current(R), B.sha);
    assert.equal(Number(read(join(R, 'server.pid'))), pid);
    assert.ok(alive(pid));
    assert.equal((await health(port)).sha, B.sha);
  });
}

test('AC-64-08 --rollback restores VERIFIED: stops B, current → A, probes sha A, VERSION A, no npm or git', async () => {
  writeFileSync(join(R, 'VERIFIED'), `${A.sha}\n`);
  const shims = join(T, 'shims');
  mkdirSync(shims, { recursive: true });
  const marker = join(T, 'shim-called');
  for (const tool of ['npm', 'git']) {
    writeFileSync(join(shims, tool), `#!/bin/sh\necho ${tool} >> '${marker}'\nexit 97\n`);
    chmodSync(join(shims, tool), 0o755);
  }
  const oldPid = Number(read(join(R, 'server.pid')));
  const r = run(['enwallet', 'staging', String(port), '--rollback'], { cwd: T, env: { PATH: `${shims}:${process.env.PATH}` } });
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(marker), false, 'npm or git ran during rollback');
  assert.equal(current(R), A.sha);
  assert.equal(read(join(R, 'VERSION')), A.sha);
  assert.equal(alive(oldPid), false, 'B server stopped');
  assert.match(r.appended, new RegExp(`^↩ \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ enwallet/staging rolled back from ${B.sha} to ${A.sha}$`, 'm'));
  assert.equal((await health(port)).sha, A.sha);
  dbHashes.push(['rollback to A', sha256(db())]);
});

test('AC-64-09 --rollback with no VERIFIED, a missing target, VERIFIED == current, or a tampered ../evil → exit 1, nothing changed', async () => {
  const evil = join(R, 'evil');
  mkdirSync(evil, { recursive: true });
  const cases = [['absent', null], ['missing dir', 'abcdef1'], ['equals current', A.sha], ['tampered', '../evil']];
  for (const [why, value] of cases) {
    if (value === null) rmSync(join(R, 'VERIFIED'), { force: true }); else writeFileSync(join(R, 'VERIFIED'), `${value}\n`);
    const pid = Number(read(join(R, 'server.pid')));
    const r = run(['enwallet', 'staging', String(port), '--rollback']);
    assert.equal(r.status, 1, `${why}: ${r.out}`);
    assert.match(r.out, /^✗ no VERIFIED release to roll back to/m, why);
    assert.equal(current(R), A.sha, why);
    assert.equal(read(join(R, 'VERSION')), A.sha, why);
    assert.equal(Number(read(join(R, 'server.pid'))), pid, why);
    assert.ok(alive(pid), why);
  }
  assert.ok(existsSync(evil), '../evil not touched');
  assert.equal((await health(port)).sha, A.sha);
});

test('AC-64-10 the store R/data/enwallet.db is byte-identical after passing, failing and rollback runs; no data in releases', () => {
  const [, seed] = dbHashes[0];
  assert.ok(dbHashes.length >= 6, JSON.stringify(dbHashes));
  for (const [when, h] of dbHashes) assert.equal(h, seed, `store changed after ${when}`);
  assert.deepEqual(readdirSync(join(R, 'data')), ['enwallet.db']);
  for (const e of releases(R)) {
    const files = readdirSync(join(R, 'releases', e), { recursive: true }).map(String);
    assert.ok(!files.some((f) => f === 'data' || f.startsWith('data/') || f.endsWith('.db')), `${e}: ${files}`);
  }
});

test('AC-64-07 a foreign listener on the port → exit 1 for deploy and rollback; the foreign pid is never signalled', async () => {
  const fport = await freePort();
  const FR = rootOf('enwallet', 'production');
  roots.push(FR);
  mkdirSync(join(FR, 'releases'), { recursive: true });
  cpSync(join(R, 'releases', A.sha), join(FR, 'releases', A.sha), { recursive: true });
  writeFileSync(join(FR, 'VERIFIED'), `${A.sha}\n`);
  writeFileSync(join(FR, 'VERSION'), `${A.sha}\n`);
  const foreign = spawn(process.execPath, ['-e', `require("net").createServer().listen(${fport},"127.0.0.1",()=>console.log("up"));process.on("SIGTERM",()=>{require("fs").writeFileSync(${JSON.stringify(join(T, 'foreign-signalled'))},"1");process.exit(0)})`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((res) => foreign.stdout.once('data', res));
  try {
    for (const args of [['enwallet', 'production', String(fport)], ['enwallet', 'production', String(fport), '--rollback']]) {
      const r = run(args, { cwd: A.dir, R: FR });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, new RegExp(`^✗ port ${fport} is in use by another process`, 'm'));
      assert.ok(alive(foreign.pid), 'foreign process still alive');
      assert.equal(existsSync(join(T, 'foreign-signalled')), false);
      assert.equal(current(FR), null);
      assert.equal(read(join(FR, 'VERSION')), A.sha);
      assert.deepEqual(releases(FR), [A.sha]);
    }
  } finally {
    foreign.kill('SIGKILL');
  }
});

test('AC-64-11 retention keeps the 5 newest plus VERIFIED and current; prunes only after a passing probe', async () => {
  const rport = await freePort();
  const RR = rootOf('retain', 'staging');
  roots.push(RR);
  const old = ['aaaaaa1', 'aaaaaa2', 'aaaaaa3', 'aaaaaa4', 'aaaaaa5', 'aaaaaa6'];
  const now = Date.now() / 1000;
  old.forEach((id, i) => {
    mkdirSync(join(RR, 'releases', id, 'server'), { recursive: true });
    utimesSync(join(RR, 'releases', id), now - 1000 + i * 10, now - 1000 + i * 10);
  });
  writeFileSync(join(RR, 'VERIFIED'), 'aaaaaa1\n');
  const E = checkout('E');
  let r = run(['retain', 'staging', String(rport)], { cwd: E.dir, R: RR });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(releases(RR), ['aaaaaa1', 'aaaaaa3', 'aaaaaa4', 'aaaaaa5', 'aaaaaa6', E.sha].sort());
  // VERIFIED inside the 5 newest → exactly 5. A failing deploy in between prunes nothing.
  const bad = checkout('F', { mode: '500' });
  const before = releases(RR);
  r = run(['retain', 'staging', String(rport)], { cwd: bad.dir, R: RR });
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(releases(RR), [...before, bad.sha].sort());
  writeFileSync(join(RR, 'VERIFIED'), 'aaaaaa6\n');
  const G = checkout('G');
  r = run(['retain', 'staging', String(rport)], { cwd: G.dir, R: RR });
  assert.equal(r.status, 0, r.out);
  const left = releases(RR);
  assert.equal(left.length, 5, left.join(' '));
  assert.ok(left.includes('aaaaaa6') && left.includes(G.sha));
});

test('AC-64-03 bad HOST, name, env, port, arg count, flag or SF_ENV_ROOT → exit 2 before any build, nothing created', () => {
  const shims = join(T, 'shims-03');
  mkdirSync(shims, { recursive: true });
  const marker = join(T, 'npm-called-03');
  writeFileSync(join(shims, 'npm'), `#!/bin/sh\necho npm >> '${marker}'\nexit 97\n`);
  chmodSync(join(shims, 'npm'), 0o755);
  const IR = rootOf('enwallet', 'staging');
  const curBefore = current(IR);
  const relBefore = releases(IR);
  const cases = [
    [{ HOST: '0.0.0.0' }, ['enwallet', 'staging', '4400'], /^✗ refusing bind: HOST=0\.0\.0\.0 /m],
    [{ HOST: 'localhost' }, ['enwallet', 'staging', '4400'], /^✗ refusing bind: HOST=localhost /m],
    [{ HOST: '::' }, ['enwallet', 'staging', '4400'], /^✗ refusing bind: HOST=::/m],
    [{ HOST: '' }, ['enwallet', 'staging', '4400'], /^✗ refusing bind: HOST=''/m],
    [{}, ['enwallet', '../x', '4400'], /^✗ invalid environment: \.\.\/x/m],
    [{}, ['Bad_Name', 'staging', '4400'], /^✗ invalid repo name: Bad_Name/m],
    [{}, ['-x', 'staging', '4400'], /^✗ invalid repo name: -x/m],
    [{}, ['enwallet', 'staging', '80'], /^✗ invalid port: 80 /m],
    [{}, ['enwallet', 'staging', '1023'], /^✗ invalid port: 1023 /m],
    [{}, ['enwallet', 'staging', '65536'], /^✗ invalid port: 65536 /m],
    [{}, ['enwallet', 'staging', '04310'], /^✗ invalid port: 04310 /m],
    [{}, ['enwallet', 'staging', '4400', '--rollback', 'extra'], /^✗ too many arguments/m],
    [{}, ['enwallet', 'staging', '4400', '--bogus'], /^✗ invalid flag: --bogus/m],
    [{ SF_ENV_ROOT: 'relative/path' }, ['enwallet', 'staging', '4400'], /^✗ invalid SF_ENV_ROOT: relative\/path/m],
  ];
  for (const [env, args, want] of cases) {
    const r = run(args, { cwd: A.dir, env: { ...env, PATH: `${shims}:${process.env.PATH}` }, R: IR });
    assert.equal(r.status, 2, `${JSON.stringify(env)} ${args}: ${r.out}`);
    assert.match(r.out, want);
  }
  assert.equal(existsSync(marker), false, 'npm ran');
  assert.equal(existsSync(join(T, 'relative')), false, 'relative SF_ENV_ROOT created');
  assert.equal(current(IR), curBefore);
  assert.deepEqual(releases(IR), relBefore);
});

test('AC-64-12 deploy.log: start line, step lines, exactly one result line per run; append-only; owner-only modes', () => {
  const logged = audits.filter((a) => a.after.length > a.before.length);
  assert.ok(logged.length >= 12, `runs logged: ${logged.length}`);
  for (const a of logged) {
    assert.ok(a.after.startsWith(a.before), `log rewritten by ${a.args}`);
    const lines = a.after.slice(a.before.length).split('\n').filter(Boolean);
    assert.match(lines[0], /^── \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ (deploy|rollback) [a-z0-9-]+@\S+ → (staging|production)$/, `${a.args}`);
    const results = lines.filter((l) => /^[✓✗↩]/.test(l));
    assert.equal(results.length, 1, `${a.args}: ${results.join(' | ')}`);
    assert.equal(results[0], lines.at(-1), `${a.args}: result line is last`);
    if (a.status === 0 && a.args.length === 3 && a.args[2] !== '') {
      for (const s of ['· build', '· copy', '· stop', '· start', '· probe']) {
        if (s === '· stop' && !lines.some((l) => l.startsWith(s))) continue; // first deploy into an empty root has nothing to stop
        assert.ok(lines.some((l) => l.startsWith(s)), `${a.args}: missing ${s}`);
      }
    }
  }
  assert.ok(logOf(R).includes('fixture listening on 127.0.0.1'), 'server start output appended');
  for (const p of ['deploy.log', 'server.log', 'server.pid', 'releases', 'data']) {
    assert.equal(statSync(join(R, p)).mode & 0o077, 0, `${p} is owner-only`);
  }
});

test('AC-64-13 no URL in the script has a host other than exactly 127.0.0.1 (grep self-test 3/3 positives, 0/3 near-misses)', () => {
  const re = 'https?://([^1]|1[^2]|12[^7]|127[^.]|127\\.[^0]|127\\.0[^.]|127\\.0\\.[^0]|127\\.0\\.0[^.]|127\\.0\\.0\\.[^1]|127\\.0\\.0\\.1[^:/])';
  const count = (file) => spawnSync('grep', ['-cE', re, file], { encoding: 'utf8' }).stdout.trim();
  assert.equal(count(SCRIPT), '0');
  const pos = join(T, 'pos.txt'), neg = join(T, 'neg.txt');
  writeFileSync(pos, 'http://0.0.0.0:4310/\nhttps://example.com/\nhttp://127.0.0.10:4310/\n');
  writeFileSync(neg, 'http://127.0.0.1:4310/\nhttp://127.0.0.1/\nhttp://127.0.0.1:$port/\n');
  assert.equal(count(pos), '3');
  assert.equal(count(neg), '0');
});

test('AC-64-14 README documents deploy/local-node.sh and its usage line', () => {
  const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
  assert.ok(readme.includes('deploy/local-node.sh'));
  assert.ok(readme.includes('local-node.sh <name> <env> <port> [--rollback]'));
});

// ── #53: releases carry src/shared and src/brand; the import-closure guard runs before any stop or switch. ──
// Separate roots (shared, carry, prune, nosrc) so the AC-64 sequence above is never disturbed.
const OVERLAY = join(here, 'fixtures', 'local-node-app-shared');
// A git checkout of the base fixture with the shared overlay copied over it. edit(dir) changes files before the commit.
const sharedCheckout = (label, edit = () => {}) => {
  const dir = join(T, `repo53-${label}`);
  cpSync(FIXTURE, dir, { recursive: true });
  cpSync(OVERLAY, dir, { recursive: true, force: true });
  writeFileSync(join(dir, 'label.txt'), `${label}\n`);
  edit(dir);
  sh('git', ['init', '-q'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', label], dir);
  return { dir, sha: sh('git', ['rev-parse', '--short', 'HEAD'], dir) };
};
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const postPay = (p) => new Promise((res, rej) => {
  const body = '{}';
  const req = request({
    host: '127.0.0.1', port: p, path: '/api/wallet/payments', method: 'POST', agent: false,
    headers: { 'Content-Type': 'application/json', 'X-Enwallet-Csrf': '1', Origin: `http://127.0.0.1:${p}`, 'Content-Length': Buffer.byteLength(body) },
  }, (r) => { let s = ''; r.on('data', (d) => { s += d; }).on('end', () => res({ status: r.statusCode, body: s })); });
  req.on('error', rej);
  req.end(body);
});
const bytes = (p) => (existsSync(p) || isLink(p) ? (isLink(p) ? `link:${readlinkSync(p)}` : readFileSync(p, 'hex')) : null);
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const findSrcDirs = (root) => spawnSync('find', [root, '-type', 'd', '(', '-path', '*src/shared', '-o', '-path', '*src/brand', ')', '-not', '-path', `${root}/releases/*`], { encoding: 'utf8' }).stdout.trim();

const SR = rootOf('shared', 'staging');
roots.push(SR);
let sport, S1;

test('AC-53-01 release has whole src/shared and src/brand and no other src entry', async () => {
  sport = await freePort();
  S1 = sharedCheckout('S1', (d) => put(d, 'src/shared/extra/new.mjs', "export const NEW = 1;\n"));
  const r = run(['shared', 'staging', String(sport)], { cwd: S1.dir, R: SR });
  assert.equal(r.status, 0, r.out);
  const rel = join(SR, 'releases', S1.sha);
  for (const p of ['dist', 'server', 'src/shared', 'src/brand']) assert.ok(existsSync(join(rel, p)), p);
  for (const d of ['src/shared', 'src/brand']) {
    const diff = spawnSync('diff', ['-r', join(S1.dir, d), join(rel, d)], { encoding: 'utf8' });
    assert.equal(diff.status, 0, `${d}: ${diff.stdout}`);
  }
  for (const p of ['src/shared/upi/parseUpiPayUri.mjs', 'src/shared/merchants.mjs', 'src/shared/money.mjs', 'src/shared/extra/new.mjs', 'src/brand/constants.ts']) {
    assert.ok(existsSync(join(rel, p)), p);
  }
  assert.deepEqual(readdirSync(join(rel, 'src')).sort(), ['brand', 'shared']);
  assert.equal(existsSync(join(rel, 'src', 'app')), false, 'src/app/App.tsx shipped');
  assert.match(r.appended, /^· copy dist, server, src\/shared, src\/brand → releases\//m);
  assert.doesNotMatch(r.out, /^closure: /m, 'valid closure prints nothing');
});

test('AC-53-02 server runs from release after source dir is deleted; no-session pay is 401', async () => {
  rmSync(S1.dir, { recursive: true, force: true });
  const h = await health(sport);
  assert.equal(h.db, true);
  assert.equal(h.sha, S1.sha);
  assert.equal(h.mark, 'A');
  const p = await postPay(sport);
  assert.equal(p.status, 401, p.body);
  assert.deepEqual(JSON.parse(p.body), { error: 'unauthenticated' });
  const log = readFileSync(join(SR, 'server.log'), 'utf8');
  assert.equal(log.split('\n').filter((l) => l.includes('ERR_MODULE_NOT_FOUND')).length, 0, log);
});

const closureCases = [
  ['a', (d) => put(d, 'server/wallet/pay.mjs', `import '../../src/app/App.tsx';\n${readFileSync(join(OVERLAY, 'server/wallet/pay.mjs'), 'utf8')}`),
    'closure: server/wallet/pay.mjs -> ../../src/app/App.tsx'],
  ['b', (d) => put(d, 'server/x.mjs', "import { y } from '../../outside/y.mjs';\nexport { y };\n"), 'closure: server/x.mjs -> ../../outside/y.mjs'],
  ['c', (d) => put(d, 'server/x.mjs', "export const z = () => import('../../src/lib/z.mjs');\n"), 'closure: server/x.mjs -> ../../src/lib/z.mjs'],
  ['d', (d) => put(d, 'src/shared/merchants.mjs', `import '../app/App.tsx';\n${readFileSync(join(OVERLAY, 'src/shared/merchants.mjs'), 'utf8')}`),
    'closure: src/shared/merchants.mjs -> ../app/App.tsx'],
  ['e', (d) => symlinkSync('money.mjs', join(d, 'src/shared/link.mjs')), 'closure: src/shared/link.mjs -> symlink'],
  ['f', (d) => put(d, 'src/brand/x.ts', "import { App } from '../app/App.tsx';\nexport const X: unknown = App;\n"), 'closure: src/brand/x.ts -> ../app/App.tsx'],
];
for (const [c, edit, want] of closureCases) {
  test(`AC-53-03 closure guard fails before switch (${c})`, async () => {
    const X = sharedCheckout(`bad-${c}`, edit);
    const state = () => ['current', 'VERSION', 'server.pid'].map((f) => bytes(join(SR, f)));
    const before = state();
    const relBefore = releases(SR);
    const r = run(['shared', 'staging', String(sport)], { cwd: X.dir, R: SR });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(r.stdout.split('\n').filter((l) => l.startsWith('closure: ')), [want]);
    assert.match(r.appended, new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm'));
    assert.match(r.appended, new RegExp(`^✗ import closure check failed for shared@${X.sha}; nothing switched$`, 'm'));
    for (const s of ['· stop', '· start', '· probe']) assert.ok(!r.appended.includes(s), `${s} ran`);
    assert.deepEqual(releases(SR), relBefore, 'releases/ changed (tmp left or rm/mv ran)');
    assert.ok(!releases(SR).some((e) => e.startsWith('.tmp-')));
    assert.deepEqual(state(), before);
    assert.equal((await health(sport)).sha, S1.sha);
  });
}

test('AC-53-03 closure guard passes a project with no src/shared or src/brand', async () => {
  const NR = rootOf('nosrc', 'staging');
  roots.push(NR);
  const N = checkout('nosrc');
  rmSync(join(N.dir, 'src'), { recursive: true, force: true });
  const r = run(['nosrc', 'staging', String(await freePort())], { cwd: N.dir, R: NR });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /^closure: /m);
  assert.equal(existsSync(join(NR, 'releases', N.sha, 'src')), false);
});

test('AC-53-05 rollback to VERIFIED and prune carry src/shared', async () => {
  const CR = rootOf('carry', 'staging');
  roots.push(CR);
  const cport = await freePort();
  const CA = sharedCheckout('CA');
  const CB = sharedCheckout('CB', (d) => put(d, 'src/shared/money.mjs', "export const MARK = 'B';\n"));
  for (const X of [CA, CB]) assert.equal(run(['carry', 'staging', String(cport)], { cwd: X.dir, R: CR }).status, 0);
  assert.equal((await health(cport)).mark, 'B');
  writeFileSync(join(CR, 'VERIFIED'), `${CA.sha}\n`);
  const r = run(['carry', 'staging', String(cport), '--rollback'], { R: CR });
  assert.equal(r.status, 0, r.out);
  assert.equal(sha256(join(CR, 'current', 'src', 'shared', 'money.mjs')), sha256(join(CR, 'releases', CA.sha, 'src', 'shared', 'money.mjs')));
  const h = await health(cport);
  assert.equal(h.sha, CA.sha);
  assert.equal(h.mark, 'A');
  assert.equal(findSrcDirs(CR), '');

  // 7 deploys with VERIFIED on the 1st: the 5 newest plus VERIFIED stay; the 2nd is pruned with its src/*.
  const PR = rootOf('prune', 'staging');
  roots.push(PR);
  const pport = await freePort();
  const shas = [];
  for (let i = 1; i <= 7; i += 1) {
    const X = sharedCheckout(`P${i}`);
    const rr = run(['prune', 'staging', String(pport)], { cwd: X.dir, R: PR });
    assert.equal(rr.status, 0, rr.out);
    shas.push(X.sha);
    if (i === 1) writeFileSync(join(PR, 'VERIFIED'), `${X.sha}\n`);
  }
  assert.deepEqual(releases(PR), [shas[0], ...shas.slice(2)].sort());
  assert.equal(existsSync(join(PR, 'releases', shas[1])), false, 'pruned release dir left behind');
  for (const s of releases(PR)) {
    for (const d of ['src/shared/money.mjs', 'src/brand/constants.ts']) assert.ok(existsSync(join(PR, 'releases', s, d)), `${s}/${d}`);
  }
  assert.equal(findSrcDirs(PR), '');
});
