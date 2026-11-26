// Two separate mistakes, both of which silently changed what an author asked for.
//
// `hudText` ran every `maxLength` element through the digit clamp, so a literal text value was
// renumbered ("007" drew as "7"), and it counted the minus sign outside the field, so "-1234" in
// a three-glyph field drew four glyphs over its neighbours. `acs-decompile` emitted
// `floor(random(min, max))` for ACS's *inclusive* `Random(min, max)`, so every decompiled roll
// lost its top value — a d6 became a d5.

import test from 'node:test';
import assert from 'node:assert/strict';
import { hudText } from '../shared/hud.js';
import { existsSync, readFileSync } from 'node:fs';
import { importWadMap, readWad } from '../shared/wad.js';
import { programFor, acsScriptStepRules } from '../shared/map-scripts.js';

const state = { playerStats: { health: 100, armor: 0 }, variables: {} };

test('a digit field caps its value at the digits it has room for', () => {
  assert.equal(hudText({ binding: 'health', maxLength: 3 }, { ...state, playerStats: { health: 1234 } }), '999');
  assert.equal(hudText({ binding: 'health', maxLength: 2 }, { ...state, playerStats: { health: 7 } }), '7');
});

test('a negative value keeps its sign inside the field', () => {
  // The field is built one glyph per digit, so the sign is a glyph: "-1234" in three cells is "-99".
  assert.equal(hudText({ binding: 'health', maxLength: 3 }, { ...state, playerStats: { health: -1234 } }), '-99');
  assert.equal(hudText({ binding: 'var:score', maxLength: 2 }, { ...state, variables: { score: -120 } }), '-9');
});

test('a literal text value is truncated, never renumbered', () => {
  // `maxLength` is documented as the maximum text length; "007" is a text the author typed.
  assert.equal(hudText({ text: '007', maxLength: 3 }, state), '007');
  assert.equal(hudText({ text: '3.50', maxLength: 4 }, state), '3.50');
  assert.equal(hudText({ text: 'abcdef', maxLength: 3 }, state), 'abc');
});

test('a decompiled ACS random keeps its inclusive top value', { skip: !existsSync(new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url)) }, () => {
  // `Random(map6, map6 + 2)` can pick any of three lines; the expression it becomes has to be able
  // to pick the third, so the half-open `random(min, max)` gets `max + 1`.
  const path = new URL('../Projects/ascentoftitan-1-1/maps/MAP05.wad', import.meta.url);
  const buffer = readFileSync(path);
  const wad = readWad(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const { project } = importWadMap(wad, 'MAP05', { actors: false });
  const program = programFor(project);
  const entry = program.scripts.find(script => script.name === 'randomizeHellTeleport');
  const [rule] = acsScriptStepRules(program, entry, { sheetId: 'sheet', groupId: 'group' });
  const action = rule.actions.find(item => item.type === 'setLineSpecial');
  assert.deepEqual(action.tag, { expr: 'floor(random(acsvar("map", 6), ((acsvar("map", 6) + 2)) + 1))' });
});
