import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { installDefaultHUD, removeHUDElements, removeHUDAnimations } from '../shared/hud.js';
import { createTimesheet, createCue, timesheetCueEvents, startTimesheetRun, setTimesheetPaused,
  startPathTween, advancePathTweens } from '../shared/timesheet.js';
import { createRuntime, stepRuntime, ruleTree } from '../shared/runtime.js';
import { advancePlaneMotion, startWaggle } from '../shared/plane-motion.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';
import { parseSndInfo, resolveSoundName } from '../shared/sndinfo.js';
import { parseLanguage } from '../shared/language.js';
import { parseSurfaceAnimations } from '../shared/animdefs.js';
import { parseMidi } from '../shared/music.js';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportCache, cachedImport, directorySignature } from '../server/import-cache.js';
import { moveSector, advanceSectors } from '../shared/world-motion.js';
import { entityDistance } from '../shared/combat.js';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createPhysics } from '../shared/physics.js';
import { driveRouteTimesheet } from '../shared/timesheet-recipe.js';
import { assembleGameLevels, parseLevelRoutes, selectGameLevel } from '../shared/game-levels.js';
import { overlayVolumes } from '../shared/areas.js';
import { installEngineSounds } from '../shared/sound.js';
import { curtainShaderId, curtainShaderTemplate } from '../shared/shaders.js';
import { encodeImage } from '../server/import.js';

await R.init();

const rule = (id, condition, actions, extra = {}) => ({ id, enabled: true, once: false, condition, actions, ...extra });
function hudProject() {
  const project = installDefaultHUD(createProject());
  project.events = [];
  return project;
}
function timeline(id, cues = []) {
  return { ...createTimesheet({ id, duration: 1 }), cues };
}
const cue = (id, time, actions) => createCue({ id, time, trackId: 'track_1', actions });
const image = (id, value) => ({ id, name: id, kind: 'sprite', width: 1, height: 1,
  src: encodeImage({ width: 1, height: 1, pixels: new Uint8Array([value, 0, 0, 255]) }) });

test('hunt 01: HUD deletion releases references in reusable scenes and timeline cues', () => {
  for (const kind of ['element', 'animation']) {
    const project = hudProject();
    const id = kind === 'element' ? project.hud.elements[0].id : project.hud.animations[0].id;
    const action = kind === 'element' ? { type: 'setHUDVisible', elementId: id, visible: 'no' }
      : { type: 'playHUDAnimation', animationId: id };
    project.scenes = [{ id: 'scene_hud', name: 'HUD scene', entities: [], events: [rule('scene_action', { type: 'always' }, [action])] }];
    project.timesheets = [timeline('timeline_hud', [cue('cue_hud', 0, [structuredClone(action)])])];
    validateProject(project);
    if (kind === 'element') removeHUDElements(project, [id]);
    else removeHUDAnimations(project, [id]);
    assert.equal(project.scenes[0].events.length, 0);
    assert.equal(project.timesheets[0].cues[0].actions.length, 0);
    validateProject(project);
  }
});

test('hunt 02: deleting a HUD condition never ungates actions or orphans sub-events', () => {
  const project = hudProject(), id = project.hud.elements.find(element => element.interactive).id;
  project.events = [
    rule('guarded', { type: 'always' }, [{ type: 'addVariable', variable: 'score', value: 1 }],
      { conditions: [{ type: 'hudClicked', elementId: id }] }),
    rule('child', { type: 'always' }, [{ type: 'addVariable', variable: 'score', value: 2 }], { parentId: 'guarded' }),
    rule('gate', { type: 'always' }, [{ type: 'setHUDVisible', elementId: id, visible: 'no' }]),
    rule('survivor', { type: 'always' }, [{ type: 'showMessage', message: 'Keep me' }], { parentId: 'gate' }),
  ];
  validateProject(project);
  removeHUDElements(project, [id]);
  assert.deepEqual(project.events.map(event => event.id), ['gate', 'survivor']);
  validateProject(project);
});

