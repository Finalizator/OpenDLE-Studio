// Runs one scenario in GZDoom and keeps its per-tic trace.
//
//   node tools/gzdoom/run.mjs scenarios/map01-idle.json
//   node tools/gzdoom/run.mjs scenarios/map01-idle.json --fullscreen
//
// GZDoom is launched with its own config and save directory (never the player's), no
// autoloads and no sound, so a run is reproducible and leaves nothing behind. The trace
// mod (tools/gzdoom/trace) prints `ODT` lines; they are read from GZDoom's own `+logfile`
// rather than from stdout — a piped stdout is block-buffered, so the lines arrived in
// bursts and a run looked hung while it was in fact working. Polling the log for the final
// `ODT END` also means the process is stopped the moment the scenario is done (140 tics
// take about six seconds) instead of idling until a timeout.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const state = join(here, '.state');
/** A scenario is a few seconds of game time; this is only a guard against a wedged run. */
const TIMEOUT_MS = 120_000;
const POLL_MS = 150;

/** The GZDoom binary to use: GZDOOM_BIN, or the copy fetch.mjs unpacked. */
export function gzdoomBinary() {
  const candidate = process.env.GZDOOM_BIN || join(here, 'dist/gzdoom');
  return existsSync(candidate) ? candidate : null;
}

export function scenarioPath(name) {
  return isAbsolute(name) ? name : join(here, 'scenarios', name.endsWith('.json') ? name : `${name}.json`);
}

/**
 * A scenario's command-line arguments.
 *
 * `+map` is what starts the map. `-warp` looks like the obvious switch but is numeric-only:
 * for a mapxx game GZDoom runs `atoi("MAP01")` on the argument (src/d_main.cpp), gets 0,
 * and looks for MAP00 — the game never starts and the trace stays empty. `-skill` is read
 * while the command line is parsed, so it must precede the map.
 */
function scenarioArgs(scenario, logPath) {
  return [
    '-skill', String(scenario.skill ?? 3),
    `+map ${scenario.map || 'MAP01'}`,
    // The window is on a real desktop, so the mouse and any gamepad would otherwise drive
    // the camera and the player: an "idle" trace came back with the view turning and the
    // player walking away. A trace has to be driven by the scenario alone.
    '+set use_mouse 0', '+set use_joystick 0',
    // An unfocused GZDoom waits between tics on purpose (src/d_net.cpp:
    // `!AppActive && vid_lowerinbackground`), so a spawned run would crawl.
    '+set vid_lowerinbackground 0',
    `+odt_tics ${scenario.tics ?? 140}`,
    `+odt_angle ${scenario.angle ?? 90}`,
    `+odt_action ${scenario.action || ''}`,
    `+odt_watch ${scenario.watch || ''}`,
    `+odt_tid ${scenario.tid ?? 0}`,
    // A summoned actor starts facing the crosshair, away from the player; this turns it
    // once so it can see them and start chasing, which is what a movement trace needs.
    // The tracer places the actor itself, in front of the player and facing them; `summon`
    // was tried first and rejected, because it aims at the crosshair and the resulting
    // position was not reproducible.
    `+odt_face ${scenario.face ? 1 : 0}`,
    `+odt_spawn ${scenario.spawnActor || ''}`,
    `+odt_spawn_distance ${scenario.spawnDistance ?? 96}`,

    `+logfile "${logPath}"`,
  ];
}

export function commandLine(scenario, { windowed = true, logPath = join(state, 'trace.log') } = {}) {
  const iwad = isAbsolute(scenario.iwad) ? scenario.iwad : resolve(root, scenario.iwad);
  return [
    '-iwad', iwad,
    // A scenario that studies one actor wants only that actor: a map monster standing where
    // the summoned one lands is a different experiment, and OpenDLE's monsters refuse to step
    // within 32 units of another — so the trace would measure that rule instead.
    ...(scenario.soloMonsters ? ['-nomonsters'] : []),
    // Doom seeds its random number generator from the clock (`I_MakeRNGSeed`), so two runs of
    // the *same* scenario take different paths and an actor comparison means nothing. A fixed
    // seed makes a scenario reproducible; `-rngseed` is read in D_DoomInit.
    '-rngseed', String(scenario.rngSeed ?? 1),
    '-file', join(here, 'trace'),
    '-config', join(state, 'gzdoom.ini'),
    '-savedir', join(state, 'saves'),
    '-noautoload',
    '-nosound',
    // Windowed by default so a trace run does not take over the desktop.
    ...(windowed ? ['-windowed'] : []),
    ...scenarioArgs(scenario, logPath),
    ...(scenario.args || []),
  ];
}

