// Owner request (2026-11-26): an org default Claude credential (subscription token or API key) and a per-agent choice,
// the same credential or a different one. Secrets stay on this machine and never leave through the dashboard view.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.SF_CREDENTIALS_FILE = path.join(mkdtempSync(path.join(tmpdir(), 'sf-creds-')), 'sub', 'credentials.json');
const C = await import('../factory/lib/credentials.mjs');
const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40) + 'TK01', KEY = 'sk-ant-api03-' + 'b'.repeat(40) + 'KY02';
const ROLES = ['engineer', 'reviewer', 'security'];

test('the first credential becomes the org default; agents share it or get their own', () => {
  const tok = C.change({ action: 'add', label: 'Team sub', kind: 'token', secret: TOKEN }, ROLES).added;
  const key = C.change({ action: 'add', label: 'Console', kind: 'api_key', secret: KEY }, ROLES).added;
  assert.equal(C.load().default, tok);
  C.change({ action: 'assign', role: 'security', id: key }, ROLES);
  C.change({ action: 'assign', role: 'reviewer', id: tok }, ROLES); // the same one as the default, pinned
  assert.equal(C.profileFor('engineer').id, tok);
  assert.equal(C.profileFor('reviewer').id, tok);
  assert.equal(C.profileFor('security').id, key);
  assert.equal(statSync(C.file()).mode & 0o777, 0o600);

  const v = JSON.stringify(C.view());
  assert.ok(!v.includes(TOKEN) && !v.includes(KEY) && v.includes('…TK01'), 'the view never carries a secret');

  // Removing a credential sends its agents back to the default.
  C.change({ action: 'remove', id: key }, ROLES);
  assert.equal(C.profileFor('security').id, tok);
  assert.throws(() => C.change({ action: 'assign', role: 'nobody', id: tok }, ROLES), /no role/);
  assert.throws(() => C.change({ action: 'add', label: 'x', kind: 'api_key', secret: TOKEN }, ROLES), /sk-ant-api/);
});

test('a run gets exactly one auth variable; with nothing set it keeps the machine login', () => {
  const env = { ANTHROPIC_API_KEY: 'old', ANTHROPIC_AUTH_TOKEN: 'x', PATH: '/bin' };
  C.applyTo(env, { kind: 'token', secret: TOKEN });
  assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, PATH: '/bin' });
  C.applyTo(env, { kind: 'api_key', secret: KEY });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: KEY, PATH: '/bin' });
  const keep = { ANTHROPIC_API_KEY: 'mine' };
  assert.deepEqual(C.applyTo(keep, null), { ANTHROPIC_API_KEY: 'mine' });
  assert.ok(!readFileSync(C.file(), 'utf8').includes('old'));
});
