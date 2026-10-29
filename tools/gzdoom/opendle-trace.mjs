// Runs the same scenario in OpenDLE's headless runtime and writes a trace in the same
// format as GZDoom's, so `compare.mjs` can diff the two.
//
//   node tools/gzdoom/opendle-trace.mjs scenarios/map01-idle.json
//
// The scenario is the contract: same IWAD, same map, same tics, same scripted action. If a
// game behaves differently, this is where it shows, tic by tic.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import { ShapeUtils, Vector2 } from 'three';
import { readWad } from '/home/allukard/Code/OpenDLE/shared/wad.js';
import { createPhysics } from '/home/allukard/Code/OpenDLE/shared/physics.js';
import { importWad } from '/home/allukard/Code/OpenDLE/server/import.js';
import { createRuntime, stepRuntime, settleGroundActors } from '/home/allukard/Code/OpenDLE/shared/runtime.js';
import { actorOf } from '/home/allukard/Code/OpenDLE/shared/actor-runtime.js';
import { sectorAt } from '/home/allukard/Code/OpenDLE/shared/sectors.js';
import { NORM_FORWARD, NORM_SIDE } from '/home/allukard/Code/OpenDLE/shared/player-motion.js';
import { TIMELINES, ticInputs } from './make-demo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const TIC = 1 / 35;

export function scenarioPath(name) {
  return isAbsolute(name) ? name : join(here, 'scenarios', name.endsWith('.json') ? name : `${name}.json`);
}

/**
 * The keys that reproduce one tic of a demo's input.
 *
 * A demo cannot be handed to OpenDLE as a file, but it does not have to be: the timeline
 * it is built from is shared (see `TIMELINES` in make-demo.mjs), so the same tic can be
 * replayed here as the key press a person would hold. One description of the input drives
 * both engines instead of two that drift apart.
 *
 * A demo expresses an axis as a number and a key press is only on or off, so the timelines
 * that are meant to mirror the keys use the values a key produces (`NORM_FORWARD`).
 */
function keysFor(input, { run = false } = {}) {
  const keys = new Set();
  if (input.forward > 0) keys.add('KeyW');
  if (input.forward < 0) keys.add('KeyS');
  if (input.side > 0) keys.add('KeyD');
  if (input.side < 0) keys.add('KeyA');
  // Doom's yaw is counter-clockwise, so a positive value is a turn to the left.
  if (input.yaw > 0) keys.add('ArrowLeft');
  if (input.yaw < 0) keys.add('ArrowRight');
  if (run) keys.add('ShiftLeft');
  return keys;
}

/**
 * Steps the scenario and returns `{ lines, state, project }`.
 *
 * The output mimics the trace mod's lines exactly, including the header and the end
 * marker, so both sides are produced and read by the same code.
 */
