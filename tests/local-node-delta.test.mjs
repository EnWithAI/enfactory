// deploy/local-node.sh deltas from #60 on top of #64: rollback argument shape, Node 26+ check, strict db probe, production gate.
// Same harness as tests/local-node.test.mjs (fixture app, temp SF_ENV_ROOT, free ports). Tests run in file order.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { get } from 'node:http';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { stopSupervised } from './fixtures/stop-supervised.mjs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'deploy', 'local-node.sh');
const FIXTURE = join(here, 'fixtures', 'local-node-app');
const T = mkdtempSync(join(tmpdir(), 'local-node-delta-'));
const ENV_ROOT = join(T, 'envs');
const roots = [];
const stubs = [];

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const which = (tool) => sh('sh', ['-c', `command -v ${tool}`]);
const REAL = { npm: which('npm'), git: which('git'), node: process.execPath };
const freePort = () => new Promise((res) => {
  const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const checkout = (label, { mode = 'ok' } = {}) => {
  const dir = join(T, `repo-${label}`);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, 'server', 'mode'), `${mode}\n`);
  writeFileSync(join(dir, 'label.txt'), `${label}\n`);
  sh('git', ['init', '-q'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', label], dir);
  return { dir, sha: sh('git', ['rev-parse', '--short', 'HEAD'], dir) };
};
// PATH shims that count calls into a file, then run the real tool. `node` can be made to report another version for -p.
const shims = (label, { nodeVersion } = {}) => {
  const dir = join(T, `shims-${label}`);
  mkdirSync(dir, { recursive: true });
  const calls = join(dir, 'calls');
  for (const tool of ['npm', 'git']) {
    writeFileSync(join(dir, tool), `#!/bin/sh\necho ${tool} >> '${calls}'\nexec '${REAL[tool]}' "$@"\n`);
    chmodSync(join(dir, tool), 0o755);
  }
  if (nodeVersion) {
    writeFileSync(join(dir, 'node'), `#!/bin/sh\nif [ "$1" = -p ]; then echo ${nodeVersion}; exit 0; fi\nexec '${REAL.node}' "$@"\n`);
    chmodSync(join(dir, 'node'), 0o755);
  }
  const count = (tool) => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter((l) => l === tool).length : 0);
  return { PATH: `${dir}:${process.env.PATH}`, count };
};
const rootOf = (name, env) => join(ENV_ROOT, name, env);
const logOf = (R) => (existsSync(join(R, 'deploy.log')) ? readFileSync(join(R, 'deploy.log'), 'utf8') : '');
const run = (args, { cwd = T, env = {}, R, bashC = false } = {}) => {
  const before = logOf(R);
  const full = { ...process.env, SF_ENV_ROOT: ENV_ROOT, ...env };
  if (!('HOST' in env)) delete full.HOST;
  // bashC: the dispatcher's shape, one string through /bin/bash -c, so an empty {port} collapses.
  const r = bashC
    ? spawnSync('/bin/bash', ['-c', `bash ${SCRIPT} ${args.join(' ')}`], { cwd, env: full, encoding: 'utf8', timeout: 180_000 })
    : spawnSync('bash', [SCRIPT, ...args], { cwd, env: full, encoding: 'utf8', timeout: 180_000 });
  return { ...r, out: r.stdout + r.stderr, appended: logOf(R).slice(before.length) };
};
const current = (R) => { try { return readlinkSync(join(R, 'current')).split('/').pop(); } catch { return null; } };
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null);
const health = (port) => new Promise((res, rej) => {
  get({ host: '127.0.0.1', port, path: '/api/health', agent: false }, (r) => {
    let s = '';
    r.on('data', (d) => { s += d; }).on('end', () => res(JSON.parse(s)));
  }).on('error', rej);
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A staging stand-in in its own process (spawnSync blocks this one): answers /api/health with the reply file, logs each request.
const stagingStub = async () => {
  const dir = mkdtempSync(join(T, 'stub-'));
  const replyFile = join(dir, 'reply.json'), hits = join(dir, 'hits');
  const src = `const fs=require('fs');require('http').createServer((q,s)=>{fs.appendFileSync(${JSON.stringify(hits)},'x');`
    + `const r=JSON.parse(fs.readFileSync(${JSON.stringify(replyFile)},'utf8'));s.writeHead(r.status);s.end(r.body);})`
    + `.listen(0,'127.0.0.1',function(){console.log(this.address().port)});`;
  const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = Number(await new Promise((res) => child.stdout.once('data', (d) => res(String(d).trim()))));
  const stub = {
    port,
    set reply(r) { writeFileSync(replyFile, JSON.stringify(r)); },
    get requests() { return existsSync(hits) ? readFileSync(hits, 'utf8').length : 0; },
    reset() { rmSync(hits, { force: true }); },
    child,
  };
  stub.reply = { status: 200, body: '{}' };
  stubs.push(stub);
  return stub;
};

after(() => {
  for (const s of stubs) s.child.kill('SIGKILL');
  for (const R of roots) {
    stopSupervised(R); // #192: unload the launchd job before anything else
    const pid = Number(read(join(R, 'server.pid')));
    if (pid && alive(pid)) process.kill(pid, 'SIGTERM');
  }
  rmSync(T, { recursive: true, force: true });
});

// ── AC-60-01 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RS = rootOf('enwallet', 'staging');
roots.push(RS);
let sport, A, B;

test('AC-60-01 --rollback as arg 4 still works', async () => {
  sport = await freePort();
  A = checkout('A');
  B = checkout('B');
  for (const X of [A, B]) assert.equal(run(['enwallet', 'staging', String(sport)], { cwd: X.dir, R: RS }).status, 0);
  writeFileSync(join(RS, 'VERIFIED'), `${A.sha}\n`);
  const s = shims('01-arg4');
  const r = run(['enwallet', 'staging', String(sport), '--rollback'], { env: { PATH: s.PATH }, R: RS });
  assert.equal(r.status, 0, r.out);
  assert.equal(current(RS), A.sha);
  assert.equal(read(join(RS, 'VERSION')), A.sha);
  assert.equal((await health(sport)).sha, A.sha);
  assert.equal(s.count('git'), 0);
});

test('AC-60-01 --rollback as arg 3 with empty port takes the rollback path', () => {
  // The dispatcher's string `local-node.sh enwallet staging  --rollback`: the empty port collapses, --rollback is $3.
  // HOST=0.0.0.0 stops the run right after the port is resolved, so the real 4310 is never bound (as in #64's AC-64-01 test).
  const scratch = join(T, 'scratch-01');
  const s = shims('01-arg3');
  const r = run(['enwallet', 'staging', '', '--rollback'], { bashC: true, env: { SF_ENV_ROOT: scratch, HOST: '0.0.0.0', PATH: s.PATH }, R: join(scratch, 'enwallet', 'staging') });
  assert.equal(r.status, 2, r.out);
  assert.match(r.appended, /^── \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ rollback enwallet@none → staging$/m);
  assert.doesNotMatch(r.out, /invalid port/);
  // Without HOST in the way, $3 --rollback reaches AC-64-09's rollback guard (no VERIFIED) rather than the port check.
  const r2 = run(['enwallet', 'staging', '', '--rollback'], { bashC: true, env: { SF_ENV_ROOT: scratch, PATH: s.PATH }, R: join(scratch, 'enwallet', 'staging') });
  assert.equal(r2.status, 1, r2.out);
  assert.match(r2.appended, /^✗ no VERIFIED release to roll back to$/m);
  assert.equal(s.count('git'), 0);
});

test('AC-60-01 empty port defaults to env port', () => {
  const scratch = join(T, 'scratch-01b');
  for (const [env, want] of [['staging', 4310], ['production', 4311]]) {
    const r = run(['enwallet', env, '', '--rollback'], { bashC: true, env: { SF_ENV_ROOT: scratch, HOST: '0.0.0.0' }, R: join(scratch, 'enwallet', env) });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, new RegExp(`^· port ${want}$`, 'm'));
    assert.match(r.appended, new RegExp(`rollback enwallet@none → ${env}$`, 'm'));
  }
});

test('AC-60-01 rollback makes 0 git calls from a non-git cwd', async () => {
  // A full $3 rollback would bind the real 4310, so the end-to-end rollback runs as $4 from a non-git cwd (standing in for the
  // dispatcher's $HOME) with a counting git shim; the $3 shape is proven above to enter the same rollback branch.
  run(['enwallet', 'staging', String(sport)], { cwd: B.dir, R: RS });
  assert.equal(current(RS), B.sha);
  const cwd = mkdtempSync(join(tmpdir(), 'not-git-'));
  assert.notEqual(spawnSync(REAL.git, ['rev-parse', '--git-dir'], { cwd }).status, 0, 'cwd must not be a git repo');
  const s = shims('01-nogit');
  const r = run(['enwallet', 'staging', String(sport), '--rollback'], { cwd, env: { PATH: s.PATH }, R: RS });
  assert.equal(r.status, 0, r.out);
  assert.equal(current(RS), A.sha);
  assert.equal(s.count('git'), 0);
  assert.equal(s.count('npm'), 0);
  rmSync(cwd, { recursive: true, force: true });
});

// ── AC-60-02 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('AC-60-02 node 24 shim exits 1 with "✗ node 26+ required (found 24.0.0)" and 0 npm calls, current unchanged', async () => {
  const pid = Number(read(join(RS, 'server.pid')));
  const s = shims('02', { nodeVersion: '24.0.0' });
  const r = run(['enwallet', 'staging', String(sport)], { cwd: B.dir, env: { PATH: s.PATH }, R: RS });
  assert.equal(r.status, 1, r.out);
  const results = r.appended.split('\n').filter((l) => /^[✓✗↩]/.test(l));
  assert.deepEqual(results, ['✗ node 26+ required (found 24.0.0)']);
  assert.equal(s.count('npm'), 0);
  assert.equal(current(RS), A.sha);
  assert.equal(Number(read(join(RS, 'server.pid'))), pid);
  assert.ok(alive(pid));
  // 26.0.0 passes the version check. Since #192 (S-4) a shim in a temp dir is then refused as an untrusted binary,
  // still before npm or any stop; the version-pass deploy with a trusted node is covered by every other live deploy.
  const ok = shims('02-26', { nodeVersion: '26.0.0' });
  const r2 = run(['enwallet', 'staging', String(sport)], { cwd: B.dir, env: { PATH: ok.PATH }, R: RS });
  assert.equal(r2.status, 1, r2.out);
  assert.match(r2.out, /✗ untrusted node binary/);
  assert.doesNotMatch(r2.out, /node 26\+ required/);
  assert.equal(ok.count('npm'), 0);
  assert.equal(current(RS), A.sha);
  assert.ok(alive(pid));
  // The version-pass deploy of B (what the shim run did before S-4) now runs with the trusted node; AC-60-03 builds on it.
  const r3 = run(['enwallet', 'staging', String(sport)], { cwd: B.dir, R: RS });
  assert.equal(r3.status, 0, r3.out);
  assert.equal(current(RS), B.sha);
});

