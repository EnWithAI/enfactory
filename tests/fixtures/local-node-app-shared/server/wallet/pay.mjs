// Overlay fixture: stands in for enwallet #5's pay handler. Loaded lazily; imports src/shared like the real one.
import { MARK as UPI } from '../../src/shared/upi/parseUpiPayUri.mjs';
import { MERCHANTS } from '../../src/shared/merchants.mjs';

export function pay(req, res) {
  req.resume();
  const sid = /(?:^|;\s*)sid=/.test(req.headers.cookie ?? '');
  res.writeHead(sid ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(sid ? { ok: true, upi: UPI, merchants: MERCHANTS.length } : { error: 'unauthenticated' }));
}
