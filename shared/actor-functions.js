/**
 * Runs the little functions a mod attaches to its own state frames.
 *
 * A decoration that turns writes it in its own class rather than calling an engine action:
 *
 * ```zscript
 * States { Spawn: PLAY A 1 Rotate; Loop; }
 * void Rotate() { angle += 1; }
 * ```
 *
 * GZDoom calls `Rotate` every tic the frame lasts. This module executes the subset of that
 * code an imported actor can need — declarations and compound assignments of numbers to the
 * actor's own fields, arithmetic and comparisons, `if`/`else`, and calls to the engine
 * actions the frame itself could have called — and reports anything else as unsupported
 * instead of guessing, so the import report still tells the truth about what the engine runs.
 */

/** Fields a mod may write from a state function, and how they are stored on an entity. */
const FIELDS = {
  angle: entity => entity.angle,
  pitch: entity => entity.pitch,
  roll: entity => entity.roll,
  alpha: entity => entity.alpha,
  scale: entity => entity.scale,
  health: entity => entity.health,
  // `z` is where the actor's bottom is; the entity keeps it as `z` once physics has run, and
  // as `elevation` above the floor before that.
  z: entity => Number.isFinite(entity.z) ? entity.z : entity.elevation,
};

const OPERATORS = { '=': 'set', '+=': 'add', '-=': 'subtract', '*=': 'multiply', '/=': 'divide', '%=': 'modulo' };

/** Splits a body into statements, honouring braces so `if (x) { a; b; }` stays one. */
function statements(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === ';' && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  const tail = text.slice(start);
  if (tail.trim()) parts.push(tail);
  return parts.map(part => part.trim()).filter(Boolean);
}

/** The end of the first statement in `text`: a whole block, or up to and including the `;`. */
function statementEnd(text) {
  if (text.startsWith('{')) {
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === '{') depth++;
      else if (text[index] === '}' && --depth === 0) return index + 1;
    }
    return text.length;
  }
  const at = text.indexOf(';');
  return at === -1 ? text.length : at + 1;
}

/** `{ a; } else { b; }` → the branch each way, so an `else` is not left inside the then-body. */
function branches(text) {
  const end = statementEnd(text);
  const then = text.slice(0, end).trim();
  const rest = text.slice(end).trim();
  const otherwise = /^else\b\s*([\s\S]*)$/.exec(rest);
  return { then, otherwise: otherwise ? otherwise[1].trim() : null };
}

/** A tiny recursive-descent parser for the expressions a state function uses. */
function parseExpression(source) {
  const text = String(source);
  let at = 0;
  const ws = () => { while (at < text.length && /\s/.test(text[at])) at++; };
  const eat = value => { ws(); if (!text.startsWith(value, at)) return false; at += value.length; return true; };
  const primary = () => {
    ws();
    if (eat('(')) { const inner = comparison(); if (!eat(')')) throw new Error('unbalanced'); return inner; }
    const number = /^-?\d+(?:\.\d+)?/.exec(text.slice(at));
    if (number) { at += number[0].length; return { kind: 'number', value: Number(number[0]) }; }
    const name = /^(?:self\.)?([A-Za-z_]\w*)/.exec(text.slice(at));
    if (!name) throw new Error(`unexpected ${text.slice(at, at + 12)}`);
    at += name[0].length;
    return { kind: 'name', name: name[1] };
  };
  const unary = () => {
    ws();
    if (eat('-') && !/\d/.test(text[at])) return { kind: 'negate', of: unary() };
    if (text[at - 1] === '-' && /\d/.test(text[at])) { const value = primary(); return { kind: 'negate', of: value }; }
    if (eat('!')) return { kind: 'not', of: unary() };
    return primary();
  };
  const term = () => {
    let left = unary();
    for (;;) {
      ws();
      const op = /^[*/%]/.exec(text.slice(at));
      if (!op) return left;
      at += 1; left = { kind: 'binary', op: op[0], left, right: unary() };
    }
  };
  const sum = () => {
    let left = term();
    for (;;) {
      ws();
      const op = /^[+-]/.exec(text.slice(at));
      if (!op) return left;
      at += 1; left = { kind: 'binary', op: op[0], left, right: term() };
    }
  };
  const comparison = () => {
    let left = sum();
    for (;;) {
      ws();
      const op = /^(==|!=|<=|>=|<|>|&&|\|\|)/.exec(text.slice(at));
      if (!op) return left;
      at += op[0].length; left = { kind: 'binary', op: op[0], left, right: sum() };
    }
  };
  const tree = comparison();
  ws();
  if (at !== text.length) throw new Error(`trailing ${text.slice(at, at + 12)}`);
  return tree;
}

