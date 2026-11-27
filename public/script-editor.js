/**
 * The game-language script editor.
 *
 * Some of what a level runs has no visual equivalent: a compiled ACS module is the game's own
 * language, and an empty project has no way to author it. This window is where that text is
 * written. It opens on one script, shows it as source with the compiled listing beside it for
 * reference, and compiles the text back into the level's module — the other scripts in that
 * module are left exactly as they were.
 *
 * The dialog is built per open and removed on close, so nothing here can go stale when the
 * project changes underneath it.
 */

import { acsBuiltinReference } from '../shared/acs-source.js';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, onClick, className) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

/** The caret's position, so the status bar can say which line a compile error is on. */
function caretPosition(textarea) {
  const before = textarea.value.slice(0, textarea.selectionStart);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function selectLine(textarea, line) {
  const lines = textarea.value.split('\n');
  if (line < 1 || line > lines.length) return;
  let start = 0;
  for (let index = 0; index < line - 1; index++) start += lines[index].length + 1;
  textarea.focus();
  textarea.setSelectionRange(start, start + lines[line - 1].length);
}

/**
 * Opens the editor on one script.
 *
 * `compile(text)` throws an error carrying `line` when the source does not build; the dialog
 * shows it, selects the line and leaves the project untouched. `onCompiled()` runs after a
 * successful compile so the caller can re-render whatever showed the old script.
 */
export function openScriptEditor({ title, subtitle, text, listing = [], compile, onCompiled, status } = {}) {
  const dialog = node('dialog', 'script-editor');
  const head = node('div', 'script-editor-head');
  head.append(node('h1', '', title), node('p', 'script-editor-subtitle', subtitle || ''));
  head.append(node('span', 'script-editor-badge', 'ACS'));

  const toolbar = node('div', 'script-editor-toolbar');
  const feedback = node('p', 'script-editor-status', '');
  feedback.setAttribute('role', 'status');
  toolbar.append(feedback);

  const body = node('div', 'script-editor-body');
  const source = node('textarea', 'script-editor-source');
  source.spellcheck = false;
  source.setAttribute('aria-label', `${title} source`);
  source.value = text || '';

  const listingBox = node('details', 'script-editor-listing');
  listingBox.append(node('summary', '', `Compiled listing (${listing.length} instruction${listing.length === 1 ? '' : 's'})`));
  const listingText = node('pre', 'script-editor-listing-body', listing.join('\n') || 'This script has not been compiled yet.');
  listingBox.append(listingText);
  if (!listing.length) listingBox.hidden = true;
  body.append(source, listingBox);

  const help = node('details', 'script-editor-help');
  help.append(node('summary', '', 'What this window understands'));
  help.append(node('pre', 'script-editor-help-body', acsBuiltinReference()));
  body.append(help);

  const actions = node('div', 'script-editor-actions');
  const compileButton = button('Compile', () => run(), 'primary');
  const revertButton = button('Revert', () => {
    source.value = text || '';
    feedback.textContent = 'Restored the source this window opened with.';
    feedback.className = 'script-editor-status';
  });
  // A background window may defer the `close` event indefinitely, so the dialog is also removed
  // here: a half-open modal left behind would block the next edit.
  const shut = () => { dialog.close(); dialog.remove(); };
  const closeButton = button('Close', shut);
  actions.append(node('span', 'script-editor-hint', 'Ctrl+Enter compiles'),
    revertButton, closeButton, compileButton);

  dialog.append(head, body, toolbar, actions);

  function run() {
    try {
      compile(source.value);
      feedback.textContent = 'Compiled into the level. The other scripts in the module are unchanged.';
      feedback.className = 'script-editor-status ok';
      compileButton.disabled = true;
      revertButton.disabled = true;
      status?.(`${title} compiled`, false);
      onCompiled?.();
    } catch (error) {
      const line = Number(error?.line) || 0;
      feedback.textContent = error?.message || String(error);
      feedback.className = 'script-editor-status error';
      if (line) selectLine(source, line);
      status?.(`${title} did not compile: ${error?.message || error}`, true);
    }
  }

  source.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); run(); return; }
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = source.selectionStart, end = source.selectionEnd;
      source.setRangeText('    ', start, end, 'end');
      return;
    }
    // Typing again after a failure re-arms the button, so a second compile is always possible.
    compileButton.disabled = false;
    revertButton.disabled = false;
  });
  source.addEventListener('input', () => {
    compileButton.disabled = false;
    revertButton.disabled = false;
    const { line, column } = caretPosition(source);
    feedback.className = 'script-editor-status';
    feedback.textContent = `Line ${line}, column ${column} · ${source.value.length} characters`;
  });

  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('cancel', event => { event.preventDefault(); shut(); });
  document.body.append(dialog);
  dialog.showModal();
  source.focus();
  const { line, column } = caretPosition(source);
  feedback.textContent = `Line ${line}, column ${column} · ${source.value.length} characters`;
  return dialog;
}
