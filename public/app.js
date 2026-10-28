import { createProject, validateProject, cloneProjectForEdit, addRoom, newId, removeEntity, eventConditions, ENTITY_TYPES } from '/shared/project.js';
import { createRuntime, stepRuntime, lookPlayer, wallSegments, distanceToSegment } from '/shared/runtime.js';
import { unsupportedActorActions } from '/shared/actor-runtime.js';
import { readWad } from '/shared/wad.js';
import { sectorGeometry, sectorAt } from '/shared/sectors.js';
import { createPreview, entityColors } from './render.js';
import { bundleModel } from '/shared/gltf.js';
import { groupDroppedFiles, readDroppedFiles, IMAGE_KINDS } from './asset-drop.js';
import { createSceneEditor } from './scene-editor.js';
import { requestMouseLock } from './pointer-lock.js';
import { commandRow, openCommandDialog } from './event-sheet.js';
import { shaderTemplate } from '/shared/shaders.js';
import { recoverProject } from './project-recovery.js';
import { eventBranch, eventDepth, moveAction, moveCondition, moveEventBranch, moveEventBranchBeside,
  removeEventBranch, setEventParent, eventScope } from '/shared/events.js';
import { editInline, installRowDrag } from './row-drag.js';
import { ENGINE_CONDITIONS, ENGINE_ACTIONS, INPUT_KEYS, engineCommand, defaultEngineCommand, installEngineScripts } from '/shared/engine-script.js';
import { ENGINE_SCRIPTLETS, installScriptlet, removeScriptlet } from '/shared/scriptlets.js';
import { createHUDEditor } from './hud-editor.js';
import { createHUDView } from './hud-view.js';
import { WEAPONS } from '/shared/player-state.js';
import { readServiceResponse } from './service-response.js';
import { requestWithSession } from './service-session.js';
import { createAudioPlayer } from './audio.js';
import { encodeSound } from '/shared/sound.js';
import { importedGameplayGaps } from './gameplay-readiness.js';
import { createActorsPanel } from './actors-panel.js';
import { createScriptsPanel } from './scripts-panel.js';
import { createFrameBudget } from '/shared/perf.js';
import { LIMITS } from '/shared/limits.js';

const ARCHIVE_LIMIT = LIMITS.archiveBytes;
import { createPlaytestLogger } from './playtest-log.js';
import { createPlaytestLogPanel } from './playtest-log-panel.js';
import { installGameMenu } from '/shared/game-menu.js';
import { installDefaultHUD } from '/shared/hud.js';
import { upgradePickupReach } from '/shared/doom-hud.js';
import { suggestedArea } from '/shared/areas.js';
import { captureScene, instantiateScene, sceneIsEmpty, newScene } from '/shared/scenes.js';
import { createSceneObjectEditor } from './scene-object-editor.js';
import { contextMenu } from './context-menu.js';
import { applyNodeFile, parseNodeFile, planNodeFileInstall } from '/shared/node-file.js';
import { openAssetPicker, PICTURE_KINDS, MODEL_KINDS } from './asset-picker.js';
import { captureModelPreview } from './model-thumbnail.js';
import { RENDER_RESOLUTIONS } from '/shared/render-resolution.js';
import { installIntermission } from '/shared/intermission.js';
import { GAME_SETTINGS, gameSettings, bindKey, mappedKeys, validBinding, setGameScreen, changeSetting } from '/shared/game-settings.js';
import { statusBarHidden } from '/shared/game-view.js';
import { engineTweaks } from '/shared/engine-tweaks.js';
import { selectGameLevel } from '/shared/game-levels.js';
import { requireLicenseAgreement } from './license-agreement.js';
import { gameSaveIdentity, captureGameSave, restoreGameSave } from '/shared/save-game.js';
import * as gameSaves from './game-saves.js';
import { installSplitters } from './splitters.js';

const $ = id => document.getElementById(id);
$('asset-dock').append($('assets-panel'));
$('assets-panel').hidden = false;
let project, token, revision = 0, dirty = false, selection = null, editVersion = 0;
// The stored project this document belongs to. Null means the document has no file of
// its own yet (a new project, an import that was never stored, a restored draft), which
// is what decides whether Save updates the open project or stores a new one.
let projectId = null;
// A temporary project is the stored copy of an import: it reopens next time but the next
// import replaces it, so the badge says so instead of "Saved".
let projectTemporary = false;
const badgeText = () => dirty ? 'Unsaved' : projectTemporary ? 'Temporary' : 'Saved';
let history = [], future = [], pendingAI = null, loadedWad = null, runtime = null;
let scriptScope = '$all';
const collapsedGroups = new Set(), collapsedEvents = new Set();
const openSpriteClips = new Set();
let previewRenderer = null, previewLoading = false, mapSectors = [];
let previewGeneration = 0;
let audioPlayer = null, audioContext = null, hudWarningShown = false, musicReported = false;
let settingsRevision = -1, settingsStorageKey = '';
let hudView = null, previewProject = null, hudCursorActive = false;
let saveIdentityVersion = -1, saveIdentityPromise = null, previewSaveIdentity = '', saveBusy = false;
let lookDrag = null, draggedLook = false;
let wadImport = null;
let packageSource = null, packageInspection = null, packageBusy = false, packageController = null;
let engineVersion = '';
let sceneMode = '2d', sceneEditor = null, sceneProject = null, sceneLoading = false, scenePose = null;
// Scene objects open in their own editor, the way Godot opens a scene in a tab. The
// list of open ids is what the tab strip shows; the active one is edited below.
let sceneObjectEditor = null, openSceneIds = [], activeSceneId = null;
const camera = { x: 0, y: 0, zoom: 1 };
const keys = new Set(), pressed = new Set();
const canvas = $('map'), ctx = canvas.getContext('2d');
let drag = null, mapNeedsDraw = true;
// Panel edges are draggable and remembered per browser; the 2D map only repaints
// when it is told its drawing buffer changed size, so every resize redraws it.
const splitters = installSplitters({
  // The scene editor's own columns are fitted to the panel that holds them.
  measure: () => document.getElementById('scene-editor-body')?.clientWidth || null,
  onStart: key => {
    const dock = $('asset-dock');
    if (key !== 'assets' || !dock.classList.contains('expanded')) return;
    // Grabbing an expanded asset browser continues from its on-screen height.
    splitters.set('assets', Math.round(dock.getBoundingClientRect().height), { save: false });
    setAssetExpanded(false);
  },
  onChange: () => { mapNeedsDraw = true; },
});
// Construct-style reordering: drag a rule by its grip to change execution order,
// drop onto the middle of another rule to make it a sub-event, and drag conditions or
// actions inside a rule the same way.
installRowDrag($('event-list'), {
  onDrop: (source, target, position) => {
    if (source.kind === 'event') {
      edit(next => {
        if (position === 'inside') setEventParent(next, source.id, target.id);
        else moveEventBranchBeside(next, source.id, target.id, position);
      }, position === 'inside' ? 'Rule indented under another' : 'Rule order changed');
      return;
    }
    edit(next => {
      const event = next.events.find(item => item.id === source.id);
      if (source.kind === 'condition') moveCondition(event, source.index, target.index);
      else moveAction(event, source.index, target.index);
    }, source.kind === 'condition' ? 'Condition order changed' : 'Action order changed');
  },
  onError: error => status(error.message, true),
});
// Scanning every actor state is cheap but not free, so the report is cached until
// the actor table or the map placements change.
const actorGapCache = new WeakMap();
function actorActionGaps() {
  const actors = project.actors || [], entities = project.map?.entities || [];
  const cached = actorGapCache.get(actors);
  if (cached && cached.entities === entities) return cached.gaps;
  const gaps = unsupportedActorActions(project);
  actorGapCache.set(actors, { entities, gaps });
  return gaps;
}
const actorsPanel = createActorsPanel({
  list: $('actor-list'), summary: $('actors-summary'), gaps: $('actors-gaps'), search: $('actor-search'), filter: $('actor-filter'),
  form: $('actor-form'), title: $('actor-title'), fields: $('actor-fields'), states: $('actor-states'),
}, { actors: () => project.actors || [], edit: editActors, unsupported: actorActionGaps });
const playtestLogPanel = createPlaytestLogPanel({
  directory: $('log-directory'), totals: $('log-totals'), list: $('log-list'), detail: $('log-detail'),
  refresh: $('log-refresh'), clear: $('log-clear'),
}, {
  list: () => api('/api/playtest/logs'),
  read: session => api(`/api/playtest/logs/${encodeURIComponent(session)}`),
  clear: () => api('/api/playtest/logs', { method: 'DELETE' }),
  status: message => status(message, true),
});
const scriptsPanel = createScriptsPanel({
  list: $('script-list'), detail: $('script-detail'), summary: $('scripts-summary'),
  specials: $('script-specials'), search: $('script-search'),
}, { project: () => project });
const hudEditor = createHUDEditor($('hud-editor'), {
  project: () => project, edit, script: openHUDScript, error: message => status(message, true),
});

// Playtest failures are written to a log folder as they happen, because they are
// invisible once the tab closes. Every error path in this file funnels through
// status() or guard(), so wiring those two covers the editor; the runtime's own
// collectors are drained in the frame loop.
const playtestLog = createPlaytestLogger({
  send: ({ session, header, entries }, { keepalive } = {}) => api('/api/playtest/logs', {
    method: 'POST', body: JSON.stringify({ session, header, entries }), ...(keepalive ? { keepalive: true } : {}),
  }),
});
playtestLog.attach(window);
function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
  if (error) playtestLog.error('editor', message);
}
function guard(fn) {
  return async (...args) => {
    try { await fn(...args); }
    catch (error) { playtestLog.error('editor', error.message, { stack: error.stack }); status(error.message, true); }
  };
}
async function api(path, options = {}) {
  let response;
  try {
    const result = await requestWithSession(path, options, token);
    response = result.response; token = result.token;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error(`Cannot reach the OpenDLE local service at ${location.origin}. Start npm start and open its URL, then retry. (${error.message})`);
  }
  return readServiceResponse(response, path);
}
// A 60-70 MB imported campaign can never fit in localStorage: serializing it
// costs seconds per edit and always ends in a quota error. Above this size the
// draft backup is skipped deliberately; Save and Export remain authoritative.
function draftTooLarge() {
  return (project?.assets?.length || 0) > 300 || (project?.game?.levels?.length || 0) > 4;
}
let draftSkipNoted = false;
function persistDraft() {
  if (draftTooLarge()) {
    if (!draftSkipNoted) {
      draftSkipNoted = true;
      try { localStorage.removeItem('opendle-draft'); localStorage.removeItem('opendle-draft-metadata'); } catch { /* ignore */ }
      status('Browser draft backup is off for large projects (it cannot fit in browser storage). Use Save or Export project to keep your edits.');
    }
    return;
  }
  try {
    localStorage.setItem('opendle-draft', JSON.stringify(project));
    localStorage.setItem('opendle-draft-metadata', JSON.stringify({ baseRevision: revision, projectId }));
  }
  catch (error) { status(`Edit kept in memory, but browser backup failed: ${error.message}. Save or export now.`, true); }
}
function clearDraft() {
  pendingAI = null;
  $('apply-ai').hidden = true;
  $('discard-ai').hidden = true;
  $('ai-draft').hidden = true;
  $('ai-project').textContent = '';
}
// Rings are recomputed only when the geometry changed: clicking around the layout, or
// an edit that leaves the walls alone, re-renders without walking every sector.
let sectorGeometryCache = { project: null, walls: null, sectors: [] };
function liveSectorGeometry(target) {
  if (sectorGeometryCache.project === target && sectorGeometryCache.walls === target.map.walls &&
    sectorGeometryCache.vertices === target.map.vertices) return sectorGeometryCache.sectors;
  const sectors = sectorGeometry(target);
  sectorGeometryCache = { project: target, walls: target.map.walls, vertices: target.map.vertices, sectors };
  return sectors;
}
function render() {
  const gaps = importedGameplayGaps(project);
  $('gameplay-warning').hidden = !gaps.length;
  $('gameplay-warning-text').textContent = gaps.length
    ? `This imported project is missing ${gaps.join(', ')}. Restarting the service does not update saved projects. Reimport the WAD to install current gameplay and artwork; export custom edits first. Reimport is undoable and does not save automatically.`
    : '';
  mapSectors = liveSectorGeometry(project);
  if (!['$all', '$scene'].includes(scriptScope) && !project.map.entities.some(entity => entity.id === scriptScope) &&
    !project.eventSheets?.some(sheet => scriptScope === `$sheet:${sheet.id}`)) scriptScope = '$all';
  $('title').value = project.title;
  $('game-level-label').hidden = !project.game;
  $('game-level').replaceChildren(...(project.game?.levels || []).map(level =>
    new Option(`${level.id} — ${level.name}`, level.id, false, level.id === project.game.active)));
  const currentLevel = project.game?.levels.find(level => level.id === project.game.active);
  for (const [id, value, ending] of [['game-entry-level', project.game?.entry, false],
    ['game-next-level', currentLevel?.next, true], ['game-secret-level', currentLevel?.secretNext, true]]) {
    $(id).replaceChildren(...(ending ? [new Option('End campaign', '', false, !value)] : []),
      ...(project.game?.levels || []).map(level => new Option(`${level.id} — ${level.name}`, level.id, false, level.id === value)));
  }
  $('project-name').textContent = project.title;
  renderSceneObjects();
  // Undo, redo and edits made elsewhere change scene objects too, and the editor is
  // only re-drawn while it is the visible panel.
  if (!$('scene-panel').hidden) sceneObjectEditor?.render();
  $('dirty').textContent = badgeText();
  $('undo').disabled = history.length === 0;
  $('redo').disabled = future.length === 0;
  renderEntities();
  renderInspector();
  renderEvents();
  renderEnvironment();
  renderAssetsIfChanged();
  // The scriptlet cards report how many rules they have installed, so undo and
  // redo have to refresh them too, not only opening the tab.
  if (!$('scriptlets-panel').hidden) renderScriptlets();
  // The HUD designer rebuilds its whole stage; only do that when it is visible.
  if (!$('hud-panel').hidden) hudEditor.render();
  if (!$('actors-panel').hidden) actorsPanel.render();
  if (!$('scripts-panel').hidden) scriptsPanel.render();
  $('map-stats').textContent = `${project.map.vertices.length} vertices / ${project.map.walls.length} walls / ${project.map.entities.length} objects / ${project.map.sectors?.length || 0} sectors`;
  mapNeedsDraw = true;
  // Editing geometry in 3D must stay interactive: update the existing scene in
  // place instead of disposing the renderer and reloading every texture.
  if (sceneMode === '3d' && sceneEditor && !sceneLoading) {
    let synced = false;
    try { synced = sceneEditor.update(project); }
    catch (error) { status(`3D update failed, reloading the scene: ${error.message}`, true); }
    if (synced) { sceneProject = project; return; }
  }
  refreshScene();
}
async function refreshScene() {
  if (sceneMode !== '3d' || sceneLoading || !project) return;
  if (sceneProject === project && sceneEditor) { sceneEditor.select(selection); return; }
  sceneLoading = true; $('scene-loading').hidden = false;
  const snapshot = project;
  try {
    if (sceneEditor) scenePose = sceneEditor.pose();
    sceneEditor?.dispose(); sceneEditor = null; sceneProject = null;
    const editor = await createSceneEditor($('scene-3d'), snapshot, {
      selection: () => selection,
      select: value => {
        selection = value;
        if (value?.kind === 'sector') $('sector-surface').value = value.surface || 'floorHeight';
        renderInspector(); sceneEditor?.select(selection);
      },
      edit, error: message => status(message, true),
      live: (fn, message) => liveApply(fn, message),
      liveFinish: (message, options) => liveFinish(message, options),
      grid: () => Number($('grid').value), tool: () => $('tool').value,
      surface: () => $('sector-surface').value,
      script: openScript,
      remove: id => {
        try { edit(next => removeEntity(next, id), 'Object deleted'); } catch (error) { status(error.message, true); }
      },
      place: point => {
        try {
          const position = snap(point), type = $('entity-type').value;
          edit(next => {
            const elevation = Math.round((point.z - (sectorAt(mapSectors, position.x, position.y)?.floorHeight || 0)) / Number($('grid').value)) * Number($('grid').value);
            if (type === 'player') Object.assign(next.map.entities.find(entity => entity.type === 'player'), position, { elevation });
            else next.map.entities.push({ id: newId('entity'), type, name: `${type[0].toUpperCase()}${type.slice(1)}`, ...position, elevation, angle: 0,
              ...(type === 'light' ? { light: { color: '#ffbd72', intensity: 1, radius: 192 } } : {}) });
          }, 'Object placed in 3D');
        } catch (error) { status(error.message, true); }
      },
      room: (start, end) => {
        try {
          const a = snap({ x: start.x, y: start.z }), b = snap({ x: end.x, y: end.z });
          edit(next => addRoom(next, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), depth: Math.abs(a.y - b.y) }), 'Room added in 3D');
        } catch (error) { status(error.message, true); }
      },
      menu: (event, picked) => mapViewMenu(event, picked),
    }, scenePose);
    if (sceneMode !== '3d' || project !== snapshot) { scenePose = editor.pose(); editor.dispose(); return; }
    editor.settings(readEngineTweaks());
    sceneEditor = editor; sceneProject = snapshot;
    sceneEditor.select(selection); sceneEditor.mode($('transform-mode').value); sceneEditor.ceilings($('show-ceilings').checked);
    sceneEditor.areas($('show-areas').checked); sceneEditor.physicsOverlay($('show-physics').checked);
    status('3D scene ready. Right-drag + WASD/QE flies. Select and drag a colored axis to edit.');
  } catch (error) { status(`3D editor failed: ${error.message}`, true); }
  finally {
    sceneLoading = false; $('scene-loading').hidden = true;
    if (sceneMode === '3d' && project !== snapshot) refreshScene();
  }
}
function setSceneMode(mode) {
  sceneMode = mode;
  $('map').hidden = mode !== '2d'; $('scene-3d').hidden = mode !== '3d';
  for (const field of ['transform-field', 'ceiling-field', 'surface-field', 'area-field', 'physics-field']) $(field).hidden = mode !== '3d';
  $('view-2d').setAttribute('aria-pressed', String(mode === '2d'));
  $('view-3d').setAttribute('aria-pressed', String(mode === '3d'));
  $('scene-hint').textContent = mode === '3d'
    ? 'Right-drag: look + WASD fly / Q E down-up / Shift faster / wheel speed. Left: select or draw. Colored axes: transform; in Rotate / tilt the vertical axis pitches the model and Shift rolls it.'
    : 'Wheel: zoom / Right-drag: pan / Select wall, vertex or object to edit';
  if (mode === '2d') {
    scenePose = sceneEditor?.pose() || scenePose; sceneEditor?.dispose(); sceneEditor = null; sceneProject = null;
    $('scene-loading').hidden = true; mapNeedsDraw = true;
  }
  else refreshScene();
}
$('view-2d').addEventListener('click', () => setSceneMode('2d'));
$('view-3d').addEventListener('click', () => setSceneMode('3d'));
$('transform-mode').addEventListener('change', () => sceneEditor?.mode($('transform-mode').value));
$('show-ceilings').addEventListener('change', () => sceneEditor?.ceilings($('show-ceilings').checked));
$('show-areas').addEventListener('change', () => sceneEditor?.areas($('show-areas').checked));
$('show-physics').addEventListener('change', () => sceneEditor?.physicsOverlay($('show-physics').checked));
$('sector-surface').addEventListener('change', () => {
  if (selection?.kind === 'sector') { selection.surface = $('sector-surface').value; sceneEditor?.select(selection); }
});
function historyLimit(candidate) {
  return candidate.game ? 3 : (candidate.assets?.length || 0) ? 10 : 40;
}
/**
 * Dragging geometry must be live: the scene editor applies the move on every
 * pointer move instead of on release. A drag is one undo step, so the project
 * is snapshotted once when the drag starts and the intermediate states are
 * replaced as the pointer moves.
 */
let liveEditState = null;
function liveBegin() {
  if (liveEditState) return;
  liveEditState = { baseline: project, changed: false, wasDirty: dirty };
  history.push(project);
  future = [];
  const limit = historyLimit(project);
  while (history.length > limit) history.shift();
}
function liveApply(fn, message) {
  liveBegin();
  const next = cloneProjectForEdit(project);
  try {
    fn(next);
    validateProject(next, { fast: true });
  } catch (error) { status(error.message, true); return; }
  project = next; dirty = true; editVersion++; liveEditState.changed = true;
  renderLive(message);
}
function liveFinish(message, { revert = false } = {}) {
  const active = liveEditState; liveEditState = null;
  if (!active) { if (message) status(message); return; }
  if (revert || !active.changed) {
    if (active.changed) { project = active.baseline; dirty = active.wasDirty; editVersion++; }
    history.pop();
    render();
    status(revert ? 'Edit cancelled' : 'No change');
    return;
  }
  persistDraft();
  render();
  status(message || 'Edit applied');
}
// Panels, the asset browser and the HUD designer are skipped while dragging; the
// 3D view and the scene stats are what has to keep up with the pointer.
function renderLive(message) {
  mapSectors = liveSectorGeometry(project);
  $('dirty').textContent = 'Unsaved';
  $('undo').disabled = history.length === 0;
  $('map-stats').textContent = `${project.map.vertices.length} vertices / ${project.map.walls.length} walls / ${project.map.entities.length} objects / ${project.map.sectors?.length || 0} sectors`;
  mapNeedsDraw = true;
  if (message) status(message);
  if (sceneMode === '3d' && sceneEditor && !sceneLoading) {
    try { sceneEditor.update(project); }
    catch (error) { status(`3D update failed, reloading the scene: ${error.message}`, true); }
    return;
  }
  render();
}
function commit(next, message = 'Project updated') {
  validateProject(next, { fast: true });
  // The previous project is never mutated in place (see cloneProjectForEdit), so the
  // old reference is already a valid snapshot; cloning it again cost a second
  // full copy of large campaigns on every edit.
  history.push(project);
  const maxHistory = Math.max(historyLimit(project), historyLimit(next));
  if (history.length > maxHistory) history.shift();
  future = [];
  project = next;
  dirty = true;
  editVersion++;
  clearDraft();
  // The draft backup can report its own notice (large projects skip it), so it
  // runs before the edit message instead of replacing it.
  persistDraft();
  status(message);
  render();
}
function edit(fn, message, { deepGame = false, cloneActors = false } = {}) {
  const next = cloneProjectForEdit(project, { deepGame, shareActors: !cloneActors });
  try {
    fn(next);
    commit(next, message);
  } catch (error) {
    render();
    throw error;
  }
}
function editGame(fn, message) {
  return edit(fn, message, { deepGame: true });
}
/** Actor edits change the table itself, so they get a real copy of it. */
function editActors(fn, message) {
  return edit(fn, message, { cloneActors: true });
}
function replace(next, message) {
  validateProject(next);
  $('import-report').hidden = true;
  selection = null;
  scriptScope = '$all';
  commit(next, message);
  // The new document has no stored project until it is adopted (imports, opened files)
  // or saved, which is what keeps Save from overwriting whatever was open before.
  projectId = null;
  projectTemporary = false;
  // A replaced document has its own scenes: close the scene editor instead of showing
  // the previous project's nodes.
  openSceneIds = [];
  activeSceneId = null;
  sceneObjectEditor?.close(null);
  if (!$('scene-panel').hidden) showTab('map');
  renderSceneObjectTabs();
  fitMap();
}
/**
 * Stores the document that was just opened as the studio's project, so the next start
 * reopens it instead of whatever was saved before.
 */
async function adoptDocument() {
  const version = editVersion, submitted = project.title;
  let result;
  try {
    // Imports and opened files are stored in the temporary slot, which every later
    // import replaces and which the next start reopens; Save promotes it to a project.
    result = await api('/api/project/adopt', { method: 'POST', body: JSON.stringify({ project, title: submitted, temporary: true }) });
  } catch (error) {
    // Opening the project worked; only storing it for the next start failed (an older
    // server, or a read-only data folder). Saving later retries it.
    status(`Project opened, but it could not be stored for reopening: ${error.message}`, true);
    return;
  }
  // An edit while the document was being stored stays unsaved and unbound.
  if (version !== editVersion) return;
  projectId = result.projectId ?? null;
  projectTemporary = Boolean(result.temporary);
  revision = result.revision;
  dirty = false;
  $('dirty').textContent = badgeText();
  await refreshProjects();
}
/** Stored projects, newest first, with the open one selected in the file menu. */
async function refreshProjects() {
  const select = $('projects');
  let library;
  try { library = await api('/api/projects'); } catch { return; }
  select.textContent = '';
  if (!library.projects.length) {
    select.append(new Option('No stored projects yet', ''));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const entry of library.projects) {
      const label = `${entry.title || entry.id}${entry.temporary ? ' (temporary)' : ''}`;
    select.append(new Option(label, entry.id, false, entry.id === (projectId ?? library.active)));
  }
}
$('game-level').addEventListener('change', guard(() => {
  const id = $('game-level').value;
  editGame(next => selectGameLevel(next, id), `Editing ${id}; other level edits are retained.`);
  selection = null; scriptScope = '$all'; render(); fitMap();
}));
for (const [id, key] of [['game-next-level', 'next'], ['game-secret-level', 'secretNext'], ['game-entry-level', 'entry']])
  $(id).addEventListener('change', guard(() => {
    const value = $(id).value;
    editGame(next => {
      if (key === 'entry') next.game.entry = value;
      else next.game.levels.find(level => level.id === next.game.active)[key] = value || null;
    }, 'Campaign routing updated.');
  }));
