import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { createMapScripts } from '../shared/map-scripts.js';
import { hurtActor, spawnActorProjectile } from '../shared/actor-runtime.js';
import { advanceProjectiles } from '../shared/combat.js';

/*
 * Combat/player-state bug hunt: damage, armour, health and items.
 * Each test reproduced its failure before the fix it guards.
 */

const fireproof = () => ({
  id: 'actor_fireproof', name: 'Fireproof', flags: { MONSTER: true }, health: 100,
  painChance: 0, painChances: {}, damageFactors: { Fire: 0, fire: 0, Cold: 2, cold: 2 },
  damageType: 'Fire', radius: 20, height: 56, states: { labels: {}, frames: [] },
});

test('ACS GiveInventory grants blue armour with its 1/2 save divisor, not the stale green divisor', () => {
  const project = createProject();
  const state = createRuntime(project);
  const scripts = createMapScripts(project, state, {});
  // The player starts with the green-armour divisor (3, one third saved).
  assert.equal(state.playerStats.armorDivisor, 3);
  scripts.host.giveInventory('BlueArmor', 1, 'player', 0);
  assert.equal(state.playerStats.armor, 200);
  assert.equal(state.playerStats.armorDivisor, 2, 'blue armour saves half of incoming damage');
});

test('actor DamageFactor immunity and weakness apply to hurtActor damage resolution', () => {
  const project = { actors: [fireproof()] };
  const entity = { id: 'imp', type: 'enemy', health: 100, actorId: 'actor_fireproof' };
  const state = { randomSeed: 1, physics: null, time: 0 };
  // A fire hit is fully absorbed by `DamageFactor "Fire", 0`.
  assert.equal(hurtActor(project, state, entity, 40, null, 'Fire'), false);
  assert.equal(entity.health, 100, 'fire-immune monster takes no fire damage');
  // An untyped hit still lands.
  assert.equal(hurtActor(project, state, entity, 40, null, null), true);
  assert.equal(entity.health, 60);
  // A cold weakness doubles the damage.
  assert.equal(hurtActor(project, state, entity, 20, null, 'Cold'), true);
  assert.equal(entity.health, 20, 'cold weakness doubles damage (20 -> 40)');
});

test('monster projectiles carry their actor damage type through advanceProjectiles', () => {
  const project = { actors: [fireproof()] };
  const imp = { id: 'imp', type: 'enemy', x: 0, y: 0, health: 100, radius: 20, actorId: 'actor_fireproof' };
  const state = {
    projectiles: [{ id: 1, ownerId: '$player', x: 0, y: 0, z: 0, dx: 1, dy: 0, dz: 0,
      speed: 100, damage: 10, diceSides: 1, radius: 0, age: 0, damageType: 'Fire' }],
    entities: [imp],
    player: { id: 'player', type: 'player', x: 10, y: 0 },
    playerStats: { health: 100, armor: 0, armorDivisor: 3, invulnerable: 0 },
    sectors: [], walls: [], randomSeed: 1, time: 0,
    sounds: [], impacts: [], projectileSequence: 1,
  };
  advanceProjectiles(state, .05, null,
    (entity, amount, source, damageType) => hurtActor(project, state, entity, amount, source, damageType));
  assert.equal(imp.health, 100, 'the fire-typed projectile is absorbed by fire immunity');
});

test('spawnActorProjectile records the projectile actor damage type', () => {
  const project = { actors: [fireproof()] };
  const owner = { id: 'imp', type: 'enemy', x: 0, y: 0, health: 100, height: 56 };
  const target = { id: 'player', type: 'player', x: 0, y: -100 };
  const state = { entities: [owner, target], player: target, sectors: [], walls: [],
    playerStats: { health: 100 }, randomSeed: 1, time: 0,
    projectiles: [], projectileSequence: 0 };
  // The actor table only contains `fireproof`, so a named projectile resolves to it.
  spawnActorProjectile(project, state, owner, 'Fireproof', { speed: 10, damage: 10 });
  assert.equal(state.projectiles[0].damageType, 'Fire');
});
