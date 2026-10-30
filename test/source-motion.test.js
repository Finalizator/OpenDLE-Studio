import test from 'node:test';
import assert from 'node:assert/strict';
import R from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import {
  AIR_SPEED_CAP, HL2_MOVEMENT, SOURCE_JUMP_SPEED, STANDABLE_NORMAL_Z, accelerate, airAccelerate,
  clipVelocity, friction, horizontalStep, measuredVelocity, standable, tiltedUpNormal, wishFromInput,
} from '../shared/source-motion.js';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { createPhysics } from '../shared/physics.js';
import { installSourceMovementScriptlet, surfRampGeometry, surfRampSurface, SOURCE_MOVEMENT_SHEET } from '../shared/engine-script.js';
import { ENGINE_SCRIPTLETS, buildSurfTestMap, installScriptlet, removeScriptlet } from '../shared/scriptlets.js';

await R.init();
const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
  holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
const DT = 1 / 100;

test('ground friction bleeds at sv_stopspeed and never below zero', () => {
  // Fast: the full speed is used as `control`, so friction is proportional.
  const fast = friction({ x: 320, y: 0, z: 0 }, DT, { onGround: true });
  assert.ok(Math.abs(fast.x - (320 - 320 * 4 * DT)) < 1e-9, `fast ${fast.x}`);
  // Slow: the stop speed is the floor, so a slow player decelerates at a constant rate.
  const slow = friction({ x: 40, y: 0, z: 0 }, DT, { onGround: true });
  assert.ok(Math.abs(slow.x - (40 - 100 * 4 * DT)) < 1e-9, `slow ${slow.x}`);
  // Already slower than the tic's drop: it stops, rather than reversing.
  assert.equal(friction({ x: 1, y: 0, z: 0 }, DT, { onGround: true }).x, 0);
  // No friction on the ground is not the same as friction nowhere: walking on a steep ramp
  // is off the ground, and that is what makes surf possible.
  assert.deepEqual(friction({ x: 320, y: 0, z: 0 }, DT, { onGround: false }), { x: 320, y: 0, z: 0 });
});

test('ground acceleration settles at sv_maxspeed instead of running away', () => {
  let velocity = { x: 0, y: 0, z: 0 };
  const dir = { x: 1, y: 0, z: 0 };
  for (let tic = 0; tic < 600; tic++) {
    velocity = friction(velocity, DT, { onGround: true });
    velocity = accelerate(velocity, dir, 320, DT);
  }
  assert.ok(Math.abs(velocity.x - 320) < .01, `settles at ${velocity.x}`);
  // Never past the wish speed: accelerate only fills the shortfall along the direction.
  assert.ok(accelerate({ x: 400, y: 0, z: 0 }, dir, 320, DT).x === 400);
});

