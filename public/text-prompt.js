/**
 * One line of text, asked for in a way that works in the desktop build.
 *
 * Electron's renderer has no `prompt()`: it throws `prompt() is not supported.` instead of
 * returning a value. Nine editor commands used it directly — Edit game version, Rename asset,
 * Rename scene object, Set sector light, and the "which scene object?" choosers — so in the
 * packaged studio each of them died with an unhandled error and did nothing at all. The playtest
 * log caught it (`logs/playtest/…`: `Error: prompt() is not supported. at editGameVersion`).
 *
 * A browser keeps its own prompt, which is synchronous and familiar; the desktop build gets the
 * same question as a small overlay. Both answer a promise: `null` means cancelled.
 */
export function askText(message, initial = '') {
  if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
    try {
      return Promise.resolve(window.prompt(message, initial));
    } catch {
      // Electron's stub throws rather than returning; the overlay below answers instead.
    }
  }
  return askWithOverlay(message, initial);
}

function askWithOverlay(message, initial) {
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.className = 'text-prompt';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');

    const panel = document.createElement('form');
    panel.className = 'text-prompt-panel';
    const label = document.createElement('label');
    label.className = 'text-prompt-message';
    label.textContent = message;
    const input = document.createElement('input');
    input.className = 'text-prompt-input';
    input.type = 'text';
    input.value = String(initial ?? '');
    label.append(input);

    const buttons = document.createElement('div');
    buttons.className = 'text-prompt-buttons';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    const accept = document.createElement('button');
    accept.type = 'submit'; accept.textContent = 'OK'; accept.className = 'primary';
    buttons.append(cancel, accept);
    panel.append(label, buttons);
    root.append(panel);

    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(value);
    };
    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
    };

    panel.addEventListener('submit', event => { event.preventDefault(); finish(input.value); });
    cancel.addEventListener('click', () => finish(null));
    // A click on the backdrop is a cancel, a click inside the panel is not.
    root.addEventListener('mousedown', event => { if (event.target === root) finish(null); });
    document.addEventListener('keydown', onKey, true);

    document.body.append(root);
    input.focus();
    input.select();
  });
}
