import { GAME_SETTINGS } from './game-settings.js';
import { INSTANCE_PICKABLE_TYPES, INSTANCE_PROPERTY_NAMES, readInstanceProperty } from './instance-properties.js';
import { PLAYER_STATS } from './player-state.js';
import { readAcsVariable, readAcsString, readAcsArray } from './acs-state.js';
import { arrayShape, readArrayCell } from './arrays.js';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
/** The actor values `acsactor(tid, "…")` can read: the ones the ACS opcodes read. */
export const ACTOR_VALUE_KINDS = ['x', 'y', 'z', 'floorZ', 'ceilingZ', 'angle', 'pitch', 'light'];

export const EXPRESSION_HELP = 'Use = before an expression in event fields. References: global("score"), local("speed"), object("id","name"), property("$self","x"), property("enemy","health"), count("enemy"), player("health"), acsvar("map", 2), acsarray("script", 1, 0), array("grid", 2, 1), arrayrows("grid"), arraycolumns("grid"), acsflat("map", 3), acsactor(3, "z"), acsactorproperty(3, 0), acssectorz(7, 0, 0, "floor"), time, dt, pi. Math: abs, min, max, clamp, lerp, floor, ceil, round, sqrt, pow, sin, cos, tan, atan2, distance, random. Text: str, number, concat, upper, lower, trim, len, left, right, mid, replace, contains, find. Operators: + - * / % ^ & == != < <= > >= && || ! and condition ? yes : no. Trigonometry uses radians; text indexes start at zero.';
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
      const start = cursor;
      cursor += match[0].length;
      return token = { type: 'literal', value: JSON.parse(match[0]), start, end: cursor };
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
    if (token.type === 'op' && ['-', '+', '!'].includes(token.value)) { const op = token.value; next(); left = { op: 'unary', operator: op, value: expression(op === '!' ? 9 : 8) }; }
    else if (token.type === 'op' && token.value === '(') { next(); left = expression(); take(')'); }
    else if (token.type === 'literal') { left = { op: 'literal', value: token.value, start: token.start, end: token.end }; next(); }
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
  str: [1, 1, value => String(value)],
  number: [1, 1, value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) throw new Error('number needs numeric text or a number');
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error('number needs numeric text or a number');
    return result;
  }],
  concat: [1, 32, (...values) => values.map(String).join('')], len: [1, 1, s => text(s).length],
  left: [2, 2, (s, n) => text(s).slice(0, Math.max(0, numeric(n)))],
  right: [2, 2, (s, n) => {
    const source = text(s), count = Math.max(0, Math.trunc(numeric(n)));
    return count ? source.slice(-count) : '';
  }],
  mid: [2, 3, (s, start, count) => {
    const source = text(s), offset = Math.max(0, Math.trunc(numeric(start)));
    return source.slice(offset, count === undefined ? undefined : offset + Math.max(0, Math.trunc(numeric(count))));
  }],
  replace: [3, 3, (s, from, to) => {
    const replacement = text(to);
    return text(s).replaceAll(text(from), () => replacement);
  }],
  contains: [2, 2, (s, needle) => text(s).includes(text(needle))],
  find: [2, 2, (s, needle) => text(s).indexOf(text(needle))],
};
// `acsvar("map", 2)` reads a compiled script's variable: the level's own store, not a copy.
const references = { global: 1, local: 1, object: 2, property: 2, player: 1, setting: 1, count: 1, acsvar: 2, acsflat: 2, acsarray: 3,
  // A project array: named like a variable, indexed by row and column. `arrayrows`/`arraycolumns`
  // give its size, so a loop over a grid can ask instead of hard-coding the numbers.
  array: 3, arrayrows: 1, arraycolumns: 1 };
/**
 * Reads that ask the running level a question, the way a compiled script's `GetActorZ`,
 * `GetActorProperty` and `GetSectorFloorZ` do. Their name argument is a literal (a property,
 * a surface), everything before it is a value the rule computes.
 */
const hostedReads = { acsactor: 2, acsactorproperty: 2, acssectorz: 4 };
/**
 * The properties an expression can read.
 *
 * `shared/instance-properties.js` owns the list, so a property added for the picking conditions is
 * readable here in the same commit — a comparison, a variable assignment and a pick all answer
 * the same question the same way.
 */