test('hunt 03: HUD images cannot reference video assets', () => {
  const project = hudProject();
  project.assets = [{ id: 'hud_video', name: 'Video', kind: 'video', format: 'mp4', src: 'data:video/mp4;base64,Ag==' }];
  project.hud.elements[0].assetId = 'hud_video';
  assert.throws(() => validateProject(project), /image asset/);
});

test('hunt 04: game-phase HUD completion is observable by interface rules next tick', () => {
  const project = hudProject(), clip = project.hud.animations[0];
  clip.duration = .01;
  clip.tracks[0].keys = [{ time: 0, value: 1 }, { time: .01, value: 0 }];
  clip.autoPlay = true;
  project.eventSheets.push({ id: 'completion_interface', name: 'Completion', enabled: true, phase: 'interface', section: 'game' });
  project.events = [rule('completion', { type: 'hudAnimationFinished', animationId: clip.id },
    [{ type: 'addVariable', variable: 'score', value: 1 }], { sheetId: 'completion_interface' })];
  validateProject(project);
  const state = createRuntime(project);
  for (let i = 0; i < 4; i++) stepRuntime(project, state, .02, new Set());
  assert.equal(state.variables.score, 1);
});

test('hunt 05: distinct legal timeline and cue IDs cannot alias generated event IDs', () => {
  const project = createProject();
  project.events = [];
  project.timesheets = [
    timeline('intro.one', [cue('begin', 0, [{ type: 'showMessage', message: 'One' }])]),
    timeline('intro:one', [cue('begin', 0, [{ type: 'showMessage', message: 'Two' }])]),
    timeline('intro', [cue('a.b', 0, []), cue('a:b', 0, [])]),
  ];
  const events = timesheetCueEvents(project.timesheets);
  assert.equal(new Set(events.map(event => event.id)).size, events.length);
  validateProject(project);
  project.events = [rule('timesheet_intro_one__begin', { type: 'always' }, [])];
  project.assets = [image('timesheet_intro__a_b', 1)];
  project.timesheets.push(timeline('long'.repeat(20), [cue('long'.repeat(30), 0, [])]));
  validateProject(project);
  const generated = [...ruleTree(project).timelineEvents.values()].flatMap(events => [...events.values()]);
  assert.ok(generated.every(event => event.id.length <= 80));
  assert.equal(new Set([...project.events, ...project.assets, ...generated].map(item => item.id)).size,
    project.events.length + project.assets.length + generated.length);
});

test('hunt 06: a reverse path tween faces its actual direction of travel', () => {
  const project = createProject();
  const entity = project.map.entities.find(item => item.type === 'pickup');
  project.paths = [{ id: 'reverse_route', name: 'Reverse', closed: false, mode: 'straight',
    points: [{ id: 'p0', x: entity.x, y: entity.y, z: 0 }, { id: 'p1', x: entity.x + 100, y: entity.y, z: 0 }] }];
  const state = createRuntime(project);
  startPathTween(state, { entityId: entity.id, pathId: 'reverse_route', fromPoint: 1, toPoint: 0, seconds: 1 });
  advancePathTweens(project, state, .5);
  assert.equal(state.entities.find(item => item.id === entity.id).angle, 180);
});

function platforms({ solid = true } = {}) {
  const bounds = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
  const rings = [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]];
  const controls = [20, 80].map((height, index) => ({
    id: `control_${index}`, floorHeight: height - 4, ceilingHeight: height, rings: [], bounds,
  }));
  const sector = { id: 'platforms', floorHeight: 0, ceilingHeight: 200, rings, bounds,
    threeDFloors: controls.map(control => ({ controlId: control.id, bottom: control.floorHeight, top: control.ceilingHeight, solid })) };
  const state = { sectors: [...controls, sector], entities: [], player: { x: -999, y: -999, z: 0 } };
  return { controls, sector, state };
}

test('hunt 07: stacked moving 3D floors carry occupants of each individual surface', () => {
  const { controls, state } = platforms();
  state.entities = [{ id: 'lower', x: 50, y: 50, z: 20 }, { id: 'upper', x: 50, y: 50, z: 80 }];
  controls[0].ceilingHeight += 5;
  controls[1].ceilingHeight += 10;
  advancePlaneMotion(state, .02);
  assert.equal(state.entities[0].z, 25);
  assert.equal(state.entities[1].z, 90);
});

