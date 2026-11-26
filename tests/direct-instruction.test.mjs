// A direct instruction from the owner to one agent (dashboard: click an agent). It runs outside the pipeline, so a role that
// can write anywhere or run any shell command runs read-only; code changes still go through build, review and security.
import test from 'node:test';
import assert from 'node:assert/strict';
import { directTools } from '../factory/lib/dashboard.mjs';

const read = ['Read', 'Grep', 'Glob', 'Bash(gh issue view:*)'];
const cfg = {
  tool_profiles: { read },
  roles: {
    engineer: { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] },
    'gate-verification-engineer': { tools: ['Read', 'Grep', 'Glob', 'Bash'] },
    'product-manager': { tools: ['Read', 'Bash(sf lint:*)', 'Write(/x/memory/specs/**)', 'Edit(/x/memory/specs/**)'] },
    sre: { tools: ['Read', 'Write(/tmp/sre/**)', 'Bash(curl:*)'] },
  },
};

test('roles that can write anywhere or run any command take direct instructions read-only', () => {
  assert.deepEqual(directTools(cfg, 'engineer'), read);
  assert.deepEqual(directTools(cfg, 'gate-verification-engineer'), read, 'unrestricted Bash alone is enough');
});

test('roles with only scoped writes and commands keep their own tools', () => {
  assert.deepEqual(directTools(cfg, 'product-manager'), cfg.roles['product-manager'].tools);
  assert.deepEqual(directTools(cfg, 'sre'), cfg.roles.sre.tools);
});

test('an unknown role gets no tools', () => {
  assert.deepEqual(directTools(cfg, 'nobody'), []);
});
