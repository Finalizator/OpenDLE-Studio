const vectorSize = type => type === 'float' ? 1 : Number(type.slice(3));
const vectorType = size => size === 1 ? 'float' : `vec${size}`;
const unary = ['abs', 'sign', 'floor', 'ceil', 'fract', 'sin', 'cos', 'tan', 'asin', 'acos', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt'];
const binary = ['mod', 'min', 'max', 'pow', 'step'];
export const shaderIntrinsics = new Set(['float', 'vec2', 'vec3', 'vec4', ...unary, ...binary, 'atan', 'clamp', 'mix', 'smoothstep', 'length', 'distance', 'dot', 'normalize']);
const reserved = new Set(['color', 'uv', 'time', 'effect', 'uniforms', 'TSL', 'constructor', 'prototype', 'return', 'const', 'uniform', 'void', 'bool', 'int', 'uint', 'if', 'else', 'for', 'while', 'do', 'switch', 'discard', 'break', 'continue']);

export function validShaderUniformName(name) {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(name) && !reserved.has(name) && !shaderIntrinsics.has(name) && !name.startsWith('gl_');
}

// This portable GLSL front end is shared by project validation and TSL codegen.
// It intentionally excludes unbounded control flow, resource access and side effects.
export function parseShaderSource(source, uniforms = {}) {
  if (typeof source !== 'string' || source.length > 16384) throw new Error('GLSL source must contain at most 16384 characters');
  const tokens = [];
  let offset = 0;
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
    const match = /^(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?|[A-Za-z_]\w*|[+\-*/%]=|[{}(),;.+\-*/%=])/.exec(rest);
    if (!match) throw new Error(`Unsupported GLSL token at character ${offset + 1}: ${rest.slice(0, 16)}`);
    if (['for', 'while', 'do', 'if', 'else', 'switch', 'discard', 'break', 'continue'].includes(match[0])) throw new Error(`Unsupported GLSL statement ${match[0]} at character ${offset + 1}; use math intrinsics such as mix, step and smoothstep instead of control flow`);
    tokens.push({ value: match[0], offset }); offset += match[0].length;
    if (tokens.length > 4096) throw new Error('GLSL source exceeds the 4096-token budget');
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
    if (++nodes > 1024) fail('GLSL source exceeds the 1024-expression budget');
    return { ...value, valueType: type };
  }
  function compatible(left, right) {
    if (left === right) return left;
    if (left === 'float') return right;
    if (right === 'float') return left;
    fail(`Incompatible GLSL types ${left} and ${right}`);
  }
  const names = new Map([['color', { type: 'vec4', mutable: false }], ['uv', { type: 'vec2', mutable: false }], ['time', { type: 'float', mutable: false }]]);
  for (const [name, value] of Object.entries(uniforms)) {
    if (!validShaderUniformName(name)) fail(`Invalid or reserved uniform name ${name}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e20) fail(`Uniform ${name} must be a finite scalar between -1e20 and 1e20`);
    names.set(name, { type: 'float', mutable: false });
  }
  function call(name, args) {
    if (!shaderIntrinsics.has(name)) fail(`Unsupported GLSL function ${name}`);
    const types = args.map(arg => arg.valueType);
    const count = (...allowed) => { if (!allowed.includes(args.length)) fail(`${name} expects ${allowed.join(' or ')} arguments`); };
    let type;
    if (/^(float|vec[234])$/.test(name)) {
      const size = vectorSize(name), total = types.reduce((sum, t) => sum + vectorSize(t), 0);
      if (!args.length || !(args.length === 1 && (types[0] === 'float' || vectorSize(types[0]) >= size) || total === size)) fail(`Invalid ${name} constructor component count`);
      type = name;
    } else if (unary.includes(name)) {
      count(1); type = types[0];
    } else if (['length', 'normalize'].includes(name)) {
      count(1);
      if (types[0] === 'float') fail(`${name} expects a vector`);
      type = name === 'length' ? 'float' : types[0];
    } else if (['distance', 'dot'].includes(name)) {
      count(2);
      if (types[0] !== types[1] || types[0] === 'float') fail(`${name} expects matching vectors`);
      type = 'float';
    } else if (name === 'atan') {
      count(1, 2); type = types[0];
      if (args.length === 2 && types[0] !== types[1]) fail('atan expects matching argument types');
    } else if (binary.includes(name)) {
      count(2); type = compatible(types[0], types[1]);
      if (name === 'pow' && types[0] !== types[1]) fail('pow expects matching argument types');
      if (name === 'step' && types[0] !== 'float' && types[0] !== types[1]) fail('step expects a scalar edge or matching vectors');
    } else {
      count(3);
      type = compatible(compatible(types[0], types[1]), types[2]);
      if (name === 'mix' && (types[0] !== types[1] || types[2] !== 'float' && types[2] !== types[0])) fail('mix expects matching values and a scalar or matching-vector weight');
      if (name === 'clamp' && (types[1] !== types[2] || types[1] !== 'float' && types[1] !== types[0])) fail('clamp expects scalar bounds or bounds matching the value');
      if (name === 'smoothstep' && (types[0] !== types[1] || types[0] !== 'float' && types[0] !== types[2])) fail('smoothstep expects scalar edges or edges matching the value');
    }
    return node({ isFunctionCall: true, name: name === 'inversesqrt' ? 'inverseSqrt' : name, params: args }, type);
  }
  function expression(minimum = 0, depth = 0) {
    if (depth > 64) fail('Expression nesting exceeds 64 levels');
    let value;
    if (['+', '-'].includes(peek())) {
      const operator = take(); const operand = expression(30, depth + 1);
      value = node({ isUnary: true, type: operator, expression: operand }, operand.valueType);
    } else if (peek() === '(') {
      take('('); value = expression(0, depth + 1); take(')');
    } else if (/^(?:\d|\.\d)/.test(peek() || '')) {
      const number = take();
      if (!Number.isFinite(Number(number.replace(/[fF]$/, '')))) fail('GLSL numeric literal must be finite');
      value = node({ isNumber: true, value: number }, 'float');
    } else {
      const name = identifier();
      if (peek() === '(') {
        take('('); const args = [];
        if (peek() !== ')') {
          do { if (args.length) take(','); args.push(expression(0, depth + 1)); } while (peek() === ',');
        }
        take(')'); value = call(name, args);
      } else {
        const entry = names.get(name);
        if (!entry) fail(`Unknown shader input or local ${name}`);
        value = node({ isAccessor: true, property: name }, entry.type);
      }
    }
    while (peek() === '.') {
      take('.'); const swizzle = identifier(), components = vectorSize(value.valueType);
      const alphabet = ['xyzw', 'rgba', 'stpq'].find(group => [...swizzle].every(letter => group.includes(letter)));
      if (!alphabet || swizzle.length > 4 || components === 1 || [...swizzle].some(letter => alphabet.indexOf(letter) >= components)) fail(`Invalid ${value.valueType} swizzle ${swizzle}`);
      value = node({ isSwizzle: true, expression: value, swizzle }, vectorType(swizzle.length));
    }
    const precedence = { '+': 10, '-': 10, '*': 20, '/': 20, '%': 20 };
    while ((precedence[peek()] ?? -1) >= minimum) {
      const operator = take(), right = expression(precedence[operator] + 1, depth + 1);
      value = node({ isOperator: true, type: operator, left: value, right }, compatible(value.valueType, right.valueType));
    }
    return value;
  }
  if (peek() === 'uniform') fail('Declare uniforms in the shader uniforms object, not in GLSL source');
  take('vec4'); take('effect'); take('(');
  for (const [position, [type, name]] of [['vec4', 'color'], ['vec2', 'uv'], ['float', 'time']].entries()) {
    if (position) take(',');
    take(type); take(name);
  }
  take(')'); take('{');
  const body = [];
  let locals = 0, returned = false;
  while (peek() && peek() !== '}') {
    if (returned) fail('No statements are allowed after return');
    if (['for', 'while', 'do', 'if', 'else', 'switch', 'discard', 'break', 'continue'].includes(peek())) fail(`Unsupported GLSL statement ${peek()}; use math intrinsics such as mix, step and smoothstep instead of control flow`);
    if (peek() === 'uniform') fail('Declare uniforms in the shader uniforms object, not in GLSL source');
    if (peek() === 'return') {
      take('return'); const value = expression();
      if (value.valueType !== 'vec4') fail(`effect must return vec4, not ${value.valueType}`);
      take(';'); body.push({ isReturn: true, value }); returned = true; continue;
    }
    const constant = peek() === 'const';
    if (constant) take('const');
    if (['float', 'vec2', 'vec3', 'vec4'].includes(peek())) {
      const type = take(), name = identifier();
      if (!validShaderUniformName(name) || names.has(name)) fail(`Invalid, reserved or duplicate local name ${name}`);
      take('='); const value = expression();
      if (value.valueType !== type) fail(`Local ${name} expects ${type}, not ${value.valueType}`);
      take(';'); names.set(name, { type, mutable: !constant });
      body.push({ isVariableDeclaration: true, type, name, value });
      if (++locals > 64) fail('An effect supports at most 64 local variables');
    } else {
      if (constant) fail('const requires a float or vector declaration');
      const name = identifier(), entry = names.get(name), operator = take();
      if (!entry?.mutable) fail(`Cannot assign to unknown, input, uniform or const variable ${name}`);
      if (!['=', '+=', '-=', '*=', '/=', '%='].includes(operator)) fail('Only whole-local assignments are supported');
      let value = expression();
      if (operator !== '=') value = node({ isOperator: true, type: operator[0], left: node({ isAccessor: true, property: name }, entry.type), right: value }, compatible(entry.type, value.valueType));
      if (value.valueType !== entry.type) fail(`Assignment to ${name} expects ${entry.type}, not ${value.valueType}`);
      take(';'); body.push({ isAssignment: true, name, value });
    }
  }
  take('}');
  if (peek()) fail('Define exactly one effect function; extra GLSL declarations are unsupported');
  if (!returned) fail('effect must end with a vec4 return statement');
  return { body };
}
