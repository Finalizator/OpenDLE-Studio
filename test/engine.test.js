import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, addRoom, removeEntity } from '../shared/project.js';
import { castRay, createRuntime, stepRuntime, lookPlayer, distanceToSegment } from '../shared/runtime.js';
import { importWadMap, readWad } from '../shared/wad.js';
import { applyTool } from '../server/tools.js';

test('starter project is valid and JSON round-trips', () => {
  const project = createProject();
  assert.equal(validateProject(project), project);
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(project))), project);
});
test('mouse look turns right, looks up/down, clamps pitch and resets for each play session', () => {
  const project = createProject(), state = createRuntime(project);
  assert.equal(state.player.pitch, 0);
  lookPlayer(state, 100, -50);
  assert.equal(state.player.angle, .2); assert.equal(state.player.pitch, .1);
  lookPlayer(state, -100, 50);
  assert.equal(state.player.angle, 0); assert.equal(state.player.pitch, 0);
  const limit = 85 * Math.PI / 180;
  lookPlayer(state, 0, -100000); assert.equal(state.player.pitch, limit);
  lookPlayer(state, 0, 100000); assert.equal(state.player.pitch, -limit);
  assert.throws(() => lookPlayer(state, NaN, 1), /finite/);
  assert.equal(createRuntime(project).player.pitch, 0);
  assert.equal(project.map.entities[0].pitch, undefined);
});
test('looking vertically does not fly or change horizontal movement speed; keyboard turning still works', () => {
  const project = createProject(); project.events = [];
  const level = createRuntime(project), tilted = createRuntime(project);
  lookPlayer(tilted, 0, -100000);
  for (let i = 0; i < 10; i++) {
    stepRuntime(project, level, .016, new Set(['KeyW', 'ArrowRight']));
    stepRuntime(project, tilted, .016, new Set(['KeyW', 'ArrowRight']));
  }
  assert.equal(tilted.player.x, level.player.x); assert.equal(tilted.player.y, level.player.y);
  assert.equal(tilted.player.angle, level.player.angle);
  assert.ok(tilted.player.angle > 0);
});
test('rejects unknown versions, invalid geometry, duplicate IDs and missing player', () => {
  const cases = [
    p => { p.version = 2; },
    p => { p.map.vertices[0].x = Infinity; },
    p => { p.map.walls[0].a = 'absent'; },
    p => { p.map.walls[0].color = 'red'; },
    p => { p.map.vertices[0].id = p.map.vertices[1].id; },
    p => { p.map.entities = []; },
    p => { p.map.walls[0].b = p.map.walls[0].a; },
  ];
  for (const change of cases) {
    const project = createProject(); change(project);
    assert.throws(() => validateProject(project));
  }
});
test('room generation and entity reference integrity', () => {
  const project = createProject();
  addRoom(project, { x: 400, y: 0, width: 128, depth: 128 });
  assert.equal(project.map.walls.length, 8);
  validateProject(project);
  delete project.events[1].ownerId;
  project.events[1].condition.entityId = 'pickup';
  project.events[1].actions[1].entityId = 'pickup';
  assert.throws(() => removeEntity(project, 'pickup'), /used by an event/);
  assert.throws(() => removeEntity(project, 'player'), /non-player/);
  project.events = [];
  removeEntity(project, 'pickup');
  validateProject(project);
});
test('legacy scene rules without ownership or extra conditions retain their behavior', () => {
  const project = createProject();
  delete project.events[1].ownerId;
  project.events[1].condition.entityId = 'pickup';
  project.events[1].actions[1].entityId = 'pickup';
  validateProject(project);
  const state = createRuntime(project);
  state.player.x = 160;
  stepRuntime(project, state, .016, new Set());
  assert.equal(state.variables.score, 1);
  assert.equal(state.entities.some(entity => entity.id === 'pickup'), false);
});
test('attached conditions are ANDed and self actions affect only the owner', () => {
  const project = createProject();
  project.map.entities.push({ id: 'other', type: 'pickup', name: 'Other cell', x: 160, y: 10, angle: 0 });
  project.events = [{
    id: 'attached', ownerId: 'pickup', enabled: true, once: true,
    condition: { type: 'nearEntity', entityId: '$self', distance: 40 },
    conditions: [{ type: 'keyPressed', key: 'KeyE' }],
    actions: [{ type: 'setEntityPosition', entityId: '$self', x: 100, y: 70 }, { type: 'rotateEntity', entityId: '$self', angle: 90 },
      { type: 'addVariable', variable: 'score', value: 1 }],
  }];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .016, new Set(), new Set(['KeyE']));
  assert.equal(state.variables.score, 0);
  assert.equal(state.fired.has('attached'), false);
  state.player.x = 160;
  stepRuntime(project, state, .016, new Set());
  assert.equal(state.variables.score, 0);
  stepRuntime(project, state, .016, new Set(), new Set(['KeyE']));
  assert.equal(state.variables.score, 1);
  const owner = state.entities.find(entity => entity.id === 'pickup');
  assert.deepEqual([owner.x, owner.y, owner.angle], [100, 70, 90]);
  const other = state.entities.find(entity => entity.id === 'other');
  assert.deepEqual([other.x, other.y, other.angle], [160, 10, 0]);
  assert.equal(project.map.entities[1].x, 160);
});
test('destroyed owners stop executing later rules but remaining actions in the current rule finish', () => {
  const project = createProject();
  project.events = [
    { id: 'destroy', ownerId: 'pickup', enabled: true, once: false, condition: { type: 'always' },
      actions: [{ type: 'removeEntity', entityId: '$self' }, { type: 'addVariable', variable: 'score', value: 1 }] },
    { id: 'late', ownerId: 'pickup', enabled: true, once: false, condition: { type: 'always' },
      actions: [{ type: 'addVariable', variable: 'score', value: 100 }] },
  ];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .016, new Set()); stepRuntime(project, state, .016, new Set());
  assert.equal(state.variables.score, 1);
  assert.equal(state.fired.has('late'), false);
});
test('object script targets and owner references are validated on every condition and action', () => {
  const cases = [
    p => { p.events[1].ownerId = 'missing'; },
    p => { delete p.events[1].ownerId; },
    p => { p.events[1].ownerId = 'player'; },
    p => { p.events[1].conditions = [{ type: 'nearEntity', entityId: 'missing', distance: 20 }]; },
    p => { p.events[1].conditions = [{ type: 'keyPressed', key: 'Delete' }]; },
    p => { p.events[1].conditions = Array.from({ length: 16 }, () => ({ type: 'always' })); },
    p => { p.events[1].conditions = {}; },
    p => { p.events[1].actions = [{ type: 'setEntityPosition', entityId: 'missing', x: 0, y: 0 }]; },
    p => { p.events[1].actions = [{ type: 'rotateEntity', entityId: '$self', angle: Infinity }]; },
  ];
  for (const change of cases) {
    const project = createProject(); change(project);
    assert.throws(() => validateProject(project));
  }
});
test('deleting an authored object removes its scripts, but external conditions/actions block deletion', () => {
  const project = createProject();
  removeEntity(project, 'pickup');
  validateProject(project);
  assert.equal(project.events.length, 1);
  const withReference = createProject();
  withReference.events[0].conditions = [{ type: 'nearEntity', entityId: 'pickup', distance: 30 }];
  assert.throws(() => removeEntity(withReference, 'pickup'), /used by an event/);
  assert.equal(withReference.events.length, 2);
  assert.equal(withReference.map.entities.length, 2);
  delete withReference.events[0].conditions;
  withReference.events[0].actions.push({ type: 'rotateEntity', entityId: 'pickup', angle: 30 });
  assert.throws(() => removeEntity(withReference, 'pickup'), /used by an event/);
});
test('player-owned position and angle actions synchronize camera and object state', () => {
  const project = createProject();
  project.events = [{
    id: 'move-player', ownerId: 'player', enabled: true, once: true, condition: { type: 'onStart' },
    actions: [{ type: 'setEntityPosition', entityId: '$self', x: 80, y: 90 }, { type: 'rotateEntity', entityId: '$self', angle: 180 }],
  }, {
    id: 'check-player', enabled: true, once: true, condition: { type: 'nearEntity', entityId: 'player', distance: 1 },
    actions: [{ type: 'addVariable', variable: 'score', value: 1 }],
  }];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .016, new Set());
  assert.deepEqual(state.player, { x: 80, y: 90, angle: Math.PI, pitch: 0 });
  const object = state.entities.find(entity => entity.type === 'player');
  assert.deepEqual([object.x, object.y, object.angle], [80, 90, 180]);
  assert.equal(state.variables.score, 1);
});
test('MCP/DeepSeek event tool supports object ownership and AND conditions transactionally', () => {
  const project = createProject();
  const args = {
    ownerId: 'pickup', condition: { type: 'keyPressed', key: 'KeyE' },
    conditions: [{ type: 'nearEntity', entityId: '$self', distance: 80 }],
    actions: [{ type: 'setEntityPosition', entityId: '$self', x: 40, y: 50 }],
  };
  const result = applyTool(project, 'events_add_rule', args);
  const event = result.project.events.at(-1);
  assert.equal(event.ownerId, 'pickup');
  assert.equal(event.conditions.length, 1);
  assert.equal(event.actions[0].entityId, '$self');
  const roundTrip = JSON.parse(JSON.stringify(result.project));
  validateProject(roundTrip);
  assert.deepEqual(roundTrip.events.at(-1), event);
  assert.equal(project.events.length, 2);
  assert.throws(() => applyTool(project, 'events_add_rule', { ...args, ownerId: 'absent' }), /unknown entity/);
  assert.equal(project.events.length, 2);
});
test('event validation rejects invalid references, reserved variables and unknown actions', () => {
  const project = createProject();
  project.events[1].condition.entityId = 'missing';
  assert.throws(() => validateProject(project), /unknown entity/);
  project.events = [];
  Object.defineProperty(project.variables, '__proto__', { value: 0, enumerable: true });
  assert.throws(() => validateProject(project), /Reserved variable/);
  const bad = createProject();
  bad.events[0].actions = [{ type: 'executeJavascript', code: 'alert(1)' }];
  assert.throws(() => validateProject(bad), /Unknown action/);
});
test('onStart and proximity actions execute once and do not mutate source', () => {
  const project = createProject(), state = createRuntime(project);
  stepRuntime(project, state, .016, new Set());
  assert.match(state.message, /Welcome/);
  state.player.x = 160;
  stepRuntime(project, state, .016, new Set());
  assert.equal(state.variables.score, 1);
  assert.equal(state.entities.some(entity => entity.id === 'pickup'), false);
  stepRuntime(project, state, .016, new Set());
  assert.equal(state.variables.score, 1);
  assert.equal(project.variables.score, 0);
  assert.equal(project.map.entities.length, 2);
});
test('key edges, repeat conditions, teleport and setVariable', () => {
  const project = createProject();
  project.events = [{ id: 'key', enabled: true, once: false, condition: { type: 'keyPressed', key: 'KeyE' },
    actions: [{ type: 'setVariable', variable: 'score', value: 7 }, { type: 'teleport', x: 100, y: 50 }] }];
  validateProject(project);
  const state = createRuntime(project);
  stepRuntime(project, state, .016, new Set(['KeyE']));
  assert.equal(state.variables.score, 0);
  stepRuntime(project, state, .016, new Set(['KeyE']), new Set(['KeyE']));
  assert.equal(state.variables.score, 7); assert.equal(state.player.x, 100); assert.equal(state.player.y, 50);
  state.variables.score = 0;
  stepRuntime(project, state, .016, new Set(['KeyE']));
  assert.equal(state.variables.score, 0);
});
test('disabled events do not fire; always runs each step when once is false', () => {
  const project = createProject();
  project.events = [
    { id: 'disabled', enabled: false, once: true, condition: { type: 'onStart' }, actions: [{ type: 'setVariable', variable: 'score', value: 100 }] },
    { id: 'repeat', enabled: true, once: false, condition: { type: 'always' }, actions: [{ type: 'addVariable', variable: 'score', value: 1 }] },
  ];
  const state = createRuntime(project);
  stepRuntime(project, state, .016, new Set()); stepRuntime(project, state, .016, new Set());
  assert.equal(state.variables.score, 2);
});
test('collision prevents crossing walls even after a long frame; ray hits nearest wall', () => {
  const project = createProject(), state = createRuntime(project);
  state.player.x = 370;
  for (let index = 0; index < 50; index++) stepRuntime(project, state, 5, new Set(['KeyW']));
  assert.ok(state.player.x <= 372);
  const ray = castRay(0, 0, 1, 0, state.walls);
  assert.equal(ray.distance, 384);
  assert.equal(ray.wall.id, 'w2');
  assert.equal(distanceToSegment(4, 3, { x: 0, y: 0 }, { x: 8, y: 0 }), 3);
  project.map.walls.find(wall => wall.id === 'w2').solid = false;
  assert.equal(castRay(0, 0, 1, 0, createRuntime(project).walls), null);
});
test('shared tools validate transactionally and leave source unchanged on failure', () => {
  const project = createProject();
  const result = applyTool(project, 'project_set_title', { title: 'Tool world' });
  assert.equal(result.project.title, 'Tool world');
  assert.notEqual(project.title, 'Tool world');
  assert.throws(() => applyTool(project, 'map_update_wall', { id: 'w1', height: -1 }));
  assert.equal(project.map.walls[0].height, 128);
  assert.throws(() => applyTool(project, 'project_get', { extra: true }));
  assert.equal(applyTool(project, 'project_get', {}).changed, false);
  assert.throws(() => applyTool(project, 'nonexistent', {}), /Unknown tool/);
  const moved = applyTool(project, 'map_add_entity', { type: 'player', name: 'Start', x: 0, y: 0 });
  assert.equal(moved.project.map.entities.filter(entity => entity.type === 'player').length, 1);
  const room = applyTool(project, 'map_add_room', { x: 1000, y: 0, width: 64, depth: 64 });
  assert.equal(room.project.map.walls.length, 8);
  const event = applyTool(project, 'events_add_rule', { condition: { type: 'onStart' }, actions: [{ type: 'showMessage', message: 'hello' }] });
  assert.equal(event.project.events.length, 3);
  assert.equal(applyTool(project, 'project_replace', { project }).project.title, project.title);
});

