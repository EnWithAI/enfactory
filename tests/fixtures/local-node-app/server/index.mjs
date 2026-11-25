// Fixture server for tests/local-node.test.mjs. Honours the #64 server contract (HOST, PORT, ENWALLET_DB, ENWALLET_SHA).
// server/mode selects the health answer: ok (default), 500, or badsha (200 with the wrong sha).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
let mode = 'ok';
try { mode = readFileSync(join(here, 'mode'), 'utf8').trim(); } catch {}
const { HOST, PORT, ENWALLET_DB, ENWALLET_SHA, FIXTURE_TRACE } = process.env;
if (FIXTURE_TRACE) writeFileSync(FIXTURE_TRACE, JSON.stringify({ argv1: process.argv[1], HOST, PORT, ENWALLET_DB, ENWALLET_SHA, pid: process.pid }));

createServer((req, res) => {
  if (req.url === '/api/health') {
    if (mode === '500') { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, db: 'ok', sha: mode === 'badsha' ? 'deadbee' : ENWALLET_SHA }));
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
}).listen(Number(PORT), HOST, () => console.log(`fixture listening on ${HOST}:${PORT} mode=${mode}`));
process.on('SIGTERM', () => process.exit(0));
