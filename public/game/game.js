// The exported game: data in, engine out, no editor anywhere.
//
// The game boots into **its own main menu** — the one authored in the project and drawn by the
// engine's HUD, the same screens the editor's playtest shows. There is no player-made menu here:
// "New game", "Options", "Load", "Quit" are the project's rows, and the shell only answers what the
// runtime asks for (`menuRequests`): start a level, change level, quit, fullscreen.
//
// The menu appears before the renderer is built, so a game opens instantly and a machine without a
// GPU can still reach it; the 3D view is created when a level actually starts.

import { createPreview } from '/render.js';
import { createAudioPlayer } from '/audio.js';
import { createHUDView } from '/hud-view.js';
import { createRuntime, stepRuntime, lookPlayer } from '/shared/runtime.js';
import { gameSettings, mappedKeys, validBinding, setGameScreen } from '/shared/game-settings.js';
import { selectGameLevel, stripInactiveLevels } from '/shared/game-levels.js';
import { installIntermission } from '/shared/intermission.js';
import { installDroppedPickupRules } from '/shared/doom-hud.js';
import { upgradeCrusherRules } from '/shared/doom-specials.js';
import { installGameDefaults } from './defaults.js';
import { hydrateAssets } from './assets.js';

const $ = id => document.getElementById(id);
const canvas = $('view'), hudHost = $('hud');

const game = {
  project: null, settings: null, engine: null, busy: false, hydrated: false, toastTimer: 0,
  keys: new Set(), pressed: new Set(), audioContext: null, fullscreenAsked: false,
};
let lookDrag = null, lastSettingsRevision = -1, frameCount = 0, lastFrameError = '', lastTick = 0;

// ---------------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------------

/** The engine data folder this build was written with (`data/` beside the page by default). */
function dataRoot() {
  try {
    const config = JSON.parse($('game-config').textContent || '{}');
    const root = typeof config.data === 'string' && config.data ? config.data : 'data/';
    return root.endsWith('/') ? root : `${root}/`;
  } catch { return 'data/'; }
}

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url} could not be loaded (${response.status})`);
  return response.json();
}

/**
 * The project as the build wrote it: a small document plus the files it names.
 *
 * Asset `src` values are URLs beside the document, so nothing here knows about base64 until a level
 * starts and the engine needs the bytes (see `assets.js`).
 */
async function loadProject() {
  const root = dataRoot();
  const saved = await readJson(`${root}project.json`);
  const document_ = saved?.project ? saved : { project: saved, sections: {} };
  const project = document_.project;
  for (const [key, file] of Object.entries(document_.sections || {})) {
    if (typeof file !== 'string') continue;
    project[key] = await readJson(`${root}${file}`);
  }
  if (!project.game) project.game = null;
  // A project that never went through the editor still gets the menus and HUD the engine expects, in
  // memory only — and a project that has them keeps them untouched.
  try { installGameDefaults(project); }
  catch (error) { showToast(`The game's menus could not be prepared: ${error.message}`, true); }
  return project;
}

function identity() {
  return String(game.project?.title || 'OpenDLE game');
}

function settingsKey() {
  return `opendle-game-settings:${identity().slice(0, 80)}`;
}

function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(settingsKey()) || '{}') || {}; } catch { stored = {}; }
  try { return gameSettings(stored); } catch { return gameSettings(); }
}

function saveSettings() {
  try { localStorage.setItem(settingsKey(), JSON.stringify(game.settings)); } catch { /* storage is optional */ }
}

/**
 * The save files the engine's `saveVariables` and checkpoint rules write.
 *
 * The studio keeps them with the project; an exported game has nowhere but the browser, so they live
 * in `localStorage` under the game's own name. The format belongs to the engine.
 */