// A synthetic map contains no copyrighted game data.
export function fixtureWad(extraLump) {
  const vertices = Buffer.alloc(16);
  [[-128, -128], [128, -128], [128, 128], [-128, 128]].forEach(([x, y], i) => {
    vertices.writeInt16LE(x, i * 4); vertices.writeInt16LE(y, i * 4 + 2);
  });
  const lines = Buffer.alloc(56);
  for (let i = 0; i < 4; i++) {
    lines.writeUInt16LE(i, i * 14); lines.writeUInt16LE((i + 1) % 4, i * 14 + 2);
    lines.writeUInt16LE(65535, i * 14 + 12);
  }
  const sector = Buffer.alloc(26); sector.writeInt16LE(128, 2);
  const thing = Buffer.alloc(10); thing.writeUInt16LE(1, 6); thing.writeUInt16LE(7, 8);
  const lumps = [['MAP01', Buffer.alloc(0)], ['THINGS', thing], ['LINEDEFS', lines],
    ['SIDEDEFS', Buffer.alloc(30)], ['VERTEXES', vertices], ['SECTORS', sector]];
  if (extraLump) lumps.push([extraLump, Buffer.alloc(0)]);
  const directory = 12 + lumps.reduce((sum, [, data]) => sum + data.length, 0);
  const buffer = Buffer.alloc(directory + lumps.length * 16);
  buffer.write('PWAD'); buffer.writeUInt32LE(lumps.length, 4); buffer.writeUInt32LE(directory, 8);
  let offset = 12;
  lumps.forEach(([name, data], i) => {
    data.copy(buffer, offset);
    const entry = directory + i * 16;
    buffer.writeUInt32LE(offset, entry); buffer.writeUInt32LE(data.length, entry + 4); buffer.write(name, entry + 8, 8);
    offset += data.length;
  });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
test('classic WAD geometry import preserves coordinates and reports limitations', () => {
  const wad = readWad(fixtureWad());
  assert.deepEqual(wad.maps, ['MAP01']);
  const result = importWadMap(wad, 'MAP01');
  validateProject(result.project);
  assert.equal(result.project.map.walls.length, 4);
  assert.equal(result.project.map.vertices[0].y, 128);
  assert.equal(result.project.map.entities[0].type, 'player');
  assert.ok(result.warnings.some(warning => warning.includes('DECORATE/ZScript state machines')));
});
test('WAD parsing rejects truncated headers, directories, out-of-bounds lumps and unsupported maps', () => {
  assert.throws(() => readWad(new ArrayBuffer(3)), /truncated/);
  const badDirectory = fixtureWad();
  new DataView(badDirectory).setUint32(8, 0xffffffff, true);
  assert.throws(() => readWad(badDirectory), /directory/);
  const badLump = fixtureWad(), view = new DataView(badLump), directory = view.getUint32(8, true);
  view.setUint32(directory, 0xffffffff, true);
  assert.throws(() => readWad(badLump), /out of bounds/);
  assert.throws(() => importWadMap(readWad(fixtureWad('BEHAVIOR')), 'MAP01'), /not supported/);
  assert.throws(() => importWadMap(readWad(fixtureWad('TEXTMAP')), 'MAP01'), /UDMF.*Missing namespace/);
});
test('WAD record limits are checked before allocating record arrays', () => {
  const source = fixtureWad();
  const oversized = new ArrayBuffer(source.byteLength + 50010);
  new Uint8Array(oversized).set(new Uint8Array(source));
  const view = new DataView(oversized);
  const directory = view.getUint32(8, true);
  view.setUint32(directory + 16 + 4, 50010, true);
  assert.throws(() => importWadMap(readWad(oversized), 'MAP01'), /THINGS exceeds/);
});
