const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export const EXPRESSION_HELP = 'Use = before an expression in event fields. References: global("score"), local("speed"), object("id","name"), property("$self","x"), player("health"), time, dt, pi. Math: abs, min, max, clamp, lerp, floor, ceil, round, sqrt, pow, sin, cos, tan, atan2, distance, random. Text: str, number, concat, upper, lower, trim, len, left, right, mid, replace, contains, find. Operators: + - * / % ^ & == != < <= > >= && || ! and condition ? yes : no. Trigonometry uses radians; text indexes start at zero.';
export const isExpression = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.expr === 'string';

export function scalar(value) {
  if (!(typeof value === 'boolean' || typeof value === 'string' && value.length <= 4096 ||
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12)) throw new Error('Variable/expression values must be finite numbers within +/-1e12, text up to 4096 characters, or booleans');
  return value;
}
export function validateVariables(variables) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables) || Object.keys(variables).length > 100) throw new Error('Variables must be a record with at most 100 entries');
  for (const [name, value] of Object.entries(variables)) {
    if (forbidden.has(name)) throw new Error(`Reserved variable name: ${name}`);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new Error(`Invalid variable name: ${name}`);
    scalar(value);
  }
}

const precedence = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '&': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 8 };
const cache = new Map();
export function parseExpression(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 2048) throw new Error('Expression must contain 1-2048 characters');
  if (cache.has(source)) return cache.get(source);
  let cursor = 0, token, nodes = 0, depth = 0;
  const next = () => {
    while (/\s/.test(source[cursor] || '') && cursor < source.length) cursor++;
    if (cursor >= source.length) return token = { value: '', type: 'end' };
    const rest = source.slice(cursor);
    if (rest[0] === '"') {
      const match = /^"(?:[^"\\\n\r]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/.exec(rest);
      if (!match) throw new Error(`Invalid quoted text at ${cursor}`);
      cursor += match[0].length;
      return token = { type: 'literal', value: JSON.parse(match[0]) };
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { cursor += number[0].length; return token = { type: 'literal', value: scalar(Number(number[0])) }; }
    const name = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(rest);
    if (name) { cursor += name[0].length; return token = { type: 'name', value: name[0] }; }
    const op = /^(==|!=|<=|>=|&&|\|\||[+\-*/%^&!<>()?:,])/.exec(rest);
    if (!op) throw new Error(`Unexpected expression character at ${cursor}`);
    cursor += op[0].length; return token = { type: 'op', value: op[0] };
  };
  const take = value => { if (token.type !== 'op' || token.value !== value) throw new Error(`Expected "${value}" in expression`); next(); };
  function expression(min = 0) {
    if (++depth > 32 || ++nodes > 256) throw new Error('Expression exceeds nesting/operation limit');
    let left;
    if (token.type === 'op' && ['-', '+', '!'].includes(token.value)) { const op = token.value; next(); left = { op: 'unary', operator: op, value: expression(9) }; }
    else if (token.type === 'op' && token.value === '(') { next(); left = expression(); take(')'); }
    else if (token.type === 'literal') { left = { op: 'literal', value: token.value }; next(); }
    else if (token.type === 'name') {
      const name = token.value; next();
      if (token.type === 'op' && token.value === '(') {
        next(); const args = [];
        if (token.type !== 'op' || token.value !== ')') do { args.push(expression()); if (token.type !== 'op' || token.value !== ',') break; next(); } while (true);
        take(')'); left = { op: 'call', name, args };
      } else left = { op: 'symbol', name };
    } else throw new Error('Expected expression value');
    while (token.type === 'op' && precedence[token.value] >= Math.max(1, min)) {
      const op = token.value, rank = precedence[op]; next();
      left = { op: 'binary', operator: op, left, right: expression(rank + (op === '^' ? 0 : 1)) };
    }
    if (!min && token.type === 'op' && token.value === '?') { next(); const yes = expression(); take(':'); left = { op: 'if', condition: left, yes, no: expression() }; }
    depth--; return left;
  }
  next(); const tree = expression();
  if (token.type !== 'end') throw new Error('Unexpected trailing expression input');
  if (cache.size >= 512) cache.delete(cache.keys().next().value);
  cache.set(source, tree); return tree;
}

