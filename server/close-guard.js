// Deciding what a window close means, without ever trapping the person inside the window.
//
// Closing the studio has to ask the page to save first, and a save can hang: a server that stopped
// answering, a hundred-megabyte document, a fetch that never settles. The first version of this
// logic kept a `closing` flag that only cleared when the save settled — so one hung save made every
// later close attempt return early, and the window could not be closed at all.
//
// This is that decision as a small state machine with a deadline, so it can be tested and so a
// failure always ends in either "closed" or "still open, and asking again will work".

/**
 * @param attempt   () => Promise<boolean>   ask the page to save; true means nothing is unsaved
 * @param ask       (reason) => Promise<boolean>  the honest offer; true means close anyway
 * @param close     () => void               close for real, bypassing unload handlers
 * @param timeout   how long a save may take before the offer is made anyway
 */
export function createCloseGuard({ attempt, ask, close, log = () => {}, timeout = 25000 }) {
  let deciding = false;

  async function decide() {
    try {
      const saved = await withDeadline(attempt(), timeout);
      if (saved === true) { close(); return; }
      if (await ask('The project still has unsaved changes.')) close();
      else log('Close cancelled; the window stays open.');
    } catch (error) {
      const reason = error?.message || String(error);
      if (await ask(reason)) close();
      else log(`Close cancelled: ${reason}`);
    } finally {
      deciding = false;
    }
  }

  /**
   * Handles a close event. Returns true when the guard took the close over, which is when the
   * caller must cancel the default close and let the decision finish.
   *
   * A second close while a decision is in flight is swallowed: it would only queue another save.
   * Once the decision ends — closed, cancelled, or failed — the next close starts a fresh one.
   */
  return function handleClose() {
    if (deciding) return true;
    deciding = true;
    void decide();
    return true;
  };
}

/** A promise that always settles, so a save that never answers cannot become a stuck window. */
function withDeadline(promise, timeout) {
  if (!Number.isFinite(timeout) || timeout <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), timeout);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