function make(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function button(text, fn, className) {
  const element = make('button', text, className);
  element.addEventListener('click', guard(fn));
  return element;
}
function input(value, type, fn, label) {
  const element = make('input');
  element.type = type;
  element.value = value;
  if (label) element.setAttribute('aria-label', label);
  element.addEventListener('change', guard(() => fn(type === 'number' ? Number(element.value) : element.value)));
  return element;
}
// Option lists are cloned from a template instead of being rebuilt node by node: the
// event sheet creates one Owner select per rule, and cloning a prepared fragment is an
// order of magnitude cheaper than creating thousands of <option> elements.
const optionTemplates = new WeakMap();
function optionTemplate(options) {
  let template = optionTemplates.get(options);
  if (template) return template;
  template = document.createDocumentFragment();
  for (const option of options) {
    const [id, text] = Array.isArray(option) ? option : [option, option];
    const item = make('option', text);
    item.value = id;
    template.append(item);
  }
  optionTemplates.set(options, template);
  return template;
}
function select(options, value, fn, label) {
  const element = make('select');
  element.append(optionTemplate(options).cloneNode(true));
  element.value = value;
  if (label) element.setAttribute('aria-label', label);
  element.addEventListener('change', guard(() => fn(element.value)));
  return element;
}
function field(parent, text, element) {
  const label = make('label', text);
  label.append(element);
  parent.append(label);
}
function checkbox(text, value, fn) {
  const label = make('label');
  const element = make('input');
  element.type = 'checkbox';
  element.checked = value;
  element.addEventListener('change', guard(() => fn(element.checked)));
  label.append(element, document.createTextNode(text));
  return label;
}

function selectObject(entity) {
  selection = { kind: 'entity', id: entity.id };
  showTab('map');
  renderInspector();
  sceneEditor?.select(selection);
  document.querySelectorAll('[data-object-id]').forEach(element => element.classList.toggle('selected', element.dataset.objectId === entity.id));
}
function openScript(ownerId = '$all') {
  scriptScope = ownerId;
  if (!['$all', '$scene'].includes(ownerId) && !ownerId.startsWith('$sheet:')) selection = { kind: 'entity', id: ownerId };
  showTab('events');
  render();
}
let entitiesSignature = '';
function renderEntities() {
  // One pass over the rules for all owners: counting per object re-read the whole event
  // list for every entity, which is quadratic on an imported game.
  const signature = `${identityId(project.map.entities)}\u0000${identityId(project.events)}\u0000${scriptScope}`;
  if (signature !== entitiesSignature || !$('entities').childElementCount) {
    entitiesSignature = signature;
    const counts = new Map();
    for (const event of project.events) if (event.ownerId) counts.set(event.ownerId, (counts.get(event.ownerId) || 0) + 1);
    $('entities').replaceChildren();
    $('project-objects').replaceChildren();
    $('object-scripts').replaceChildren();
    for (const entity of project.map.entities) {
      const count = counts.get(entity.id) || 0;
      const tile = button('', () => selectObject(entity), 'object-tile');
      tile.setAttribute('aria-label', `${entity.name}, ${count} attached events`);
      tile.append(make('span', entity.type[0].toUpperCase(), 'object-symbol'), make('span', entity.name, 'object-name'), make('small', `${count} events`));
      const tree = button(entity.name, () => selectObject(entity), 'tree-link');
      for (const element of [tile, tree]) {
        element.dataset.objectId = entity.id;
        element.addEventListener('dblclick', () => openScript(entity.id));
      }
      $('entities').append(tile);
      $('project-objects').append(tree);
      const script = button(`${entity.name} (${count})`, () => openScript(entity.id), 'tree-link');
      script.dataset.scriptScope = entity.id;
      $('object-scripts').append(script);
    }
    $('object-scripts').append(button('+ New object script sheet', () => attachObjectScriptSheet(), 'tree-link'));
  }
  // The highlight follows every click without rebuilding the lists.
  for (const element of $('entities').children) element.classList.toggle('selected', element.dataset.objectId === selection?.id);
  for (const element of $('project-objects').children) element.classList.toggle('selected', element.dataset.objectId === selection?.id);
  for (const element of $('object-scripts').children) element.classList.toggle('selected', element.dataset.scriptScope === scriptScope);
  filterProject();
}
function attachObjectScriptSheet() {
  const entity = project.map.entities.find(item => item.id === selection?.id) ||
    project.map.entities.find(item => item.type !== 'player') || project.map.entities[0];
  if (!entity) throw new Error('Add an object before creating an object script sheet');
  edit(next => {
    const used = new Set([...next.eventSheets, ...next.eventGroups, ...next.events].map(item => item.id));
    let id = `object_${entity.id}_${next.eventSheets.length}`;
    while (used.has(id)) id += '_';
    next.eventSheets.push({ id, name: `${entity.name} script`.slice(0, 100), section: 'object', enabled: true, phase: 'afterPhysics' });
    next.eventGroups.push({ id: `${id}_group`, sheetId: id, name: `${entity.name} logic`.slice(0, 100), enabled: true });
    next.events.push({ id: `${id}_start`, name: `${entity.name} / on start`.slice(0, 100), sheetId: id, groupId: `${id}_group`,
      ownerId: entity.id, enabled: true, once: true, condition: { type: 'onStart' }, conditions: [], actions: [] });
    scriptScope = `$sheet:${id}`;
  }, `Created an editable object script sheet for ${entity.name}.`);
}
let projectFilterActive = false;
function filterProject() {
  const query = $('project-search').value.trim().toLowerCase();
  // With no search there is nothing to hide, and reading `textContent` for every object
  // and sheet on every render is what a filter that matches everything costs.
  if (!query && !projectFilterActive) return;
  projectFilterActive = Boolean(query);
  for (const parent of ['project-objects', 'object-scripts', 'engine-sheets', 'game-sheets']) {
    for (const element of $(parent).children) element.hidden = query ? !element.textContent.toLowerCase().includes(query) : false;
  }
}
function renderInspector() {
  const parent = $('inspector');
  parent.replaceChildren();
  if (!selection) {
    $('selection-kind').textContent = 'Layout';
    parent.append(make('h2', 'Layout 1'), make('p', `${project.map.entities.length} objects / ${project.map.walls.length} walls`, 'muted'),
      button('Open scene events', () => openScript('$scene')),
      button('Environment & variables', () => showTab('environment')));
    if (project.importSource) parent.append(make('p', `Native UDMF import (${project.importSource.namespace}). Original map properties are retained as source provenance. Script execution and advanced map behavior are still incomplete.`, 'info'));
    return;
  }
  const collection = { entity: 'entities', vertex: 'vertices', wall: 'walls', sector: 'sectors' }[selection.kind];
  const item = project.map[collection]?.find(value => value.id === selection.id);
  if (!item) { selection = null; renderInspector(); return; }
  $('selection-kind').textContent = selection.kind;
  const update = (key, value) => edit(next => { next.map[collection].find(value => value.id === item.id)[key] = value; });
  parent.append(make('h2', `${selection.kind[0].toUpperCase()}${selection.kind.slice(1)}`), make('p', item.id, 'muted'));
  if (project.importSource) {
    const types = { entity: ['thing', /^thing(\d+)$/], vertex: ['vertex', /^v(\d+)$/],
      wall: ['linedef', /^w(\d+)$/], sector: ['sector', /^sector(\d+)$/] };
    const [type, pattern] = types[selection.kind], match = pattern.exec(item.id);
    const original = match && project.importSource.blocks.filter(block => block.type === type)[Number(match[1])];
    if (original) {
      const details = make('details');
      details.append(make('summary', 'Original UDMF properties (import snapshot)'),
        make('p', 'Read-only provenance, not live behavior. Edit the native properties below; unsupported source fields are retained for compatibility work.', 'muted'),
        make('pre', JSON.stringify(original.properties, null, 2)));
      parent.append(details);
    }
  }
  if (selection.kind === 'sector') {
    field(parent, 'Floor height', input(item.floorHeight, 'number', value => update('floorHeight', value)));
    field(parent, 'Ceiling height', input(item.ceilingHeight, 'number', value => update('ceilingHeight', value)));
    field(parent, 'Floor material', assetSelect(item.floorAsset, value => update('floorAsset', value), ['flat', 'texture']));
    field(parent, 'Ceiling material', assetSelect(item.ceilingAsset, value => update('ceilingAsset', value), ['flat', 'texture']));
    // Texture scale is pixels-per-unit: 2 draws the artwork twice as large on the
    // floor and ceiling, 0.5 twice as fine, with no separate texture needed.
    field(parent, 'Texture scale (floors/ceilings)', input(item.textureScale ?? 1, 'number', value => update('textureScale', value)));
    field(parent, 'Light level (0-255)', input(item.light, 'number', value => update('light', value)));
    parent.append(checkbox('Sky ceiling', item.sky, value => update('sky', value)),
      make('p', 'Closed or inverted heights are retained for static Doom doors. Movement needs 56 units of clearance; upward steps are limited to 24 units.', 'muted'));
  } else if (selection.kind === 'wall') {
    field(parent, 'Color', input(item.color, 'color', value => update('color', value)));
    field(parent, 'Height', input(item.height, 'number', value => update('height', value)));
    parent.append(checkbox('Blocks player', item.solid, value => update('solid', value)));
    if (!item.right && !item.left) field(parent, 'Wall material', assetSelect(item.assetId, value => update('assetId', value), ['texture', 'flat']));
    for (const key of ['right', 'left']) {
      if (!item[key]) continue;
      const part = make('div', undefined, 'property-section');
      part.append(make('strong', `${key === 'right' ? 'Front' : 'Back'} side / ${item[key].sectorId}`));
      const changeSide = (property, value) => edit(next => { next.map.walls.find(wall => wall.id === item.id)[key][property] = value; });
      for (const [property, name] of [['middle', 'Middle texture'], ['upper', 'Upper texture'], ['lower', 'Lower texture']]) {
        field(part, name, assetSelect(item[key][property], value => changeSide(property, value), ['texture', 'flat']));
      }
      field(part, 'X texture offset', input(item[key].offsetX, 'number', value => changeSide('offsetX', value)));
      field(part, 'Y texture offset', input(item[key].offsetY, 'number', value => changeSide('offsetY', value)));
      field(part, 'Texture scale', input(item[key].textureScale ?? 1, 'number', value => changeSide('textureScale', value)));
      part.append(button('Edit sector', () => { selection = { kind: 'sector', id: item[key].sectorId }; render(); }));
      parent.append(part);
    }
    parent.append(make('p', 'Sector walls use floor/ceiling heights, sidedef materials and portal openings. Blocking is independent of material visibility.', 'muted'));
  } else {
    if (selection.kind === 'entity') field(parent, 'Name', input(item.name, 'text', value => update('name', value)));
    const grid = make('div', undefined, 'field-grid');
    field(grid, 'X', input(item.x, 'number', value => update('x', value)));
    field(grid, 'Y', input(item.y, 'number', value => update('y', value)));
    parent.append(grid);
    if (selection.kind === 'entity') {
      field(parent, 'Angle (degrees)', input(item.angle, 'number', value => update('angle', value)));
      field(parent, 'Elevation above sector floor', input(item.elevation || 0, 'number', value => update('elevation', value)));
      parent.append(make('h3', 'Object-local variables'));
      renderVariables(parent, item.variables || {}, variables => update('variables', variables));
      if (item.type === 'enemy') field(parent, 'Initial health', input(item.health ?? 20, 'number', value => update('health', value)));
      if (item.type !== 'player') {
        if (item.doomType !== undefined) field(parent, 'Doom thing type', input(item.doomType, 'number', value => update('doomType', value)));
        field(parent, 'Sprite image', assetSelect(item.spriteAsset, value => update('spriteAsset', value), ['sprite']));
        field(parent, 'Sprite scale', input(item.spriteScale || 1, 'number', value => update('spriteScale', value)));
        if (project.spriteClips?.length) for (const name of ['stand', 'walk', 'attack', 'pain', 'death']) {
          field(parent, `Sprite / ${name}`, select([['', 'No animation'], ...project.spriteClips.map(clip => [clip.id, clip.name])],
            item.spriteStates?.[name] || '', value => {
              const states = { ...item.spriteStates };
              if (value) states[name] = value; else delete states[name];
              update('spriteStates', states);
            }));
        }
        field(parent, '3D model', assetSelect(item.modelAsset, value => edit(next => {
          const entity = next.map.entities.find(entity => entity.id === item.id);
          entity.modelAsset = value; delete entity.animation;
        }), ['model']));
        if (item.modelAsset) {
          field(parent, 'Model scale (map units / glTF unit)', input(item.modelScale ?? 32, 'number', value => update('modelScale', value)));
          // Yaw is the object's own facing; pitch and roll stand the model up, on its
          // side (roll 90) or on its head (pitch 180) without turning the object.
          const tilt = item.modelTilt || { pitch: 0, roll: 0 };
          const changeTilt = (key, value) => edit(next => {
            const entity = next.map.entities.find(entity => entity.id === item.id);
            const updated = { ...tilt, [key]: value };
            if (!updated.pitch && !updated.roll) delete entity.modelTilt; else entity.modelTilt = updated;
          });
          field(parent, 'Model pitch (deg)', input(tilt.pitch || 0, 'number', value => changeTilt('pitch', value)));
          field(parent, 'Model roll (deg)', input(tilt.roll || 0, 'number', value => changeTilt('roll', value)));
          const clips = project.assets.find(asset => asset.id === item.modelAsset).animations;
          if (clips.length) {
            const animation = item.animation || { clip: clips[0], speed: 1, loop: true, autoPlay: false };
            const changeAnimation = (key, value) => update('animation', { ...animation, [key]: value });
            field(parent, 'Animation clip', select(clips, animation.clip, value => changeAnimation('clip', value)));
            field(parent, 'Playback speed', input(animation.speed, 'number', value => changeAnimation('speed', value)));
            parent.append(checkbox('Auto-play animation', animation.autoPlay, value => changeAnimation('autoPlay', value)),
              checkbox('Loop animation', animation.loop, value => changeAnimation('loop', value)));
          }
        }
        const physics = { body: 'none', shape: 'box', width: 24, height: 32, depth: 24, radius: 12, mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true, ...item.physics };
        const changePhysics = (key, value) => {
          const config = { ...physics, [key]: value };
          if (config.shape === 'ball') config.height = config.radius * 2;
          update('physics', config);
        };
        parent.append(make('h2', 'Rapier physics'));
        field(parent, 'Rigid body', select(['none', 'fixed', 'dynamic', 'kinematic'], physics.body, value => changePhysics('body', value)));
        if (physics.body !== 'none') {
          field(parent, 'Collider', select(['box', 'ball', 'capsule'], physics.shape, value => changePhysics('shape', value)));
          for (const key of physics.shape === 'box' ? ['width', 'height', 'depth'] : physics.shape === 'ball' ? ['radius'] : ['radius', 'height']) {
            field(parent, `Collider ${key}`, input(physics[key], 'number', value => changePhysics(key, value)));
          }
          for (const key of ['mass', 'friction', 'restitution']) field(parent, key, input(physics[key], 'number', value => changePhysics(key, value)));
          parent.append(checkbox('Sensor / trigger (no blocking)', physics.sensor, value => changePhysics('sensor', value)),
            checkbox('Lock body rotation', physics.lockRotation, value => changePhysics('lockRotation', value)),
            make('p', 'Colliders use primitive shapes, not the model mesh. Positions are map units; 64 units = 1 metre.', 'muted'));
        }
        const area = item.area;
        const changeArea = (key, value) => {
          const config = { ...suggestedArea(item), ...area, [key]: value };
          if (config.shape === 'sphere') config.height = config.radius * 2;
          update('area', config);
        };
        parent.append(make('h2', 'Interaction area'));
        field(parent, 'Shape', select([['', 'None'], ['box', 'Box'], ['sphere', 'Sphere'], ['capsule', 'Capsule']], area?.shape || '', value => {
          if (!value) { edit(next => { delete next.map.entities.find(entity => entity.id === item.id).area; }, 'Interaction area removed'); return; }
          const next = { ...suggestedArea(item), ...area, shape: value };
          if (value === 'sphere') next.height = next.radius * 2;
          update('area', next);
        }));
        if (area?.shape) {
          const keys = area.shape === 'box' ? ['width', 'height', 'depth'] : area.shape === 'sphere' ? ['radius'] : ['radius', 'height'];
          for (const key of keys) field(parent, `${key[0].toUpperCase()}${key.slice(1)}`, input(area[key], 'number', value => changeArea(key, value)));
          parent.append(make('p', 'Volume above the floor, using the collider shapes. A Player: inside this object interaction area condition is true while the player stands in it; Player: entered this object interaction area fires once per entry.', 'muted'));
        }
      } else {
        parent.append(make('p', project.playerControl === 'events'
          ? 'Rapier capsule: radius 12, height 56. Movement and mouse look come from editable Engine / Input rules. Jumping is off in the starter; add a jumpPlayer action to enable it.'
          : 'Rapier capsule: radius 12, height 56; gravity, 24-unit steps. Space jumps. WASD moves; arrows turn.', 'muted'));
      }
      if (item.type === 'light') {
        const light = item.light || { color: '#ffbd72', intensity: 1, radius: 192 };
        const changeLight = (key, value) => update('light', { ...light, [key]: value });
        field(parent, 'Light color', input(light.color, 'color', value => changeLight('color', value)));
        field(parent, 'Light intensity (0-10)', input(light.intensity, 'number', value => changeLight('intensity', value)));
        field(parent, 'Light radius', input(light.radius, 'number', value => changeLight('radius', value)));
        if (!item.light) parent.append(button('Enable point light', () => update('light', light)));
      }
      const scripts = make('div', undefined, 'property-section');
      const count = project.events.filter(event => event.ownerId === item.id).length;
      scripts.append(make('strong', 'Visual script'), make('p', `${count} attached events`, 'muted'),
        button('Edit object script', () => openScript(item.id)),
        make('p', 'Use "This object" in conditions and actions. Scripts belong to this instance, not every object of its type.', 'muted'));
      parent.append(scripts);
      if (item.type !== 'player') {
        field(parent, 'Type', select(ENTITY_TYPES.filter(type => type !== 'player'), item.type, value => update('type', value)));
        parent.append(button('Delete object', () => {
          if (count && !confirm(`Delete ${item.name} and its ${count} attached events? You can undo this change.`)) return;
          edit(next => removeEntity(next, item.id), 'Object deleted');
          selection = null;
          render();
        }, 'danger'));
      }
    }
  }
}
/**
 * Image assets a creator can pick for an action (sprays, decals, artwork): every asset
 * that is a picture, named so the list reads like the asset library.
 */
function imageAssetOptions() {
  return (project?.assets || []).filter(asset => !['sound', 'music', 'model', 'font'].includes(asset.kind))
    .map(asset => [asset.id, `${asset.name} (${asset.kind} ${asset.width}x${asset.height})`]);
}
function readEngineTweaks() {
  const stored = localStorage.getItem('opendle-engine-tweaks');
  if (stored === null) return engineTweaks();
  try { return engineTweaks(JSON.parse(stored)); }
  // A value from an older build (or a hand-edited one) must not break every tab that
  // reads a tweak: fall back to the defaults and let the next save rewrite it.
  catch { return engineTweaks(); }
}
function saveEngineTweaks(changes) {
  const tweaks = engineTweaks({ ...readEngineTweaks(), ...changes });
  localStorage.setItem('opendle-engine-tweaks', JSON.stringify(tweaks));
  if (runtime) { Object.assign(runtime.settings, tweaks); runtime.settingsRevision++; }
  sceneEditor?.settings(tweaks);
  $('engine-tweaks-status').textContent = 'Saved for all projects in this browser.';
}
$('engine-jumping').addEventListener('change', guard(() => {
  saveEngineTweaks({ jumping: $('engine-jumping').checked });
}));
function renderEngineTweaks() {
  const tweaks = readEngineTweaks();
  $('engine-jumping').checked = tweaks.jumping;
  const fields = $('engine-setting-fields'); fields.replaceChildren();
  for (const [key, label] of [['masterVolume', 'Overall sound level (0 = silent, 1 = full)'], ['muted', 'Mute preview audio'],
    ['renderResolution', 'Render resolution'], ['fov', 'Field of view'], ['resolution', 'Render scale'], ['brightness', 'Brightness'],
    ['bunnyhop', 'Simulated bunnyhop (speed gain while chaining jumps)'], ['bunnyhopGain', 'Bunnyhop speed gain per chained jump']]) {
    const wrapper = make('label', label), spec = GAME_SETTINGS[key];
    if (spec.options) {
      const select = document.createElement('select');
      for (const entry of RENDER_RESOLUTIONS) {
        const option = document.createElement('option');
        option.value = entry.value; option.textContent = entry.label;
        select.append(option);
      }
      select.value = tweaks[key];
      select.addEventListener('change', guard(() => saveEngineTweaks({ [key]: select.value })));
      wrapper.append(select);
    } else {
      const input = document.createElement('input');
      input.type = typeof spec.value === 'boolean' ? 'checkbox' : 'number'; input.setAttribute('aria-label', label);
      if (input.type === 'checkbox') input.checked = tweaks[key];
      else { input.min = spec.min; input.max = spec.max; input.step = spec.step; input.value = tweaks[key]; }
      input.addEventListener('change', guard(() => saveEngineTweaks({ [key]: input.type === 'checkbox' ? input.checked : Number(input.value) })));
      wrapper.append(input);
    }
    fields.append(wrapper);
  }
}
$('engine-tweaks-reset').addEventListener('click', guard(() => {
  const tweaks = engineTweaks();
  localStorage.setItem('opendle-engine-tweaks', JSON.stringify(tweaks));
  if (runtime) { Object.assign(runtime.settings, tweaks); runtime.settingsRevision++; }
  sceneEditor?.settings(tweaks);
  renderEngineTweaks(); $('engine-tweaks-status').textContent = 'Engine tweaks reset.';
}));
/** Reads the engine version once and caches it for the About tab and log headers. */
function loadEngineVersion() {
  if (engineVersion) { $('engine-version').textContent = `OpenDLE: Studio version: ${engineVersion}`; return Promise.resolve(engineVersion); }
  return api('/api/health').then(info => {
    engineVersion = String(info.version || '');
    $('engine-version').textContent = `OpenDLE: Studio version: ${engineVersion}`;
    return engineVersion;
  }).catch(error => {
    $('engine-version').textContent = `Version unavailable: ${error.message}`;
    throw error;
  });
}
// Engine scriptlets: generators that install editable rules. The panel is built from
// the shared registry, so adding another generator is one entry there plus nothing here.
function renderScriptlets() {
  const list = $('scriptlet-list');
  list.replaceChildren();
  for (const scriptlet of ENGINE_SCRIPTLETS) {
    const installed = scriptlet.installed(project);
    const card = make('div', undefined, 'scriptlet-card');
    card.append(make('h2', scriptlet.name),
      make('p', scriptlet.summary),
      make('p', scriptlet.detail, 'muted'),
      make('p', installed ? `Installed: ${installed} rules in their own engine sheet.` : 'Not installed in this project.', installed ? 'scriptlet-state' : 'scriptlet-state muted'));
    const install = button(installed ? 'Reinstall (replaces its rules)' : 'Add to project', () => {
      let sheetId;
      edit(next => { sheetId = installScriptlet(next, scriptlet.id); },
        `${scriptlet.name} scriptlet ${installed ? 'reinstalled' : 'installed'} — its rules are editable in the event sheets`);
      renderScriptlets();
      openScript(`$sheet:${sheetId}`);
    });
    card.append(install);
    if (installed) card.append(button('Remove its rules', () => {
      if (!confirm(`Remove the ${scriptlet.name} scriptlet and its ${installed} rules? Undo restores them.`)) return;
      edit(next => removeScriptlet(next, scriptlet.id), `${scriptlet.name} scriptlet removed`);
      renderScriptlets();
    }, 'danger'));
    list.append(card);
  }
  if (!ENGINE_SCRIPTLETS.length) list.append(make('p', 'No scriptlets are available in this build.', 'muted'));
}

function showTab(tab) {
  if (tab !== 'hud') hudEditor.stopPreview();
  if (tab === 'assets') {
    setAssetExpanded(true); $('asset-search').focus(); return;
  }
  for (const name of ['map', 'events', 'environment', 'hud', 'actors', 'scripts', 'logs', 'tweaks', 'scriptlets', 'about', 'scene'])
    $(name + '-panel').hidden = tab !== name;
  // The designer is only refreshed while its tab is visible, so opening the tab
  // has to build it once.
  if (tab === 'hud') hudEditor.render();
  if (tab === 'scene') { sceneObjectEditor?.render(); /* the scene editor's columns are fitted to the panel, so measure it now that it is visible */ splitters.refresh(); }
  if (tab === 'actors') actorsPanel.render();
  if (tab === 'scripts') scriptsPanel.render();
  if (tab === 'logs') playtestLogPanel.render();
  if (tab === 'scriptlets') renderScriptlets();
  if (tab === 'tweaks') {
    try { renderEngineTweaks(); }
    catch (error) { $('engine-tweaks-status').textContent = error.message; status(error.message, true); }
  }
  document.querySelectorAll('[data-tab]').forEach(element => element.classList.toggle('active', element.dataset.tab === tab));
  if (tab === 'about') {
    $('engine-version').textContent = 'Loading OpenDLE: Studio version...';
    void loadEngineVersion().catch(error => status(`Could not read engine version: ${error.message}`, true));
    const cacheStatus = $('import-cache-status');
    const renderCache = async () => {
      try {
        const info = await api('/api/import-cache');
        cacheStatus.textContent = info.enabled
          ? `Decompiled import cache: ${info.entries} saved import(s), ${(info.bytes / 1048576).toFixed(1)} MiB, ${info.hits} cache hit(s). Repeating an import loads the finished native project instead of converting again.`
          : 'Decompiled import cache: disabled for this server.';
      } catch (error) { cacheStatus.textContent = `Decompiled import cache unavailable: ${error.message}`; }
    };
    void renderCache();
    $('import-cache-clear').onclick = guard(async () => {
      await api('/api/import-cache', { method: 'DELETE' });
      $('import-cache-status').textContent = 'Decompiled import cache cleared. The next import of each game will convert again.';
    });
  }
  mapNeedsDraw = true;
}
function setAssetExpanded(expanded) {
  $('asset-dock').classList.toggle('expanded', expanded);
  $('expand-assets').textContent = expanded ? 'Restore' : 'Expand';
  $('expand-assets').setAttribute('aria-expanded', String(expanded));
  mapNeedsDraw = true;
}
$('expand-assets').addEventListener('click', () => setAssetExpanded(!$('asset-dock').classList.contains('expanded')));
$('project-search').addEventListener('input', filterProject);
$('world-layer').addEventListener('click', () => { selection = null; showTab('map'); renderInspector(); mapNeedsDraw = true; });
function closeMenu() {
  $('file-menu').hidden = true; $('menu-toggle').setAttribute('aria-expanded', 'false');
}
$('menu-toggle').addEventListener('click', () => {
  $('file-menu').hidden = !$('file-menu').hidden;
  $('menu-toggle').setAttribute('aria-expanded', String(!$('file-menu').hidden));
});
$('file-menu').addEventListener('click', event => { if (event.target.closest('button')) closeMenu(); });
document.addEventListener('click', event => {
  if (!event.target.closest('#file-menu, #menu-toggle')) closeMenu();
});
document.addEventListener('keydown', event => { if (event.code === 'Escape' && !$('file-menu').hidden) { closeMenu(); $('menu-toggle').focus(); } });

// Rebuilt once per project, not once per rule: the event sheet asks for the object list
// for every card (Owner, target and condition fields), and each rebuild allocated a
// fresh array of pairs for all objects.
let entityOptionCache = { entities: null, all: [], withoutPlayer: [] };
function entityOptionLists() {
  if (entityOptionCache.entities !== project.map.entities) {
    const all = [], withoutPlayer = [];
    for (const entity of project.map.entities) {
      const pair = [entity.id, entity.name];
      all.push(pair);
      if (entity.type !== 'player') withoutPlayer.push(pair);
    }
    entityOptionCache = { entities: project.map.entities, all, withoutPlayer };
  }
  return entityOptionCache;
}
function entityOptions(excludePlayer = false, ownerId) {
  const list = entityOptionLists();
  // A `$self` entry makes the array specific to the owner, so it is built on demand and
  // only for the few cards that need it.
  if (ownerId) {
    const owner = project.map.entities.find(entity => entity.id === ownerId);
    if (owner && (!excludePlayer || owner.type !== 'player')) return [['$self', `This object (${owner.name})`], ...(excludePlayer ? list.withoutPlayer : list.all)];
    if (ownerId.startsWith('$type:')) return [['$self', `Each ${ownerId.slice(6)}`], ...(excludePlayer ? list.withoutPlayer : list.all)];
  }
  return excludePlayer ? list.withoutPlayer : list.all;
}
/** Sheet options for the scope picker and the per-rule Sheet field. */
let sheetOptionCache = { sheets: null, options: [] };
function sheetOptions() {
  if (sheetOptionCache.sheets !== project.eventSheets) {
    sheetOptionCache = { sheets: project.eventSheets,
      options: (project.eventSheets || []).map(sheet => [`$sheet:${sheet.id}`, `${sheet.section} / ${sheet.name}`]) };
  }
  return sheetOptionCache.options;
}
function scriptContext(event) { return event.ownerId || (event.forEachType ? `$type:${event.forEachType}` : undefined); }
function healthTarget(context) {
  if (context?.startsWith('$type:')) return '$self';
  const entity = scriptObject(context, entity => entity.type !== 'player', 'Create a non-player object first');
  return entity.id === context ? '$self' : entity.id;
}
function defaultHUDTarget(command) {
  const definition = engineCommand(command.type);
  if (definition.hudElement) {
    command.elementId = project.hud?.elements.find(element => command.type !== 'hudClicked' || element.interactive)?.id;
    if (!command.elementId) throw new Error('Create a suitable HUD element in the HUD designer first');
  }
  if (definition.hudAnimation) {
    command.animationId = project.hud?.animations[0]?.id;
    if (!command.animationId) throw new Error('Create a HUD animation first');
  }
}
function openHUDScript(elementId) {
  let sheet = project.eventSheets?.find(sheet => sheet.name === 'HUD');
  const element = project.hud?.elements.find(element => element.id === elementId);
  const existing = element && project.events.find(event =>
    eventConditions(event).some(condition => condition.elementId === elementId) || event.actions.some(action => action.elementId === elementId));
  if (existing) { openScript(existing.sheetId ? `$sheet:${existing.sheetId}` : '$scene'); return; }
  if (!sheet || element) edit(next => {
    if (!sheet) {
      sheet = { id: newId('sheet'), name: 'HUD', section: 'game', phase: 'afterPhysics', enabled: true };
      (next.eventSheets ||= []).push(sheet);
    }
    if (element) next.events.push({ id: newId('event'), name: `${element.name} script`, sheetId: sheet.id, enabled: true, once: false,
      condition: element.interactive ? { type: 'hudClicked', elementId } : { type: 'onStart' }, actions: [] });
  }, 'HUD visual script opened');
  openScript(`$sheet:${sheet.id}`);
}
function defaultCondition(type, ownerId) {
  if (engineCommand(type)) {
    const command = defaultEngineCommand(type);
    defaultHUDTarget(command);
    defaultWorldTarget(command);
    if (engineCommand(type).group) {
      command.groupId = project.eventGroups?.[0]?.id;
      if (!command.groupId) throw new Error('Add an event group first');
    }
    if (engineCommand(type).target && !['setObjectVariable', 'addObjectVariable', 'objectVariableCompare'].includes(type)) command.entityId = healthTarget(ownerId);
    defaultObjectVariable(command, ownerId);
    defaultShaderTarget(command);
    if (engineCommand(type).variable) {
      command.variable = Object.keys(project.variables)[0];
      if (!command.variable) throw new Error('Create a numeric variable first');
    }
    return command;
  }
  if (type === 'keyPressed') return { type, key: 'KeyE' };
  if (type === 'nearEntity') return { type, entityId: ownerId ? '$self' : project.map.entities[0].id, distance: 48 };
  if (['collisionStarted', 'collisionEnded', 'isTouching'].includes(type)) {
    const entity = project.map.entities.find(entity => entity.id === ownerId && (entity.type === 'player' || entity.physics?.body && entity.physics.body !== 'none'))
      || project.map.entities.find(entity => entity.type === 'player');
    return { type, entityId: entity.id === ownerId ? '$self' : entity.id, otherId: '$world' };
  }
  if (type === 'animationFinished') {
    const entity = scriptObject(ownerId, entity => entity.modelAsset, 'Assign a model to an object first');
    return { type, entityId: entity.id === ownerId ? '$self' : entity.id };
  }
  return { type };
}
function scriptObject(ownerId, predicate, message) {
  const entity = project.map.entities.find(entity => entity.id === ownerId && predicate(entity)) || project.map.entities.find(predicate);
  if (!entity) throw new Error(message);
  return entity;
}
function defaultAction(type, ownerId) {
  if (engineCommand(type)) {
    const command = defaultEngineCommand(type);
    defaultHUDTarget(command);
    defaultWorldTarget(command);
    if (engineCommand(type).group) {
      command.groupId = project.eventGroups?.[0]?.id;
      if (!command.groupId) throw new Error('Add an event group first');
    }
    if (engineCommand(type).target && !['setObjectVariable', 'addObjectVariable', 'objectVariableCompare'].includes(type)) command.entityId = healthTarget(ownerId);
    defaultObjectVariable(command, ownerId);
    defaultShaderTarget(command);
    return command;
  }
  if (type === 'showMessage') return { type, message: 'Hello from OpenDLE!' };
  if (type === 'teleport') return { type, x: 0, y: 0 };
  if (type === 'setEntityPosition') return { type, entityId: ownerId ? '$self' : project.map.entities[0].id, x: 0, y: 0 };
  if (type === 'rotateEntity') return { type, entityId: ownerId ? '$self' : project.map.entities[0].id, angle: 0 };
  if (['applyImpulse', 'applyForce', 'setVelocity'].includes(type)) {
    const entity = scriptObject(ownerId, entity => entity.physics?.body === 'dynamic', 'Enable a dynamic rigid body on an object first');
    return { type, entityId: entity.id === ownerId ? '$self' : entity.id, x: 0, y: 0, z: 1 };
  }
  if (['playAnimation', 'stopAnimation'].includes(type)) {
    const entity = scriptObject(ownerId, entity => entity.modelAsset && (type === 'stopAnimation' || project.assets.find(asset => asset.id === entity.modelAsset).animations.length), 'Import and assign a model with animation clips first');
    const result = { type, entityId: entity.id === ownerId ? '$self' : entity.id };
    if (type === 'playAnimation') Object.assign(result, { clip: project.assets.find(asset => asset.id === entity.modelAsset).animations[0], speed: 1, loop: true });
    return result;
  }
  if (type === 'removeEntity') {
    if (ownerId?.startsWith('$type:')) return { type, entityId: '$self' };
    const owner = project.map.entities.find(entity => entity.id === ownerId);
    if (owner && owner.type !== 'player') return { type, entityId: '$self' };
    const entity = project.map.entities.find(entity => entity.type !== 'player');
    if (!entity) throw new Error('Place a non-player entity before using Remove entity');
    return { type, entityId: entity.id };
  }
  const variable = Object.keys(project.variables).find(name => type !== 'addVariable' || typeof project.variables[name] === 'number');
  if (!variable) throw new Error(type === 'addVariable' ? 'Create a numeric variable first' : 'Create a variable first');
  return { type, variable, value: type === 'addVariable' ? 1 : project.variables[variable] };
}
function defaultWorldTarget(command) {
  const definition = engineCommand(command.type);
  if (definition.wall) {
    command.wallId = project.map.walls[0]?.id;
    if (!command.wallId) throw new Error('Add a wall first');
  }
  if (definition.sector) {
    command.sectorId = project.map.sectors?.[0]?.id;
    if (!command.sectorId) throw new Error('Add a sector first');
  }
  if (definition.spriteClip) {
    command.clipId = project.spriteClips?.[0]?.id;
    if (!command.clipId) throw new Error('Import sprite animation frames first');
  }
}
function defaultObjectVariable(command, context) {
  if (!['setObjectVariable', 'addObjectVariable', 'objectVariableCompare'].includes(command.type)) return;
  const candidates = context?.startsWith('$type:') ? project.map.entities.filter(e => e.type === context.slice(6))
    : context ? project.map.entities.filter(e => e.id === context) : project.map.entities;
  const entity = candidates.find(e => Object.keys(e.variables || {}).some(name =>
    command.type !== 'addObjectVariable' || typeof e.variables[name] === 'number'));
  if (!entity) throw new Error('Add an object-local variable in Object Properties first');
  const name = Object.keys(entity.variables).find(name => (command.type !== 'addObjectVariable' || typeof entity.variables[name] === 'number') &&
    (!context?.startsWith('$type:') || candidates.every(e => Object.hasOwn(e.variables || {}, name) && typeof e.variables[name] === typeof entity.variables[name])));
  if (!name) throw new Error('Each selected object type needs a matching local variable');
  command.entityId = context ? '$self' : entity.id;
  command.variable = name; command.value = command.type === 'addObjectVariable' ? 1 : entity.variables[name];
}
function defaultShaderTarget(command) {
  if (command.type !== 'setShaderUniform') return;
  const shader = project.shaders?.find(shader => shader.id === project.environment.shaderId);
  command.uniform = Object.keys(shader?.uniforms || {})[0];
  if (!command.uniform) throw new Error('Select a shader with a numeric uniform in Environment first');
  command.value = shader.uniforms[command.uniform];
}
const conditionLabels = [['onStart', 'On start of layout'], ['always', 'Every tick'], ['keyPressed', 'On key pressed'], ['nearEntity', 'Player is near object'],
  ['collisionStarted', 'Physics: contact / trigger entered'], ['collisionEnded', 'Physics: contact / trigger exited'],
  ['isTouching', 'Physics: touching / overlapping'], ['playerGrounded', 'Player is grounded'], ['animationFinished', 'Model: animation finished'],
  ...ENGINE_CONDITIONS.map(command => [command.type, command.label])];
const actionLabels = [['showMessage', 'System: show message'], ['setVariable', 'System: set variable'], ['addVariable', 'System: add to variable'],
  ['teleport', 'Player: teleport'], ['removeEntity', 'Object: destroy'], ['setEntityPosition', 'Object: set position'], ['rotateEntity', 'Object: set angle'],
  ['applyImpulse', 'Physics: apply impulse'], ['applyForce', 'Physics: apply force'], ['setVelocity', 'Physics: set velocity'],
  ['playAnimation', 'Model: play animation'], ['stopAnimation', 'Model: stop animation'],
  ...ENGINE_ACTIONS.map(command => [command.type, command.label])];
let eventsRendered = '';
function eventsSignature() {
  // The rules and sheets are compared by *content*, not identity: every edit clones the
  // project, and rebuilding several hundred rule cards because a wall moved (or the
  // project was renamed) is what made an imported game feel sluggish. Serialising the
  // rule list costs a couple of milliseconds; rebuilding the cards costs more than a
  // second. Everything else is small enough to compare directly.
  return [scriptScope, project.playerControl, JSON.stringify(project.events),
    JSON.stringify(project.eventSheets || []), JSON.stringify(project.eventGroups || []),
    Object.keys(project.variables).length, assetListSignature(),
    JSON.stringify(project.map.entities.map(entity => [entity.id, entity.name, entity.type])),
    project.map.walls.length, (project.map.sectors || []).length,
    JSON.stringify(project.spriteClips || []), JSON.stringify(project.hud?.elements?.map(element => [element.id, element.name]) || []),
    (project.hud?.animations || []).length,
    collapsedEvents.size, collapsedGroups.size, [...collapsedEvents].join(','), [...collapsedGroups].join(',')].join('\u0000');
}
// Grip element for drag-reordering. The row it sits in carries data-drag-*, so the
// installer can tell a rule from a condition without knowing the DOM structure.
function grip() {
  const element = make('span', '⋮⋮', 'drag-grip');
  element.dataset.dragGrip = '';
  element.setAttribute('aria-hidden', 'true');
  element.title = 'Drag to reorder';
  return element;
}

// Per-render lookups for the rule list: sibling order for the Up/Down buttons and the
// option lists for the Sheet and Group fields. Each used to be a full scan of every
// rule for every card, which is quadratic on an imported game.
let ruleRenderCache = null;
function ruleRenderCacheFor() {
  if (ruleRenderCache && ruleRenderCache.events === project.events && ruleRenderCache.groups === project.eventGroups &&
    ruleRenderCache.sheets === project.eventSheets) return ruleRenderCache;
  const siblings = new Map(), groupLists = new Map(), unfiled = [['', 'Unfiled / scene'],
    ...(project.eventSheets || []).map(sheet => [sheet.id, `${sheet.section} / ${sheet.name}`])];
  const lists = new Map();
  for (const sheet of project.eventSheets || []) lists.set(sheet.id, [['', 'Ungrouped']]);
  for (const group of project.eventGroups || []) lists.get(group.sheetId)?.push([group.id, group.name]);
  for (const event of project.events) {
    const key = `${event.parentId || ''}\u0000${event.sheetId || ''}\u0000${event.groupId || ''}`;
    let list = siblings.get(key);
    if (!list) siblings.set(key, list = []);
    list.push(event);
  }
  ruleRenderCache = { events: project.events, groups: project.eventGroups, sheets: project.eventSheets, siblings, lists, unfiled };
  return ruleRenderCache;
}
function siblingRules(event) {
  return ruleRenderCacheFor().siblings.get(`${event.parentId || ''}\u0000${event.sheetId || ''}\u0000${event.groupId || ''}`) || [event];
}
function unfiledSheetOptions() { return ruleRenderCacheFor().unfiled; }
function groupOptions(sheetId) { return ruleRenderCacheFor().lists.get(sheetId) || [['', 'Ungrouped']]; }
function renderEvents() {
  const parent = $('event-list');
  // A large imported game carries hundreds of event rules; rebuilding every
  // card for a geometry drag is the slowest part of an edit.
  const signature = eventsSignature();
  if (signature === eventsRendered && parent.childElementCount) return;
  eventsRendered = signature;
  ruleRenderCache = null;
  parent.replaceChildren();
  const owner = project.map.entities.find(entity => entity.id === scriptScope);
  const currentSheet = project.eventSheets?.find(sheet => scriptScope === `$sheet:${sheet.id}`);
  $('sheet-title').textContent = owner ? `${owner.name} - Visual script` : scriptScope === '$scene' ? 'Scene events' : 'Event sheet 1';
  $('events-tab').textContent = owner ? `${owner.name} events` : 'Event sheet 1';
  $('sheet-description').textContent = owner ? `Attached to ${owner.type} instance ${owner.id}. "This object" refers to this instance.` : 'Scene and object rules share one top-to-bottom execution order.';
  if (currentSheet) {
    $('sheet-title').textContent = `${currentSheet.section === 'engine' ? 'Engine' : 'Game'} / ${currentSheet.name}`;
    $('events-tab').textContent = `${currentSheet.name} events`;
    $('sheet-description').textContent = 'Editable event rules, not hidden built-in behavior. Engine rules run for the whole game; object rules are local to one object instance or object type. Before-physics rules run first.';
  }
  for (const section of ['engine', 'game']) {
    const tree = $(`${section}-sheets`); tree.replaceChildren();
    for (const sheet of project.eventSheets || []) {
      if (sheet.section !== section) continue;
      const count = project.events.filter(event => event.sheetId === sheet.id).length;
      const link = button(`${sheet.name} (${count})${sheet.enabled ? '' : ' [disabled]'}`, () => openScript(`$sheet:${sheet.id}`), 'tree-link');
      link.classList.toggle('selected', sheet === currentSheet); tree.append(link);
    }
  }
  $('install-engine').hidden = project.playerControl === 'events' || project.eventSheets?.some(sheet => sheet.section === 'engine');
  const properties = $('sheet-properties'); properties.replaceChildren();
  if (currentSheet) {
    const update = (key, value) => edit(next => { next.eventSheets.find(sheet => sheet.id === currentSheet.id)[key] = value; });
    field(properties, 'Name', input(currentSheet.name, 'text', value => update('name', value)));
    field(properties, 'Section', select(['engine', 'game', 'object'], currentSheet.section, value => update('section', value)));
    field(properties, 'Phase', select(['beforePhysics', 'afterPhysics', 'interface'], currentSheet.phase, value => update('phase', value)));
    properties.append(checkbox('Sheet enabled', currentSheet.enabled, value => update('enabled', value)),
      button('Delete sheet and rules', () => {
        if (!confirm(`Delete ${currentSheet.name} and its rules? Undo restores them.`)) return;
        edit(next => {
          next.events = next.events.filter(event => event.sheetId !== currentSheet.id);
          next.eventSheets = next.eventSheets.filter(sheet => sheet.id !== currentSheet.id);
          const removed = new Set((next.eventGroups || []).filter(group => group.sheetId === currentSheet.id).map(group => group.id));
          if (next.events.some(event => [...eventConditions(event), ...event.actions].some(command => removed.has(command.groupId)))) {
            throw new Error('This sheet contains groups referenced by other rules. Remove those references first.');
          }
          next.eventGroups = (next.eventGroups || []).filter(group => !removed.has(group.id));
        }, 'Event sheet deleted');
      }, 'danger'));
  }
  $('script-scope').replaceChildren(...[['$all', 'All events'], ['$scene', 'Scene only'],
    ...sheetOptions(), ...entityOptions()].map(([id, name]) => {
    const option = make('option', name); option.value = id; return option;
  }));
  $('script-scope').value = scriptScope;
  const matchesScope = event => scriptScope === '$all' || (currentSheet ? event.sheetId === currentSheet.id :
    scriptScope === '$scene' ? event.ownerId === undefined && !event.forEachType && !event.sheetId : event.ownerId === scriptScope);
  const count = project.events.filter(matchesScope).length;
  $('script-count').textContent = `${count} events`;
  if (!count) parent.append(make('p', owner ? 'No script attached yet. Add an event to this object.' : 'No events in this sheet. Add a condition and an action.', 'muted'));
  project.events.forEach((event, index) => {
    if (!matchesScope(event)) return;
    const card = make('div', undefined, 'event-card');
    card.dataset.eventId = event.id;
    // Dragging a rule moves it (with its sub-events) in execution order.
    card.dataset.dragRow = 'event'; card.dataset.dragId = event.id; card.dataset.dragKind = 'event';
    const modify = fn => edit(next => fn(next.events[index]));
    const context = scriptContext(event);
    const meta = make('details', undefined, 'event-meta');
    const summary = make('summary');
    summary.append(grip());
    summary.append(make('span', `${String(index + 1).padStart(2, '0')}  ${eventScope(event) === 'object' ? 'Object' : 'Game'}${event.once ? ' · Once' : ''}${event.enabled ? '' : ' · Disabled'}`));
    meta.append(summary);
    field(meta, 'Rule name', input(event.name || event.id, 'text', value => modify(item => { item.name = value; })));
    field(meta, 'Sheet', select(unfiledSheetOptions(),
      event.sheetId || '', value => edit(next => {
        if (event.parentId) throw new Error('Move the parent event to change a sub-event sheet');
        const ids = eventBranch(next.events, event.id);
        for (const item of next.events.filter(item => ids.has(item.id))) {
          if (value) item.sheetId = value; else delete item.sheetId;
          delete item.groupId;
        }
      })));
    field(meta, 'Group', select(groupOptions(event.sheetId),
      event.groupId || '', value => edit(next => {
        if (event.parentId) throw new Error('Move the parent event to change its group');
        const ids = eventBranch(next.events, event.id);
        for (const item of next.events.filter(item => ids.has(item.id))) {
          if (value) item.groupId = value; else delete item.groupId;
        }
      })));
    field(meta, 'Comment', input(event.comment || '', 'text', value => modify(item => { item.comment = value; })));
    field(meta, 'Condition logic', select([['and', 'All conditions (AND)'], ['or', 'Any condition (OR)']], event.conditionMode || 'and',
      value => modify(item => { item.conditionMode = value; })));
    field(meta, 'For each', select([['', 'None'], 'enemy', 'pickup', 'decoration'], event.forEachType || '', value => modify(item => {
      if (value) { item.forEachType = value; delete item.ownerId; } else delete item.forEachType;
    })));
    field(meta, 'Owner', select([['$scene', 'System / scene'], ...entityOptions()], event.ownerId || '$scene', value => modify(item => {
      if (value === '$scene') delete item.ownerId;
      else { item.ownerId = value; delete item.forEachType; }
    }), 'Event owner'));
    if (event.ownerId) meta.classList.add('event-owner-object');
    meta.append(
      checkbox('Enabled', event.enabled, value => modify(item => { item.enabled = value; })),
      checkbox('Once', event.once, value => modify(item => { item.once = value; })));
    const controls = make('div', undefined, 'event-controls');
    const siblings = siblingRules(event);
    for (const [label, direction] of [['Up', -1], ['Down', 1]]) {
      const target = siblings[siblings.indexOf(event) + direction];
      const move = button(label, () => edit(next => moveEventBranch(next, event.id, direction)));
      move.disabled = !target;
      controls.append(move);
    }
    controls.append(button('Delete branch', () => edit(next => removeEventBranch(next, event.id)), 'danger'));
    controls.append(button('+ Sub-event', () => addScriptEvent(event)));
    controls.append(button('Collapse children', () => {
      if (collapsedEvents.has(event.id)) collapsedEvents.delete(event.id); else collapsedEvents.add(event.id);
      renderEvents();
    }));
    meta.append(controls);
    const conditions = make('div', undefined, 'event-conditions');
    conditions.dataset.dragList = `${event.id}:condition`;
    eventConditions(event).forEach((condition, conditionIndex) => {
      const row = commandRow(condition, conditionLabels, objectName, () => editCommand('condition', condition, value => modify(item => {
        if (conditionIndex === 0) item.condition = value; else item.conditions[conditionIndex - 1] = value;
      }), eventConditions(event).length > 1 ? () => modify(item => {
        if (conditionIndex === 0) item.condition = item.conditions.shift(); else item.conditions.splice(conditionIndex - 1, 1);
      }) : undefined), { inverted: condition.inverted, or: event.conditionMode === 'or' && conditionIndex > 0 });
      row.prepend(grip());
      row.dataset.dragRow = 'condition'; row.dataset.dragId = event.id;
      row.dataset.dragKind = 'condition'; row.dataset.dragIndex = String(conditionIndex);
      conditions.append(row);
    });
    conditions.append(button('+ Add condition', () => editCommand('condition', undefined, value => modify(item => {
      item.conditions ||= []; item.conditions.push(value);
    })), 'add-script-command'));
    const actions = make('div', undefined, 'event-actions');
    actions.dataset.dragList = `${event.id}:action`;
    event.actions.forEach((action, actionIndex) => {
      const row = commandRow(action, actionLabels, objectName, () => editCommand('action', action,
        value => modify(item => { item.actions[actionIndex] = value; }),
        () => modify(item => { item.actions.splice(actionIndex, 1); }), direction => modify(item => {
          const target = actionIndex + direction;
          if (target < 0 || target >= item.actions.length) throw new Error('No adjacent action');
          [item.actions[actionIndex], item.actions[target]] = [item.actions[target], item.actions[actionIndex]];
        })));
      row.prepend(grip());
      row.dataset.dragRow = 'action'; row.dataset.dragId = event.id;
      row.dataset.dragKind = 'action'; row.dataset.dragIndex = String(actionIndex);
      actions.append(row);
    });
    actions.append(button('+ Add action', () => editCommand('action', undefined, value => modify(item => { item.actions.push(value); })), 'add-script-command'));
    function objectName(id) {
      return id === '$self' ? (event.forEachType ? `Each ${event.forEachType}` : project.map.entities.find(entity => entity.id === event.ownerId)?.name || 'This object')
        : id === '$world' ? 'World' : project.map.entities.find(entity => entity.id === id)?.name || id;
    }
    function editCommand(kind, command, submit, remove, move) {
      const version = editVersion;
      openCommandDialog({ kind, command, submit: value => {
        if (version !== editVersion) throw new Error('Project changed while this dialog was open. Cancel and reopen it.');
        submit(value);
      }, remove, move, labels: kind === 'condition' ? conditionLabels : actionLabels,
        defaults: type => (kind === 'condition' ? defaultCondition : defaultAction)(type, context),
        entities: entityOptions(false, context), variables: Object.keys(project.variables),
        playerId: project.map.entities.find(entity => entity.type === 'player').id,
        groups: (project.eventGroups || []).map(group => [group.id, group.name]),
        walls: project.map.walls.map(wall => [wall.id, `${wall.id} / special ${wall.special || 0}`]),
        sectors: (project.map.sectors || []).map(sector => [sector.id, sector.id]),
        spriteClips: (project.spriteClips || []).map(clip => [clip.id, clip.name]),
        images: imageAssetOptions(),
        hudElements: (project.hud?.elements || []).map(element => [element.id, element.name]),
        hudAnimations: (project.hud?.animations || []).map(clip => [clip.id, clip.name]),
        clips: id => {
          const entity = project.map.entities.find(entity => id === '$self'
            ? event.forEachType ? entity.type === event.forEachType : entity.id === event.ownerId : entity.id === id);
          return project.assets?.find(asset => asset.id === entity?.modelAsset)?.animations || [];
        },
      });
    }
    card.append(meta, conditions, actions);
    const depth = eventDepth(project.events, event);
    card.style.marginLeft = `${depth * 22}px`;
    card.classList.toggle('disabled', !event.enabled);
    let ancestor = event;
    while (ancestor.parentId) {
      if (collapsedEvents.has(ancestor.parentId)) card.hidden = true;
      ancestor = project.events.find(item => item.id === ancestor.parentId);
    }
    if (event.comment || event.name) {
      const comment = make('p', event.comment || event.name.replaceAll('_', ' '), 'event-comment');
      comment.dataset.eventId = event.id;
      comment.title = 'Click to edit this comment';
      comment.hidden = card.hidden; comment.style.marginLeft = `${depth * 22 + 32}px`;
      comment.addEventListener('click', () => {
        // Start from the text that is on screen: a rule without a comment shows its
        // name, so editing it writes a real comment instead of an empty box.
        const field = editInline(comment, { value: event.comment || event.name?.replaceAll('_', ' ') || '', multiline: true,
          onCommit: text => edit(next => {
            const target = next.events.find(item => item.id === event.id);
            if (text) target.comment = text; else delete target.comment;
          }, 'Rule comment changed'),
          onCancel: () => renderEvents() });
        field.addEventListener('blur', () => { if (!field.isConnected) renderEvents(); }, { once: true });
      });
      parent.append(comment);
    }
    parent.append(card);
  });
  renderEventGroups(parent, currentSheet, matchesScope);
}
function addScriptEvent(parentEvent) {
  const template = { id: newId('event'), enabled: true, once: false, actions: [] };
  if (parentEvent) {
    for (const key of ['sheetId', 'groupId', 'ownerId', 'forEachType']) if (parentEvent[key] !== undefined) template[key] = parentEvent[key];
    template.parentId = parentEvent.id;
  } else if (scriptScope.startsWith('$sheet:')) template.sheetId = scriptScope.slice(7);
  else if (!['$all', '$scene'].includes(scriptScope)) template.ownerId = scriptScope;
  const context = scriptContext(template), version = editVersion;
  openCommandDialog({
    kind: 'condition', labels: conditionLabels, defaults: type => defaultCondition(type, context),
    entities: entityOptions(false, context), variables: Object.keys(project.variables),
    playerId: project.map.entities.find(entity => entity.type === 'player').id,
    groups: (project.eventGroups || []).map(group => [group.id, group.name]), clips: () => [],
    walls: project.map.walls.map(wall => [wall.id, `${wall.id} / special ${wall.special || 0}`]),
    sectors: (project.map.sectors || []).map(sector => [sector.id, sector.id]),
    spriteClips: (project.spriteClips || []).map(clip => [clip.id, clip.name]),
    images: imageAssetOptions(),
    hudElements: (project.hud?.elements || []).map(element => [element.id, element.name]),
    hudAnimations: (project.hud?.animations || []).map(clip => [clip.id, clip.name]),
    submit: condition => {
      if (version !== editVersion) throw new Error('Project changed. Cancel and reopen the dialog.');
      edit(next => {
        const event = { ...template, condition };
        if (parentEvent) {
          const ids = eventBranch(next.events, parentEvent.id);
          next.events.splice(next.events.findLastIndex(item => ids.has(item.id)) + 1, 0, event);
          collapsedEvents.delete(parentEvent.id);
        } else next.events.push(event);
      }, parentEvent ? 'Sub-event added' : 'Event added');
    },
  });
}
function renderEventGroups(parent, currentSheet, matchesScope) {
  const nodes = [...parent.children], seen = new Set();
  parent.replaceChildren();
  let activeId, content = parent;
  function header(group) {
    seen.add(group.id);
    const section = make('section', undefined, 'script-group');
    const bar = make('div', undefined, 'script-group-heading'), body = make('div', undefined, 'script-group-body');
    const toggle = button(`${collapsedGroups.has(group.id) ? '+' : '-'}  ${group.name}`, () => {
      if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id); else collapsedGroups.add(group.id);
      renderEvents();
    });
    toggle.setAttribute('aria-expanded', String(!collapsedGroups.has(group.id)));
    body.hidden = collapsedGroups.has(group.id);
    bar.append(toggle, checkbox('Active', group.enabled, value => edit(next => {
      next.eventGroups.find(item => item.id === group.id).enabled = value;
    })), button('Edit group', () => editEventGroup(group)));
    section.classList.toggle('disabled', !group.enabled);
    section.append(bar);
    if (group.description) section.append(make('p', group.description, 'event-comment'));
    section.append(body); parent.append(section);
    return body;
  }
  for (const node of nodes) {
    const eventId = node.dataset.eventId || node.nextElementSibling?.dataset.eventId;
    const event = project.events.find(event => event.id === eventId);
    if (event?.groupId !== activeId) {
      activeId = event?.groupId;
      content = activeId ? header(project.eventGroups.find(group => group.id === activeId)) : parent;
    }
    content.append(node);
  }
  for (const group of project.eventGroups || []) {
    if (seen.has(group.id)) continue;
    if (currentSheet ? group.sheetId === currentSheet.id : scriptScope === '$all' ||
      project.events.some(event => event.groupId === group.id && matchesScope(event))) header(group);
  }
}
function editEventGroup(group) {
  const dialog = make('dialog'); dialog.className = 'command-dialog'; dialog.setAttribute('aria-label', 'Edit event group');
  let name = group.name, description = group.description || '';
  dialog.append(make('h2', 'Edit event group'));
  field(dialog, 'Name', input(name, 'text', value => { name = value; }));
  field(dialog, 'Description', input(description, 'text', value => { description = value; }));
  const error = make('p', '', 'error'); error.setAttribute('role', 'alert');
  const apply = fn => {
    try { fn(); dialog.close(); } catch (failure) { error.textContent = failure.message; }
  };
  dialog.append(error, button('Done', () => apply(() => edit(next => {
    Object.assign(next.eventGroups.find(item => item.id === group.id), { name, description });
  }))), button('Cancel', () => dialog.close()), button('Delete group, keep events', () => apply(() => edit(next => {
    if (next.events.some(event => [...eventConditions(event), ...event.actions].some(command => command.groupId === group.id))) {
      throw new Error('Group is referenced by event commands. Remove those references first.');
    }
    next.eventGroups = next.eventGroups.filter(item => item.id !== group.id);
    for (const event of next.events) if (event.groupId === group.id) delete event.groupId;
  })), 'danger'));
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
}
// Rebuilding a panel is the expensive part of an edit (hundreds of nodes, asset
// pickers with thousands of options), so panels rebuild only when the data they
// show actually changed.
const panelSignatures = new Map();
function panelUnchanged(name, signature, element) {
  if (panelSignatures.get(name) === signature && element.childElementCount) return true;
  panelSignatures.set(name, signature);
  return false;
}
// Comparing a signature against the last render is how the editor avoids rebuilding
// thousands of DOM nodes for an unrelated edit. Serializing the whole project to do it
// (the events list alone is hundreds of kilobytes in an imported game) cost more than
// the render it was guarding, so signatures use object identity instead: every edit
// clones the project, so a new array or object *is* a change.
const identityIds = new WeakMap();
let identityIdCounter = 0;
function identityId(value) {
  if (value === null || typeof value !== 'object') return String(value);
  let id = identityIds.get(value);
  if (id === undefined) identityIds.set(value, id = ++identityIdCounter);
  return id;
}
let assetSignatureCache = { assets: null, length: -1, signature: '' };
function assetListSignature() {
  const assets = project.assets || [];
  if (assetSignatureCache.assets === assets && assetSignatureCache.length === assets.length) return assetSignatureCache.signature;
  const signature = assets.map(asset => `${asset.id}:${asset.kind}:${asset.name}:${asset.format || ''}` +
    `:${asset.meshes || 0}:${asset.animations?.length || 0}:${asset.generated ? 1 : 0}`).join('|');
  assetSignatureCache = { assets, length: assets.length, signature };
  return signature;
}
function renderEnvironment() {
  const parent = $('environment-form');
  if (panelUnchanged('environment', JSON.stringify([project.environment, project.variables, project.shaders, assetListSignature()]), parent)) return;
  parent.replaceChildren();
  parent.append(make('h2', 'Renderer and GLSL effects'), make('p',
    'WebGPU is preferred when available; WebGL2 is the explicit fallback. Browsers do not expose native Vulkan. The preview reports its actual API. GLSL effects run on both backends using the portable effect function below.', 'muted'));
  field(parent, 'World shader', select([['', 'No effect'], ...(project.shaders || []).map(shader => [shader.id, shader.name])],
    project.environment.shaderId || '', value => edit(next => {
      if (value) next.environment.shaderId = value; else delete next.environment.shaderId;
    })));
  for (const shader of project.shaders || []) {
    const details = make('details'); details.append(make('summary', `${shader.name} / GLSL`));
    field(details, 'Name', input(shader.name, 'text', value => edit(next => { next.shaders.find(item => item.id === shader.id).name = value; })));
    const source = make('textarea'); source.rows = 10; source.value = shader.source;
    source.setAttribute('aria-label', `${shader.name} GLSL source`);
    field(details, 'GLSL effect source', source);
    details.append(button('Apply GLSL source', () => edit(next => { next.shaders.find(item => item.id === shader.id).source = source.value; })));
    for (const [name, value] of Object.entries(shader.uniforms || {})) {
      field(details, `Uniform ${name}`, input(value, 'number', value => edit(next => {
        next.shaders.find(item => item.id === shader.id).uniforms[name] = value;
      })));
    }
    const uniformName = input('', 'text', () => {}, 'New shader uniform name');
    details.append(uniformName, button('Add numeric uniform', () => edit(next => {
      const item = next.shaders.find(item => item.id === shader.id); item.uniforms ||= {};
      if (Object.hasOwn(item.uniforms, uniformName.value)) throw new Error('That uniform already exists');
      Object.defineProperty(item.uniforms, uniformName.value, { value: 1, enumerable: true, writable: true, configurable: true });
    })), button('Delete shader', () => edit(next => { next.shaders = next.shaders.filter(item => item.id !== shader.id); })));
    parent.append(details);
  }
  parent.append(button('Add GLSL effect', () => edit(next => {
    next.shaders ||= [];
    const id = newId('shader');
    next.shaders.push({ id, name: 'World effect', language: 'glsl', source: shaderTemplate, uniforms: { strength: 1 } });
    next.environment.shaderId ||= id;
  })), make('p', 'Effect signature: vec4 effect(vec4 color, vec2 uv, float time). Uniform names are numeric parameters declared by the engine, not source declarations. Set uniforms and toggle the effect with visual-script shader commands. This portable GLSL subset is not an unrestricted vertex/fragment pipeline.', 'muted'));
  for (const key of ['sky', 'floor']) field(parent, key === 'sky' ? 'Sky color' : 'Floor color',
    input(project.environment[key], 'color', value => edit(next => { next.environment[key] = value; })));
  field(parent, 'Sky panorama', assetSelect(project.environment.skyAsset, value => edit(next => {
    next.environment.skyAsset = value; delete next.environment.skybox;
  }), ['sky']));
  field(parent, 'Sky projection', select([['doom', 'Doom sky (90-degree horizontal repeat)'], ['panorama', '360-degree panorama']],
    project.environment.skyMode || 'panorama', value => edit(next => { next.environment.skyMode = value; })));
  field(parent, 'Weapon overlay', assetSelect(project.environment.weaponAsset, value => edit(next => { next.environment.weaponAsset = value; }), ['weapon']));
  if (project.environment.weaponAssets) for (const weapon of WEAPONS) {
    field(parent, `${weapon} overlay`, assetSelect(project.environment.weaponAssets[weapon], value => edit(next => {
      next.environment.weaponAssets[weapon] = value;
    }), ['weapon']));
  }
  const cube = make('details');
  cube.append(make('summary', 'Six-face skybox'));
  const faces = {}, grid = make('div', undefined, 'skybox-grid');
  for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
    faces[face] = assetSelect(project.environment.skybox?.[face], () => {}, ['sky']);
    field(grid, face, faces[face]);
  }
  cube.append(grid, button('Apply six-face skybox', () => edit(next => {
    const skybox = Object.fromEntries(Object.entries(faces).map(([face, element]) => [face, element.value || null]));
    if (Object.values(skybox).some(value => !value)) throw new Error('Choose an image for all six skybox faces');
    next.environment.skybox = skybox;
  })), button('Use panorama / solid sky instead', () => edit(next => { delete next.environment.skybox; })));
  parent.append(cube, make('p', 'Sky is visible through sky-enabled ceilings and outside geometry. Sector lights multiply materials; point lights add colored illumination without shadows (maximum 16). Weapon images are visual overlays; separate hitscan event actions implement prototype firing and damage.', 'muted'));
  parent.append(make('h2', 'Global variables'));
  renderVariables(parent, project.variables, variables => edit(next => { next.variables = variables; }));
}

