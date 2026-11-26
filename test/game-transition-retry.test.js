// A level change must not throw the session away on its first failure.
//
// A reported bug (Windows build): on a level change the game said it could not load the textures and
// dropped back to the main menu; a second attempt was fine. Two causes, both in the exported game's
// own script: the frame that carried out the change went on using the engine it had just disposed
// (so the rest of the frame drew with a torn-down renderer), and a start that failed once was never
// tried again. These are static assertions because the script is only meaningful inside the page;
// `npm run automation:game` exercises the same behaviour through a real exported build.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/game/game.js', import.meta.url), 'utf8');

test('the frame stops using an engine a transition has replaced', () => {
  const afterRequests = source.slice(source.indexOf('handleRequests(runtime);'));
  assert.match(afterRequests.slice(0, 1200), /if \(game\.engine !== engine\) return;/,
    'the loop bails out before touching the engine it started the frame with');
});

test('a level that fails to start is tried once more before the menu', () => {
  assert.match(source, /async function playLevel\(levelId, options = \{\}\) \{\n  const \{ attempt = 1, \.\.\.rest \} = options;/);
  assert.match(source, /if \(!record && attempt < 2\) \{[\s\S]{0,200}return 'retry';/);
  assert.match(source, /if \(outcome === 'retry'\) return playLevel\(levelId, \{ \.\.\.rest, attempt: attempt \+ 1 \}\);/);
});

test('a save load is never retried silently', () => {
  // A record that does not fit is a real error: retrying hides the message and costs the player
  // their save. `record` short-circuits the retry, and the load error is kept for the menu to show.
  assert.match(source, /if \(record\) lastLoadError = error\.message;/);
  assert.match(source, /if \(!record && attempt < 2\)/);
});

test('a disposed preview and a disposed HUD refuse to draw', () => {
  const render = readFileSync(new URL('../public/render.js', import.meta.url), 'utf8');
  const hud = readFileSync(new URL('../public/hud-view.js', import.meta.url), 'utf8');
  assert.match(render, /if \(disposed\) \{ globalThis\.__staleRenders/, 'the renderer counts and ignores a stale call');
  assert.match(hud, /function update\(state, \{ selectedId, cursor = state\.hudState\.cursor, screen \} = \{\}\) \{\n    if \(disposed\) return;/);
});
