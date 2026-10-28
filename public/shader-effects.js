import * as TSL from 'three/tsl';
import GLSLDecoder from 'three/addons/transpiler/GLSLDecoder.js';
import TSLEncoder from 'three/addons/transpiler/TSLEncoder.js';
import Transpiler from 'three/addons/transpiler/Transpiler.js';
import { parseShaderSource } from '../shared/shader-language.js';

const ZERO = { float: () => TSL.float(0), int: () => TSL.int(0), bool: () => TSL.bool(false),
  vec2: () => TSL.vec2(0), vec3: () => TSL.vec3(0), vec4: () => TSL.vec4(0),
  mat2: () => TSL.mat2(), mat3: () => TSL.mat3(), mat4: () => TSL.mat4() };
const ARITHMETIC = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'remainder' };
const COMPARISONS = { '<': 'lessThan', '>': 'greaterThan', '<=': 'lessThanEqual', '>=': 'greaterThanEqual', '==': 'equal', '!=': 'notEqual' };

/** True when this expression samples the rendered background anywhere inside it. */
function samplesScreen(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.isTexture) return node.channel === 'iChannel0';
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) { if (value.some(samplesScreen)) return true; }
    else if (value && typeof value === 'object' && samplesScreen(value)) return true;
  }
  return false;
}

const blockReturns = (statements) => (statements || []).some(statement =>
  statement.isReturn || blockReturns(statement.then) || blockReturns(statement.otherwise) || blockReturns(statement.body));

/**
 * The GLSL name a local gets in the generated shader.
 *
 * Three's WebGL node builder writes the fragment result into a variable called
 * `fragColor`, and the Shadertoy entry point this engine compiles names its output
 * `fragColor` too, so a local that kept the shader's own name would shadow the output
 * and the whole draw would write nothing at all.
 */
function localName(scope, name) {
  const owner = scope.owner ? `${scope.owner}_` : '';
  return `fx_${owner}${name}`;
}

/**
 * Compiles one portable GLSL effect into a TSL function.
 *
 * `screen` is the texture holding everything drawn behind the object this frame: an
 * effect that samples it distorts what is behind it instead of only being transparent,
 * and `usesScreen` tells the renderer to draw that background pass at all. `resolution`
 * is a uniform holding the viewport size, which `iResolution` (Shadertoy) reports.
 */
