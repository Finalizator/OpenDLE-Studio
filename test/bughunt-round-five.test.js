import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';

import { importActors } from '../shared/actors.js';
import { createRuntime } from '../shared/runtime.js';
import { actorTic, actorStateOf, setActorState } from '../shared/actor-runtime.js';
import { HUD_MESSAGE_COLORS } from '../shared/map-scripts.js';
import { createMapScripts } from '../shared/map-scripts.js';
import { captureGameSave } from '../shared/save-game.js';

// A room with one monster, built the same way the actor tests build theirs.
function room() {
  const project = createProject();
  project.events = [];
  project.map.vertices = [['a', -512, -512], ['b', 512, -512], ['c', 512, 512], ['d', -512, 512]]
    .map(([id, x, y]) => ({ id, x, y }));
  project.map.walls = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([a, b], index) => ({
    id: `wall${index}`, a, b, height: 128, color: '#888888', solid: true,
    right: { sectorId: 'room', offsetX: 0, offsetY: 0 },
  }));
  project.map.sectors = [{ id: 'room', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false }];
  project.actors = importActors({ sources: [{ name: 'test.dec', text: DECORATE }], warnings: [] }).actors;
  project.map.entities = [
    { ...project.map.entities.find(entity => entity.type === 'player'), x: 0, y: 0, angle: 0 },
    { id: 'guard', type: 'enemy', name: 'Guard', actorName: 'Guard', x: 200, y: 0, elevation: 0, angle: 180, health: 60 },
  ];
  validateProject(project);
  const state = createRuntime(project);
  return { project, state };
}

const DECORATE = `
actor Guard
{
  Health 60
  Speed 8
  PainChance 0
  Radius 20
  Height 56
  ReactionTime 8
  Monster
  States
  {
  Spawn:
    POSS AB 10 A_Look
    Loop
  See:
    POSS AABBCCDD 3 A_Chase
    Loop
  Missile:
    POSS E 8 A_FaceTarget
    POSS F 3 A_PosAttack
    Goto See
  Death:
    POSS I 8 A_Scream
    POSS L -1
    Stop
  }
}
`;

test('a goto to a relative target follows the index the importer worked out', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  const actor = project.actors.find(item => item.name === guard.actorName);
  // `Goto Missile+2` is not a label of the actor, so the label lookup cannot follow it and the
  // machine stopped dead: a monster in the middle of its attack froze there for the rest of the
  // game. `targetIndex` holds the frame the importer resolved and nothing ever read it.
  const frames = actor.states.frames;
  const seeIndex = frames.findIndex(frame => frame.kind === 'loop' && frame.label === 'See');
  const missile = frames[frames.length - 1].kind === 'goto' ? frames.length - 1 : null;
  assert.notEqual(seeIndex, -1);
  const gotoFrame = missile ?? frames.length - 1;
  frames[gotoFrame] = { kind: 'goto', target: 'See+1', targetIndex: seeIndex + 1, label: 'Missile' };
  setActorState(project, guard, 'Missile');
  actorStateOf(guard).index = gotoFrame;
  actorTic(project, state, guard);
  // The label "See+1" does not exist; the stored index does.
  assert.equal(actorStateOf(guard).index, seeIndex + 1);
});

test('a goto that cannot be resolved anywhere still halts instead of spinning', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  const actor = project.actors.find(item => item.name === guard.actorName);
  const frames = actor.states.frames;
  const index = frames.length - 1;
  frames[index] = { kind: 'goto', target: 'Nowhere+3', targetIndex: index, label: 'Missile' };
  setActorState(project, guard, 'See');
  actorStateOf(guard).index = index;
  actorTic(project, state, guard);
  // Following the self-index the importer falls back to would have looped this tic for ever.
  assert.equal(actorStateOf(guard).index, null);
});

test('ThingCount does not count a corpse', () => {
  const { project, state } = room();
  const guard = state.entities.find(entity => entity.id === 'guard');
  guard.tid = 7;
  const scripts = createMapScripts(project, state, {});
  assert.equal(scripts.host.thingCount({ tid: 7 }), 1);
  // P_ThingCount wants `health > 0`; a corpse keeps its type and its tid, so counting it made
  // "kill them all" scripts wait for ever.
  guard.health = 0;
  assert.equal(scripts.host.thingCount({ tid: 7 }), 0);
});

test('the ACS HUD colours follow GZDoom\u2019s EColorRange order', () => {
  // CR_BRICK 0, CR_TAN 1, CR_GRAY 2, CR_GREEN 3, CR_BROWN 4, CR_GOLD 5, CR_RED 6, CR_BLUE 7,
  // CR_ORANGE 8, CR_WHITE 9, CR_YELLOW 10. The table had gold and red where brown and gold
  // belong, so `HudMessage(..., CR_RED)` printed brown text and the countdown colour was wrong.
  assert.equal(HUD_MESSAGE_COLORS[0], '#a03020');   // brick
  assert.equal(HUD_MESSAGE_COLORS[1], '#d8c090');   // tan
  assert.equal(HUD_MESSAGE_COLORS[2], '#a0a0a0');   // gray
  assert.equal(HUD_MESSAGE_COLORS[3], '#00a000');   // green
  assert.equal(HUD_MESSAGE_COLORS[4], '#a06030');   // brown
  assert.equal(HUD_MESSAGE_COLORS[5], '#f0d000');   // gold
  assert.equal(HUD_MESSAGE_COLORS[6], '#f00000');   // red
  assert.equal(HUD_MESSAGE_COLORS[7], '#0000f0');   // blue
  assert.equal(HUD_MESSAGE_COLORS[8], '#f07000');   // orange
  assert.equal(HUD_MESSAGE_COLORS[9], '#ffffff');   // white
  assert.equal(HUD_MESSAGE_COLORS[10], '#ffff00');  // yellow
});

test('a save is accepted while script arrays are live', () => {
  const { project, state } = room();
  state.hasGame = true;
  // The ACS array store lives on the runtime, and the save validator refuses any field it does
  // not know: a map with `int arr[4]` could not be saved at all.
  state.acsScriptArrays = { 1: [1, 2, 3, 4] };
  state.acsArrayStore = { 1: [1, 2, 3, 4] };
  assert.doesNotThrow(() => captureGameSave(project, state, 'arrays'));
});
