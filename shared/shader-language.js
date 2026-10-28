// A portable GLSL front end, shared by project validation and TSL code generation.
//
// It reads the subset of GLSL an effect needs: typed locals, assignments, `if`/`else`,
// bounded `for` loops, `break`/`continue`/`return`, helper functions, matrices,
// comparisons and logic. That is also the shape Shadertoy shaders are written in, so a
// pasted Shadertoy effect runs here: `shadertoySource` rewrites `mainImage` into the
// `effect` entry point and `parseShaderSource` applies it automatically.
//
// What it deliberately leaves out is anything that could escape the sandbox or never
// terminate: preprocessor directives, `while`/`do`, arrays, structs, and any resource
// other than the screen channels.

const typeSizes = { float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4, mat2: 4, mat3: 9, mat4: 16 };
const matrixSizes = { mat2: 2, mat3: 3, mat4: 4 };
const scalarTypes = new Set(['float', 'int', 'bool']);
const vectorSize = type => (scalarTypes.has(type) ? 1 : matrixSizes[type] ? 1 : Number(String(type).slice(3)) || 1);
const unary = ['abs', 'sign', 'floor', 'ceil', 'fract', 'round', 'trunc', 'sin', 'cos', 'tan', 'asin', 'acos', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt'];
const binary = ['mod', 'min', 'max', 'pow', 'step', 'atan'];
const ternary = ['clamp', 'mix', 'smoothstep'];
const geometry = ['length', 'distance', 'dot', 'cross', 'normalize', 'reflect', 'refract'];
const sampling = ['texture', 'texture2D', 'sampleScreen'];
const constructors = ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4'];

export const shaderIntrinsics = new Set([...constructors, ...sampling, ...unary, ...binary, ...ternary, ...geometry]);
/** The channels an effect can sample; only `iChannel0` is the rendered background. */
export const shaderChannels = new Set(['iChannel0', 'iChannel1', 'iChannel2', 'iChannel3']);

const reserved = new Set(['color', 'uv', 'time', 'screenUv', 'resolution', 'effect', 'mainImage', 'uniforms', 'TSL', 'constructor',
  'prototype', 'return', 'const', 'uniform', 'void', 'if', 'else', 'for', 'while', 'do', 'switch', 'discard', 'break', 'continue',
  'in', 'out', 'inout', 'true', 'false']);

/** Names a shader cannot use as a local: JavaScript internals the compiler maps onto. */
const unsafeLocals = new Set(['constructor', 'prototype', '__proto__', 'TSL', 'uniforms', 'this', 'function', 'var', 'let', 'new', 'class', 'typeof', 'in', 'of', 'with', 'yield', 'await', 'delete', 'void', 'null', 'undefined']);
const validLocalName = name => /^[A-Za-z_]\w{0,47}$/.test(name) && !unsafeLocals.has(name) && !name.startsWith('gl_');

export function validShaderUniformName(name) {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(name) && !reserved.has(name) && !shaderIntrinsics.has(name) && !name.startsWith('gl_');
}

const isType = name => Object.hasOwn(typeSizes, name) || name === 'sampler2D';

const SHADERTOY_ENTRY = /void\s+mainImage\s*\(\s*out\s+vec4\s+([A-Za-z_]\w*)\s*,\s*in\s+vec2\s+([A-Za-z_]\w*)\s*\)\s*\{/;

/**
 * Rewrites a Shadertoy shader into this engine's effect entry point: `mainImage` becomes
 * `effect`, its `fragColor` becomes the value returned and its `fragCoord` becomes the
 * pixel coordinate `iResolution` describes. Helpers and constants above it are untouched.
 */
export function shadertoySource(source) {
  if (typeof source !== 'string') return source;
  const match = SHADERTOY_ENTRY.exec(source);
  if (!match) return source;
  const [head, colour, coord] = match;
  const start = match.index + head.length;
  let depth = 1, index = start;
  for (; index < source.length && depth > 0; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}') depth--;
  }
  if (depth !== 0) throw new Error('Unterminated Shadertoy mainImage body');
  const body = source.slice(start, index - 1);
  return `${source.slice(0, match.index)}${source.slice(index)}
vec4 effect(vec4 color, vec2 uv, float time) {
  // Shadertoy's fragCoord is the pixel on the viewport, not a coordinate inside the object.
  vec2 ${coord} = screenUv * iResolution.xy;
  vec4 ${colour} = vec4(0.0);
${body}
  return ${colour};
}`;
}

/** True when this source is written as a Shadertoy entry point. */
export function isShadertoySource(source) {
  return typeof source === 'string' && SHADERTOY_ENTRY.test(source);
}

/**
 * Parses one effect source. The result holds every function it defines plus the entry
 * point's statements in `body`, which is what the TSL compiler walks.
 */
export function parseShaderSource(rawSource, uniforms = {}) {
  if (typeof rawSource !== 'string' || rawSource.length > 65536) throw new Error('GLSL source must contain at most 65536 characters');
  const source = shadertoySource(rawSource);
  const tokens = [];
  let offset = 0;
  const operators = ['<=', '>=', '==', '!=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%='];
  while (offset < source.length) {
    const rest = source.slice(offset);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) { offset += whitespace[0].length; continue; }
    if (rest.startsWith('//')) { const end = rest.indexOf('\n'); offset += end < 0 ? rest.length : end; continue; }
    if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/', 2);
      if (end < 0) throw new Error(`Unterminated GLSL comment at character ${offset + 1}`);
      offset += end + 2; continue;
    }
    if (rest.startsWith('#')) throw new Error(`Unsupported GLSL preprocessor directive at character ${offset + 1}; write the constant out instead`);
    const operator = operators.find(candidate => rest.startsWith(candidate));
    const match = operator ? [operator] : /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?|[A-Za-z_]\w*|[{}()[\],;.?:!<>=+\-*/%])/.exec(rest);
    if (!match) throw new Error(`Unsupported GLSL token at character ${offset + 1}: ${rest.slice(0, 16)}`);
    if (['while', 'do', 'switch', 'discard'].includes(match[0])) {
      throw new Error(`Unsupported GLSL statement ${match[0]} at character ${offset + 1}; use a for loop with a constant bound, or math intrinsics such as mix, step and smoothstep`);
    }
    tokens.push({ value: match[0], offset }); offset += match[0].length;
    if (tokens.length > 16384) throw new Error('GLSL source exceeds the 16384-token budget');
  }

  let index = 0, nodes = 0;
  const peek = () => tokens[index]?.value;
  const fail = message => { throw new Error(`${message} at character ${(tokens[index]?.offset ?? source.length) + 1}`); };
  function take(expected) {
    const value = peek();
    if (!value || expected && value !== expected) fail(`Expected ${expected || 'GLSL token'}, found ${value || 'end of source'}`);
    index++; return value;
  }
  function identifier() {
    const value = take();
    if (!/^[A-Za-z]\w*$/.test(value)) fail(`Invalid GLSL identifier ${value}`);
    return value;
  }
  function node(value, type) {
    if (++nodes > 8192) fail('GLSL source exceeds the 8192-expression budget');
    return { ...value, valueType: type };
  }
  function compatible(left, right) {
    if (left === right) return left;
    if (left === 'float' || right === 'float') return left === 'float' ? right : left;
    if (vectorSize(left) === vectorSize(right) && left !== 'bool' && right !== 'bool' && !matrixSizes[left] && !matrixSizes[right]) return left;
    fail(`Incompatible GLSL types ${left} and ${right}`);
  }

  // One flat map per scope is enough: blocks add locals, and the compiler gives each
  // local its own variable, so a name can safely be reused in a later block.
  const globals = new Map([
    ['color', { type: 'vec4', mutable: false, input: 'color' }],
    ['uv', { type: 'vec2', mutable: false, input: 'uv' }],
    ['time', { type: 'float', mutable: false, input: 'time' }],
    ['iTime', { type: 'float', mutable: false, input: 'time' }],
    // Where this fragment sits on the viewport (0..1), so an effect can sample what is
    // drawn behind the object and refract it.
    ['screenUv', { type: 'vec2', mutable: false, input: 'screenUv' }],
    ['resolution', { type: 'vec2', mutable: false, input: 'resolution' }],
    ['iResolution', { type: 'vec3', mutable: false, input: 'resolution3' }],
    ['iMouse', { type: 'vec4', mutable: false, input: 'mouse' }],
    ['iFrame', { type: 'float', mutable: false, input: 'frame' }],
    ['true', { type: 'bool', mutable: false, constant: 1 }],
    ['false', { type: 'bool', mutable: false, constant: 0 }],
  ]);
  for (const channel of shaderChannels) globals.set(channel, { type: 'sampler2D', mutable: false });
  for (const [name, value] of Object.entries(uniforms)) {
    if (!validShaderUniformName(name)) fail(`Invalid or reserved uniform name ${name}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e20) fail(`Uniform ${name} must be a finite scalar between -1e20 and 1e20`);
    globals.set(name, { type: 'float', mutable: false, uniform: name });
  }
  const scopes = [globals];
  const lookup = name => {
    for (let depth = scopes.length - 1; depth >= 0; depth--) if (scopes[depth].has(name)) return scopes[depth].get(name);
    return null;
  };
  const functions = new Map();

  const comparisonNames = { '<': 'lessThan', '>': 'greaterThan', '<=': 'lessThanEqual', '>=': 'greaterThanEqual', '==': 'equal', '!=': 'notEqual' };
  const assignmentOperators = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
  const precedence = {
    '||': 4, '&&': 5, '==': 8, '!=': 8, '<': 9, '>': 9, '<=': 9, '>=': 9,
    '+': 10, '-': 10, '*': 20, '/': 20, '%': 20,
  };

  function call(name, args) {
    if (!shaderIntrinsics.has(name)) fail(`Unsupported GLSL function ${name}`);
    const types = args.map(arg => arg.valueType);
    const count = (...allowed) => { if (!allowed.includes(args.length)) fail(`${name} expects ${allowed.join(' or ')} arguments`); };
    if (sampling.includes(name)) {
      if (name === 'sampleScreen') {
        count(1);
        if (types[0] !== 'vec2') fail(`sampleScreen expects a vec2 screen coordinate, not ${types[0]}`);
        return node({ isTexture: true, channel: 'iChannel0', coord: args[0] }, 'vec4');
      }
      count(2);
      const channel = args[0].property;
      if (types[0] !== 'sampler2D' || !shaderChannels.has(channel)) fail(`${name} samples ${[...shaderChannels].join(', ')}; use one of those as the first argument`);
      if (types[1] !== 'vec2') fail(`${name} expects a vec2 coordinate, not ${types[1]}`);
      return node({ isTexture: true, channel, coord: args[1] }, 'vec4');
    }
    if (constructors.includes(name)) {
      const type = name.replace(/^[ib]/, '');
      const size = typeSizes[type];
      if (!args.length) fail(`${name} needs at least one component`);
      const total = types.reduce((sum, item) => sum + (typeSizes[item] || 1), 0);
      const broadcast = args.length === 1 && (scalarTypes.has(types[0]) || vectorSize(types[0]) === size);
      if (!broadcast && total !== size) fail(`Invalid ${name} constructor component count`);
      return node({ isConstructor: true, name: type, params: args }, type);
    }
    if (unary.includes(name)) {
      count(1);
      return node({ isFunctionCall: true, name: name === 'inversesqrt' ? 'inverseSqrt' : name, params: args }, types[0]);
    }
    if (name === 'length') { count(1); return node({ isFunctionCall: true, name, params: args }, 'float'); }
    if (['distance', 'dot'].includes(name)) {
      count(2);
      if (vectorSize(types[0]) !== vectorSize(types[1])) fail(`${name} expects matching vectors`);
      return node({ isFunctionCall: true, name, params: args }, 'float');
    }
    if (name === 'cross') { count(2); if (types[0] !== 'vec3' || types[1] !== 'vec3') fail('cross expects two vec3 values'); return node({ isFunctionCall: true, name, params: args }, 'vec3'); }
    if (name === 'normalize') { count(1); return node({ isFunctionCall: true, name, params: args }, types[0]); }
    if (name === 'reflect') { count(2); return node({ isFunctionCall: true, name, params: args }, types[0]); }
    if (name === 'refract') {
      count(3);
      if (types[0] !== types[1] || types[2] !== 'float') fail('refract expects a matching vector pair and a scalar index');
      return node({ isFunctionCall: true, name, params: args }, types[0]);
    }
    if (name === 'atan') {
      count(1, 2);
      if (args.length === 2 && types[0] !== types[1]) fail('atan expects matching argument types');
      return node({ isFunctionCall: true, name, params: args }, types[0]);
    }
    if (binary.includes(name)) {
      count(2);
      const type = compatible(types[0], types[1]);
      if (name === 'pow' && vectorSize(types[0]) !== vectorSize(types[1])) fail('pow expects matching argument types');
      if (name === 'step' && types[0] !== 'float' && types[0] !== types[1]) fail('step expects a scalar edge or matching vectors');
      return node({ isFunctionCall: true, name, params: args }, type);
    }
    count(3);
    const type = compatible(compatible(types[0], types[1]), types[2] === 'float' ? types[0] : types[2]);
    if (name === 'mix' && (types[0] !== types[1] || types[2] !== 'float' && types[2] !== types[0])) fail('mix expects matching values and a scalar or matching-vector weight');
    if (name === 'clamp' && (types[1] !== types[2] || types[1] !== 'float' && types[1] !== types[0])) fail('clamp expects scalar bounds or bounds matching the value');
    if (name === 'smoothstep' && (types[0] !== types[1] || types[0] !== 'float' && types[0] !== types[2])) fail('smoothstep expects scalar edges or edges matching the value');
    return node({ isFunctionCall: true, name, params: args }, type);
  }

  function userCall(name, args) {
    const fn = functions.get(name);
    if (!fn) fail(`Unsupported GLSL function ${name}`);
    if (fn.params.length !== args.length) fail(`${name} expects ${fn.params.length} argument(s)`);
    return node({ isUserCall: true, name, params: args }, fn.returnType);
  }

  function expression(minimum = 0) {
    if (++nodes > 8192) fail('GLSL source exceeds the 8192-expression budget');
    let value = unaryExpression();
    if (minimum === 0 && peek() === '?') {
      take('?');
      const whenTrue = expression(0);
      take(':');
      const whenFalse = expression(0);
      value = node({ isTernary: true, condition: value, whenTrue, whenFalse }, compatible(whenTrue.valueType, whenFalse.valueType));
    }
    for (;;) {
      const operator = peek();
      const weight = precedence[operator];
      if (weight === undefined || weight < minimum) break;
      take();
      const right = expression(weight + 1);
      value = binaryOperation(operator, value, right);
    }
    return value;
  }

  function binaryOperation(operator, left, right) {
    const leftType = left.valueType, rightType = right.valueType;
    if (operator === '&&' || operator === '||') {
      if (leftType !== 'bool' || rightType !== 'bool') fail(`${operator} expects two comparisons`);
      return node({ isLogic: true, type: operator, left, right }, 'bool');
    }
    if (comparisonNames[operator]) {
      if (vectorSize(leftType) !== vectorSize(rightType)) fail(`Cannot compare ${leftType} with ${rightType}`);
      return node({ isComparison: true, type: operator, left, right }, vectorSize(leftType) === 1 ? 'bool' : `bvec${vectorSize(leftType)}`);
    }
    if (matrixSizes[leftType] || matrixSizes[rightType]) {
      const matrix = matrixSizes[leftType] ? leftType : rightType;
      const other = matrixSizes[leftType] ? rightType : leftType;
      const size = matrixSizes[matrix];
      if (operator === '*') {
        if (matrixSizes[other]) return node({ isOperator: true, type: operator, left, right }, matrix);
        if (vectorSize(other) === size) return node({ isOperator: true, type: operator, left, right }, `vec${size}`);
        if (scalarTypes.has(other)) return node({ isOperator: true, type: operator, left, right }, matrix);
      }
      fail(`Unsupported ${operator} between ${leftType} and ${rightType}`);
    }
    return node({ isOperator: true, type: operator, left, right }, compatible(leftType, rightType));
  }

  function unaryExpression() {
    const value = peek();
    if (value === '-') { take(); const operand = unaryExpression(); return node({ isUnary: true, type: '-', expression: operand }, operand.valueType); }
    if (value === '+') { take(); return unaryExpression(); }
    if (value === '!') { take(); const operand = unaryExpression(); return node({ isUnary: true, type: '!', expression: operand }, operand.valueType); }
    return postfix();
  }

  function postfix() {
    let value = primary();
    for (;;) {
      if (peek() === '.') {
        take('.');
        const swizzle = identifier(), components = vectorSize(value.valueType);
        if (matrixSizes[value.valueType]) fail(`Swizzling ${value.valueType} is not supported; use its components`);
        const alphabet = ['xyzw', 'rgba', 'stpq'].find(group => [...swizzle].every(letter => group.includes(letter)));
        if (!alphabet || swizzle.length > 4 || [...swizzle].some(letter => alphabet.indexOf(letter) >= components)) fail(`Invalid ${value.valueType} swizzle ${swizzle}`);
        value = node({ isSwizzle: true, expression: value, swizzle }, swizzle.length === 1 ? 'float' : `vec${swizzle.length}`);
      } else if (peek() === '[') {
        take('[');
        const at = expression(0);
        take(']');
        value = node({ isIndex: true, expression: value, at }, 'float');
      } else break;
    }
    return value;
  }

  function primary() {
    const value = peek();
    if (value === '(') { take('('); const inner = expression(0); take(')'); return inner; }
    if (/^(?:\d|\.\d)/.test(value || '')) {
      const number = take();
      const literal = Number(number.replace(/[fF]$/, ''));
      if (!Number.isFinite(literal)) fail('GLSL numeric literal must be finite');
      return node({ isNumber: true, value: number }, 'float');
    }
    const name = identifier();
    if (peek() === '(') {
      take('(');
      const args = [];
      if (peek() !== ')') { do { if (peek() === ',') take(','); args.push(expression(0)); } while (peek() === ','); }
      take(')');
      return shaderIntrinsics.has(name) ? call(name, args) : userCall(name, args);
    }
    const entry = lookup(name);
    if (!entry) fail(`Unknown shader input or local ${name}`);
    return node({ isAccessor: true, property: name, source: entry }, entry.type);
  }

  /* ------------------------------------------------------------- statements */

  function block() {
    take('{');
    scopes.push(new Map());
    const body = [];
    while (peek() && peek() !== '}') {
      if (body[body.length - 1]?.isReturn) fail('No statements are allowed after return');
      body.push(statement());
    }
    take('}');
    scopes.pop();
    return body;
  }

  function declaration() {
    const constant = peek() === 'const';
    if (constant) take('const');
    const type = take();
    if (!isType(type) || type === 'sampler2D') fail(`Unsupported GLSL type ${type}`);
    const name = identifier();
    // Shadowing an input or an outer local is legal and Shadertoy code relies on it
    // (`vec2 uv = ...` inside mainImage); redeclaring in the same block is not.
    if (!validLocalName(name) || scopes[scopes.length - 1].has(name)) fail(`Invalid or duplicate local name ${name}`);
    if (peek() !== '=') fail(`Local ${name} needs a value`);
    take('=');
    const value = expression();
    if (peek() === ',') fail('Declare one local per statement');
    take(';');
    if (!(type === value.valueType || scalarTypes.has(type) && scalarTypes.has(value.valueType) || vectorSize(type) === vectorSize(value.valueType) && !matrixSizes[type])) {
      fail(`Local ${name} expects ${type}, not ${value.valueType}`);
    }
    scopes[scopes.length - 1].set(name, { type, mutable: !constant, local: true });
    return { isVariableDeclaration: true, type, name, value };
  }

  function bodyOf() {
    return peek() === '{' ? block() : [statement()];
  }

  function statement() {
    const value = peek();
    if (value === '{') return { isBlock: true, body: block() };
    if (value === ';') { take(';'); return { isBlock: true, body: [] }; }
    if (value === 'if') {
      take('if'); take('(');
      const condition = expression();
      take(')');
      if (condition.valueType !== 'bool' && vectorSize(condition.valueType) === 1) fail('if expects a comparison');
      const then = bodyOf();
      const otherwise = peek() === 'else' ? (take('else'), bodyOf()) : [];
      return { isIf: true, condition, then, otherwise };
    }
    if (value === 'for') {
      take('for'); take('(');
      scopes.push(new Map());
      const init = statement();
      if (!init.isVariableDeclaration) fail('A for loop must declare its counter');
      const condition = expression();
      if (!condition.isComparison) fail('A for loop needs a comparison over the counter, such as i < 16');
      take(';');
      const update = statement();
      if (!update.isAssignment && !update.isIncrement) fail('A for loop needs a counter update such as i++');
      take(')');
      const body = bodyOf();
      scopes.pop();
      return { isFor: true, init, condition, update, body };
    }
    if (value === 'return') {
      take('return');
      if (peek() === ';') { take(';'); return { isReturn: true, value: null }; }
      const returned = expression();
      take(';');
      return { isReturn: true, value: returned };
    }
    if (value === 'break') { take('break'); take(';'); return { isBreak: true }; }
    if (value === 'continue') { take('continue'); take(';'); return { isContinue: true }; }
    if (isType(value) || value === 'const') return declaration();
    const target = primary();
    if (peek() === '++' || peek() === '--') {
      const operator = take();
      const entry = target.isAccessor ? target.source : null;
      if (!entry?.mutable) fail(`Cannot change ${target.property}`);
      return { isIncrement: true, name: target.property, delta: operator === '++' ? 1 : -1 };
    }
    const operator = peek();
    if (assignmentOperators.has(operator)) {
      take();
      const entry = target.isAccessor ? target.source : null;
      if (!entry?.mutable) fail(`Cannot assign to unknown, input, uniform or const variable ${target.property || ''}`);
      let assigned = expression();
      if (operator !== '=') assigned = binaryOperation(operator[0], target, assigned);
      take(';');
      return { isAssignment: true, name: target.property, value: assigned };
    }
    take(';');
    return { isExpression: true, value: target };
  }

  /* -------------------------------------------------------------- functions */

  const definitions = [];
  while (peek()) {
    const returnType = take();
    if (returnType === 'uniform') fail('Declare uniforms in the shader uniforms object, not in GLSL source');
    if (!isType(returnType) || returnType === 'sampler2D') fail(`Unsupported GLSL type ${returnType}`);
    const name = identifier();
    take('(');
    const params = [];
    if (peek() !== ')') {
      do {
        if (params.length) take(',');
        if (peek() === 'in' || peek() === 'inout') take();
        const qualifier = peek() === 'out' ? take() : 'in';
        const type = take();
        if (!isType(type)) fail(`Unsupported GLSL parameter type ${type}`);
        params.push({ type, name: identifier(), qualifier });
      } while (peek() === ',');
    }
    take(')');
    if (functions.has(name)) fail(`Duplicate GLSL function ${name}`);
    const fn = { name, returnType, params, body: null };
    functions.set(name, fn);
    definitions.push(fn);
    scopes.push(new Map(params.map(param => [param.name, { type: param.type, mutable: param.qualifier !== 'in', param: true }])));
    fn.body = block();
    scopes.pop();
  }

  const main = functions.get('effect');
  if (!main) fail('Define exactly one vec4 effect(vec4 color, vec2 uv, float time) function, or paste a Shadertoy shader with mainImage');
  if (main.returnType !== 'vec4') fail(`effect must return vec4, not ${main.returnType}`);
  const signature = main.params.map(param => param.type).join(', ');
  if (signature !== 'vec4, vec2, float') fail(`effect expects (vec4 color, vec2 uv, float time), not (${signature || 'no parameters'})`);
  const returns = [];
  const walk = body => {
    for (const statement of body || []) {
      if (statement.isReturn) returns.push(statement);
      else { walk(statement.then); walk(statement.otherwise); walk(statement.body); if (statement.isBlock) walk(statement.body); }
    }
  };
  walk(main.body);
  if (!returns.length) fail('effect must end with a vec4 return statement');
  for (const returned of returns) {
    if (!returned.value) fail('effect must return a vec4 value');
    if (returned.value.valueType !== 'vec4') fail(`effect must return vec4, not ${returned.value.valueType}`);
  }
  return { body: main.body, functions: definitions, main };
}
