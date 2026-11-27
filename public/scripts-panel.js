/**
 * Map scripts panel: what a level's compiled ACS module actually does, and where its source is
 * edited.
 *
 * A compiled module is the game's own language, and there is no visual equivalent for it — an
 * empty project cannot author one either. Every row here is therefore marked as engine-language
 * text, and opening one gives the source editor: the imported instruction listing stays beside it
 * for reference, and a compile writes the new text back into the module without disturbing the
 * level's other scripts.
 */

import { disassemble } from '../shared/acs.js';
import { specialName, SUPPORTED_SPECIALS } from '../shared/line-specials.js';
import { compileScriptSource, mapScriptEntries, programFor, scriptSourceStub } from '../shared/map-scripts.js';

const KINDS = {
  open: 'Runs when the level starts',
  enter: 'Runs when a player enters the level',
  respawn: 'Runs when the player respawns',
  death: 'Runs when the player dies',
  lightning: 'Runs on lightning in a Hexen storm',
  unloading: 'Runs when the level unloads',
  closed: 'Triggered from a line or another script',
};

const NEW_SCRIPT = `// A new script for this level. It runs when the level starts; change OPEN to ENTER,
// CLOSED (called from a line or another script) or one of the other types as needed.
script 1 OPEN
{
    Print(s:"the level is running");
}
`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function action(label, onClick, className = '') {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

export function createScriptsPanel(nodes, { project, edit, openEditor, status }) {
  let selected = null, search = '';

  const program = () => programFor(project());

  function render() {
    const current = project();
    const entries = mapScriptEntries(current);
    if (!entries.length) {
      nodes.summary.textContent = 'This level has no ACS scripts. Doom-format line types run as visual rules in '
        + 'the event sheet; Hexen/UDMF line specials run natively. A script written here compiles into the level\'s '
        + 'own module.';
      nodes.list.replaceChildren();
      const empty = element('div', 'script-empty');
      empty.append(element('p', 'muted', 'Scripts are the part of a level with no visual equivalent: they are the '
        + 'game\'s own language, so they are written as text and compiled here.'), addButton());
      nodes.list.append(empty);
      nodes.detail.replaceChildren(element('p', 'muted', 'Nothing to show yet.'));
      nodes.specials.replaceChildren();
      return;
    }
    const edited = entries.filter(entry => entry.source).length;
    nodes.summary.textContent = `${entries.length} script(s) in an ACS program`
      + `${edited ? `, ${edited} edited here` : ''}. Scripts run at 35 Hz. Every row is game-language code: `
      + 'click it to read the compiled listing, or double-click to edit its source.';
    renderList(entries);
    renderSpecials(current);
    if (selected && entries.some(entry => entry.key === selected)) show(entries, selected);
    else nodes.detail.replaceChildren(element('p', 'muted', 'Pick a script to see what it does.'));
  }

  function addButton(label = 'Write a new script', text = NEW_SCRIPT) {
    return action(label, () => openEditorFor(null, text), 'primary');
  }

  function renderList(entries) {
    const needle = search.trim().toLowerCase();
    const matching = entries.filter(entry => !needle ||
      String(entry.name ?? entry.number).toLowerCase().includes(needle) || entry.type.includes(needle) ||
      entry.module.toLowerCase().includes(needle));
    nodes.list.replaceChildren();
    if (!matching.length) { nodes.list.append(element('p', 'muted', 'No script matches this search.')); }
    let group = null;
    for (const entry of matching) {
      if (entry.module !== group) {
        group = entry.module;
        nodes.list.append(element('p', 'script-group', entry.library ? `library ${entry.moduleName}` : 'this map'));
      }
      const row = element('button', 'script-row engine-script');
      row.type = 'button';
      row.classList.toggle('selected', selected === entry.key);
      const name = element('strong', '');
      name.append(element('span', 'script-badge', 'ACS'), element('span', 'script-name', entry.name || `script ${entry.number}`));
      row.append(name, element('small', '', `${entry.number < 0 ? 'named' : `#${entry.number}`} · ${entry.type}`
        + `${entry.argCount ? ` · ${entry.argCount} arg(s)` : ''}${entry.source ? ' · edited' : ''}`));
      row.title = `${KINDS[entry.type] || 'Triggered from a line or another script'}. `
        + 'Game-language code: double-click to edit its source.';
      row.addEventListener('click', () => { selected = entry.key; renderList(entries); show(entries, entry.key); });
      row.addEventListener('dblclick', () => openEditorFor(entry));
      nodes.list.append(row);
    }
    if (matching.length) nodes.list.append(addButton());
  }

  function show(entries, key) {
    const entry = entries.find(candidate => candidate.key === key);
    if (!entry) { nodes.detail.replaceChildren(); return; }
    nodes.detail.replaceChildren();
    const heading = element('h2', '');
    heading.append(element('span', 'script-badge', 'ACS'), element('span', 'script-name', entry.name || `Script ${entry.number}`));
    nodes.detail.append(heading);
    nodes.detail.append(element('p', 'muted', `${KINDS[entry.type] || 'Triggered from a line or another script'}`
      + `${entry.argCount ? `, ${entry.argCount} argument(s)` : ''}. Compiled into `
      + `${entry.library ? `library ${entry.moduleName}` : 'the map\'s BEHAVIOR lump'}.`));
    const actions = element('div', 'button-row');
    actions.append(action(entry.source ? 'Edit source' : 'Edit source (starts a stub)', () => openEditorFor(entry)));
    nodes.detail.append(actions);
    if (entry.source) {
      const preview = element('pre', 'script-source-preview', entry.source.trim().split('\n').slice(0, 40).join('\n'));
      nodes.detail.append(element('p', 'muted', 'Source saved in the project for this script:'), preview);
    }
    const listing = element('ol', 'script-listing');
    for (const line of disassemble(program(), entry.number >= 0 ? entry.number : entry.name)) {
      const item = element('li', '', line);
      item.dataset.op = line.split(/\s+/)[1] || '';
      listing.append(item);
    }
    nodes.detail.append(element('h3', '', 'Compiled listing'), listing);
    const module = program()?.modules[entry.moduleIndex ?? 0]?.module;
    if (module?.strings.length) {
      const table = element('details', 'script-strings');
      table.append(element('summary', '', `String table (${module.strings.length})`));
      const list = element('ul');
      module.strings.forEach((text, index) => list.append(element('li', '', `${index}: ${text}`)));
      table.append(list);
      nodes.detail.append(table);
    }
  }

  /**
   * Opens the source editor on one script, or on a fresh script when `entry` is null.
   *
   * The compile runs inside the editor's own error handling: `compileScriptSource` throws before
   * anything is committed, so a mistake in the text leaves the level exactly as it was.
   */
  function openEditorFor(entry, text = null) {
    const entries = mapScriptEntries(project());
    const key = entry ? entry.key : nextKey(entries);
    const source = text ?? entry?.source ?? (entry ? scriptSourceStub(entry) : NEW_SCRIPT);
    const listing = entry ? disassemble(program(), entry.number >= 0 ? entry.number : entry.name) : [];
    openEditor({
      title: entry ? (entry.name || `Script ${entry.number}`) : 'New script',
      subtitle: entry
        ? `${KINDS[entry.type] || 'Triggered from a line or another script'}`
          + ` · ${entry.library ? `library ${entry.moduleName}` : 'the map\'s BEHAVIOR lump'}`
          + `${entry.source ? '' : ' · imported as compiled bytecode'}`
        : 'Compiled into this level\'s own ACS module',
      text: source,
      listing,
      compile: value => {
        let result = null;
        edit(next => {
          result = compileScriptSource(next, key, value);
          next.mapScripts = result.mapScripts;
        }, entry ? `Script ${entry.name || entry.number} compiled` : 'Script compiled');
        if (result?.warnings?.length) status?.(result.warnings.join(' '), true);
        return result;
      },
      onCompiled: () => { selected = entry?.key ?? key; render(); },
      status,
    });
  }

  /** The next free script number, so a new script does not replace an existing one by accident. */
  function nextKey(entries) {
    const numbers = entries.filter(entry => entry.number >= 0).map(entry => entry.number);
    return `map:${numbers.length ? Math.max(...numbers) + 1 : 1}`;
  }

  function renderSpecials(current) {
    const walls = (current.map.walls || []).filter(wall => wall.special);
    nodes.specials.replaceChildren();
    const groups = new Map();
    for (const wall of walls) {
      if (!groups.has(wall.special)) groups.set(wall.special, []);
      groups.get(wall.special).push(wall);
    }
    if (!groups.size) { nodes.specials.append(element('p', 'muted', 'This level uses no linedef specials.')); return; }
    const table = element('div', 'script-specials');
    for (const [special, entries] of [...groups].sort((a, b) => a[0] - b[0])) {
      const supported = SUPPORTED_SPECIALS.has(special);
      const row = element('div', `script-special${supported ? '' : ' unsupported'}`);
      row.append(element('strong', '', `${special} ${specialName(special)}`),
        element('small', '', `${entries.length} line(s)`
          + `${entries[0].activationModes?.length ? ` · ${[...new Set(entries[0].activationModes)].join('/')}` : ''}`
          + `${supported ? '' : ' · not performed by the native runtime'}`));
      table.append(row);
    }
    nodes.specials.append(table);
  }

  nodes.search?.addEventListener('input', () => { search = nodes.search.value; render(); });
  nodes.jump?.addEventListener('click', () => status?.('Pick a script, or double-click one to edit its source.', false));
  /** Opens the editor on the map script an event's `runScript` action names, if this level has it. */
  function openScript(selector) {
    const entry = mapScriptEntries(project()).find(candidate => candidate.key === `map:${selector}`);
    if (!entry) return false;
    selected = entry.key;
    render();
    openEditorFor(entry);
    return true;
  }

  return {
    render,
    select: value => { selected = value; render(); },
    edit: key => openEditorFor(mapScriptEntries(project()).find(entry => entry.key === key) ?? null),
    openScript,
  };
}
