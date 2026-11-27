// Four defects found by probing the renderer, the audio player and the damage path.
//
// `saySound` publishes a monster's place as `position`, and the audio player read only `x`/`y`, so
// every monster sight, pain, death and attack played at full volume from anywhere on the map. A
// camera actor's pitch is degrees and was handed to a radians function, so any pitch looked almost
// straight down. A light object's floor-relative elevation was dropped, so a raised lamp lit the
// floor. And `Sector_SetDamage` subtracted health directly, so it ignored invulnerability.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { installEngineScripts } from '../shared/engine-script.js';

test('a monster sound is attenuated by where the monster is', () => {
  // `saySound` publishes the place as `position`; the player read only `x`/`y`, so every monster
  // sound played at full volume from anywhere on the map. The assertion is on the source because
  // the mixing path needs a real Web Audio context; `npm run automation:game` covers the rest.
  const source = readFileSync(new URL('../public/audio.js', import.meta.url), 'utf8');
  assert.match(source, /const at = event\.position \|\| \(event\.x === undefined \? null : event\);/);
  // The distance is the real 3D one on Doom's own curve: a sound 5000 units overhead used to be as
  // loud as one at the player's feet, and the shape was a straight line where GZDoom's is
  // `(10^v - 1) / 9` with a 200-unit plateau.
  assert.match(source, /const effectGain = distance =>/);
  assert.match(source, /at\.z \|\| 0\) - \(state\.player\.z \|\| 0\)\)\)/);
  assert.match(source, /\(Math\.pow\(10, v\) - 1\) \/ 9/);
});

test('a camera actor’s pitch is read as degrees', () => {
  const source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(source, /pitch: \(spectator\.cameraPitch \|\| 0\) \* Math\.PI \/ 180/);
});

test('a light object respects its floor-relative elevation', () => {
  const source = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  assert.match(source, /const z = entity\.z \?\? \(sectorOf\(entity\)\?\.floorHeight \?\? 0\) \+ \(entity\.elevation \|\| 0\);/);
});

test('a damaging sector cannot hurt an invulnerable player', () => {
  const project = createProject();
  project.events = [];
  installEngineScripts(project);
  project.map.vertices = [[-128, -128], [128, -128], [128, 128], [-128, 128]].map(([x, y], index) => ({ id: `v${index}`, x, y }));
  project.map.sectors = [{ id: 's1', floorHeight: 0, ceilingHeight: 128, light: 255, sky: false, tag: 0, damage: 20 }];
  const side = { sectorId: 's1', offsetX: 0, offsetY: 0 };
  project.map.walls = [0, 1, 2, 3].map(index => ({ id: `w${index}`, a: `v${index}`, b: `v${(index + 1) % 4}`,
    right: side, height: 128, color: '#888888', solid: true }));
  project.map.entities = [{ ...project.map.entities[0], x: 0, y: 0, angle: 0 }];
  validateProject(project);
  const state = createRuntime(project);
  state.playerStats.health = 100;
  state.playerStats.invulnerable = 60;
  for (let frame = 0; frame < 70; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.equal(state.playerStats.health, 100, 'the sphere protects against a damaging sector');
  state.playerStats.invulnerable = 0;
  for (let frame = 0; frame < 70; frame++) stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(state.playerStats.health < 100, 'and the sector hurts once the sphere runs out');
});
