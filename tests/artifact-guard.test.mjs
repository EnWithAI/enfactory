// Feedback 118f8faf (#68): a council's one-line decision replaced the spec, and spec_lint looped on "No acceptance criteria".
// A stage artifact is never replaced by text that drops its acceptance criteria or is a fraction of the previous version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { artifactRegression } from '../factory/lib/memory.mjs';
import { specLint } from '../factory/lib/checks.mjs';
import { loadConfig } from '../factory/lib/config.mjs';

const spec = readFileSync(new URL('./fixtures/spec-issue-2-v3.md', import.meta.url), 'utf8');

test('the #68 case: a council decision replacing a spec is refused, and the kept spec still lints', () => {
  assert.match(artifactRegression(spec, '# Council decision #68\nRoute: tech-grooming.'), /acceptance criteria/);
  const predates134 = (f) => !/closed set \("exactly"|§4a has no "Repo invariant" row/.test(f); // the fixture predates owner request #134
  assert.deepEqual(specLint(spec, loadConfig()).failures.filter(predates134), [], 'the version that is kept passes spec_lint');
});

test('a much shorter replacement of a substantial artifact is refused', () => {
  const design = `# Tech design\n${'Detailed design text. '.repeat(200)}`;
  assert.match(artifactRegression(design, '# Tech design\nSee previous.'), /characters against/);
});

test('normal revisions are accepted', () => {
  assert.equal(artifactRegression('', '# Anything'), null, 'first version');
  assert.equal(artifactRegression(spec, `${spec}\n## Delta\nOne AC tightened.`), null, 'growing revision');
  assert.equal(artifactRegression(spec, spec.replace('Press release', 'Announcement')), null, 'edit in place');
  assert.equal(artifactRegression('# Short note\nok', '# Other\nfine'), null, 'small artifacts may be rewritten freely');
});
