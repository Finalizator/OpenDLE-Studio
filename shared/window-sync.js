/**
 * One document, several windows.
 *
 * A detached tab is not a copy of the editor: it is the same document, shown elsewhere, and the
 * panel it shows *owns* the part of the project it edits. Two windows therefore never write the
 * same top-level section, which is what keeps a wall drag in the main window from erasing a HUD
 * change made on the second monitor — a merge that needed no diffing and no version numbers.
 *
 * The main window is the hub: it holds every section nobody detached, and it merges what a peer
 * sends. A peer sends its whole project and names the sections it owns; the hub keeps its own
 * version of everything else. The hub then broadcasts the merged document, and each peer keeps
 * its own sections when it receives it. That is a fixed point: after one round trip every window
 * shows the same document.
 *
 * Everything here is pure so the rules can be tested without a browser; `public/windows.js` does
 * the messaging.
 */

/**
 * What each tab of the editor edits.
 *
 * A panel owns exactly the sections it writes, and the hub keeps the rest. A read-only tab owns
 * nothing, which detaches harmlessly: it receives the document and sends nothing back.
 */
export const PANEL_SECTIONS = {
  map: ['map', 'paths', 'variables', 'worldLockedEntityIds'],
  events: ['events', 'eventSheets', 'eventGroups', 'variables', 'arrays'],
  environment: ['environment', 'shaders', 'variables', 'assets', 'materialAnimations'],
  shaders: ['shaders', 'environment', 'assets'],
  actors: ['actors', 'assets'],
  scripts: ['mapScripts'],
  hud: ['hud', 'assets', 'spriteClips', 'gameMenus'],
  terrain: ['terrain', 'assets'],
  timesheet: ['timesheets', 'paths'],
  scene: ['scenes', 'actors', 'assets'],
  assets: ['assets'],
  logs: [],
  scriptlets: [],
  tweaks: [],
  about: [],
  addons: [],
};

/** The sections a detached panel is allowed to write. */
export function sectionsForPanel(panel) {
  return [...(PANEL_SECTIONS[panel] || [])];
}

/** Which panel would own a section, so a menu can say where an editor already lives. */
export function panelForSection(section) {
  return Object.keys(PANEL_SECTIONS).find(panel => PANEL_SECTIONS[panel].includes(section)) || null;
}

/**
 * The window a URL asks for: `?view=hud`, or `?view=dialog&dialog=script-editor&args=...`.
 * No `view` means the main window, which is the hub.
 */
export function parseWindowView(search = '') {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const view = params.get('view');
  if (!view) return { kind: 'main' };
  if (view === 'dialog') return { kind: 'dialog', dialog: params.get('dialog') || '', args: params.get('args') || '' };
  return { kind: 'panel', panel: view };
}

/** The URL a detached panel opens at, so the main window and the window itself agree. */
export function panelWindowURL(base, panel) {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', panel);
  return url.toString();
}

/** The URL a detached dialog opens at. `args` is a short JSON string the dialog reads back. */
export function dialogWindowURL(base, dialog, args = null) {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('view', 'dialog');
  url.searchParams.set('dialog', dialog);
  if (args !== null) url.searchParams.set('args', JSON.stringify(args));
  return url.toString();
}

/**
 * What the hub keeps when a peer commits.
 *
 * The peer is the only window editing the sections it names, so those come from it. Everything
 * else stays the hub's, including sections the peer changed without owning them: a panel that
 * touches something outside its section is re-synchronised with the hub's version rather than
 * overwriting it.
 */
export function mergeFromPeer(hubProject, peerProject, peerOwned) {
  if (!peerProject || typeof peerProject !== 'object') return hubProject;
  const owned = new Set(peerOwned || []);
  const next = { ...peerProject };
  for (const [key, value] of Object.entries(hubProject || {})) {
    if (!owned.has(key)) next[key] = value;
  }
  // A key the hub does not have is only kept when the peer owns it; otherwise the hub would grow
  // fields nobody agreed to.
  for (const key of Object.keys(next)) {
    if (!(key in (hubProject || {})) && !owned.has(key)) delete next[key];
  }
  return next;
}

/** What a peer keeps when the hub broadcasts: its own sections, and nothing else of its own. */
export function mergeFromHub(peerProject, hubProject, peerOwned) {
  if (!hubProject || typeof hubProject !== 'object') return peerProject;
  const next = { ...hubProject };
  for (const key of peerOwned || []) {
    if (peerProject && key in peerProject) next[key] = peerProject[key];
  }
  return next;
}

/**
 * Sections two windows would both own, so opening a second editor for the same part of the
 * project can be refused instead of letting them overwrite each other.
 */
export function conflictingSections(wanted, taken) {
  const owned = new Set(taken || []);
  return (wanted || []).filter(section => owned.has(section));
}