// ── AC-60-03 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('AC-60-03 probe passes with db:true', async () => {
  assert.deepEqual(await health(sport), { ok: true, db: true, sha: B.sha });
  assert.equal(read(join(RS, 'VERSION')), B.sha);
});

for (const [mode, label] of [['dbfalse', 'db:false'], ['dbstring', 'db:"ok"'], ['nodb', 'no db field'], ['okfalse', 'ok:false'], ['nojson', 'non-JSON health']]) {
  const title = {
    dbfalse: 'AC-60-03 db:false fails and restores previous',
    dbstring: 'AC-60-03 db:"ok" fails',
    nodb: 'AC-60-03 missing db field fails',
    okfalse: 'AC-60-03 ok:false fails',
    nojson: 'AC-60-03 non-JSON health fails',
  }[mode];
  test(title, async () => {
    const X = checkout(`03-${mode}`, { mode });
    const r = run(['enwallet', 'staging', String(sport)], { cwd: X.dir, R: RS });
    assert.equal(r.status, 1, `${label}: ${r.out}`);
    assert.equal(current(RS), B.sha);
    assert.equal(read(join(RS, 'VERSION')), B.sha);
    assert.match(r.appended, new RegExp(`✗ health check failed for enwallet@${X.sha} on staging; ↩ restored ${B.sha}$`, 'm'));
    assert.equal((await health(sport)).sha, B.sha);
  });
}

