// Runs one automation scenario against a single OpenDLE desktop window.
//
//   node tools/automation/run.mjs brushes
//   node tools/automation/run.mjs brushes --port 3000
//
// Output is one JSON line: `{"ok":true,"scenario":"...","seconds":3.1,"result":{...}}`. A failure
// exits non-zero with the failing step named, which is what a regression check needs.

import { withStudio } from './studio.mjs';

const [, , name = 'brushes', ...rest] = process.argv;
const portIndex = rest.indexOf('--port');
const port = portIndex >= 0 ? Number(rest[portIndex + 1]) : Number(process.env.PORT || 3000);

const scenarios = {
  brushes: () => import('./scenarios/brushes.mjs'),
  menus: () => import('./scenarios/menus.mjs'),
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
try {
  const { run, needsStudio = true } = await load();
  // A scenario that drives another window (the exported game, for one) says so, so the run is not
  // held hostage by the editor's licence gate.
  const result = needsStudio ? await withStudio({ port }, run, log => { desktop = log; }) : await run({});
  console.log(JSON.stringify({ ok: true, scenario: name, seconds: Math.round((Date.now() - started) / 100) / 10, result }));
} catch (error) {
  const detail = String(error?.message || error).split('\n');
  // The window's own output is the only evidence left when the desktop process dies mid-run.
  const tail = desktop().split('\n').filter(Boolean).slice(-6);
  if (tail.length) detail.push('--- desktop output ---', ...tail);
  console.log(JSON.stringify({ ok: false, scenario: name, seconds: Math.round((Date.now() - started) / 100) / 10,
    error: detail[0], detail: detail.slice(1, 12) }));
  process.exitCode = 1;
}
