#!/usr/bin/env node
// Import-closure guard for deploy/local-node.sh (#53). Usage: check-import-closure.mjs <stageDir>
// Every relative import in the staged release must resolve to an existing regular file inside one of its roots:
//   server (required, *.mjs → .mjs) · src/shared (if present, *.mjs → .mjs) · src/brand (if present, *.ts|*.mjs → .ts|.mjs).
// A .ts target is valid only under src/brand. Any symlink fails. Bare and node: specifiers are ignored (server is
// stdlib-only); a non-literal import() cannot be checked statically. Comments are scanned too, so the guard fails closed.
// Prints one `closure: <stage-relative file> -> <specifier|symlink>` line per failure.
// Exit 0 silently when the closure is complete, 1 on any failure, 2 on a bad argument.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const ROOTS = [
  { rel: 'server', required: true, scan: ['.mjs'], targets: ['.mjs'] },
  { rel: join('src', 'shared'), required: false, scan: ['.mjs'], targets: ['.mjs'] },
  { rel: join('src', 'brand'), required: false, scan: ['.ts', '.mjs'], targets: ['.mjs', '.ts'] },
];
const IMPORT_RES = [
  /from\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g,
  /import\s*\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*\)/g,
  /(?:^|[;\s])import\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g,
];

function usage(msg) {
  process.stderr.write(`check-import-closure: ${msg}\n`);
  process.exit(2);
}

function main(argv) {
  if (argv.length !== 1 || !argv[0]) usage('expected exactly one argument: <stageDir>');
  let stage;
  try { stage = realpathSync(argv[0]); } catch { usage(`stage directory not found: ${argv[0]}`); }
  if (!lstatSync(stage).isDirectory()) usage(`not a directory: ${argv[0]}`);

  const roots = [];
  for (const r of ROOTS) {
    const abs = join(stage, r.rel);
    if (!existsSync(abs)) {
      if (r.required) usage(`missing required root: ${r.rel}`);
      continue;
    }
    roots.push({ ...r, abs: realpathSync(abs) });
  }

  const failures = [];
  const fail = (file, what) => failures.push(`closure: ${relative(stage, file)} -> ${what}`);
  const rootOf = (p) => roots.find((r) => p.startsWith(r.abs + sep));

  for (const root of roots) {
    for (const file of walk(root.abs, fail)) {
      if (!root.scan.includes(extname(file))) continue;
      const text = readFileSync(file, 'utf8');
      const specs = new Set();
      for (const re of IMPORT_RES) for (const m of text.matchAll(re)) specs.add(m[2]);
      for (const spec of specs) {
        const target = resolve(dirname(file), spec);
        const tr = rootOf(target);
        let ok = Boolean(tr) && tr.targets.includes(extname(target));
        if (ok) {
          try { ok = lstatSync(target).isFile(); } catch { ok = false; }
        }
        if (!ok) fail(file, spec);
      }
    }
  }

  if (failures.length) {
    process.stdout.write(`${failures.join('\n')}\n`);
    process.exit(1);
  }
}

// Recursive walk that reports every symlink (file or directory) and never follows one.
function* walk(dir, fail) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) { fail(p, 'symlink'); continue; }
    if (e.isDirectory()) yield* walk(p, fail);
    else if (e.isFile()) yield p;
  }
}

main(process.argv.slice(2));
