import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIONS, CONDITIONS } from '../shared/project.js';

const doc = readFileSync(new URL('../Docs/visual-scripting.md', import.meta.url), 'utf8');

test('the visual scripting catalogue documents every condition and action', () => {
  const missing = [...CONDITIONS, ...ACTIONS].filter(type => !doc.includes(`\`${type}\``));
  assert.deepEqual(missing, [], `Docs/visual-scripting.md is missing ${missing.join(', ')}`);
});

test('the catalogue documents the wall-walking and interaction area commands', () => {
  // These are the primitives behind "walk on walls" and "player entered area"; the
  // doc claims to be generated from the source, so it must not fall behind them.
  for (const type of ['playerTouchingSurface', 'playerAirborne', 'setPlayerGravity', 'playerInArea', 'playerEnteredArea'])
    assert.ok(doc.includes(`\`${type}\``), `${type} is undocumented`);
});