function renderVariables(parent, variables, change) {
  for (const [key, value] of Object.entries(variables)) {
    const row = make('div', undefined, 'variable-row');
    const type = typeof value;
    row.append(make('span', key), select(['number', 'string', 'boolean'], type, type => {
      change({ ...variables, [key]: type === 'number' ? 0 : type === 'boolean' ? false : '' });
    }), type === 'boolean' ? select([['true', 'True'], ['false', 'False']], String(value), value => change({ ...variables, [key]: value === 'true' }))
      : input(value, type === 'number' ? 'number' : 'text', value => change({ ...variables, [key]: value }), `${key} initial value`),
      button('Delete', () => { const next = { ...variables }; delete next[key]; change(next); }));
    parent.append(row);
  }

  const row = make('div', undefined, 'variable-row');
  const name = input('', 'text', () => {}, 'New variable name');
  name.placeholder = 'Variable name';
  row.append(name, button('+ Variable', () => {
    if (Object.hasOwn(variables, name.value)) throw new Error('That variable already exists');
    const next = { ...variables };
    Object.defineProperty(next, name.value, { value: 0, enumerable: true, writable: true, configurable: true });
    change(next);
  }));
  parent.append(row, make('p', 'Number, text and boolean values reset on Play. Object variables are per instance. Expressions use global("name"), local("name") for the event owner, or object("id","name"). Referenced variables cannot be deleted.', 'muted'));
}

