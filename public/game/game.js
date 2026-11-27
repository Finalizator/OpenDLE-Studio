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
import { controllerSnapshot, gamepadLook, playRumble, readGamepads, rumbleEffect, stopRumble } from '/shared/gamepad.js';
import { bindKey, gameSettings, mappedKeys, validBinding, setGameScreen } from '/shared/game-settings.js';
import { statusBarHidden } from '/shared/game-view.js';
import { selectGameLevel, stripInactiveLevels } from '/shared/game-levels.js';
import { installIntermission } from '/shared/intermission.js';
import { installDroppedPickupRules } from '/shared/doom-hud.js';
import { upgradeCrusherRules } from '/shared/doom-specials.js';
import { installGameDefaults } from './defaults.js';
import { hydrateAssets } from './assets.js';
import { captureGameSave, restoreGameSave } from '/shared/save-game.js';
import { saveFileDocument, serializeSaveFile, parseSaveFile } from '/shared/save-files.js';
import { createSaveStore, SAVE_SLOT_COUNT } from '/shared/player-saves.js';

const $ = id => document.getElementById(id);
const canvas = $('view'), hudHost = $('hud');

const game = {
  project: null, settings: null, engine: null, busy: false, hydrated: false, toastTimer: 0,
  keys: new Set(), pressed: new Set(), audioContext: null, fullscreenAsked: false, pointerHeld: false,
};
let lookDrag = null, lastSettingsRevision = -1, frameCount = 0, lastFrameError = '', lastTick = 0;
/** What the pads said last frame, for the sticks' hysteresis and the buttons' press edges. */
let padState = { held: new Map(), sticks: new Map(), looks: new Map() };
/**
 * The controllers, read once a frame.
 *
 * A pad is translated into the same key codes the keyboard produces, so the runtime, the menus and
 * every event rule written against the keyboard keep working with one — and the buttons and axes
 * themselves are stored on the runtime as `state.pad`, which is what the controller conditions read.
 */
function pollGamepads(runtime, dt) {
  const empty = { keys: new Set(), pressed: new Set() };
  if (!navigator.getGamepads || runtime.settings.gamepadEnabled === false) return empty;
  const pads = [...navigator.getGamepads()].filter(Boolean);
  const result = readGamepads(pads, runtime.settings, padState, { menu: runtime.gameScreen !== 'playing' });
  padState = { held: result.held, sticks: result.sticks, looks: result.looks };
  runtime.pad = controllerSnapshot(result);
  const look = gamepadLook(result, dt);
  if ((look.x || look.y) && !runtime.hudState.cursor) lookPlayer(runtime, look.x, look.y);
  return result;
}
/** A rumble a rule asked for belongs to whoever holds the controllers, which is this page. */
function playRumbles(runtime) {
  if (!runtime.rumbles?.length) return;
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  for (const request of runtime.rumbles.splice(0)) {
    if (request.stop) stopRumble(pads);
    else playRumble(pads, rumbleEffect(request));
  }
}
/** Bumped by every start: a load that finishes after the player gave up is thrown away. */
let startToken = 0;
/** How long the 3D view may take to come up before the game goes on without it. */
const PREVIEW_TIMEOUT = (() => {
  // The build writes no timeout; a test can shorten it in the page's config block.
  try { return Number(JSON.parse($('game-config').textContent || '{}').previewTimeout) || 45000; }
  catch { return 45000; }
})();

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
 * Where this game keeps its saves.
 *
 * One store for the slots and the save files, in the browser storage of the game's own origin — the
 * port the server listens on is part of that origin, which is why it is derived from the game and
 * not chosen at random (see `server/game-port.js`). The studio keeps its slots on its own server; a
 * shipped game has nowhere but the browser, and a player must not have to care.
 */
function saves() {
  return createSaveStore(localStorage, { identity: identity() });
}

/**
 * The save files the engine's `saveVariables` and checkpoint rules write.
 *
 * The record in a slot, a whole-game save file and a checkpoint written by a rule are one format
 * (`shared/save-game.js` inside the envelope `shared/save-files.js` describes), so a save means the
 * same thing wherever a player moves it.
 */
