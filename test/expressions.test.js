import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject } from '../shared/project.js';
import { createRuntime, stepRuntime } from '../shared/runtime.js';
import { evaluateExpression, validateExpression, expressionContext, parseExpression } from '../shared/expressions.js';
import { applyTool } from '../server/tools.js';
import { ProjectStore } from '../server/store.js';
import { installDefaultHUD } from '../shared/hud.js';
import { shaderTemplate } from '../shared/shaders.js';

const expr = source => ({ expr: source });
const context = { time: 3, dt: .05, random: () => .25, reference: () => 10 };
const evaluate = source => evaluateExpression(expr(source), context);
const tick = (p, s) => stepRuntime(p, s, .05, new Set());
test('setting expressions validate names and read live settings for editable menu sliders', () => {
  const p = createProject(), s = createRuntime(p), event = { id: 'setting_test' };
  const context = expressionContext(p, event, s);
  validateExpression(expr('setting("volume")'), context);
  assert.equal(evaluateExpression(expr('setting("volume")'), context), .8);
  s.settings.volume = .25;
  assert.equal(evaluateExpression(expr('setting("volume") * 120'), context), 30);
  assert.throws(() => validateExpression(expr('setting("constructor")'), context), /Unknown setting/);
  assert.throws(() => validateExpression(expr('setting("missing")'), context), /Unknown setting/);
});
function fixture() {
  const p = createProject(); p.events = [];
  p.variables = { score: 0, title: 'Hello', enabled: true };
  p.map.entities = p.map.entities.filter(e => e.type === 'player');
  for (const [index, speed] of [2, 4].entries()) p.map.entities.push({
    id: `enemy${index}`, name: `Guard ${index}`, type: 'enemy', x: 100, y: index * 80, angle: 0,
    variables: { speed, title: 'guard', seen: false },
  });
  return p;
}
test('math/text expressions use bounded parsing with explicit types, precedence and short circuit evaluation', () => {
  for (const [source, expected] of [
    ['2 + 3 * 4', 14], ['2 ^ 3 ^ 2', 512], ['(2 + 3) * 4', 20], ['-3 + abs(-4)', 1],
    ['clamp(12, 0, 10) + lerp(0, 10, 0.5)', 15], ['sqrt(9) + round(2.2) + floor(2.9) + ceil(0.1)', 8],
    ['min(3, 4, 1) + max(2, 6)', 7], ['sin(pi / 2)', 1], ['random(4, 8)', 5],
    ['time + dt', 3.05], ['upper(trim("  guard  ")) & str(3)', 'GUARD3'], ['concat("a", 2, true)', 'a2true'],
    ['number("42") + 1', 43], ['len("hello")', 5], ['left("hello", 2) & right("hello", 2)', 'helo'],
    ['mid("hello", 1, 3)', 'ell'], ['replace("a-a", "-", "_")', 'a_a'], ['"-"', '-'], ['"("', '('],
    ['contains("hello", "ell") && find("hello", "l") == 2', true],
    ['false && 1 / 0 > 0', false], ['true || 1 / 0 > 0', true], ['true ? "yes" : str(1 / 0)', 'yes'],
  ]) assert.equal(evaluate(source), expected, source);
  for (const source of ['1/0', 'sqrt(-1)', 'pow(10, 20)', 'number("abc")', 'number("")', '"a" + 1', '!3', '1 && true', 'true < false',
    'unknown()', 'min()', 'global(1)', 'window.alert(1)', 'constructor("x")', '1;2', '1 trailing', '"unterminated']) {
    assert.throws(() => evaluate(source), undefined, source);
  }
  assert.throws(() => parseExpression('('.repeat(40) + '1' + ')'.repeat(40)), /limit/);
  assert.throws(() => parseExpression('1'.repeat(2049)), /2048/);
});
test('object variables are independent per instance; expressions observe sequential actions and inherited sub-event ownership', () => {
  const p = fixture();
  p.events.push({ id: 'parent', enabled: true, once: true, forEachType: 'enemy',
    condition: { type: 'objectVariableCompare', entityId: '$self', variable: 'speed', operator: '>', value: 0 },
    actions: [{ type: 'addObjectVariable', entityId: '$self', variable: 'speed', value: expr('local("speed") * 2') }] },
  { id: 'child', enabled: true, once: true, forEachType: 'enemy', parentId: 'parent',
    condition: { type: 'expressionCompare', left: expr('len(local("title"))'), operator: '=', right: 5 },
    actions: [
      { type: 'setObjectVariable', entityId: '$self', variable: 'title', value: expr('upper(local("title")) & str(local("speed"))') },
      { type: 'setObjectVariable', entityId: '$self', variable: 'seen', value: expr('true') },
      { type: 'addVariable', variable: 'score', value: expr('local("speed")') },
      { type: 'setEntityPosition', entityId: '$self', x: expr('property("$self", "x") + local("speed")'), y: expr('property("$self", "y")') },
      { type: 'showMessage', message: expr('global("title") & " " & local("title")') },
    ] });
  validateProject(p);
  const s = createRuntime(p); tick(p, s);
  const a = s.entities.find(e => e.id === 'enemy0'), b = s.entities.find(e => e.id === 'enemy1');
  assert.deepEqual(a.variables, { speed: 6, title: 'GUARD6', seen: true });
  assert.deepEqual(b.variables, { speed: 12, title: 'GUARD12', seen: true });
  assert.equal(a.x, 106); assert.equal(b.x, 112); assert.equal(s.variables.score, 18);
  assert.equal(s.message, 'Hello GUARD12');
  assert.equal(p.map.entities.find(e => e.id === a.id).variables.speed, 2);
  assert.equal(createRuntime(p).variables.score, 0);
});
test('references reject missing globals, objects and owner variables across all for-each candidates', () => {
  for (const source of ['global("missing")', 'object("missing","speed")', 'local("missing")', 'property("$self","constructor")', 'player("missing")']) {
    const p = fixture(), e = { forEachType: 'enemy' };
    assert.throws(() => validateExpression(expr(source), expressionContext(p, e)), undefined, source);
  }
  const p = fixture();
  assert.throws(() => validateExpression(expr('local("speed")'), expressionContext(p, {})));
  delete p.map.entities.find(e => e.id === 'enemy1').variables.speed;
  assert.throws(() => validateExpression(expr('local("speed")'), expressionContext(p, { forEachType: 'enemy' })));
  assert.equal(evaluateExpression(expr('object("enemy0","speed")'), expressionContext(fixture(), {})), 2);
});
test('runtime expression failures identify the rule, enforce numeric limits, and never silently coerce variable types', () => {
  for (const action of [
    { type: 'setVariable', variable: 'score', value: expr('1 / 0') },
    { type: 'setVariable', variable: 'score', value: expr('"text"') },
    { type: 'moveEnemy', entityId: 'enemy0', speed: expr('-1') },
    { type: 'showMessage', message: expr('42') },
    { type: 'setObjectVariable', entityId: 'enemy0', variable: 'speed', value: expr('"text"') },
  ]) {
    const p = fixture(); p.events.push({ id: 'bad_rule', name: 'Bad expression', enabled: true, once: true, condition: { type: 'always' }, actions: [action] });
    validateProject(p);
    assert.throws(() => tick(p, createRuntime(p)), /Bad expression/);
  }
});
test('global and object-local numeric, text and boolean variables survive persistence and MCP editing with reference validation', () => {
  const p = fixture();
  const updated = applyTool(p, 'variables_set', { entityId: 'enemy0', variables: { speed: 10, title: 'Hello', seen: false } }).project;
  const globals = applyTool(updated, 'variables_set', { variables: { score: 2, text: '', enabled: true } }).project;
  const store = new ProjectStore(null); store.update(globals, 0);
  assert.deepEqual(store.snapshot().project.map.entities[1].variables, globals.map.entities[1].variables);
  assert.equal(p.map.entities[1].variables.speed, 2);
  for (const variables of [JSON.parse('{"__proto__":1}'), { bad: null }, { bad: Infinity }, { bad: 'x'.repeat(4097) }]) {
    const q = fixture(); q.map.entities[1].variables = variables;
    assert.throws(() => validateProject(q));
  }
});
test('HUD numeric properties and captions accept expressions with their existing field-specific limits', () => {
  const p = fixture(); installDefaultHUD(p);
  p.events = [];
  const elementId = p.hud.elements.find(e => e.type === 'text').id;
  p.events.push({ id: 'hud_math', enabled: true, once: true, condition: { type: 'always' }, actions: [
    { type: 'setHUDText', elementId, text: expr('upper(global("title")) & " " & str(player("health"))') },
    { type: 'setHUDProperty', elementId, property: 'opacity', value: expr('1 / 2') },
  ] });
  validateProject(p);
  const s = createRuntime(p); tick(p, s);
  assert.equal(s.hudState.elements.get(elementId).text, 'HELLO 100');
  assert.equal(s.hudState.elements.get(elementId).opacity, .5);
  p.events[0].actions[1].value = expr('2');
  assert.throws(() => tick(p, createRuntime(p)), /HUD opacity/);
});
test('GLSL effects and uniforms are controlled by the same visual-script expressions and persisted through MCP', () => {
  let p = fixture();
  p = applyTool(p, 'shaders_set', { shaders: [{ id: 'effect', name: 'World effect', language: 'glsl',
    source: shaderTemplate, uniforms: { strength: 1 } }], shaderId: 'effect' }).project;
  p.events.push({ id: 'shader_rule', enabled: true, once: true, condition: { type: 'shaderEnabled' }, actions: [
    { type: 'setShaderUniform', uniform: 'strength', value: expr('sin(time) * 0.25 + 0.5') },
    { type: 'setShaderEnabled', enabled: 'no' },
  ] });
  validateProject(p);
  const s = createRuntime(p); tick(p, s);
  assert.equal(s.shaderEnabled, false);
  assert.ok(Math.abs(s.shaderUniforms.get('strength') - (Math.sin(.05) * .25 + .5)) < 1e-9);
  assert.equal(createRuntime(p).shaderUniforms.get('strength'), 1);
  assert.equal(p.shaders[0].uniforms.strength, 1);
  const q = structuredClone(p); q.events[0].actions[0].uniform = 'missing';
  assert.throws(() => validateProject(q), /unknown uniform/);
  assert.throws(() => applyTool(p, 'shaders_set', { shaders: [], shaderId: null }), /selected environment shader/);
  const broken = structuredClone(p); broken.shaders[0].id = p.map.entities[0].id; broken.environment.shaderId = broken.shaders[0].id;
  assert.throws(() => validateProject(broken), /Duplicate ID/);
});
