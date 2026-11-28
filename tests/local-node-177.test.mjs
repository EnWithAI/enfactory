// #177: deploy/local-node.sh ships deploy/csp.txt beside server/, and aborts before switching when server/ reads it but
// the checkout has none. Same fixture app and temp SF_ENV_ROOT shape as tests/local-node.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { stopSupervised } from './fixtures/stop-supervised.mjs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'deploy', 'local-node.sh');
const FIXTURE = join(here, 'fixtures', 'local-node-app');
const T = mkdtempSync(join(tmpdir(), 'local-node-177-'));
const ENV_ROOT = join(T, 'envs');
const pids = [];
const roots = new Set();
after(() => {
  for (const R of roots) stopSupervised(R); // #192: unload the launchd jobs before anything else
  for (const pid of pids) try { process.kill(pid); } catch {}
  rmSync(T, { recursive: true, force: true });
});

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const freePort = () => new Promise((res) => {
  const s = netServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const POLICY = "default-src 'self'; frame-ancestors 'none'\n";
const checkout = (label, { csp, serverRef }) => {
  const dir = join(T, `repo-${label}`);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, 'server', 'mode'), 'ok\n');
  if (serverRef) writeFileSync(join(dir, 'server', 'csp-ref.mjs'), "// reads ../deploy/csp.txt at start-up\nexport {};\n");
  if (csp) {
    mkdirSync(join(dir, 'deploy'));
    writeFileSync(join(dir, 'deploy', 'csp.txt'), csp);
  }
  sh('git', ['init', '-q'], dir);
  sh('git', ['add', '-A'], dir);
  sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', label], dir);
  return { dir, sha: sh('git', ['rev-parse', '--short', 'HEAD'], dir) };
};
const deploy = (name, cwd, port) => {
  const env = { ...process.env, SF_ENV_ROOT: ENV_ROOT };
  delete env.HOST;
  const r = spawnSync('bash', [SCRIPT, name, 'staging', String(port)], { cwd, env, encoding: 'utf8', timeout: 180_000 });
  const R = join(ENV_ROOT, name, 'staging');
  roots.add(R);
  if (existsSync(join(R, 'server.pid'))) pids.push(Number(readFileSync(join(R, 'server.pid'), 'utf8')));
  return { ...r, out: r.stdout + r.stderr, R };
};

test('AC-177-08 release ships deploy/csp.txt byte-equal to the checkout', async () => {
  const { dir, sha } = checkout('ship', { csp: POLICY, serverRef: true });
  const r = deploy('csp-ship', dir, await freePort());
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /· copy deploy\/csp\.txt/);
  const shipped = readFileSync(join(r.R, 'releases', sha, 'deploy', 'csp.txt'));
  assert.equal(Buffer.compare(shipped, readFileSync(join(dir, 'deploy', 'csp.txt'))), 0);
});

test('AC-177-08 server/ references deploy/csp.txt but the checkout has none → exit 1, nothing switched', async () => {
  const { dir, sha } = checkout('nofile', { serverRef: true });
  const r = deploy('csp-missing', dir, await freePort());
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✗ server reads deploy\/csp\.txt but the release has none/);
  assert.equal(existsSync(join(r.R, 'releases', sha)), false);
  assert.equal(existsSync(join(r.R, 'current')), false);
});