const numeric = value => { if (typeof value !== 'number') throw new Error('Expression requires a number'); return value; };
const text = value => { if (typeof value !== 'string') throw new Error('Expression requires text'); return value; };
const boolean = value => { if (typeof value !== 'boolean') throw new Error('Expression requires a boolean'); return value; };
const functions = {
  abs: [1, 1, Math.abs], floor: [1, 1, Math.floor], ceil: [1, 1, Math.ceil], round: [1, 1, Math.round],
  sqrt: [1, 1, Math.sqrt], sin: [1, 1, Math.sin], cos: [1, 1, Math.cos], tan: [1, 1, Math.tan],
  asin: [1, 1, Math.asin], acos: [1, 1, Math.acos], atan: [1, 1, Math.atan],
  sign: [1, 1, Math.sign], log: [1, 1, Math.log], exp: [1, 1, Math.exp],
  radians: [1, 1, value => value * Math.PI / 180], degrees: [1, 1, value => value * 180 / Math.PI],
  atan2: [2, 2, Math.atan2], pow: [2, 2, Math.pow], min: [1, 32, Math.min], max: [1, 32, Math.max],
  distance: [4, 4, (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1)],
  clamp: [3, 3, (v, lo, hi) => { if (lo > hi) throw new Error('clamp minimum exceeds maximum'); return Math.min(hi, Math.max(lo, v)); }],
  lerp: [3, 3, (a, b, t) => a + (b - a) * t],
};
const textFunctions = {
  upper: [1, 1, s => text(s).toUpperCase()], lower: [1, 1, s => text(s).toLowerCase()], trim: [1, 1, s => text(s).trim()],
  str: [1, 1, value => String(value)], number: [1, 1, value => { if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) throw new Error('number needs numeric text or a number'); return Number(value); }],
  concat: [1, 32, (...values) => values.map(String).join('')], len: [1, 1, s => text(s).length],
  left: [2, 2, (s, n) => text(s).slice(0, Math.max(0, numeric(n)))],
  right: [2, 2, (s, n) => numeric(n) <= 0 ? '' : text(s).slice(-n)],
  mid: [2, 3, (s, start, count) => text(s).slice(Math.max(0, numeric(start)), count === undefined ? undefined : Math.max(0, start) + Math.max(0, numeric(count)))],
  replace: [3, 3, (s, from, to) => text(s).replaceAll(text(from), text(to))],
  contains: [2, 2, (s, needle) => text(s).includes(text(needle))],
  find: [2, 2, (s, needle) => text(s).indexOf(text(needle))],
};
const references = { global: 1, local: 1, object: 2, property: 2, player: 1 };
const properties = new Set(['x', 'y', 'z', 'angle', 'health', 'elevation', 'name', 'type', 'doomType']);
const playerStats = new Set(['health', 'armor', 'armorDivisor', 'bullets', 'shells', 'rockets', 'cells',
  'maxBullets', 'maxShells', 'maxRockets', 'maxCells', 'invulnerable', 'berserk', 'invisible', 'radiationSuit', 'lightAmp']);