function evaluate(node, vars, entity) {
  switch (node.kind) {
    case 'number': return node.value;
    case 'name':
      if (Object.hasOwn(vars, node.name)) return vars[node.name];
      if (FIELDS[node.name]) return Number(FIELDS[node.name](entity)) || 0;
      throw new Error(`unknown name ${node.name}`);
    case 'negate': return -evaluate(node.of, vars, entity);
    case 'not': return evaluate(node.of, vars, entity) ? 0 : 1;
    case 'binary': {
      const left = evaluate(node.left, vars, entity);
      // `&&` and `||` short-circuit the way the language does.
      if (node.op === '&&') return left ? evaluate(node.right, vars, entity) : 0;
      if (node.op === '||') return left ? 1 : evaluate(node.right, vars, entity);
      const right = evaluate(node.right, vars, entity);
      switch (node.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return right === 0 ? 0 : left / right;
        case '%': return right === 0 ? 0 : left % right;
        case '==': return left === right ? 1 : 0;
        case '!=': return left === right ? 0 : 1;
        case '<': return left < right ? 1 : 0;
        case '>': return left > right ? 1 : 0;
        case '<=': return left <= right ? 1 : 0;
        case '>=': return left >= right ? 1 : 0;
        default: throw new Error(`unknown operator ${node.op}`);
      }
    }
    default: throw new Error(`unknown node ${node.kind}`);
  }
}

function writeField(entity, name, value) {
  if (name === 'angle') entity.angle = ((value % 360) + 360) % 360;
  else if (name === 'z') {
    if (Number.isFinite(entity.z)) {
      entity.elevation = (Number(entity.elevation) || 0) + value - entity.z;
      entity.z = value;
    } else entity.elevation = value;
  } else entity[name] = value;
}

function combine(operator, current, value) {
  switch (operator) {
    case 'set': return value;
    case 'add': return current + value;
    case 'subtract': return current - value;
    case 'multiply': return current * value;
    case 'divide': return value === 0 ? current : current / value;
    case 'modulo': return value === 0 ? current : current % value;
    default: return value;
  }
}

/** Arguments of a call, splitting on commas that are not inside quotes or brackets. */
function splitArgs(text) {
  const parts = [];
  let depth = 0, quote = false, start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') quote = !quote;
    else if (!quote && (char === '(' || char === '[')) depth++;
    else if (!quote && (char === ')' || char === ']')) depth--;
    else if (char === ',' && !quote && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

/**
 * Executes a function body against an entity.
 *
 * Returns `{ ran, unsupported }`: `ran` is false when any statement could not be executed,
 * and `unsupported` names the statement that stopped it. Nothing is applied unless the whole
 * body runs, so a function that cannot be followed changes nothing rather than half of it.
 *
 * `call(name, args)` runs an engine action from inside the body (`A_PlaySound("x")`), which
 * is how a mod's own function does something the engine already knows how to do.
 */
export function runActorFunction(entity, source, call = null) {
  const body = String(source || '');
  if (!body.trim()) return { ran: false, unsupported: null };
  const vars = {};
  let applied = 0;

  const exec = statement => {
    const text = statement.trim();
    if (!text) return true;
    // A block: `{ a; b; }`.
    if (text.startsWith('{')) {
      const inner = text.slice(1, text.endsWith('}') ? -1 : undefined);
      for (const part of statements(inner)) if (!exec(part)) return false;
      return true;
    }
    const conditional = /^if\s*\(([\s\S]*?)\)\s*([\s\S]*)$/.exec(text);
    if (conditional) {
      let test;
      try { test = evaluate(parseExpression(conditional[1]), vars, entity); }
      catch { return false; }
      const { then, otherwise } = branches(conditional[2]);
      const chosen = test ? then : otherwise;
      return chosen === null ? true : exec(chosen);
    }
    if (/^return\b/.test(text)) return true;
    const assignment = /^(?:(?:self|owner)\.)?\s*(?:(int|float|double|bool|let|var)\s+)?([A-Za-z_]\w*)\s*(\+=|-=|\*=|\/=|%=|=)\s*([\s\S]+)$/.exec(text);
    if (assignment) {
      const [, declaration, name, token, raw] = assignment;
      let value;
      try { value = evaluate(parseExpression(raw), vars, entity); }
      catch { return false; }
      // A declared name is the function's own (and shadows a field of the same name);
      // otherwise a known actor field is the actor's.
      if (!declaration && FIELDS[name] && !Object.hasOwn(vars, name)) {
        writeField(entity, name, combine(OPERATORS[token], Number(FIELDS[name](entity)) || 0, value));
      } else {
        vars[name] = combine(OPERATORS[token], vars[name] ?? 0, value);
      }
      applied++;
      return true;
    }
    const called = /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/.exec(text);
    if (called && /^(A_|ACS_)/.test(called[1])) {
      if (!call) return false;
      const args = called[2].trim() ? splitArgs(called[2]).map(arg => {
        const string = /^"([\s\S]*)"$/.exec(arg.trim());
        if (string) return string[1];
        const text = arg.trim();
        if (text === 'true') return true;
        if (text === 'false') return false;
        return evaluate(parseExpression(text), vars, entity);
      }) : [];
      try { call(called[1], args); } catch { return false; }
      applied++;
      return true;
    }
    return false;
  };

  for (const statement of statements(body)) {
    if (!exec(statement)) return { ran: false, unsupported: statement.slice(0, 120) };
  }
  return { ran: applied > 0, unsupported: null };
}

/** The source of one of the actor's own functions, or null when it has none by that name. */
export function actorFunctionSource(actor, name) {
  const list = actor?.functions;
  if (!list) return null;
  if (Array.isArray(list)) {
    const found = list.find(entry => String(entry.name).toLowerCase() === String(name).toLowerCase());
    return found?.source ?? null;
  }
  const key = Object.keys(list).find(candidate => candidate.toLowerCase() === String(name).toLowerCase());
  return key === undefined ? null : list[key]?.source ?? list[key] ?? null;
}