/**
 * Runs a scenario and resolves with `{ tics, lastTic, lines, log, exitCode, timedOut }`.
 *
 * `lines` holds the `ODT` lines only; `log` is everything GZDoom wrote, which is where a
 * ZScript compile error or a missing WAD shows up.
 */
export async function runScenario(scenario, { windowed = true, timeoutMs = TIMEOUT_MS } = {}) {
  const binary = gzdoomBinary();
  if (!binary) throw new Error('GZDoom is not installed: run `node tools/gzdoom/fetch.mjs` first');
  mkdirSync(join(state, 'saves'), { recursive: true });
  const logPath = join(state, `${scenario.name || 'scenario'}.log`);
  rmSync(logPath, { force: true });
  // GZDoom writes the tracer's own cvars into the config when it exits, so a scenario that
  // ran an actor left `odt_spawn=ZombieMan` behind and the *next* run spawned one too — a
  // baseline quietly measured a scenario it never asked for. The config is therefore rebuilt
  // from defaults for every run; the tracer's knobs live on the command line only.
  rmSync(join(state, 'gzdoom.ini'), { force: true });

  const child = spawn(binary, commandLine(scenario, { windowed, logPath }), {
    cwd: dirname(binary),
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [join(here, 'dist/lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
      SDL_AUDIODRIVER: 'dummy',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });

  const deadline = Date.now() + timeoutMs;
  let finished = false;
  const exited = new Promise(done => child.on('close', code => done(code ?? -1)));
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (existsSync(logPath) && readFileSync(logPath, 'utf8').includes('ODT END')) { finished = true; break; }
    await new Promise(done => setTimeout(done, POLL_MS));
  }
  // GZDoom returns to the title screen after the scenario, so it is stopped rather than
  // left running: the trace it wrote is already complete.
  if (child.exitCode === null) child.kill('SIGKILL');
  const exitCode = await exited;

  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : stderr;
  const lines = log.split('\n').map(line => line.trim()).filter(line => line.startsWith('ODT '));
  return {
    tics: sampleTics(lines), lastTic: lastTicOf(lines), lines, log, exitCode,
    timedOut: !finished && Date.now() >= deadline,
  };
}

/** The highest tic a trace reached, which tells a short run from an incomplete one. */
export function lastTicOf(lines) {
  let last = -1;
  for (const line of lines) {
    const match = /^ODT (\d+) /.exec(line);
    if (match) last = Math.max(last, Number(match[1]));
  }
  return last;
}

/** How many tics a trace actually contains, which is what a comparison needs. */
export function sampleTics(lines) {
  const seen = new Set();
  for (const line of lines) {
    const match = /^ODT (\d+) /.exec(line);
    if (match) seen.add(Number(match[1]));
  }
  return seen.size;
}

/** Writes `<logDir>/<name>.trace` (ODT lines) and `.log` (everything), returns the paths. */
export function saveTrace(name, result, { logDir = join(root, 'logs/gzdoom') } = {}) {
  mkdirSync(logDir, { recursive: true });
  const tracePath = join(logDir, `${name}.trace`);
  const logPath = join(logDir, `${name}.log`);
  writeFileSync(tracePath, `${result.lines.join('\n')}\n`);
  writeFileSync(logPath, result.log);
  return { tracePath, logPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: node tools/gzdoom/run.mjs <scenario.json> [--fullscreen]');
    process.exit(2);
  }
  const scenario = JSON.parse(readFileSync(scenarioPath(name), 'utf8'));
  const result = await runScenario(scenario, { windowed: !process.argv.includes('--fullscreen') });
  const { tracePath, logPath } = saveTrace(scenario.name || 'scenario', result);
  console.log(`tics ${result.tics} | last tic ${result.lastTic} | exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`);
  console.log(`trace ${tracePath}`);
  console.log(`log   ${logPath}`);
  const wanted = scenario.tics ?? 140;
  if (!result.tics) {
    console.error('No ODT lines: the trace mod did not run. Last lines of the log:');
    console.error(result.log.split('\n').slice(-25).join('\n'));
    process.exitCode = 1;
  } else if (result.lastTic < wanted) {
    // A trace that stopped early compares as if the engines agreed on fewer tics, which is
    // exactly the mistake this harness exists to avoid.
    console.error(`Trace stopped at tic ${result.lastTic} of ${wanted}: the run did not finish.`);
    process.exitCode = 1;
  }
}
