import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { moveSector, installWorldScripts } from '../shared/world-motion.js';
import { sectorAt } from '../shared/sectors.js';
import { canSeePlayer } from '../shared/combat.js';
import { clipFrame, spriteAsset, spriteView, setSpriteState, installSpriteAnimations } from '../shared/sprite-animation.js';
import { importWad } from '../server/import.js';
import { ProjectStore } from '../server/store.js';
import { launchProjectile } from '../shared/combat.js';

await R.init();
const triangulate = (o, h) => ShapeUtils.triangulateShape(o.map(v => new Vector2(v.x, v.y)), h.map(r => r.map(v => new Vector2(v.x, v.y))));
const tick = (p, s, count = 1, keys = [], pressed = []) => {
  for (let i = 0; i < count; i++) stepRuntime(p, s, 1 / 35, new Set(keys), i ? new Set() : new Set(pressed));
};
function corridor() {
  const p = createProject();
  p.events = [];
  p.map.vertices = [[-192, -96], [-32, -96], [32, -96], [192, -96], [-192, 96], [-32, 96], [32, 96], [192, 96]]
    .map(([x, y], i) => ({ id: `v${i}`, x, y }));
  p.map.sectors = [0, 1, 2].map(i => ({ id: `s${i}`, floorHeight: 0, ceilingHeight: i === 1 ? 0 : 128, light: 255, sky: false, tag: i }));
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  p.map.walls = [
    [0, 1, 's0'], [1, 5, 's0', 's1', 1], [5, 4, 's0'], [4, 0, 's0'],
    [1, 2, 's1'], [2, 6, 's1', 's2'], [6, 5, 's1'], [2, 3, 's2'], [3, 7, 's2'], [7, 6, 's2'],
  ].map(([a, b, right, left, special = 0], i) => ({ id: `w${i}`, a: `v${a}`, b: `v${b}`, right: side(right), left: left ? side(left) : null,
    solid: !left, height: 128, color: '#888888', special, tag: 0 }));
  p.map.entities = [{ id: 'player', type: 'player', name: 'Player', x: -60, y: 0, angle: 0 }];
  installEngineScripts(p);
  installWorldScripts(p, []);
  validateProject(p);
  return p;
}
function physics(t, p) {
  const state = createRuntime(p);
  state.physics = createPhysics(p, state, R, triangulate);
  t.after(() => state.physics.dispose());
  return state;
}
test('E uses a door within64 units; live collision opens and closes with the visible sector', t => {
  const p = corridor(), s = physics(t, p);
  tick(p, s, 20, ['KeyW']);
  assert.ok(s.player.x < -32, 'closed door blocks capsule');
  tick(p, s, 1, [], ['KeyE']);
  assert.ok(s.sectorMotions.has('s1:ceilingHeight'));
  tick(p, s, 70);
  assert.equal(s.sectors[1].ceilingHeight, 124);
  tick(p, s, 50, ['KeyW']);
  assert.ok(s.player.x > 32, `open door traversed: ${s.player.x}`);
  tick(p, s, 220);
  assert.equal(s.sectors[1].ceilingHeight, 0, 'door returns closed');
  assert.equal(p.map.sectors[1].ceilingHeight, 0, 'runtime preserves project');
});
test('door use respects range, facing, occlusion and required key ownership', t => {
  const p = corridor();
  p.events = p.events.filter(e => !e.id.startsWith('world_special_'));
  p.map.walls[1].special = 26;
  installWorldScripts(p, []);
  const s = physics(t, p);
  tick(p, s, 1, [], ['KeyE']);
  assert.equal(s.sectorMotions.size, 0); assert.match(s.message, /blue key/);
  s.inventory.keys.add('blueSkull');
  s.player.angle = Math.PI;
  tick(p, s, 1, [], ['KeyE']); assert.equal(s.sectorMotions.size, 0, 'facing away');
  s.player.angle = 0;
  tick(p, s, 1, [], ['KeyE']); assert.equal(s.sectorMotions.size, 1);
});
test('closing doors reverse instead of crushing a player in their opening', t => {
  const p = corridor(), s = physics(t, p);
  tick(p, s, 1, [], ['KeyE']); tick(p, s, 65);
  s.physics.teleport('player', 0, 0, 0);
  tick(p, s, 280);
  assert.ok(s.sectors[1].ceilingHeight >= 56, 'occupied doorway stays safe');
  assert.equal(s.playerStats.health, 100);
});
test('moving floor carries the real Rapier capsule upward and downward and rebuilds collision', t => {
  const p = installEngineScripts(createProject());
  p.events.push({ id: 'lift_rule', enabled: true, once: true, condition: { type: 'keyPressed', key: 'KeyE' },
    actions: [{ type: 'moveSector', sectorId: p.map.sectors[0].id, surface: 'floorHeight', height: 64, speed: 35, wait: .5, returnMode: 'return' }] });
  const s = physics(t, p);
  tick(p, s, 10); tick(p, s, 1, [], ['KeyE']); tick(p, s, 65);
  assert.equal(s.sectors[0].floorHeight, 64);
  assert.ok(Math.abs(s.player.z - 64) < 1, `rider z ${s.player.z}`);
  tick(p, s, 100);
  assert.equal(s.sectors[0].floorHeight, 0); assert.ok(Math.abs(s.player.z) < 1);
  assert.ok(s.worldRevision > 50); assert.equal(p.map.sectors[0].floorHeight, 0);
});
test('crossing tagged lift triggers only the tagged sector and one-shot/repeatable rules are preserved', () => {
  const p = corridor();
  p.events = p.events.filter(e => !e.id.startsWith('world_special_'));
  p.map.sectors[1].ceilingHeight = 128; p.map.sectors[1].floorHeight = 16;
  p.map.walls[1].special = 10; p.map.walls[1].tag = 1;
  installWorldScripts(p, []);
  const s = createRuntime(p);
  tick(p, s, 10, ['KeyW']);
  assert.ok(s.player.x > -32); assert.ok(s.sectorMotions.has('s1:floorHeight'));
  tick(p, s, 20);
  assert.equal(s.sectors[1].floorHeight, 0);
  assert.equal(s.sectors[0].floorHeight, 0); assert.equal(s.sectors[2].floorHeight, 0);
});
test('perpetual platforms use distinct low/high neighboring heights even when starting at the low point', () => {
  const p = corridor();
  p.events = p.events.filter(e => !e.id.startsWith('world_special_'));
  p.map.sectors[1].ceilingHeight = 128;
  p.map.sectors[2].floorHeight = 32;
  p.map.walls[1].special = 53; p.map.walls[1].tag = 1;
  installWorldScripts(p, []);
  const action = p.events.find(e => e.id.startsWith('world_special_')).actions[0];
  assert.equal(action.returnHeight, 32);
  const s = createRuntime(p);
  moveSector(s, { ...action, wait: .1 });
  tick(p, s, 50);
  assert.ok(s.sectors[1].floorHeight > 0, 'platform rises from low point');
  tick(p, s, 100);
  assert.equal(s.sectorMotions.size, 1, 'perpetual motion remains active');
});
test('sector motion validation rejects unknown references and unsafe parameters', () => {
  const p = corridor(), event = p.events.find(e => e.actions.some(a => a.type === 'moveSector'));
  for (const patch of [{ sectorId: 'missing' }, { speed: 0 }, { height: Infinity }, { returnMode: 'unsafe' }]) {
    const next = structuredClone(p); Object.assign(next.events.find(e => e.id === event.id).actions[0], patch);
    assert.throws(() => validateProject(next));
  }
});
const freedoom = new URL('../Projects/freedoom2.wad', import.meta.url);
test('Freedoom rear-facing room guards wake on gunfire and chase with the full map and Rapier active', { skip: !existsSync(freedoom) }, t => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01'), s = physics(t, p);
  const guard = s.entities.find(e => e.id === 'thing4'), original = { ...guard };
  s.playerStats.invulnerable = 10000;
  s.physics.teleport(s.entities.find(e => e.type === 'player').id, 384, -64, -64);
  tick(p, s);
  assert.equal(s.timers.has(`${guard.id}:alert`), false, 'player is behind the guard');
  tick(p, s, 1, ['Mouse0']);
  assert.ok(s.timers.has(`${guard.id}:alert`), 'gunfire wakes the guard');
  tick(p, s, 175);
  assert.ok(Math.hypot(guard.x - original.x, guard.y - original.y) > 48, 'guard genuinely pursues on the original unfiltered map');
  assert.ok(Math.abs(s.player.z + 64) < 1, 'player stays on the room floor');
});
test('imported Doom sprite frames select all eight camera-relative views including mirrored pairs and rotation zero', { skip: !existsSync(freedoom) }, () => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01'), s = createRuntime(p);
  const guard = s.entities.find(e => e.doomType === 3004);
  guard.angle = 0; s.time = 0;
  const front = p.assets.find(asset => asset.id === guard.spriteAsset);
  assert.equal(front.rotations.length, 8);
  for (let i = 0; i < 8; i++) {
    const angle = -i * Math.PI / 4, view = spriteView(p, s, guard,
      { x: guard.x + Math.cos(angle) * 128, y: guard.y + Math.sin(angle) * 128 });
    assert.deepEqual(view, front.rotations[i], `rotation ${i + 1}`);
    const asset = p.assets.find(asset => asset.id === view.assetId);
    assert.ok(asset.name.slice(view.flip ? 6 : 4).startsWith(`A${i + 1}`));
  }
  assert.equal(front.rotations[1].assetId, front.rotations[7].assetId);
  assert.notEqual(front.rotations[1].flip, front.rotations[7].flip);
  setSpriteState(p, s, guard, 'walk');
  s.time = 8 / 35 + .001;
  assert.match(p.assets.find(asset => asset.id === spriteView(p, s, guard).assetId).name, /^POSSB/);
  setSpriteState(p, s, guard, 'death'); s.time += 10;
  const corpse = spriteView(p, s, guard, { x: guard.x, y: guard.y - 100 });
  assert.match(p.assets.find(asset => asset.id === corpse.assetId).name, /^POSSL0$/);
  assert.equal(corpse.flip, false);
  validateProject(JSON.parse(JSON.stringify(p)));
  const invalid = structuredClone(p);
  invalid.assets.find(asset => asset.rotations).rotations[0].assetId = 'missing';
  assert.throws(() => validateProject(invalid), /unknown asset/);
});
test('Freedoom actual linedefs retain specials and import editable doors, moving platforms, sprites and missiles', { skip: !existsSync(freedoom) }, t => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01');
  assert.equal(p.map.walls.find(w => w.id === 'w165').special, 1);
  assert.ok(p.events.some(e => e.actions.some(a => a.type === 'moveSector' && a.returnMode === 'cycle')));
  assert.ok(p.spriteClips.length > 20);
  assert.ok(p.events.find(e => e.name === 'rocketLauncher').actions.find(a => a.type === 'launchProjectile').clipId);
  const s = physics(t, p), wall = s.walls.find(w => w.id === 'w165');
  const x = (wall.start.x + wall.end.x) / 2, y = (wall.start.y + wall.end.y) / 2;
  const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y, length = Math.hypot(dx, dy);
  const candidates = [4, 8, 16, 24, 32].flatMap(distance => [1, -1].map(sign => ({ x: x + sign * dy / length * distance, y: y - sign * dx / length * distance })));
  const from = candidates.find(pos => sectorAt(s.sectors, pos.x, pos.y)?.id === wall.right.sectorId);
  assert.ok(from);
  s.physics.teleport(s.entities.find(e => e.type === 'player').id, from.x, from.y, sectorAt(s.sectors, from.x, from.y).floorHeight);
  s.player.angle = Math.atan2(y - from.y, x - from.x);
  tick(p, s, 1, [], ['KeyE']); tick(p, s, 100);
  const door = s.sectors.find(sector => sector.id === wall.left.sectorId);
  assert.ok(door.ceilingHeight - door.floorHeight >= 56, `actual door ${door.ceilingHeight}/${door.floorHeight}`);
});
test('actual Freedoom enemy pursues, animates and fires when approached in its room', { skip: !existsSync(freedoom) }, t => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01'), s = physics(t, p);
  tick(p, s);
  s.playerStats.invulnerable = 1;
  const enemy = s.entities.find(e => e.doomType === 3001);
  const home = sectorAt(s.sectors, enemy.x, enemy.y);
  let from;
  for (let angle = 0; angle < 6.3; angle += .3) {
    const position = { x: enemy.x + Math.cos(angle) * 128, y: enemy.y + Math.sin(angle) * 128 };
    if (sectorAt(s.sectors, position.x, position.y)?.id !== home.id) continue;
    s.physics.teleport(s.entities.find(e => e.type === 'player').id, position.x, position.y, home.floorHeight);
    if (canSeePlayer(s, enemy, 1024)) { from = position; break; }
  }
  assert.ok(from, 'actual room contains a visible approach point');
  enemy.angle = Math.atan2(from.y - enemy.y, from.x - enemy.x) * 180 / Math.PI;
  const original = { x: enemy.x, y: enemy.y };
  let flying = false, animated = false;
  for (let i = 0; i < 35; i++) {
    tick(p, s);
    flying ||= s.projectiles.length > 0;
    animated ||= spriteAsset(p, s, enemy) !== enemy.spriteAsset;
  }
  assert.ok(Math.hypot(enemy.x - original.x, enemy.y - original.y) > 16, 'actual enemy moves');
  assert.ok(animated, 'enemy sprite changes frames');
  assert.ok(flying, 'imp launches traveling missile');
});
test('sprite clip timing loops walking, completes attacks, preserves death and survives storage', { skip: !existsSync(freedoom) }, () => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01'), s = createRuntime(p);
  tick(p, s);
  const enemy = s.entities.find(e => e.type === 'enemy'), clip = p.spriteClips.find(c => c.id === enemy.spriteStates.walk);
  assert.notEqual(clipFrame(p, clip.id, 0).assetId, clipFrame(p, clip.id, clip.seconds + .001).assetId);
  assert.equal(clipFrame(p, clip.id, clip.seconds * clip.frames.length).assetId, clip.frames[0]);
  setSpriteState(p, s, enemy, 'death');
  const death = p.spriteClips.find(c => c.id === enemy.spriteStates.death);
  assert.equal(clipFrame(p, death.id, 100).assetId, death.frames.at(-1));
  assert.equal(clipFrame(p, death.id, 100).finished, true);
  const store = new ProjectStore(null); store.update(p, 0);
  assert.deepEqual(store.snapshot().project.spriteClips, p.spriteClips);
});
test('classic monster deaths end at normal corpse frames, never the next gib or resurrection sequence', () => {
  const expected = { POSS: 'HIJKL', SPOS: 'HIJKL', CPOS: 'HIJKLMN', TROO: 'IJKLM', SARG: 'IJKLMN',
    SKUL: 'FGHIJK', HEAD: 'GHIJK', BOSS: 'IJKLMNO', BOS2: 'IJKLMNO', BSPI: 'JKLMNOP',
    PAIN: 'HIJKLM', SKEL: 'LMNOPQ', FATT: 'KLMNOPQRST', VILE: 'QRSTUVWXYZ', CYBR: 'HIJKLMNOP', SPID: 'JKLMNOPQRS' };
  const p = createProject();
  p.assets = [];
  p.map.entities = p.map.entities.filter(e => e.type === 'player');
  for (const prefix of Object.keys(expected)) {
    p.assets.push({ id: `${prefix}A1`, name: `${prefix}A1`, kind: 'sprite' });
    p.map.entities.push({ id: prefix, type: 'enemy', x: 100, y: 100, angle: 0, spriteAsset: `${prefix}A1` });
  }
  installEngineScripts(p);
  const assets = { has: () => true, get: name => name, materialSequences: () => [] };
  installSpriteAnimations(p, assets);
  const s = createRuntime(p);
  tick(p, s);
  for (const [prefix, letters] of Object.entries(expected)) {
    const enemy = s.entities.find(e => e.id === prefix);
    enemy.health = 0;
    const clip = p.spriteClips.find(c => c.id === enemy.spriteStates.death);
    assert.deepEqual(clip.frames, [...letters].map(letter => `${prefix}${letter}0`));
  }
  tick(p, s, 150);
  for (const [prefix, letters] of Object.entries(expected)) {
    const enemy = s.entities.find(e => e.id === prefix);
    assert.ok(enemy, 'corpse is retained');
    assert.equal(s.spriteAnimations.get(enemy.id).name, 'death');
    assert.equal(spriteAsset(p, s, enemy), `${prefix}${letters.at(-1)}0`);
  }
});
test('Freedoom shelf bonuses are collected from the lower floor without jumping or climbing a 32-unit step', { skip: !existsSync(freedoom) }, t => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01');
  p.map.entities = p.map.entities.filter(e => e.type !== 'enemy');
  const s = physics(t, p), player = s.entities.find(e => e.type === 'player');
  tick(p, s);
  s.playerStats.health = 41;
  s.physics.teleport(player.id, 320, -88, -64);
  s.player.angle = Math.PI;
  tick(p, s, 20, ['KeyW']);
  assert.ok(s.player.x >= 300, 'capsule remains on the lower side of the shelf');
  assert.ok(Math.abs(s.player.z + 64) < 1, 'player never jumps onto the shelf');
  assert.equal(s.entities.some(e => e.id === 'thing6'), false, 'set-back health bonus is within pickup reach');
  assert.equal(s.playerStats.health, 42);
  assert.ok(s.entities.some(e => e.id === 'thing7'), 'next bonus is not collected from too far away');
});
test('missiles advance over time, select flight frames and leave a finite impact animation rather than disappearing', { skip: !existsSync(freedoom) }, () => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01'), s = createRuntime(p);
  tick(p, s);
  s.entities = s.entities.filter(e => e.type !== 'enemy');
  const action = p.events.find(e => e.name === 'plasmaRifle').actions.find(a => a.type === 'launchProjectile');
  launchProjectile(s, action);
  const projectile = s.projectiles.at(-1), start = { x: projectile.x, y: projectile.y };
  stepRuntime(p, s, .02, new Set());
  assert.ok(Math.abs(Math.hypot(projectile.x - start.x, projectile.y - start.y) - 17.5) < .001);
  assert.ok(clipFrame(p, projectile.clipId, projectile.age).assetId);
  let impact;
  for (let i = 0; i < 200; i++) {
    tick(p, s);
    if (s.impacts.length) { impact = s.impacts[0]; break; }
  }
  assert.ok(impact, 'wall impact produces an effect');
  assert.equal(s.projectiles.length, 0);
  assert.equal(impact.clipId, action.impactClipId);
  tick(p, s, 100);
  assert.equal(s.impacts.length, 0, 'finished impact removed');
});
test('surface animations and sprite-state references are portable and validated', { skip: !existsSync(freedoom) }, () => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01');
  assert.ok(p.materialAnimations.length > 0);
  const animation = p.materialAnimations[0], clip = p.spriteClips.find(c => c.id === animation.clipId);
  assert.notEqual(clipFrame(p, clip.id, 0).assetId, clipFrame(p, clip.id, clip.seconds + .001).assetId);
  for (const mutate of [
    q => { q.spriteClips[0].frames[0] = 'missing'; },
    q => { q.spriteClips[0].seconds = 0; },
    q => { q.materialAnimations[0].clipId = 'missing'; },
    q => { q.materialAnimations[0].assetId = 'missing'; },
    q => { q.map.entities.find(e => e.type === 'enemy').spriteStates.walk = 'missing'; },
    q => { q.events.find(e => e.name === 'plasmaRifle').actions.find(a => a.type === 'launchProjectile').impactClipId = 'missing'; },
  ]) {
    const next = structuredClone(p); mutate(next); assert.throws(() => validateProject(next));
  }
});