// ── AC-60-04 ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RP = rootOf('enwallet', 'production');
roots.push(RP);
let pport, stub, P1, P2;

test('AC-60-04 production proceeds when staging healthy on HEAD', async () => {
  pport = await freePort();
  stub = await stagingStub();
  P1 = checkout('P1');
  stub.reply = { status: 200, body: JSON.stringify({ ok: true, db: true, sha: P1.sha }) };
  const r = run(['enwallet', 'production', String(pport)], { cwd: P1.dir, env: { SF_STAGING_PORT: String(stub.port) }, R: RP });
  assert.equal(r.status, 0, r.out);
  assert.ok(stub.requests >= 1);
  assert.match(r.appended, new RegExp(`^· gate: staging 127\\.0\\.0\\.1:${stub.port} reports ${P1.sha}$`, 'm'));
  assert.match(r.appended, new RegExp(`^✓ enwallet@${P1.sha} live on production at http://127\\.0\\.0\\.1:${pport}/$`, 'm'));
  assert.equal((await health(pport)).sha, P1.sha);
});

test('AC-60-04 production refused when staging down / non-200 / sha mismatch / db:false / ok:false / non-JSON (0 npm calls, ✗ line in deploy.log)', async () => {
  P2 = checkout('P2');
  const down = await freePort();
  const good = { ok: true, db: true, sha: P2.sha };
  const cases = [
    ['staging down', down, null],
    ['non-200', stub.port, { status: 500, body: JSON.stringify(good) }],
    ['sha mismatch', stub.port, { status: 200, body: JSON.stringify({ ...good, sha: P1.sha }) }],
    ['db:false', stub.port, { status: 200, body: JSON.stringify({ ...good, db: false }) }],
    ['db:"ok"', stub.port, { status: 200, body: JSON.stringify({ ...good, db: 'ok' }) }],
    ['ok:false', stub.port, { status: 200, body: JSON.stringify({ ...good, ok: false }) }],
    ['non-JSON', stub.port, { status: 200, body: 'not json' }],
  ];
  for (const [why, sp, reply] of cases) {
    if (reply) stub.reply = reply;
    const pid = Number(read(join(RP, 'server.pid')));
    const s = shims(`04-${why.replace(/\W+/g, '-')}`);
    const r = run(['enwallet', 'production', String(pport)], { cwd: P2.dir, env: { SF_STAGING_PORT: String(sp), PATH: s.PATH }, R: RP });
    assert.equal(r.status, 1, `${why}: ${r.out}`);
    const lines = r.appended.split('\n').filter(Boolean);
    assert.match(lines[0], new RegExp(`^── \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ deploy enwallet@${P2.sha} → production$`), why);
    assert.equal(lines.at(-1), `✗ staging is not healthy on ${P2.sha}`, why);
    assert.equal(lines.filter((l) => /^[✓✗↩]/.test(l)).length, 1, why);
    assert.equal(s.count('npm'), 0, why);
    assert.equal(current(RP), P1.sha, why);
    assert.equal(Number(read(join(RP, 'server.pid'))), pid, why);
    assert.ok(alive(pid), why);
    assert.ok(!readdirSync(join(RP, 'releases')).includes(P2.sha), why);
  }
  assert.equal((await health(pport)).sha, P1.sha);
});