function saveFileHost() {
  const store = saves();
  return {
    identity: identity(),
    read: name => store.readFile(String(name)),
    write: (name, text) => store.writeFile(String(name), String(text)),
    list: () => store.fileNames(),
  };
}

// ---------------------------------------------------------------------------------------------------
// Chrome: loading, messages, fatal errors
// ---------------------------------------------------------------------------------------------------

/**
 * The splash while the 3D view comes up.
 *
 * It shows the stage the engine is at and how far along it is, so a slow start looks like work
 * rather than a frozen window — the progress creeps towards 88% while a stage is running and
 * jumps to 100% when it finishes, because that is the honest thing a load with unknown steps can
 * say.
 */
let loadingProgress = 0, loadingCreep = null, loadingStage = null;
function setLoading(text, progress = null) {
  const overlay = $('loading');
  if (!overlay) return;
  if (!text) {
    clearInterval(loadingCreep);
    loadingCreep = null;
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  $('loading-text').textContent = text;
  if (progress !== null) {
    clearInterval(loadingCreep);
    loadingCreep = null;
    loadingStage = progress;
    setProgress(progress);
    return;
  }
  if (loadingStage === null) return;
  // A stage with no measurable steps: drift towards 88% of the way to the next one.
  clearInterval(loadingCreep);
  const ceiling = Math.min(88, loadingStage + 12);
  loadingCreep = setInterval(() => {
    if (loadingProgress >= ceiling) { clearInterval(loadingCreep); loadingCreep = null; return; }
    setProgress(loadingProgress + Math.max(0.4, (ceiling - loadingProgress) * 0.08));
  }, 120);
}
function setProgress(value) {
  loadingProgress = Math.max(0, Math.min(100, value));
  const bar = $('loading')?.querySelector('.bar');
  if (!bar) return;
  bar.setAttribute('aria-valuenow', String(Math.round(loadingProgress)));
  const fill = bar.querySelector('i');
  if (fill) fill.style.width = `${loadingProgress}%`;
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

/**
 * Waits for `promise`, but not forever.
 *
 * Returns `{ value }` when it settles, or `null` when the deadline passes first. A renderer that
 * never comes up must not leave the player looking at a loading bar with the music playing.
 */
async function withDeadline(promise, ms) {
  let timer = 0;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try {
    const settled = await Promise.race([promise.then(value => ({ value })), deadline]);
    return settled;
  } finally { clearTimeout(timer); }
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
  publishSaves(runtime);
  return { snapshot, runtime, levelId: playing };
}

/**
 * Tells the running game which slots and save files exist.
 *
 * The save and load screens draw `{game:save1}`… and a rule's `loadGameState` asks whether a file is
 * there before offering it, so both are read from storage on every menu that can change them.
 */
function publishSaves(runtime) {
  if (!runtime) return;
  try {
    runtime.saveSlots = saves().slotLabels();
    runtime.saveFiles = new Set(saves().fileNames());
  } catch (error) {
    runtime.saveSlots = Array(SAVE_SLOT_COUNT).fill('');
    runtime.saveFiles = new Set();
    runtime.saveStatus = `Saves are unavailable: ${error.message}`;
  }
}

/**
 * Takes the pointer back whenever the game is at play without it.
 *
 * Only for a player who had it: the intent is remembered across a level change, the intermission and
 * a pause, because each of those is the game deciding, not the player. A player who never captured
 * the mouse is never grabbed, and a browser refusing the re-capture only rejects the promise, which
 * leaves the click-to-look and click-to-fire paths in charge.
 */
let pointerWatch = { runtime: null, screen: null };
/** Why the last load failed, for `__game.status()`: a save that refuses to load must not be silent. */
let lastLoadError = '';
function watchPointerCapture(runtime) {
  const screen = runtime?.gameScreen || null;
  if (runtime === pointerWatch.runtime && screen === pointerWatch.screen) return;
  pointerWatch = { runtime, screen };
  if (screen !== 'playing' || !game.pointerHeld || document.pointerLockElement === canvas) return;
  canvas.requestPointerLock?.()?.catch?.(() => {
    // A browser can refuse: the gesture that started the level may be too old, or its post-Escape
    // cooldown may still be running. Clicking the view is the path that always works, so say so
    // rather than leaving the player wondering why the cursor is still theirs.
    showToast('The browser did not capture the mouse — click the view to take it.');
  });
}

/**
 * Tears the running level down.
 *
 * The captured mouse is not part of what a level owns: `releasePointer` is for the caller that is
 * opening a screen the player has to point at (the game's menu, quitting). A level change kept
 * releasing it, so finishing a level handed the player a free cursor in the middle of the game.
 */
function disposeEngine({ releasePointer = false } = {}) {
  // The player is done with the mouse capture when the game goes back to its own menu.
  if (releasePointer) game.pointerHeld = false;
  if (!game.engine) {
    if (releasePointer) document.exitPointerLock?.();
    return;
  }
  const { preview, hud, audio } = game.engine;
  game.engine = null;
  try { audio?.dispose(); } catch { /* already gone */ }
  try { hud?.dispose(); } catch { /* already gone */ }
  try { preview?.dispose(); } catch { /* already gone */ }
  hudHost.replaceChildren();
  $('message').hidden = true;
  if (releasePointer) document.exitPointerLock?.();
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
  disposeEngine({ releasePointer: true });
  setLoading('Loading the game…', 4);
  try {
    if (!game.hydrated) {
      await loadArtwork();
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

/**
 * Reads the split payloads with a running count, and reports what it could not read.
 *
 * The count matters: a campaign is thousands of files, and a bar that only says "loading" looks
 * the same whether it is nearly done or wedged.
 */
async function loadArtwork() {
  const failures = [];
  const { loaded, failed } = await hydrateAssets(game.project, (done, total) => {
    // Artwork is the long part of a first start, so it is where most of the bar lives.
    if (total) setLoading(`Loading the artwork… ${done} of ${total}`, 6 + Math.round((done / total) * 62));
  }, undefined, { concurrency: 8, timeout: 20000, onFailure: (asset, reason) => failures.push(`${asset.name || asset.id}: ${reason}`) });
  if (failed.length) {
    showToast(`${failed.length} of ${loaded + failed.length} artwork files could not be read — first: ${failures[0]}`, true);
  }
  return { loaded, failed };
}

/**
 * Starts a level, retrying once when it fails.
 *
 * A level change builds its runtime and its renderer in the same instant the previous level is
 * being torn down, and a texture decode or a GPU allocation can lose that race. Players report it
 * as "it said it could not load the textures and went back to the menu, but the second try worked" —
 * so the second try is taken here, once, before the session is thrown away. A save load is not
 * retried: a record that does not fit is a real error and hiding it would cost the player the
 * message.
 */
async function playLevel(levelId, options = {}) {
  const { attempt = 1, ...rest } = options;
  const outcome = await startLevel(levelId, { ...rest, attempt });
  if (outcome === 'retry') return playLevel(levelId, { ...rest, attempt: attempt + 1 });
}

/** Starts a level: the runtime is rebuilt at `playing` and the 3D view is created for it. */
async function startLevel(levelId, { progress = null, record = null, attempt = 1 } = {}) {
  if (game.busy) return;
  game.busy = true;
  const token = ++startToken;
  // Starting a level is the player saying "I am playing", so the mouse is captured as the level comes
  // up. Until this existed the first level of a session was the one screen that needed a click in the
  // view to get the mouse back: nothing had asked for the capture yet, so the pointer stayed the
  // system's and the cursor sat over the game.
  game.pointerHeld = true;
  hideFatal();
  // The artwork loader owns most of the bar, so a first start shows it from the start instead of
  // jumping back from the level's own percentage to a smaller one.
  setLoading('Loading the level…', 4);
  game.keys.clear(); game.pressed.clear();
  try {
    if (!game.hydrated) {
      await loadArtwork();
      game.hydrated = true;
      if (token !== startToken) return;
    }
    setLoading('Loading the level…', 70);
    let engine = buildRuntime({ levelId, screen: 'playing', progress });
    // A record rebuilds the runtime the save was written from: same level, same carried stats, same
    // place on the map. Its physics is restored once the collision world exists, which is after the
    // renderer has been created — a save that moves the player without moving their body would put
    // the camera inside a wall.
    let physicsData = null;
    if (record) {
      const restored = restoreGameSave(engine.snapshot, record, identity());
      physicsData = restored.physicsData;
      engine = { ...engine, runtime: restored.runtime };
      engine.runtime.hudState.cursor = engine.runtime.gameScreen !== 'playing';
      publishSaves(engine.runtime);
      engine.runtime.saveStatus = `Loaded the game${record.levelId ? ` at ${record.levelId}` : ''}.`;
    }
    // Screen size 11 is the fullscreen HUD, and it hides a classic status bar as a whole. A player
    // who starts a game and finds no bar at the bottom cannot tell that from a broken build, so the
    // bar wins over the screen size — but only for a project that has one.
    if (statusBarHidden(engine.snapshot.hud, engine.runtime.settings)) {
      engine.runtime.settings.viewSize = 10;
      engine.runtime.settingsRevision++;
      engine.runtime.message = 'Screen size 11 hides the whole status bar, so it was set back to 10.';
      engine.runtime.messageTime = 6;
    }
    disposeEngine();
    game.engine = { ...engine, preview: null, hud: null, audio: null, last: performance.now() };
    let preview = null;
    // Without a number the bar creeps: the renderer answers when it answers, and a stage that
    // takes seconds must not sit frozen on the mark the previous one left.
    setLoading('Starting the 3D view…');
    const pending = createPreview(canvas, engine.snapshot, engine.runtime, { onMediaError: message => showToast(message, true) });
    const started = await withDeadline(pending, PREVIEW_TIMEOUT);
    if (!started) {
      // The renderer may answer after the deadline: nothing will ever draw it, and a preview that
      // is never disposed holds its WebGL context and every texture it uploaded for the whole
      // session, so the late one is thrown away as soon as it arrives.
      pending.then(late => late?.dispose?.(), () => {});
    }
    if (token !== startToken) {
      // The player gave up on this level while the renderer was coming up: throw the late one away.
      if (started?.value?.dispose) started.value.dispose();
      return;
    }
    setLoading(started ? 'Ready' : 'The 3D view is not available', 100);
    if (!started) {
      showToast('The 3D view did not start in time, so the game continues without it.', true);
    } else {
      preview = started.value;
    }
    if (game.engine?.runtime !== engine.runtime) { preview?.dispose(); return; }
    game.engine.preview = preview;
    if (physicsData && engine.runtime.physics) {
      try { engine.runtime.physics.restoreState(physicsData); }
      catch (error) { showToast(`The saved physics state could not be restored: ${error.message}`, true); }
    }
    attachHud(game.engine);
    try {
      game.engine.audio = createAudioPlayer(engine.snapshot, message => showToast(message, true), undefined, primeAudio() || undefined);
    } catch (error) { showToast(`Sound is unavailable: ${error.message}`, true); }
    game.engine.last = performance.now();
    await goFullscreen();
    canvas.focus();
    stepRuntime(engine.snapshot, engine.runtime, 0, new Set());
    game.engine.hud.update?.(engine.runtime);
    // A load reports the level it resumed; that is not an error, so it is not shown as one.
    if (engine.runtime.saveStatus) showToast(engine.runtime.saveStatus);
  } catch (error) {
    if (record) lastLoadError = error.message;
    // The retry runs from `playLevel`, after this call's `finally` has released `game.busy`.
    if (!record && attempt < 2) {
      console.warn(`The level did not start (${error.message}); trying once more.`);
      return 'retry';
    }
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
  disposeEngine({ releasePointer: true });
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
    // A whole-game document: a checkpoint a rule writes, or the file a player keeps. Both hold the
    // engine's own record in the envelope `shared/save-files.js` describes.
    if (request?.type === 'save-file' || request?.type === 'load-file') {
      const name = String(request.file ?? '').trim();
      try {
        if (request.type === 'save-file') {
          const record = saveRecord(runtime, game.engine?.levelId);
          saves().writeFile(name, serializeSaveFile(saveFileDocument({
            kind: 'game', name, identity: identity(), levelId: game.engine?.levelId || null, record,
          })));
          publishSaves(runtime);
          runtime.saveFileError = '';
          runtime.saveStatus = `Saved the game to the save file ${name}.`;
        } else {
          const text = saves().readFile(name);
          if (text === null || text === undefined) throw new Error(`there is no save file named ${name}`);
          const document_ = parseSaveFile(text);
          if (document_.kind !== 'game') throw new Error(`${name} holds variables, not a whole game`);
          if (document_.identity && document_.identity !== identity())
            throw new Error(`${name} belongs to a different game`);
          loadRecord(runtime, document_.record);
        }
      } catch (error) { runtime.saveFileError = error.message; runtime.saveStatus = `Save file failed: ${error.message}`; }
      continue;
    }
    // The save slots the project's own menu draws. The record is the engine's, the storage is the
    // game's own: Save writes slot N, Load rebuilds the level the record names and resumes there.
    if (request?.type === 'save' || request?.type === 'load') {
      const slot = Number(request.slot);
      try {
        if (request.type === 'save') {
          saves().writeSlot(slot, saveRecord(runtime, game.engine?.levelId));
          publishSaves(runtime);
          runtime.saveFileError = '';
          runtime.saveStatus = `Game saved in slot ${slot}.`;
          setGameScreen(runtime, 'save');
        } else {
          const record = saves().readSlot(slot);
          if (!record) { runtime.saveStatus = `Save slot ${slot} is empty.`; runtime.saveFileError = 'empty'; continue; }
          loadRecord(runtime, record);
        }
      } catch (error) {
        runtime.saveFileError = error.message;
        runtime.saveStatus = `${request.type === 'save' ? 'Save' : 'Load'} failed: ${error.message}`;
      }
    }
  }
}

/** The engine's record of the running game, ready to be stored. */
function saveRecord(runtime, levelId) {
  if (!game.engine?.snapshot) throw new Error('start or resume a game before saving');
  return captureGameSave(game.engine.snapshot, runtime, identity());
}

/**
 * Resumes a record: its own level, its own state, its own physics.
 *
 * A level is rebuilt rather than patched in place, because the record may name a different level
 * than the one on screen and half of a level's runtime is derived from its map.
 */
function loadRecord(runtime, record) {
  const levelId = record?.levelId ?? null;
  if (levelId && !game.project?.game?.levels?.some(level => level.id === levelId)) {
    throw new Error(`that save is for level ${levelId}, which this build does not have`);
  }
  runtime.saveStatus = 'Loading…';
  void playLevel(levelId, { record });
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
/**
 * CapsLock read from the event itself: it is a toggle, so a key held state cannot answer for it.
 * The runtime sees `CapsLock` in the held set and runs while the light is on.
 */
function syncCapsLock(event) {
  const on = Boolean(event.getModifierState?.('CapsLock'));
  if (on) game.keys?.add('CapsLock'); else game.keys?.delete('CapsLock');
}

function handleMenuKey(code) {
  const runtime = game.engine?.runtime;
  if (!runtime || runtime.gameScreen === 'playing') return false;
  if (code === 'Escape') { setGameScreen(runtime, 'return'); return true; }
  // Space is how a Doom menu is used, and a pad's Cross arrives as Enter: both are the same key.
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'Space'].includes(code)) return false;
  if (code === 'ArrowLeft' || code === 'ArrowRight') {
    if (!game.keys.has(code)) game.pressed.add(code);
    game.keys.add(code);
    return true;
  }
  const rows = [...hudHost.querySelectorAll('[role="button"]')]
    .filter(node => node.tabIndex === 0 && node.dataset.menuSelectable !== 'false');
  if (!rows.length) return false;
  const focused = rows.findIndex(node => node.dataset.hudId === runtime.hudState.focused);
  if (code === 'Enter' || code === 'NumpadEnter' || code === 'Space') {
    (rows[focused < 0 ? 0 : focused])?.click();
    return true;
  }
  const next = focused < 0
    ? (code === 'ArrowDown' ? 0 : rows.length - 1)
    : (focused + (code === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
  return true;
}

window.addEventListener('keydown', event => {
  primeAudio();
  syncCapsLock(event);
  // The Options sheet asks for the next key it sees (`captureGameBinding`); nothing read that, so
  // every rebind ended by doing nothing and the menu kept waiting. Escape cancels, as the HUD says.
  const binding = game.engine?.runtime?.bindingKey;
  if (binding) {
    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'Escape') game.engine.runtime.bindingKey = null;
    else {
      try { bindKey(game.engine.runtime, event.code); showToast(`Bound to ${event.code}.`); }
      catch (error) { showToast(error.message, true); }
    }
    game.engine.runtime.settingsRevision++;
    return;
  }
  if (event.code === 'Escape') {
    if (game.busy) {
      // A start that is taking too long must be escapable: give up on it and go back to the menu.
      event.preventDefault();
      startToken++;
      game.busy = false;
      showToast('Level start cancelled.');
      void openMenu();
      return;
    }
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
window.addEventListener('keyup', event => {
  syncCapsLock(event);
  // CapsLock raised its own keyup the moment it was pressed; deleting it here would drop the
  // always-run flag until some other key repeated.
  if (event.code !== 'CapsLock') game.keys.delete(event.code);
});
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
document.addEventListener('pointerlockchange', () => {
  // Losing the lock can swallow the button release, so the trigger is dropped — but the keyboard
  // has nothing to do with the pointer. Clearing it here is why a player who was running stopped
  // dead the moment a click grabbed the pointer: the `W` never came back until it was re-pressed.
  for (const code of ['Mouse0', 'Mouse2']) { game.keys.delete(code); game.pressed.delete(code); }
  // The captured mouse belongs to the game, not to a level, and the intent is the player's: it is
  // set when they take the pointer and dropped only when the game goes back to its own menu. So a
  // level change, the intermission, or a pause and resume does not hand them a free cursor.
  if (document.pointerLockElement === canvas) game.pointerHeld = true;
});

// ---------------------------------------------------------------------------------------------------
// The frame loop: the same calls the editor's playtest makes, minus the editor
// ---------------------------------------------------------------------------------------------------

/**
 * The frame loop, scheduled exactly once.
 *
 * `frame` is called both by animation frames and by the fallback timer below, and it used to
 * register a new animation frame on every call. A window the browser occludes runs the timer for
 * every tick while animation frames are stopped, so each tick left one more callback pending: when
 * the window came back, hundreds of them fired for the same frame, each stepping the runtime and
 * drawing the scene, and the game never recovered its frame time.
 */
let frameScheduled = false;
function scheduleFrame() {
  if (frameScheduled) return;
  frameScheduled = true;
  requestAnimationFrame(now => { frameScheduled = false; frame(now); });
}

function frame(now) {
  scheduleFrame();
  frameCount++;
  lastTick = now;
  const engine = game.engine;
  if (!engine) return;
  const dt = Math.min(.1, Math.max(0, (now - engine.last) / 1000));
  engine.last = now;
  const runtime = engine.runtime;
  try {
    const menu = runtime.gameScreen !== 'playing';
    const pad = pollGamepads(runtime, dt);
    // A menu screen is navigated by this shell, not by the runtime, so a pad's d-pad and Cross
    // have to arrive here as well: they were read only by the game loop, which is why a
    // controller could not move through the menu at all.
    if (menu) for (const code of pad.pressed) handleMenuKey(code);
    const heldKeys = pad.keys.size ? new Set([...game.keys, ...pad.keys]) : game.keys;
    const pressedKeys = pad.pressed.size ? new Set([...game.pressed, ...pad.pressed]) : game.pressed;
    const held = menu ? heldKeys : mappedKeys(heldKeys, runtime.settings);
    const pressed = menu ? pressedKeys : mappedKeys(pressedKeys, runtime.settings);
    stepRuntime(engine.snapshot, runtime, dt, held, pressed);
    game.pressed.clear();
    playRumbles(runtime);
    handleRequests(runtime);
    // A level change, a load or a quit disposes this engine and builds the next one *inside*
    // handleRequests, so `engine` above is now a disposed renderer and a disposed HUD. Rendering
    // with it drew one more frame into a torn-down WebGL state and, on Windows, threw — which sent
    // the player straight back to the menu from the middle of a level change. Leave the frame to
    // the engine that is actually current; the next frame picks it up.
    if (game.engine !== engine) return;
    if (game.engine) watchPointerCapture(runtime);
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
  /** Start a level without clicking through the menus; a test hook, and a way to reproduce a report. */
  start: levelId => playLevel(levelId || game.project?.game?.entry || null),
  /**
   * Ask the game for something, exactly as an engine rule does (`saveGame`, `loadGame`,
   * `saveGameState`, `loadGameState` all end up as a `menuRequests` entry).
   */
  request: request => {
    const runtime = game.engine?.runtime;
    if (!runtime) return false;
    runtime.menuRequests.push(request);
    handleRequests(runtime);
    return true;
  },
  /**
   * Ask for something and let the *frame loop* carry it out, which is how a real level exit
   * reaches `handleRequests`. `request` above runs it here and now, on the caller's stack, so it
   * cannot show what the loop does when the engine is replaced underneath it.
   */
  enqueue: request => {
    const runtime = game.engine?.runtime;
    if (!runtime) return false;
    runtime.menuRequests.push(request);
    return true;
  },
  /** The campaign's level ids, in play order. */
  levels: () => (game.project?.game?.levels || []).map(level => level.id || level.name).filter(Boolean),
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
      // What the frame was actually given, and how fast the world says the player is going: the
      // pair that answers "did my input reach the game?" without guessing.
      keys: [...game.keys].sort(),
      speed: Math.round(runtime?.speed ?? 0),
      pointer: { locked: document.pointerLockElement === canvas, held: game.pointerHeld },
      // Save slots and save files, as the save and load screens see them; `saveStatus` is what the
      // menu prints under the rows, so a report can quote the game's own words.
      saveSlots: runtime?.saveSlots ?? [],
      saveFiles: [...(runtime?.saveFiles || [])],
      saveStatus: runtime?.saveStatus ?? '',
      lastLoadError,
      viewSize: game.engine?.runtime?.settings?.viewSize ?? null,
      statusBar: (() => {
        const elements = [...(game.engine?.runtime?.hudState?.elements?.values?.() || [])].filter(element => element.statusbar);
        const nodes = elements.map(element => document.querySelector(`#hud [data-hud-id="${element.id}"]`)).filter(Boolean);
        const first = nodes[0]?.getBoundingClientRect();
        return {
          elements: elements.length,
          visibleFlags: elements.filter(element => element.visible).length,
          displays: [...new Set(elements.map(element => element.display))],
          nodes: nodes.length,
          nodeHidden: nodes.filter(node => node.hidden).length,
          window: [window.innerWidth, window.innerHeight],
          rect: first ? [Math.round(first.x), Math.round(first.y), Math.round(first.width), Math.round(first.height)] : null,
        };
      })(),
      preview: Boolean(game.engine?.preview),
      frames: frameCount, lastError: lastFrameError,
    };
  },
};
window.addEventListener('beforeunload', () => disposeEngine());
scheduleFrame();
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