function assetSelect(value, fn, kinds) {
  return select([['', 'None / fallback'], ...(project.assets || []).filter(asset => kinds.includes(asset.kind)).map(asset => [asset.id, asset.name])],
    value || '', value => fn(value || null));
}
let assetsRendered = '';
// Thumbnails for models imported before previews existed: captured once per session.
const modelPreviews = new Map(), modelPreviewPending = new Set();
function scheduleModelPreview(asset) {
  if (modelPreviewPending.has(asset.id) || modelPreviews.has(asset.id)) return;
  modelPreviewPending.add(asset.id);
  captureModelPreview(asset).then(preview => {
    modelPreviewPending.delete(asset.id);
    if (!preview) return;
    modelPreviews.set(asset.id, preview);
    if ($('asset-list').childElementCount) renderAssets();
  }).catch(() => modelPreviewPending.delete(asset.id));
}
function modelPreview(asset) {
  return asset.preview || modelPreviews.get(asset.id) || null;
}
function assetsSignature() {
  return `${$('asset-filter').value}\0${$('asset-search').value}\0${assetListSignature()}\0${JSON.stringify(project.spriteClips || [])}`;
}
function renderAssetsIfChanged() {
  // Re-rendering thousands of tiles (with <audio> data URIs) on every geometry
  // drag is what made editing feel slow; rebuild only when the list changed.
  if (assetsSignature() === assetsRendered && $('asset-list').childElementCount) return;
  renderAssets();
}
function renderAssets() {
  const parent = $('asset-list');
  parent.replaceChildren();
  const filter = $('asset-filter').value, search = $('asset-search').value.toLowerCase();
  $('asset-folders').replaceChildren(...[...$('asset-filter').options].map(option => {
    const count = option.value === 'scene' ? (project.scenes || []).length
      : (project.assets || []).filter(asset => option.value === 'all' || asset.kind === option.value).length;
    const folder = button(`${option.textContent} (${count})`, () => { $('asset-filter').value = option.value; renderAssets(); }, 'asset-folder');
    folder.dataset.filter = option.value;
    folder.classList.toggle('selected', option.value === filter);
    return folder;
  }));
  const assets = filter === 'scene' ? [] : (project.assets || []).filter(asset => (filter === 'all' || asset.kind === filter) && asset.name.toLowerCase().includes(search));
  if (filter === 'scene') {
    for (const scene of project.scenes || []) {
      const tile = make('div', undefined, 'asset-tile');
      tile.dataset.sceneId = scene.id;
      tile.append(make('strong', 'Scene'), make('strong', scene.name),
        make('small', `${scene.entities.length} objects / ${(scene.events || []).length} events`),
        button('Place at view', () => placeScene(scene.id)),
        button('Delete', () => edit(next => { next.scenes = next.scenes.filter(item => item.id !== scene.id); }, `Scene ${scene.name} deleted`)));
      parent.append(tile);
    }
    if (!(project.scenes || []).length) parent.append(make('p', 'No scenes yet. Select an object or a sector, then capture it as a scene.', 'muted'));
  }
  for (const asset of assets) {
    const tile = make('div', undefined, 'asset-tile'), image = make('img');
    // The id makes drag and drop and the context menu exact instead of inferring which
    // asset a tile shows from its position in the filtered list.
    tile.dataset.assetId = asset.id;
    if (asset.kind === 'music') {
      tile.append(make('strong', '♪'), make('strong', asset.name), make('small', `${asset.format.toUpperCase()} score / plays as level music`),
        button('Set as level music', () => edit(next => {
          next.environment = { ...next.environment, music: asset.name, musicAsset: asset.id };
        }, `Level music set to ${asset.name}.`)));
    } else if (asset.kind === 'sound') {
      const audio = document.createElement('audio');
      audio.controls = true; audio.preload = 'none'; audio.src = asset.src;
      audio.style.width = '100%';
      audio.addEventListener('error', () => status(`Cannot decode sound ${asset.name}`, true));
      tile.append(make('strong', asset.name), make('small', asset.generated ? 'Generated fallback sound' : 'Imported sound'), audio);
    } else if (asset.kind === 'font') {
      tile.append(make('strong', 'Aa'), make('strong', asset.name), make('small', 'Embedded web font / assign in HUD'));
    } else if (asset.kind === 'model') {
      const preview = modelPreview(asset);
      if (preview) { image.src = preview; image.alt = asset.name; image.loading = 'lazy'; tile.append(image); }
      else { tile.append(make('strong', '3D')); scheduleModelPreview(asset); }
      tile.append(make('strong', asset.name), make('small', `${asset.format} / ${asset.meshes} meshes / ${asset.skins} skins / ${asset.animations.length} clips`));
      tile.append(button('Assign to selected object', () => {
        if (selection?.kind !== 'entity') throw new Error('Select an object in the layout first');
        edit(next => {
          const entity = next.map.entities.find(entity => entity.id === selection.id);
          if (entity.type === 'player') throw new Error('Assign world models to a non-player object');
          entity.modelAsset = asset.id; delete entity.animation;
        });
      }));
    } else {
      image.src = asset.src; image.alt = asset.name; image.loading = 'lazy';
      tile.append(image, make('strong', asset.name), make('small', `${asset.kind} / ${asset.width}x${asset.height}`));
    }
    if (asset.kind === 'weapon') tile.append(button('Use weapon overlay', () => edit(next => { next.environment.weaponAsset = asset.id; })));
    if (asset.kind === 'sky') tile.append(button('Use sky panorama', () => edit(next => {
      next.environment.skyAsset = asset.id; next.environment.skyMode = 'panorama'; delete next.environment.skybox;
    })));
    parent.append(tile);
  }
  if (!assets.length) parent.append(make('p', 'No matching assets. Import a WAD or ordinary images to get started.', 'muted'));
  $('sector-list').replaceChildren(...(project.map.sectors || []).map(sector => button(`${sector.id} / light ${sector.light}`, () => {
    selection = { kind: 'sector', id: sector.id }; renderInspector(); mapNeedsDraw = true;
  })));
  const animationList = $('sprite-animation-list'); animationList.replaceChildren();
  for (const clip of project.spriteClips || []) {
    const details = make('details'), summary = make('summary', `${clip.name} / ${clip.frames.length} frames`);
    details.append(summary);
    details.open = openSpriteClips.has(clip.id);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) openSpriteClips.add(clip.id); else openSpriteClips.delete(clip.id);
      if (!details.open || details.dataset.ready) return;
      details.dataset.ready = 'true';
      const change = (key, value) => edit(next => { next.spriteClips.find(item => item.id === clip.id)[key] = value; });
      field(details, 'Name', input(clip.name, 'text', value => change('name', value)));
      field(details, 'Seconds per frame', input(clip.seconds, 'number', value => change('seconds', value)));
      details.append(checkbox('Loop', clip.loop, value => change('loop', value)));
      clip.frames.forEach((id, index) => {
        const row = make('div', undefined, 'field-grid');
        field(row, `Frame ${index + 1}`, assetSelect(id, value => {
          if (!value) throw new Error('Each animation frame needs an image');
          const frames = [...clip.frames]; frames[index] = value; change('frames', frames);
        }, ['sprite', 'weapon', 'texture', 'flat']));
        if (clip.frames.length > 1) row.append(button('Remove frame', () => change('frames', clip.frames.filter((_, i) => i !== index))));
        details.append(row);
      });
      details.append(button('Add frame', () => change('frames', [...clip.frames, clip.frames.at(-1)])));
    });
    animationList.append(details);
  }
  assetsRendered = assetsSignature();
}

function resizeMap() {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; mapNeedsDraw = true; }
  return { width: rect.width, height: rect.height, ratio };
}
function worldPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left - rect.width / 2) / camera.zoom + camera.x,
    y: (event.clientY - rect.top - rect.height / 2) / camera.zoom + camera.y };
}
function snap(point) {
  const grid = Number($('grid').value);
  return { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid };
}
function fitMap() {
  if (sceneMode === '3d') { sceneEditor?.fit(); return; }
  const vertices = project.map.vertices;
  const xs = vertices.map(vertex => vertex.x), ys = vertices.map(vertex => vertex.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const rect = canvas.getBoundingClientRect();
  camera.x = (minX + maxX) / 2; camera.y = (minY + maxY) / 2;
  camera.zoom = Math.max(.02, Math.min(3, (rect.width - 90) / Math.max(64, maxX - minX), (rect.height - 90) / Math.max(64, maxY - minY)));
  mapNeedsDraw = true;
}
function drawMap() {
  const { width, height, ratio } = resizeMap();
  if (!width || !height) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);
  for (const sector of mapSectors) {
    ctx.beginPath();
    for (const ring of sector.rings) {
      ring.forEach((vertex, index) => index ? ctx.lineTo(vertex.x, vertex.y) : ctx.moveTo(vertex.x, vertex.y));
      ctx.closePath();
    }
    ctx.fillStyle = selection?.id === sector.id ? '#4179aa70' : `rgba(150,170,195,${sector.light / 255 * .07})`;
    ctx.fill('evenodd');
  }
  const left = camera.x - width / 2 / camera.zoom, top = camera.y - height / 2 / camera.zoom;
  let grid = Number($('grid').value);
  while (grid * camera.zoom < 16) grid *= 2;
  ctx.strokeStyle = '#656565'; ctx.lineWidth = 1 / camera.zoom; ctx.beginPath();
  for (let x = Math.floor(left / grid) * grid; x < left + width / camera.zoom; x += grid) { ctx.moveTo(x, top); ctx.lineTo(x, top + height / camera.zoom); }
  for (let y = Math.floor(top / grid) * grid; y < top + height / camera.zoom; y += grid) { ctx.moveTo(left, y); ctx.lineTo(left + width / camera.zoom, y); }
  ctx.stroke();
  let display = project;
  if (drag?.kind === 'move') {
    // Display-only overlay during a 2D drag: only the map changes.
    display = { ...project, map: structuredClone(project.map) };
    const collection = drag.selection.kind === 'entity' ? display.map.entities : display.map.vertices;
    const item = collection.find(item => item.id === drag.selection.id);
    item.x += drag.end.x - drag.start.x; item.y += drag.end.y - drag.start.y;
  }
  for (const wall of wallSegments(display)) {
    ctx.strokeStyle = selection?.id === wall.id ? '#ffffff' : wall.color;
    ctx.lineWidth = (selection?.id === wall.id ? 4 : 2) / camera.zoom;
    ctx.setLineDash(wall.solid ? [] : [6 / camera.zoom, 5 / camera.zoom]);
    ctx.beginPath(); ctx.moveTo(wall.start.x, wall.start.y); ctx.lineTo(wall.end.x, wall.end.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  if (camera.zoom > .18) for (const vertex of display.map.vertices) {
    const size = (selection?.id === vertex.id ? 7 : 4) / camera.zoom;
    ctx.fillStyle = selection?.id === vertex.id ? '#ffffff' : '#95abc0';
    ctx.fillRect(vertex.x - size / 2, vertex.y - size / 2, size, size);
  }
  for (const entity of display.map.entities) {
    ctx.fillStyle = entityColors[entity.type];
    ctx.strokeStyle = selection?.id === entity.id ? '#ffffff' : entityColors[entity.type];
    ctx.lineWidth = 2 / camera.zoom;
    ctx.beginPath(); ctx.arc(entity.x, entity.y, 7 / camera.zoom, 0, Math.PI * 2); ctx.fill();
    if (selection?.id === entity.id) { ctx.beginPath(); ctx.arc(entity.x, entity.y, 12 / camera.zoom, 0, Math.PI * 2); ctx.stroke(); }
    if (entity.type === 'player') {
      const angle = entity.angle * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(entity.x, entity.y);
      ctx.lineTo(entity.x + Math.cos(angle) * 24 / camera.zoom, entity.y + Math.sin(angle) * 24 / camera.zoom); ctx.stroke();
    }
    if (camera.zoom > .25) {
      ctx.font = `${10 / camera.zoom}px system-ui`; ctx.fillText(entity.name, entity.x + 12 / camera.zoom, entity.y + 4 / camera.zoom);
    }
  }
  if (drag?.kind === 'room') {
    ctx.strokeStyle = '#70ddba'; ctx.lineWidth = 2 / camera.zoom;
    ctx.strokeRect(drag.start.x, drag.start.y, drag.end.x - drag.start.x, drag.end.y - drag.start.y);
  }
  ctx.restore();
}
function hitTest(point) {
  const tolerance = 12 / camera.zoom;
  const entity = project.map.entities.find(item => Math.hypot(item.x - point.x, item.y - point.y) < tolerance);
  if (entity) return { kind: 'entity', id: entity.id };
  const vertex = project.map.vertices.find(item => Math.hypot(item.x - point.x, item.y - point.y) < tolerance * .7);
  if (vertex) return { kind: 'vertex', id: vertex.id };
  const wall = wallSegments(project).find(item => distanceToSegment(point.x, point.y, item.start, item.end) < tolerance * .6);
  if (wall) return { kind: 'wall', id: wall.id };
  const sector = sectorAt(mapSectors, point.x, point.y);
  return sector ? { kind: 'sector', id: sector.id } : null;
}
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('pointerdown', guard(event => {
  if (!project) return;
  capturePointer(canvas, event.pointerId);
  const point = worldPoint(event);
  if (event.button === 2 || event.button === 1) {
    drag = { kind: 'pan', button: event.button, clientX: event.clientX, clientY: event.clientY, x: camera.x, y: camera.y,
      startX: event.clientX, startY: event.clientY, moved: false }; return;
  }
  if ($('tool').value === 'room') { drag = { kind: 'room', start: snap(point), end: snap(point) }; return; }
  if ($('tool').value === 'entity') {
    const position = snap(point), type = $('entity-type').value;
    edit(next => {
      if (type === 'player') Object.assign(next.map.entities.find(entity => entity.type === 'player'), position);
      else next.map.entities.push({ id: newId('entity'), type, name: `${type[0].toUpperCase()}${type.slice(1)}`, ...position, angle: 0,
        ...(type === 'light' ? { light: { color: '#ffbd72', intensity: 1, radius: 192 } } : {}) });
    }, `${type} placed`);
    return;
  }
  selection = hitTest(point);
  if (selection && ['entity', 'vertex'].includes(selection.kind)) drag = { kind: 'move', selection: { ...selection }, start: snap(point), end: snap(point) };
  render();
}));
canvas.addEventListener('pointermove', event => {
  if (!project) return;
  const point = worldPoint(event);
  $('coordinates').textContent = `X ${Math.round(point.x)} / Y ${Math.round(point.y)}`;
  if (!drag) return;
  if (drag.kind === 'pan') {
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 3) drag.moved = true;
    camera.x = drag.x - (event.clientX - drag.clientX) / camera.zoom;
    camera.y = drag.y - (event.clientY - drag.clientY) / camera.zoom;
  } else drag.end = snap(point);
  mapNeedsDraw = true;
});
canvas.addEventListener('pointerup', guard(event => {
  const finished = drag;
  drag = null;
  mapNeedsDraw = true;
  if (!finished) return;
  if (finished.kind === 'pan' && finished.button === 2 && !finished.moved) { mapCanvasMenu(event); return; }
  if (finished.kind === 'room') {
    const { start, end } = finished;
    edit(next => addRoom(next, { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), depth: Math.abs(start.y - end.y) }), 'Room added. Select shared walls and disable collision to make openings.');
  }
  if (finished.kind === 'move' && (finished.start.x !== finished.end.x || finished.start.y !== finished.end.y)) {
    edit(next => {
      const collection = finished.selection.kind === 'entity' ? next.map.entities : next.map.vertices;
      const item = collection.find(item => item.id === finished.selection.id);
      item.x += finished.end.x - finished.start.x; item.y += finished.end.y - finished.start.y;
    }, 'Object moved');
  }
}));
canvas.addEventListener('pointercancel', () => { drag = null; mapNeedsDraw = true; });
canvas.addEventListener('dblclick', event => {
  if ($('tool').value !== 'select') return;
  const hit = hitTest(worldPoint(event));
  if (hit?.kind === 'entity') openScript(hit.id);
});
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  const before = worldPoint(event);
  camera.zoom = Math.max(.02, Math.min(6, camera.zoom * Math.exp(-event.deltaY * .001)));
  const after = worldPoint(event);
  camera.x += before.x - after.x; camera.y += before.y - after.y;
  mapNeedsDraw = true;
}, { passive: false });

