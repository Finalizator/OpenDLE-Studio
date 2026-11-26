// Doom's damaging floors (`P_PlayerInSpecialSector`) must burn the player.
//
// The classic sector specials are the hazard: 4 (strobe hurt) and 16 (super nukage) cost 20 a
// second, 5 (nukage) 10 and 7 (blood) 5, and the radiation suit stops the burn while it runs.
// Before this, `sector.special` was never read for damage at all, so a player could stand in the
// nukage in any level forever.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';

function floorWith(special) {
  const project = createProject();
  project.events = [];
  project.map.vertices = [[-128, -128], [128, -128], [128, 128], [-128, 128]]
    .map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0, special }];
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.walls = [0, 1, 2, 3].map(index => ({
    id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`, right: side, height: 128,
    color: '#888888', solid: true,
  }));
  project.map.entities = [{ ...project.map.entities[0], x: 0, y: 0, angle: 0 }];
  validateProject(project);
  const state = createRuntime(project);
  const stand = (seconds, options = {}) => {
    Object.assign(state.playerStats, options);
    for (let frame = 0; frame < Math.round(seconds * 35); frame++) stepRuntime(project, state, 1 / 35, new Set());
    return state;
  };
  return { project, state, stand };
}

test('nukage costs ten health a second, as Doom does', () => {
  const { state, stand } = floorWith(5);
  state.playerStats.health = 100;
  stand(2);
  assert.equal(state.playerStats.health, 80);
});

test('blood costs five and super nukage twenty a second', () => {
  for (const [special, cost] of [[7, 5], [16, 20], [4, 20]]) {
    const { state, stand } = floorWith(special);
    state.playerStats.health = 100;
    stand(2);
    assert.equal(state.playerStats.health, 100 - cost * 2, `sector special ${special}`);
  }
});

test('an ordinary floor and a strobe floor without damage cost nothing', () => {
  for (const special of [0, 8, 9]) {
    const { state, stand } = floorWith(special);
    state.playerStats.health = 100;
    stand(3);
    assert.equal(state.playerStats.health, 100, `sector special ${special}`);
  }
});

test('the radiation suit stops the burn while it runs', () => {
  const { state, stand } = floorWith(16);
  state.playerStats.health = 100;
  stand(2, { radiation: 10 });
  assert.equal(state.playerStats.health, 100);
  state.playerStats.radiation = 0;
  stand(1);
  assert.equal(state.playerStats.health, 80, 'and it burns again once the suit runs out');
});

test('armour and the invulnerability sphere apply to floor damage as to any other hit', () => {
  const { state, stand } = floorWith(5);
  Object.assign(state.playerStats, { health: 100, armor: 100, armorDivisor: 2 });
  stand(1);
  assert.equal(state.playerStats.health, 95);
  assert.equal(state.playerStats.armor, 95, 'half the hit came out of the armour');
  Object.assign(state.playerStats, { health: 100, armor: 0, invulnerable: 30 });
  stand(2);
  assert.equal(state.playerStats.health, 100);
});