test('hunt 08: non-solid 3D floors do not carry objects hovering at their height', () => {
  const { controls, sector, state } = platforms({ solid: false });
  sector.threeDFloors.pop();
  state.entities = [{ id: 'hovering', x: 50, y: 50, z: 20 }];
  controls[0].ceilingHeight += 5;
  advancePlaneMotion(state, .02);
  assert.equal(state.entities[0].z, 20);
});

test('hunt 09: a saved active waggle resumes and returns to its original plane height', () => {
  const project = createProject();
  project.events = [];
  project.map.sectors[0].tag = 73;
  const state = createRuntime(project);
  const initial = state.sectors[0].ceilingHeight;
  startWaggle(state, { tag: 73, amplitude: 24, speed: 32, timer: 1, ceiling: true });
  advancePlaneMotion(state, .2);
  const record = captureGameSave(project, state, 'waggle-save');
  const restored = restoreGameSave(project, JSON.parse(JSON.stringify(record)), 'waggle-save').runtime;
  assert.equal(restored.waggles?.length, 1);
  for (let i = 0; i < 100; i++) advancePlaneMotion(restored, .02);
  assert.equal(restored.sectors[0].ceilingHeight, initial);
});

test('hunt 10: pausing a timeline suppresses pending time-zero cues until resumed', () => {
  const project = createProject();
  project.events = [];
  project.timesheets = [timeline('paused_intro', [cue('pending', 0, [{ type: 'addVariable', variable: 'score', value: 1 }])])];
  validateProject(project);
  const state = createRuntime(project);
  startTimesheetRun(project, state, 'paused_intro');
  setTimesheetPaused(state, 'paused_intro', true);
  stepRuntime(project, state, .02, new Set());
  assert.equal(state.variables.score, 0);
  setTimesheetPaused(state, 'paused_intro', false);
  stepRuntime(project, state, .02, new Set());
  assert.equal(state.variables.score, 1);
});

test('hunt 11: multiline SNDINFO random groups resolve all their members', () => {
  const table = parseSndInfo('$random grass/rustle\n{\n grass/one\n grass/two\n}\ngrass/one DSONE\ngrass/two DSTWO');
  assert.equal(resolveSoundName('grass/rustle', table, () => 0), 'DSONE');
  assert.equal(resolveSoundName('grass/rustle', table, () => .99), 'DSTWO');
});

test('hunt 12: the last SNDINFO declaration wins across alias and random forms', () => {
  const table = parseSndInfo('$random test { OLD1 OLD2 }\ntest NEW');
  assert.equal(resolveSoundName('test', table, () => 0), 'NEW');
  const alias = parseSndInfo('$random test { OLD1 OLD2 }\n$alias test final\nfinal NEW');
  assert.equal(resolveSoundName('test', alias, () => 0), 'NEW');
});

test('hunt 13: multiline SNDINFO comments cannot override real sound mappings', () => {
  const table = parseSndInfo('weapon/fire DSREAL\n/*\nweapon/fire DSWRONG\n*/');
  assert.equal(resolveSoundName('weapon/fire', table), 'DSREAL');
});

test('hunt 14: LANGUAGE concatenates adjacent quoted strings across lines', () => {
  const strings = parseLanguage('[default]\nTEXT = "First "\n"second "\n"third";\nINLINE = "A" "B";');
  assert.equal(strings.TEXT, 'First second third');
  assert.equal(strings.INLINE, 'AB');
});

test('hunt 15: LANGUAGE escapes distinguish literal backslashes from line breaks', () => {
  const strings = parseLanguage(String.raw`[default]
TEXT = "slash\\next\tcolumn\nline\"quote";`);
  assert.equal(strings.TEXT, 'slash\\next\tcolumn\nline"quote');
});

test('hunt 16: English LANGUAGE overrides do not depend on default-section order', () => {
  const strings = parseLanguage('[enu]\nTEXT = "English";\n[default]\nTEXT = "Default";');
  assert.equal(strings.TEXT, 'English');
});