export function compileGLSLEffect(shader, { screen = null, resolution = null } = {}) {
  const defaults = shader.uniforms ?? {};
  const parsed = parseShaderSource(shader.source, defaults);
  const prelude = Object.keys(defaults).map(name => `uniform float ${name};`).join('\n');
  const encoder = new TSLEncoder(); encoder.iife = true; encoder.reference = true;
  // Keep the official transpilation available for diagnostics; build the same TSL
  // graph directly from its validated GLSL AST without evaluating JavaScript/CSP exceptions.
  const generated = new Transpiler(new GLSLDecoder(), encoder).parse(`${prelude}\n${shader.source}`);
  const uniforms = Object.fromEntries(Object.entries(defaults).map(([name, value]) => [name, { value }]));
  const references = Object.fromEntries(Object.entries(uniforms).map(([name, entry]) => [name, TSL.reference('value', 'float', entry)]));

  /** A scope chain: a local shadows an input of the same name, as GLSL allows in a block. */
  function scopeOf(parent, entries = []) {
    return { parent, vars: new Map(entries), owner: parent ? parent.owner : '' };
  }
  function resolve(scope, name) {
    for (let current = scope; current; current = current.parent) if (current.vars.has(name)) return current.vars.get(name);
    return null;
  }

  function expression(node, scope, builtins, functions) {
    if (node.isNumber) return TSL.float(Number(String(node.value).replace(/[fF]$/, '')));
    if (node.isAccessor) {
      const found = resolve(scope, node.property);
      if (found) return found;
      return builtins[node.property] ?? TSL.float(0);
    }
    if (node.isSwizzle) return expression(node.expression, scope, builtins, functions)[node.swizzle];
    if (node.isIndex) return expression(node.expression, scope, builtins, functions).element(expression(node.at, scope, builtins, functions));
    if (node.isOperator) {
      const left = expression(node.left, scope, builtins, functions), right = expression(node.right, scope, builtins, functions);
      return left[ARITHMETIC[node.type]](right);
    }
    if (node.isUnary) {
      const value = expression(node.expression, scope, builtins, functions);
      return node.type === '-' ? value.negate() : TSL.not(value);
    }
    if (node.isComparison) return TSL[COMPARISONS[node.type]](expression(node.left, scope, builtins, functions), expression(node.right, scope, builtins, functions));
    if (node.isLogic) {
      const left = expression(node.left, scope, builtins, functions), right = expression(node.right, scope, builtins, functions);
      return node.type === '&&' ? TSL.and(left, right) : TSL.or(left, right);
    }
    if (node.isTernary) return TSL.select(expression(node.condition, scope, builtins, functions),
      expression(node.whenTrue, scope, builtins, functions), expression(node.whenFalse, scope, builtins, functions));
    if (node.isTexture) {
      // Sampling the screen is how an effect refracts what is drawn behind the object.
      if (node.channel !== 'iChannel0' || !builtins.screen) return TSL.vec4(0, 0, 0, 1);
      return TSL.texture(builtins.screen, expression(node.coord, scope, builtins, functions));
    }
    if (node.isUserCall) {
      const target = functions(node.name);
      return target(...node.params.map(parameter => expression(parameter, scope, builtins, functions)));
    }
    if (node.isConstructor) return TSL[node.name](...node.params.map(parameter => expression(parameter, scope, builtins, functions)));
    return TSL[node.name](...node.params.map(parameter => expression(parameter, scope, builtins, functions)));
  }

  /**
   * Compiles the statements of one function.
   *
   * A function writes its value into `result` and flips `done` when it returns, so an
   * early return inside an `if` or a loop ends the function the way GLSL does. Blocks
   * without any return skip that guard entirely, which keeps ordinary effects small.
   */
  function compileStatements(statements, scope, builtins, functions, target) {
    const list = statements || [];
    if (!blockReturns(list)) {
      for (const statement of list) compileStatement(statement, scope, builtins, functions, target);
      return;
    }
    // Locals are declared before the guarded statements, not inside them: a variable
    // created within the `if` that guards everything after a return belongs to that
    // block, so every later read of it reads a variable the function never declares and
    // the fragment stage compiles to nothing at all. The value is still assigned in
    // order by the declaration's own guarded statement.
    const hoisted = new Set();
    for (const statement of list) {
      if (!statement.isVariableDeclaration || !ZERO[statement.type]) continue;
      hoisted.add(statement);
      scope.vars.set(statement.name, ZERO[statement.type]().toVar(localName(scope, statement.name)));
    }
    for (const statement of list) {
      if (statement.isVariableDeclaration && !hoisted.has(statement)) {
        // A type with no known zero is declared where it stands, unguarded: its value is
        // a pure expression, so running it after a return changes nothing.
        compileStatement(statement, scope, builtins, functions, target);
        continue;
      }
      if (statement.isVariableDeclaration) {
        const local = scope.vars.get(statement.name);
        // The callback must not return the assignment: TSL would turn the guarded body
        // into a `return`, which an inline Fn discards, leaving the local at zero.
        TSL.If(target.done.equal(0), () => { local.assign(expression(statement.value, scope, builtins, functions)); });
        continue;
      }
      TSL.If(target.done.equal(0), () => compileStatement(statement, scope, builtins, functions, target));
    }
  }

  function compileStatement(statement, scope, builtins, functions, target) {
    const value = node => expression(node, scope, builtins, functions);
    if (statement.isBlock) {
      compileStatements(statement.body, scopeOf(scope), builtins, functions, target);
      return;
    }
    if (statement.isVariableDeclaration) {
      scope.vars.set(statement.name, value(statement.value).toVar(localName(scope, statement.name)));
      return;
    }
    if (statement.isAssignment) {
      const found = resolve(scope, statement.name);
      if (found?.assign) found.assign(value(statement.value));
      return;
    }
    if (statement.isIncrement) {
      const found = resolve(scope, statement.name);
      found?.addAssign?.(statement.delta);
      return;
    }
    if (statement.isIf) {
      const condition = value(statement.condition);
      const then = () => compileStatements(statement.then, scopeOf(scope), builtins, functions, target);
      if (!statement.otherwise?.length) { TSL.If(condition, then); return; }
      const otherwise = () => compileStatements(statement.otherwise, scopeOf(scope), builtins, functions, target);
      TSL.If(condition, then).Else(otherwise);
      return;
    }
    if (statement.isFor) {
      const loopScope = scopeOf(scope);
      compileStatement(statement.init, loopScope, builtins, functions, target);
      const condition = expression(statement.condition, loopScope, builtins, functions);
      TSL.Loop(condition, () => {
        const bodyScope = scopeOf(loopScope);
        compileStatements(statement.body, bodyScope, builtins, functions, target);
        compileStatement(statement.update, loopScope, builtins, functions, target);
      });
      return;
    }
    if (statement.isReturn) {
      if (statement.value) target.result.assign(value(statement.value));
      target.done.assign(1);
      return;
    }
    if (statement.isBreak) { TSL.Break(); return; }
    if (statement.isContinue) { TSL.Continue(); return; }
    if (statement.isExpression) value(statement.value);
  }

  function compileFunction(fn, params, builtins, functionCache) {
    const result = ZERO[fn.returnType]().toVar();
    const done = TSL.int(0).toVar();
    const scope = scopeOf(null, fn.params.map((param, index) => [param.name, params[index]]));
    scope.owner = fn.name;
    compileStatements(fn.body, scope, builtins, functionCache, { result, done });
    return result;
  }

  const resolutionInput = resolution || TSL.uniform(new Float32Array([1280, 720]));
  const effect = TSL.Fn(([color, uv, time, screenUv]) => {
    const builtins = {
      ...references, color, uv, time, screenUv, screen: screen,
      resolution: resolutionInput,
      resolution3: TSL.vec3(resolutionInput.x, resolutionInput.y, 1),
      mouse: TSL.vec4(0, 0, 0, 0),
      frame: time.mul(60).floor(),
      true: TSL.bool(true), false: TSL.bool(false),
    };
    // Helper functions are compiled inside the effect so they close over the same inputs.
    const compiled = new Map();
    const functions = name => {
      if (!compiled.has(name)) {
        const fn = parsed.functions.find(entry => entry.name === name);
        if (!fn) return (...args) => TSL.float(0);
        const node = TSL.Fn(params => compileFunction(fn, params, builtins, functions));
        compiled.set(name, node);
      }
      return compiled.get(name);
    };
    return compileFunction(parsed.main, [color, uv, time], builtins, functions);
  });
  // Read from the parsed body rather than from the built graph: TSL builds the function
  // body lazily, so asking it afterwards would answer "no sample" and the renderer would
  // never draw the background pass this effect needs.
  const usesScreen = Boolean(screen) && samplesScreen({ body: parsed.body, functions: parsed.functions.map(fn => fn.body) });
  return { effect, uniforms, generated, usesScreen, resolution: resolutionInput };
}
