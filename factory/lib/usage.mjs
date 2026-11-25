// Claude usage limits. Every agent run reports the account's utilisation of its 5-hour session window and 7-day window
// (Claude Code's rate_limit_event). The factory pauses itself before a window runs out, so work isn't cut off mid-stage,
// and resumes on its own when that window resets. A pause a person made is never lifted automatically.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { p, paused, setPaused } from './config.mjs';
import * as M from './memory.mjs';

const FILE = () => p('.factory/usage.json');
export const DEFAULTS = { five_hour: 0.85, seven_day: 0.95 };
const NAMES = { five_hour: '5-hour session', seven_day: '7-day' };

/** The latest report: { windows: { five_hour: { utilization, resetsAt }, … }, status, at }. */
export function read() { try { return JSON.parse(readFileSync(FILE(), 'utf8')); } catch { return null; } }

/** Called by the worker with each run's rate_limit_info. Written atomically: several agents report at once. */
export function save(info) {
  if (!info) return;
  const windows = { ...(info.unifiedWindows ?? {}) };
  if (info.rateLimitType && info.resetsAt && !windows[info.rateLimitType]) windows[info.rateLimitType] = { utilization: null, resetsAt: info.resetsAt };
  mkdirSync(p('.factory'), { recursive: true });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ windows, status: info.status, limited: info.rateLimitType ?? null, at: new Date().toISOString() }));
  renameSync(tmp, FILE());
}

/**
 * Pause when a window is over its threshold (or the limit is already hit); resume an automatic pause once its window has
 * reset. Returns what it did: 'paused' | 'resumed' | null.
 */
export function check(cfg) {
  const limits = { ...DEFAULTS, ...(cfg.capacity?.usage_pause ?? {}) };
  if (limits.enabled === false) return null;
  const now = Date.now(), cur = paused();
  if (cur?.by === 'usage-limit') {
    if (cur.resumeAt && now >= new Date(cur.resumeAt).getTime()) {
      setPaused(false);
      M.record('auto_resumed', { window: cur.window, paused_since: cur.since }, { actor: 'dispatcher' });
      console.log(`usage: the ${NAMES[cur.window] ?? cur.window} window has reset, resuming`);
      return 'resumed';
    }
    return null;
  }
  if (cur) return null; // a person paused it: leave it alone
  const u = read();
  if (!u) return null;
  // The window to wait for: one that's over its threshold, or the one the limit was hit on. Latest reset wins.
  const over = Object.entries(u.windows ?? {}).filter(([w, x]) => x?.resetsAt * 1000 > now &&
    ((x.utilization != null && limits[w] != null && x.utilization >= limits[w]) || (u.status === 'rejected' && u.limited === w)));
  if (!over.length) return null;
  const [w, x] = over.sort((a, b) => b[1].resetsAt - a[1].resetsAt)[0];
  const resumeAt = new Date(x.resetsAt * 1000 + 60e3).toISOString(); // a minute after the reset
  setPaused(true, 'usage-limit', { window: w, utilization: x.utilization, threshold: limits[w] ?? null, resumeAt,
    reason: `${NAMES[w] ?? w} usage at ${x.utilization != null ? `${Math.round(x.utilization * 100)}%` : 'its limit'}` });
  M.record('auto_paused', { window: w, utilization: x.utilization, threshold: limits[w] ?? null, resume_at: resumeAt }, { actor: 'dispatcher' });
  console.log(`usage: ${NAMES[w] ?? w} window at ${Math.round((x.utilization ?? 1) * 100)}%, pausing until ${resumeAt}`);
  return 'paused';
}
