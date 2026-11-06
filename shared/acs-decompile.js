/**
 * ACS bytecode, read back as the actions a rule can take.
 *
 * The interpreter executes a level's compiled scripts because that is what the WAD ships,
 * but a rule sheet cannot show bytecode. This walks the same instructions and writes the
 * ones it understands as catalogue actions, so a script's decisions appear in the sheet:
 *
 * ```
 * PUSH3BYTES 49, 32, 64          ->  runLineSpecial { special: 20, arg1: 49, arg2: 32, arg3: 64 }
 * LSPEC3 20
 * ```
 *
 * It is deliberately all-or-nothing: a body is translated only when **every** instruction
 * is understood. Anything else — a loop, an array, stack juggling — returns null and the
 * script keeps its `runScript` rule, because a rule that runs half a script is worse than
 * one that runs none of it. Coverage therefore grows by teaching this module one construct
 * at a time, and the import report can say how many scripts are still bytecode.
 *
 * A script comes back as **segments** split at its waits, each a list of **steps**: the
 * straight-line actions, then one step per guarded block. A step's conditions are the
 * `IFNOTGOTO` test that led to it, so `map13 += 1; if (map13 >= 2) open` reads as "add one,
 * then — if the counter reached two — open the door", which is a rule with a sub-event.
 */

import { instructionAt, lookupString } from './acs.js';

