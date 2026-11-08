import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { createProject, validateProject } from '../shared/project.js';
import { installEngineScripts } from '../shared/engine-script.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { SPRITE_ANIMATIONS } from '../shared/vanilla-animations.js';
import { createPhysics } from '../shared/physics.js';
import { moveSector, installWorldScripts, classicSpecialSupported } from '../shared/world-motion.js';
import { specialName, unsupportedSpecials, teleportDestination } from '../shared/line-specials.js';
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
test('door use respects reach and required key ownership', t => {
  const p = corridor();
  p.events = p.events.filter(e => !e.id.startsWith('world_special_'));
  p.map.walls[1].special = 26;
  installWorldScripts(p, []);
  const s = physics(t, p);
  tick(p, s, 1, [], ['KeyE']);
  assert.equal(s.sectorMotions.size, 0); assert.match(s.message, /blue key/);
  s.inventory.keys.add('blueSkull');
  // Doom's P_UseLines activates every line in the player's 64 unit use box, so a door
  // beside or behind the player still opens; only distance stops the press.
  s.player.angle = Math.PI;
  tick(p, s, 1, [], ['KeyE']); assert.equal(s.sectorMotions.size, 1, 'reached without aiming at it');
  s.sectorMotions.clear();
  s.physics.teleport('player', -180, 0, 0);
  s.player.x = -180; s.player.y = 0;
  tick(p, s, 1, [], ['KeyE']); assert.equal(s.sectorMotions.size, 0, 'out of the 64 unit reach');
  s.player.angle = 0;
  tick(p, s, 1, [], ['KeyE']); assert.equal(s.sectorMotions.size, 0, 'still out of reach');
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
  // Doom's player accelerates, so crossing the line 28 units away takes a few tics more
  // than it did when the engine moved the player at a fixed speed from the first frame.
  tick(p, s, 14, ['KeyW']);
  assert.ok(s.player.x > -32); assert.ok(s.sectorMotions.has('s1:floorHeight'));
  tick(p, s, 20);
  assert.equal(s.sectors[1].floorHeight, 0);
  assert.equal(s.sectors[0].floorHeight, 0); assert.equal(s.sectors[2].floorHeight, 0);
});

