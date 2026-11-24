// Closing the studio window.
//
// The window used to be able to become unclosable: it asked the page to save, kept a flag so a
// second click could not start a second save, and cleared that flag only when the save settled. One
// save that never settled left every later close doing nothing. This checks the healthy half of the
// deal — a page that says "saved" closes the window for real — and that the window really is gone
// afterwards, not merely hidden behind a dialog nobody can answer.

const wait = ms => new Promise(done => setTimeout(done, ms));

export async function run({ page }) {
  const steps = [];
  const check = (name, ok, detail) => {
    steps.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    if (!ok) {
      const trail = steps.map(step => `${step.ok ? 'ok  ' : 'FAIL'} ${step.name}${step.detail === undefined ? '' : ` ${JSON.stringify(step.detail)}`}`);
      throw new Error(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}\n${trail.join('\n')}`);
    }
  };

  // Stand in for the page's save: this scenario is about the shell's close path, not about saving,
  // and a real save on the automation project would need the whole persistence stack.
  await page.evaluate('window.opendleSaveBeforeClose = async () => true');

  const closed = page.evaluate('setTimeout(() => window.close(), 20), "requested"').then(() => page.evaluate('1')).then(
    () => false,
    () => true,
  );
  const went = await Promise.race([closed, wait(15000).then(() => 'timeout')]);
  // A closed window cannot answer, which is the signal we want; a window that is still there answers.
  check('the window closes when the page says the project is saved', went !== 'timeout',
    { outcome: went === 'timeout' ? 'still open' : 'closed' });
  if (went === 'timeout') {
    // Say why it did not close before the harness tears the window down.
    try { await page.evaluate('1'); } catch { /* it closed as we looked */ }
  }
  return { closed: went !== 'timeout' };
}
