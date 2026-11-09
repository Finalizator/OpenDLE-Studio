import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime } from '../shared/runtime.js';
import { evaluateExpression, validateExpression, expressionContext } from '../shared/expressions.js';

const expr = source => ({ expr: source });

test('player() rejects power-up stats the runtime does not expose, instead of validating then crashing', () => {
  const p = createProject();
  p.events = [];
  p.variables = { score: 0 };
  const event = {};
  const context = expressionContext(p, event);
  for (const stat of ['radiationSuit', 'lightAmp', 'allmap']) {
    const source = `player("${stat}")`;
    assert.throws(() => validateExpression(expr(source), context), /Unknown player expression stat/, source);
  }
  // Implemented stats still validate and read their live value.
  const state = createRuntime(p);
  const live = expressionContext(p, event, state);
  validateExpression(expr('player("health")'), live);
  assert.equal(evaluateExpression(expr('player("health")'), live), 100);
  assert.equal(evaluateExpression(expr('player("armor")'), live), 0);
  assert.equal(evaluateExpression(expr('player("invulnerable")'), live), 0);
  // The power-up clocks the pickup rules set are readable too.
  assert.equal(evaluateExpression(expr('player("berserk")'), live), 0);
  assert.equal(evaluateExpression(expr('player("radiation")'), live), 0);
  assert.equal(evaluateExpression(expr('player("invisible")'), live), 0);
  assert.equal(evaluateExpression(expr('player("lightamp")'), live), 0);
});

test('a rule reading a stat the runtime does not expose is rejected at authoring time', () => {
  const p = createProject();
  p.events = [];
  p.variables = { score: 0 };
  p.events.push({
    id: 'megasphere_rule', enabled: true, once: true,
    condition: { type: 'always' },
    actions: [{ type: 'setVariable', variable: 'score', value: expr('player("megasphere")') }],
  });
  assert.throws(() => validateProject(p), /Unknown player expression stat: megasphere/);
});

test('number() reports non-numeric text as such instead of a misleading finite-number error', () => {
  const context = { time: 0, dt: 0, random: () => .5, reference: () => 10 };
  for (const source of ['number("abc")', 'number("1,000")', 'number("Infinity")', 'number("NaN")', 'number("")']) {
    assert.throws(() => evaluateExpression(expr(source), context), /number needs numeric text/, source);
  }
  assert.equal(evaluateExpression(expr('number("42")'), context), 42);
  assert.equal(evaluateExpression(expr('number(" 42 ")'), context), 42);
  assert.equal(evaluateExpression(expr('number("1e3")'), context), 1000);
  assert.equal(evaluateExpression(expr('number(7)'), context), 7);
});
