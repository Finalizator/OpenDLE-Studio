/**
 * Detached windows, wired up.
 *
 * The editor is one document. This module lets a panel (or a big dialog) be shown in a window of
 * its own — a second monitor, usually — without becoming a second copy of the project: the main
 * window stays the hub, and the rules for who may write which section live in
 * `shared/window-sync.js`.
 *
 * The window that opened first is the hub because it is the one whose document the others were
 * opened from; a detached window says hello, receives the document, and from then on sends what
 * its own panel changed. Nothing here touches the project directly — `commit`, `reset` and
 * `applyProject` are the editor's own paths, so a change made in another window is indistinguishable
 * from a local edit once it lands.
 */

import { mergeFromHub, mergeFromPeer, parseWindowView, panelWindowURL, dialogWindowURL,
  sectionsForPanel } from '../shared/window-sync.js';

const CHANNEL = 'opendle-studio';
const PANEL_LABELS = {
  map: 'Layout', events: 'Event sheet', environment: 'Environment', shaders: 'Shaders', actors: 'Actors',
  scripts: 'Scripts', logs: 'Playtest logs', scriptlets: 'Engine scriptlets', timesheet: 'Timesheet',
  hud: 'HUD', terrain: 'Terrain', assets: 'Assets', tweaks: 'Engine tweaks', about: 'About',
  addons: 'Addons', scene: 'Scene',
};

const uid = () => `w${Math.random().toString(36).slice(2, 10)}`;

/**
 * The payload of a drag that came from another window.
 *
 * Chromium does not carry custom drag data across windows, so the source announces what it is
 * dragging and a drop here asks for it for as long as the gesture can plausibly last.
 */
let incoming = null;
export function dragPayload() {
  if (incoming && Date.now() - incoming.at < 30000) return incoming.data;
  return null;
}
/** The payload, taken: a drop uses it once, so a stale drag cannot be dropped twice. */
export function consumeDragPayload() {
  const data = dragPayload();
  incoming = null;
  return data;
}

/** A dialog window's arguments, or null when the URL carried none this build understands. */
function dialogArguments(view) {
  if (view.kind !== 'dialog' || !view.args) return null;
  try { return JSON.parse(view.args); }
  catch { return null; }
}

