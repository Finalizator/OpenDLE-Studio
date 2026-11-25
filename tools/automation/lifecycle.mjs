// Keeping an automation run from outliving its own failure.
//
// A scenario drives a real window, and a real window can sit there doing nothing: a boot that ended
// on its error screen, a menu whose row never answers, a renderer that never comes up. A scenario
// that waits for one of those used to wait for its own timeout, and when the *page* had gone the
// await never answered at all — the node process then exited on "unsettled top-level await" and left
// the game window running with nobody driving it.
//
// Two things fix that, and they are both here: every spawned process is tracked so it can be killed
// on the way out, and a whole-run deadline turns "it is stuck" into a failed run that says so.

const tracked = new Set();

/** Registers a child process to be killed when the run ends, however it ends. */
export function track(child) {
  if (!child || typeof child.kill !== 'function') return child;
  tracked.add(child);
  child.once?.('exit', () => tracked.delete(child));
  return child;
}

export function untrack(child) {
  if (child) tracked.delete(child);
}

/** Kills every tracked process: the same handle the runner uses on success and on failure. */
export function killTracked(reason = 'the automation run ended') {
  const children = [...tracked];
  tracked.clear();
  for (const child of children) {
    try { child.kill('SIGKILL'); }
    catch { /* already gone */ }
  }
  return children.length;
}

export const trackedCount = () => tracked.size;

/** How long a whole scenario may take, when nothing else says otherwise. */
export const DEFAULT_RUN_TIMEOUT_MS = 240000;

/**
 * Starts the run's deadline.
 *
 * `onTimeout` runs first (so the runner can print its own failure line), then every tracked process
 * is killed and the process exits. The timer is deliberately **referenced**: a scenario blocked on a
 * promise that will never settle is exactly the case the event loop would otherwise drain on, and a
 * pending timer is what keeps the process alive long enough to be killed.
 */
export function startWatchdog({ ms = Number(process.env.OPENDLE_AUTOMATION_TIMEOUT_MS) || DEFAULT_RUN_TIMEOUT_MS,
  onTimeout = () => {} } = {}) {
  const budget = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_RUN_TIMEOUT_MS;
  const timer = setTimeout(() => {
    try { onTimeout(budget); }
    catch { /* a broken reporter must still not keep the window alive */ }
    killTracked('the run timed out');
    // A child that ignored SIGKILL is not this run's problem to wait for.
    process.exit(1);
  }, budget);
  return { ms: budget, stop: () => clearTimeout(timer) };
}

/**
 * Last-resort cleanup.
 *
 * `exit` cannot await anything, so it can only fire and forget; the watchdog already killed the
 * children — this catches the paths that end normally but left a helper behind.
 */
process.once('exit', () => { killTracked(); });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    killTracked(`the run was stopped (${signal})`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}
