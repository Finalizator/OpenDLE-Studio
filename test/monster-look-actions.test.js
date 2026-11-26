// A monster whose Spawn state the engine does not run never wakes.
//
// Doom's `A_Look` was implemented, but the engines it borrows monsters from spell it differently:
// Heretic's 43 Acolyte variants wake in `A_Look2`, Strife's twelve marines in `A_MarineLook`, and
// the IceGuy, Maulotaur, ceiling turret, stalker, wraith and the Strife spectres in their own
// variants. Every one of those actions was unknown, so those monsters stood in their Spawn frame
// for the rest of the level while a player walked past them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { ACTIONS } from '../shared/actor-runtime.js';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';

const LOOK_ACTIONS = ['A_Look2', 'A_MarineLook', 'A_IceGuyLook', 'A_MinotaurLook', 'A_TurretLook',
  'A_StalkerLookInit', 'A_WraithInit'];

test('the look actions of the engines Doom’s monsters are borrowed from are performed', () => {
  for (const name of LOOK_ACTIONS) assert.equal(typeof ACTIONS[name], 'function', `${name} runs`);
});

test('every monster Spawn state in the imported campaign has a known action', () => {
  const dir = new URL('../data/projects/imported-wad-game-7/', import.meta.url);
  if (!existsSync(dir)) return;
  const file = readdirSync(dir).find(name => name.startsWith('actors-'));
  assert.ok(file, 'the campaign has an actor table');
  const table = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  const monsters = (table.actors || table).filter(actor => actor.flags?.MONSTER === true);
  assert.ok(monsters.length > 100, `the campaign brings its own monsters (${monsters.length})`);
  const unknown = new Set();
  for (const actor of monsters) {
    const frames = actor.states?.frames || [], start = actor.states?.labels?.Spawn ?? actor.states?.labels?.spawn;
    if (!Number.isInteger(start)) continue;
    for (let index = start; index < frames.length; index++) {
      const frame = frames[index];
      if (frame.kind !== 'frame') break;
      if (index > start && frame.label && frame.label.toLowerCase() !== 'spawn') break;
      for (const action of frame.actions || []) if (ACTIONS[action.name] === undefined) unknown.add(action.name);
    }
  }
  // Neither is a look: `A_ClassBossHealth` is Hexen's boss health bar and `A_SentinelBob` and
  // `A_SorcSpinBalls` move a Hexen boss, which is a feature this engine does not claim.
  assert.deepEqual([...unknown].sort(), ['A_ClassBossHealth', 'A_SentinelBob', 'A_SorcSpinBalls'],
    'no look action is left unimplemented');
});

test('an Acolyte that wakes through A_Look2 hunts the player', () => {
  // A real one, from the campaign's own actor table: doomType 142 in a 256-unit room.
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  project.map.vertices = [[-256, -256], [256, -256], [256, 256], [-256, 256]].map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0 }];
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.walls = [0, 1, 2, 3].map(index => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`,
    right: side, height: 128, color: '#888888', solid: true }));
  project.map.entities = [
    { id: 'player', type: 'player', name: 'Player', x: -200, y: 0, angle: 0 },
    { id: 'acolyte', type: 'enemy', name: 'Acolyte', actorName: 'AcolyteRed', doomType: 142, x: 128, y: 0, angle: 180, health: 80 },
  ];
  project.actors = buildAcolyte();
  validateProject(project);
  const state = createRuntime(project);
  const acolyte = state.entities.find(entity => entity.id === 'acolyte');
  for (let frame = 0; frame < 35 * 2; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(acolyte.target || acolyte.stateLabel === 'See', `the acolyte woke (state ${acolyte.stateLabel})`);
  const before = acolyte.x;
  for (let frame = 0; frame < 35 * 4; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(Math.abs(acolyte.x - before) > 16, 'and closed on the player');
});

/** The campaign's own AcolyteRed, reduced to the state machine that matters here. */
function buildAcolyte() {
  const dir = new URL('../data/projects/imported-wad-game-7/', import.meta.url);
  if (existsSync(dir)) {
    const file = readdirSync(dir).find(name => name.startsWith('actors-'));
    const table = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const actors = table.actors || table;
    const acolyte = actors.find(actor => actor.name === 'AcolyteRed');
    if (acolyte) return [acolyte];
  }
  return [{ id: 'acolyte_red', name: 'AcolyteRed', doomType: 142, health: 80, radius: 20, height: 56,
    flags: { MONSTER: true, COUNTKILL: true, SOLID: true },
    states: { frames: [
      { kind: 'frame', sprite: 'ACLO', letter: 'A', duration: 10, actions: [{ name: 'A_Look2', args: [] }], label: 'Spawn' },
      { kind: 'frame', sprite: 'ACLO', letter: 'A', duration: 8, actions: [{ name: 'A_Chase', args: [] }], label: 'See' },
    ], labels: { Spawn: 0, See: 1 } } }];
}