export async function traceScenario(scenario, { log = () => {} } = {}) {
  const iwad = isAbsolute(scenario.iwad) ? scenario.iwad : resolve(root, scenario.iwad);
  const buffer = readFileSync(iwad);
  const { project, warnings } = importWad(buffer, scenario.map || 'MAP01');
  const map = project.map;

  // The actor the scenario watches is placed where GZDoom put it (see `spawn`), so both
  // traces describe the same thing at the same coordinates. GZDoom's `summon` decides the
  // spot from the crosshair, which is not reproducible here; reading the first tic of its
  // trace is, and a scenario written by hand can pass `spawn` itself.
  let spawned = scenario.spawn ? spawnWatched(project, scenario) : null;

  const state = createRuntime(project, {
    // OpenDLE names the skill setting `difficulty` (1-5); a scenario speaks GZDoom's skill.
    settings: { difficulty: scenario.skill ?? 3, viewSize: 11, fov: 90 },
    screen: 'playing',
    gameMode: true,
  });
  settleGroundActors(state);
  // The runtime builds its entities from the map, so the object pushed above is not the one
  // that ticks: the spawned actor has to be looked up again or the trace reports a frozen
  // state (`tics=-1`) while the state machine runs on a different object.
  if (spawned) {
    spawned = state.entities.find(entity => entity.id === spawned.id) || spawned;
    alignToFirstSample(spawned, project, scenario.spawn);
  }

  // The preview always has a physics world, so a trace without one measures the fallback
  // path instead of the engine: the player stopped at a two-sided line that Rapier walks
  // through, and the divergence that produced was not one the game has.
  if (scenario.physics !== false) {
    await RAPIER.init();
    const triangulate = (outer, holes) => ShapeUtils.triangulateShape(outer.map(point => new Vector2(point.x, point.y)),
      holes.map(ring => ring.map(point => new Vector2(point.x, point.y))));
    state.physics = createPhysics(project, state, RAPIER, triangulate);
  }

  const tics = scenario.tics ?? 140;
  const action = scenario.action || 'idle';
  const lines = [`ODT START map=${scenario.map || 'MAP01'} tics=${tics} action=${action} watch=${scenario.watch || ''} tid=${scenario.tid ?? 0}`];

  const player = state.player;
  // OpenDLE stores Doom's map with y flipped, so its angle runs the other way round:
  // a GZDoom heading of 90° is -90° here, and the trace negates it back when writing.
  if (action === 'aim' && player) player.angle = -(scenario.angle ?? 90) * Math.PI / 180;
  // A demo's tic stream is the scenario's input; `run` is what the demo's own movement
  // values say about speed, and the keys that mean it are Shift, or `alwaysRun`.
  const timeline = scenario.demo ? TIMELINES[scenario.demo] : null;
  const inputs = timeline ? ticInputs(timeline) : [];
  const running = timeline ? inputs.some(input => Math.abs(input.forward) >= NORM_FORWARD.run || Math.abs(input.side) >= NORM_SIDE.run) : false;
  if (running) state.settings.alwaysRun = true;
  // The timeline carries the same eight idle tics GZDoom throws away (see `DEMO_PREROLL`),
  // so command N is the command for traced tic N and nothing has to be skipped here.
  const lead = timeline ? (scenario.demoLead ?? 0) : 0;
  for (let tic = 0; tic <= tics; tic++) {
    // GZDoom prints its sample at the end of the tic it names, so a trace that printed
    // before stepping would describe the previous tic and every position would lag by one.
    const index = tic;
    // GZDoom samples a tic between the momentum update and the position update: its
    // velocity for tic N is the speed the player leaves tic N at, while the position is
    // the one tic N started from (`y[N + 1] - y[N]` equals `v[N]` in every trace). Reading
    // the position from before the step puts both traces on the same instant.
    const beforeStep = { x: player.x, y: player.y, z: player.z };
    stepRuntime(project, state, TIC, index < lead ? new Set() : keysFor(inputs[index] || {}, { run: running }));
    lines.push(playerLine(tic, player, state, project, beforeStep));
    if (spawned) lines.push(watchLine(tic, spawned, state, project));
  }
  lines.push(`ODT END tics=${tics}`);
  return { lines, state, project, warnings };
}

function playerLine(tic, player, state, project, position) {
  if (!player) return `ODT ${tic} player none`;
  // Doom's velocity is momentum in map units per tic, which is what the trace compares.
  const velocity = state.momentum || { x: 0, y: 0, z: 0 };
  const at = position || player;
  const floor = sectorAt(state.sectors, at.x, at.y)?.floorHeight ?? 0;
  const z = at.z ?? floor;
  const health = state.playerStats?.health ?? player.health ?? 0;
  return `ODT ${tic} player cls=DoomPlayer x=${fixed(at.x)} y=${fixed(toGzdoomY(at.y))} z=${fixed(z)}`
    + ` vx=${fixed(velocity.x)} vy=${fixed(toGzdoomY(velocity.y))} vz=${fixed(velocity.z ?? 0)}`
    + ` angle=${fixed(toGzdoomAngle(player.angle))} pitch=${fixed(player.pitch ?? 0)}`
    + ` health=${Math.round(health)} tics=-1`;
}

// OpenDLE keeps Doom's map in screen orientation (y grows downwards) and its angles in
// radians turning the other way, so a comparison has to speak GZDoom's convention first:
// otherwise every tic "differs" and the diff says nothing.
const toGzdoomY = value => -(Number.isFinite(value) ? value : 0);
const toGzdoomAngle = radians => (Number.isFinite(radians) ? -(radians * 180) / Math.PI : 0);

