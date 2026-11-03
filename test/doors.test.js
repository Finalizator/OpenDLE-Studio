import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { commandFields } from '../shared/command-fields.js';
import { defaultEngineCommand, ENGINE_ACTIONS, ENGINE_CONDITIONS, installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { executeSpecial } from '../shared/line-specials.js';
import { applyTool } from '../server/tools.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { doorHeights, operateSectorDoor, sectorDoorOpen } from '../shared/doors.js';
import { sectorMover, sectorMovers, elevatorHeights } from '../shared/sector-movers.js';
import { operateSectorElevator, sectorElevatorAt } from '../shared/elevators.js';
import { installWorldScripts, advanceSectors } from '../shared/world-motion.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { projectZipEntries } from '../server/project-folder.js';
import { createZipArchive } from '../server/export-build.js';
import { readProjectArchive } from '../server/project-archive.js';

function properties(project, sectorId = 'door') {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function renderDoorProperties('), end = source.indexOf('\nfunction renderInspector(', start);
  assert.ok(start >= 0 && end > start);
  const fields = new Map(), checks = [], buttons = [];
  const parent = { append() {} };
  const context = {
    project, doorHeights, sectorMover, sectorMovers, elevatorHeights, parent,
    sector: project.map.sectors.find(sector => sector.id === sectorId),
    make: () => ({ append() {} }),
    field: (host, label, control) => fields.set(label, control),
    input: (value, type, change) => ({ value, change }),
    select: (options, value, change) => ({ options, value, change }),
    button: (label, change) => { const result = { label, change }; buttons.push(result); return result; },
    checkbox: (label, value, change) => { const result = { label, value, change }; checks.push(result); return result; },
    edit: fn => { fn(project); validateProject(project); },
  };
  runInNewContext(`${source.slice(start, end)}\nrenderDoorProperties(parent, sector);`, context);
  return { fields, checks, buttons, context, source };
}

test('wall and sector properties share editable door states, activation and geometry settings', () => {
  const project = doorway({ initial: 'closed', activation: 'manual' });
  const { fields, buttons, context, source } = properties(project);
  assert.equal(fields.get('Initial door state').value, 'closed');
  fields.get('Initial door state').change('open');
  fields.get('Activation').change('event-only');
  fields.get('Activation distance (map units)').change(96);
  fields.get('Open ceiling height').change(120);
  fields.get('Closed ceiling height').change(8);
  fields.get('Door speed (units / second)').change(140);
  assert.deepEqual(structuredClone(project.map.sectors.find(sector => sector.id === 'door').door),
    { initial: 'open', activation: 'event-only', radius: 96, openHeight: 120, closedHeight: 8, speed: 140 });
  assert.equal(project.map.sectors.find(sector => sector.id === 'roomA').door, undefined);
  buttons[0].change();
  assert.equal(context.sector.door, undefined);
  properties(project).fields.get('Movement').change('door');
  assert.deepEqual(structuredClone(context.sector.door), { initial: 'closed', activation: 'manual' });
  assert.match(source, /if \(sector\) renderDoorProperties\(part, sector\)/, 'each selected wall side exposes its own sector settings');
  assert.match(source, /renderDoorProperties\(parent, item\)/, 'sector selection uses the same controls');
});

function doorway(door, events = []) {
  const project = createProject();
  project.events = events.map(event => ({ once: false, ...event }));
  const points = { v1: [-256, -32], v2: [-64, -32], v3: [-64, 32], v4: [-256, 32],
    v5: [64, -32], v6: [64, 32], v7: [256, -32], v8: [256, 32] };
  project.map.vertices = Object.entries(points).map(([id, [x, y]]) => ({ id, x, y }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  const walls = [['v1', 'v2', 'roomA'], ['v2', 'v3', 'roomA', 'door'], ['v3', 'v4', 'roomA'], ['v4', 'v1', 'roomA'],
    ['v2', 'v5', 'door'], ['v5', 'v6', 'door', 'roomB'], ['v6', 'v3', 'door'],
    ['v5', 'v7', 'roomB'], ['v7', 'v8', 'roomB'], ['v8', 'v6', 'roomB']];
  project.map.walls = walls.map(([a, b, front, back], index) => ({
    id: `wall${index}`, a, b, height: 256, color: '#888888', solid: !back,
    ...(index === 1 ? { special: 11, tag: 2 } : {}),
    right: side(front), ...(back ? { left: side(back) } : {}),
  }));
  project.map.sectors = [
    { id: 'roomA', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false },
    { id: 'door', floorHeight: 0, ceilingHeight: 0, light: 255, sky: false, tag: 2, ...(door ? { door } : {}) },
    { id: 'roomB', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false },
  ];
  project.map.entities[0] = { ...project.map.entities[0], x: -80, y: 0, angle: 0 };
  validateProject(project);
  return project;
}

function tick(project, state, count = 1, pressed = new Set()) {
  for (let index = 0; index < count; index++) stepRuntime(project, state, .05, new Set(), pressed);
}

test('authored doors establish their configured open or closed initial height', () => {
  for (const [initial, height] of [['closed', 0], ['open', 124]]) {
    const project = doorway({ initial, activation: 'event-only' });
    const state = createRuntime(project);
    assert.equal(state.sectors.find(sector => sector.id === 'door').ceilingHeight, height);
  }
});

test('door settings and door-targeting commands are validated against configured geometry', () => {
  const project = doorway({ initial: 'closed', activation: 'event-only' });
  project.map.sectors.find(sector => sector.id === 'door').door.openHeight = 0;
  assert.throws(() => validateProject(project), /open height must exceed/i);
  const unconfigured = createProject();
  unconfigured.events = [{ id: 'bad-door-target', enabled: true, once: false,
    condition: { type: 'always' }, actions: [{ type: 'openSectorDoor', sectorId: 'room0' }] }];
  assert.throws(() => validateProject(unconfigured), /configured sector door/i);
});

test('proximity doors open within range and close when the player leaves', () => {
  const project = doorway({ initial: 'closed', activation: 'proximity', radius: 32 });
  const state = createRuntime(project);
  tick(project, state, 40);
  const door = state.sectors.find(sector => sector.id === 'door');
  assert.equal(door.ceilingHeight, 124);
  state.player.x = -200;
  tick(project, state, 40);
  assert.equal(door.ceilingHeight, 0);
});

test('manual doors toggle on use, while event-only doors ignore use and line specials', () => {
  const manualProject = doorway({ initial: 'closed', activation: 'manual', radius: 32 });
  const manualState = createRuntime(manualProject);
  tick(manualProject, manualState, 1, new Set(['KeyE']));
  assert.equal(manualState.sectorMotions.get('door:ceilingHeight')?.height, 124);
  tick(manualProject, manualState, 40);
  tick(manualProject, manualState, 1, new Set(['KeyE']));
  assert.equal(manualState.sectorMotions.get('door:ceilingHeight')?.height, 0);

  const eventProject = doorway({ initial: 'closed', activation: 'event-only' }, [{
    id: 'legacy-wall-door', enabled: true, condition: { type: 'wallActivated', wallId: 'wall1', mode: 'use' },
    actions: [{ type: 'moveSector', sectorId: 'door', surface: 'ceilingHeight', height: 124, speed: 70, wait: 0, returnMode: 'stay' }],
  }]);
  const eventState = createRuntime(eventProject);
  tick(eventProject, eventState, 1, new Set(['KeyE']));
  assert.equal(eventState.sectorMotions.size, 0, 'wallActivated plus generic moveSector cannot bypass event-only');
  assert.equal(executeSpecial(eventProject, eventState, 11, [2], { activator: 'player', line: 'wall1' }), 1);
  assert.equal(eventState.sectorMotions.size, 0, 'ACS/line-special motion cannot bypass event-only');

  const deliberateProject = doorway({ initial: 'closed', activation: 'event-only' }, [{
    id: 'authored-motion', enabled: true, condition: { type: 'keyPressed', key: 'KeyQ' },
    actions: [{ type: 'moveSector', sectorId: 'door', surface: 'ceilingHeight', height: 124, speed: 70, wait: 0, returnMode: 'stay' }],
  }]);
  const deliberateState = createRuntime(deliberateProject);
  tick(deliberateProject, deliberateState, 1, new Set(['KeyQ']));
  assert.equal(deliberateState.sectorMotions.get('door:ceilingHeight')?.height, 124,
    'a direct authored event can still deliberately move an event-only door');
});

test('door-specific actions and state conditions are available through the command catalogue', () => {
  const project = doorway({ initial: 'closed', activation: 'event-only' }, [
    { id: 'open-door', enabled: true, condition: { type: 'keyPressed', key: 'KeyQ' },
      actions: [{ type: 'openSectorDoor', sectorId: 'door' }] },
    { id: 'close-door', enabled: true, condition: { type: 'keyPressed', key: 'KeyR' },
      actions: [{ type: 'closeSectorDoor', sectorId: 'door' }] },
    { id: 'toggle-door', enabled: true, condition: { type: 'keyPressed', key: 'KeyT' },
      actions: [{ type: 'toggleSectorDoor', sectorId: 'door' }] },
    { id: 'opened', enabled: true, condition: { type: 'sectorDoorOpen', sectorId: 'door' },
      actions: [{ type: 'setVariable', variable: 'score', value: 1 }] },
  ]);
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state, 1, new Set(['KeyQ']));
  assert.equal(state.sectorMotions.get('door:ceilingHeight')?.height, 124);
  tick(project, state, 40);
  assert.equal(state.variables.score, 1, 'open condition sees the completed motion');
  tick(project, state, 1, new Set(['KeyR']));
  assert.equal(state.sectorMotions.get('door:ceilingHeight')?.height, 0);
  tick(project, state, 40);
  tick(project, state, 1, new Set(['KeyT']));
  assert.equal(state.sectorMotions.get('door:ceilingHeight')?.height, 124);

  for (const command of [...ENGINE_ACTIONS, ...ENGINE_CONDITIONS]) {
    if (!/SectorDoor/.test(command.type)) continue;
    const value = defaultEngineCommand(command.type);
    value.sectorId = 'door';
    validateProject({ ...project, events: [{ id: 'catalogue', enabled: true, once: false,
      condition: command.type.startsWith('sectorDoor') ? value : { type: 'always' },
      actions: command.type.startsWith('sectorDoor') ? [] : [value] }] });
    const doorField = commandFields({ type: command.type }, {
      entities: [], sectors: [['room0', 'ordinary sector'], ['door', 'door sector']], doorSectors: [['door', 'door sector']],
    }).find(field => field.name === 'sectorId');
    assert.equal(doorField.label, 'Door sector');
    assert.deepEqual(doorField.options, [['door', 'door sector']]);
  }
});

test('sector_update can configure or remove an authored door', () => {
  const initial = createProject();
  const configured = applyTool(initial, 'sector_update', { id: 'room0',
    door: { initial: 'open', activation: 'event-only', radius: 64 } }).project;
  assert.deepEqual(configured.map.sectors[0].door, { initial: 'open', activation: 'event-only', radius: 64 });
  const removed = applyTool(configured, 'sector_update', { id: 'room0', door: null }).project;
  assert.equal(removed.map.sectors[0].door, undefined);
});

function importedMover(special = 1, { zdoom = false, args, floor = 0, ceiling = 0, neighbors = [0, 0] } = {}) {
  const project = doorway();
  const sector = project.map.sectors.find(item => item.id === 'door');
  Object.assign(sector, { floorHeight: floor, ceilingHeight: ceiling });
  project.map.sectors[0].floorHeight = neighbors[0];
  project.map.sectors[2].floorHeight = neighbors[1];
  Object.assign(project.map.walls[1], { special, tag: 2, ...(zdoom ? { specialFormat: 'zdoom',
    args: Array.from({ length: 5 }, (_, index) => (args || [2, 16, 105])[index] || 0) } : {}) });
  installEngineScripts(project);
  installWorldScripts(project, []);
  validateProject(project);
  return project;
}

test('classic local, tagged and keyed doors are recognized without adding overrides or mutating the map', () => {
  for (const special of [1, 26, 31, 99, 133, 2, 29, 103, 118]) {
    const project = importedMover(special), snapshot = JSON.stringify(project);
    assert.equal(sectorMover(project, 'door')?.kind, 'door', `special ${special}`);
    const { fields, checks } = properties(project);
    assert.equal(fields.get('Initial door state').value, 'native');
    assert.equal(fields.get('Activation').value, 'native');
    assert.equal(checks.length, 0, 'there is no author checkbox for an existing door');
    assert.equal(sectorMover(project, 'roomA'), null, 'the neighboring room is not a door');
    assert.equal(JSON.stringify(project), snapshot, 'recognition and inspection are read-only');
    fields.get('Initial door state').change('open');
    assert.deepEqual(structuredClone(project.map.sectors[1].door), { initial: 'open', activation: 'native' });
    const state = createRuntime(project);
    assert.equal(state.sectors[1].ceilingHeight, 124);
    properties(project).buttons[0].change();
    assert.equal(project.map.sectors[1].door, undefined);
    assert.equal(sectorMover(project, 'door')?.kind, 'door', 'removing an override keeps recognition');
  }
});

test('existing native doors work as event targets without being authored again', () => {
  const project = importedMover(1);
  project.events = [{ id: 'terminal-door', enabled: true, once: true,
    condition: { type: 'always' }, actions: [{ type: 'openSectorDoor', sectorId: 'door' }] }];
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state, 40);
  assert.equal(state.sectors[1].ceilingHeight, 124);
  assert.equal(sectorDoorOpen(project, state, 'door'), true);
  assert.equal(project.map.sectors[1].door, undefined);
});

test('native door overrides preserve keys and return cycles unless activation is explicitly replaced', () => {
  const project = importedMover(26);
  project.map.sectors[1].door = { initial: 'native', activation: 'native', speed: 140 };
  const state = createRuntime(project);
  tick(project, state, 1, new Set(['KeyE']));
  assert.equal(state.sectorMotions.size, 0, 'imported blue key requirement remains active');
  state.inventory.keys.add('blueCard');
  tick(project, state, 1, new Set(['KeyE']));
  const motion = state.sectorMotions.get('door:ceilingHeight');
  assert.equal(motion.height, 124);
  assert.equal(motion.speed, 140);
  assert.equal(motion.returnMode, 'return');
  assert.ok(motion.wait > 0);
});

test('classic and ZDoom special numbers are not confused and native tag-zero doors target only the back sector', () => {
  const classicExit = importedMover(11);
  assert.equal(sectorMover(classicExit, 'door'), null);
  const project = importedMover(11, { zdoom: true, args: [0, 16, 0] });
  assert.equal(sectorMover(project, 'door')?.kind, 'door');
  assert.equal(sectorMover(project, 'roomA'), null);
  const state = createRuntime(project);
  executeSpecial(project, state, 11, [0, 16, 0], { line: 'wall1' });
  assert.equal(state.sectorMotions.get('door:ceilingHeight').height, 124);
  assert.equal(state.sectorMotions.size, 1);
});

test('MAP07-style floor barriers expose elevator properties, not invalid ceiling-door authoring', () => {
  const project = importedMover(38, { floor: 112, ceiling: 112, neighbors: [8, 32] });
  assert.equal(sectorMover(project, 'door')?.kind, 'elevator');
  assert.deepEqual(elevatorHeights(project, project.map.sectors[1]),
    { lower: 8, upper: 112, speed: 35, radius: 64, moveCeiling: false });
  const { fields } = properties(project);
  assert.equal(fields.has('Initial door state'), false);
  assert.equal(fields.get('Initial elevator state').value, 'native');
  assert.equal(fields.get('Lower floor height').value, 8);
  fields.get('Activation').change('event-only');
  fields.get('Initial elevator state').change('lower');
  const state = createRuntime(project);
  assert.equal(state.sectors[1].floorHeight, 8);
  assert.equal(state.sectors[1].ceilingHeight, 112);
  assert.equal(project.map.sectors[1].door, undefined);
  properties(project).buttons[0].change();
  assert.equal(project.map.sectors[1].elevator, undefined);
});

test('existing lifts retain native cycles and can be overridden and restored through MCP', () => {
  const initial = importedMover(62, { floor: 64, ceiling: 192, neighbors: [0, 32] });
  const configured = applyTool(initial, 'sector_update', { id: 'door',
    elevator: { initial: 'native', activation: 'native', speed: 70, lowerHeight: -8, upperHeight: 72 } }).project;
  const state = createRuntime(configured);
  tick(configured, state, 1, new Set(['KeyE']));
  const motion = state.sectorMotions.get('door:floorHeight');
  assert.equal(motion.height, -8);
  assert.equal(motion.origin, 72);
  assert.equal(motion.returnMode, 'return');
  assert.equal(motion.speed, 70);
  const restored = applyTool(configured, 'sector_update', { id: 'door', elevator: null }).project;
  assert.equal(restored.map.sectors[1].elevator, undefined);
  assert.equal(sectorMover(restored, 'door').kind, 'elevator');
});

test('floor and elevator actions expose only existing movers and validate endpoints', () => {
  const project = importedMover(62, { floor: 64, ceiling: 192, neighbors: [0, 32] });
  for (const definition of [...ENGINE_ACTIONS, ...ENGINE_CONDITIONS].filter(command => command.elevator)) {
    const command = { type: definition.type, sectorId: 'door' };
    validateProject({ ...project, events: [{ id: 'elevator-target', enabled: true, once: false,
      condition: definition.type.startsWith('sectorElevator') ? command : { type: 'always' },
      actions: definition.type.startsWith('sectorElevator') ? [] : [command] }] });
    const fields = commandFields(command, { entities: [], sectors: [['roomA', 'Room'], ['door', 'Lift']],
      elevatorSectors: [['door', 'Lift']] });
    assert.deepEqual(fields.filter(field => field.name === 'sectorId'),
      [{ name: 'sectorId', label: 'Elevator sector', options: [['door', 'Lift']] }]);
  }
  project.map.sectors[1].elevator = { initial: 'lower', activation: 'event-only', lowerHeight: 64, upperHeight: 64 };
  assert.throws(() => validateProject(project), /upper height must exceed/i);
  project.map.sectors[1].elevator.upperHeight = 96;
  project.map.sectors[1].door = { initial: 'closed', activation: 'manual' };
  assert.throws(() => validateProject(project), /both an authored ceiling door and an elevator/);
});

test('elevator events and raised/lowered conditions work with native floor barriers', () => {
  const project = importedMover(38, { floor: 112, ceiling: 112, neighbors: [8, 32] });
  project.map.sectors[1].elevator = { initial: 'native', activation: 'event-only' };
  project.events = [
    { id: 'lower', enabled: true, once: false, condition: { type: 'keyPressed', key: 'KeyQ' },
      actions: [{ type: 'lowerSectorElevator', sectorId: 'door' }] },
    { id: 'lowered', enabled: true, once: false, condition: { type: 'sectorElevatorLowered', sectorId: 'door' },
      actions: [{ type: 'setVariable', variable: 'score', value: 10 }] },
  ];
  validateProject(project);
  const state = createRuntime(project);
  tick(project, state, 1, new Set(['KeyQ']));
  assert.equal(state.sectorMotions.get('door:floorHeight').height, 8);
  tick(project, state, 70);
  assert.equal(state.variables.score, 10);
  assert.equal(sectorElevatorAt(project, state, 'door', 'lower'), true);
  operateSectorElevator(project, state, 'door', 'toggle');
  assert.equal(state.sectorMotions.get('door:floorHeight').height, 112);
});

test('manual and proximity elevator overrides block imported activation and use the same floor motions', () => {
  for (const activation of ['manual', 'proximity', 'event-only']) {
    const project = importedMover(62, { floor: 64, ceiling: 192, neighbors: [0, 32] });
    project.map.sectors[1].elevator = { initial: 'lower', activation, radius: 32 };
    const state = createRuntime(project);
    tick(project, state, 1, new Set(['KeyE']));
    if (activation === 'event-only') assert.equal(state.sectorMotions.size, 0);
    else assert.equal(state.sectorMotions.get('door:floorHeight').height, 64);
    if (activation === 'proximity') {
      tick(project, state, 45);
      state.player.x = -200;
      tick(project, state, 1);
      assert.equal(state.sectorMotions.get('door:floorHeight').height, 0);
    }
  }
});

test('ZDoom elevators move both planes, by-value platforms infer real travel and ordinary ceilings are not doors', () => {
  const project = importedMover(245, { zdoom: true, args: [2, 16], floor: 0, ceiling: 128, neighbors: [32, 64] });
  assert.equal(sectorMover(project, 'door').movesCeiling, true);
  assert.equal(elevatorHeights(project, project.map.sectors[1]).upper, 32);
  const state = createRuntime(project);
  executeSpecial(project, state, 245, [2, 16], { format: 'zdoom' });
  for (let index = 0; index < 40; index++) advanceSectors(state, .05);
  assert.equal(state.sectors[1].floorHeight, 32);
  assert.equal(state.sectors[1].ceilingHeight, 160);
  operateSectorElevator(project, state, 'door', 'lower');
  for (let index = 0; index < 40; index++) advanceSectors(state, .05);
  assert.equal(state.sectors[1].floorHeight, 0);
  assert.equal(state.sectors[1].ceilingHeight, 128);

  const byValue = importedMover(23, { zdoom: true, args: [2, 8, 48], floor: 0, ceiling: 128 });
  assert.equal(elevatorHeights(byValue, byValue.map.sectors[1]).upper, 48);
  properties(byValue).fields.get('Initial elevator state').change('upper');
  assert.equal(createRuntime(byValue).sectors[1].floorHeight, 48);
  const crusher = importedMover(25, { floor: 0, ceiling: 128 });
  assert.equal(sectorMover(crusher, 'door'), null);
});

test('native mover overrides survive project JSON and mid-motion game saves', () => {
  const project = importedMover(62, { floor: 64, ceiling: 192, neighbors: [0, 32] });
  project.map.sectors[1].elevator = { initial: 'native', activation: 'native', speed: 70 };
  const portable = JSON.parse(JSON.stringify(project));
  validateProject(portable);
  const state = createRuntime(portable);
  operateSectorElevator(portable, state, 'door', 'lower');
  tick(portable, state, 5);
  const saved = JSON.parse(JSON.stringify(captureGameSave(portable, state, 'movers')));
  const restored = restoreGameSave(portable, saved, 'movers').runtime;
  assert.equal(restored.sectors[1].floorHeight, state.sectors[1].floorHeight);
  assert.deepEqual(restored.sectorMotions, state.sectorMotions);
  tick(portable, restored, 30);
  assert.equal(restored.sectors[1].floorHeight, 0);
  assert.equal(portable.map.sectors[1].floorHeight, 64);
  assert.equal(portable.map.sectors[1].moverOrigins, undefined, 'derived runtime endpoints do not alter project data');
});

test('project archives preserve native mover sources and only explicit property overrides', async () => {
  const project = importedMover(1);
  const lift = { ...project.map.sectors[2], elevator: { initial: 'lower', activation: 'event-only', lowerHeight: 0,
    upperHeight: 64, moveCeiling: true } };
  project.map.sectors[2] = lift;
  project.map.sectors[1].door = { initial: 'open', activation: 'native', speed: 140 };
  validateProject(project);
  const archive = createZipArchive(projectZipEntries(project), new Date('2026-01-01T00:00:00Z'));
  const { project: restored } = await readProjectArchive(archive);
  validateProject(restored);
  assert.equal(sectorMover(restored, 'door').kind, 'door');
  assert.equal(sectorMover(restored, 'roomB').kind, 'elevator');
  assert.deepEqual(restored.map.sectors, project.map.sectors);
  assert.deepEqual(restored.map.walls, project.map.walls);
});

test('a descending cabin keeps its exact headroom and rider, including after a mid-motion save', () => {
  const project = importedMover(245, { zdoom: true, args: [2, 16], floor: 32, ceiling: 88, neighbors: [0, 64] });
  project.map.sectors[1].elevator = { initial: 'native', activation: 'event-only', lowerHeight: 0, upperHeight: 32 };
  const state = createRuntime(project);
  state.player.x = state.player.y = 0;
  state.player.z = 32;
  state.entities.find(item => item.type === 'player').z = 32;
  operateSectorElevator(project, state, 'door', 'lower');
  advanceSectors(state, .1);
  assert.equal(state.sectors[1].ceilingHeight - state.sectors[1].floorHeight, 56);
  assert.equal(state.player.z, state.sectors[1].floorHeight);
  assert.ok(state.sectors[1].floorHeight < 32, 'the ceiling does not incorrectly reverse against a descending rider');
  const saved = JSON.parse(JSON.stringify(captureGameSave(project, state, 'cabin')));
  const restored = restoreGameSave(project, saved, 'cabin').runtime;
  for (let index = 0; index < 40; index++) advanceSectors(restored, .05);
  assert.equal(restored.sectors[1].floorHeight, 0);
  assert.equal(restored.sectors[1].ceilingHeight, 56);
  assert.equal(restored.player.z, 0);
});
