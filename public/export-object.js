/**
 * The question an export asks: does the object's visual script travel with it?
 *
 * A `.node` file is meant to be dropped into another project and work there, so it embeds the
 * artwork, the model and the shader. Its visual script is a different matter: an event can name
 * another object, and half a rule set that arrives without its partners is worse than no rule
 * set at all. So the choice is the author's to make at the moment of export, with the count in
 * front of them, and the file records what was chosen (`script.available` / `script.included`).
 */

import { nodeFileText } from '/shared/node-file.js';

/**
 * Asks, then resolves with `{ includeEvents }`, or `null` when the author backed out.
 *
 * The dialog is built here rather than sitting in `index.html` because it is only ever needed
 * for the length of one export, and a `<dialog>` removed afterwards cannot be reached by a
 * stale keyboard focus or a second export.
 */
export function askObjectExport({ name, kind = 'Object', events = 0 } = {}) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'export-dialog';
    dialog.setAttribute('aria-label', `Export ${name || kind}`);

    const heading = document.createElement('h2');
    heading.textContent = `Export ${name || kind}`;

    const summary = document.createElement('p');
    summary.className = 'info';
    summary.textContent = 'The file carries the object with its artwork, model and shader embedded, so it '
      + 'opens on another machine without the project it came from. Its route and its layout group '
      + 'belong to the layout and stay behind.';

    const label = document.createElement('label');
    label.className = 'export-script-option';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = events > 0;
    box.disabled = events === 0;
    label.append(box, document.createTextNode(events
      ? `Include its visual script (${events} event${events === 1 ? '' : 's'})`
      : 'This object has no visual script to include'));

    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = events
      ? 'An event that names an object outside this one cannot travel: it would arrive pointing at '
        + 'nothing. Those are left out and reported.'
      : '';

    const row = document.createElement('div');
    row.className = 'button-row';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.value = 'cancel';
    const confirm = document.createElement('button');
    confirm.textContent = 'Export';
    confirm.value = 'export';
    confirm.className = 'primary';
    row.append(confirm, cancel);

    // A form method="dialog" is the platform's own way to close with a value, and Escape cancels
    // by itself, so no key handling is needed for either.
    const form = document.createElement('form');
    form.method = 'dialog';
    form.append(heading, summary, label, note, row);
    dialog.append(form);

    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'export';
      dialog.remove();
      resolve(confirmed ? { includeEvents: box.checked } : null);
    });

    document.body.append(dialog);
    dialog.showModal();
    (events ? box : confirm).focus();
  });
}

/** Saves a `.node` document under `name`, the way the scene editor's own button does. */
export function downloadNodeFile(file, name) {
  const url = URL.createObjectURL(new Blob([nodeFileText(file)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // The download reads the blob after the click returns, so revoking in the same task can cancel
  // it — the export reports success and no file arrives. Give the browser its turn first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