/**
 * Places the watched class where GZDoom placed it.
 *
 * The actor is created the way the importer creates a map monster (`actorName`, no actor id:
 * `initialiseActorEntities` resolves it and fills in its health and size), and it faces the
 * player when the scenario asks for it, because GZDoom's trace handler turns it once for the
 * same reason: a monster with its back turned never sees the player.
 */
function spawnWatched(project, scenario) {
  const spawn = scenario.spawn;
  const actors = project.actors || [];
  const actor = actors.find(entry => entry.name.toLowerCase() === String(spawn.class).toLowerCase());
  const entity = {
    id: `odt_watch_${String(spawn.class).toLowerCase()}`,
    type: 'enemy',
    name: spawn.class,
    actorName: spawn.class,
    // OpenDLE stores the map with y flipped, and so does its angle.
    x: spawn.x,
    y: -spawn.y,
    angle: -spawn.angle * Math.PI / 180,
    // Height is deliberately *not* carried: GZDoom places the actor mid-air and lets it fall,
    // and the headless runtime has no physics, so an actor started at that height never lands
    // — and a monster above its floor refuses every step (`moveEnemy` will not walk down more
    // than 24 units). Vertical motion is physics, which needs Rapier in the trace; the actor
    // is placed on the floor so the horizontal behaviour can be compared now.
    elevation: 0,
    ...(actor ? { health: Math.max(1, actor.health || 20) } : {}),
  };
  project.map.entities.push(entity);
  return entity;
}

/**
 * Starts the actor in the state GZDoom was already in when its trace began.
 *
 * A `summon` happens at console time, so the first traced tic is not the actor's first: the
 * Zombieman is already several tics into its Spawn frame. Without seeding that, the two
 * traces are permanently offset by however long the spawn took, and every later difference
 * is measured against the wrong tic.
 */
function alignToFirstSample(entity, project, spawn) {
  if (!spawn || spawn.frame === undefined) return;
  const actor = actorOf(project, entity);
  const frames = actor?.states?.frames;
  if (!frames) return;
  const label = actor.states.labels?.Spawn ?? 0;
  for (let index = label; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.kind !== 'frame') break;
    if (frame.letter !== spawn.frame) continue;
    entity.actorState = { ...(entity.actorState || {}), index, tics: spawn.tics ?? frame.duration, entered: true };
    return;
  }
}

/** One line for the watched actor, in the same shape GZDoom's tracer prints. */
function watchLine(tic, entity, state, project) {
  const velocity = entity.velocity || { x: 0, y: 0, z: 0 };
  // The sectors live on the runtime, not on the project: reading them from the project gave
  // a floor of zero, and the first divergence reported was that invented height.
  const floor = sectorAt(state.sectors ?? [], entity.x, entity.y)?.floorHeight ?? 0;
  const runtime = entity.actorState || {};
  const actor = actorOf(project, entity);
  const frame = actor?.states?.frames?.[runtime.index ?? -1];
  return `ODT ${tic} watch cls=${entity.actorName || entity.name} x=${fixed(entity.x)} y=${fixed(toGzdoomY(entity.y))} z=${fixed(entity.z ?? floor)}`
    + ` vx=${fixed(velocity.x)} vy=${fixed(toGzdoomY(velocity.y))} vz=${fixed(velocity.z ?? 0)}`
    + ` angle=${fixed(toGzdoomAngle(entity.angle ?? 0))} pitch=0.000`
    + ` health=${Math.round(entity.health ?? 0)} tics=${runtime.tics ?? -1}`
    + ` spr=0 frame=${frame?.letter?.charCodeAt?.(0) ?? -1}`;
}

const fixed = value => (Number.isFinite(value) ? value : 0).toFixed(3);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: node tools/gzdoom/opendle-trace.mjs <scenario.json>');
    process.exit(2);
  }
  const scenario = JSON.parse(readFileSync(scenarioPath(name), 'utf8'));
  const result = await traceScenario(scenario);
  const outDir = join(root, 'logs/opendle');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${scenario.name || 'scenario'}.trace`);
  writeFileSync(out, `${result.lines.join('\n')}\n`);
  console.log(`map ${scenario.map} | ${result.lines.length - 2} samples | entities ${result.state.entities?.length ?? 0} | warnings ${result.warnings?.length ?? 0}`);
  console.log(`trace ${out}`);
}
