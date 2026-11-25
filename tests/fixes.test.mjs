// One-click fixes from the request and complaint box must never grant more than read-only tools or writes inside memory/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validate, SAFE_TOOLS } from '../factory/lib/fixes.mjs';

const cfg = parse(readFileSync(new URL('../templates/org/org.yaml', import.meta.url), 'utf8'), { merge: true });
const ok = (fix) => assert.equal(validate(fix, cfg).ok, true, JSON.stringify(validate(fix, cfg)));
const no = (fix, why) => { const v = validate(fix, cfg); assert.equal(v.ok, false, `${why}: ${JSON.stringify(fix)}`); };

test('read-only tools can be granted; anything that can write or run code cannot', () => {
  ok({ kind: 'grant_tools', role: 'architect', tools: ['Bash(npm view:*)', 'Bash(git status:*)'] });
  for (const t of ['Bash', 'Bash(git -C:*)', 'Bash(git:*)', 'Bash(npm install:*)', 'Bash(node:*)', 'Bash(rm:*)', 'Edit', 'Write', 'Bash(git branch:*)'])
    no({ kind: 'grant_tools', role: 'architect', tools: [t] }, `must refuse ${t}`);
  no({ kind: 'grant_tools', role: 'nobody', tools: ['Read'] }, 'unknown role');
  assert.ok(![...SAFE_TOOLS].some((t) => /\bBash\((git -C|cd|npm (install|i |run)|node (?!--version\))|sh |bash )/.test(t)));
});

test('writes stay inside memory/ (not the records only the dispatcher writes) or a /tmp scratch folder', () => {
  ok({ kind: 'scoped_write', role: 'product-manager', paths: ['memory/specs/**'] });
  ok({ kind: 'scoped_write', role: 'sre', paths: ['/tmp/sre/**'] });
  for (const x of ['memory/ledger/**', 'memory/state/x.json', 'memory/hr/**', 'memory/decisions/**', 'memory/runs/**', 'org/org.yaml', 'factory/**', '../etc/**', 'memory/../org/**', '/etc/**', '/tmp/**', '**'])
    no({ kind: 'scoped_write', role: 'product-manager', paths: [x] }, `must refuse ${x}`);
});

test('doc edits only touch org documents and the library, with an exact single match', () => {
  no({ kind: 'doc_edit', file: 'org/org.yaml', find: 'a', replace: 'b' }, 'config is not a document');
  no({ kind: 'doc_edit', file: 'factory/lib/worker.mjs', find: 'a', replace: 'b' }, 'code is not a document');
  no({ kind: 'doc_edit', file: 'org/charters/../org.yaml', find: 'a', replace: 'b' }, 'no traversal');
});

test('lint families, lessons and factory code', () => {
  ok({ kind: 'lint_family', families: ['contract'] });
  no({ kind: 'lint_family', families: ['Bad Family!'] }, 'lowercase words only');
  ok({ kind: 'lesson', role: 'all', text: 'Check spend before starting a spend-gated item.' });
  no({ kind: 'lesson', role: 'nobody', text: 'x' }, 'unknown role');
  no({ kind: 'factory_code', brief: 'add a wait outcome' }, 'code changes are never applied from the dashboard');
});
