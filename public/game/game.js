// The exported game: data in, engine out, no editor anywhere.
//
// This file is the whole application a player runs. It boots to a main menu, starts the engine when
// the player asks for a level, and keeps the loop the editor's playtest uses (runtime step, audio,
// render, HUD) so a level plays the same here as it does in the studio.

import { createPreview } from '/render.js';
import { createAudioPlayer } from '/audio.js';
import { createHUDView } from '/hud-view.js';
import { createRuntime, stepRuntime, lookPlayer } from '/shared/runtime.js';
import { gameSettings, mappedKeys, changeSetting, validBinding, setGameScreen, GAME_SETTINGS } from '/shared/game-settings.js';
import { selectGameLevel, stripInactiveLevels } from '/shared/game-levels.js';
import { installDefaultHUD } from '/shared/hud.js';
import { installGameMenu } from '/shared/game-menu.js';
import { installIntermission } from '/shared/intermission.js';
import { installDroppedPickupRules } from '/shared/doom-hud.js';
import { upgradeCrusherRules } from '/shared/doom-specials.js';
import { mainMenu, levelEntries, optionRows, gameProgress, progressKey, skillLabel } from './menu.js';
import { hydrateAssets } from './assets.js';

const $ = id => document.getElementById(id);
const canvas = $('view'), hudHost = $('hud');

const game = {
  project: null, settings: null, engine: null, progress: null, screen: 'loading', busy: false, toastTimer: 0,
};

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
 * Asset `src` values are URLs beside the document, so the renderer, the audio player and the model
 * loaders fetch them the same way they fetch a data URL — that is what keeps the game's JSON small.
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
  // A project that never went through the editor's playtest still gets the menus and HUD the engine
  // expects, in memory only: the exported files are never written to.
  installDefaultHUD(project);
  installGameMenu(project);
  return project;
}

function settingsKey() {
  return `opendle-game-settings:${String(game.project?.title || 'game').slice(0, 80)}`;
}

function loadSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(settingsKey()) || '{}') || {}; } catch { stored = {}; }
  try { return gameSettings(stored); } catch { return gameSettings(); }
}

function saveSettings() {
  try { localStorage.setItem(settingsKey(), JSON.stringify(game.settings)); } catch { /* storage is optional */ }
}

function loadProgress() {
  try {
    return gameProgress(game.project, JSON.parse(localStorage.getItem(progressKey(game.project?.title)) || 'null'));
  } catch { return null; }
}

function rememberProgress(levelId) {
  try { localStorage.setItem(progressKey(game.project?.title), JSON.stringify({ levelId, at: Date.now() })); } catch { /* optional */ }
  game.progress = loadProgress();
}


// ---------------------------------------------------------------------------------------------------
// Chrome: menu, panels, loading, messages
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
  if (message) game.toastTimer = setTimeout(() => { node.hidden = true; }, 6000);
}

function hideOverlays() {
  $('menu').hidden = true;
  $('panel').hidden = true;
  $('pause').hidden = true;
}

function showMenu() {
  game.screen = 'menu';
  hideOverlays();
  document.exitPointerLock?.();
  const model = mainMenu(game.project, { progress: game.progress });
  document.title = model.title;
  $('game-title').textContent = model.title;
  $('game-subtitle').textContent = model.subtitle;
  const buttons = $('menu-buttons');
  buttons.replaceChildren(...model.actions.map((action, index) => menuButton(action, index)));
  $('menu-hint').innerHTML = 'Enter or click to choose. <kbd>Escape</kbd> closes a panel or the game menu.';
  $('menu').hidden = false;
  buttons.firstElementChild?.focus();
}

function menuButton(action, index) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action.id;
  if (index === 0) button.className = 'primary';
  const label = document.createElement('span'); label.className = 'label'; label.textContent = action.label;
  const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = action.hint || '';
  button.append(label, hint);
  button.addEventListener('click', () => { action.run ? action.run() : chooseMenuAction(action.id); });
  return button;
}

function chooseMenuAction(id) {
  if (game.busy) return;
  if (id === 'new') return void startLevel(game.project?.game?.entry || null);
  if (id === 'continue') return void startLevel(game.progress?.levelId || game.project?.game?.entry || null);
  if (id === 'levels') return showLevels();
  if (id === 'options') return showOptions();
  if (id === 'quit') return quitGame();
  if (id === 'resume') return resumeGame();
  if (id === 'menu') return quitToMenu();
}

function showPanel(title, lede, body, actions) {
  game.screen = 'panel';
  hideOverlays();
  $('panel-title').textContent = title;
  $('panel-lede').textContent = lede;
  $('panel-body').replaceChildren(...body);
  $('panel-actions').replaceChildren(...actions.map(action => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    if (action.primary) button.className = 'primary';
    button.addEventListener('click', action.run);
    return button;
  }));
  $('panel').hidden = false;
  $('panel-body').querySelector('button, input, select')?.focus();
  return $('panel-actions').lastElementChild;
}

