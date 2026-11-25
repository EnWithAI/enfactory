// Overlay fixture server for the #53 tests (copied over tests/fixtures/local-node-app). Honours the #64 server contract
// (HOST, PORT, ENWALLET_DB, and the release sha from SF_RELEASE_SHA ?? ENWALLET_SHA) and server/mode (ok, 500, badsha).
// It imports src/shared statically at start-up and loads wallet/pay.mjs lazily on the first POST /api/wallet/payments,
// like enwallet #5, so a missing src/shared or src/brand shows up as ERR_MODULE_NOT_FOUND.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK } from '../src/shared/money.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
let mode = 'ok';
try { mode = readFileSync(join(here, 'mode'), 'utf8').trim(); } catch {}
const { HOST, PORT } = process.env;
const SHA = process.env.SF_RELEASE_SHA ?? process.env.ENWALLET_SHA;

createServer(async (req, res) => {
  if (req.url === '/api/health') {
    if (mode === '500') { res.writeHead(500); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, db: true, sha: mode === 'badsha' ? 'deadbee' : SHA, mark: MARK }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/wallet/payments') {
    try {
      const { pay } = await import('./wallet/pay.mjs');
      pay(req, res);
    } catch (e) {
      console.error(e);
      res.writeHead(500);
      res.end('{}');
    }
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
