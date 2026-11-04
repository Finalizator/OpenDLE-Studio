/**
 * The question a delete asks when something still names the object.
 *
 * Deleting an object that a script talks about used to be either impossible ("This entity is used
 * by an event. Remove those references first." — with no way to find them) or, for the references
 * the check did not know about, silently corrupting. This dialog names every rule and cue that
 * mentions the object, links to each one, and then offers the two honest answers: take those rules
 * with the object, or keep them and put an empty stand-in in the object's place.
 */

/**
 * Asks what to do about one delete.
 *
 * Resolves with `{ mode: 'strip' }`, `{ mode: 'replace' }`, `{ open: reference }` when the author
 * followed a link instead, or `null` when they backed out.
 *
 * `onOpen` is called for a follow-up link only after the dialog has closed, so the editor can move
 * the selection and switch tabs without a modal in the way.
 */
export function askDeleteObject({ names = [], references = [], ownedEvents = 0, labelFor = null } = {}) {
  return new Promise(resolve => {
    let answer = null;
    const dialog = document.createElement('dialog');
    dialog.className = 'delete-dialog';

    const heading = document.createElement('h2');
    const many = names.length > 1;
    heading.textContent = many ? `Delete ${names.length} objects?` : `Delete ${names[0] || 'this object'}?`;

    const lead = document.createElement('p');
    const links = references.filter(reference => !reference.owned);
    const namedCount = new Set(links.map(reference => `${reference.source}:${reference.id}`)).size;
    lead.textContent = namedCount
      ? `${namedCount === 1 ? 'One rule names it' : `${namedCount} rules name it`}`
        + `${links.length > namedCount ? ` (${links.length} references in all)` : ''}. `
        + 'Deleting the object would leave them pointing at nothing.'
      : 'Nothing else in the project names it.';

    const list = document.createElement('ul');
    list.className = 'delete-references';
    const seen = new Set();
    for (const reference of links) {
      const key = `${reference.source}:${reference.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = document.createElement('li');
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'delete-reference-link';
      link.textContent = labelFor ? labelFor(reference) : reference.name;
      link.title = 'Open this rule';
      link.addEventListener('click', () => {
        answer = { open: reference };
        dialog.close('open');
      });
      item.append(link);
      list.append(item);
    }

    const choices = document.createElement('fieldset');
    choices.className = 'delete-choice';
    const legend = document.createElement('legend');
    legend.textContent = 'What should happen to them?';
    const option = (value, label, text, checked = false) => {
      const wrap = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'delete-mode';
      radio.value = value;
      radio.checked = checked;
      wrap.append(radio, document.createTextNode(label));
      if (text) {
        const note = document.createElement('span');
        note.className = 'delete-choice-note';
        note.textContent = text;
        wrap.append(note);
      }
      return wrap;
    };
    const strip = option('strip', 'Delete them too',
      ownedEvents
        ? `The object's own ${ownedEvents} event${ownedEvents === 1 ? '' : 's'} go as well; affected condition branches are removed.`
        : 'Affected condition branches and actions that name it are removed.', true);
    const replace = option('replace', 'Keep them and put an empty object in its place',
      'A stand-in keeps the object type, local data, signals and body. A model stays only when animation rules need it.');
    // An object with no outside references still has a script of its own to account for.
    choices.append(legend, strip);
    if (namedCount) choices.append(replace);

    const row = document.createElement('div');
    row.className = 'button-row';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.value = 'cancel';
    const confirm = document.createElement('button');
    confirm.textContent = 'Delete';
    confirm.value = 'confirm';
    confirm.className = 'danger';
    row.append(confirm, cancel);

    const form = document.createElement('form');
    form.method = 'dialog';
    form.append(heading, lead);
    if (namedCount) form.append(list);
    form.append(choices, row);
    dialog.append(form);

    dialog.addEventListener('close', () => {
      if (answer?.open) { dialog.remove(); resolve(answer); return; }
      const mode = dialog.returnValue === 'confirm'
        ? dialog.querySelector('input[name="delete-mode"]:checked')?.value || 'strip'
        : null;
      dialog.remove();
      resolve(mode ? { mode } : null);
    });

    document.body.append(dialog);
    dialog.showModal();
    confirm.focus();
  });
}