function showLevels() {
  const entries = levelEntries(game.project, { progress: game.progress, current: game.engine?.levelId || null });
  const list = document.createElement('div');
  list.className = 'level-list';
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    if (entry.current) button.className = 'current';
    const label = document.createElement('span'); label.textContent = entry.label;
    const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = entry.hint;
    button.append(label, hint);
    button.addEventListener('click', () => void startLevel(entry.id));
    list.append(button);
  }
  showPanel('Levels', 'Pick a level to play. Progress through the campaign is remembered on this machine.',
    [list], [{ label: 'Back', run: () => (game.engine ? resumeGame() : showMenu()) }]);
}

/** The options panel edits the same settings object the runtime uses, so a change is live. */
function showOptions() {
  const rows = optionRows(game.engine?.runtime.settings || game.settings, GAME_SETTINGS);
  const list = document.createElement('div');
  list.className = 'option-list';
  for (const row of rows) list.append(optionRow(row));
  showPanel('Options', 'Settings are saved on this machine and apply to the next start too.', [list], [
    {
      label: document.fullscreenElement ? 'Leave fullscreen' : 'Fullscreen',
      run: () => toggleFullscreen().then(() => showOptions()).catch(error => showToast(error.message, true)),
    },
    { label: 'Back', primary: true, run: () => (game.engine ? resumeGame() : showMenu()) },
  ]);
}

function optionRow(row) {
  const line = document.createElement('label');
  line.className = 'option-row';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = row.name === 'difficulty' ? 'skill' : row.name.replace(/([A-Z])/g, ' $1').toLowerCase();
  line.append(name);
  if (row.kind === 'toggle') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(row.value);
    input.addEventListener('change', () => applySetting(row.name, input.checked));
    const value = document.createElement('output');
    value.textContent = row.value ? 'on' : 'off';
    line.append(input, value);
  } else if (row.kind === 'choice') {
    const select = document.createElement('select');
    for (const option of row.options) {
      const node = document.createElement('option');
      node.value = String(option); node.textContent = String(option);
      if (String(option) === String(row.value)) node.selected = true;
      select.append(node);
    }
    select.addEventListener('change', () => applySetting(row.name, select.value));
    const value = document.createElement('output');
    line.append(select, value);
  } else {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(row.min ?? 0); input.max = String(row.max ?? 1); input.step = String(row.step ?? .1);
    input.value = String(row.value ?? 0);
    const value = document.createElement('output');
    const label = () => {
      if (row.name === 'difficulty') return skillLabel(input.value);
      if (row.name === 'viewSize') return String(Math.round(Number(input.value)));
      return Number(input.value).toFixed(2).replace(/\.?0+$/, '');
    };
    value.textContent = label();
    input.addEventListener('input', () => { value.textContent = label(); });
    input.addEventListener('change', () => applySetting(row.name, Number(input.value)));
    line.append(input, value);
  }
  return line;
}

function applySetting(name, value) {
  try {
    if (game.engine?.runtime) changeSetting(game.engine.runtime, name, value);
    else game.settings[name] = value;
    game.settings = game.engine?.runtime?.settings || game.settings;
    saveSettings();
  } catch (error) { showToast(error.message, true); }
}

// ---------------------------------------------------------------------------------------------------
// Fullscreen
// ---------------------------------------------------------------------------------------------------

async function goFullscreen() {
  if (document.fullscreenElement) return;
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); }
  catch { /* the browser can refuse outside a gesture; the game plays windowed */ }
}

async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
}

// ---------------------------------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------------------------------

function disposeEngine() {
  if (!game.engine) return;
  const { preview, hud, audio } = game.engine;
  game.engine = null;
  try { audio?.dispose(); } catch { /* already gone */ }
  try { hud?.dispose(); } catch { /* already gone */ }
  try { preview?.dispose(); } catch { /* already gone */ }
  hudHost.replaceChildren();
  $('message').hidden = true;
}

/**
 * Builds the runtime for one level and starts drawing it.
 *
 * Only the level being played keeps its map: an imported campaign is hundreds of megabytes of level
 * data, and cloning all of it to play the first one is what made starting a game slow in the editor
 * before it was fixed there.
 */