test('hunt 17: quoted ANIMDEFS names and adjacent braces retain their frames', () => {
  const parsed = parseSurfaceAnimations(['texture "WATER1"{pic "WATER1" tics 3 pic "WATER2" tics 4}']);
  assert.deepEqual(parsed.sequences[0]?.frames, [{ name: 'WATER1', tics: 3 }, { name: 'WATER2', tics: 4 }]);
});

test('hunt 18: ANIMDEFS block tics directives use their own value without skipping the next pic', () => {
  const parsed = parseSurfaceAnimations(['texture WATER1 { tics 3 pic WATER1 pic WATER2 }']);
  assert.deepEqual(parsed.sequences[0]?.frames, [{ name: 'WATER1', tics: 3 }, { name: 'WATER2', tics: 3 }]);
});

function midi(...tracks) {
  const header = [77, 84, 104, 100, 0, 0, 0, 6, 0, tracks.length > 1 ? 1 : 0, 0, tracks.length, 0, 100];
  return new Uint8Array([...header, ...tracks.flatMap(body => [
    77, 84, 114, 107, body.length >>> 24, body.length >>> 16 & 255, body.length >>> 8 & 255, body.length & 255, ...body,
  ])]);
}

test('hunt 19: MIDI channel events merge by time across tracks, not file order', () => {
  const score = parseMidi(midi(
    [100, 0x80, 60, 0, 0, 0xff, 0x2f, 0],
    [0, 0x90, 60, 100, 100, 0xff, 0x2f, 0],
  ));
  assert.equal(score.notes.length, 1);
  assert.equal(score.notes[0].duration, .5);
});

test('hunt 20: MIDI song length includes the end-of-track trailing rest', () => {
  const score = parseMidi(midi([0, 0x90, 60, 100, 100, 0x80, 60, 0, 100, 0xff, 0x2f, 0]));
  assert.equal(score.notes[0].duration, .5);
  assert.equal(score.seconds, 1);
});