async function saveProject() {
  const submittedVersion = editVersion;
  // A document without a stored project gets its own file, so saving a fresh import no
  // longer overwrites whichever project happened to be open.
  const result = projectId
    ? await api('/api/project', { method: 'PUT', body: JSON.stringify({ project, revision }) })
    : await api('/api/project/adopt', { method: 'POST', body: JSON.stringify({ project, title: project.title }) });
  revision = result.revision;
  projectId = result.projectId ?? projectId;
  // Saving promotes a temporary import into a real project.
  projectTemporary = Boolean(result.temporary);
  dirty = editVersion !== submittedVersion;
  if (!dirty) persistDraft();
  render();
  await refreshProjects();
  status(dirty ? 'Earlier snapshot saved; newer edits are still unsaved'
    : `Project saved to the local server; it reopens next time as "${project.title}"`);
}
async function reloadProject(initial = false) {
  if (!initial && dirty && !confirm('Discard unsaved edits and load the server project? Your last draft stays in browser storage.')) return;
  const result = await api('/api/project');
  project = validateProject(result.project); revision = result.revision; projectId = result.projectId ?? null;
  projectTemporary = Boolean(result.temporary); dirty = false;
  let recovery;
  if (initial) {
    recovery = recoverProject(result, localStorage.getItem('opendle-draft'), localStorage.getItem('opendle-draft-metadata'));
    if (recovery.recovery === 'conflict' && confirm('A different unsaved browser draft exists. Restore it instead of the server project? Choose Cancel to load the server project; the draft remains available in Restore draft.')) {
      project = recovery.draft; dirty = true;
    } else { project = recovery.project; dirty = recovery.dirty; }
  }
  // Drafts and older imports can still carry the narrow pickup reach that made an
  // item on a ledge impossible to take.
  if (upgradePickupReach(project)) { dirty = true; status('Pickup reach widened so items on ledges can be collected; save to keep it.'); }
  history = []; future = []; selection = null; scriptScope = '$all'; editVersion++; clearDraft();
  render(); fitMap();
  status(dirty ? 'Unsaved browser draft restored; save to keep it on the server'
    : recovery?.warning || 'Server project loaded', Boolean(recovery?.warning));
}
/**
 * Drains what the runtime collected while playing: stopped ACS scripts, action
 * functions with no equivalent, and anything the renderer flagged. Indexes are kept
 * on the runtime so each failure is logged once, not once per frame.
 */
const reportedScriptErrors = new WeakMap();
let actorAttribution = null;
function reportPlaytestFailures(session) {
  const failures = session.scripts?.errors;
  if (Array.isArray(failures)) {
    // Kept off the runtime object: its own field list is saved with the game and
    // rejects anything it does not recognise.
    const reported = reportedScriptErrors.get(session) || 0;
    for (const message of failures.slice(reported)) playtestLog.error('acs', message);
    reportedScriptErrors.set(session, failures.length);
  }
  if (session.actorUnsupported?.size) {
    // Which actor uses the function comes from the actor table, so the log entry
    // points at the states to edit instead of only naming a function. Walking the
    // whole actor table for it on every frame was a steady cost in any imported game
    // that uses an unsupported action, so it is computed once per preview.
    if (!actorAttribution || actorAttribution.project !== previewProject) {
      actorAttribution = { project: previewProject,
        map: new Map((previewProject ? unsupportedActorActions(previewProject) : []).map(gap => [gap.name, gap.actors])) };
    }
    const attribution = actorAttribution.map;
    for (const name of session.actorUnsupported) {
      const actors = attribution.get(name) || [];
      playtestLog.once(`actor:${name}`, { severity: 'warning', category: 'actor',
        message: `Action function ${name} has no engine equivalent; actor states that call it skip that step`
          + `${actors.length ? ` (used by ${actors.slice(0, 4).join(', ')}${actors.length > 4 ? ', …' : ''})` : ''}.`,
        details: { name, actors } });
    }
  }
  if (session.missileGaps?.size) {
    // A weapon that names a projectile class the project does not contain fires
    // nothing, so the log names the class instead of leaving a silent dud.
    for (const name of session.missileGaps) {
      playtestLog.once(`missile:${name}`, { severity: 'warning', category: 'actor',
        message: `A weapon fired ${name}, which is not in this project's actor table, so the shot was skipped.`,
        details: { missile: name } });
    }
  }
  for (const special of session.scripts?.unsupportedSpecials || []) {
    playtestLog.once(`special:${special}`, { severity: 'warning', category: 'acs',
      message: `Line special ${special} was triggered but this runtime does not perform it.`,
      details: { special } });
  }
  const spriteReport = previewRenderer?.spriteReport?.();
  if (spriteReport?.sprites?.length) {
    // Enemy sprite placement, with the artwork offsets and the anchor, so a report of
    // "the monsters are half in the floor" can be answered from the log alone.
    playtestLog.once('render:sprite-placement', { severity: 'info', category: 'render',
      message: `Enemy sprite placement: ${spriteReport.sprites.map(sprite =>
        `${sprite.asset} anchor ${sprite.anchor} floor ${sprite.floor} bottom ${sprite.drawnBottom}`).join('; ')}.`,
      details: spriteReport });
  }
  if (spriteReport?.hiddenWithoutArtwork) {
    // Objects that carry no artwork are invisible in Doom and are not drawn here either;
    // the log still names them, because a *missing* sprite is an import problem.
    playtestLog.once('render:without-artwork', { severity: 'info', category: 'render',
      message: `${spriteReport.hiddenWithoutArtwork} object(s) have no artwork and are not drawn: ${spriteReport.withoutArtwork
        .map(entry => `${entry.name} (${entry.doomType ?? entry.type})`).join(', ')}.`,
      details: { count: spriteReport.hiddenWithoutArtwork, objects: spriteReport.withoutArtwork } });
  }
  if (session.groundCorrections?.first) {
    // An actor below its sector floor is drawn buried in it; the runtime snaps it back
    // up, and the log names which actor and by how much so the cause can be fixed.
    const { name, id, below } = session.groundCorrections.first;
    playtestLog.once('ground:corrections', { severity: 'warning', category: 'actor',
      message: `${session.groundCorrections.count} actor(s) started below their sector floor and were moved back up; `
        + `first was ${name} (${below} units under).`,
      details: { actor: name, id, below, count: session.groundCorrections.count } });
  }
}
/**
 * A frame that took far longer than it should is what a player experiences as a
 * stutter (and as the music stopping). The renderer keeps session-wide counters, so
 * the log names the stall and what was on screen instead of leaving it unexplained.
 */
let reportedStalls = 0;
// The renderer times its own draw call only, so a long pause in the simulation,
// the audio mixer or the HUD never reached the playtest log. The frame budget and
// the long-task observer below cover the rest of the loop.
const frameBudget = createFrameBudget({ slowMs: 120 });
const frameParts = { step: 0, audio: 0, render: 0, hud: 0 };
let reportedSlowFrames = 0, reportedSlowWorst = 0, slowFrameReports = 0;
let longTaskWatch = null, reportedLongTasks = 0;
function reportSlowFrame() {
  const slowest = frameBudget.slowest;
  // Only a new worst frame is worth a log line: an ordinary slow frame repeats.
  if (!slowest || slowest.ms <= reportedSlowWorst || slowFrameReports >= 10) return;
  reportedSlowWorst = slowest.ms;
  reportedSlowFrames = frameBudget.slow;
  slowFrameReports++;
  playtestLog.warn('performance', `Preview frame took ${slowest.ms} ms`, {
    ...slowest, slowFrames: frameBudget.slow, frames: frameBudget.frames, slowMs: frameBudget.slowMs,
    // A step that stalls says nothing on its own: the stages name what it was doing.
    stepStages: runtime?.slowStep ?? null,
    heapBefore: slowest.heapBefore,
    entities: runtime?.entities?.length ?? 0, level: previewProject?.game?.active ?? null,
    // A huge heap means the pause was a collection, and a hidden page means the browser
    // froze the tab mid-frame and charged the frozen time to this frame.
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined,
    hidden: document.hidden,
  });
}
/**
 * Garbage collection, image decodes, layouts and long synchronous handlers run
 * between frames, where nothing in the loop can measure them. The browser reports
 * them as long tasks; attributing them is the only way to name a one-off hitch.
 */
function watchLongTasks() {
  if (longTaskWatch || typeof PerformanceObserver !== 'function') return null;
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return null;
  const watch = { count: 0, total: 0, worst: 0, observer: null };
  try {
    watch.observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        watch.count++; watch.total += entry.duration;
        if (entry.duration > watch.worst) watch.worst = entry.duration;
        if (entry.duration < 200 || ++reportedLongTasks > 10) continue;
        playtestLog.warn('performance', `Long task blocked the preview for ${Math.round(entry.duration)} ms`, {
          ms: Math.round(entry.duration), tasks: watch.count, worstMs: Math.round(watch.worst),
          attribution: entry.attribution?.map(item => item.containerType || item.name || 'unknown') || [],
          level: previewProject?.game?.active ?? null,
        });
      }
    });
    watch.observer.observe({ entryTypes: ['longtask'] });
  } catch { return null; }
  longTaskWatch = watch;
  return watch;
}
/**
 * A tab the browser suspends or occludes freezes the loop mid-frame and charges the
 * frozen wall time to that frame, which in a report looks exactly like a stall in the
 * code. Recording when the page loses visibility is what tells the two apart.
 */
document.addEventListener('visibilitychange', () => {
  if (!runtime) return;
  playtestLog.info('performance', document.hidden ? 'Preview hidden by the browser' : 'Preview visible again', {
    hidden: document.hidden, playSeconds: Math.round(runtime.time),
    frameWorstMs: Math.round(frameBudget.worst), slowFrames: frameBudget.slow,
  });
});
function stopLongTasks() {
  longTaskWatch?.observer?.disconnect();
  longTaskWatch = null;
  reportedLongTasks = 0;
}
function reportFrameStalls(session) {
  const perf = previewRenderer?.perf?.();
  if (!perf || perf.sessionStalls <= reportedStalls) return;
  reportedStalls = perf.sessionStalls;
  if (reportedStalls > 20) return;
  playtestLog.warn('performance', `Frame stalled for ${Math.round(perf.worst)} ms`, {
    ms: Math.round(perf.worst), stalls: perf.sessionStalls, frames: perf.sessionFrames,
    entities: session.entities?.length ?? 0, projectiles: session.projectiles?.length ?? 0,
    effects: session.impacts?.length ?? 0, level: previewProject?.game?.active ?? null,
    // update vs draw, geometry rebuilds and pipeline/texture counts for the worst frame
    slowFrame: perf.slowFrame ? { ...perf.slowFrame } : null,
  });
}
function stopPreview() {
  previewGeneration++;
  if (runtime) {
    reportPlaytestFailures(runtime);
    const perf = previewRenderer?.perf?.();
    playtestLog.info('playtest', 'Preview stopped', {
      playSeconds: Math.round(runtime.time), health: runtime.playerStats.health,
      screen: runtime.gameScreen,
      ...(perf ? { frames: perf.sessionFrames, stalls: perf.sessionStalls, worstFrameMs: Math.round(perf.worst) } : {}),
      // Whole-frame worst case and the tasks the browser ran between frames.
      frameWorstMs: Math.round(frameBudget.worst), slowFrames: frameBudget.slow,
      slowestFrame: frameBudget.slowest,
      slowStep: runtime.slowStep,
      stepTotals: runtime.stepTotals,
      ...(longTaskWatch ? { longTasks: longTaskWatch.count, longTaskMs: Math.round(longTaskWatch.total), longTaskWorstMs: Math.round(longTaskWatch.worst) } : {}),
    });
  }
  stopLongTasks();
  playtestLog.flush().catch(() => {});
  audioPlayer?.dispose(); audioPlayer = null;
  lookDrag = null; draggedLook = false;
  if (document.pointerLockElement === $('preview')) document.exitPointerLock();
  $('play-dialog').close(); runtime = null; previewRenderer?.dispose(); previewRenderer = null; keys.clear(); pressed.clear();
  hudView?.dispose(); hudView = null; previewProject = null; hudCursorActive = false;
  $('hud-cursor').setAttribute('aria-pressed', 'false');
  $('show-statusbar').hidden = true;
}
function mouseStatus(message, error = false) {
  $('mouse-status').textContent = message;
  $('mouse-status').classList.toggle('error', error);
  status(message, error);
}
function captureMouse() {
  if (!runtime || runtime.gameScreen !== 'playing') return;
  audioPlayer?.resume();
  runtime.hudState.cursor = false; syncHUDCursor();
  const session = runtime;
  requestMouseLock(document, $('preview'), (message, error) => {
    if (runtime === session) mouseStatus(message, error);
  });
}
function syncHUDCursor() {
  if (!runtime || hudCursorActive === runtime.hudState.cursor) return;
  hudCursorActive = runtime.hudState.cursor;
  lookDrag = null; keys.clear(); pressed.clear();
  runtime.input.mouseX = 0; runtime.input.mouseY = 0;
  if (hudCursorActive && document.pointerLockElement === $('preview')) document.exitPointerLock();
  $('hud-cursor').setAttribute('aria-pressed', String(hudCursorActive));
  if (!hudCursorActive) $('preview').focus();
  mouseStatus(runtime.gameScreen !== 'playing' ? 'Game menu active. Gameplay is paused. Use the mouse or Up/Down and Enter; Escape goes back.'
    : hudCursorActive ? 'HUD cursor active. Click controls; Tab or Resume returns to gameplay. Simulation continues.'
    : 'Gameplay input active. Click Capture mouse to lock; Tab opens the HUD cursor.');
}
$('hud-cursor').addEventListener('click', () => {
  if (!runtime || runtime.gameScreen !== 'playing') return;
  runtime.hudState.cursor = !runtime.hudState.cursor; syncHUDCursor(); hudView?.update(runtime);
});
/**
 * Screen size 11 intentionally hides the classic status bar, and any of the imported
 * Options controls can reach it in one click, so the preview keeps a way back on
 * screen instead of relying on the player finding that menu again.
 */