test('air acceleration fills at most 30 units along the wish direction, which is what lets you gain speed', () => {
  // Holding forward while already at 320 in the same direction adds nothing.
  assert.equal(airAccelerate({ x: 320, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 320, DT).x, 320);
  // Strafing perpendicular to the velocity: 30 units of new speed on the new heading, and
  // the total speed grows, which is the air-strafe mechanic.
  const strafed = airAccelerate({ x: 320, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 320, DT);
  assert.ok(Math.abs(strafed.y - AIR_SPEED_CAP) < 1e-9, `gained ${strafed.y}`);
  assert.ok(Math.hypot(strafed.x, strafed.y) > 320, 'total speed increased');
  assert.ok(Math.hypot(strafed.x, strafed.y) - 320 < 1.5, 'but only by the amount the cap allows');
  // The acceleration term uses the uncapped wish speed, so a high airaccelerate behaves
  // like a surf server's.
  const surfServer = airAccelerate({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 320, 1 / 35,
    { settings: { ...HL2_MOVEMENT, airAccelerate: 100 } });
  assert.ok(Math.abs(surfServer.x - AIR_SPEED_CAP) < 1e-9, 'a surf server fills the cap in one tic');
});

test('clip velocity keeps the speed along a surface and drops the part going into it', () => {
  // A 50 degree ramp facing back along -x: its normal is (-0.766, 0, 0.643) in map space.
  const up = tiltedUpNormal({ roll: 50 });
  const normal = { x: up.x, y: up.z, z: up.y };
  assert.ok(Math.abs(normal.z - Math.cos(50 * Math.PI / 180)) < 1e-9);
  assert.equal(standable(normal), false, '50 degrees is too steep to stand on');
  assert.equal(standable({ x: 0, y: 0, z: STANDABLE_NORMAL_Z }), true);
  // Falling straight down onto it keeps the component along the slope, and loses none of it.
  const clipped = clipVelocity({ x: 0, y: 0, z: -100 }, normal);
  const speed = Math.hypot(clipped.x, clipped.y, clipped.z);
  // A fall onto a slope keeps the component along it, which for a 50 degree ramp is sin(50°)
  // of the fall — Source loses the part that went into the surface, not the part along it.
  assert.ok(Math.abs(speed - 100 * Math.sin(50 * Math.PI / 180)) < 1e-9, `speed kept: ${speed}`);
  assert.ok(clipped.x < 0 && clipped.z < 0, 'and it now heads down the ramp');
  // Nothing goes further into the plane.
  assert.ok(clipped.x * normal.x + clipped.y * normal.y + clipped.z * normal.z > -1e-9);
});

test('the wish direction clamps a diagonal to the run speed and follows the view', () => {
  const forward = wishFromInput({ forward: 1, angle: 0 });
  assert.equal(forward.speed, 320);
  assert.deepEqual(forward.dir, { x: 1, y: 0, z: 0 });
  const diagonal = wishFromInput({ forward: 1, side: 1, angle: 0 });
  assert.equal(diagonal.speed, 320, 'walking diagonally is not faster');
  // Facing +y (a quarter turn) sends a forward input along +y.
  const turned = wishFromInput({ forward: 1, angle: Math.PI / 2 });
  assert.ok(Math.abs(turned.dir.y - 1) < 1e-9);
  assert.equal(wishFromInput({}).speed, 0);
});

test('the scriptlet installs editable rules and surf ramps that can be removed again', () => {
  const project = createProject();
  project.events = [];
  const before = project.map.entities.length;
  const sheetId = installScriptlet(project, 'source-movement');
  const sheet = project.eventSheets.find(item => item.id === sheetId);
  assert.equal(sheet.name, SOURCE_MOVEMENT_SHEET);
  const rules = project.events.filter(event => event.sheetId === sheetId);
  assert.equal(rules.length, 2);
  // The movement rule carries every constant as an editable field.
  const movement = rules.find(rule => rule.name === 'source_movement').actions[0];
  assert.equal(movement.type, 'setMotionModel');
  assert.equal(movement.model, 'source');
  assert.equal(movement.airSpeedCap, AIR_SPEED_CAP);
  assert.equal(movement.airAccelerate, 10);
  // "Add to project" installs the rules only: ramps belong to the map-building action, because
  // dropping them into an imported WAD puts them against whatever geometry is already there.
  assert.equal(project.map.entities.length, before, 'adding rules does not move anything');
  assert.equal(project.sourceMovementRamps, undefined);
  // The registry offers that second action.
  const entry = ENGINE_SCRIPTLETS.find(scriptlet => scriptlet.id === 'source-movement');
  assert.equal(typeof entry.build, 'function');
  // Removing the scriptlet takes its rules with it.
  removeScriptlet(project, 'source-movement');
  assert.equal(project.events.filter(event => event.sheetId === sheetId).length, 0);
});

test('the scriptlet can build a new, empty surf map with a surf ramp and a way back up', () => {
  const project = createProject();
  buildSurfTestMap(project);
  // A whole new document: one room, a player, and nothing left of the map that was open.
  assert.doesNotThrow(() => validateProject(project));
  assert.equal(project.title, 'Surf test map');
  assert.equal(project.map.sectors.length, 1);
  assert.equal(project.map.entities.filter(entity => entity.type === 'player').length, 1);
  // Raised above the default 128 units, because the ramp rises 196 and the player is 56 tall.
  assert.ok(project.map.sectors[0].ceilingHeight >= 252);
  const [surfId, backId] = project.sourceMovementRamps;
  const surf = project.map.entities.find(entity => entity.id === surfId);
  const back = project.map.entities.find(entity => entity.id === backId);
  // Only the surf ramp is too steep to stand on, which is what makes it a surf ramp.
  assert.ok(tiltedUpNormal(surf.modelTilt).y < STANDABLE_NORMAL_Z, 'the surf ramp is too steep to stand on');
  assert.ok(tiltedUpNormal(back.modelTilt).y > STANDABLE_NORMAL_Z, 'the way back is walkable');
  const room = project.map.vertices;
  const minX = Math.min(...room.map(vertex => vertex.x)), maxX = Math.max(...room.map(vertex => vertex.x));
  const minY = Math.min(...room.map(vertex => vertex.y)), maxY = Math.max(...room.map(vertex => vertex.y));
  for (const ramp of [surf, back]) {
    const surface = surfRampSurface(ramp);
    const half = ramp.physics.depth / 2;
    // The room outline is the collision, so a ramp sticking out through a wall is one the player
    // slides into the wall.
    assert.ok(Math.min(surface.lowEdgeX, surface.highEdgeX) > minX && Math.max(surface.lowEdgeX, surface.highEdgeX) < maxX,
      `${ramp.id} fits between x ${minX} and ${maxX}`);
    assert.ok(ramp.y - half > minY && ramp.y + half < maxY, `${ramp.id} fits between y ${minY} and ${maxY}`);
    // A ramp is a wedge: its top face meets the floor at the low end, so there is no gap under
    // it for a player to walk into and no lip to climb.
    assert.ok(Math.abs(surface.lowHeight) < 1, `${ramp.id} meets the floor at its low edge (${surface.lowHeight.toFixed(1)})`);
  }
  // The bridge joins the two high edges exactly, so neither join is a step.
  const bridge = project.map.entities.find(entity => entity.id === project.surfBridge);
  const surfSurface = surfRampSurface(surf), backSurface = surfRampSurface(back);
  assert.ok(Math.abs(bridge.physics.height - surfSurface.highHeight) < 1 && Math.abs(bridge.physics.height - backSurface.highHeight) < 1,
    'the bridge is level with both high edges');
  assert.ok(Math.abs(bridge.x - (surfSurface.highEdgeX + backSurface.highEdgeX) / 2) < .01, 'and spans the gap between them');
  // A slope steeper than 45 degrees cannot be walked onto, only started on. An earlier version
  // started the player beside a ramp instead of on it — a ramp's run and its width are different
  // numbers once it is tilted — and they fell past it.
  const start = project.map.entities.find(entity => entity.type === 'player');
  const startSurface = surfRampSurface(surf);
  assert.ok(start.x > Math.min(startSurface.lowEdgeX, startSurface.highEdgeX) &&
    start.x < Math.max(startSurface.lowEdgeX, startSurface.highEdgeX), `player starts on the ramp at ${start.x}`);
  assert.ok(Math.abs(start.y - surf.y) < .01, 'in the ramp\'s lane');
  assert.ok(start.elevation > startSurface.heightAt(start.x) &&
    start.elevation - startSurface.heightAt(start.x) < 12,
    `player stands at ${start.elevation.toFixed(1)} on a surface at ${startSurface.heightAt(start.x).toFixed(1)}`);
  // The movement rules come with it.
  const sheet = project.eventSheets.find(item => item.name === SOURCE_MOVEMENT_SHEET);
  assert.ok(sheet, 'the movement sheet is installed');
  assert.equal(project.events.filter(event => event.sheetId === sheet.id).length, 2);
});

test('sliding from the built map ridge reaches full speed and lands on the floor', async t => {
  const project = buildSurfTestMap(createProject());
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  stepRuntime(project, state, 1 / 35, new Set());
  state.motionSettings = { ...state.motionSettings, airAccelerate: 100 };
  const startZ = state.player.z;
  let airborne = 0, lowest = startZ, maxSpeed = 0;
  for (let tic = 0; tic < 40; tic++) {
    stepRuntime(project, state, 1 / 35, new Set(['KeyW']));
    if (!state.physics.grounded) airborne++;
    lowest = Math.min(lowest, state.player.z);
    maxSpeed = Math.max(maxSpeed, Math.hypot(state.motion.x, state.motion.y));
  }
  // The player starts on the ramp, descends the whole height of it without ever being grounded,
  // and arrives on the floor at speed — the slide a surf ramp is for.
  assert.ok(maxSpeed > 300, `reached ${maxSpeed.toFixed(0)} units a second`);
  assert.ok(airborne >= 10, `airborne for ${airborne} tics on the ramp`);
  assert.ok(startZ > 100 && lowest < 1, `descended from ${startZ.toFixed(0)} to ${lowest.toFixed(0)}`);
});

test('the run speed does not depend on the frame rate the game is drawn at', async t => {
  // A frame that ran no physics substep has nothing to measure, so the movement model must keep
  // its own velocity instead of being told it is standing still. Reporting 0 there made the
  // player crawl: at 174 frames a second most frames run no substep, and each one wiped the
  // speed the previous tic had built.
  const run = framesPerSecond => {
    const project = buildSurfTestMap(createProject());
    const state = createRuntime(project, { screen: 'playing', gameMode: true });
    state.physics = createPhysics(project, state, R, triangulate);
    const clear = () => state.physics.dispose();
    const frame = 1 / framesPerSecond;
    stepRuntime(project, state, frame, new Set());
    let fastest = 0;
    const startX = state.player.x;
    // Half a second, which is long enough to reach top speed and still be on the platform.
    for (let drawn = 0; drawn < Math.round(framesPerSecond / 2); drawn++) {
      stepRuntime(project, state, frame, new Set(['KeyW']));
      fastest = Math.max(fastest, Math.hypot(state.motion.x, state.motion.y));
    }
    const travelled = state.player.x - startX;
    clear();
    return { fastest, travelled };
  };
  const slow = run(35), fast = run(174);
  for (const [label, result] of [['35 fps', slow], ['174 fps', fast]]) {
    assert.ok(result.fastest > 200, `reached ${result.fastest.toFixed(0)} units a second at ${label}`);
    assert.ok(result.travelled > 60, `covered ${result.travelled.toFixed(0)} units in half a second at ${label}`);
  }
  // And the two agree on where the player went, which is the ground truth. The reported speed
  // is not compared: it is the velocity of the last substep that ran, so at a high frame rate it
  // is up to two frames stale and reads low while accelerating.
  assert.ok(Math.abs(slow.travelled - fast.travelled) < 8,
    `travelled ${slow.travelled.toFixed(0)} against ${fast.travelled.toFixed(0)}`);
});

test('a frame without a physics substep reports no measured velocity', async t => {
  const project = buildSurfTestMap(createProject());
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  // The controller only runs a substep once its 1/60 s accumulator fills, so at this frame
  // length the first frames move nothing and must say so rather than claim speed zero.
  const reported = [];
  for (let frame = 0; frame < 6; frame++) {
    state.physics.step(1 / 174, .22, 1, { forward: 0, strafe: 0 }, .06, false);
    reported.push(state.physics.playerVelocity);
  }
  assert.ok(reported.includes(null), 'a frame that ran no substep reports null');
  assert.ok(reported.some(velocity => velocity !== null), 'and a frame that ran one reports speed');
});

test('jumping under Half-Life movement leaves the ground, from the floor and from a solid block', async t => {
  // Half-Life's jump is `sv_jumpvelocity` 160, which is 2.7 units of rise in one 1/60 s
  // substep — less than the 4 units the character controller snaps to the ground over. The snap
  // pulled the player straight back down and the ground test still reported them standing, so
  // jumping did nothing at all under the Source model while Doom's faster jump worked.
  for (const [label, prepare] of [
    ['sector floor', () => {}],
    ['solid block', project => {
      // A 64 unit block under a 128 unit ceiling leaves the 56 unit capsule 8 units of headroom,
      // which is a ceiling test rather than a jump test.
      project.map.sectors[0].ceilingHeight = 256;
      project.map.entities.push({ id: 'block', name: 'Block', type: 'decoration', x: 0, y: 0, angle: 0,
        physics: { body: 'fixed', shape: 'box', width: 200, height: 64, depth: 200, radius: 8, mass: 1,
          friction: .7, restitution: 0, sensor: false, lockRotation: true } });
      // Over the block, not just above its height: the default start is off to one side.
      Object.assign(project.map.entities.find(entity => entity.type === 'player'), { x: 0, elevation: 64 });
    }],
  ]) {
    const project = createProject();
    project.events = [];
    prepare(project);
    const state = createRuntime(project, { screen: 'playing', gameMode: true });
    state.motionModel = 'source';
    state.physics = createPhysics(project, state, R, triangulate);
    t.after(() => state.physics.dispose());
    // A few tics to settle onto whatever is under them.
    for (let tic = 0; tic < 6; tic++) stepRuntime(project, state, 1 / 35, new Set());
    const ground = state.player.z;
    assert.equal(state.physics.grounded, true, `${label}: starts on the ground at ${ground.toFixed(1)}`);
    stepRuntime(project, state, 1 / 35, new Set(['Space']), new Set(['Space']));
    let peak = state.player.z;
    for (let tic = 0; tic < 24; tic++) {
      stepRuntime(project, state, 1 / 35, new Set());
      peak = Math.max(peak, state.player.z);
    }
    // `sv_jumpvelocity² / 2g` at 160 and 600 is 21 units.
    assert.ok(peak > ground + 12, `${label}: rose ${(peak - ground).toFixed(0)} units`);
    assert.ok(Math.abs(state.player.z - ground) < 1, `${label}: came back down`);
    assert.equal(state.physics.grounded, true, `${label}: landed`);
  }
});

test('a surf ramp redirects a fall into speed along the ramp, and the player never touches ground', async t => {
  const project = createProject();
  project.events = [];
  // A 50 degree ramp of this size is 216 units tall, so the default 128 unit ceiling would
  // have it through the roof and the player teleported into the ceiling.
  project.map.sectors[0].ceilingHeight = 384;
  const geometry = surfRampGeometry({ roll: 50 });
  project.map.entities.push({ id: 'ramp', name: 'Surf ramp', type: 'decoration', x: 40, y: 0, angle: 0,
    elevation: geometry.elevation, modelTilt: { pitch: 0, roll: 50 },
    physics: { body: 'fixed', shape: 'box', width: geometry.width, height: geometry.thickness,
      depth: geometry.depth, radius: 8, mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true } });
  validateProject(project);
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.motionModel = 'source';
  // What a surf server runs.
  state.motionSettings = { ...state.motionSettings, airAccelerate: 100 };
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const surface = surfRampSurface(project.map.entities.find(entity => entity.id === 'ramp'));
  const startZ = surface.heightAt(45) + 4;
  state.physics.teleport('player', 45, 0, startZ);
  const speeds = [];
  for (let tic = 0; tic < 15; tic++) {
    stepRuntime(project, state, 1 / 35, new Set(['KeyW']));
    speeds.push(Math.hypot(state.motion.x, state.motion.y));
    assert.equal(state.physics.grounded, false, 'a 50 degree ramp is never ground');
  }
  // Speed builds rather than being absorbed: this is the mechanic surf is made of.
  assert.ok(speeds[0] < 40, `starts slow: ${speeds[0]}`);
  assert.ok(speeds.at(-1) > 100, `gains speed down the ramp: ${speeds.at(-1)}`);
  assert.ok(state.player.z < startZ, 'and the player actually descended');
});

test('a standable slope is walked on with friction instead of surfed', async t => {
  const project = createProject();
  project.events = [];
  project.map.sectors[0].ceilingHeight = 384;
  const geometry = surfRampGeometry({ roll: 30 });
  project.map.entities.push({ id: 'ramp', name: 'Gentle ramp', type: 'decoration', x: 40, y: 0, angle: 0,
    elevation: geometry.elevation, modelTilt: { pitch: 0, roll: 30 },
    physics: { body: 'fixed', shape: 'box', width: geometry.width, height: geometry.thickness,
      depth: geometry.depth, radius: 8, mass: 1, friction: .7, restitution: 0, sensor: false, lockRotation: true } });
  validateProject(project);
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.motionModel = 'source';
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  const surface = surfRampSurface(project.map.entities.find(entity => entity.id === 'ramp'));
  state.physics.teleport('player', 40, 0, surface.heightAt(40) + 2);
  let sawGround = false;
  for (let tic = 0; tic < 20; tic++) {
    stepRuntime(project, state, 1 / 35, new Set());
    if (state.physics.grounded) sawGround = true;
  }
  assert.ok(sawGround, 'a 30 degree ramp is walkable');
  // On the ground, friction holds the player: they do not accelerate down the slope.
  assert.ok(Math.hypot(state.motion.x, state.motion.y) < 30, `held still: ${Math.hypot(state.motion.x, state.motion.y)}`);
});

test('walking under Half-Life movement reaches the run speed and stops with friction', async t => {
  const project = createProject();
  project.events = [];
  validateProject(project);
  const state = createRuntime(project, { screen: 'playing', gameMode: true });
  state.motionModel = 'source';
  state.physics = createPhysics(project, state, R, triangulate);
  t.after(() => state.physics.dispose());
  for (let tic = 0; tic < 40; tic++) stepRuntime(project, state, 1 / 35, new Set(['KeyW']));
  const running = Math.hypot(state.motion.x, state.motion.y);
  assert.ok(running > 300 && running <= 321, `runs at ${running} units a second`);
  for (let tic = 0; tic < 40; tic++) stepRuntime(project, state, 1 / 35, new Set());
  assert.ok(Math.hypot(state.motion.x, state.motion.y) < 5, 'and friction stops the player');
});

test('measured velocity is the speed the world actually moved the player at', () => {
  assert.deepEqual(measuredVelocity({ x: 0, y: 0 }, { x: 10, y: 0 }, .5), { x: 20, y: 0, z: 0 });
  // Pressed against a wall the displacement is nothing, so the speed is nothing.
  assert.deepEqual(measuredVelocity({ x: 5, y: 5 }, { x: 5, y: 5 }, .5), { x: 0, y: 0, z: 0 });
  assert.equal(SOURCE_JUMP_SPEED, 268.3281572999747);
});
