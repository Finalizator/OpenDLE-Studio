// Runs one automation scenario against a single OpenDLE desktop window.
//
//   node tools/automation/run.mjs brushes
//   node tools/automation/run.mjs brushes --port 3000
//
// Output is one JSON line: `{"ok":true,"scenario":"...","seconds":3.1,"result":{...}}`. A failure
// exits non-zero with the failing step named, which is what a regression check needs.

import { withStudio } from './studio.mjs';
import { killTracked, startWatchdog } from './lifecycle.mjs';

const [, , name = 'brushes', ...rest] = process.argv;
const portIndex = rest.indexOf('--port');
const port = portIndex >= 0 ? Number(rest[portIndex + 1]) : Number(process.env.PORT || 3000);
// `--timeout <ms>` for the run's deadline. A bare number would be wrong: `--port 3000` carries one.
const timeoutIndex = rest.indexOf('--timeout');
const runTimeout = timeoutIndex >= 0 ? Number(rest[timeoutIndex + 1]) : undefined;

const scenarios = {
  brushes: () => import('./scenarios/brushes.mjs'),
  menus: () => import('./scenarios/menus.mjs'),
  skybox: () => import('./scenarios/skybox.mjs'),
  maps: () => import('./scenarios/maps.mjs'),
  game: () => import('./scenarios/game.mjs'),
  close: () => import('./scenarios/close.mjs'),
};

const load = scenarios[name];
if (!load) {
  console.error(`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

const started = Date.now();
let desktop = () => '';
const elapsed = () => Math.round((Date.now() - started) / 100) / 10;

/** One JSON line, whichever way the run ended. */
function report(ok, { result = undefined, error = null, detail = [] } = {}) {
  const lines = error === null ? [] : String(error).split('\n');
  const extra = lines.slice(1);
  // The window's own output is the only evidence left when the desktop process dies mid-run.
  const tail = desktop().split('\n').filter(Boolean).slice(-6);
  if (tail.length) extra.push('--- desktop output ---', ...tail);
  console.log(JSON.stringify({ ok, scenario: name, seconds: elapsed(),
    ...(ok ? { result } : { error: lines[0], detail: [...extra, ...detail].slice(0, 12) }) }));
}

// A scenario that hangs must fail like any other: the deadline kills the window it started and
// prints the same one-line failure, instead of leaving a game window running with nobody driving it.
const watchdog = startWatchdog({
  ms: Number.isFinite(runTimeout) && runTimeout > 0 ? runTimeout : undefined,
  onTimeout: budget => report(false, {
    error: `The scenario exceeded its ${Math.round(budget / 1000)} s deadline (build included) and was stopped.`,
    detail: ['Set OPENDLE_AUTOMATION_TIMEOUT_MS or pass --timeout <ms> to change the deadline.'],
  }),
});

try {
  const { run, needsStudio = true } = await load();
  // A scenario that drives another window (the exported game, for one) says so, so the run is not
  // held hostage by the editor's licence gate.
  const result = needsStudio ? await withStudio({ port }, run, log => { desktop = log; }) : await run({});
  watchdog.stop();
  // Nothing of the run survives it: the window, the game it exported, the server behind it.
  killTracked();
  report(true, { result });
} catch (error) {
  watchdog.stop();
  killTracked();
  report(false, { error: error?.message || error });
  process.exitCode = 1;
}