export function createStudioWindows({
  getProject, applyProject, status = () => {}, channelName = CHANNEL,
  location = globalThis.location, openWindow = (url, name, features) => globalThis.open?.(url, name, features),
  channel = null, windowRef = globalThis.window,
} = {}) {
  const view = parseWindowView(location?.search || '');
  const isMain = view.kind === 'main';
  const panel = view.kind === 'panel' ? view.panel : null;
  const sections = panel ? sectionsForPanel(panel) : [];
  const id = uid();
  const link = channel || (typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : null);
  /** Detached windows this one knows about: id → view. */
  const peers = new Map();
  let connected = false, ready = false;
  let listener = () => {};
  // A detached window has no document of its own to load: it waits for the hub's, which is the
  // only copy that includes edits nobody saved yet.
  let settleFirstDocument;
  const firstDocument = new Promise(resolve => { settleFirstDocument = resolve; });

  const label = () => PANEL_LABELS[panel] || (panel ? panel[0].toUpperCase() + panel.slice(1) : 'OpenDLE');
  const send = message => { try { link?.postMessage(message); } catch { /* a closed channel is a window on its way out */ } };

  /* --- chrome -------------------------------------------------------- */

  let bar = null;
  function buildBar() {
    if (bar || isMain) return bar;
    bar = document.createElement('div');
    bar.id = 'detached-bar';
    const title = document.createElement('strong');
    title.textContent = view.kind === 'dialog'
      ? (view.dialog === 'script-editor' ? 'Script editor' : view.dialog)
      : `${label()} — detached`;
    const hint = document.createElement('span');
    hint.className = 'detached-hint';
    hint.textContent = 'Edits here and in the main window stay in step.';
    const home = document.createElement('button');
    home.type = 'button';
    home.textContent = 'Move back to the main window';
    home.addEventListener('click', () => { send({ type: 'dock', id, panel }); requestClose(); });
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close window';
    close.addEventListener('click', () => requestClose());
    bar.append(title, hint, home, close);
    document.body.prepend(bar);
    document.body.classList.add('detached');
    document.title = `${label()} — OpenDLE: Studio`;
    if (view.kind === 'dialog') document.body.classList.add('detached-dialog');
    return bar;
  }

  /** A detached window is a view: it never asks to save the document, and it closes at once. */
  function requestClose() {
    send({ type: 'bye', id, panel });
    try { windowRef?.close?.(); } catch { /* the browser may refuse a window it did not open */ }
  }

  /** Keeps the detached window showing only its own panel, whatever a render did to the tabs. */
  function applyChrome() {
    if (isMain) return;
    buildBar();
    if (view.kind === 'dialog') return;
    for (const element of document.querySelectorAll('.panel')) {
      element.hidden = element.id !== `${panel}-panel`;
    }
    const dock = document.getElementById('asset-dock');
    if (panel === 'assets') {
      if (dock) dock.hidden = false;
      for (const element of document.querySelectorAll('.panel')) element.hidden = true;
    } else if (dock) dock.hidden = true;
  }

  /* --- messaging ------------------------------------------------------ */

  function receive(event) {
    const message = event?.data;
    if (!message || typeof message !== 'object' || message.id === id) return;
    switch (message.type) {
      case 'hello': {
        if (!isMain) return;
        peers.set(message.id, message.view);
        send({ type: 'here', id, view });
        if (ready) send({ type: 'state', id, document: getProject() });
        listener(peers);
        return;
      }
      case 'here':
        peers.set(message.id, message.view);
        listener(peers);
        return;
      case 'bye': {
        peers.delete(message.id);
        if (message.panel) openWindows.delete(message.panel);
        listener(peers);
        const waiter = dockWaiters.get(message.panel);
        if (waiter) {
          dockWaiters.delete(message.panel);
          waiter.forget();
          waiter.onClosed();
        }
        return;
      }
      case 'commit': {
        if (!isMain || !ready) return;
        const merged = mergeFromPeer(getProject(), message.document, message.owned);
        applyProject(merged, { remote: true, from: message.view });
        send({ type: 'state', id, document: merged });
        return;
      }
      case 'state': {
        if (isMain || !message.document) return;
        applyProject(mergeFromHub(getProject(), message.document, sections), { remote: true });
        settleFirstDocument(true);
        return;
      }
      case 'dock': {
        // The main window brought its tab back: this view no longer edits anything, and closes.
        if (isMain || message.panel !== panel) return;
        sections.splice(0, sections.length);
        requestClose();
        return;
      }
      default:
    }
  }

  function connect() {
    if (connected) return;
    connected = true;
    // One dispatcher, so a drag announcement and a document message are read once each.
    if (link) link.onmessage = event => { rememberDrag(event); receive(event); };
    send({ type: 'hello', id, view });
    if (windowRef?.addEventListener) windowRef.addEventListener('beforeunload', () => send({ type: 'bye', id, panel }));
  }

  /** The document is loaded (or replaced): the hub is now able to answer, and tells everyone. */
  function reset(project) {
    ready = Boolean(project);
    if (ready && isMain) send({ type: 'state', id, document: project });
  }

  /**
   * Resolves when this window has the document — immediately in the main window, which loaded it,
   * and on the hub's first message in a detached one. A hub that never answers is reported instead
   * of leaving a blank window waiting.
   */
  function whenReady(timeout = 20000) {
    if (isMain || getProject()) return Promise.resolve(true);
    return Promise.race([
      firstDocument,
      new Promise((_, reject) => setTimeout(() => reject(new Error(
        'The main OpenDLE window did not send its project. Keep it open, or reopen this window from its tab.')), timeout)),
    ]);
  }

  /** An edit landed in this window. A peer sends it to the hub, the hub broadcasts it. */
  function commit(project) {
    if (!project) return;
    if (isMain) { ready = true; send({ type: 'state', id, document: project }); return; }
    send({ type: 'commit', id, view, owned: sections, document: project });
  }

  /* --- opening windows ------------------------------------------------ */

  /** The windows this one opened, so bringing a tab home can close the window itself. */
  const openWindows = new Map();
  function openPanel(target) {
    const url = panelWindowURL(location.href, target);
    const opened = openWindow(url, `opendle-${target}`, 'popup=yes,width=1280,height=900');
    if (!opened) {
      status('The window could not open. Allow pop-ups for this page and try again.', true);
      return null;
    }
    openWindows.set(target, opened);
    return opened;
  }

  function openDialog(name, args = null) {
    const url = dialogWindowURL(location.href, name, args);
    const opened = openWindow(url, `opendle-dialog-${name}`, 'popup=yes,width=900,height=760');
    if (!opened) status('The window could not open. Allow pop-ups for this page and try again.', true);
    return opened;
  }

  /** Brings a detached panel back: the window closes and the tab becomes the active one again. */
  /** Runs when the window showing `target` has said goodbye (or once it has plainly gone). */
  const dockWaiters = new Map();
  function dock(target, onClosed = null) {
    // The window this one opened is closed from here as well: a hidden or background window does
    // not always honour `window.close()` on its own.
    const opened = openWindows.get(target);
    openWindows.delete(target);
    try { opened?.close?.(); } catch { /* already gone */ }
    send({ type: 'dock', id, panel: target });
    const forget = () => {
      for (const [peerId, peerView] of peers) {
        if (peerView?.kind === 'panel' && peerView.panel === target) peers.delete(peerId);
      }
      listener(peers);
    };
    if (onClosed) dockWaiters.set(target, { onClosed, forget });
    // A window that ignores the request must not leave the tab unusable: after a moment the hub
    // takes the section back anyway, and tells the peer to stop editing it.
    setTimeout(() => {
      const waiter = dockWaiters.get(target);
      if (!waiter) return;
      dockWaiters.delete(target);
      waiter.forget();
      waiter.onClosed();
    }, 1500);
  }

  /* --- drag and drop between windows ---------------------------------- */

  // Chromium does not carry custom drag data between windows, so a drag announces its payload
  // here and a drop in another window asks for it by token.
  const drags = new Map();
  let dragToken = 0;
  const drag = {
    announce(data, mime = 'text/plain') {
      const token = `${id}:${++dragToken}`;
      drags.set(token, { mime, data, at: Date.now() });
      send({ type: 'drag', id, token, mime, data });
      if (drags.size > 16) drags.delete([...drags.keys()][0]);
      return token;
    },
    /** The payload a drop event refers to, or null when the drag started in this window. */
    resolve(event) {
      const token = event?.dataTransfer?.getData?.('text/opendle-drag') || event?.__opendleToken;
      if (token && drags.has(token)) return drags.get(token);
      if (!token) return null;
      return drags.get(token) || null;
    },
    remember(token, payload) { if (token && payload) drags.set(token, { ...payload, at: Date.now() }); },
    clear() { for (const [token, value] of drags) if (Date.now() - value.at > 60000) drags.delete(token); },
  };

  /** Another window started a drag: remember the payload so a drop here can use it. */
  function rememberDrag(event) {
    const message = event?.data;
    if (!message || message.type !== 'drag' || message.id === id) return;
    drags.set(message.token, { mime: message.mime, data: message.data, at: Date.now() });
    incoming = { mime: message.mime, data: message.data, at: Date.now() };
  }

  return {
    id, view, isMain, panel, dialog: view.kind === 'dialog' ? view.dialog : null,
    arguments: dialogArguments(view),
    sections, label,
    connect, reset, commit, applyChrome, openPanel, openDialog, dock, drag, whenReady,
    peers: () => new Map(peers),
    onPeers: fn => { listener = fn; },
    close: requestClose,
    /** Sections that another window owns right now, so a menu can say where an editor lives. */
    detachedSections: () => new Set([...peers.values()]
      .filter(entry => entry?.kind === 'panel').flatMap(entry => sectionsForPanel(entry.panel))),
    detachedPanels: () => new Set([...peers.values()].filter(entry => entry?.kind === 'panel').map(entry => entry.panel)),
  };
}