test('AC-60-04 production --rollback makes 0 staging requests', async () => {
  stub.reply = { status: 200, body: JSON.stringify({ ok: true, db: true, sha: P2.sha }) };
  assert.equal(run(['enwallet', 'production', String(pport)], { cwd: P2.dir, env: { SF_STAGING_PORT: String(stub.port) }, R: RP }).status, 0);
  writeFileSync(join(RP, 'VERIFIED'), `${P1.sha}\n`);
  stub.reset();
  const r = run(['enwallet', 'production', String(pport), '--rollback'], { env: { SF_STAGING_PORT: String(stub.port) }, R: RP });
  assert.equal(r.status, 0, r.out);
  assert.equal(stub.requests, 0);
  assert.equal(current(RP), P1.sha);
  assert.equal((await health(pport)).sha, P1.sha);
});

test('AC-60-04 invalid SF_STAGING_PORT exits 2', () => {
  for (const bad of ['80', '65536', '04310', 'abc', '4310;id']) {
    const s = shims(`04-port-${bad.replace(/\W+/g, '-')}`);
    const r = run(['enwallet', 'production', String(pport)], { cwd: P2.dir, env: { SF_STAGING_PORT: bad, PATH: s.PATH }, R: RP });
    assert.equal(r.status, 2, `${bad}: ${r.out}`);
    assert.match(r.out, /^✗ invalid SF_STAGING_PORT: /m);
    assert.equal(s.count('npm'), 0);
  }
  assert.equal(current(RP), P1.sha);
});