function syncStatusBarButton() {
  const button = $('show-statusbar'), hidden = !runtime || !statusBarHidden(previewProject?.hud, runtime.settings);
  if (button.hidden === hidden) return;
  button.hidden = hidden;
}
$('show-statusbar').addEventListener('click', () => {
  if (!runtime) return;
  changeSetting(runtime, 'viewSize', 10);
  settingsRevision = -1;
  runtime.message = 'Status bar shown again (Screen size 10).';
  runtime.messageTime = 4;
  syncStatusBarButton(); hudView?.update(runtime);
  mouseStatus('Status bar shown again. Screen size is 10.');
});
$('capture-mouse').addEventListener('click', captureMouse);
$('system-browser').addEventListener('click', guard(async () => {
  if (dirty) {
    if (!confirm('Save the current project before opening it in your system browser? Your unsaved edits must be saved to transfer them.')) return;
    await saveProject();
    if (dirty) throw new Error('Newer edits remain unsaved. Save again before opening the system browser.');
  }
  $('system-browser').disabled = true;
  try {
    const result = await api('/api/open-browser', { method: 'POST', body: '{}' });
    mouseStatus(`Opened ${result.url} in your system browser. Click Play there, then Capture mouse. This preview is still open.`);
  } catch (error) {
    mouseStatus(`Cannot open the system browser: ${error.message}. Open ${location.origin} manually in Chrome/Firefox. If you just updated OpenDLE, restart the local service first.`, true);
  } finally { $('system-browser').disabled = false; }
}));
async function beginPreview(gameMode = false, resumeSettings, start = false, levelId, progress, savedGame) {
  if (previewLoading) return;
  if (!project.gameMenus) {
    edit(next => installGameMenu(next), 'Editable game menus added. Save to keep them in the project.');
  }
  if (!project.eventSheets.some(sheet => sheet.id === 'intermission_sheet')) {
    edit(next => installIntermission(next), 'Editable level intermission added. Save to keep it in the project.');
  }
  if (!project.hud) {
    edit(next => installDefaultHUD(next), 'This project had no HUD, so an editable default HUD was added. Save to keep it.');
    hudWarningShown = false;
  }
  validateProject(project);
  const gaps = importedGameplayGaps(project);
  if (project.events.length === 0 && gaps.length && !confirm('This is a geometry-only import with no gameplay rules. Weapons, enemies and pickups will not work. Cancel and restore your gameplay draft or reimport the WAD. Continue with a geometry-only preview?')) return;
  previewLoading = true; $('play').disabled = true; $('play-game').disabled = true; $('play-level').disabled = true;
  const version = editVersion;
  const generation = ++previewGeneration;
  let replacingPreview = false;
  try {
    if (saveIdentityVersion !== version || !saveIdentityPromise) {
      saveIdentityVersion = version; saveIdentityPromise = gameSaveIdentity(project);
    }
    const identity = await saveIdentityPromise;
    if (generation !== previewGeneration) throw new Error('Preview was stopped while loading.');
    if (version !== editVersion) throw new Error('Project changed while preview loaded. Play again.');
    const snapshot = structuredClone(project);
    if (snapshot.game && !savedGame) selectGameLevel(snapshot, levelId || (gameMode ? snapshot.game.entry : snapshot.game.active));
    const restored = savedGame ? restoreGameSave(snapshot, savedGame, identity) : null;
    installIntermission(snapshot);
    // A preview only ever plays the active level, and a level change builds a fresh
    // snapshot from the editor project, so the other levels' data is dead weight here:
    // on an imported game it is tens of megabytes of duplicated map data that the
    // browser's collector still has to walk while the level runs.
    for (const level of snapshot.game?.levels || []) {
      if (level.id === snapshot.game.active) continue;
      level.data = {};
      level.assetIds = [];
    }
    replacingPreview = true;
    if (runtime) {
      audioPlayer?.dispose(); audioPlayer = null;
      previewRenderer?.dispose(); previewRenderer = null;
      hudView?.dispose(); hudView = null;
      runtime = null;
    }
    settingsStorageKey = `opendle-game-settings:${snapshot.title}`;
    let settings = resumeSettings;
    if (!settings) {
      const stored = localStorage.getItem(settingsStorageKey);
      try { settings = gameSettings(stored ? JSON.parse(stored) : {}); }
      catch (error) {
        if (!confirm(`Saved game settings are invalid: ${error.message}. Reset them?`)) throw error;
        settings = gameSettings(); localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
      }
    }
    Object.assign(settings, readEngineTweaks());
    audioPlayer = createAudioPlayer(snapshot, message => mouseStatus(message, true), undefined, primeAudio() || undefined);
    status('Loading renderer and embedded images (WebGPU preferred, WebGL fallback)...');
    const nextRuntime = restored?.runtime || createRuntime(snapshot, { settings, gameMode, progress,
      screen: gameMode && !start ? snapshot.gameMenus.entry : 'playing' });
    nextRuntime.gameMode = gameMode;
    nextRuntime.hudState.cursor = nextRuntime.gameScreen !== 'playing';
    if (statusBarHidden(snapshot.hud, nextRuntime.settings)) {
      // Our HUD *is* the status bar, so screen size 11 leaves nothing on screen. It was
      // also one stray click away in the Options menu, so a stored 11 is treated as an
      // accident: the bar comes back and the player can raise the size again on purpose.
      changeSetting(nextRuntime, 'viewSize', 10);
      nextRuntime.message = 'Screen size 11 hides the whole HUD, so it was set back to 10. Raise it in Options if you meant it.';
      nextRuntime.messageTime = 6;
    }
    try { nextRuntime.saveSlots = saveSlotLabels(await gameSaves.list(identity)); }
    catch (error) { nextRuntime.saveStatus = `Saved games unavailable: ${error.message}`; status(nextRuntime.saveStatus, true); }
    if (generation !== previewGeneration) throw new Error('Preview was stopped while loading.');
    const preview = await createPreview($('preview'), snapshot, nextRuntime);
    if (generation !== previewGeneration) { preview.dispose(); throw new Error('Preview was stopped while loading.'); }
    if (version !== editVersion) { preview.dispose(); throw new Error('Project changed while preview loaded. Play again.'); }
    previewRenderer = preview;
    if (restored?.physicsData) nextRuntime.physics.restoreState(restored.physicsData);
    runtime = nextRuntime;
    settingsRevision = -1;
    previewProject = snapshot;
    previewSaveIdentity = identity;
    hudView = createHUDView($('hud-overlay'), snapshot, {
      click: id => { if (runtime?.hudState.cursor && !runtime.bindingKey) runtime.hudState.clicked.add(id); },
      error: message => mouseStatus(message, true),
    });
    $('preview-title').textContent = `${snapshot.title}${snapshot.game ? ` / ${snapshot.game.active}` : ''}`;
    reportedStalls = 0;
    reportedSlowFrames = 0; reportedSlowWorst = 0; slowFrameReports = 0;
    frameBudget.reset();
    watchLongTasks();
    playtestLog.setContext({
      project: snapshot.title,
      level: snapshot.game ? `${snapshot.game.active} — ${(snapshot.game.levels || []).find(level => level.id === snapshot.game.active)?.name || ''}` : snapshot.title,
      difficulty: `difficulty ${runtime.settings.difficulty}`,
      music: runtime.environment?.music || project.environment?.music || 'none',
      renderer: preview.rendererStatus?.backend,
      mode: gameMode ? 'game' : 'level',
      levels: snapshot.game?.levels?.length,
      // A missing status bar is usually a screen-size or import question, so the
      // log records what the HUD actually contains and what the view shows.
      viewSize: runtime.settings.viewSize,
      hudElements: (snapshot.hud?.elements || []).length,
      statusBarElements: (snapshot.hud?.elements || []).filter(element => element.statusbar).length,
      sky: (snapshot.assets || []).find(asset => asset.id === snapshot.environment?.skyAsset)?.name || null,
      url: location.href,
      app: engineVersion ? `OpenDLE: Studio ${engineVersion}` : 'OpenDLE: Studio',
    });
    playtestLog.info('playtest', `${gameMode ? 'Game' : 'Level'} preview ready`, {
      level: snapshot.game?.active, backend: preview.rendererStatus?.backend,
      levels: snapshot.game?.levels?.length,
    });
    $('play-level-label').hidden = !snapshot.game;
    $('play-level').replaceChildren(...(snapshot.game?.levels || []).map(level =>
      new Option(`${level.id} — ${level.name}`, level.id, false, level.id === snapshot.game.active)));
    $('preview-controls').textContent = runtime.scriptedInput
      ? 'Editable Engine controls: WASD / arrows / mouse look. Space: jump (editor Engine tweaks). E: use doors and switches. Left mouse: fire selected weapon (pistol/shotgun bullets are instant hitscan, not flying missiles). 1-9: select owned weapons (8=chainsaw, 9=super shotgun). Right-drag: look without capture. Tab: HUD cursor. Escape releases cursor, then opens the pause menu.'
      : 'Click: mouse look (or left-drag). Escape releases cursor, then opens the pause menu. WASD moves, arrows turn, Space jumps; E / F / Q trigger events.';
    if (!$('play-dialog').open) $('play-dialog').showModal();
    $('preview').focus(); keys.clear(); pressed.clear();
    if (!restored) stepRuntime(snapshot, runtime, 0, keys);
    hudView.update(runtime);
    mouseStatus('Mouse is free. Click the view or Capture mouse. If the browser blocks capture, use drag-look or open this URL in a desktop browser.');
    if (runtime.saveStatus) status(runtime.saveStatus, true);
    else status(`${preview.rendererStatus?.backend || 'GPU'} preview ready${preview.rendererStatus?.fallbackReason ? ` — ${preview.rendererStatus.fallbackReason}` : ''}`);
  } catch (error) { if (replacingPreview || !runtime) stopPreview(); throw error; }
  finally { previewLoading = false; $('play').disabled = false; $('play-game').disabled = false; $('play-level').disabled = false; }
}
function saveSlotLabels(slots) {
  return Array.from({ length: 6 }, (_, index) => {
    const slot = slots.find(slot => slot?.slot === index + 1);
    return slot ? `${slot.levelId || 'Level'} / ${new Date(slot.createdAt).toLocaleString()}` : '';
  });
}
async function processGameSave(request) {
  if (saveBusy || !runtime || previewLoading) return;
  const session = runtime, identity = previewSaveIdentity;
  saveBusy = true;
  try {
    session.saveStatus = request.type === 'save' ? 'Saving game...' : 'Loading game...';
    if (request.type === 'save') {
      const record = captureGameSave(previewProject, session, identity);
      await gameSaves.save(identity, request.slot, record);
      const slots = await gameSaves.list(identity);
      if (runtime === session) {
        session.saveSlots = saveSlotLabels(slots);
        session.saveStatus = `Game saved in slot ${request.slot}.`;
        setGameScreen(session, 'save');
      }
    } else {
      const record = await gameSaves.load(identity, request.slot);
      if (runtime === session) await beginPreview(session.gameMode, session.settings, true, undefined, undefined, record);
    }
  } catch (error) {
    if (runtime === session) session.saveStatus = `${request.type === 'save' ? 'Save' : 'Load'} failed: ${error.message}`;
    status(`${request.type === 'save' ? 'Save' : 'Load'} failed: ${error.message}`, true);
  } finally { saveBusy = false; }
}
$('play-level').addEventListener('change', guard(async () => {
  if (!runtime || previewLoading) return;
  hudWarningShown = false; musicReported = false;
  await beginPreview(runtime.gameMode, structuredClone(runtime.settings), true, $('play-level').value);
}));
$('play').addEventListener('click', guard(() => { primeAudio(); hudWarningShown = false; musicReported = false; return beginPreview(false); }));
$('play-game').addEventListener('click', guard(() => { primeAudio(); hudWarningShown = false; musicReported = false; return beginPreview(true); }));
// Browsers only allow audio to start inside a user gesture. Creating the
// AudioContext here (not after the asynchronous preview setup) keeps sound and
// music working even when loading takes seconds.
function primeAudio() {
  if (audioContext) { audioContext.resume().catch(() => {}); return audioContext; }
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) return null;
  try { audioContext = new Context(); audioContext.resume().catch(() => {}); }
  catch { audioContext = null; }
  return audioContext;
}
function pauseGame() {
  if (!runtime || !runtime.hasGame) return;
  setGameScreen(runtime, runtime.gameScreen === 'playing' ? 'pause' : 'playing');
  runtime.bindingKey = null; keys.clear(); pressed.clear(); syncHUDCursor();
}
$('pause-game').addEventListener('click', pauseGame);
async function togglePreviewFullscreen() {
  if (!document.fullscreenEnabled) throw new Error('Fullscreen is unavailable in this browser or embedded preview. Open in system browser.');
  if (document.fullscreenElement) await document.exitFullscreen();
  else await $('preview-stage').requestFullscreen();
}
$('preview-fullscreen').addEventListener('click', guard(togglePreviewFullscreen));
$('stop').addEventListener('click', stopPreview);
function backFromGameMenu(event) {
  event.preventDefault();
  if (runtime?.bindingKey) { runtime.bindingKey = null; return; }
  if (!runtime) return;
  if (runtime.gameScreen === 'playing' || runtime.gameScreen === 'pause') pauseGame();
  else {
    setGameScreen(runtime, runtime.gameScreen === 'title' ? 'quit' : 'return');
  }
}
$('play-dialog').addEventListener('cancel', backFromGameMenu);
$('preview').addEventListener('click', () => {
  if (!runtime || runtime.hudState.cursor) return;
  $('preview').focus();
  if (draggedLook) { draggedLook = false; return; }
  captureMouse();
});
// Pointer capture is an enhancement (it keeps drag-look working outside the canvas)
// and the browser throws InvalidStateError when the pointer is already gone, so a
// failed capture must never escape as an uncaught error.
function capturePointer(element, pointerId) {
  try { element.setPointerCapture(pointerId); } catch { /* capture is best effort */ }
}
$('preview').addEventListener('pointerdown', event => {
  if (runtime?.bindingKey) {
    try { bindKey(runtime, `Mouse${event.button}`); } catch (error) { mouseStatus(error.message, true); }
    return;
  }
  if (!runtime || runtime.hudState.cursor) return;
  if (runtime.scriptedInput && event.button === 2) {
    if (!keys.has('Mouse2')) pressed.add('Mouse2');
    keys.add('Mouse2');
  }
  if (runtime.scriptedInput && event.button === 0) {
    if (!keys.has('Mouse0')) pressed.add('Mouse0');
    keys.add('Mouse0'); $('preview').focus(); capturePointer($('preview'), event.pointerId); return;
  }
  if (event.button !== (runtime.scriptedInput ? 2 : 0) || document.pointerLockElement === $('preview')) return;
  $('preview').focus(); draggedLook = false;
  lookDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  capturePointer($('preview'), event.pointerId);
});
$('preview').addEventListener('pointermove', event => {
  if (!runtime || runtime.hudState.cursor || !lookDrag || event.pointerId !== lookDrag.id || document.pointerLockElement === $('preview')) return;
  const dx = event.clientX - lookDrag.x, dy = event.clientY - lookDrag.y;
  if (dx || dy) { lookPlayer(runtime, dx, dy); draggedLook = true; }
  lookDrag.x = event.clientX; lookDrag.y = event.clientY;
});
$('preview').addEventListener('contextmenu', event => event.preventDefault());
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('preview').addEventListener(type, () => {
  lookDrag = null; keys.delete('Mouse0'); keys.delete('Mouse2');
});
document.addEventListener('pointerlockchange', () => {
  lookDrag = null; keys.clear(); pressed.clear();
  if (!runtime && document.pointerLockElement === $('preview')) { document.exitPointerLock(); return; }
  if (runtime && document.pointerLockElement === $('preview')) $('preview').focus();
  if (runtime) mouseStatus(document.pointerLockElement === $('preview')
    ? 'Mouse look active. Escape releases the cursor.'
    : 'Cursor released. Click the preview to resume mouse look.');
});
document.addEventListener('pointerlockerror', () => {
  const session = runtime;
  setTimeout(() => {
    if (runtime && runtime === session && $('mouse-status').textContent.startsWith('Requesting mouse capture')) {
      mouseStatus(`Browser refused mouse capture. Hold ${runtime.scriptedInput ? 'right' : 'left'} mouse and drag to look. For unrestricted capture, open ${location.origin} in a desktop browser and click Capture mouse.`, true);
    }
  }, 0);
});
document.addEventListener('mousemove', event => {
  if (runtime && !runtime.hudState.cursor && document.pointerLockElement === $('preview')) lookPlayer(runtime, event.movementX, event.movementY);
});
document.addEventListener('keydown', event => {
  if (runtime && $('play-dialog').open) {
    if (event.target === $('play-level')) return;
    if (event.code === 'Escape') { backFromGameMenu(event); return; }
    if (runtime.bindingKey && event.code !== 'Escape') {
      event.preventDefault();
      try { bindKey(runtime, event.code); } catch (error) { mouseStatus(error.message, true); }
      return;
    }
    if (runtime.gameScreen !== 'playing') {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.code)) {
        event.preventDefault(); event.stopPropagation();
        if (['ArrowLeft', 'ArrowRight'].includes(event.code)) {
          if (!keys.has(event.code)) pressed.add(event.code);
          keys.add(event.code); return;
        }
        const buttons = [...$('hud-overlay').querySelectorAll('[role="button"]')].filter(node => node.tabIndex === 0 && node.dataset.menuSelectable !== 'false');
        const index = buttons.findIndex(node => node.dataset.hudId === runtime.hudState.focused);
        if (event.code === 'Enter') buttons[index < 0 ? 0 : index]?.click();
        else buttons[(index < 0 ? event.code === 'ArrowDown' ? 0 : buttons.length - 1
          : (index + (event.code === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length)]?.focus();
      }
      return;
    }
  }
  if (!runtime || !(document.activeElement === $('preview') || event.code === 'Tab' && $('play-dialog').contains(document.activeElement))) return;
  if (INPUT_KEYS.includes(event.code) || validBinding(event.code)) event.preventDefault();
  if (!keys.has(event.code)) pressed.add(event.code);
  keys.add(event.code);
}, true);
document.addEventListener('keyup', event => { keys.delete(event.code); });
window.addEventListener('blur', () => {
  lookDrag = null; keys.clear(); pressed.clear();
  if (runtime) { runtime.input.mouseX = 0; runtime.input.mouseY = 0; }
  if (document.pointerLockElement === $('preview')) document.exitPointerLock();
});
$('preview').addEventListener('blur', () => { keys.clear(); pressed.clear(); });
let lastFrame = performance.now();
function frame(now) {
  const dt = (now - lastFrame) / 1000; lastFrame = now;
  const frameStart = performance.now();
  // The heap a frame starts with: a slow frame that ends with a much smaller one was a
  // garbage collection, not work this code did.
  frameParts.heapBefore = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0;
  if (runtime) {
    try {
      const onMenu = runtime.gameScreen !== 'playing';
      stepRuntime(previewProject, runtime, dt, onMenu ? keys : mappedKeys(keys, runtime.settings),
        onMenu ? pressed : mappedKeys(pressed, runtime.settings)); pressed.clear();
      if (settingsRevision !== runtime.settingsRevision) {
        settingsRevision = runtime.settingsRevision;
        try { localStorage.setItem(settingsStorageKey, JSON.stringify(runtime.settings)); }
        catch (error) { mouseStatus(`Settings could not be saved: ${error.message}`, true); }
      }
      const requests = runtime.menuRequests.splice(0);
      const saveRequest = requests.find(request => ['save', 'load'].includes(request?.type));
      if (saveRequest) void processGameSave(saveRequest);
      const levelRequest = requests.find(request => request?.type === 'level');
      if (levelRequest) {
        const settings = structuredClone(runtime.settings), mode = runtime.gameMode;
        const progress = levelRequest.carryProgress ? { playerStats: runtime.playerStats, inventory: runtime.inventory } : null;
        beginPreview(mode, settings, true, levelRequest.levelId, progress)
          .catch(error => { stopPreview(); status(`Level change failed: ${error.message}`, true); });
        requestAnimationFrame(frame); return;
      }
      if (requests.includes('complete')) status('Campaign complete. Choose New game or select another level.');
      if (requests.includes('quit')) { stopPreview(); requestAnimationFrame(frame); return; }
      if (requests.includes('fullscreen')) {
        togglePreviewFullscreen().catch(error => mouseStatus(`Fullscreen failed: ${error.message}`, true));
      }
      const startRequest = requests.find(request => request?.type === 'start');
      if (requests.includes('start') || startRequest) {
        const settings = structuredClone(runtime.settings), mode = runtime.gameMode;
        beginPreview(mode, settings, true, startRequest?.levelId).catch(error => status(`New game failed: ${error.message}`, true));
        requestAnimationFrame(frame); return;
      }
      frameParts.step = performance.now() - frameStart;
      audioPlayer?.update(runtime);
      frameParts.audio = performance.now() - frameStart - frameParts.step;
      previewRenderer.render(runtime, runtime.gameScreen === 'playing' ? dt : 0);
      frameParts.render = performance.now() - frameStart - frameParts.step - frameParts.audio;
      reportPlaytestFailures(runtime);
      reportFrameStalls(runtime);
      syncHUDCursor(); syncStatusBarButton(); hudView?.update(runtime);
      if (!musicReported && audioPlayer?.musicInfo) {
        const music = audioPlayer.musicInfo();
        if (music.playing || (music.hasMusicAssets && music.requested) || !music.hasMusicAssets) {
          musicReported = true;
          if (music.playing) {
            status(`Music: ${music.track}${music.volume === 0 ? ' — music volume is 0, raise it in Options' : ''}`, music.volume === 0);
          } else if (music.error) {
            // A track that is present but cannot be decoded must not be reported as
            // missing: the reason the import produced no playback is in the error.
            status(`Music ${music.requested || ''} could not be played: ${music.error}`, true);
          } else if (music.requested && !music.track) {
            status(`Music ${music.requested} is not embedded in this project. Reimport the game to add its MIDI/MUS soundtrack.`, true);
          } else if (!music.hasMusicAssets) {
            status('No music assets in this project. Reimport the game with the current version to add MIDI/MUS soundtracks.', true);
          }
        }
      }
      if (!hudWarningShown && runtime.gameScreen === 'playing' && hudView?.nodes?.size) {
        hudWarningShown = true;
        if (![...hudView.nodes.values()].some(entry => !entry.node.hidden)) {
          const hiddenBySize = statusBarHidden(previewProject.hud, runtime.settings);
          status(hiddenBySize
            ? 'The status bar is hidden because Screen size is 11. Open Options and raise Screen size (- gives a smaller screen, + shows the bar), or reset settings.'
            : 'No HUD elements are visible. Check HUD element visibility and display mode in the HUD designer.', true);
        }
      }
    } catch (error) { stopPreview(); status(`Preview failed: ${error.message}`, true); }
    if (!runtime) { requestAnimationFrame(frame); return; }
    $('game-message').textContent = !previewProject.hud && runtime.messageTime > 0 ? runtime.message : '';
    $('game-variables').textContent = [
      ...(!previewProject.hud && runtime.hud ? [`Health: ${runtime.playerStats.health}`, `Armor: ${runtime.playerStats.armor}`, `Bullets: ${runtime.playerStats.bullets}`] : []),
      ...(!previewProject.hud ? Object.entries(runtime.variables).map(([key, value]) => `${key}: ${value}`) : []),
    ].join('  /  ');
    frameParts.hud = performance.now() - frameStart - frameParts.step - frameParts.audio - frameParts.render;
    if (frameBudget.push(performance.now() - frameStart, frameParts)) reportSlowFrame();
  } else if (project && !$('scene-panel').hidden) {
    // The scene object editor draws its own canvas: redraws keep it in step with
    // window resizes and edits made from anywhere else (undo, inspector, import).
    try { sceneObjectEditor?.frame(dt); } catch (error) { status(`Scene editor failed: ${error.message}`, true); }
  } else if (project && !$('map-panel').hidden) {
    if (sceneMode === '3d') {
      try { sceneEditor?.frame(dt); } catch (error) { status(`3D editor failed: ${error.message}`, true); setSceneMode('2d'); }
    } else {
      resizeMap();
      if (mapNeedsDraw) { drawMap(); mapNeedsDraw = false; }
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
document.querySelectorAll('[data-tab]').forEach(element => element.addEventListener('click', () => showTab(element.dataset.tab)));
$('title').addEventListener('change', guard(() => edit(next => { next.title = $('title').value; })));
$('fit').addEventListener('click', fitMap);
$('grid').addEventListener('change', () => { mapNeedsDraw = true; });
$('save').addEventListener('click', guard(saveProject));
$('reload').addEventListener('click', guard(() => reloadProject()));
$('projects').addEventListener('change', guard(async () => {
  const id = $('projects').value;
  if (!id || id === projectId) return;
  if (dirty && !confirm('Discard unsaved edits and open this stored project? Your draft stays in browser storage.')) {
    await refreshProjects();
    return;
  }
  const result = await api('/api/projects/open', { method: 'POST', body: JSON.stringify({ id }) });
  project = validateProject(result.project);
  revision = result.revision;
  projectId = result.projectId ?? id;
  projectTemporary = Boolean(result.temporary);
  dirty = false;
  editVersion++;
  history = []; future = []; selection = null; scriptScope = '$all';
  $('dirty').textContent = badgeText();
  render(); fitMap();
  status(`Opened stored project "${project.title}"; it reopens next time`);
}));
$('undo').addEventListener('click', () => {
  if (!history.length) return;
  // Projects are never mutated in place (see cloneProjectForEdit), so the current
  // value is already a safe snapshot and needs no copy.
  future.push(project); project = history.pop(); dirty = true; editVersion++; clearDraft();
  persistDraft(); render(); status('Undone');
});
$('redo').addEventListener('click', () => {
  if (!future.length) return;
  history.push(project); project = future.pop(); dirty = true; editVersion++; clearDraft();
  persistDraft(); render(); status('Redone');
});
$('new').addEventListener('click', guard(() => {
  if (confirm('Create a new project? You can undo this change.')) replace(installEngineScripts(createProject(), { organizeStarter: true }), 'New project created with editable Engine sheets');
}));
$('restore').addEventListener('click', guard(() => {
  const draft = localStorage.getItem('opendle-draft');
  if (!draft) throw new Error('There is no local draft in this browser');
  if (!confirm('Restore your last browser draft? You can undo this change.')) return;
  let parsed;
  try { parsed = JSON.parse(draft); }
  catch (error) { throw new Error(`The browser draft is not valid JSON (${error.message}). Export or clear it before restoring.`); }
  replace(parsed, 'Browser draft restored; save to keep it on the server');
}));
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, project.game ? 0 : 2)], { type: 'application/json' }));
  const link = make('a'); link.href = url; link.download = `${project.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.opendle.json`; link.click();
  // The blob URL keeps the whole project document alive until it is revoked.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Project exported');
});
$('export-build').addEventListener('click', guard(async () => {
  $('export-build').disabled = true;
  status('Packaging a standalone desktop build (engine files, project data and launch scripts)...');
  try {
    const { response } = await requestWithSession(`/api/export/build?platform=${encodeURIComponent(navigator.platform.toLowerCase().includes('win') ? 'windows' : navigator.platform.toLowerCase().includes('mac') ? 'macos' : 'linux')}`, {}, token);
    if (!response.ok) throw new Error(`Export failed (HTTP ${response.status})`);
    const blob = await response.blob();
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'opendle-game.zip';
    const url = URL.createObjectURL(blob);
    const link = make('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    status(`Standalone build downloaded: ${name} (${(blob.size / 1048576).toFixed(1)} MiB). Unzip it and run the launch script; it needs Node.js 22+ and a Chromium-based browser for app-window mode.`);
  } finally { $('export-build').disabled = false; }
}));
$('open').addEventListener('click', () => $('project-file').click());
$('project-file').addEventListener('change', guard(async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > ARCHIVE_LIMIT) throw new Error(`Project exceeds the ${ARCHIVE_LIMIT / 1048576} MiB file limit`);
  const next = validateProject(JSON.parse(await file.text()));
  if (!confirm('Open this project? You can undo this change.')) return;
  replace(next, 'Project opened');
  await adoptDocument();
}));
$('wad').addEventListener('click', () => $('wad-file').click());
$('wad-file').addEventListener('change', guard(async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > ARCHIVE_LIMIT) throw new Error(`WAD exceeds the ${ARCHIVE_LIMIT / 1048576} MiB file limit`);
  loadedWad = readWad(await file.arrayBuffer());
  $('local-wad-label').hidden = true;
  $('wad-map').replaceChildren(...loadedWad.maps.map(name => { const option = make('option', name); option.value = name; return option; }));
  showWadImport();
}));
function closeWadImport() {
  if (wadImport) { wadImport.abort(); status('WAD import cancelled; project unchanged.'); }
  $('import-dialog').close(); loadedWad = null;
}
function showWadImport() {
  $('wad-scope').value = 'game';
  $('import-status').textContent = 'Ready to import. Your current project stays unchanged until import succeeds.';
  $('import-status').classList.remove('error');
  $('import-report').hidden = true;
  $('import-dialog').showModal();
}
$('cancel-import').addEventListener('click', closeWadImport);
$('import-dialog').addEventListener('cancel', event => { event.preventDefault(); closeWadImport(); });
$('local-wad').addEventListener('click', guard(async () => {
  const result = await api('/api/wads');
  if (!result.files.length) throw new Error('No WAD files in the Projects folder');
  $('local-wad-select').replaceChildren(...result.files.map(name => { const option = make('option', name); option.value = name; return option; }));
  await loadLocalMaps();
  $('local-wad-label').hidden = false;
  showWadImport();
}));
$('reimport-gameplay').addEventListener('click', () => $('local-wad').click());
async function loadLocalMaps() {
  const name = $('local-wad-select').value;
  const result = await api(`/api/wads/${encodeURIComponent(name)}/maps`);
  loadedWad = { localName: name };
  $('wad-map').replaceChildren(...result.maps.map(name => { const option = make('option', name); option.value = name; return option; }));
}
$('local-wad-select').addEventListener('change', guard(loadLocalMaps));
$('import-map').addEventListener('click', async () => {
  if (wadImport || !loadedWad) return;
  const controller = new AbortController(), source = loadedWad, map = $('wad-map').value, scope = $('wad-scope').value;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 300000);
  wadImport = controller;
  $('import-map').disabled = true;
  $('import-map').textContent = 'Importing...';
  $('import-dialog').setAttribute('aria-busy', 'true');
  $('wad-map').disabled = true; $('local-wad-select').disabled = true; $('wad-scope').disabled = true;
  const version = editVersion;
  try {
    const message = scope === 'game' ? `Importing all WAD levels (starting at ${map}); this may take a few minutes...`
      : `Importing ${map}: decoding sectors, images and editable WAD status bar...`;
    status(message); $('import-status').textContent = message; $('import-status').classList.remove('error');
    const result = source.localName
      ? await api('/api/import/local-wad', { method: 'POST', signal: controller.signal, body: JSON.stringify({ name: source.localName, map, scope }) })
      : await api(`/api/import/wad?map=${encodeURIComponent(map)}&scope=${scope}`, {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/octet-stream' }, body: source.buffer,
      });
    if (controller.signal.aborted) return;
    if (version !== editVersion) throw new Error('Project changed during import. Retry to avoid overwriting new edits.');
    const cacheNote = result.cached ? ` Loaded from the decompiled import cache (${Math.round(result.cached.bytes / 1024)} KiB, imported ${new Date(result.cached.importedAt).toLocaleString()}) in place of a full conversion.` : '';
    const summary = `Imported ${result.project.game?.levels.length || 1} level(s), starting at ${map}: ${result.project.assets.length} shared assets.${cacheNote} Use Editing level to edit another map, Play game for the game entry, or the in-game Level selector to play any imported map.`;
    replace(result.project, summary);
    await adoptDocument();
    $('import-summary').textContent = `${summary} Import notes`;
    $('import-warnings').textContent = result.warnings.join('\n');
    $('import-report').hidden = false;
    wadImport = null; closeWadImport();
  } catch (error) {
    if (controller.signal.aborted && !timedOut) { status('WAD import cancelled; project unchanged.'); return; }
    const message = `WAD import failed: ${timedOut ? 'No response within five minutes. Check that the local server is running, then retry.' : error.message}`;
    $('import-status').textContent = message; $('import-status').classList.add('error'); status(message, true);
  } finally {
    clearTimeout(timeout);
    if (wadImport === controller) wadImport = null;
    $('import-map').disabled = false; $('wad-map').disabled = false; $('local-wad-select').disabled = false;
    $('wad-scope').disabled = false;
    $('import-map').textContent = 'Import game & assets'; $('import-dialog').removeAttribute('aria-busy');
  }
});
$('asset-filter').addEventListener('change', renderAssets);
$('package-upload').addEventListener('click', () => $('package-file').click());
async function packageBases() {
  const library = await api('/api/packages');
  $('package-base').replaceChildren(new Option('None (PNG-only or self-contained map)', ''),
    ...library.wads.map(name => new Option(name, name)));
  if (library.wads.includes('freedoom2.wad')) $('package-base').value = 'freedoom2.wad';
  return library;
}
function showPackageImages() {
  const query = $('package-search').value.toLowerCase();
  $('package-images').replaceChildren(...packageInspection.images.filter(path => path.includes(query)).map(path => new Option(path, path)));
  $('package-count').textContent = `${packageInspection.images.length} image resources. Selection is cleared when filtering. Unsupported formats report an error if selected.`;
}
function showPackageInspection(inspection) {
  packageInspection = inspection;
  $('package-scope').value = 'game';
  $('package-map').replaceChildren(new Option('Automatic — game entry level', 'auto'),
    new Option('Extract selected images only', ''),
    ...inspection.maps.map(map => {
      const option = new Option(`${map.name} — ${map.format}${map.supported ? '' : ' (unsupported)'}`, map.id);
      option.disabled = !map.supported; return option;
    }));
  $('package-search').value = ''; showPackageImages();
  $('package-advanced').open = false;
  $('package-kind').value = '';
  const game = inspection.game;
  $('package-game-info').textContent = [game?.title, game?.standalone ? 'Standalone game — no base selected by default.'
    : game?.requiredBase ? `Requires: ${game.requiredBase}` : 'Base game not declared by the mod.',
    game?.entryError || game?.entryReason].filter(Boolean).join(' · ');
  if (game?.standalone) $('package-base').value = '';
  else if (game?.requiredBase) {
    const match = [...$('package-base').options].find(option => option.value.split('/').at(-1).toLowerCase() === game.requiredBase.toLowerCase());
    $('package-base').value = match?.value || '';
  }
  $('package-notes').textContent = inspection.warnings.join('\n');
  $('package-status').textContent = game?.entryError || (game?.standalone
    ? 'Standalone game: Import game directly, or choose a base explicitly if additional resources are needed.'
    : 'Choose the required base game, then Import game.');
}
$('package-library').addEventListener('click', guard(async () => {
  const library = await packageBases();
  if (!library.packages.length) throw new Error('No PK3/IPK3 archives or unpacked resource folders found under Projects');
  $('package-source').replaceChildren(...library.packages.map(item => new Option(`${item.name} (${item.type})`, item.name)));
  $('package-source-label').hidden = false;
  await inspectLocalPackage();
  $('package-dialog').showModal();
}));
// One-click import: choose a local game/mod and convert it immediately with
// automatic entry detection and standalone/declared-base policy.
async function quickImport() {
  const library = await api('/api/packages');
  const wads = (await api('/api/wads')).files;
  if (!library.packages.length && !wads.length) throw new Error('No local games found under Projects. Add a WAD, PK3 or IPK3 there first.');
  const candidates = [...library.packages.map(item => ({ kind: 'package', name: item.name, label: `${item.name} (${item.type})` })),
    ...wads.map(name => ({ kind: 'wad', name, label: `${name} (WAD)` }))];
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', 'Quick import game or mod');
  const heading = document.createElement('h2'); heading.textContent = 'Quick import game or mod';
  const note = document.createElement('p'); note.className = 'muted';
  note.textContent = 'Converts the selected local game into native OpenDLE content: geometry, artwork, HUD, menus and visual scripts. Standalone games need no base; mods use their declared base automatically. Resource-only packages such as brightmaps, lights or actor libraries are listed too but are meant to accompany a game, not replace one.';
  const list = document.createElement('div'); list.className = 'button-row'; list.style.flexWrap = 'wrap';
  const state = document.createElement('p'); state.className = 'muted';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  dialog.append(heading, note, list, state, close);
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  for (const candidate of candidates) {
    const item = document.createElement('button'); item.type = 'button'; item.textContent = candidate.label;
    item.addEventListener('click', async () => {
      item.disabled = true;
      const version = editVersion;
      try {
        state.textContent = `Importing ${candidate.label}... this can take a few minutes for a full game.`;
        const result = candidate.kind === 'wad'
          ? await api('/api/import/local-wad', { method: 'POST', body: JSON.stringify({ name: candidate.name, scope: 'game' }) })
          : await (async () => {
            const inspection = await api('/api/packages/inspect', { method: 'POST', body: JSON.stringify({ name: candidate.name }) });
            const wadName = inspection.game?.requiredBase
              ? [...library.wads].find(name => name.split('/').at(-1).toLowerCase() === inspection.game.requiredBase.toLowerCase())
              : null;
            return api('/api/import/local-package', { method: 'POST', body: JSON.stringify({ name: candidate.name, map: 'auto',
              scope: 'game', ...(wadName ? { base: wadName } : {}) }) });
          })();
        if (version !== editVersion) throw new Error('Project changed during import. Retry to avoid overwriting new edits.');
        const levels = result.project.game?.levels.length || 1;
        const summary = `Imported ${result.project.title}: ${levels} level(s), ${result.project.assets.length} shared assets.${result.cached ? ' Served from the decompiled import cache.' : ''}`;
        replace(result.project, summary);
        await adoptDocument();
        status(summary);
        dialog.close();
      } catch (error) {
        state.textContent = `Import failed: ${error.message}`;
        status(`Import failed: ${error.message}`, true);
      } finally { item.disabled = false; }
    });
    list.append(item);
  }
  dialog.showModal();
}
$('quick-import').addEventListener('click', guard(quickImport));
async function inspectLocalPackage() {
  packageSource = null;
  const name = $('package-source').value;
  showPackageInspection(await api('/api/packages/inspect', { method: 'POST', body: JSON.stringify({ name }) }));
  packageSource = { name };
}
$('package-source').addEventListener('change', guard(async () => {
  $('package-import').disabled = true; $('package-source').disabled = true;
  try { await inspectLocalPackage(); }
  catch (error) { $('package-status').textContent = `Package inspection failed: ${error.message}`; throw error; }
  finally { $('package-import').disabled = false; $('package-source').disabled = false; }
}));
$('package-file').addEventListener('change', guard(async event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return;
  if (file.size > ARCHIVE_LIMIT) throw new Error(`PK3/IPK3/PK7/PKE exceeds the ${ARCHIVE_LIMIT / 1048576} MiB import limit`);
  packageSource = null;
  await packageBases();
  const buffer = await file.arrayBuffer();
  const inspection = await api('/api/packages/upload/inspect', {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buffer,
  });
  packageSource = { buffer }; showPackageInspection(inspection);
  $('package-source-label').hidden = true; $('package-dialog').showModal();
}));
$('package-search').addEventListener('input', () => { if (packageInspection) showPackageImages(); });
function cancelPackage() {
  packageController?.abort(); packageSource = null;
  $('package-dialog').close();
}
$('package-cancel').addEventListener('click', cancelPackage);
$('package-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelPackage(); });
$('package-import').addEventListener('click', async () => {
  if (!packageSource || packageBusy) return;
  const source = packageSource, map = $('package-map').value, base = $('package-base').value, kind = $('package-kind').value,
    scope = $('package-scope').value;
  const paths = [...$('package-images').selectedOptions].map(option => option.value);
  if (!map && (!paths.length || paths.length > 64)) {
    $('package-status').textContent = 'Select 1–64 images, or choose a supported map.'; return;
  }
  const controller = new AbortController(), version = editVersion;
  packageController = controller; packageBusy = true;
  const timeout = setTimeout(() => controller.abort(new Error('Package import timed out after five minutes')), 300000);
  for (const id of ['package-source', 'package-base', 'package-map', 'package-scope', 'package-kind', 'package-search', 'package-images', 'package-import']) $(id).disabled = true;
  $('package-status').textContent = 'Importing package resources...';
  try {
    const query = new URLSearchParams({ map, base, scope, images: paths.map(path => packageInspection.images.indexOf(path)).join(',') });
    const result = source.name
      ? await api('/api/import/local-package', { method: 'POST', signal: controller.signal, body: JSON.stringify({ name: source.name, map, base, paths, scope }) })
      : await api(`/api/import/package?${query}`, { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/octet-stream' }, body: source.buffer });
    if (controller.signal.aborted) return;
    if (version !== editVersion) throw new Error('Project changed during import; retry to preserve new edits');
    let summary;
    if (result.project) {
      summary = result.entry
        ? `Imported ${result.project.title}: ${result.project.game?.levels.length || 1} level(s), entry ${result.entry.map}, ${result.project.assets.length} shared assets.${result.cached ? ' Loaded from the decompiled import cache.' : ''}`
        : `Imported package map: ${result.project.assets.length} images, ${result.project.hud.elements.length} HUD elements.`;
      replace(result.project, summary);
      await adoptDocument();
    } else {
      const assets = result.assets.map(asset => kind ? { ...asset, kind } : asset);
      const additions = assets.filter(asset => !(project.assets || []).some(existing =>
        existing.name === asset.name && existing.src === asset.src && existing.kind === asset.kind));
      summary = `Imported ${additions.length} package images; ${result.assets.length - additions.length} already present.`;
      if (additions.length) edit(next => { (next.assets ||= []).push(...additions.map(asset => ({ ...asset, id: newId('asset') }))); }, summary);
      else status(summary);
    }
    $('import-summary').textContent = `${summary} Import notes`;
    $('import-warnings').textContent = result.warnings.join('\n'); $('import-report').hidden = false;
    packageSource = null; $('package-dialog').close();
  } catch (error) {
    const message = controller.signal.aborted ? controller.signal.reason?.message || 'Package import cancelled; project unchanged.' : error.message;
    $('package-status').textContent = message; status(message, true);
  } finally {
    clearTimeout(timeout); packageBusy = false; packageController = null;
    for (const id of ['package-source', 'package-base', 'package-map', 'package-scope', 'package-kind', 'package-search', 'package-images', 'package-import']) $(id).disabled = false;
  }
});
$('asset-search').addEventListener('input', renderAssets);
$('import-image').addEventListener('click', () => $('image-file').click());
$('import-model').addEventListener('click', () => $('model-file').click());
$('add-sprite-animation').addEventListener('click', guard(() => edit(next => {
  const image = next.assets?.find(asset => ['sprite', 'weapon', 'texture', 'flat'].includes(asset.kind));
  if (!image) throw new Error('Import an image first');
  next.spriteClips ||= [];
  next.spriteClips.push({ id: newId('sprite_clip'), name: 'New sprite animation', frames: [image.id], seconds: .1, loop: true });
})));
$('import-sound').addEventListener('click', () => $('sound-file').click());
async function importSoundFiles(files) {
  if (!files.length) return;
  if (files.length > 64) throw new Error('Import at most 64 sounds at once');
  const imported = [];
  for (const file of files) {
    if (file.size > 8 * 1024 * 1024) throw new Error(`Sound ${file.name} exceeds 8 MiB`);
    const extension = file.name.split('.').pop().toLowerCase();
    const name = file.name.replace(/\.[^.]+$/, '').toUpperCase();
    if (!name || name.length > 100) throw new Error('Sound names must be 1-100 characters');
    imported.push({ name, kind: 'sound', src: encodeSound(new Uint8Array(await file.arrayBuffer()), extension) });
  }
  edit(next => {
    next.assets ||= [];
    for (const asset of imported) {
      const existing = next.assets.find(item => item.kind === 'sound' && item.name === asset.name);
      if (existing) { existing.src = asset.src; delete existing.generated; }
      else next.assets.push({ id: newId('sound'), ...asset });
    }
  });
  $('asset-filter').value = 'sound'; renderAssets();
  status(`Imported ${imported.length} sounds. Matching sound names replace existing effects; use playSound actions in visual rules.`);
}
$('sound-file').addEventListener('change', guard(async event => {
  const files = [...event.target.files]; event.target.value = '';
  await importSoundFiles(files);
}));
$('import-model-folder').addEventListener('click', () => $('model-directory').click());
async function importModelFiles(files) {
  const version = editVersion;
  const sources = files.filter(file => /\.(glb|gltf|bbmodel)$/i.test(file.name));
  if (!sources.length) throw new Error('Select a GLB, glTF or Blockbench .bbmodel export plus any .bin / texture dependencies');
  if (sources.length > 16 || files.length > 300) throw new Error('Import at most 16 models / 300 files at a time');
  const assets = [], warnings = [];
  for (const file of sources) {
    const result = await bundleModel(file, files, newId('asset'));
    // The library shows a snapshot of the model; capturing can fail on odd drivers.
    const preview = await captureModelPreview(result.asset).catch(() => null);
    assets.push(preview ? { ...result.asset, preview } : result.asset); warnings.push(...result.warnings);
  }
  if (version !== editVersion) throw new Error('Project changed during model import. Retry.');
  $('asset-filter').value = 'model'; renderAssets();
  edit(next => { next.assets ||= []; next.assets.push(...assets); }, `${assets.length} models imported. ${warnings.join(' ')}`);
}
$('model-file').addEventListener('change', guard(async event => {
  const files = [...event.target.files]; event.target.value = '';
  await importModelFiles(files);
}));
$('model-directory').addEventListener('change', guard(async event => {
  const files = [...event.target.files]; event.target.value = '';
  await importModelFiles(files);
}));
// Scenes: capture a selection as a reusable group, then place copies of it.
function uniqueSceneName(base) {
  const names = new Set((project.scenes || []).map(scene => scene.name));
  if (!names.has(base)) return base;
  for (let index = 2; ; index++) if (!names.has(`${base} ${index}`)) return `${base} ${index}`;
}
function sceneTargetPoint() {
  if (sceneMode === '3d' && sceneEditor) return sceneEditor.sceneTarget();
  return { x: Math.round(camera.x), y: Math.round(camera.y) };
}
function placeScene(sceneId) {
  const scene = (project.scenes || []).find(item => item.id === sceneId);
  if (!scene) throw new Error('That scene no longer exists');
  if (sceneIsEmpty(scene)) throw new Error(`Scene ${scene.name} has no objects`);
  const target = sceneTargetPoint();
  const placed = instantiateScene(scene, { x: target.x, y: target.y });
  edit(next => {
    next.map.entities.push(...placed.entities);
    next.events.push(...placed.events);
    // A scene's joints come with it, re-pointed at the copied objects.
    if (placed.joints.length) next.map.joints = [...(next.map.joints || []), ...placed.joints];
  }, `Placed ${scene.name} (${placed.entities.length} objects) at ${target.x}, ${target.y}`);
  selection = placed.entities.length ? { kind: 'entity', id: placed.entities[0].id } : selection;
  render();
}
function captureSceneFromSelection(scope) {
  const player = project.map.entities.find(entity => entity.type === 'player');
  let ids, name;
  if (scope === 'object') {
    if (selection?.kind !== 'entity') throw new Error('Select an object in the layout or 3D view first');
    if (selection.id === player?.id) throw new Error('The player object cannot be captured into a scene');
    const entity = project.map.entities.find(item => item.id === selection.id);
    if (!entity) throw new Error('That object no longer exists');
    ids = [entity.id];
    name = entity.name;
  } else {
    const sectorId = selection?.kind === 'sector' ? selection.id
      : selection?.kind === 'entity' ? sectorAt(mapSectors, project.map.entities.find(item => item.id === selection.id)?.x, project.map.entities.find(item => item.id === selection.id)?.y)?.id
        : sectorAt(mapSectors, camera.x, camera.y)?.id;
    if (!sectorId) throw new Error('Select a sector, or an object inside one, to capture its objects');
    ids = project.map.entities.filter(entity => entity.type !== 'player' && sectorAt(mapSectors, entity.x, entity.y)?.id === sectorId).map(entity => entity.id);
    if (!ids.length) throw new Error(`Sector ${sectorId} has no objects to capture`);
    name = `${sectorId} props`;
  }
  const scene = captureScene(project, ids, { name: uniqueSceneName(name) });
  edit(next => { next.scenes ||= []; next.scenes.push(scene); },
    `Scene ${scene.name} captured (${scene.entities.length} objects, ${scene.events.length} events). Place copies from the Scenes filter.`);
  $('asset-filter').value = 'scene'; renderAssets();
}
$('scene-from-object').addEventListener('click', guard(() => captureSceneFromSelection('object')));
$('scene-from-sector').addEventListener('click', guard(() => captureSceneFromSelection('sector')));

/* ---------------------------------------------------------------------------
   Scene objects: a scene opens in its own editor (node tree, view, inspector)
   instead of being only a reusable bag of objects.
--------------------------------------------------------------------------- */
function sceneObjectRow(scene) {
  const row = button('', () => openSceneObject(scene.id), 'scene-object-row');
  row.dataset.sceneId = scene.id;
  const parentCount = scene.entities.filter(entity => entity.parentId).length;
  row.append(make('span', '◆', 'node-glyph node-glyph-scene'), make('span', scene.name, 'node-name'),
    make('span', `${scene.entities.length}`, 'scene-object-count'));
  row.title = `${scene.name}: ${scene.entities.length} object${scene.entities.length === 1 ? '' : 's'}`
    + `${scene.events?.length ? `, ${scene.events.length} event${scene.events.length === 1 ? '' : 's'}` : ''}`
    + `${parentCount ? `, ${parentCount} grouped node${parentCount === 1 ? '' : 's'}` : ''}`;
  row.setAttribute('aria-label', row.title);
  return row;
}
/** Keeps the Layouts section list in step with the project and the open scene. */
function renderSceneObjects() {
  const list = $('scene-objects');
  if (!list) return;
  list.replaceChildren();
  const scenes = project?.scenes || [];
  if (!scenes.length) {
    list.append(make('p', 'No scene objects yet. Capture a selection or press + Scene Object.', 'muted scene-empty'));
    return;
  }
  for (const scene of scenes) {
    const row = sceneObjectRow(scene);
    row.classList.toggle('active', scene.id === activeSceneId);
    list.append(row);
  }
}
function ensureSceneObjectEditor() {
  if (sceneObjectEditor) return sceneObjectEditor;
  sceneObjectEditor = createSceneObjectEditor({
    callbacks: {
      scenes: () => project?.scenes || [],
      openScenes: () => openSceneIds,
      assets: () => project?.assets || [],
      shaders: () => project?.shaders || [],
      entities: () => project?.map?.entities || [],
      editScene(id, fn, message) {
        editGame(next => {
          const scene = (next.scenes || []).find(item => item.id === id);
          if (!scene) throw new Error('That scene object no longer exists');
          fn(scene);
          if (scene.id === activeSceneId && scene.name !== undefined) {
            const tab = document.querySelector(`.scene-tab[data-scene-id="${scene.id}"]`);
            if (tab) tab.querySelector('.scene-tab-name').textContent = scene.name;
          }
        }, message);
        renderSceneObjects();
        sceneObjectEditor?.render();
      },
      openScene: id => openSceneObject(id),
      closeScene(id) {
        openSceneIds = openSceneIds.filter(candidate => candidate !== id);
        sceneObjectEditor?.close(id);
        if (activeSceneId === id) {
          activeSceneId = openSceneIds.at(-1) || null;
          if (activeSceneId) sceneObjectEditor?.open(activeSceneId);
          else showTab('map');
        }
        renderSceneObjects();
        renderSceneObjectTabs();
      },
      chooseScene: () => {
        const scenes = project?.scenes || [];
        if (!scenes.length) { status('There are no scene objects yet; press + Scene Object to make one.', true); return; }
        const names = scenes.map((scene, index) => `${index + 1}. ${scene.name}`);
        const answer = prompt(`Open which scene object?\n${names.join('\n')}\n\nType a number.`,
          String(scenes.findIndex(scene => scene.id === activeSceneId) + 1 || 1));
        if (!answer) return;
        const index = Number(answer) - 1;
        if (!Number.isInteger(index) || !scenes[index]) { status('That is not a scene object number', true); return; }
        openSceneObject(scenes[index].id);
      },
      placeScene(id) {
        placeScene(id);
        status(`Placed ${(project.scenes || []).find(scene => scene.id === id)?.name || 'the scene'} in the layout; press Layout 1 to see it.`);
      },
      captureInto(id) {
        try {
          captureIntoSceneObject(id);
        } catch (error) { status(error.message, true); }
      },
      deleteScene(id) {
        const scene = (project.scenes || []).find(item => item.id === id);
        if (!scene) return;
        if (!confirm(`Delete the scene object "${scene.name}"? Objects already placed from it in the layout are kept.`)) return;
        edit(next => { next.scenes = (next.scenes || []).filter(item => item.id !== id); }, `Scene ${scene.name} deleted`);
        openSceneIds = openSceneIds.filter(candidate => candidate !== id);
        sceneObjectEditor?.close(id);
        activeSceneId = openSceneIds.at(-1) || null;
        if (activeSceneId) sceneObjectEditor?.open(activeSceneId); else showTab('map');
        renderSceneObjects();
      },
      importNode: (document, options) => importNodeDocument(document, options),
      openEvents: ownerId => openScript(ownerId),
      status: (message, isError) => status(message, isError),
    },
  });
  return sceneObjectEditor;
}
function renderSceneObjectTabs() {
  const strip = $('scene-tabs');
  if (!strip) return;
  strip.replaceChildren();
  for (const id of openSceneIds) {
    const scene = (project?.scenes || []).find(item => item.id === id);
    if (!scene) continue;
    const tab = make('button', null, 'scene-tab');
    tab.dataset.sceneId = id;
    tab.classList.toggle('active', id === activeSceneId);
    tab.append(make('span', null, 'scene-tab-icon'), make('span', scene.name, 'scene-tab-name'));
    const close = make('span', '×', 'scene-tab-close');
    close.title = 'Close this scene object';
    close.addEventListener('click', event => {
      event.stopPropagation();
      openSceneIds = openSceneIds.filter(candidate => candidate !== id);
      if (activeSceneId === id) {
        activeSceneId = openSceneIds.at(-1) || null;
        if (activeSceneId) sceneObjectEditor?.open(activeSceneId);
        else showTab('map');
      }
      renderSceneObjects();
      renderSceneObjectTabs();
    });
    tab.append(close);
    tab.addEventListener('click', () => openSceneObject(id));
    strip.append(tab);
  }
  const add = make('button', '+', 'scene-tab-add');
  add.title = 'Open another scene object';
  add.addEventListener('click', guard(() => {
    const scenes = project?.scenes || [];
    if (!scenes.length) { createSceneObject(); return; }
    const names = scenes.map((scene, index) => `${index + 1}. ${scene.name}`);
    const answer = prompt(`Open which scene object?\n${names.join('\n')}\n\nType a number.`, '1');
    if (!answer) return;
    const scene = scenes[Number(answer) - 1];
    if (scene) openSceneObject(scene.id);
  }));
  strip.append(add);
}
function openSceneObject(id) {
  const scene = (project?.scenes || []).find(item => item.id === id);
  if (!scene) { status('That scene object no longer exists', true); return; }
  if (!openSceneIds.includes(id)) openSceneIds.push(id);
  activeSceneId = id;
  showTab('scene');
  const editor = ensureSceneObjectEditor();
  editor.open(id);
  renderSceneObjectTabs();
  renderSceneObjects();
  status(`Editing scene object "${scene.name}"`);
}
function createSceneObject() {
  const scene = newScene(uniqueSceneName('Scene Object'));
  edit(next => { next.scenes ||= []; next.scenes.push(scene); }, `Scene object ${scene.name} created`);
  renderSceneObjects();
  openSceneObject(scene.id);
}
/** Adds the layout's selected objects to an open scene, keeping their relative layout. */
function captureIntoSceneObject(id) {
  const scene = (project.scenes || []).find(item => item.id === id);
  if (!scene) throw new Error('That scene object no longer exists');
  const player = project.map.entities.find(entity => entity.type === 'player');
  let ids;
  if (selection?.kind === 'entity') ids = [selection.id];
  else if (selection?.kind === 'sector') {
    ids = project.map.entities.filter(entity => sectorAt(mapSectors, entity.x, entity.y)?.id === selection.id).map(entity => entity.id);
  } else {
    // The layout is not visible while a scene object is open, so say where to select.
    throw new Error('Select an object or a sector in Layout 1 (this scene stays open in its tab), then use Edit > Capture selected layout objects');
  }
  ids = ids.filter(entityId => entityId !== player?.id);
  if (!ids.length) throw new Error('Nothing in the layout is selected to add');
  const captured = captureScene(project, ids, { name: scene.name });
  edit(next => {
    const target = next.scenes.find(item => item.id === id);
    const existing = new Set(target.entities.map(entity => entity.id));
    for (const entity of captured.entities) {
      const copy = { ...entity, id: existing.has(entity.id) ? `${entity.id}_${newId('n').slice(2, 8)}` : entity.id };
      target.entities.push(copy);
    }
    target.events = [...(target.events || []), ...captured.events];
  }, `${captured.entities.length} object(s) added to ${scene.name}`);
  renderSceneObjects();
  sceneObjectEditor?.render();
}
$('new-scene-object').addEventListener('click', guard(createSceneObject));
async function importImageFiles(files, kind) {
  if (files.length > 64) throw new Error('Import at most 64 images at a time');
  const version = editVersion;
  const assets = [];
  for (const file of files) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 6 * 1024 * 1024) throw new Error('Use PNG, JPEG or WebP images no larger than 6 MiB');
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width > 2048 || bitmap.height > 2048) throw new Error(`${file.name} exceeds 2048x2048`);
      const surface = document.createElement('canvas');
      surface.width = bitmap.width; surface.height = bitmap.height;
      surface.getContext('2d').drawImage(bitmap, 0, 0);
      const asset = { id: newId('asset'), name: file.name.slice(0, 100), kind, width: bitmap.width, height: bitmap.height, src: surface.toDataURL('image/png') };
      if (kind === 'sprite') { asset.offsetX = bitmap.width / 2; asset.offsetY = bitmap.height; }
      assets.push(asset);
    } finally { bitmap.close(); }
  }
  if (version !== editVersion) throw new Error('Project changed during image import. Retry.');
  edit(next => { next.assets ||= []; next.assets.push(...assets); }, `${assets.length} images imported`);
}
$('image-file').addEventListener('change', guard(async event => {
  const files = [...event.target.files];
  event.target.value = '';
  await importImageFiles(files, $('image-kind').value);
}));
// Dropping on the asset browser imports without opening a file dialog: model
// sources (with their .bin/texture dependencies), images into the selected image
// category, sounds as sound effects. Folders are read recursively.
async function dropAssets(event) {
  const files = await readDroppedFiles(event.dataTransfer);
  const group = groupDroppedFiles(files);
  const section = event.target.closest?.('.asset-folder')?.dataset.filter;
  if (group.nodes.length) return importDroppedNodes(group.nodes);
  if (group.models.length) return importModelFiles(group.models);
  if (group.images.length) return importImageFiles(group.images, IMAGE_KINDS.has(section) ? section : $('image-kind').value);
  if (group.sounds.length) return importSoundFiles(group.sounds);
  throw new Error('Drop GLB, glTF, .bbmodel, PNG/JPEG/WebP images or WAV/OGG/MP3 sounds');
}
/** A dropped `.node` file is a scene object: import it where the pointer is. */
async function importDroppedNodes(files) {
  for (const file of files) {
    const document = parseNodeFile(await file.text());
    const target = sceneObjectEditor?.viewPoint?.() || { x: 0, y: 0 };
    importNodeDocument(document, target);
  }
}

