import { createProject, validateProject, cloneProjectForEdit, addRoom, newId, removeEntity, eventConditions, ENTITY_TYPES } from '/shared/project.js';
import { createRuntime, stepRuntime, lookPlayer, wallSegments, distanceToSegment } from '/shared/runtime.js';
import { readWad } from '/shared/wad.js';
import { sectorGeometry, sectorAt } from '/shared/sectors.js';
import { createPreview, entityColors } from './render.js';
import { bundleModel } from '/shared/gltf.js';
import { createSceneEditor } from './scene-editor.js';
import { requestMouseLock } from './pointer-lock.js';
import { commandRow, openCommandDialog } from './event-sheet.js';
import { shaderTemplate } from '/shared/shaders.js';
import { recoverProject } from './project-recovery.js';
import { eventBranch, eventDepth, moveEventBranch, removeEventBranch, eventScope } from '/shared/events.js';
import { ENGINE_CONDITIONS, ENGINE_ACTIONS, INPUT_KEYS, engineCommand, defaultEngineCommand, installEngineScripts } from '/shared/engine-script.js';
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
import { installGameMenu } from '/shared/game-menu.js';
import { installDefaultHUD } from '/shared/hud.js';
import { installIntermission } from '/shared/intermission.js';
import { GAME_SETTINGS, gameSettings, bindKey, mappedKeys, validBinding, setGameScreen } from '/shared/game-settings.js';
import { engineTweaks } from '/shared/engine-tweaks.js';
import { selectGameLevel } from '/shared/game-levels.js';
import { requireLicenseAgreement } from './license-agreement.js';
import { gameSaveIdentity, captureGameSave, restoreGameSave } from '/shared/save-game.js';
import * as gameSaves from './game-saves.js';

