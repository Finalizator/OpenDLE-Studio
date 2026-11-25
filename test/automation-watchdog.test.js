// The automation harness must not outlive its own failure.
//
// A scenario drives a real game window. When that window ends up on its error screen — or stops
// answering altogether — the run used to wait for its own timeout, and a page that had gone took the
// await with it: the node process exited on "unsettled top-level await" and left a game window
// running with nobody driving it. These tests hold the two guards that fix that.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { track, untrack, killTracked, trackedCount } from '../tools/automation/lifecycle.mjs';
import { waitForGame } from '../tools/automation/scenarios/game.mjs';
import { gamePortFor, gamePortCandidates, GAME_PORT_RANGE } from '../server/game-port.js';

/** A stand-in for the CDP page: answers `evaluate` with whatever the test decides. */
function fakePage(answers) {
  let index = 0;
  return {
    calls: 0,
    async evaluate() {
      this.calls++;
      const answer = answers[Math.min(index++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const fatal = { fatal: { title: 'The game could not start', message: 'HUD already exists', hint: 'Try again' } };

test('automation: the game\'s own error screen ends the wait with its words', async () => {
  const page = fakePage([{ value: null }, fatal]);
  // Before: the wait polled for a menu row and reported a timeout 30 s later, never the reason the
  // game had stopped — the error screen the player was looking at.
  await assert.rejects(waitForGame(page, 'null', { timeout: 5000 }),
    error => /HUD already exists/.test(error.message) && /The game could not start/.test(error.message) && /Try again/.test(error.message));
  assert.equal(page.calls, 2, 'it stopped asking the moment the screen appeared');
});

test('automation: a page that throws while being read names the exception', async () => {
  const page = fakePage([{ error: 'Cannot read properties of null' }]);
  await assert.rejects(waitForGame(page, 'window.x', { timeout: 5000 }), /Cannot read properties of null/);
});

test('automation: a state that never arrives times out with the label, not forever', async () => {
  const page = fakePage([{ value: null }]);
  const started = Date.now();
  await assert.rejects(waitForGame(page, 'window.never', { timeout: 300, interval: 50, label: 'the next level' }),
    /Timed out after 0 s waiting for the next level/);
  assert.ok(Date.now() - started < 5000, 'bounded by its own timeout');
});

test('automation: a state that arrives is returned', async () => {
  const page = fakePage([{ value: null }, { value: 'playing' }]);
  assert.equal(await waitForGame(page, 'window.screen', { timeout: 5000 }), 'playing');
});

test('automation: tracked children are killed together, and untracking is honoured', () => {
  const child = () => Object.assign(new EventEmitter(), { killed: false, kill() { this.killed = true; this.emit('exit'); } });
  const first = child(), second = child(), spared = child();
  track(first); track(second); track(spared);
  untrack(spared);
  assert.equal(trackedCount(), 2);
  assert.equal(killTracked(), 2);
  assert.equal(first.killed, true);
  assert.equal(second.killed, true);
  assert.equal(spared.killed, false, 'a child taken out of the run is left alone');
  assert.equal(trackedCount(), 0);
});

test('automation: an exported game keeps one port, so its storage is one origin', () => {
  // The port is the browser origin, and localStorage is per origin: a port that changed between
  // launches threw away the player's settings and saves. It is derived from the game's name instead.
  assert.equal(gamePortFor('imported-wad-game'), gamePortFor('imported-wad-game'));
  assert.notEqual(gamePortFor('imported-wad-game'), gamePortFor('another-game'));
  for (const slug of ['a', 'my-first-opendle-world', 'Hunt Probe', '', null, undefined, 'Привет']) {
    const port = gamePortFor(slug);
    assert.ok(Number.isInteger(port), String(slug));
    assert.ok(port >= GAME_PORT_RANGE.min && port < GAME_PORT_RANGE.min + GAME_PORT_RANGE.span, `${slug} -> ${port}`);
    // Below the ephemeral range Linux hands out for outgoing connections, so it cannot be mistaken
    // for one of those.
    assert.ok(port < 32768, `${slug} -> ${port}`);
  }
  const candidates = gamePortCandidates('imported-wad-game', 4);
  assert.equal(new Set(candidates).size, 4, 'the walk visits four different ports');
  assert.equal(candidates[0], gamePortFor('imported-wad-game'));
});