const assetDropTarget = $('assets-panel');
assetDropTarget.addEventListener('dragover', event => {
  if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  assetDropTarget.classList.add('drop-target');
});
assetDropTarget.addEventListener('dragleave', event => {
  if (!assetDropTarget.contains(event.relatedTarget)) assetDropTarget.classList.remove('drop-target');
});
assetDropTarget.addEventListener('drop', guard(async event => {
  event.preventDefault();
  assetDropTarget.classList.remove('drop-target');
  await dropAssets(event);
}));
$('add-event').addEventListener('click', () => addScriptEvent());
$('add-group').addEventListener('click', guard(() => {
  const group = { id: newId('group'), name: 'New group', enabled: true };
  if (scriptScope.startsWith('$sheet:')) group.sheetId = scriptScope.slice(7);
  edit(next => { next.eventGroups ||= []; next.eventGroups.push(group); }, 'Event group added');
  editEventGroup(group);
}));
$('script-scope').addEventListener('change', () => {
  scriptScope = $('script-scope').value;
  if (!['$all', '$scene'].includes(scriptScope) && !scriptScope.startsWith('$sheet:')) selection = { kind: 'entity', id: scriptScope };
  render();
});
$('scene-script').addEventListener('click', () => openScript('$scene'));
$('layout-events').addEventListener('click', () => openScript('$all'));
$('install-engine').addEventListener('click', guard(() => {
  if (confirm('Install editable FPS starter rules and switch movement to event scripts? This is NOT complete Doom compatibility. Existing rules are preserved.')) {
    edit(installEngineScripts, 'Editable Engine starter installed; existing rules preserved');
    openScript(`$sheet:${project.eventSheets.find(sheet => sheet.section === 'engine').id}`);
  }
}));
$('add-sheet').addEventListener('click', guard(() => {
  const id = newId('sheet');
  edit(next => {
    next.eventSheets ||= [];
    next.eventSheets.push({ id, name: `Event sheet ${next.eventSheets.length + 1}`, section: 'game', enabled: true, phase: 'afterPhysics' });
  }, 'Event sheet created');
  openScript(`$sheet:${id}`);
}));
$('ask-ai').addEventListener('click', guard(async () => {
  const prompt = $('prompt').value.trim();
  if (!prompt) throw new Error('Describe the edit you want first');
  if (!confirm('Send the project and your instruction to DeepSeek? Current edits will first be saved to the local server.')) return;
  $('ask-ai').disabled = true;
  try {
    await saveProject();
    if (dirty) throw new Error('Project changed while saving. Save the new edits and request a fresh proposal.');
    const baseVersion = editVersion;
    $('ai-result').textContent = 'DeepSeek is preparing a tool-driven draft...';
    const result = await api('/api/ai', { method: 'POST', body: JSON.stringify({ prompt, revision }) });
    if (editVersion !== baseVersion) throw new Error('Project was edited during the request. Draft was not applied; request a new one.');
    validateProject(result.project);
    pendingAI = { ...result, baseVersion };
    $('ai-draft').hidden = false;
    $('ai-project').textContent = JSON.stringify(result.project, null, 2);
    $('ai-result').textContent = `${result.explanation}\n\nTools: ${result.changes.join(', ') || 'No edits proposed'}\nReview the explanation; applying is undoable.`;
    $('apply-ai').hidden = result.changes.length === 0; $('discard-ai').hidden = false;
    status('AI draft ready for review; your project is unchanged');
  } catch (error) {
    $('ai-result').textContent = error.message;
    throw error;
  } finally { $('ask-ai').disabled = false; }
}));
$('discard-ai').addEventListener('click', () => {
  clearDraft(); $('ai-result').textContent = 'Draft discarded.';
});
$('apply-ai').addEventListener('click', guard(async () => {
  if (!pendingAI || pendingAI.baseVersion !== editVersion) throw new Error('Draft is stale; request a fresh proposal');
  const snapshot = await api('/api/project');
  if (snapshot.revision !== pendingAI.revision) throw new Error('Server project changed. Reload it and request a fresh proposal.');
  replace(pendingAI.project, 'AI draft applied locally. Review the world, then save when ready.');
  $('ai-result').textContent = 'Draft applied. You can undo this change.';
}));
/* ---------------------------------------------------------------------------
   Context menus

   Every list, tile and view answers a right click with the actions that apply to what is
   under the pointer, so the editor behaves the same way everywhere instead of going
   silent outside the scene tree.
   ------------------------------------------------------------------------- */