async function startLevel(levelId, { progress = null } = {}) {
  if (game.busy) return;
  game.busy = true;
  hideOverlays();
  setLoading('Loading the level…');
  const keys = game.keys; keys?.clear(); game.pressed?.clear();
  try {
    const playing = levelId || game.project?.game?.entry || null;
    setLoading('Loading the artwork…');
    await hydrateAssets(game.project, (done, total) => {
      if (total) setLoading(`Loading the artwork… ${Math.round((done / total) * 100)}%`);
    });
    setLoading('Loading the level…');
    const playable = playing ? stripInactiveLevels(game.project, playing) : game.project;
    const snapshot = structuredClone(playable);
    if (snapshot.game && playing) selectGameLevel(snapshot, playing);
    installIntermission(snapshot);
    installDroppedPickupRules(snapshot);
    upgradeCrusherRules(snapshot);
    for (const level of snapshot.game?.levels || []) {
      if (level.id === snapshot.game.active) continue;
      level.data = {}; level.assetIds = [];
    }
    disposeEngine();
    const runtime = createRuntime(snapshot, {
      settings: { ...(game.settings || {}) }, gameMode: Boolean(snapshot.game), screen: 'playing', progress,
    });
    runtime.gameMode = Boolean(snapshot.game);
    runtime.hudState.cursor = false;
    game.engine = { snapshot, runtime, levelId: playing, preview: null, hud: null, audio: null, last: performance.now() };
    const preview = await createPreview(canvas, snapshot, runtime, { onMediaError: message => showToast(message, true) });
    if (game.engine?.runtime !== runtime) { preview.dispose(); return; }
    game.engine.preview = preview;
    game.engine.hud = createHUDView(hudHost, snapshot, {
      click: id => { if (runtime.hudState.cursor) runtime.hudState.clicked.add(id); },
      error: message => showToast(message, true),
    });
    try { game.engine.audio = createAudioPlayer(snapshot, message => showToast(message, true)); } catch (error) { showToast(`Sound is unavailable: ${error.message}`, true); }
    game.engine.last = performance.now();
    rememberProgress(playing);
    game.screen = 'game';
    await goFullscreen();
    canvas.focus();
    stepRuntime(snapshot, runtime, 0, new Set());
    game.engine.hud.update?.(runtime);
    if (runtime.saveStatus) showToast(runtime.saveStatus, true);
  } catch (error) {
    disposeEngine();
    showToast(`Could not start the level: ${error.message}`, true);
    showMenu();
  } finally {
    game.busy = false;
    setLoading(null);
  }
}

function pauseGame() {
  const runtime = game.engine?.runtime;
  if (!runtime || runtime.gameScreen !== 'playing') return;
  document.exitPointerLock?.();
  if (game.project?.gameMenus?.screens?.includes('pause')) {
    setGameScreen(runtime, 'pause');
    return;
  }
  game.screen = 'pause';
  $('pause').hidden = false;
  const frame = document.createElement('div');
  frame.className = 'menu-frame';
  const title = document.createElement('h1'); title.textContent = 'Paused';
  const subtitle = document.createElement('p'); subtitle.id = 'game-subtitle';
  subtitle.textContent = game.project?.title || '';
  const buttons = document.createElement('div'); buttons.className = 'menu-buttons';
  for (const action of [
    { id: 'resume', label: 'Resume', hint: 'Back to the level' },
    { id: 'levels', label: 'Levels', hint: 'Pick another level' },
    { id: 'options', label: 'Options', hint: 'Video, sound and controls' },
    { id: 'menu', label: 'Quit to menu', hint: 'Leave this level' },
  ]) {
    const button = menuButton({ ...action, run: () => { $('pause').hidden = true; chooseMenuAction(action.id); } });
    buttons.append(button);
  }
  frame.append(title, subtitle, buttons);
  $('pause').replaceChildren(frame);
  buttons.firstElementChild?.focus();
}

function resumeGame() {
  const runtime = game.engine?.runtime;
  hideOverlays();
  if (!runtime) return showMenu();
  setGameScreen(runtime, 'playing');
  game.screen = 'game';
  canvas.focus();
}

function quitToMenu() {
  disposeEngine();
  game.screen = 'menu';
  showMenu();
}

function quitGame() {
  disposeEngine();
  window.close();
  // A browser window that was not opened by a script cannot be closed; say so instead of hanging.
  showMenu();
  showToast('Close this tab to leave the game.');
}

// ---------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------

game.keys = new Set();
game.pressed = new Set();
let lookDrag = null;

function playing() {
  const runtime = game.engine?.runtime;
  return Boolean(runtime) && game.screen === 'game' && runtime.gameScreen === 'playing';
}

window.addEventListener('keydown', event => {
  if (!game.engine) return;
  if (event.code === 'Escape') {
    const runtime = game.engine.runtime;
    if (runtime.gameScreen === 'playing') { event.preventDefault(); pauseGame(); }
    else if (runtime.gameScreen === 'pause') { event.preventDefault(); resumeGame(); }
    else if (game.screen === 'pause') { event.preventDefault(); resumeGame(); }
    return;
  }
  if (!playing() || runtime()?.hudState.cursor) return;
  if (validBinding(event.code) || ['Tab', 'Space', 'Enter'].includes(event.code)) event.preventDefault();
  if (!game.keys.has(event.code)) game.pressed.add(event.code);
  game.keys.add(event.code);
}, true);
window.addEventListener('keyup', event => game.keys.delete(event.code));
window.addEventListener('blur', () => { game.keys.clear(); game.pressed.clear(); });

