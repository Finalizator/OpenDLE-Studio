import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime } from '../shared/runtime.js';
import { ACTIONS } from '../shared/actor-runtime.js';
import { captureGameSave, restoreGameSave } from '../shared/save-game.js';

/** A square room with a player and whatever the caller places, plus its own actor table. */
function room(entities = [], actors = []) {
  const project = installEngineScripts(createProject());
  project.actors = actors;
  project.map.vertices = [[-256, -256], [256, -256], [256, 256], [-256, 256]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 256, light: 255, sky: false, tag: 0 }];
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.walls = [0, 1, 2, 3].map(index => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`,
    right: side, height: 256, color: '#888888', solid: true }));
  project.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -200, y: 0, angle: 0 }, ...entities];
  const state = createRuntime(project, { screen: 'playing' });
  state.hasGame = true;
  return { project, state };
}

const ctxFor = (project, state, entity) => ({ project, state, entity, actor: null, args: [], named: {} });

test('a save taken after a monster spawned another monster loads again', () => {
  // Killing a Pain Elemental lets three Lost Souls out, and none of them was placed by the project:
  // the save used to refuse them as "an addon changed the runtime state".
  const { project, state } = room([{ id: 'pain1', type: 'enemy', x: 64, y: 0, angle: 180, elevation: 0, health: 400 }],
    [{ id: 'actor_soul', name: 'LostSoul', flags: { MONSTER: true, COUNTKILL: true },
      health: 100, speed: 8, radius: 16, height: 56,
      states: { labels: { Spawn: 0 }, frames: [{ kind: 'frame', sprite: 'SKUL', letter: 'A', duration: 10, actions: [] }] } }]);
  ACTIONS.A_PainDie(ctxFor(project, state, state.entities.find(entity => entity.id === 'pain1')));
  const spawned = state.entities.filter(entity => String(entity.id).startsWith('spawned_'));
  assert.equal(spawned.length, 3);
  const record = JSON.parse(JSON.stringify(captureGameSave(project, state, 'probe')));
  const restored = restoreGameSave(project, record, 'probe').runtime;
  assert.equal(restored.entities.filter(entity => String(entity.id).startsWith('spawned_')).length, 3);
  // A thing no actor table explains is still refused: an addon's own entity has no template.
  state.entities.push({ id: 'spawned_999', type: 'enemy', name: 'Mystery', x: 0, y: 0, angle: 0, health: 1 });
  assert.throws(() => captureGameSave(project, state, 'probe'), /unknown entity spawned_999/);
});