function selectionEntity() {
  return project.map.entities.find(entity => entity.id === selection?.id) || null;
}

function assetUseOf(asset) {
  if (asset?.kind === 'model') return 'model';
  return ['sprite', 'weapon', 'flat', 'texture', 'sky', 'image', 'hud'].includes(asset?.kind) ? 'sprite' : null;
}

/** Applies an asset to the object selected in the layout, the way a drop would. */
function assignAssetToSelection(asset) {
  const entity = selectionEntity();
  if (!entity) throw new Error('Select an object in the layout first');
  const use = assetUseOf(asset);
  if (!use) throw new Error(`${asset.name} is a ${asset.kind} asset; objects take pictures or models`);
  if (use === 'model' && entity.type === 'player') throw new Error('Assign world models to a non-player object');
  edit(next => {
    const target = next.map.entities.find(item => item.id === entity.id);
    if (!target) throw new Error('That object no longer exists');
    if (use === 'model') { target.modelAsset = asset.id; delete target.animation; return; }
    target.spriteAsset = asset.id;
    if (target.modelAsset) { delete target.modelAsset; delete target.animation; }
  }, `${asset.name} assigned to ${entity.name}`);
  render();
}

function renameAsset(asset) {
  const answer = prompt('Asset name', asset.name);
  if (answer === null) return;
  const clean = answer.trim().slice(0, 100);
  if (!clean || clean === asset.name) return;
  edit(next => {
    const target = next.assets.find(item => item.id === asset.id);
    if (!target) throw new Error('That asset no longer exists');
    target.name = clean;
  }, `Asset renamed to ${clean}`);
}

function renameSceneObject(id) {
  const scene = (project.scenes || []).find(item => item.id === id);
  if (!scene) throw new Error('That scene object no longer exists');
  const answer = prompt('Scene object name', scene.name);
  if (answer === null) return;
  const clean = answer.trim().slice(0, 100);
  if (!clean || clean === scene.name) return;
  edit(next => {
    const target = (next.scenes || []).find(item => item.id === id);
    if (!target) throw new Error('That scene object no longer exists');
    target.name = clean;
  }, `Scene object renamed to ${clean}`);
  renderSceneObjects();
  renderSceneObjectTabs();
  if (activeSceneId === id) sceneObjectEditor?.render();
}

function duplicateLayoutObject(id) {
  const entity = project.map.entities.find(item => item.id === id);
  if (!entity) throw new Error('That object no longer exists');
  if (entity.type === 'player') throw new Error('The layout keeps exactly one player object');
  const copyId = newId('entity');
  edit(next => {
    const source = next.map.entities.find(item => item.id === id);
    const copy = structuredClone(source);
    copy.id = copyId;
    copy.name = `${source.name} copy`.slice(0, 100);
    copy.x += 64; copy.y += 64;
    delete copy.parentId;
    next.map.entities.push(copy);
  }, `${entity.name} duplicated`);
  selection = { kind: 'entity', id: copyId };
  render();
}

function deleteLayoutObject(id) {
  const entity = project.map.entities.find(item => item.id === id);
  if (!entity) throw new Error('That object no longer exists');
  if (entity.type === 'player') throw new Error('The layout must keep the player object');
  const count = project.events.filter(event => event.ownerId === id).length;
  if (count && !confirm(`Delete ${entity.name} and its ${count} attached events? You can undo this change.`)) return;
  edit(next => removeEntity(next, id), 'Object deleted');
  if (selection?.id === id) selection = null;
  render();
}

function setSectorLight(sector) {
  const answer = prompt(`Light level of ${sector.id} (0-255)`, String(sector.light ?? 160));
  if (answer === null) return;
  const value = Math.round(Number(answer));
  if (!Number.isFinite(value)) { status('A light level is a number between 0 and 255', true); return; }
  const light = Math.max(0, Math.min(255, value));
  edit(next => {
    const target = next.map.sectors.find(item => item.id === sector.id);
    if (!target) throw new Error('That sector no longer exists');
    target.light = light;
  }, `Sector ${sector.id} light ${light}`);
  render();
}

function copyText(text, label) {
  navigator.clipboard?.writeText(text).then(() => status(`Copied ${label}`),
    () => status(`Clipboard access was refused; ${label} is ${text}`, true));
}

function assetTileMenu(tile, event) {
  const sceneId = tile.dataset.sceneId;
  if (sceneId) {
    const scene = (project.scenes || []).find(item => item.id === sceneId);
    if (!scene) return;
    contextMenu(event, [
      { label: 'Open in the scene object editor', run: () => openSceneObject(scene.id) },
      { label: 'Place at the view', run: () => guard(() => placeScene(scene.id))() },
      { label: 'Rename\u2026', run: guard(() => renameSceneObject(scene.id)) },
      { separator: true },
      { label: 'Delete scene object', danger: true, run: guard(() => {
        if (!confirm(`Delete the scene object "${scene.name}"? Objects already placed from it are kept.`)) return;
        edit(next => { next.scenes = (next.scenes || []).filter(item => item.id !== scene.id); }, `Scene ${scene.name} deleted`);
        openSceneIds = openSceneIds.filter(candidate => candidate !== scene.id);
        if (activeSceneId === scene.id) { activeSceneId = openSceneIds.at(-1) || null; if (activeSceneId) sceneObjectEditor?.open(activeSceneId); }
        renderSceneObjects();
        renderSceneObjectTabs();
        renderAssets();
      }) },
    ], { label: `${scene.name} actions` });
    return;
  }
  const asset = (project.assets || []).find(item => item.id === tile.dataset.assetId);
  if (!asset) return;
  const entity = selectionEntity();
  const use = assetUseOf(asset);
  const items = [{
    label: entity ? `Assign ${asset.name} to ${entity.name}` : 'Assign to the selected object',
    disabled: !entity || !use || (use === 'model' && entity.type === 'player'),
    run: guard(() => assignAssetToSelection(asset)),
  }];
  if (asset.kind === 'music') {
    items.push({ label: 'Set as the level music', run: guard(() => edit(next => {
      next.environment = { ...next.environment, music: asset.name, musicAsset: asset.id };
    }, `Level music set to ${asset.name}`)) });
  }
  if (asset.kind === 'weapon') {
    items.push({ label: 'Use as the weapon overlay', run: guard(() => edit(next => { next.environment.weaponAsset = asset.id; })) });
  }
  if (asset.kind === 'sky') {
    items.push({ label: 'Use as the sky panorama', run: guard(() => edit(next => {
      next.environment.skyAsset = asset.id; next.environment.skyMode = 'panorama'; delete next.environment.skybox;
    })) });
  }
  items.push({ separator: true });
  items.push({ label: 'Rename asset\u2026', run: guard(() => renameAsset(asset)) });
  items.push({ label: 'Copy name', run: () => copyText(asset.name, `"${asset.name}"`) });
  contextMenu(event, items, { label: `${asset.name} actions` });
}

function objectTileMenu(id, event) {
  const entity = project.map.entities.find(item => item.id === id);
  if (!entity) return;
  contextMenu(event, objectMenuItems(entity), { label: `${entity.name} actions` });
}

function eventCardMenu(id, event) {
  const rule = project.events.find(item => item.id === id);
  if (!rule) return;
  const index = project.events.indexOf(rule);
  const siblings = siblingRules(rule);
  const position = siblings.indexOf(rule);
  contextMenu(event, [
    { label: 'Enabled', checked: rule.enabled, run: guard(() => edit(next => {
      next.events[index].enabled = !next.events[index].enabled;
    }, 'Rule enabled toggled')) },
    { label: 'Run once', checked: rule.once, run: guard(() => edit(next => {
      next.events[index].once = !next.events[index].once;
    }, 'Rule once toggled')) },
    { separator: true },
    { label: 'Move up', disabled: position <= 0, run: guard(() => edit(next => moveEventBranch(next, rule.id, -1), 'Rule moved up')) },
    { label: 'Move down', disabled: position < 0 || position >= siblings.length - 1,
      run: guard(() => edit(next => moveEventBranch(next, rule.id, 1), 'Rule moved down')) },
    { separator: true },
    { label: 'Delete this rule and its sub-events', danger: true,
      run: guard(() => edit(next => removeEventBranch(next, rule.id), 'Rule deleted')) },
  ], { label: 'Rule actions' });
}

/**
 * Installs a `.node` file's artwork and shaders, then places its nodes in the open scene.
 * It is one edit, so the whole import is a single undo step.
 */
function importNodeDocument(document, options = {}) {
  const sceneId = activeSceneId || project.scenes?.[0]?.id;
  if (!sceneId) throw new Error('Create a scene object before importing a .node file');
  const plan = planNodeFileInstall(document, { assets: project.assets || [], shaders: project.shaders || [] });
  let imported = null;
  editGame(next => {
    next.assets ||= [];
    next.shaders ||= [];
    next.assets.push(...plan.addAssets);
    next.shaders.push(...plan.addShaders);
    const scene = (next.scenes || []).find(item => item.id === sceneId);
    if (!scene) throw new Error('That scene object no longer exists');
    imported = applyNodeFile(scene, document, { ...options, assetRemap: plan.assetRemap, shaderRemap: plan.shaderRemap });
  }, `Imported ${document.nodes.length} node(s) from ${document.name}`);
  renderSceneObjects();
  const notes = [...(document.warnings || [])];
  if (plan.addAssets.length) notes.push(`${plan.addAssets.length} asset(s) added`);
  status(`Imported "${document.name}" (${document.nodes.length} node(s)${notes.length ? `; ${notes.join('; ')}` : ''})`);
  return imported;
}

/** Picks artwork for the layout object under the pointer, sprites and models together. */
function pickAssetForEntity(entity) {
  openAssetPicker({
    anchor: $('map-canvas'),
    title: `Artwork for ${entity.name}`,
    assets: project.assets || [],
    kinds: [...PICTURE_KINDS, ...MODEL_KINDS],
    value: entity.spriteAsset || entity.modelAsset || '',
    emptyText: 'No pictures or models yet. Import a WAD, images or a model first.',
    onPick: asset => { selection = { kind: 'entity', id: entity.id }; guard(() => assignAssetToSelection(asset))(); },
  });
}

/** Places the entity type chosen in the toolbar at a layout point. */
function placeLayoutObject(position, elevation = 0) {
  const type = $('entity-type').value;
  edit(next => {
    if (type === 'player') Object.assign(next.map.entities.find(entity => entity.type === 'player'), position);
    else next.map.entities.push({ id: newId('entity'), type, name: `${type[0].toUpperCase()}${type.slice(1)}`, ...position, elevation, angle: 0,
      ...(type === 'light' ? { light: { color: '#ffbd72', intensity: 1, radius: 192 } } : {}) });
  }, `${type} placed`);
}

function objectMenuItems(entity) {
  const isPlayer = entity.type === 'player';
  return [
    { label: 'Select', run: () => { selection = { kind: 'entity', id: entity.id }; render(); } },
    { label: 'Edit its visual script', run: () => openScript(entity.id) },
    { label: 'Assign sprite or model\u2026', run: guard(() => pickAssetForEntity(entity)) },
    { separator: true },
    { label: 'Duplicate 64 units away', disabled: isPlayer, run: guard(() => duplicateLayoutObject(entity.id)) },
    { label: 'Capture as a scene object', disabled: isPlayer, run: guard(() => {
      selection = { kind: 'entity', id: entity.id };
      render();
      captureSceneFromSelection('object');
    }) },
    { separator: true },
    { label: 'Delete object', danger: !isPlayer, disabled: isPlayer, run: guard(() => deleteLayoutObject(entity.id)) },
  ];
}

function sectorMenuItems(sector) {
  return [
    { label: 'Select', run: () => { selection = { kind: 'sector', id: sector.id }; renderInspector(); mapNeedsDraw = true; } },
    { label: 'Set light level\u2026', run: guard(() => setSectorLight(sector)) },
    { label: 'Capture its objects as a scene', run: guard(() => {
      selection = { kind: 'sector', id: sector.id };
      captureSceneFromSelection('sector');
    }) },
    { label: 'Copy sector id', run: () => copyText(sector.id, sector.id) },
  ];
}

/** Right click in the 2D layout: act on whatever is under the pointer. */
function mapCanvasMenu(event) {
  const point = worldPoint(event);
  const hit = hitTest(point);
  const position = snap(point);
  const items = [];
  if (hit?.kind === 'entity') {
    const entity = project.map.entities.find(item => item.id === hit.id);
    if (entity) items.push(...objectMenuItems(entity), { separator: true });
  } else if (hit?.kind === 'sector') {
    const sector = project.map.sectors.find(item => item.id === hit.id);
    if (sector) items.push(...sectorMenuItems(sector), { separator: true });
  } else if (hit) {
    items.push({ label: `Select ${hit.kind} ${hit.id}`, run: () => { selection = { ...hit }; render(); } },
      { label: 'Copy id', run: () => copyText(hit.id, hit.id) }, { separator: true });
  }
  items.push(
    { label: `Place ${$('entity-type').value} here`, run: guard(() => placeLayoutObject(position)) },
    { label: 'Fit the map in the view', run: () => { fitMap(); mapNeedsDraw = true; } },
    { separator: true },
    { label: 'Copy coordinates', run: () => copyText(`${position.x}, ${position.y}`, `${position.x}, ${position.y}`) });
  contextMenu(event, items, { label: 'Layout actions' });
}

/** Right click in the 3D view, with the object the ray hit (the view selects nothing). */
function mapViewMenu(event, picked) {
  const entity = picked?.kind === 'entity' ? project.map.entities.find(item => item.id === picked.id) : null;
  const sector = picked?.kind === 'sector' ? project.map.sectors.find(item => item.id === picked.id) : null;
  if (!entity && !sector) {
    contextMenu(event, [
      { label: `Place ${$('entity-type').value} at the view centre`, run: guard(() => {
        placeLayoutObject({ x: Math.round(camera.x), y: Math.round(camera.y) });
      }) },
      { label: 'Copy view coordinates', run: () => copyText(`${Math.round(camera.x)}, ${Math.round(camera.y)}`, `${Math.round(camera.x)}, ${Math.round(camera.y)}`) },
    ], { label: '3D view actions' });
    return;
  }
  if (sector) { contextMenu(event, sectorMenuItems(sector), { label: `${sector.id} actions` }); return; }
  selection = { kind: 'entity', id: entity.id };
  render();
  contextMenu(event, objectMenuItems(entity), { label: `${entity.name} actions` });
}

/**
 * Right-clicking the empty part of a list opens that area's own actions, so a menu is
 * never missing just because the pointer missed a row. Every menu here offers the thing
 * you would otherwise have to hunt for in a toolbar.
 */
function emptyAreaMenus() {
  const menus = [
    [$('scene-tree'), 'Node tree', () => [
      { label: 'Add a node', run: guard(() => { if (activeSceneId) ensureSceneObjectEditor().addNode(); else status('Open a scene object first', true); }) },
      { label: 'Capture the selected layout objects', run: guard(() => { if (activeSceneId) captureIntoSceneObject(activeSceneId); else status('Open a scene object first', true); }) },
      { separator: true },
      { label: 'New scene object', run: guard(() => createSceneObject()) },
      { label: 'Place this scene in the layout', run: guard(() => { if (activeSceneId) placeScene(activeSceneId); }) },
    ]],
    [$('scene-tabs'), 'Scene object tabs', () => [
      { label: 'New scene object', run: guard(() => createSceneObject()) },
      { label: 'Open another scene object\u2026', run: guard(() => ensureSceneObjectEditor().choose()) },
    ]],
    [$('scene-properties'), 'Inspector', () => [
      { label: 'Show every property', run: () => sceneInspectorAction('expand') },
      { label: 'Fold every category', run: () => sceneInspectorAction('collapse') },
      { separator: true },
      { label: 'Clear the property filter', run: () => sceneInspectorAction('clear') },
    ]],
    [$('scene-objects'), 'Scene objects', () => [
      { label: 'New scene object', run: guard(() => createSceneObject()) },
      { label: 'Capture the selected layout objects', run: guard(() => { if (selection) captureSceneFromSelection(selection.kind === 'sector' ? 'sector' : 'object'); else status('Select objects in the layout first', true); }) },
    ]],
    [$('asset-list'), 'Assets', () => [
      { label: 'Show every asset', run: () => { $('asset-filter').value = 'all'; $('asset-search').value = ''; renderAssets(); } },
      { label: 'Show the scene objects', run: () => { $('asset-filter').value = 'scene'; renderAssets(); } },
      { separator: true },
      { label: 'Import a game or an archive\u2026', run: guard(() => showWadImport()) },
      { label: 'New scene object', run: guard(() => createSceneObject()) },
    ]],
    [$('event-list'), 'Event sheet', () => [
      { label: 'Add an event', run: guard(() => addScriptEvent()) },
      { label: 'Open the sheet properties', run: () => { $('sheet-properties').scrollIntoView({ block: 'nearest' }); } },
      { separator: true },
      { label: 'Collapse every rule', run: () => { for (const event of project.events) collapsedEvents.add(event.id); renderEvents(); } },
    ]],
    [$('entities'), 'Objects', () => [
      { label: 'Place the chosen object type at the view centre', run: guard(() => placeLayoutObject({ x: Math.round(camera.x), y: Math.round(camera.y) })) },
      { label: 'New object script sheet', run: guard(() => attachObjectScriptSheet()) },
      { separator: true },
      { label: 'Fit the map in the view', run: () => { fitMap(); mapNeedsDraw = true; } },
    ]],
    [$('sector-list'), 'Sectors', () => [
      { label: 'Fit the map in the view', run: () => { fitMap(); mapNeedsDraw = true; } },
      { label: 'Open the layout', run: () => showTab('map') },
    ]],
    [$('project-objects'), 'Project objects', () => [
      { label: 'New object script sheet', run: guard(() => attachObjectScriptSheet()) },
    ]],
    [$('object-scripts'), 'Object scripts', () => [
      { label: 'New object script sheet', run: guard(() => attachObjectScriptSheet()) },
    ]],
  ];
  for (const [element, label, items] of menus) {
    if (!element) continue;
    element.addEventListener('contextmenu', event => {
      // A row's own menu wins; this only answers the empty space around the rows.
      if (event.defaultPrevented) return;
      const row = event.target.closest('[data-object-id], [data-scene-id], [data-event-id], .node-row, button');
      if (row && element.contains(row)) return;
      event.preventDefault();
      contextMenu(event, items(), { label: `${label} actions` });
    });
  }
}

/** The scene object editor's own toolbar actions, reachable from the inspector menu. */
function sceneInspectorAction(action) {
  const button = $('scene-inspector-menu');
  if (!button) return;
  button.click();
  const menu = $('scene-menu');
  const wanted = action === 'expand' ? 0 : action === 'collapse' ? 1 : 3;
  menu?.querySelectorAll('button')[wanted]?.click();
}

function installContextMenus() {
  $('asset-list').addEventListener('contextmenu', event => {
    const tile = event.target.closest('.asset-tile');
    if (!tile) return;
    event.preventDefault();
    assetTileMenu(tile, event);
  });
  for (const id of ['entities', 'project-objects']) {
    $(id).addEventListener('contextmenu', event => {
      const tile = event.target.closest('[data-object-id]');
      if (!tile) return;
      event.preventDefault();
      objectTileMenu(tile.dataset.objectId, event);
    });
  }
  $('event-list').addEventListener('contextmenu', event => {
    const card = event.target.closest('.event-card');
    if (!card) return;
    event.preventDefault();
    eventCardMenu(card.dataset.eventId, event);
  });
  $('sector-list').addEventListener('contextmenu', event => {
    const button = event.target.closest('button');
    if (!button) return;
    event.preventDefault();
    const sector = project.map.sectors.find(item => button.textContent.startsWith(`${item.id} /`));
    if (!sector) return;
    contextMenu(event, [
      { label: `Select ${sector.id}`, run: () => {
        selection = { kind: 'sector', id: sector.id }; renderInspector(); mapNeedsDraw = true;
      } },
      { label: 'Set light level\u2026', run: guard(() => setSectorLight(sector)) },
      { label: 'Capture its objects as a scene', run: guard(() => {
        selection = { kind: 'sector', id: sector.id };
        captureSceneFromSelection('sector');
      }) },
      { separator: true },
      { label: 'Copy sector id', run: () => copyText(sector.id, sector.id) },
    ], { label: `${sector.id} actions` });
  });
  emptyAreaMenus();
  $('scene-objects').addEventListener('contextmenu', event => {
    const row = event.target.closest('.scene-object-row');
    if (!row?.dataset.sceneId) return;
    event.preventDefault();
    const scene = (project.scenes || []).find(item => item.id === row.dataset.sceneId);
    if (!scene) return;
    contextMenu(event, [
      { label: 'Open in the scene object editor', run: () => openSceneObject(scene.id) },
      { label: 'Place at the view', run: guard(() => placeScene(scene.id)) },
      { label: 'Rename\u2026', run: guard(() => renameSceneObject(scene.id)) },
      { label: 'Capture the selected layout objects', run: guard(() => captureIntoSceneObject(scene.id)) },
      { separator: true },
      { label: 'Delete scene object', danger: true, run: guard(() => {
        if (!confirm(`Delete the scene object "${scene.name}"? Objects already placed from it are kept.`)) return;
        edit(next => { next.scenes = (next.scenes || []).filter(item => item.id !== scene.id); }, `Scene ${scene.name} deleted`);
        openSceneIds = openSceneIds.filter(candidate => candidate !== scene.id);
        if (activeSceneId === scene.id) { activeSceneId = openSceneIds.at(-1) || null; if (activeSceneId) sceneObjectEditor?.open(activeSceneId); }
        renderSceneObjects();
        renderSceneObjectTabs();
      }) },
    ], { label: `${scene.name} actions` });
  });
}

installContextMenus();
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });

async function start() {
  const accepted = await requireLicenseAgreement({
    dialog: $('license-dialog'), text: $('license-text'), accept: $('license-accept'),
    decline: $('license-decline'), message: $('license-message'),
  });
  if (!accepted) {
    $('license-accept').hidden = true; $('license-decline').hidden = true;
    $('license-message').textContent = 'License declined. The editor is closed. You can close this tab or reload to review the license again.';
    window.close();
    return;
  }
  const response = await fetch('/api/session');
  if (!response.ok) throw new Error(`Local session failed (HTTP ${response.status})`);
  const session = await response.json(); token = session.token;
  $('ai-state').textContent = session.deepseekConfigured ? session.model : 'Not configured';
  $('ask-ai').disabled = !session.deepseekConfigured;
  await reloadProject(true);
  await refreshProjects();
  // The version is part of every playtest log header, so read it before any play.
  await loadEngineVersion().catch(() => {});
  $('editor-shell').hidden = false; $('editor-shell').inert = false;
  fitMap();
}
start().catch(error => {
  if ($('license-dialog').open) $('license-message').textContent = `Cannot open editor: ${error.message}. Check browser storage and the local service, then reload.`;
  status(`Cannot start editor: ${error.message}. Check the local service and reload.`, true);
  document.querySelectorAll('button,input,select,textarea').forEach(element => { element.disabled = true; });
});
