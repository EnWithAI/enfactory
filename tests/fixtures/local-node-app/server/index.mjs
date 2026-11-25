// Fixture server for tests/local-node.test.mjs and tests/local-node-delta.test.mjs. Honours the server contract
// `server/index.mjs <port> <dataDir>` (#3, #110) with env HOST, ENWALLET_SHA (#64). server/mode selects the health answer: ok (default, db:true), 500, badsha (200 with
// the wrong sha), and for #60: dbfalse (db:false), dbstring (db:"ok"), nodb (no db field), okfalse (ok:false), nojson (200 `not json`).
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
let mode = 'ok';
try { mode = readFileSync(join(here, 'mode'), 'utf8').trim(); } catch {}
const { HOST, PORT, ENWALLET_DB, ENWALLET_SHA, FIXTURE_TRACE, FIXTURE_MARKER } = process.env;
if (FIXTURE_TRACE) {
  writeFileSync(FIXTURE_TRACE, JSON.stringify({
    argv: process.argv.slice(2), argvLen: process.argv.length, argv1: process.argv[1], HOST, PORT, ENWALLET_DB, ENWALLET_SHA, pid: process.pid,
  }));
}
// #110: like #3's server (CLI `server/index.mjs <port> <dataDir>`), the port and data dir come from argv only. PORT and
// ENWALLET_DB are recorded in the trace but never used to listen or to open files.
if (!process.argv[2] || !process.argv[3]) {
  process.stderr.write('usage: index.mjs <port> <dataDir>\n');
  process.exit(2);
}
const listenPort = Number(process.argv[2]);
const dataDir = process.argv[3];
// Opt-in so the #64 suite's data/ stays exactly ['enwallet.db'] (AC-64-10).
const marker = join(dataDir, 'fixture-marker');
if (FIXTURE_MARKER && !existsSync(marker)) writeFileSync(marker, `${process.pid}\n`);

createServer((req, res) => {
  if (req.url === '/api/health') {
    if (mode === '500') { res.writeHead(500); res.end('{}'); return; }
    if (mode === 'nojson') { res.writeHead(200); res.end('not json'); return; }
    const db = { dbfalse: false, dbstring: 'ok' }[mode] ?? true;
    const body = { ok: mode !== 'okfalse', db, sha: mode === 'badsha' ? 'deadbee' : ENWALLET_SHA };
    if (mode === 'nodb') delete body.db;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }
  const rel = normalize(req.url === '/' ? 'index.html' : req.url.slice(1));
  try {
    if (rel.startsWith('..')) throw new Error('outside dist');
    const body = readFileSync(join(dist, rel));
    res.writeHead(200);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(listenPort, HOST, () => console.log(`fixture listening on ${HOST}:${listenPort} mode=${mode}`));
process.on('SIGTERM', () => process.exit(0));
