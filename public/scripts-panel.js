/**
 * Map scripts panel: what a level's compiled ACS module actually does.
 *
 * ACC output is bytecode, so the honest view is a disassembly plus the script
 * directory: number or name, trigger kind, argument count, and the linedef
 * specials the level uses. Editing the bytecode by hand is not something anyone
 * wants, so this panel is a reader; behaviour is changed in the event sheet or by
 * re-importing the map's source.
 */

import { parseBehavior, describeBehavior, disassemble } from '../shared/acs.js';
import { specialName, SUPPORTED_SPECIALS } from '../shared/line-specials.js';

const KINDS = {
  open: 'Runs when the level starts',
  enter: 'Runs when a player enters the level',
  respawn: 'Runs when the player respawns',
  death: 'Runs when the player dies',
  lightning: 'Runs on lightning in a Hexen storm',
  unloading: 'Runs when the level unloads',
  closed: 'Triggered from a line or another script',
};

function byteDecoder(project) {
  if (!project?.mapScripts?.data) return null;
  try {
    const binary = atob(project.mapScripts.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return parseBehavior(bytes);
  } catch { return null; }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createScriptsPanel(nodes, { project, focus }) {
  let behavior = null, selected = null, search = '';

  function render() {
    const current = project();
    behavior = byteDecoder(current);
    const summary = nodes.summary;
    if (!behavior) {
      summary.textContent = current?.mapScripts
        ? 'This level ships an ACS module that could not be read; see the import warnings.'
        : 'This level has no ACS scripts. Doom-format line types run as visual rules in the event sheet; Hexen/UDMF line specials run natively.';
      nodes.list.replaceChildren();
      nodes.detail.replaceChildren(element('p', 'muted', 'Nothing to disassemble.'));
      nodes.specials.replaceChildren();
      return;
    }
    const stats = describeBehavior(behavior);
    const kinds = Object.entries(stats.kinds).map(([kind, count]) => `${count} ${kind}`).join(', ');
    summary.textContent = `${stats.scripts} script(s) in an ACS ${stats.format === 'old' ? '1.0 (Hexen)' : '1.x ZDoom'} `
      + `module (${kinds || 'none'}), ${stats.strings} string(s), ${stats.functions} function(s). Scripts run at 35 Hz.`;
    renderList();
    renderSpecials(current);
    if (selected) show(selected);
  }

  function renderList() {
    const needle = search.trim().toLowerCase();
    const scripts = behavior.scripts.filter(script => !needle ||
      String(script.name ?? script.number).toLowerCase().includes(needle) || script.type.includes(needle));
    nodes.list.replaceChildren();
    if (!scripts.length) { nodes.list.append(element('p', 'muted', 'No script matches this search.')); return; }
    for (const script of scripts) {
      const row = element('button', 'script-row');
      row.type = 'button';
      row.classList.toggle('selected', selected === script.number);
      row.append(element('strong', '', script.name || `script ${script.number}`),
        element('small', '', `${script.number < 0 ? 'named' : `#${script.number}`} · ${script.type}`
          + `${script.argCount ? ` · ${script.argCount} arg(s)` : ''}`));
      row.title = KINDS[script.type] || 'Triggered from a line or another script';
      row.addEventListener('click', () => { selected = script.number; renderList(); show(script.number); });
      nodes.list.append(row);
    }
  }

  function show(selector) {
    const script = behavior.scripts.find(entry => entry.number === selector || entry.name === selector);
    if (!script) { nodes.detail.replaceChildren(); return; }
    nodes.detail.replaceChildren();
    const heading = element('h2', '', script.name || `Script ${script.number}`);
    nodes.detail.append(heading);
    nodes.detail.append(element('p', 'muted', `${KINDS[script.type] || 'Triggered from a line or another script'}`
      + `${script.argCount ? `, ${script.argCount} argument(s)` : ''}. Disassembled from the compiled BEHAVIOR lump.`));
    const listing = element('ol', 'script-listing');
    for (const line of disassemble(behavior, selector === script.number ? (script.name ?? script.number) : selector)) {
      const item = element('li', '', line);
      item.dataset.op = line.split(/\s+/)[1] || '';
      listing.append(item);
    }
    nodes.detail.append(listing);
    const source = behavior.strings.length
      ? element('details', 'script-strings')
      : null;
    if (source) {
      source.append(element('summary', '', `String table (${behavior.strings.length})`));
      const list = element('ul');
      behavior.strings.forEach((text, index) => list.append(element('li', '', `${index}: ${text}`)));
      source.append(list);
      nodes.detail.append(source);
    }
  }

  function renderSpecials(current) {
    const walls = (current.map.walls || []).filter(wall => wall.special);
    nodes.specials.replaceChildren();
    const groups = new Map();
    for (const wall of walls) {
      const key = wall.special;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(wall);
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

  nodes.search?.addEventListener('input', () => { search = nodes.search.value; if (behavior) renderList(); });
  nodes.jump?.addEventListener('click', () => focus?.(selected));
  return { render, select: value => { selected = value; render(); } };
}