function saveFileHost() {
  const prefix = `opendle-game-save-file:${identity().slice(0, 80)}:`;
  return {
    identity: identity(),
    read: name => { try { return localStorage.getItem(prefix + String(name)); } catch { return null; } },
    write: (name, text) => {
      try { localStorage.setItem(prefix + String(name), String(text)); }
      catch (error) { throw new Error(`the game could not store ${name}: ${error.message}`); }
    },
    list: () => {
      const names = [];
      try {
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key?.startsWith(prefix)) names.push(key.slice(prefix.length));
        }
      } catch { /* storage is optional */ }
      return names;
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Chrome: loading, messages, fatal errors
// ---------------------------------------------------------------------------------------------------

function setLoading(text) {
  $('loading').hidden = !text;
  if (text) $('loading-text').textContent = text;
}

function showToast(message, error = false) {
  const node = $('toast');
  node.textContent = String(message ?? '');
  node.classList.toggle('error', Boolean(error));
  node.hidden = !message;
  clearTimeout(game.toastTimer);
  if (message) game.toastTimer = setTimeout(() => { node.hidden = true; }, 7000);
}

/** A start that cannot happen at all: say why, and blame the right thing. */
function showFatal(error) {
  $('fatal-title').textContent = 'The game could not start';
  $('fatal-message').textContent = error?.message || String(error);
  $('fatal-hint').textContent = /could not be loaded|JSON|fetch/i.test(String(error?.message))
    ? 'The exported data folder is missing or damaged. Re-export the game.'
    : 'This build of the game is not usable. The message above names what to fix.';
  $('fatal').hidden = false;
}

function hideFatal() {
  $('fatal').hidden = true;
}

// ---------------------------------------------------------------------------------------------------
// Fullscreen and sound, both of which need a user gesture
// ---------------------------------------------------------------------------------------------------

async function goFullscreen() {
  if (document.fullscreenElement) return;
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); }
  catch { /* a browser can refuse; the game plays windowed */ }
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (error) { showToast(`Fullscreen is not available: ${error.message}`, true); }
}

/** The AudioContext has to be created inside a gesture, so it is made on the first one. */
function primeAudio() {
  if (game.audioContext) { game.audioContext.resume?.().catch(() => {}); return game.audioContext; }
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) return null;
  try { game.audioContext = new Context(); game.audioContext.resume?.().catch(() => {}); }
  catch { game.audioContext = null; }
  return game.audioContext;
}

/** The first click or key asks for fullscreen, which is how a game starts without a launcher. */
function maybeFullscreenOnGesture() {
  if (game.fullscreenAsked) return;
  game.fullscreenAsked = true;
  void goFullscreen();
}

// ---------------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------------

/** The snapshot and runtime for one level, with this session's settings and save files. */
function buildRuntime({ levelId = null, screen = 'playing', progress = null } = {}) {
  const playing = levelId || game.project?.game?.entry || null;
  const playable = playing ? stripInactiveLevels(game.project, playing) : game.project;
  const snapshot = structuredClone(playable);
  if (snapshot.game && playing) selectGameLevel(snapshot, playing);
  installIntermission(snapshot);
  installDroppedPickupRules(snapshot);
  upgradeCrusherRules(snapshot);
  // Only the level being played keeps its map: an imported campaign is hundreds of megabytes of
  // level data, and the runtime never looks at the others.
  for (const level of snapshot.game?.levels || []) {
    if (level.id === snapshot.game.active) continue;
    level.data = {}; level.assetIds = [];
  }
  const runtime = createRuntime(snapshot, {
    settings: { ...(game.settings || {}) }, gameMode: Boolean(snapshot.game), screen, progress,
    saveFiles: saveFileHost(),
  });
  // The editor's playtest does this the moment a runtime is built, and the menus depend on it: a
  // menu row is only shown and made focusable while the HUD cursor is active, so without this the
  // title screen was there in the DOM and invisible on the canvas.
  runtime.hudState.cursor = runtime.gameScreen !== 'playing';
  return { snapshot, runtime, levelId: playing };
}

function disposeEngine() {
  if (!game.engine) return;
  const { preview, hud, audio } = game.engine;
  game.engine = null;
  try { audio?.dispose(); } catch { /* already gone */ }
  try { hud?.dispose(); } catch { /* already gone */ }
  try { preview?.dispose(); } catch { /* already gone */ }
  hudHost.replaceChildren();
  $('message').hidden = true;
  document.exitPointerLock?.();
}

function attachHud(engine) {
  engine.hud = createHUDView(hudHost, engine.snapshot, {
    click: id => { if (engine.runtime.hudState.cursor) engine.runtime.hudState.clicked.add(id); },
    error: message => showToast(message, true),
  });
  engine.hud.update?.(engine.runtime);
}

/**
 * Opens the project's own main menu.
 *
 * This is what the game starts on: the runtime is at `gameMenus.entry` (usually the title screen) and
 * the HUD draws the authored menu rows over it. No renderer is built yet — the menu is DOM, and
 * building a 3D scene to show a list of words would only make the game slower to open.
 */
