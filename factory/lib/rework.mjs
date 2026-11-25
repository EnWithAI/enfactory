// Rework: spend on doing the same work again, by cause (rework review, 2026-11-25). A repeat run of the same role on the same
// issue and task is rework only when something sent it back: a failed check, a loop-back, a failed run, a block or a council.
// A run that picks up after a person or vendor answered, a dependency landed, or a planned "continue" is new work, and is
// reported apart as continuation, so the rework number points at waste instead of at progress.
const taskOf = (label) => String(label ?? '').replace(/-[0-9a-f]{8}$/, '').replace(/-\d+$/, '').replace(/#\d+$/, '');
const CONTINUE = new Set(['person_action', 'human_approved', 'answer_recorded', 'vendor_fulfilled', 'waiting', 'dependency_ready', 'continued']);

/** Classify one rerun from the issue's events between the previous run of the same role and task and this one. */
function cause(between, prevRun) {
  if (between.some((e) => e.type === 'check_failed')) return 'check';
  if (between.some((e) => e.type === 'transition' && (e.loop || e.outcome === 'loop_back'))) return 'loop';
  if (prevRun?.ok === false || between.some((e) => e.type === 'infra_failure' || e.type === 'error')) return 'failed';
  if (between.some((e) => e.type === 'escalated' || e.type === 'council_closed' || e.type === 'council_skipped')) return 'blocked';
  if (between.some((e) => CONTINUE.has(e.type))) return 'continuation';
  return 'repeat';
}

/** { cost, rework, continuation, causes: { council, check, loop, failed, blocked, repeat } } for runs at or after `since`. */
export function rework(evs, { since = '' } = {}) {
  const out = { cost: 0, rework: 0, continuation: 0, causes: { council: 0, check: 0, loop: 0, failed: 0, blocked: 0, repeat: 0 } };
  const last = new Map(), byIssue = new Map();
  evs.forEach((e, i) => { if (e.issue != null) (byIssue.get(e.issue) ?? byIssue.set(e.issue, []).get(e.issue)).push(i); });
  evs.forEach((e, i) => {
    if (e.type !== 'run_finished') return;
    const counted = e.ts >= since, c = e.cost_usd ?? 0;
    if (counted) out.cost += c;
    const k = `${e.actor}|${e.issue}|${taskOf(e.label)}`, prev = last.get(k);
    last.set(k, i);
    if (!counted || !e.issue) return;
    let why = null;
    if (/^council-/.test(e.label)) why = 'council';
    else if (e.check_retry) why = 'check';
    else if (prev != null) why = cause(byIssue.get(e.issue).filter((j) => j > prev && j < i).map((j) => evs[j]), evs[prev]);
    if (!why) return;
    if (why === 'continuation') out.continuation += c;
    else { out.rework += c; out.causes[why] += c; }
  });
  return out;
}