export function expressionContext(project, event, state, dt = 0) {
  const entities = state?.entities || project.map.entities;
  function targets(id) {
    const matches = id === '$self'
      ? event.ownerId ? entities.filter(e => e.id === event.ownerId) : entities.filter(e => e.type === event.forEachType)
      : entities.filter(e => e.id === id);
    if (!matches.length && (state || id !== '$self' || !event.forEachType)) throw new Error(`Expression references unknown object/context: ${id}`);
    return matches;
  }
  function variable(record, name) {
    if (forbidden.has(name) || !Object.hasOwn(record, name)) throw new Error(`Expression references unknown variable: ${name}`);
    return record[name];
  }
  return {
    time: state?.time ?? 0, dt,
    random: () => {
      if (!state) return .5;
      state.randomSeed = (Math.imul(state.randomSeed, 1664525) + 1013904223) >>> 0;
      return state.randomSeed / 4294967296;
    },
    reference(kind, args) {
      if (kind === 'global') return variable(state?.variables || project.variables, args[0]);
      if (kind === 'player') {
        if (!playerStats.has(args[0])) throw new Error(`Unknown player expression stat: ${args[0]}`);
        return state ? state.playerStats[args[0]] : 0;
      }
      const list = targets(kind === 'local' ? '$self' : args[0]), name = kind === 'local' ? args[0] : args[1];
      if (kind === 'property') {
        if (!properties.has(name)) throw new Error(`Unknown object expression property: ${name}`);
        if (!list.length) return name === 'name' || name === 'type' ? '' : 0;
        if (state && list[0].type === 'player' && ['x', 'y', 'z', 'angle'].includes(name)) return name === 'angle' ? state.player.angle * 180 / Math.PI : state.player[name] ?? 0;
        return list[0][name] ?? (name === 'name' || name === 'type' ? '' : 0);
      }
      const values = list.map(entity => variable(entity.variables || {}, name));
      if (!values.length) return 0;
      if (values.some(v => typeof v !== typeof values[0])) throw new Error(`Object variable types differ between instances: ${name}`);
      return values[0];
    },
  };
}
function checkCall(node) {
  if (forbidden.has(node.name) || !Object.hasOwn(functions, node.name) && !Object.hasOwn(textFunctions, node.name) &&
    !Object.hasOwn(references, node.name) && node.name !== 'random') throw new Error(`Unknown expression function: ${node.name}`);
  const definition = functions[node.name] || textFunctions[node.name];
  const count = references[node.name];
  const min = count || (node.name === 'random' ? 2 : definition?.[0]);
  const max = count || (node.name === 'random' ? 2 : definition?.[1]);
  if (min === undefined || node.args.length < min || node.args.length > max) throw new Error(`Unknown function or invalid argument count: ${node.name}`);
  if (count && node.args.some(arg => arg.op !== 'literal' || typeof arg.value !== 'string')) throw new Error(`${node.name} references require literal quoted names`);
}
export function validateExpression(value, context) {
  if (!isExpression(value)) throw new Error('Expression must be {expr: "expression text"}');
  const tree = parseExpression(value.expr);
  function visit(node) {
    if (node.op === 'literal') return;
    if (node.op === 'symbol') {
      if (!['time', 'dt', 'pi', 'e', 'true', 'false'].includes(node.name)) throw new Error(`Unknown expression symbol: ${node.name}`);
    } else if (node.op === 'call') {
      checkCall(node); node.args.forEach(visit);
      if (references[node.name]) context.reference(node.name, node.args.map(arg => arg.value));
    } else if (node.op === 'unary') visit(node.value);
    else if (node.op === 'binary') { visit(node.left); visit(node.right); }
    else { visit(node.condition); visit(node.yes); visit(node.no); }
  }
  visit(tree);
}
export function evaluateExpression(value, context) {
  const evaluate = node => {
    let result;
    if (node.op === 'literal') result = node.value;
    else if (node.op === 'symbol') {
      if (!Object.hasOwn({ time: 0, dt: 0, pi: 0, e: 0, true: 0, false: 0 }, node.name)) throw new Error(`Unknown expression symbol: ${node.name}`);
      result = { time: context.time, dt: context.dt, pi: Math.PI, e: Math.E, true: true, false: false }[node.name];
    } else if (node.op === 'call') {
      checkCall(node);
      const args = node.args.map(evaluate);
      if (references[node.name]) result = context.reference(node.name, args);
      else if (node.name === 'random') {
        const [min, max] = args.map(numeric); if (min > max) throw new Error('random minimum exceeds maximum');
        result = min + context.random() * (max - min);
      } else {
        const definition = functions[node.name] || textFunctions[node.name];
        result = definition[2](...(functions[node.name] ? args.map(numeric) : args));
      }
    } else if (node.op === 'unary') {
      const v = evaluate(node.value);
      result = node.operator === '!' ? !boolean(v) : node.operator === '-' ? -numeric(v) : numeric(v);
    } else if (node.op === 'if') result = evaluate(boolean(evaluate(node.condition)) ? node.yes : node.no);
    else {
      const a = evaluate(node.left), op = node.operator;
      if (op === '&&') result = boolean(a) && boolean(evaluate(node.right));
      else if (op === '||') result = boolean(a) || boolean(evaluate(node.right));
      else {
        const b = evaluate(node.right);
        if (op === '&') result = String(a) + String(b);
        else if (op === '==' || op === '!=') result = op === '==' ? a === b : a !== b;
        else if (['<', '<=', '>', '>='].includes(op)) {
          if (typeof a !== typeof b || !['number', 'string'].includes(typeof a)) throw new Error('Comparison requires matching numbers or text');
          result = op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
        } else {
          numeric(a); numeric(b);
          if (['/', '%'].includes(op) && b === 0) throw new Error('Expression division by zero');
          result = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : op === '%' ? a % b : a ** b;
        }
      }
    }
    return scalar(result);
  };
  return evaluate(parseExpression(value.expr));
}
