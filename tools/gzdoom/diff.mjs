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
import { traceScenario } from './opendle-trace.mjs';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/** GZDoom's trace, written to `logs/gzdoom/<name>.trace`. */
export async function recordGzdoom(scenario, options = {}) {
  const result = await runScenario(scenario, options);
  return { result, ...saveTrace(scenario.name || 'scenario', result) };
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
  const opendle = recordOpenDLE(scenario);
  console.log(`opendle ${opendle.result.lines.length - 2} samples → ${opendle.tracePath}`);

  const result = compareTraces(readTrace(gzdoom.tracePath), readTrace(opendle.tracePath), options);
  console.log(report(result));
  process.exitCode = result.first ? 1 : 0;
}