const properties = new Set(INSTANCE_PROPERTY_NAMES);
// The stats a `player("stat")` expression may name are exactly the ones the runtime state carries;
// deriving from `player-state.js` keeps a stat from validating here and then being undefined in play.
const playerStats = new Set(PLAYER_STATS);
export function expressionContext(project, event, state, dt = 0, { selection } = {}) {
  const entities = () => state?.entities || project.map.entities;
  function targets(id, picks = state?.picks) {
    if (id === '$self') {
      const matches = event.ownerId ? entities().filter(e => e.id === event.ownerId) : entities().filter(e => e.type === event.forEachType);
      if (!matches.length && (state || !event.forEachType)) throw new Error(`Expression references unknown object/context: ${id}`);
      return matches;
    }
    const byId = entities().filter(e => e.id === id);
    if (byId.length) return byId;
    if (state && project.map.entities.some(entity => entity.id === id)) return [];
    // An expression may also name the object *type*, and then it reads whatever the rule picked,
    // which is how `Enemy.X()` behaves in GDevelop. A type with nothing left answers zero rather
    // than failing, so only a name that is neither an instance nor a known type is refused.
    if (INSTANCE_PICKABLE_TYPES.includes(id)) {
      const picked = picks?.get(id);
      return entities().filter(e => e.type === id && (!picked || picked.has(e.id)));
    }
    throw new Error(`Expression references unknown object/context: ${id}`);
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
      if (kind === 'setting') {
        if (!Object.hasOwn(GAME_SETTINGS, args[0])) throw new Error(`Unknown setting expression: ${args[0]}`);
        return state ? state.settings[args[0]] : GAME_SETTINGS[args[0]].value;
      }
      if (hostedReads[kind]) {
        const host = state?.scripts?.host;
        if (!host) return 0;
        const name = String(args[args.length - 1]);
        const numbers = args.slice(0, -1).map(value => Number(value) || 0);
        if (kind === 'acsactor') return host.getActor(numbers[0], name, 'player') | 0;
        if (kind === 'acsactorproperty') return host.getActorProperty(numbers[0], numbers[1], 'player') | 0;
        return host.getSectorZ(numbers[0], numbers[1], numbers[2], name === 'ceiling') | 0;
      }
      if (kind === 'acsvar') return readAcsVariable(state, args[0], Number(args[1]) || 0);
      if (kind === 'acsflat') return readAcsString(state, args[0], Number(args[1]) || 0);
      if (kind === 'acsarray') return readAcsArray(state, args[0], Number(args[1]) || 0, Number(args[2]) || 0);
      // The live arrays when a game is running, the authored grid otherwise: the designer's preview
      // reads real values before Play has started.
      if (kind === 'array') return readArrayCell(state?.arrays ?? project.arrays, args[0],
        Number(args[1]) || 0, Number(args[2]) || 0);
      if (kind === 'arrayrows' || kind === 'arraycolumns') {
        const shape = arrayShape(state?.arrays ?? project.arrays, args[0]);
        return kind === 'arrayrows' ? shape.rows : shape.columns;
      }
      if (kind === 'global') return variable(state?.variables || project.variables, args[0]);
      if (kind === 'player') {
        if (!playerStats.has(args[0])) throw new Error(`Unknown player expression stat: ${args[0]}`);
        return state ? state.playerStats[args[0]] : 0;
      }
      if (kind === 'count') return targets(args[0], selection ?? state?.picks).length;
      const list = targets(kind === 'local' ? '$self' : args[0]), name = kind === 'local' ? args[0] : args[1];
      if (kind === 'property') {
        if (!properties.has(name)) throw new Error(`Unknown object expression property: ${name}`);
        // The first matching instance answers: this is how GDevelop's `Enemy.X()` behaves when
        // several are picked, and a rule that needs a specific one picks it first.
        return readInstanceProperty(project, state, list[0] ?? null, name);
      }
      const values = list.map(entity => variable(entity.variables || {}, name));
      if (!values.length) {
        const authored = targetsForValidation(kind === 'local' ? '$self' : args[0]);
        const initial = authored.map(entity => variable(entity.variables || {}, name));
        if (!initial.length) throw new Error(`Expression references unknown variable: ${name}`);
        return typeof initial[0] === 'string' ? '' : typeof initial[0] === 'boolean' ? false : 0;
      }
      if (values.some(v => typeof v !== typeof values[0])) throw new Error(`Object variable types differ between instances: ${name}`);
      return values[0];
    },
  };
  function targetsForValidation(id) {
    if (id === '$self') return project.map.entities.filter(entity => event.ownerId ? entity.id === event.ownerId : entity.type === event.forEachType);
    const byId = project.map.entities.filter(entity => entity.id === id);
    return byId.length ? byId : project.map.entities.filter(entity => entity.type === id);
  }
}
function checkCall(node) {
  if (forbidden.has(node.name) || !Object.hasOwn(functions, node.name) && !Object.hasOwn(textFunctions, node.name) &&
    !Object.hasOwn(references, node.name) && !Object.hasOwn(hostedReads, node.name) &&
    node.name !== 'random') throw new Error(`Unknown expression function: ${node.name}`);
  const definition = functions[node.name] || textFunctions[node.name];
  const count = references[node.name] || hostedReads[node.name];
  const min = count || (node.name === 'random' ? 2 : definition?.[0]);
  const max = count || (node.name === 'random' ? 2 : definition?.[1]);
  if (min === undefined || node.args.length < min || node.args.length > max) throw new Error(`Unknown function or invalid argument count: ${node.name}`);
  if (hostedReads[node.name]) {
    const name = node.args[node.args.length - 1];
    if (name?.op !== 'literal' || typeof name.value !== 'string')
      throw new Error(`${node.name} needs a literal name as its last argument`);
    if (node.name === 'acsactor' && !ACTOR_VALUE_KINDS.includes(name.value))
      throw new Error(`acsactor names one of: ${ACTOR_VALUE_KINDS.join(', ')}`);
    if (node.name === 'acssectorz' && !['floor', 'ceiling'].includes(name.value))
      throw new Error('acssectorz names "floor" or "ceiling"');
    return;
  }
  if (node.name === 'acsvar' || node.name === 'acsflat') {
    const [scope, index] = node.args;
    if (scope?.op !== 'literal' || !['map', 'world', 'global'].includes(scope.value))
      throw new Error(`${node.name} requires a scope: "map", "world" or "global"`);
    if (index?.op !== 'literal' || typeof index.value !== 'number')
      throw new Error(`${node.name} requires a literal variable index`);
    return;
  }
  if (node.name === 'acsarray') {
    const [scope, id, index] = node.args;
    if (scope?.op !== 'literal' || !['script', 'map', 'world', 'global'].includes(scope.value))
      throw new Error('acsarray requires a scope: "script", "map", "world" or "global"');
    if (id?.op !== 'literal' || typeof id.value !== 'number')
      throw new Error('acsarray requires a literal array number');
    if (!index) throw new Error('acsarray requires an element index');
    return;
  }
  // An array is named literally, but its row and column may be computed: walking a grid with a
  // counter is the point of having one, so only the name is required to be a literal.
  if (node.name === 'array') {
    if (node.args[0]?.op !== 'literal' || typeof node.args[0].value !== 'string')
      throw new Error('array needs a literal quoted array name');
    return;
  }
  if (count && node.args.some(arg => arg.op !== 'literal' || typeof arg.value !== 'string')) throw new Error(`${node.name} references require literal quoted names`);
}

export function expressionObjectReferences(value) {
  const found = [];
  function visit(node) {
    if (node.op === 'call') {
      if (['object', 'property', 'count'].includes(node.name)) {
        checkCall(node);
        const { value: id, start, end } = node.args[0];
        found.push({ id, start, end });
      }
      node.args.forEach(visit);
    } else if (node.op === 'unary') visit(node.value);
    else if (node.op === 'binary') { visit(node.left); visit(node.right); }
    else if (node.op === 'if') { visit(node.condition); visit(node.yes); visit(node.no); }
  }
  visit(parseExpression(value.expr));
  return found;
}

export function rewriteExpressionObjects(value, mapping) {
  let source = value.expr;
  for (const { id, start, end } of expressionObjectReferences(value).reverse()) {
    if (!mapping.has(id)) continue;
    source = source.slice(0, start) + JSON.stringify(mapping.get(id)) + source.slice(end);
  }
  return source === value.expr ? value : { expr: source };
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
      if (references[node.name] || hostedReads[node.name]) result = context.reference(node.name, args);
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