test('hunt 21: import cache quotas hold after misses and when several entries need eviction', t => {
  const root = mkdtempSync(join(tmpdir(), 'opendle-hunt-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = createImportCache({ directory: root, maxEntries: 2 });
  for (const id of ['one', 'two', 'three']) cachedImport(cache, id, () => ({ id }));
  assert.equal(cache.files().length, 2);
  const small = createImportCache({ directory: root, maxBytes: 1 });
  small.set('four', { id: 'four' });
  assert.equal(small.files().length, 0);
  assert.equal(small.stats().bytes, 0);
});

test('hunt 22: moving a package file into another namespace changes its cache signature', t => {
  const root = mkdtempSync(join(tmpdir(), 'opendle-hunt-signature-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'textures'));
  writeFileSync(join(root, 'textures', 'water.png'), 'image');
  const before = directorySignature(root);
  renameSync(join(root, 'textures'), join(root, 'flats'));
  assert.notEqual(directorySignature(root), before);
});

function movingRoom() {
  const project = createProject();
  project.events = [];
  return { project, state: createRuntime(project) };
}
const moveFloor = (state, height, speed = 100) => moveSector(state, {
  sectorId: state.sectors[0].id, surface: 'floorHeight', height, speed, wait: 0, returnMode: 'stay',
});

test('hunt 23: a rising floor catches an airborne rider without adding its gap twice', () => {
  const { state } = movingRoom();
  state.player.z = 5;
  moveFloor(state, 10);
  advanceSectors(state, .1);
  assert.equal(state.player.z, 10);
  assert.equal(state.entities.find(entity => entity.type === 'player').z, 10);
});

test('hunt 24: moving planes respect tall and short imported actor heights', () => {
  for (const height of [90, 32]) {
    const { state } = movingRoom(), sector = state.sectors[0];
    state.player.x = -10000;
    state.entities.push({ id: 'sized_enemy', type: 'enemy', x: 0, y: 0, z: 0, height, health: 100 });
    const target = height === 90 ? 80 : 40;
    moveSector(state, { sectorId: sector.id, surface: 'ceilingHeight', height: target,
      speed: 1000, wait: 0, returnMode: 'stay' });
    advanceSectors(state, 1);
    assert.equal(sector.ceilingHeight, height === 90 ? 128 : target);
  }
});

test('hunt 25: sector waiting consumes only the wait, not the rest of the frame', () => {
  const { state } = movingRoom(), sector = state.sectors[0];
  moveFloor(state, 10);
  sector.floorHeight = 10;
  state.player.z = 10;
  Object.assign(state.sectorMotions.get(`${sector.id}:floorHeight`), { direction: 'return', waiting: .01 });
  advanceSectors(state, .05);
  assert.ok(Math.abs(sector.floorHeight - 6) < 1e-8);
});

test('hunt 26: timeline actions run in crossing order, including across a loop boundary', () => {
  for (const wrap of [false, true]) {
    const { project, state } = movingRoom();
    const action = value => [{ type: 'setVariable', variable: 'score', value }];
    project.timesheets = [timeline('ordered', wrap
      ? [cue('early', .01, action(1)), cue('late', .49, action(2))]
      : [cue('late', .04, action(2)), cue('early', .02, action(1))])];
    project.timesheets[0].duration = .5;
    startTimesheetRun(project, state, 'ordered', { loop: wrap });
    if (wrap) state.timesheets.get('ordered').time = .48;
    stepRuntime(project, state, .05, new Set());
    assert.equal(state.variables.score, wrap ? 1 : 2);
  }
});

test('hunt 27: combat traces use imported actors own hitbox dimensions', () => {
  const { state } = movingRoom();
  const target = { type: 'enemy', x: 0, y: 0, z: 0, height: 100, radius: 40 };
  assert.equal(entityDistance(state, { x: -100, y: 0, z: 90 }, { x: 1, y: 0, z: 0 }, target, 200), 60);
  target.height = 20;
  assert.equal(entityDistance(state, { x: -100, y: 0, z: 30 }, { x: 1, y: 0, z: 0 }, target, 200), null);
});

test('hunt 28: player position actions synchronize height without a physics world', () => {
  for (const type of ['teleport', 'setEntityPosition']) {
    const { project, state } = movingRoom();
    project.events = [rule('position', { type: 'onStart' }, [{ type, entityId: 'player', x: 0, y: 0, z: 64 }])];
    stepRuntime(project, state, .01, new Set());
    assert.equal(state.player.z, 64);
    assert.equal(state.entities.find(entity => entity.type === 'player').z, 64);
  }
});

test('hunt 29: incremental object rotation also turns its Rapier body', t => {
  const { project } = movingRoom(), entity = project.map.entities[1];
  entity.type = 'decoration';
  entity.angle = 0;
  entity.physics = { body: 'kinematic', shape: 'box', width: 32, height: 32, depth: 32,
    radius: 16, mass: 1, friction: .5, restitution: 0, sensor: false, lockRotation: false };
  project.events = [rule('turn', { type: 'onStart' }, [{ type: 'rotateEntityBy', entityId: entity.id, angle: 90 }])];
  validateProject(project);
  const state = createRuntime(project);
  const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
    holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  stepRuntime(project, state, .02, new Set());
  stepRuntime(project, state, .02, new Set());
  assert.ok(Math.abs(state.entities[1].angle - 90) < .01);
  assert.ok(Math.abs(Math.abs(state.entities[1].rotation.y) - Math.SQRT1_2) < .001);
});

test('hunt 30: replacing a foreach rule does not keep its old cached action', () => {
  const { project, state } = movingRoom();
  const event = value => rule('edited', { type: 'always' }, [{ type: 'setVariable', variable: 'score', value }],
    { forEachType: 'pickup' });
  project.events = [event(1)];
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.variables.score, 1);
  project.events = [event(2)];
  stepRuntime(project, state, .01, new Set());
  assert.equal(state.variables.score, 2);
});

test('hunt 31: unchanged timelines reuse their compiled rule tree', () => {
  const project = createProject();
  project.timesheets = [timeline('cached', [cue('setup', 0, [])])];
  assert.equal(ruleTree(project), ruleTree(project));
  const first = ruleTree(project);
  project.timesheets = structuredClone(project.timesheets);
  project.timesheets[0].cues[0].actions.push({ type: 'showMessage', message: 'New action' });
  assert.notEqual(ruleTree(project), first);
});

test('hunt 32: the drive-route recipe accepts legal long object and route names', () => {
  const project = createProject(), entity = project.map.entities[1];
  entity.name = 'Object'.repeat(16);
  const path = { id: 'named_route', name: 'Route'.repeat(20), closed: false,
    points: [{ id: 'start', x: 0, y: 0 }, { id: 'end', x: 100, y: 0 }] };
  project.paths = [path];
  const recipe = driveRouteTimesheet({ entity, path, nextId: kind => `recipe_${kind}` });
  project.timesheets = [recipe.sheet];
  project.events.push(recipe.event);
  validateProject(project);
});

test('hunt 33: campaign asset remapping never rewrites literal text, variables or object identities', () => {
  const a = createProject(), b = createProject();
  a.assets = [image('literal', 1)];
  b.assets = [image('literal', 2)];
  b.variables.title = 'literal';
  b.variables.assetId = 'literal';
  b.events = [rule('message_rule', { type: 'onStart' }, [{ type: 'showMessage', message: 'literal' }])];
  b.map.entities[1].spriteAsset = 'literal';
  validateProject(a);
  validateProject(b);
  const project = assembleGameLevels([{ id: 'MAP01', project: a }, { id: 'MAP02', project: b }], 'MAP01', 'Remap').project;
  selectGameLevel(project, 'MAP02');
  assert.equal(project.variables.title, 'literal');
  assert.equal(project.variables.assetId, 'literal');
  assert.equal(project.events[0].id, 'message_rule');
  assert.equal(project.events[0].actions[0].message, 'literal');
  assert.notEqual(project.map.entities[1].spriteAsset, 'literal');
  validateProject(project);

  for (const [level, value] of [[a, 10], [b, 20]]) {
    level.assets = [image('front', 100), image('side', value)];
    level.assets[0].rotations = Array.from({ length: 8 }, (_, index) => ({ assetId: index ? 'side' : 'front', flip: false }));
    level.map.entities[1].spriteAsset = 'front';
  }
  const rotated = assembleGameLevels([{ id: 'MAP01', project: a }, { id: 'MAP02', project: b }], 'MAP02', 'Rotations').project;
  const front = rotated.assets.find(asset => asset.id === rotated.map.entities[1].spriteAsset);
  assert.equal(rotated.assets.find(asset => asset.id === front.rotations[1].assetId).src, b.assets[1].src);
  assert.equal(b.assets[0].rotations[1].assetId, 'side');
  validateProject(rotated);
  b.assets = structuredClone(a.assets);
  const identical = assembleGameLevels([{ id: 'MAP01', project: a }, { id: 'MAP02', project: b }], 'MAP01', 'Shared rotations').project;
  assert.equal(identical.assets.length, 2, 'identical directional artwork still deduplicates between maps');
});

test('hunt 34: MIDI notes still held at song end are emitted rather than discarded', () => {
  const score = parseMidi(midi([0, 0x90, 60, 100, 100, 0xff, 0x2f, 0]));
  assert.equal(score.notes.length, 1);
  assert.equal(score.notes[0].duration, .5);
});

test('hunt 35: overlapping MIDI note-ons of one pitch retain both notes and their programs', () => {
  const score = parseMidi(midi([0, 0x90, 60, 100, 50, 0xc0, 20, 0, 0x90, 60, 80,
    50, 0x80, 60, 0, 50, 0x80, 60, 0, 0, 0xff, 0x2f, 0]));
  assert.deepEqual(score.notes.map(note => [note.time, note.duration, note.program]), [[0, .5, 0], [.25, .5, 20]]);
});

test('hunt 36: editor overlay plans retain yaw and absolute object heights', () => {
  const entity = { id: 'raised', type: 'decoration', x: 0, y: 0, z: 80, elevation: 0, angle: 90,
    area: { shape: 'box', width: 100, depth: 20, height: 32, radius: 16 },
    physics: { body: 'fixed', shape: 'box', width: 100, depth: 20, height: 32, radius: 16 } };
  const plans = overlayVolumes([entity], { areas: true, physics: true }, () => 0);
  for (const plan of plans) {
    assert.equal(plan.angle, 90);
    assert.equal(plan.center.z, 96);
  }
  const playerPlan = overlayVolumes([{ id: 'player', type: 'player', x: 0, y: 0, z: 80 }],
    { player: true }, () => 0)[0];
  assert.equal(playerPlan.center.z, 108);
});

test('hunt 37: MAPINFO quoted prose cannot inject routing, lighting or music assignments', () => {
  const route = parseLevelRoutes(['map MAP01 { next = MAP02; intertext = "next = MAP99 music = WRONG lightmode = 7"; }']).get('MAP01');
  assert.equal(route.next, 'MAP02');
  assert.equal(route.music, undefined);
  assert.equal(route.lightMode, undefined);
});

const simpleShader = id => ({ id, name: 'Custom', language: 'glsl', source: 'vec4 effect(vec4 color, vec2 uv, float time) { return color; }', uniforms: {} });

test('hunt 38: built-in installers reserve shader and sprite-clip identifiers too', () => {
  for (const installer of [installDefaultHUD, installEngineSounds]) for (const table of ['shaders', 'spriteClips']) {
    const project = createProject();
    const id = installer === installDefaultHUD ? 'hud_Status_bar' : 'engine_sound_0';
    if (table === 'shaders') project.shaders = [simpleShader(id)];
    else {
      project.assets = [image('clip_image', 0)];
      project.spriteClips = [{ id, name: 'Existing', frames: ['clip_image'], seconds: .1, loop: true }];
    }
    validateProject(project);
    installer(project);
    validateProject(project);
  }
});

test('hunt 39: a player on a moving 3D floor is carried exactly once when physics synchronizes it', t => {
  const { controls, state } = platforms();
  state.player = { x: 50, y: 50, z: 20 };
  state.entities = [{ id: 'player', type: 'player', ...state.player }];
  const teleports = [];
  state.physics = { teleport(id, x, y, z) {
    teleports.push(id);
    Object.assign(state.entities[0], { x, y, z });
    Object.assign(state.player, { x, y, z });
  } };
  controls[0].ceilingHeight += 5;
  advancePlaneMotion(state, .02);
  assert.equal(state.player.z, 25);
  assert.equal(state.entities[0].z, 25);
  assert.deepEqual(teleports, ['player']);

  const { project, state: physical } = movingRoom();
  const player = physical.entities.find(entity => entity.type === 'player');
  player.z = 20;
  const control = { ...controls[0], id: 'physical_control', floorHeight: 16, ceilingHeight: 20 };
  physical.sectors.push(control);
  physical.sectors[0].threeDFloors = [{ controlId: control.id, bottom: 16, top: 20, solid: true }];
  const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
    holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
  physical.physics = createPhysics(project, physical, R, triangulate);
  t.after(() => physical.physics.dispose());
  const before = physical.player.z;
  control.ceilingHeight += 5;
  advancePlaneMotion(physical, .02);
  assert.ok(Math.abs(physical.player.z - before - 5) <= .5, 'the real Rapier body moves by one platform delta');
  assert.equal(player.z, physical.player.z);
});

test('hunt 40: consecutive repeated ANIMDEFS pictures preserve authored hold durations', () => {
  const parsed = parseSurfaceAnimations(['texture WATER1 { pic WATER1 tics 2 pic WATER1 tics 8 pic WATER2 tics 4 }']);
  assert.deepEqual(parsed.sequences[0]?.frames, [
    { name: 'WATER1', tics: 2 }, { name: 'WATER1', tics: 8 }, { name: 'WATER2', tics: 4 },
  ]);
});

test('hunt 41: adding the glass preset never returns an unrelated colliding shader', () => {
  const project = createProject();
  project.shaders = [simpleShader('plastic_curtain')];
  const id = curtainShaderId(project);
  assert.notEqual(id, 'plastic_curtain');
  assert.equal(project.shaders.find(shader => shader.id === id).source, curtainShaderTemplate);
  validateProject(project);
});
