export function createProjectAutosave({
  isDirty, isBusy, save, onError, delay = 1000,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let timer = null, saving = null;
  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule() {
    cancelTimer();
    if (!isDirty()) return;
    timer = setTimer(() => {
      timer = null;
      if (isBusy()) { schedule(); return; }
      flush().catch(onError);
    }, delay);
  }
  function flush() {
    cancelTimer();
    if (!saving) {
      saving = (async () => {
        while (isDirty()) {
          if (isBusy()) { schedule(); return; }
          await save();
        }
      })().finally(() => { saving = null; });
    }
    return saving;
  }
  return { schedule, flush };
}
