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
import { readWad } from '/home/allukard/Code/OpenDLE/shared/wad.js';
import { importWad } from '/home/allukard/Code/OpenDLE/server/import.js';
import { createRuntime, stepRuntime, settleGroundActors } from '/home/allukard/Code/OpenDLE/shared/runtime.js';
import { sectorAt } from '/home/allukard/Code/OpenDLE/shared/sectors.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const TIC = 1 / 35;

export function scenarioPath(name) {
  return isAbsolute(name) ? name : join(here, 'scenarios', name.endsWith('.json') ? name : `${name}.json`);
}

/**
 * Keys for a scripted action.
 *
 * Only aiming is scripted, on both sides: OpenDLE cannot be fed a GZDoom demo, and
 * writing the player's velocity directly in GZDoom is not input — it bypasses the engine's
 * movement code (and wedged it against a wall). Walking has to come from a demo or from the
 * person playing, which is what `manual` scenarios are for.
 */
function keysFor() {
  return new Set();
}

/**
 * Steps the scenario and returns `{ lines, state, project }`.
 *
 * The output mimics the trace mod's lines exactly, including the header and the end
 * marker, so both sides are produced and read by the same code.
 */
export function traceScenario(scenario, { log = () => {} } = {}) {
  const iwad = isAbsolute(scenario.iwad) ? scenario.iwad : resolve(root, scenario.iwad);
  const buffer = readFileSync(iwad);
  const { project, warnings } = importWad(buffer, scenario.map || 'MAP01');
  const map = project.map;

  const state = createRuntime(project, {
    // OpenDLE names the skill setting `difficulty` (1-5); a scenario speaks GZDoom's skill.
    settings: { difficulty: scenario.skill ?? 3, viewSize: 11, fov: 90 },
    screen: 'playing',
    gameMode: true,
  });
  settleGroundActors(state);

  const tics = scenario.tics ?? 140;
  const action = scenario.action || 'idle';
  const lines = [`ODT START map=${scenario.map || 'MAP01'} tics=${tics} action=${action} watch=${scenario.watch || ''} tid=${scenario.tid ?? 0}`];

  const player = state.player;
  // OpenDLE stores Doom's map with y flipped, so its angle runs the other way round:
  // a GZDoom heading of 90° is -90° here, and the trace negates it back when writing.
  if (action === 'aim' && player) player.angle = -(scenario.angle ?? 90) * Math.PI / 180;
  for (let tic = 0; tic <= tics; tic++) {
    lines.push(playerLine(tic, player, state, project));
    for (const sample of watched(state, scenario)) lines.push(sample);
    stepRuntime(project, state, TIC, keysFor(action));
  }
  lines.push(`ODT END tics=${tics}`);
  return { lines, state, project, warnings };
}

function playerLine(tic, player, state, project) {
  if (!player) return `ODT ${tic} player none`;
  const velocity = state.velocity || player.velocity || { x: 0, y: 0, z: 0 };
  const floor = sectorAt(state.sectors, player.x, player.y)?.floorHeight ?? 0;
  const z = player.z ?? floor;
  const health = state.playerStats?.health ?? player.health ?? 0;
  return `ODT ${tic} player cls=DoomPlayer x=${fixed(player.x)} y=${fixed(toGzdoomY(player.y))} z=${fixed(z)}`
    + ` vx=${fixed(velocity.x)} vy=${fixed(toGzdoomY(velocity.y))} vz=${fixed(velocity.z ?? 0)}`
    + ` angle=${fixed(toGzdoomAngle(player.angle))} pitch=${fixed(player.pitch ?? 0)}`
    + ` health=${Math.round(health)} tics=-1`;
}

// OpenDLE keeps Doom's map in screen orientation (y grows downwards) and its angles in
// radians turning the other way, so a comparison has to speak GZDoom's convention first:
// otherwise every tic "differs" and the diff says nothing.
const toGzdoomY = value => -(Number.isFinite(value) ? value : 0);
const toGzdoomAngle = radians => (Number.isFinite(radians) ? -(radians * 180) / Math.PI : 0);

/** One line per watched actor of the scenario's class, in engine order. */
function watched(state, scenario) {
  if (!scenario.watch) return [];
  const matches = (state.entities || []).filter(entity => entity.name === scenario.watch || entity.type === scenario.watch);
  return matches.map(entity => {
    const velocity = entity.velocity || entity.vel || { x: 0, y: 0, z: 0 };
    return `ODT ${state.time * 35 | 0} watch cls=${entity.name || entity.type} x=${fixed(entity.x)} y=${fixed(toGzdoomY(entity.y))} z=${fixed(entity.z ?? 0)}`
      + ` vx=${fixed(velocity.x)} vy=${fixed(toGzdoomY(velocity.y))} vz=${fixed(velocity.z ?? 0)}`
      + ` angle=${fixed(toGzdoomAngle(entity.angle ?? 0))} pitch=${fixed(entity.pitch ?? 0)}`
      + ` health=${Math.round(entity.health ?? 0)} tics=-1`;
  });
}

const fixed = value => (Number.isFinite(value) ? value : 0).toFixed(3);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: node tools/gzdoom/opendle-trace.mjs <scenario.json>');
    process.exit(2);
  }
  const scenario = JSON.parse(readFileSync(scenarioPath(name), 'utf8'));
  const result = traceScenario(scenario);
  const outDir = join(root, 'logs/opendle');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${scenario.name || 'scenario'}.trace`);
  writeFileSync(out, `${result.lines.join('\n')}\n`);
  console.log(`map ${scenario.map} | ${result.lines.length - 2} samples | entities ${result.state.entities?.length ?? 0} | warnings ${result.warnings?.length ?? 0}`);
  console.log(`trace ${out}`);
}