const $ = id => document.getElementById(id);
$('asset-dock').append($('assets-panel'));
$('assets-panel').hidden = false;
let project, token, revision = 0, dirty = false, selection = null, editVersion = 0;
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
let sceneMode = '2d', sceneEditor = null, sceneProject = null, sceneLoading = false, scenePose = null;
const camera = { x: 0, y: 0, zoom: 1 };
const keys = new Set(), pressed = new Set();
const canvas = $('map'), ctx = canvas.getContext('2d');
let drag = null, mapNeedsDraw = true;
const actorsPanel = createActorsPanel({
  list: $('actor-list'), summary: $('actors-summary'), search: $('actor-search'), filter: $('actor-filter'),
  form: $('actor-form'), title: $('actor-title'), fields: $('actor-fields'), states: $('actor-states'),
}, { actors: () => project.actors || [], edit });
const scriptsPanel = createScriptsPanel({
  list: $('script-list'), detail: $('script-detail'), summary: $('scripts-summary'),
  specials: $('script-specials'), search: $('script-search'),
}, { project: () => project });
const hudEditor = createHUDEditor($('hud-editor'), {
  project: () => project, edit, script: openHUDScript, error: message => status(message, true),
});

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function guard(fn) {
  return async (...args) => {
    try { await fn(...args); } catch (error) { status(error.message, true); }
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
    localStorage.setItem('opendle-draft-metadata', JSON.stringify({ baseRevision: revision }));
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
function render() {
  const gaps = importedGameplayGaps(project);
  $('gameplay-warning').hidden = !gaps.length;
  $('gameplay-warning-text').textContent = gaps.length
    ? `This imported project is missing ${gaps.join(', ')}. Restarting the service does not update saved projects. Reimport the WAD to install current gameplay and artwork; export custom edits first. Reimport is undoable and does not save automatically.`
    : '';
  mapSectors = sectorGeometry(project);
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
  $('dirty').textContent = dirty ? 'Unsaved' : 'Saved';
  $('undo').disabled = history.length === 0;
  $('redo').disabled = future.length === 0;
  renderEntities();
  renderInspector();
  renderEvents();
  renderEnvironment();
  renderAssetsIfChanged();
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
    }, scenePose);
    if (sceneMode !== '3d' || project !== snapshot) { scenePose = editor.pose(); editor.dispose(); return; }
    sceneEditor = editor; sceneProject = snapshot;
    sceneEditor.select(selection); sceneEditor.mode($('transform-mode').value); sceneEditor.ceilings($('show-ceilings').checked);
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
  for (const field of ['transform-field', 'ceiling-field', 'surface-field']) $(field).hidden = mode !== '3d';
  $('view-2d').setAttribute('aria-pressed', String(mode === '2d'));
  $('view-3d').setAttribute('aria-pressed', String(mode === '3d'));
  $('scene-hint').textContent = mode === '3d'
    ? 'Right-drag: look + WASD fly / Q E down-up / Shift faster / wheel speed. Left: select or draw. Colored axes: transform.'
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
  mapSectors = sectorGeometry(project);
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
function edit(fn, message, { deepGame = false } = {}) {
  const next = cloneProjectForEdit(project, { deepGame });
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
function replace(next, message) {
  validateProject(next);
  $('import-report').hidden = true;
  selection = null;
  scriptScope = '$all';
  commit(next, message);
  fitMap();
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
function select(options, value, fn, label) {
  const element = make('select');
  for (const option of options) {
    const [id, text] = Array.isArray(option) ? option : [option, option];
    const item = make('option', text);
    item.value = id;
    element.append(item);
  }
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
function renderEntities() {
  $('entities').replaceChildren();
  $('project-objects').replaceChildren();
  $('object-scripts').replaceChildren();
  for (const entity of project.map.entities) {
    const count = project.events.filter(event => event.ownerId === entity.id).length;
    const tile = button('', () => selectObject(entity), 'object-tile');
    tile.setAttribute('aria-label', `${entity.name}, ${count} attached events`);
    tile.append(make('span', entity.type[0].toUpperCase(), 'object-symbol'), make('span', entity.name, 'object-name'), make('small', `${count} events`));
    const tree = button(entity.name, () => selectObject(entity), 'tree-link');
    for (const element of [tile, tree]) {
      element.dataset.objectId = entity.id;
      element.classList.toggle('selected', selection?.id === entity.id);
      element.addEventListener('dblclick', () => openScript(entity.id));
    }
    $('entities').append(tile);
    $('project-objects').append(tree);
    const script = button(`${entity.name} (${count})`, () => openScript(entity.id), 'tree-link');
    script.classList.toggle('selected', scriptScope === entity.id);
    $('object-scripts').append(script);
  }
  $('object-scripts').append(button('+ New object script sheet', () => attachObjectScriptSheet(), 'tree-link'));
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
function filterProject() {  const query = $('project-search').value.trim().toLowerCase();
  for (const parent of ['project-objects', 'object-scripts', 'engine-sheets', 'game-sheets']) for (const element of $(parent).children) {
    element.hidden = !element.textContent.toLowerCase().includes(query);
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
function readEngineTweaks() {
  const stored = localStorage.getItem('opendle-engine-tweaks');
  return engineTweaks(stored === null ? {} : JSON.parse(stored));
}
function saveEngineTweaks(changes) {
  const tweaks = engineTweaks({ ...readEngineTweaks(), ...changes });
  localStorage.setItem('opendle-engine-tweaks', JSON.stringify(tweaks));
  if (runtime) { Object.assign(runtime.settings, tweaks); runtime.settingsRevision++; }
  $('engine-tweaks-status').textContent = 'Saved for all projects in this browser.';
}
$('engine-jumping').addEventListener('change', guard(() => {
  saveEngineTweaks({ jumping: $('engine-jumping').checked });
}));
function renderEngineTweaks() {
  const tweaks = readEngineTweaks();
  $('engine-jumping').checked = tweaks.jumping;
  const fields = $('engine-setting-fields'); fields.replaceChildren();
  for (const [key, label] of [['fov', 'Field of view'], ['resolution', 'Render resolution'], ['brightness', 'Brightness'], ['muted', 'Mute preview audio'],
    ['bunnyhop', 'Simulated bunnyhop (speed gain while chaining jumps)'], ['bunnyhopGain', 'Bunnyhop speed gain per chained jump']]) {
    const wrapper = make('label', label), input = document.createElement('input'), spec = GAME_SETTINGS[key];
    input.type = typeof spec.value === 'boolean' ? 'checkbox' : 'number'; input.setAttribute('aria-label', label);
    if (input.type === 'checkbox') input.checked = tweaks[key];
    else { input.min = spec.min; input.max = spec.max; input.step = spec.step; input.value = tweaks[key]; }
    input.addEventListener('change', guard(() => saveEngineTweaks({ [key]: input.type === 'checkbox' ? input.checked : Number(input.value) })));
    wrapper.append(input); fields.append(wrapper);
  }
}
$('engine-tweaks-reset').addEventListener('click', guard(() => {
  const tweaks = engineTweaks();
  localStorage.setItem('opendle-engine-tweaks', JSON.stringify(tweaks));
  if (runtime) { Object.assign(runtime.settings, tweaks); runtime.settingsRevision++; }
  renderEngineTweaks(); $('engine-tweaks-status').textContent = 'Engine tweaks reset.';
}));
function showTab(tab) {
  if (tab !== 'hud') hudEditor.stopPreview();
  if (tab === 'assets') {
    setAssetExpanded(true); $('asset-search').focus(); return;
  }
  for (const name of ['map', 'events', 'environment', 'hud', 'actors', 'scripts', 'tweaks', 'about']) $(name + '-panel').hidden = tab !== name;
  // The designer is only refreshed while its tab is visible, so opening the tab
  // has to build it once.
  if (tab === 'hud') hudEditor.render();
  if (tab === 'actors') actorsPanel.render();
  if (tab === 'scripts') scriptsPanel.render();
  if (tab === 'tweaks') {
    try { renderEngineTweaks(); }
    catch (error) { $('engine-tweaks-status').textContent = error.message; status(error.message, true); }
  }
  document.querySelectorAll('[data-tab]').forEach(element => element.classList.toggle('active', element.dataset.tab === tab));
  if (tab === 'about') {
    $('engine-version').textContent = 'Loading OpenDLE: Studio version...';
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
    api('/api/health').then(info => {
      $('engine-version').textContent = `OpenDLE: Studio version: ${info.version}`;
    }).catch(error => {
      $('engine-version').textContent = `Version unavailable: ${error.message}`;
      status(`Could not read engine version: ${error.message}`, true);
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

function entityOptions(excludePlayer = false, ownerId) {
  const options = project.map.entities.filter(entity => !excludePlayer || entity.type !== 'player').map(entity => [entity.id, entity.name]);
  const owner = project.map.entities.find(entity => entity.id === ownerId);
  if (owner && (!excludePlayer || owner.type !== 'player')) options.unshift(['$self', `This object (${owner.name})`]);
  else if (ownerId?.startsWith('$type:')) options.unshift(['$self', `Each ${ownerId.slice(6)}`]);
  return options;
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
  return JSON.stringify([scriptScope, project.playerControl, project.events, project.eventSheets, project.eventGroups,
    Object.keys(project.variables), assetListSignature(),
    project.map.entities.map(entity => [entity.id, entity.name, entity.type]),
    project.map.walls.map(wall => [wall.id, wall.special || 0]),
    (project.map.sectors || []).map(sector => sector.id),
    project.spriteClips, project.hud?.elements?.map(element => [element.id, element.name]),
    project.hud?.animations?.map(clip => [clip.id, clip.name]),
    [...collapsedEvents], [...collapsedGroups]]);
}
function renderEvents() {
  const parent = $('event-list');
  // A large imported game carries hundreds of event rules; rebuilding every
  // card for a geometry drag is the slowest part of an edit.
  const signature = eventsSignature();
  if (signature === eventsRendered && parent.childElementCount) return;
  eventsRendered = signature;
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
    ...(project.eventSheets || []).map(sheet => [`$sheet:${sheet.id}`, `${sheet.section} / ${sheet.name}`]), ...entityOptions()].map(([id, name]) => {
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
    const modify = fn => edit(next => fn(next.events[index]));
    const context = scriptContext(event);
    const meta = make('details', undefined, 'event-meta');
    meta.append(make('summary', `${String(index + 1).padStart(2, '0')}  ${eventScope(event) === 'object' ? 'Object' : 'Game'}${event.once ? ' · Once' : ''}${event.enabled ? '' : ' · Disabled'}`));
    field(meta, 'Rule name', input(event.name || event.id, 'text', value => modify(item => { item.name = value; })));
    field(meta, 'Sheet', select([['', 'Unfiled / scene'], ...(project.eventSheets || []).map(sheet => [sheet.id, `${sheet.section} / ${sheet.name}`])],
      event.sheetId || '', value => edit(next => {
        if (event.parentId) throw new Error('Move the parent event to change a sub-event sheet');
        const ids = eventBranch(next.events, event.id);
        for (const item of next.events.filter(item => ids.has(item.id))) {
          if (value) item.sheetId = value; else delete item.sheetId;
          delete item.groupId;
        }
      })));
    field(meta, 'Group', select([['', 'Ungrouped'], ...(project.eventGroups || []).filter(group => group.sheetId === event.sheetId).map(group => [group.id, group.name])],
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
    for (const [label, direction] of [['Up', -1], ['Down', 1]]) {
      const siblings = project.events.filter(item => item.parentId === event.parentId && item.sheetId === event.sheetId && item.groupId === event.groupId);
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
    eventConditions(event).forEach((condition, conditionIndex) => {
      conditions.append(commandRow(condition, conditionLabels, objectName, () => editCommand('condition', condition, value => modify(item => {
        if (conditionIndex === 0) item.condition = value; else item.conditions[conditionIndex - 1] = value;
      }), eventConditions(event).length > 1 ? () => modify(item => {
        if (conditionIndex === 0) item.condition = item.conditions.shift(); else item.conditions.splice(conditionIndex - 1, 1);
      }) : undefined), { inverted: condition.inverted, or: event.conditionMode === 'or' && conditionIndex > 0 }));
    });
    conditions.append(button('+ Add condition', () => editCommand('condition', undefined, value => modify(item => {
      item.conditions ||= []; item.conditions.push(value);
    })), 'add-script-command'));
    const actions = make('div', undefined, 'event-actions');
    event.actions.forEach((action, actionIndex) => {
      actions.append(commandRow(action, actionLabels, objectName, () => editCommand('action', action,
        value => modify(item => { item.actions[actionIndex] = value; }),
        () => modify(item => { item.actions.splice(actionIndex, 1); }), direction => modify(item => {
          const target = actionIndex + direction;
          if (target < 0 || target >= item.actions.length) throw new Error('No adjacent action');
          [item.actions[actionIndex], item.actions[target]] = [item.actions[target], item.actions[actionIndex]];
        }))));
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
      comment.hidden = card.hidden; comment.style.marginLeft = `${depth * 22 + 32}px`;
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
function assetListSignature() {
  return (project.assets || []).map(asset => `${asset.id}:${asset.kind}:${asset.name}:${asset.format || ''}` +
    `:${asset.meshes || 0}:${asset.animations?.length || 0}:${asset.generated ? 1 : 0}`).join('|');
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
    const count = (project.assets || []).filter(asset => option.value === 'all' || asset.kind === option.value).length;
    const folder = button(`${option.textContent} (${count})`, () => { $('asset-filter').value = option.value; renderAssets(); }, 'asset-folder');
    folder.classList.toggle('selected', option.value === filter);
    return folder;
  }));
  const assets = (project.assets || []).filter(asset => (filter === 'all' || asset.kind === filter) && asset.name.toLowerCase().includes(search));
  for (const asset of assets) {
    const tile = make('div', undefined, 'asset-tile'), image = make('img');
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
      tile.append(make('strong', '3D'), make('strong', asset.name), make('small', `${asset.format} / ${asset.meshes} meshes / ${asset.skins} skins / ${asset.animations.length} clips`));
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
  canvas.setPointerCapture(event.pointerId);
  const point = worldPoint(event);
  if (event.button === 2 || event.button === 1) {
    drag = { kind: 'pan', clientX: event.clientX, clientY: event.clientY, x: camera.x, y: camera.y }; return;
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
    camera.x = drag.x - (event.clientX - drag.clientX) / camera.zoom;
    camera.y = drag.y - (event.clientY - drag.clientY) / camera.zoom;
  } else drag.end = snap(point);
  mapNeedsDraw = true;
});
canvas.addEventListener('pointerup', guard(() => {
  const finished = drag;
  drag = null;
  mapNeedsDraw = true;
  if (!finished) return;
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
  const result = await api('/api/project', { method: 'PUT', body: JSON.stringify({ project, revision }) });
  revision = result.revision;
  dirty = editVersion !== submittedVersion;
  if (!dirty) persistDraft();
  render();
  status(dirty ? 'Earlier snapshot saved; newer edits are still unsaved' : 'Project saved to local server');
}
async function reloadProject(initial = false) {
  if (!initial && dirty && !confirm('Discard unsaved edits and load the server project? Your last draft stays in browser storage.')) return;
  const result = await api('/api/project');
  project = validateProject(result.project); revision = result.revision; dirty = false;
  let recovery;
  if (initial) {
    recovery = recoverProject(result, localStorage.getItem('opendle-draft'), localStorage.getItem('opendle-draft-metadata'));
    if (recovery.recovery === 'conflict' && confirm('A different unsaved browser draft exists. Restore it instead of the server project? Choose Cancel to load the server project; the draft remains available in Restore draft.')) {
      project = recovery.draft; dirty = true;
    } else { project = recovery.project; dirty = recovery.dirty; }
  }
  history = []; future = []; selection = null; scriptScope = '$all'; editVersion++; clearDraft();
  render(); fitMap();
  status(dirty ? 'Unsaved browser draft restored; save to keep it on the server'
    : recovery?.warning || 'Server project loaded', Boolean(recovery?.warning));
}
function stopPreview() {
  previewGeneration++;
  audioPlayer?.dispose(); audioPlayer = null;
  lookDrag = null; draggedLook = false;
  if (document.pointerLockElement === $('preview')) document.exitPointerLock();
  $('play-dialog').close(); runtime = null; previewRenderer?.dispose(); previewRenderer = null; keys.clear(); pressed.clear();
  hudView?.dispose(); hudView = null; previewProject = null; hudCursorActive = false;
  $('hud-cursor').setAttribute('aria-pressed', 'false');
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
    if (nextRuntime.settings.viewSize === 11 && (snapshot.hud?.elements || []).some(element => element.statusbar)) {
      nextRuntime.message = 'Status bar hidden (Screen size 11). Raise Screen size in Options to show it again.';
      nextRuntime.messageTime = 8;
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
    keys.add('Mouse0'); $('preview').focus(); $('preview').setPointerCapture(event.pointerId); return;
  }
  if (event.button !== (runtime.scriptedInput ? 2 : 0) || document.pointerLockElement === $('preview')) return;
  $('preview').focus(); draggedLook = false;
  lookDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
  $('preview').setPointerCapture(event.pointerId);
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
      audioPlayer?.update(runtime);
      previewRenderer.render(runtime, runtime.gameScreen === 'playing' ? dt : 0);
      syncHUDCursor(); hudView?.update(runtime);
      if (!musicReported && audioPlayer?.musicInfo) {
        const music = audioPlayer.musicInfo();
        if (music.playing || (music.hasMusicAssets && music.requested) || !music.hasMusicAssets) {
          musicReported = true;
          if (music.playing) {
            status(`Music: ${music.track}${music.volume === 0 ? ' — music volume is 0, raise it in Options' : ''}`, music.volume === 0);
          } else if (music.requested && !music.track) {
            status(`Music ${music.requested} is not embedded in this project. Reimport the game to add its MIDI/MUS soundtrack.`, true);
          } else if (music.error) {
            status(`Music could not start: ${music.error}`, true);
          } else if (!music.hasMusicAssets) {
            status('No music assets in this project. Reimport the game with the current version to add MIDI/MUS soundtracks.', true);
          }
        }
      }
      if (!hudWarningShown && runtime.gameScreen === 'playing' && hudView?.nodes?.size) {
        hudWarningShown = true;
        if (![...hudView.nodes.values()].some(entry => !entry.node.hidden)) {
          const hiddenBySize = runtime.settings.viewSize === 11 &&
            (previewProject.hud?.elements || []).some(element => element.statusbar);
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
  if (confirm('Restore your last browser draft? You can undo this change.')) replace(JSON.parse(draft), 'Browser draft restored; save to keep it on the server');
}));
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, project.game ? 0 : 2)], { type: 'application/json' }));
  const link = make('a'); link.href = url; link.download = `${project.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.opendle.json`; link.click();
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
  if (file.size > 128 * 1024 * 1024) throw new Error('Project exceeds the 128 MiB file limit');
  const next = validateProject(JSON.parse(await file.text()));
  if (confirm('Open this project? You can undo this change.')) replace(next, 'Project opened');
}));
$('wad').addEventListener('click', () => $('wad-file').click());
$('wad-file').addEventListener('change', guard(async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 128 * 1024 * 1024) throw new Error('WAD exceeds the 128 MiB file limit');
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
  if (file.size > 128 * 1024 * 1024) throw new Error('PK3/IPK3 exceeds the 128 MiB import limit');
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
$('sound-file').addEventListener('change', guard(async event => {
  const files = [...event.target.files]; event.target.value = '';
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
}));
$('import-model-folder').addEventListener('click', () => $('model-directory').click());
async function importModels(event) {
  const files = [...event.target.files], version = editVersion;
  event.target.value = '';
  const sources = files.filter(file => /\.(glb|gltf)$/i.test(file.name));
  if (!sources.length) throw new Error('Select a GLB or glTF export plus any .bin / texture dependencies');
  if (sources.length > 16 || files.length > 300) throw new Error('Import at most 16 models / 300 files at a time');
  const assets = [], warnings = [];
  for (const file of sources) {
    const result = await bundleModel(file, files, newId('asset'));
    assets.push(result.asset); warnings.push(...result.warnings);
  }
  if (version !== editVersion) throw new Error('Project changed during model import. Retry.');
  edit(next => { next.assets ||= []; next.assets.push(...assets); }, `${assets.length} models imported. ${warnings.join(' ')}`);
}
$('model-file').addEventListener('change', guard(importModels));
$('model-directory').addEventListener('change', guard(importModels));
$('image-file').addEventListener('change', guard(async event => {
  const files = [...event.target.files], version = editVersion, kind = $('image-kind').value;
  event.target.value = '';
  if (files.length > 64) throw new Error('Import at most 64 images at a time');
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
  $('editor-shell').hidden = false; $('editor-shell').inert = false;
  fitMap();
}
start().catch(error => {
  if ($('license-dialog').open) $('license-message').textContent = `Cannot open editor: ${error.message}. Check browser storage and the local service, then reload.`;
  status(`Cannot start editor: ${error.message}. Check the local service and reload.`, true);
  document.querySelectorAll('button,input,select,textarea').forEach(element => { element.disabled = true; });
});