async function openMenu() {
  disposeEngine();
  setLoading('Loading the game…');
  try {
    if (!game.hydrated) {
      await hydrateAssets(game.project, (done, total) => {
        if (total) setLoading(`Loading the artwork… ${Math.round((done / total) * 100)}%`);
      });
      game.hydrated = true;
    }
    const engine = buildRuntime({ screen: game.project.gameMenus?.entry || 'playing' });
    game.engine = { ...engine, preview: null, hud: null, audio: null, last: performance.now() };
    attachHud(game.engine);
    hideFatal();
  } catch (error) {
    disposeEngine();
    showFatal(error);
  } finally {
    setLoading(null);
  }
}

/** Starts a level: the runtime is rebuilt at `playing` and the 3D view is created for it. */
async function playLevel(levelId, { progress = null } = {}) {
  if (game.busy) return;
  game.busy = true;
  hideFatal();
  setLoading('Loading the level…');
  game.keys.clear(); game.pressed.clear();
  try {
    if (!game.hydrated) {
      await hydrateAssets(game.project, (done, total) => {
        if (total) setLoading(`Loading the artwork… ${Math.round((done / total) * 100)}%`);
      });
      game.hydrated = true;
    }
    const engine = buildRuntime({ levelId, screen: 'playing', progress });
    disposeEngine();
    game.engine = { ...engine, preview: null, hud: null, audio: null, last: performance.now() };
    const preview = await createPreview(canvas, engine.snapshot, engine.runtime, { onMediaError: message => showToast(message, true) });
    if (game.engine?.runtime !== engine.runtime) { preview.dispose(); return; }
    game.engine.preview = preview;
    attachHud(game.engine);
    try {
      game.engine.audio = createAudioPlayer(engine.snapshot, message => showToast(message, true), undefined, primeAudio() || undefined);
    } catch (error) { showToast(`Sound is unavailable: ${error.message}`, true); }
    game.engine.last = performance.now();
    await goFullscreen();
    canvas.focus();
    stepRuntime(engine.snapshot, engine.runtime, 0, new Set());
    game.engine.hud.update?.(engine.runtime);
    if (engine.runtime.saveStatus) showToast(engine.runtime.saveStatus, true);
  } catch (error) {
    showToast(`Could not start the level: ${error.message}`, true);
    await openMenu();
  } finally {
    game.busy = false;
    setLoading(null);
  }
}

/** Back to the game's own menu, from the pause screen or a finished campaign. */
function quitToMenu() {
  game.keys.clear(); game.pressed.clear();
  return openMenu();
}

function quitGame() {
  disposeEngine();
  window.close();
  // A browser window that was not opened by a script cannot be closed, so say what to do instead.
  $('fatal-title').textContent = 'Thanks for playing';
  $('fatal-message').textContent = identity();
  $('fatal-hint').textContent = 'You can close this tab now.';
  $('fatal').hidden = false;
}

// ---------------------------------------------------------------------------------------------------
// What the runtime asks for
// ---------------------------------------------------------------------------------------------------

function handleRequests(runtime) {
  for (const request of runtime.menuRequests.splice(0)) {
    if (request === 'quit') { quitGame(); return; }
    if (request === 'fullscreen') { void toggleFullscreen(); continue; }
    if (request === 'complete') { showToast('Campaign complete.'); continue; }
    if (request === 'start' || request?.type === 'start') {
      void playLevel(request?.levelId || game.project?.game?.entry || null);
      return;
    }
    if (request?.type === 'level') {
      const carried = request.carryProgress
        ? { playerStats: runtime.playerStats, inventory: runtime.inventory } : null;
      void playLevel(request.levelId, { progress: carried });
      return;
    }
    // A rule-written save file: the host is `localStorage`, the document format is the engine's.
    if (request?.type === 'save-file' || request?.type === 'load-file') {
      const name = String(request.file ?? '').trim();
      try {
        if (request.type === 'save-file') {
          saveFileHost().write(name, JSON.stringify(checkpointDocument(runtime, game.engine?.levelId)));
          runtime.saveStatus = `Saved ${name}.`;
        } else {
          const text = saveFileHost().read(name);
          if (text === null || text === undefined) throw new Error(`there is no save file named ${name}`);
          applyCheckpoint(runtime, JSON.parse(text));
          runtime.saveStatus = `Loaded ${name}.`;
        }
      } catch (error) { runtime.saveStatus = `Save file failed: ${error.message}`; }
      continue;
    }
    if (request?.type === 'save' || request?.type === 'load') {
      runtime.saveStatus = 'Save slots belong to the studio; this build saves through the game\'s own save files.';
    }
  }
}

