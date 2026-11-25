// Fixture build for tests/local-node.test.mjs: dist/index.html references one assets/*.js bundle.
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist/assets', { recursive: true });
writeFileSync('dist/assets/app.js', 'console.log("fixture");\n');
writeFileSync('dist/index.html', '<!doctype html><title>fixture</title><script type="module" src="/assets/app.js"></script>\n');