function runtime() { return game.engine?.runtime || null; }

canvas.addEventListener('pointerdown', event => {
  const state = runtime();
  if (!state || !playing() || state.hudState.cursor) return;
  if (![0, 2].includes(event.button)) return;
  const code = `Mouse${event.button}`;
  // A Doom project fires with the left button and looks with the right one; anything else looks
  // with the left button, exactly as the editor's playtest does.
  const fire = state.scriptedInput && event.button === 0;
  if (state.scriptedInput) {
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
  const state = runtime();
  if (!state || !playing() || state.hudState.cursor) return;
  if (document.pointerLockElement === canvas) return; // pointerlock contributes via mousemove
  if (!lookDrag || event.pointerId !== lookDrag.id) return;
  const dx = event.clientX - lookDrag.x, dy = event.clientY - lookDrag.y;
  if (dx || dy) lookPlayer(state, dx, dy);
  lookDrag = { ...lookDrag, x: event.clientX, y: event.clientY };
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(type, () => { lookDrag = null; game.keys.delete('Mouse0'); game.keys.delete('Mouse2'); });
}
canvas.addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('mousemove', event => {
  const state = runtime();
  if (!state || !playing() || state.hudState.cursor) return;
  if (document.pointerLockElement === canvas) lookPlayer(state, event.movementX, event.movementY);
});
document.addEventListener('pointerlockchange', () => {
  game.keys.clear(); game.pressed.clear();
  if (game.engine && !document.pointerLockElement) game.pressed.clear();
});

// ---------------------------------------------------------------------------------------------------
// The frame loop: the same five calls the editor's playtest makes.
// ---------------------------------------------------------------------------------------------------

function handleRequests(runtime) {
  const requests = runtime.menuRequests.splice(0);
  for (const request of requests) {
    if (request === 'quit') { quitToMenu(); return; }
    if (request === 'fullscreen') { toggleFullscreen().catch(error => showToast(error.message, true)); continue; }
    if (request === 'complete') { showToast('Campaign complete.'); continue; }
    const start = request?.type === 'start' ? request : null;
    if (start || request === 'start') {
      void startLevel(start?.levelId || game.project?.game?.entry || null);
      return;
    }
    if (request?.type === 'level') {
      const carried = request.carryProgress && runtime
        ? { playerStats: runtime.playerStats, inventory: runtime.inventory } : null;
      void startLevel(request.levelId, { progress: carried });
      return;
    }
    if (['save', 'load', 'save-file', 'load-file'].includes(request?.type)) {
      showToast('Saving inside the game menu is not part of this build yet.', true);
    }
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const engine = game.engine;
  if (!engine || !engine.preview) return;
  const dt = Math.min(.1, Math.max(0, (now - engine.last) / 1000));
  engine.last = now;
  const runtime = engine.runtime;
  try {
    const onMenu = runtime.gameScreen !== 'playing';
    const held = mappedKeys(game.keys, runtime.settings);
    const pressed = mappedKeys(game.pressed, runtime.settings);
    stepRuntime(engine.snapshot, runtime, dt, onMenu ? game.keys : held, onMenu ? game.pressed : pressed);
    game.pressed.clear();
    handleRequests(runtime);
    if (!game.engine) return;
    engine.audio?.update(runtime);
    engine.preview.render(runtime, runtime.gameScreen === 'playing' || runtime.ambientWorld ? dt : 0);
    engine.hud?.update(runtime);
    const message = $('message');
    const text = !engine.snapshot.hud && runtime.messageTime > 0 ? String(runtime.message || '') : '';
    message.textContent = text;
    message.hidden = !text;
  } catch (error) {
    showToast(`The game stopped: ${error.message}`, true);
    quitToMenu();
  }
}

// ---------------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------------

async function boot() {
  setLoading('Loading the game…');
  try {
    game.project = await loadProject();
    game.settings = loadSettings();
    game.progress = loadProgress();
    document.title = game.project.title || 'OpenDLE game';
    showMenu();
  } catch (error) {
    $('menu').hidden = false;
    $('game-title').textContent = 'The game could not start';
    $('game-subtitle').textContent = error.message;
    $('menu-buttons').replaceChildren();
    $('menu-hint').textContent = 'The exported data folder is missing or damaged. Re-export the game.';
  } finally {
    setLoading(null);
  }
}

window.addEventListener('beforeunload', () => disposeEngine());
requestAnimationFrame(frame);
boot();
