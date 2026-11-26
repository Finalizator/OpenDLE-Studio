// Five defects in the script layer: a property read that could not be written the way the
// decompiler writes it, ACS fades that were always black, PlayerInGame inverted, actor height and
// radius read as plain numbers where every other property is 16.16, and constant folding done in
// JS numbers where ACS is signed 32-bit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExpression, expressionContext } from '../shared/expressions.js';
import { readFileSync } from 'node:fs';

test('acsactorproperty takes a property index and passes both arguments through', () => {
  validateExpression({ expr: 'acsactorproperty(3, 0)' }, { reference() {} });
  let call = null;
  const state = { entities: [], picks: new Map(), settings: {},
    scripts: { host: { getActorProperty: (...args) => { call = args; return 7; } } } };
  const value = expressionContext({ map: { entities: [] }, variables: {} }, {}, state).reference('acsactorproperty', [3, 0]);
  assert.equal(value, 7);
  assert.deepEqual(call, [3, 0, 'player'], 'the property index reaches the host');
});

test('PlayerInGame is true for player zero, the one this engine has', () => {
  const source = readFileSync(new URL('../shared/acs.js', import.meta.url), 'utf8');
  assert.match(source, /setTop\(vm, script, 1, peek\(vm, script, 1\) === 0 \? 1 : 0\)/);
});

test('an ACS fade keeps its colours: they are plain bytes, not fixed point', () => {
  const vm = readFileSync(new URL('../shared/acs.js', import.meta.url), 'utf8');
  assert.match(vm, /const scaleColour = value => Math\.max\(0, Math\.min\(255, Math\.round\(value\)\)\);/);
  const decompiler = readFileSync(new URL('../shared/acs-decompile.js', import.meta.url), 'utf8');
  assert.match(decompiler, /const colour = entry => fixed\(entry, 255, value => Math\.round\(value\)\);/);
});

test('APROP_Height and APROP_Radius are 16.16, like every other property', () => {
  const source = readFileSync(new URL('../shared/map-scripts.js', import.meta.url), 'utf8');
  assert.match(source, /case APROP\.height: return Math\.round\(\(actor\?\.height \?\? entity\.height \?\? 0\) \* 65536\);/);
  assert.match(source, /case APROP\.radius: return Math\.round\(\(actor\?\.radius \?\? entity\.radius \?\? 0\) \* 65536\);/);
});

test('constant folding wraps like ACS int32', () => {
  const source = readFileSync(new URL('../shared/acs-decompile.js', import.meta.url), 'utf8');
  assert.match(source, /Math\.imul\(a, b\)/, 'multiplication wraps');
  assert.match(source, /Math\.trunc\(a \/ b\) \| 0/, 'division truncates');
});