const PUSHES = {
  PUSHBYTE: 1, PUSHNUMBER: 1, PUSH2BYTES: 2, PUSH3BYTES: 3, PUSH4BYTES: 4, PUSH5BYTES: 5,
};
const SPECIALS = /^LSPEC([1-5])(DIRECT|DIRECTB)?$/;
const VARIABLE = /^(PUSH|ASSIGN|ADD|SUB|MUL|DIV|MOD|INC|DEC)(SCRIPT|MAP|WORLD|GLOBAL)VAR$/;
const SCOPE = { SCRIPT: 'script', MAP: 'map', WORLD: 'world', GLOBAL: 'global' };
const COMPARISONS = { EQ: '=', NE: '!=', LT: '<', GT: '>', LE: '<=', GE: '>=' };
const FOLDS = { ADD: '+', SUBTRACT: '-', MULTIPLY: '*', DIVIDE: '/', MODULUS: '%' };
const MIRROR = { '=': '=', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };
const NEGATED = { '=': '!=', '!=': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
const ENDS = /^(TERMINATE|SUSPEND|RETURNVOID|RETURNVAL|END)$/;
const WAITS = /^(DELAY|DELAYDIRECT|TAGWAIT|TAGWAITDIRECT)$/;

/**
 * The actions one script performs, or null when its body uses anything this cannot read.
 *
 * `selector` is a script number or name, as everywhere else in the ACS layer.
 */
export function decompileScript(program, selector) {
  const script = findEntry(program, selector);
  if (!script) return null;
  const module = program.modules?.[script.moduleIndex ?? 0]?.module;
  if (!module) return null;
  const moduleIndex = script.moduleIndex ?? 0;
  const segments = [];
  const seen = new Set();
  let offset = script.address;
  // A script variable lives as long as the script does, not as long as one step of it: a
  // script that sets a pause length, waits, and uses it again keeps that value.
  const locals = new Map();

  /**
   * Reads instructions from `start` until the script ends or `limit` is reached.
   *
   * A guard inside a guard, or a wait inside a guard, is not translated: a step is one rule
   * with one set of conditions, and an inner wait would need a rule chain per branch.
   */
  const read = (start, limit, depth) => {
    const stack = [];
    const steps = [];
    let pending = { conditions: [], actions: [] };
    let offset = start;
    const flush = () => {
      if (pending.actions.length) steps.push(pending);
      pending = { conditions: [], actions: [] };
    };
    const pop = () => stack.pop();
    for (let guard = 0; guard < 8192; guard++) {
      if (limit !== null && limit !== undefined) {
        if (offset === limit) { flush(); return { steps, offset, wait: null, ended: false }; }
        if (offset > limit) return null;
      }
      if (offset === null || offset === undefined) return null;
      if (depth === 0) {
        if (seen.has(offset)) return null; // a loop
        seen.add(offset);
      }
      const instruction = instructionAt(module, offset);
      if (!instruction?.supported || !instruction.end) return null;
      const name = instruction.name;
      const operands = instruction.operands || [];
      const next = instruction.end;

      if (ENDS.test(name)) { flush(); return { steps, offset: next, wait: null, ended: true }; }

      // A wait splits the body: everything after it happens later.
      if (WAITS.test(name)) {
        if (depth > 0) return null;
        // `DELAY` and `TAGWAIT` take their number off the stack; anything else left on it is
        // a value the next step would have needed, which a step boundary cannot carry.
        const raw = name === 'DELAY' || name === 'TAGWAIT' ? pop() : null;
        const operand = raw ? (raw.kind === 'number' ? Number(raw.value) || 0 : NaN) : Number(operands[0]);
        if (stack.length) return null;
        let wait;
        if (name === 'DELAY' || name === 'DELAYDIRECT') {
          if (!Number.isFinite(operand)) return null;
          wait = { kind: 'delay', seconds: operand / 35 };
        } else if (Number.isFinite(operand)) {
          wait = { kind: 'tag', tag: operand };
        } else {
          // A tag may be a variable: the script waits on whatever tag it was handed.
          const text = raw ? expressionOf(raw) : null;
          if (text === null) return null;
          wait = { kind: 'tag', tag: { expr: text } };
        }
        flush();
        return { steps, offset: next, wait, ended: false };
      }

      if (name === 'IFNOTGOTO' || name === 'IFGOTO') {
        if (depth > 0) return null;
        const target = Number(operands[0]);
        // A backward jump is a loop; a forward one that is not a guard has no rule shape yet.
        if (!(target > next)) return null;
        // `IFNOTGOTO` runs its block when the value is true; `IFGOTO` skips the block then.
        const guarded = conditionsFor(pop(), name === 'IFGOTO');
        if (!guarded) return null;
        const inside = read(next, target, depth + 1);
        if (!inside || inside.wait) return null;
        flush();
        // At this depth `read` cannot nest, so the block is one group of plain actions.
        if (!guarded.dead) {
          const actions = inside.steps.flatMap(step => step.actions);
          if (actions.length) steps.push({ conditions: guarded.conditions, actions });
        }
        if (inside.ended) return { steps, offset: target, wait: null, ended: true };
        offset = target;
        continue;
      }
      if (name === 'GOTO' || name === 'GOTOSTACK' || name === 'CASEGOTO' || name === 'CASEGOTOSORTED') return null;

      if (name === 'PUSHSTRING') { stack.push({ kind: 'string', text: module.strings?.[operands[0]] ?? '' }); offset = next; continue; }
      if (name === 'PRINTSTRING') {
        const shown = pop();
        if (shown?.kind !== 'string') return null;
        pending.actions.push({ type: 'showMessage', message: String(shown.text).slice(0, 200), seconds: 4 });
        offset = next; continue;
      }
      // A dropped value changes nothing a rule could see.
      if (name === 'DROP') { pop(); offset = next; continue; }

      const variable = VARIABLE.exec(name);
      if (variable) {
        const [, operation, scopeName] = variable;
        const scope = SCOPE[scopeName];
        const index = Number(operands[0]);
        if (scope === 'script') {
          if (operation === 'PUSH') {
            if (!locals.has(index)) return null;
            stack.push(locals.get(index));
            offset = next; continue;
          }
          if (operation === 'ASSIGN') {
            // A script variable is a temporary here: it holds whatever the stack held, so a
            // random roll or a counter offset can be carried to the call that uses it.
            const assigned = pop();
            if (!assigned) return null;
            locals.set(index, assigned);
            offset = next; continue;
          }
          return null;
        }
        if (operation === 'PUSH') {
          stack.push({ kind: 'variable', scope, index, module: moduleIndex, add: 0 });
          offset = next; continue;
        }
        const store = (mode, amount) => pending.actions.push({ type: 'setAcsVariable', scope, index,
          module: moduleIndex, mode, value: amount });
        if (operation === 'ASSIGN') {
          const assigned = pop();
          if (assigned?.kind === 'number') { store('set', Number(assigned.value) || 0); offset = next; continue; }
          // `mapVar = mapVar + 1` is how some builds compile `mapVar++`.
          if (assigned?.kind === 'variable' && assigned.scope === scope && assigned.index === index) {
            if (assigned.add) store('add', assigned.add);
            offset = next; continue;
          }
          return null;
        }
        // `INC`/`DEC` carry no operand; the rest pop the amount they apply.
        const amount = /^(INC|DEC)$/.test(operation) ? { kind: 'number', value: 1 } : pop();
        if (amount?.kind !== 'number') return null;
        if (!['INC', 'DEC', 'ADD', 'SUB'].includes(operation)) return null;
        const delta = operation === 'DEC' ? -Number(amount.value) : Number(amount.value);
        if (delta) store('add', delta);
        offset = next; continue;
      }

      // Constant arithmetic is folded, so `35 * 1` becomes the delay it stands for.
      if (FOLDS[name]) {
        const folded = fold(FOLDS[name], pop(), pop());
        if (!folded) return null;
        stack.push(folded);
        offset = next; continue;
      }
      if (COMPARISONS[name]) {
        const right = pop();
        const compared = compare(pop(), COMPARISONS[name], right);
        if (!compared) return null;
        stack.push(compared);
        offset = next; continue;
      }
      if (name === 'ANDLOGICAL' || name === 'ORLOGICAL' || name === 'NEGATELOGICAL') {
        const right = name === 'NEGATELOGICAL' ? null : pop();
        const joined = logic(name, pop(), right);
        if (!joined) return null;
        stack.push(joined);
        offset = next; continue;
      }

      if (name === 'RANDOM' || name === 'RANDOMDIRECT') {
        // `Random(min, max)` is inclusive; the expression that replaces it floors a roll.
        const max = name === 'RANDOM' ? pop() : { kind: 'number', value: Number(operands[1]) || 0 };
        const min = name === 'RANDOM' ? pop() : { kind: 'number', value: Number(operands[0]) || 0 };
        const low = expressionOf(min), high = expressionOf(max);
        if (low === null || high === null) return null;
        stack.push({ kind: 'random', min: low, max: high });
        offset = next; continue;
      }

      // The builtins a script calls directly, as the actions that do the same thing.
      const builtin = BUILTINS[name];
      if (builtin) {
        // A `*DIRECT` opcode carries its arguments as operands; the stack form pops them.
        const values = builtin.operands
          ? operands.slice(0, builtin.count).map(value => ({ kind: 'number', value: Number(value) || 0 }))
          : stack.splice(Math.max(0, stack.length - builtin.count));
        if (values.length !== builtin.count) return null;
        const action = builtin.action(values, module);
        if (!action) return null;
        // `CheckInventory` leaves a count on the stack for the comparison that follows.
        if (builtin.result) stack.push(action);
        else pending.actions.push(action);
        offset = next; continue;
      }

      const pushed = PUSHES[name];
      if (pushed) {
        // A push of N bytes hands the caller N arguments, in the order they are written.
        for (const entry of operands.slice(0, pushed)) stack.push({ kind: 'number', value: Number(entry) || 0 });
        offset = next; continue;
      }
      const special = SPECIALS.exec(name);
      if (special) {
        const count = Number(special[1]);
        let args;
        if (special[2]) args = operands.slice(1, 1 + count);
        else {
          // The stack form pops its arguments, so the last pushed is the last argument.
          if (stack.length < count) return null;
          args = stack.splice(stack.length - count, count).map(argumentOf);
        }
        if (args.some(argument => argument === null)) return null;
        if (!args.length && count > 0) return null;
        pending.actions.push({ type: 'runLineSpecial', special: Number(operands[0]), arg1: args[0] ?? 0,
          arg2: args[1] ?? 0, arg3: args[2] ?? 0, arg4: args[3] ?? 0, arg5: args[4] ?? 0 });
        offset = next; continue;
      }
      // Anything else — loops, arrays, stack juggling, a call frame — is not translated.
      return null;
    }
    return null;
  };

  for (;;) {
    const segment = read(offset, null, 0);
    if (!segment) return null;
    const steps = segment.steps.filter(step => step.actions.length);
    if (steps.length || segment.wait) segments.push({ steps, wait: segment.wait });
    if (!segment.wait || segment.ended) break;
    offset = segment.offset;
  }
  const actions = segments.flatMap(segment => segment.steps.flatMap(step => step.actions));
  return { actions, segments, instructions: seen.size };
}

/**
 * An argument as the value a rule passes: a plain number, or `acsvar("map", 3)` for a level
 * variable, which the runtime reads from the same store the rest of the scripts use.
 */
function argumentOf(entry) {
  if (entry === undefined || entry === null) return 0;
  if (entry.kind === 'number') return Number(entry.value) || 0;
  const text = expressionOf(entry);
  return text === null ? null : { expr: text };
}

/** The expression text a stack entry reads as, or null when it is not something a rule can say. */
function expressionOf(entry) {
  if (entry?.kind === 'number') return String(Number(entry.value) || 0);
  if (entry?.kind === 'random') return `floor(random(${entry.min}, ${entry.max}))`;
  if (entry?.kind === 'variable' && entry.scope !== 'script') {
    const name = `acsvar("${entry.scope}", ${entry.index})`;
    const offset = entry.add || 0;
    return offset ? `(${name} + ${offset})` : name;
  }
  return null;
}

/**
 * The ACS builtins a script calls directly, and the action each one becomes. They take their
 * arguments from the stack, and a string argument is a string-table index, which the module
 * can resolve — `PUSHBYTE 1; CHANGEFLOOR` is `ChangeFloor(tag, "HEX01")`.
 */
/** Each builtin reads its arguments as stack entries: numbers, variables, or a string index. */
const BUILTINS = {
  CHANGEFLOOR: { count: 2, action: ([tag, flat], module) => flatAction('floor', tag, flat, module) },
  CHANGEFLOORDIRECT: { count: 2, action: ([tag, flat], module) => flatAction('floor', tag, flat, module) },
  CHANGECEILING: { count: 2, action: ([tag, flat], module) => flatAction('ceiling', tag, flat, module) },
  CHANGECEILINGDIRECT: { count: 2, action: ([tag, flat], module) => flatAction('ceiling', tag, flat, module) },
  SETLINETEXTURE: { count: 4, action: ([line, side, part, texture], module) => named({
    type: 'setLineTexture', line: argumentOf(line), side: argumentOf(side), part: argumentOf(part) },
  'texture', stringOf(texture, module)) },
  SETLINEBLOCKING: { count: 2, action: ([tag, mode]) => (mode?.kind !== 'number' ? null
    : { type: 'setLineBlocking', tag: argumentOf(tag), blocking: Number(mode.value) === 0 ? 'no' : 'yes' }) },
  SETLINEMONSTERBLOCKING: { count: 2, action: ([tag, on]) => (on?.kind !== 'number' ? null
    : { type: 'setLineMonsterBlocking', tag: argumentOf(tag), monsters: Number(on.value) === 0 ? 'no' : 'yes' }) },
  SETLINESPECIAL: { count: 7, action: ([tag, special, ...args]) => ({
    type: 'setLineSpecial', tag: argumentOf(tag), special: argumentOf(special),
    arg1: argumentOf(args[0]), arg2: argumentOf(args[1]), arg3: argumentOf(args[2]),
    arg4: argumentOf(args[3]), arg5: argumentOf(args[4]) }) },
  GIVEINVENTORY: { count: 2, action: ([name, amount], module) => withItem({ type: 'giveInventory' },
    name, module, { amount: argumentOf(amount) }) },
  GIVEINVENTORYDIRECT: { operands: true, count: 2, action: ([name, amount], module) => withItem({
    type: 'giveInventory' }, name, module, { amount: argumentOf(amount) }) },
  TAKEINVENTORY: { count: 2, action: ([name, amount], module) => withItem({ type: 'takeInventory' },
    name, module, { amount: argumentOf(amount) }) },
  TAKEINVENTORYDIRECT: { operands: true, count: 2, action: ([name, amount], module) => withItem({
    type: 'takeInventory' }, name, module, { amount: argumentOf(amount) }) },
  // `CheckInventory` leaves a count behind, which the comparison after it reads.
  CHECKINVENTORY: { count: 1, result: true, action: ([name], module) => withItem({
    kind: 'inventory' }, name, module) },
  THINGDAMAGE2: { count: 3, action: ([tid, amount, kind], module) => withKind({
    type: 'damageThing', tid: argumentOf(tid), amount: argumentOf(amount) }, kind, module) },
  SECTORDAMAGE: { count: 5, action: ([tag, amount, kind, protection], module) => withKind({
    type: 'sectorDamage', tag: argumentOf(tag), amount: argumentOf(amount),
    protection: nameOf(protection, module) ?? '' }, kind, module) },
};

/**
 * A flat or texture name. A constant index is resolved now, out of the module's own string
 * table; a variable is resolved at run time, because that is when the script would have read it.
 */
function stringOf(value, module) {
  if (value?.kind === 'number') return lookupString(module, Number(value.value) & 0xffff);
  if (value?.kind === 'variable' && value.scope !== 'script') {
    return { expr: `acsflat("${value.scope}", ${value.index})` };
  }
  return null;
}

function flatAction(surface, tag, flat, module) {
  const name = stringOf(flat, module);
  if (name === null) return null;
  const action = { type: 'setSectorFlat', surface, tag: argumentOf(tag) };
  return named(action, 'flat', name);
}

/** The name a string index stands for, or null when it is not one this can read. */
function nameOf(value, module) {
  const name = stringOf(value, module);
  return typeof name === 'string' ? name : null;
}

/** An inventory command, from an item name the module's string table holds. */
function withItem(action, name, module, extra = {}) {
  const item = nameOf(name, module);
  if (item === null) return null;
  return { ...action, ...extra, item };
}

/** A damage command; its damage type is a name, and an unknown one is left empty. */
function withKind(action, kind, module) {
  if ([...Object.values(action)].some(entry => entry === null)) return null;
  return { ...action, kind: nameOf(kind, module) ?? '' };
}

/** Adds a name field to an action, refusing the whole action when the name could not be read. */
function named(action, field, value) {
  if (value === null || value === undefined) return null;
  if ([...Object.values(action)].some(entry => entry === null)) return null;
  action[field] = value;
  return action;
}

/** Constant folding; a variable on either side needs a rule, not a number. */
function fold(operator, right, left) {
  if (left?.kind !== 'number' || right?.kind !== 'number') {
    // `x + 1` and `x - 1` keep their offset, which is how a counter is read against a bound.
    if (left?.kind === 'variable' && right?.kind === 'number' && (operator === '+' || operator === '-')) {
      return { ...left, add: (left.add || 0) + (operator === '+' ? right.value : -right.value) };
    }
    return null;
  }
  const a = Number(left.value), b = Number(right.value);
  const value = operator === '+' ? a + b : operator === '-' ? a - b : operator === '*' ? a * b
    : operator === '/' ? (b === 0 ? null : a / b) : (b === 0 ? null : a % b);
  return value === null ? null : { kind: 'number', value };
}

/** A comparison, folded to a number when both sides are constants. */
function compare(left, operator, right) {
  if (left?.kind === 'number' && right?.kind === 'number') {
    const holds = compareNumbers(Number(left.value), operator, Number(right.value));
    return { kind: 'number', value: holds ? 1 : 0 };
  }
  if ((left?.kind === 'variable' || left?.kind === 'inventory') && right?.kind === 'number') {
    return { kind: 'expr', operator, left, right };
  }
  if (left?.kind === 'number' && right?.kind === 'variable') {
    return { kind: 'expr', operator: MIRROR[operator], left: right, right: left };
  }
  return null;
}

function compareNumbers(a, operator, b) {
  switch (operator) {
    case '=': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    default: return a >= b;
  }
}

/** `&&` joins two tests; `||` cannot be said with a rule's conditions, so it is refused. */
function logic(name, left, right) {
  if (name === 'NEGATELOGICAL') {
    if (left?.kind === 'number') return { kind: 'number', value: left.value ? 0 : 1 };
    if (left?.kind !== 'expr' || left.operator === '&&') return null;
    return { kind: 'expr', operator: NEGATED[left.operator], left: left.left, right: left.right };
  }
  if (name !== 'ANDLOGICAL') return null;
  if (left?.kind === 'expr' && right?.kind === 'expr') return { kind: 'expr', operator: '&&', left, right };
  if (left?.kind === 'number') return left.value ? right : { kind: 'number', value: 0 };
  if (right?.kind === 'number') return right.value ? left : { kind: 'number', value: 0 };
  return null;
}

/**
 * The conditions a test becomes, or `{ dead: true }` when it can only be true or only false.
 * `invert` is for `IFGOTO`, whose guarded block runs when the test is false.
 */
function conditionsFor(entry, invert = false) {
  if (entry?.kind === 'number') {
    return (Number(entry.value) !== 0) !== invert ? { conditions: [] } : { dead: true };
  }
  if (entry?.kind !== 'expr') return null;
  if (entry.operator === '&&') {
    if (invert) return null;
    const left = conditionsFor(entry.left), right = conditionsFor(entry.right);
    if (!left || !right) return null;
    return { conditions: [...left.conditions, ...right.conditions] };
  }
  const { left, right } = entry;
  // `CheckInventory("Shells") >= 5`: the count is the script's, asked through the same table.
  if (left?.kind === 'inventory' && right?.kind === 'number') {
    return { conditions: [{ type: 'acsInventory', item: left.item,
      operator: invert ? NEGATED[entry.operator] : entry.operator, value: Number(right.value) }] };
  }
  if (left?.kind !== 'variable' || right?.kind !== 'number') return null;
  // `x + 1 >= 2` is the test for `if (++x >= 2)`: read the counter with the offset folded in.
  const threshold = Number(right.value) - (left.add || 0);
  return { conditions: [{ type: 'acsVariable', scope: left.scope, index: left.index,
    module: left.module || 0, operator: invert ? NEGATED[entry.operator] : entry.operator, value: threshold }] };
}

function findEntry(program, selector) {
  const list = program?.scripts || [];
  if (typeof selector === 'number' || /^-?\d+$/.test(String(selector))) {
    const number = Number(selector);
    return list.find(script => script.number === number) || null;
  }
  const name = String(selector);
  return list.find(script => String(script.name || '').toLowerCase() === name.toLowerCase()) || null;
}

/** How many of a program's scripts this module can currently translate. */
export function decompileCoverage(program) {
  const scripts = program?.scripts || [];
  let translated = 0;
  for (const script of scripts) if (decompileScript(program, script.number ?? script.name)) translated++;
  return { total: scripts.length, translated };
}