/** What a checkpoint keeps: where the player is and everything that would be lost on a reload. */
function checkpointDocument(runtime, levelId) {
  return {
    version: 1, kind: 'opendle-checkpoint', levelId: levelId || null,
    player: { ...runtime.player },
    playerStats: structuredClone(runtime.playerStats),
    inventory: structuredClone(runtime.inventory),
    variables: { ...runtime.variables },
    physics: runtime.physics?.saveState?.() ?? null,
  };
}

function applyCheckpoint(runtime, saved) {
  if (!saved || saved.kind !== 'opendle-checkpoint') throw new Error('that file is not a checkpoint of this game');
  Object.assign(runtime.player, saved.player || {});
  if (saved.playerStats) Object.assign(runtime.playerStats, saved.playerStats);
  if (saved.variables) Object.assign(runtime.variables, saved.variables);
  if (saved.physics) runtime.physics?.restoreState?.(saved.physics);
}

// ---------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------

function playing() {
  const runtime = game.engine?.runtime;
  return Boolean(runtime) && runtime.gameScreen === 'playing';
}

function onMenu() {
  const runtime = game.engine?.runtime;
  return Boolean(runtime) && runtime.gameScreen !== 'playing';
}

/** The engine's menu screens are keyboard driven: arrows move between rows, Enter clicks one. */
function handleMenuKey(code) {
  const runtime = game.engine?.runtime;
  if (!runtime || runtime.gameScreen === 'playing') return false;
  if (code === 'Escape') { setGameScreen(runtime, 'return'); return true; }
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(code)) return false;
  if (code === 'ArrowLeft' || code === 'ArrowRight') {
    if (!game.keys.has(code)) game.pressed.add(code);
    game.keys.add(code);
    return true;
  }
  const rows = [...hudHost.querySelectorAll('[role="button"]')]
    .filter(node => node.tabIndex === 0 && node.dataset.menuSelectable !== 'false');
  if (!rows.length) return false;
  const focused = rows.findIndex(node => node.dataset.hudId === runtime.hudState.focused);
  if (code === 'Enter') { (rows[focused < 0 ? 0 : focused])?.click(); return true; }
  const next = focused < 0
    ? (code === 'ArrowDown' ? 0 : rows.length - 1)
    : (focused + (code === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
  return true;
}

window.addEventListener('keydown', event => {
  primeAudio();
  if (event.code === 'Escape') {
    const runtime = game.engine?.runtime;
    if (runtime?.gameScreen === 'playing') {
      event.preventDefault();
      setGameScreen(runtime, 'pause');
      game.keys.clear(); game.pressed.clear();
    } else if (onMenu() && handleMenuKey('Escape')) event.preventDefault();
    return;
  }
  if (!game.engine) return;
  maybeFullscreenOnGesture();
  if (onMenu()) {
    if (handleMenuKey(event.code)) { event.preventDefault(); event.stopPropagation(); }
    return;
  }
  if (!playing() || game.engine.runtime.hudState.cursor) return;
  if (validBinding(event.code) || ['Tab', 'Space', 'Enter'].includes(event.code)) event.preventDefault();
  if (!game.keys.has(event.code)) game.pressed.add(event.code);
  game.keys.add(event.code);
}, true);
window.addEventListener('keyup', event => game.keys.delete(event.code));
window.addEventListener('blur', () => { game.keys.clear(); game.pressed.clear(); });

canvas.addEventListener('pointerdown', event => {
  const runtime = game.engine?.runtime;
  primeAudio();
  maybeFullscreenOnGesture();
  if (!runtime || !playing() || runtime.hudState.cursor) return;
  if (![0, 2].includes(event.button)) return;
  const code = `Mouse${event.button}`;
  const fire = runtime.scriptedInput && event.button === 0;
  if (runtime.scriptedInput) {
    if (!game.keys.has(code)) game.pressed.add(code);
    game.keys.add(code);
  }
  if (fire) { canvas.requestPointerLock?.(); return; }
  if (document.pointerLockElement !== canvas) {
    lookDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture?.(event.pointerId);
  }
});
canvas.addEventListener('pointermove', event => {
  const runtime = game.engine?.runtime;
  if (!runtime || !playing() || runtime.hudState.cursor) return;
  if (document.pointerLockElement === canvas) return;
  if (!lookDrag || event.pointerId !== lookDrag.id) return;
  const dx = event.clientX - lookDrag.x, dy = event.clientY - lookDrag.y;
  if (dx || dy) lookPlayer(runtime, dx, dy);
  lookDrag = { ...lookDrag, x: event.clientX, y: event.clientY };
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(type, () => { lookDrag = null; game.keys.delete('Mouse0'); game.keys.delete('Mouse2'); });
}
canvas.addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('mousemove', event => {
  const runtime = game.engine?.runtime;
  if (!runtime || !playing() || runtime.hudState.cursor) return;
  if (document.pointerLockElement === canvas) lookPlayer(runtime, event.movementX, event.movementY);
});
document.addEventListener('pointerlockchange', () => { game.keys.clear(); game.pressed.clear(); });

// ---------------------------------------------------------------------------------------------------
// The frame loop: the same calls the editor's playtest makes, minus the editor
// ---------------------------------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  frameCount++;
  lastTick = now;
  const engine = game.engine;
  if (!engine) return;
  const dt = Math.min(.1, Math.max(0, (now - engine.last) / 1000));
  engine.last = now;
  const runtime = engine.runtime;
  try {
    const menu = runtime.gameScreen !== 'playing';
    const held = menu ? game.keys : mappedKeys(game.keys, runtime.settings);
    const pressed = menu ? game.pressed : mappedKeys(game.pressed, runtime.settings);
    stepRuntime(engine.snapshot, runtime, dt, held, pressed);
    game.pressed.clear();
    handleRequests(runtime);
    if (!game.engine) return;
    if (runtime.settingsRevision !== lastSettingsRevision) {
      lastSettingsRevision = runtime.settingsRevision;
      game.settings = runtime.settings;
      saveSettings();
    }
    engine.audio?.update(runtime);
    engine.preview?.render(runtime, runtime.gameScreen === 'playing' || runtime.ambientWorld ? dt : 0);
    engine.hud?.update(runtime);
    const text = !engine.snapshot.hud && runtime.messageTime > 0 ? String(runtime.message || '') : '';
    $('message').textContent = text;
    $('message').hidden = !text;
  } catch (error) {
    lastFrameError = error?.message || String(error);
    showToast(`The game stopped: ${error.message}`, true);
    void quitToMenu();
  }
}

// ---------------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------------

/**
 * A small read-only window into the running game, for the automation scenario and for a bug report:
 * which screen the engine is on, whether the HUD cursor is active, and what the menu rows look like.
 */
window.__game = {
  status: () => {
    const runtime = game.engine?.runtime;
    const rows = [...hudHost.querySelectorAll('[role="button"]')];
    return {
      screen: runtime?.gameScreen ?? null,
      cursor: Boolean(runtime?.hudState?.cursor),
      hud: Boolean(runtime?.hud),
      screens: [...(runtime?.hudState?.screens || [])].map(([id, shown]) => `${id}:${shown ? 'on' : 'off'}`).slice(0, 12),
      rows: rows.length, shown: rows.filter(row => !row.hidden).length,
      selectable: rows.filter(row => row.tabIndex === 0).length,
      level: game.engine?.levelId ?? null,
      preview: Boolean(game.engine?.preview),
      frames: frameCount, lastError: lastFrameError,
    };
  },
};
window.addEventListener('beforeunload', () => disposeEngine());
requestAnimationFrame(frame);
// A window the browser considers hidden — occluded behind another window, or on a machine whose
// compositor never presents it — receives no animation frames at all, and the game's menus are drawn
// from this loop, so they would simply never appear. A slow timer keeps the simulation alive when
// frames stop arriving; when they resume, the loop simply carries on.
setInterval(() => {
  if (performance.now() - lastTick < 250) return;
  frame(performance.now());
}, 200);
loadProject()
  .then(project => {
    game.project = project;
    game.settings = loadSettings();
    document.title = identity();
    return openMenu();
  })
  .catch(showFatal);