test('a repeatable crossing event does not repeat while the player stands still', () => {
  const p = corridor();
  p.map.sectors[1].ceilingHeight = 128;
  p.variables.crossings = 0;
  p.events = [...p.events.filter(event => !event.id.startsWith('world_special_')),
    { id: 'cross', enabled: true, once: false, condition: { type: 'wallActivated', wallId: 'w1', mode: 'cross' },
      actions: [{ type: 'addVariable', variable: 'crossings', value: 1 }] }];
  const s = createRuntime(p);
  for (let frame = 0; frame < 60 && s.player.x <= -32; frame++) tick(p, s, 1, ['KeyW']);
  assert.ok(s.player.x > -32, 'the player crossed the line');
  assert.equal(s.variables.crossings, 1);
  s.momentum = { x: 0, y: 0, z: 0 };
  tick(p, s, 5);
  assert.equal(s.variables.crossings, 1);
  assert.equal(s.worldTriggers.cross.size, 0);
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
  // The pistol's own Fire state has a windup, so hold the trigger long enough for
  // the shot (4 + 6 tics) to actually happen.
  tick(p, s, 12, ['Mouse0']);
  assert.ok(s.timers.has(`${guard.id}:alert`), 'gunfire wakes the guard');
  tick(p, s, 350);
  // A monster walks 8 map units once per See frame — every four tics for a Zombieman — so it
  // covers 70 units a second *while walking*, and spends most of its time in its 26-tic
  // attack at this range, exactly as it does in GZDoom. What must still be true is that it
  // moves at all and that it fights: a frozen AI would fail both.
  const moved = Math.hypot(guard.x - original.x, guard.y - original.y);
  assert.ok(moved > 20, `guard genuinely pursues on the original unfiltered map: ${moved.toFixed(0)} units`);
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
  // The walk clip is built from the actor's own See frames, so it advances
  // through those letters rather than the classic four-letter guess.
  setSpriteState(p, s, guard, 'walk');
  const walk = p.spriteClips.find(clip => clip.id === guard.spriteStates.walk);
  assert.equal(clipFrame(p, walk.id, 0).assetId, walk.frames[0]);
  assert.notEqual(clipFrame(p, walk.id, walk.seconds + .001).assetId, walk.frames[0], 'the walk clip advances');
  const named = id => p.assets.find(asset => asset.id === id).name;
  assert.ok(walk.frames.every(id => named(id).startsWith('POSSA') || /^POSSB|^POSSC|^POSSD/.test(named(id))),
    `walk frames come from the See state: ${walk.frames.map(named)}`);
  setSpriteState(p, s, guard, 'death');
  const death = p.spriteClips.find(clip => clip.id === guard.spriteStates.death);
  const corpse = spriteView(p, s, guard, { x: guard.x, y: guard.y - 100 });
  assert.equal(clipFrame(p, death.id, 100).assetId, death.frames.at(-1), 'the corpse holds the last death frame');
  assert.match(named(death.frames.at(-1)), /^POSS/);
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
  // The rocket launcher is an imported weapon actor whose Rocket projectile carries
  // the flight and explosion clips.
  assert.ok(p.actors.find(actor => actor.name === 'RocketLauncher').flags.WEAPON);
  assert.ok(p.spriteClips.some(clip => clip.id === 'clip_actor_actor_rocket_fly'));
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
  // 200 tics, because a translated monster plays its attack out instead of restarting it: the
  // imp's Missile state is 22 tics with only a few See tics between attacks at this range, so
  // most of any window is spent firing. The walk is still there — it is just a small fraction
  // of it, which is what Doom looks like when you stand next to an imp.
  for (let i = 0; i < 200; i++) {
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
  // The letters used to be a guess written out here; they now come from the animation
  // measured out of GZDoom (`shared/vanilla-animations.js`). What this test still guards is
  // the behaviour: a monster's death plays exactly its Death frames, ends on the corpse and
  // never walks on into the next block (the gib or the resurrection).
  const expected = Object.fromEntries(Object.entries(SPRITE_ANIMATIONS)
    .filter(([, clips]) => clips.death)
    .map(([prefix, clips]) => [prefix, clips.death.letters]));
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
// The Doom 2 staircase in MAP01: 8-unit steps onto landings narrower than the capsule, with
// the upper corridor under a lower ceiling. A capsule cannot shape-cast over a landing that
// narrow, and the player used to stop dead at the foot of the last step, where Doom walks on.
const doom2 = new URL('../Projects/Doom2.wad', import.meta.url);
test('the MAP01 staircase is walked to the top instead of stopping at its narrowest landing', { skip: !existsSync(doom2) }, t => {
  const { project: p } = importWad(readFileSync(doom2), 'MAP01');
  p.map.entities = p.map.entities.filter(e => e.type !== 'enemy');
  // Play mode, because that is where the Doom movement model and its momentum live.
  const s = createRuntime(p, { settings: { difficulty: 3, viewSize: 11, fov: 90 }, screen: 'playing', gameMode: true });
  s.physics = createPhysics(p, s, R, triangulate);
  t.after(() => s.physics.dispose());
  tick(p, s, 8);
  tick(p, s, 130, ['KeyW']);
  assert.ok(s.player.y < -1290, `player walked past the step at y -1280 (stopped at ${s.player.y.toFixed(1)})`);
  assert.ok(s.player.z >= 55, `player stands on the 56-unit corridor floor (was ${s.player.z.toFixed(1)})`);
});
test('missiles advance over time, select flight frames and leave a finite impact animation rather than disappearing', { skip: !existsSync(freedoom) }, () => {
  const { project: p } = importWad(readFileSync(freedoom), 'MAP01'), s = createRuntime(p);
  tick(p, s);
  s.entities = s.entities.filter(e => e.type !== 'enemy');
  // Fire the plasma rifle from its own states: Ready consumes the trigger, then the
  // Fire state's A_FirePlasma launches the PlasmaBall actor.
  s.inventory.weapons.add('plasmaRifle'); s.inventory.selectedWeapon = 'plasmaRifle';
  s.playerStats.cells = 40;
  for (let i = 0; i < 40 && !s.projectiles.length; i++) tick(p, s, 1, ['Mouse0']);
  assert.ok(s.projectiles.length, 'the plasma rifle fired');
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
  assert.equal(impact.clipId, projectile.impactClipId, 'the impact uses the missile Death frames');
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
    q => { q.spriteClips.find(clip => clip.id.endsWith('_fly')).frames[0] = 'missing'; },
  ]) {
    const next = structuredClone(p); mutate(next); assert.throws(() => validateProject(next));
  }
});

test('classic Doom specials keep Doom numbering and the newly performed ones run', () => {
  const project = createProject();
  project.events = [];
  // A tagged room with a tag-19 lowering floor, a tag-97 teleport with a landing
  // marker, and a tag-25 crushing ceiling: Doom numbers, not Hexen ones.
  assert.equal(specialName(19, 'classic'), 'W1 Floor Lower to Lowest');
  assert.equal(specialName(19), 'Thing_Stop', 'the Hexen table keeps its own meaning');
  assert.equal(classicSpecialSupported(19), true);
  assert.equal(classicSpecialSupported(48), false, 'Boom scrolling is not performed');
  assert.deepEqual(unsupportedSpecials([19, 48], { format: 'classic' }), ['48 S1 Scroll Texture Right']);
  assert.deepEqual(unsupportedSpecials([19], { format: 'zdoom' }), ['19 Thing_Stop'],
    'the same number is judged against the map format it came from');
});

/**
 * An L-shaped room tagged 15 with a corridor tagged 0 beside it, and a detached room tagged 8
 * standing in the notch of the L — inside the L's bounding box but not inside the L.
 *
 * This is MAP03's shape, and it is what broke teleporters: the destination marker was looked up
 * by bounding box, so the L-shaped room's teleporter resolved to the *other* room's marker.
 */
function notchedRooms() {
  const p = createProject();
  p.events = [];
  p.map.vertices = [[0, 0], [256, 0], [256, 96], [96, 96], [96, 256], [0, 256], [384, 0], [384, 96],
    [128, 128], [224, 128], [224, 224], [128, 224]].map(([x, y], index) => ({ id: `v${index}`, x, y }));
  p.map.sectors = [
    { id: 'left', floorHeight: 0, ceilingHeight: 160, light: 160, sky: false, tag: 15 },
    { id: 'corridor', floorHeight: 0, ceilingHeight: 160, light: 160, sky: false, tag: 0 },
    { id: 'island', floorHeight: 64, ceilingHeight: 160, light: 160, sky: false, tag: 8 },
  ];
  const side = sectorId => ({ sectorId, offsetX: 0, offsetY: 0 });
  p.map.walls = [
    { id: 'a', a: 'v0', b: 'v1', right: side('left') },
    // Front side facing the corridor, so the L-shaped room walks its own loop in reverse — the
    // same convention `corridor()` uses for its shared door.
    { id: 'teleport', a: 'v2', b: 'v1', right: side('corridor'), left: side('left'), solid: false, special: 97, tag: 15 },
    { id: 'c', a: 'v2', b: 'v3', right: side('left') },
    { id: 'd', a: 'v3', b: 'v4', right: side('left') },
    { id: 'e', a: 'v4', b: 'v5', right: side('left') },
    { id: 'f', a: 'v5', b: 'v0', right: side('left') },
    { id: 'g', a: 'v1', b: 'v6', right: side('corridor') },
    { id: 'h', a: 'v6', b: 'v7', right: side('corridor') },
    { id: 'i', a: 'v7', b: 'v2', right: side('corridor') },
    { id: 'island1', a: 'v8', b: 'v9', right: side('island') },
    { id: 'island2', a: 'v9', b: 'v10', right: side('island') },
    { id: 'island3', a: 'v10', b: 'v11', right: side('island') },
    { id: 'island4', a: 'v11', b: 'v8', right: side('island') },
  ].map(wall => ({ color: '#888888', height: 160, solid: true, ...wall }));
  // The island's marker is listed first, exactly as it is in MAP03: a bounding-box search finds
  // it and every teleporter in the level goes there.
  p.map.entities = [
    { id: 'islandDest', type: 'decoration', name: 'Teleport destination', doomType: 14, x: 176, y: 176, angle: 0 },
    { id: 'leftDest', type: 'decoration', name: 'Teleport destination', doomType: 14, x: 48, y: 48, angle: 90 },
    { id: 'player', type: 'player', name: 'Player', x: 320, y: 48, angle: 180 },
  ];
  installEngineScripts(p);
  installWorldScripts(p, []);
  validateProject(p);
  return p;
}

test('a teleporter lands on the destination inside its own sector, not one beside it', () => {
  const p = notchedRooms();
  const teleport = p.events.find(event => event.actions.some(action => action.type === 'teleport'));
  assert.deepEqual(teleport.actions[0], { type: 'teleport', x: 48, y: 48, z: 0, angle: 90 },
    'the marker inside the tagged sector wins over one that merely shares its bounding box');
  assert.equal(teleport.condition.mode, 'cross');
});

test('a teleport line fixes a landing an older import baked in the wrong room', t => {
  const p = notchedRooms();
  // What the earlier import wrote: the island's marker coordinates, in a project whose line is
  // tagged 15. A coordinate baked at import cannot be trusted, so the line is resolved at play.
  for (const event of p.events) {
    for (const action of event.actions || []) {
      if (action.type === 'teleport') Object.assign(action, { x: 176, y: 176, z: 64, angle: 0 });
    }
  }
  const s = physics(t, p);
  tick(p, s, 1);
  // Walk west out of the corridor across the teleport line into the L-shaped room.
  for (let tic = 0; tic < 60 && s.player.x > 200; tic++) tick(p, s, 1, ['KeyW']);
  assert.ok(s.player.x <= 200, `the line was crossed: ${s.player.x.toFixed(0)}`);
  assert.ok(Math.abs(s.player.x - 48) < 24 && Math.abs(s.player.y - 48) < 24,
    `landed at the marker in the tagged sector, not the island: ${s.player.x.toFixed(0)},${s.player.y.toFixed(0)}`);
  assert.equal(sectorAt(s.sectors, s.player.x, s.player.y)?.id, 'left');
});

test('a tag carried by several sectors finds the marker in whichever of them holds it', () => {
  // GZDoom walks every sector with the tag. Only looking at the first left MAP20's tag-28
  // teleporter with nothing to do, although sector162 of that tag holds a destination.
  const p = notchedRooms();
  p.map.sectors.push({ id: 'annex', floorHeight: 0, ceilingHeight: 160, light: 160, sky: false, tag: 8 });
  const s = createRuntime(p);
  s.entities.push({ id: 'annexPlayer', type: 'decoration', name: 'Marker', x: 176, y: 176, angle: 0 });
  const landing = teleportDestination(s, null, 8);
  assert.deepEqual([landing.x, landing.y], [176, 176], 'the marker in the second sector of tag 8 is the destination');
  assert.equal(teleportDestination(s, null, 99), null, 'a tag no sector carries has no destination');
});

test('a teleport line with no destination thing does nothing, as in Doom', () => {
  const p = notchedRooms();
  p.map.entities = p.map.entities.filter(entity => entity.id !== 'leftDest' && entity.id !== 'islandDest');
  const warnings = [];
  p.events = p.events.filter(event => !event.id.startsWith('world_special_'));
  installWorldScripts(p, warnings);
  assert.equal(p.events.some(event => event.actions.some(action => action.type === 'teleport')), false,
    'no teleport rule is invented for a sector with no marker');
  assert.match(warnings.join('\n'), /no teleport destination thing/i);
});

test('classic Doom specials 97, 25 and 133 become engine rules with baked targets', () => {
  const p = corridor();
  p.events = p.events.filter(e => !e.id.startsWith('world_special_'));
  p.map.walls[5].special = 97; p.map.walls[5].tag = 2;   // WR Teleport into tag 2
  p.map.walls[3].special = 25; p.map.walls[3].tag = 1;   // W1 Ceiling Crush and Raise
  p.map.walls[1].special = 133;  // S1 Blazing Door Blue Key on the corridor door (opens the sector behind it)
  p.map.entities.push({ id: 'landing', type: 'decoration', name: 'Teleport destination', x: 120, y: 40, angle: 90, doomType: 14 });
  const warnings = [];
  installWorldScripts(p, warnings);
  assert.deepEqual(warnings.filter(w => /not yet translated/.test(w)), [], 'these specials are performed');
  validateProject(p);

  const teleport = p.events.find(event => event.actions.some(action => action.type === 'teleport'));
  assert.deepEqual(teleport.actions[0], { type: 'teleport', x: 120, y: 40, z: 0, angle: 90 },
    'the landing marker position and angle are resolved at import, on the destination floor');
  assert.equal(teleport.condition.mode, 'cross');
  assert.equal(teleport.once, false, 'WR teleport lines stay active');

  const crush = p.events.filter(event => event.actions.some(action =>
    action.type === 'moveSector' && action.surface === 'ceilingHeight' && action.returnMode === 'cycle'));
  assert.ok(crush.length, 'a crush-and-raise ceiling cycles');

  const door = p.events.filter(event => /Blazing Door Blue Key/.test(event.name));
  assert.equal(door.length, 3, 'the door, its keyed action and the locked message');
});

test('a blazing key door opens after the key is taken', t => {
  const p = corridor();
  p.events = p.events.filter(e => !e.id.startsWith('world_special_'));
  p.map.walls[1].special = 133;  // S1 Blazing Door Blue Key on the corridor door
  installWorldScripts(p, []);
  const s = physics(t, p);
  tick(p, s, 1, [], ['KeyE']);
  assert.match(s.message, /blue key/);
  s.inventory.keys.add('blueCard');
  tick(p, s, 1, [], ['KeyE']);
  assert.ok(s.sectorMotions.has('s1:ceilingHeight'), 'the door starts opening');
  tick(p, s, 30);
  assert.ok(s.sectors[1].ceilingHeight > 0, 'the ceiling is moving');
});
