// The org template is what every new install starts from: it must be portable (no one's machine paths, logins or project)
// and valid once setup fills it in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const src = readFileSync(new URL('../templates/org/org.yaml', import.meta.url), 'utf8');

test('template carries no machine paths, people or project', () => {
  assert.doesNotMatch(src, /\/Users\/|\/home\/[a-z]/, 'absolute home paths');
  const cfg = parse(src, { merge: true });
  assert.deepEqual(cfg.people, []);
  assert.equal(cfg.product.tracker, '');
  assert.deepEqual(cfg.product.repos, []);
  assert.match(src, /\{FACTORY\}/, 'scoped tool rules use the {FACTORY} placeholder');
});

test('template is a valid org: every stage, pool and team names a real role', () => {
  const cfg = parse(src, { merge: true });
  for (const [stage, st] of Object.entries(cfg.pipeline)) {
    if (st.role) assert.ok(cfg.roles[st.role], `${stage}: ${st.role}`);
    for (const r of st.pool ?? []) assert.ok(cfg.roles[r], `${stage} pool: ${r}`);
    for (const n of st.next ?? []) assert.ok(cfg.pipeline[n] || ['done', 'rejected'].includes(n), `${stage} next: ${n}`);
  }
  for (const [team, t] of Object.entries(cfg.teams)) for (const r of t.roles) assert.ok(cfg.roles[r], `team ${team}: ${r}`);
  for (const r of Object.keys(cfg.roles)) assert.ok(readFileSync(new URL(`../.claude/agents/${r}.md`, import.meta.url)), `agent definition for ${r}`);
});
