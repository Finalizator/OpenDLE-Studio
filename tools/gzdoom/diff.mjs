// Runs a scenario in both engines and compares them, in one command.
//
//   node tools/gzdoom/diff.mjs scenarios/map01-idle.json
//   node tools/gzdoom/diff.mjs map01-idle            (the .json is optional)
//   node tools/gzdoom/diff.mjs map01-idle --tolerance 0.5 --fields x,y,z
//
// Exit code 0 means the engines agreed for the whole scenario; 1 means they diverged, and
// the report names the first tic and field that differs. That makes it usable as a test.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runScenario, scenarioPath, saveTrace } from './run.mjs';
import { report, compareTraces } from './compare.mjs';
import { readTrace } from './trace.mjs';
import { frameLetter } from './animation.mjs';
import { traceScenario } from './opendle-trace.mjs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/** GZDoom's trace, written to `logs/gzdoom/<name>.trace`. */
export async function recordGzdoom(scenario, options = {}) {
  const result = await runScenario(scenario, options);
  return { result, ...saveTrace(scenario.name || 'scenario', result) };
}

/**
 * Where GZDoom placed the watched actor, read from the first tic of its trace.
 *
 * GZDoom's `summon` picks the spot from the crosshair, so reproducing it in OpenDLE is not a
 * matter of repeating a command: the position has to be read from the trace, which is also
 * what makes the two traces describe the same object rather than two similar ones.
 */
export function spawnFromTrace(tracePath) {
  const trace = readTrace(tracePath);
  const first = trace.samples.find(sample => sample.tag === 'watch');
  if (!first) return null;
  // The frame and the remaining tics travel too: the actor was already mid-state when the
  // trace began, because `summon` happens at console time.
  return { class: first.cls, x: first.x, y: first.y, z: first.z, angle: first.angle,
    frame: first.frame === undefined ? undefined : frameLetter(first.frame), tics: first.tics };
}

/** OpenDLE's trace for the same scenario, written to `logs/opendle/<name>.trace`. */
export function recordOpenDLE(scenario) {
  const result = traceScenario(scenario);
  const logDir = join(root, 'logs/opendle');
  mkdirSync(logDir, { recursive: true });
  const tracePath = join(logDir, `${scenario.name || 'scenario'}.trace`);
  writeFileSync(tracePath, `${result.lines.join('\n')}\n`);
  return { result, tracePath };
}

/**
 * How far each engine moved the watched actor, and the states it passed through.
 *
 * This is the comparable part of actor behaviour: distance closed, and the animation states
 * visited. The exact path is not comparable — `A_Chase` strafes with Doom's random number
 * generator, so two runs differ even in GZDoom itself.
 */
export function actorSummary(gzdoomTrace, opendleTrace) {
  const watched = trace => trace.samples.filter(sample => sample.tag === 'watch');
  const left = watched(gzdoomTrace), right = watched(opendleTrace);
  if (!left.length || !right.length) return null;
  const closed = samples => {
    const first = samples[0], last = samples.at(-1);
    if (!first || !last) return 0;
    return Math.hypot(first.x - last.x, first.y - last.y);
  };
  const states = samples => {
    const seen = [];
    for (const sample of samples) {
      const key = `${sample.frame}`;
      if (seen.at(-1) !== key) seen.push(key);
    }
    return seen.length;
  };
  return `actor ${left[0].cls}: gzdoom moved ${closed(left).toFixed(1)} units over ${states(left)} frame changes`
    + `, opendle ${closed(right).toFixed(1)} over ${states(right)} (paths differ: A_Chase strafes at random)`;
}

function parseArgs(argv) {
  const options = { tolerance: 0.01, fields: undefined, tags: undefined };
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--tolerance') options.tolerance = Number(argv[++index]);
    else if (arg === '--fields') options.fields = argv[++index].split(',');
    else if (arg === '--tags') options.tags = argv[++index].split(',');
    else files.push(arg);
  }
  return { options, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { options, files } = parseArgs(process.argv.slice(2));
  if (files.length !== 1) {
    console.error('usage: node tools/gzdoom/diff.mjs <scenario.json> [--tolerance n] [--fields a,b] [--tags t]');
    process.exit(2);
  }
  const scenario = JSON.parse(readFileSync(scenarioPath(files[0]), 'utf8'));
  const name = scenario.name || 'scenario';

  console.log(`scenario ${name}: ${scenario.map}, skill ${scenario.skill ?? 3}, ${scenario.tics ?? 140} tics, action ${scenario.action || 'idle'}`);
  const gzdoom = await recordGzdoom(scenario);
  console.log(`gzdoom  ${gzdoom.result.tics} samples (last tic ${gzdoom.result.lastTic}) → ${gzdoom.tracePath}`);
  if (!gzdoom.result.tics) {
    console.error(gzdoom.result.log.split('\n').slice(-20).join('\n'));
    process.exit(1);
  }
  const scenarioForOpenDLE = gzdoom.result.lines.some(line => line.includes(' watch '))
    ? { ...scenario, spawn: spawnFromTrace(gzdoom.tracePath) }
    : scenario;
  const opendle = recordOpenDLE(scenarioForOpenDLE);
  console.log(`opendle ${opendle.result.lines.length - 2} samples → ${opendle.tracePath}`);

  // A watched actor is compared as well as the player, so movement and animation are checked
  // on the same run.
  // Height and vertical velocity are left out: the headless runtime has no physics, so an
  // actor does not fall there, and comparing z would report that absence on every tic.
  // Only the options that were actually given may override the defaults: spreading `fields:
  // undefined` back over the object silently restored every field, including the vertical
  // ones this deliberately leaves out.
  const settings = { tolerance: options.tolerance ?? 0.01 };
  if (options.fields) settings.fields = options.fields;
  if (options.tags) settings.tags = options.tags;
  const gzdoomTrace = readTrace(gzdoom.tracePath), opendleTrace = readTrace(opendle.tracePath);
  const result = compareTraces(gzdoomTrace, opendleTrace,
    { fields: ['x', 'y', 'vx', 'vy', 'angle', 'health'], ...settings });
  console.log(report(result));
  const actor = actorSummary(gzdoomTrace, opendleTrace);
  if (actor) console.log(actor);
  // A watched actor's path cannot match tic by tic: Doom's A_Chase strafes at random, and its
  // random number sequence is not reproduced here. The player comparison is what decides the
  // exit code when an actor is present; the actor's own numbers are reported for reading.
  const verdict = result.first && !actor ? 1 : (result.first && actor && result.first.tag !== 'watch' ? 1 : 0);
  process.exitCode = verdict;
}
