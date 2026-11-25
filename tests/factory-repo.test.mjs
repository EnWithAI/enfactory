// Feedback 01406a6d / 21182531 (#42, #81): a change to the factory's own code goes through the pipeline as factory_paths,
// is published to the factory repo, never deployed, and never confused with a product repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Dispatcher, factoryRepo, factoryPaths } from '../factory/lib/dispatcher.mjs';

const cfg = {
  product: { tracker: 'acme/wallet', repos: [{ name: 'enwallet', repo: 'acme/enwallet', default_branch: 'main', deploy_command: 'deploy.sh', health: { staging: 'http://127.0.0.1:4310/' } }] },
  environments: ['staging', 'production'],
  pipeline: { 'tech-grooming': { next: ['build'] }, build: { next: ['review'] }, review: {} },
};
const make = () => { const d = new Dispatcher(cfg); d.factory = { name: 'software-factory', repo: 'acme/factory', default_branch: 'main', factory: true }; return d; };

test('the factory repo comes from the install\'s own git remote, or is absent', () => {
  const f = factoryRepo();
  if (f) { assert.match(f.repo, /^[^/]+\/[^/]+$/); assert.equal(f.factory, true); assert.equal(f.name, 'software-factory'); }
});

test('tech-grooming offers factory_paths, and its repos list stays product-only', () => {
  const x = make().extra('tech-grooming');
  assert.deepEqual(x.repos.items.enum, ['enwallet']);
  assert.ok(!x.repos.items.enum.includes('software-factory'), 'the factory is never a product repo');
  assert.ok(!x.repos.items.enum.includes('mystery'), 'an unknown repo still fails the enum');
  assert.equal(x.factory_paths.type, 'array');
});

test('factory paths: code only, never this install\'s data', () => {
  const { ok, refused } = factoryPaths(['deploy/local-node.sh', './factory/lib/checks.mjs', 'org/org.yaml', 'memory/x.md', 'library/a.md', '../etc/passwd', '']);
  assert.deepEqual(ok, ['deploy/local-node.sh', 'factory/lib/checks.mjs']);
  assert.deepEqual(refused, ['org/org.yaml', 'memory/x.md', 'library/a.md', '../etc/passwd', '']);
});

test('a factory-only change works in the factory repo alone and deploys nothing', () => {
  const d = make(), state = { factory: { paths: ['deploy/local-node.sh'] } };
  assert.deepEqual(d.touched(state).map((r) => r.name), ['software-factory']);
  assert.deepEqual(d.deployable(state), []);
});

test('a mixed change works in both, and only the product repo is deployed', () => {
  const d = make(), state = { repos: ['enwallet'], factory: { paths: ['deploy/local-node.sh'] } };
  assert.deepEqual(d.touched(state).map((r) => r.name), ['enwallet', 'software-factory']);
  assert.deepEqual(d.deployable(state).map((r) => r.name), ['enwallet']);
  assert.equal(d.repoByName('software-factory').repo, 'acme/factory', 'PR links resolve for the factory repo');
});

test('without factory_paths nothing changes', () => {
  const d = make();
  assert.deepEqual(d.touched({}).map((r) => r.name), ['enwallet']);
  assert.deepEqual(d.touched({ repos: ['enwallet'] }).map((r) => r.name), ['enwallet']);
});
