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
export function decompileScript(program, selector, { args = [] } = {}) {
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
  // A printed string is built up over several instructions (`BEGINPRINT`, pushes, `ENDPRINT`),
  // and a HudMessage adds six numbers between the text and the end.
  const print = { text: '', open: false, hud: false, hudStart: null, width: 0, height: 0, font: null };
  // The script's arguments arrive in its first slots: `ACS_Execute(n, 0, a, b)` hands a and b
  // to script n, so a body that reads them can be read when the caller's values are known.
  for (const [index, value] of args.entries()) {
    if (index >= (script.argCount || 0)) break;
    if (typeof value === 'number') locals.set(index, { kind: 'number', value });
  }

  /**
   * Reads instructions from `start` until the script ends or `limit` is reached.
   *
   * A guard inside a guard, or a wait inside a guard, is not translated: a step is one rule
   * with one set of conditions, and an inner wait would need a rule chain per branch.
   */
  /**
   * A script variable's value, for the places that need a number rather than the variable.
   * Returns null when the variable was never assigned a value this can follow.
   */
  const resolveLocal = entry => {
    if (entry?.kind !== 'local') return entry;
    const stored = locals.get(entry.index);
    if (!stored) return null;
    const add = entry.add || 0;
    if (!add) return stored;
    if (stored.kind === 'number') return { kind: 'number', value: Number(stored.value) + add };
    if (stored.kind === 'variable') return { ...stored, add: (stored.add || 0) + add };
    return null;
  };

  const read = (start, limit, { nested = false, guards = true, waits = true } = {}) => {
    const stack = [];
    const steps = [];
    let pending = { conditions: [], actions: [] };
    let offset = start;
    const flush = () => {
      if (pending.actions.length) steps.push(pending);
      pending = { conditions: [], actions: [] };
    };
    const pop = () => stack.pop();
    const peek = () => stack[stack.length - 1];
    // An argument is the value it stands for: a script variable resolves to what it holds.
    const argOf = entry => (entry?.kind === 'local' ? argumentOf(resolveLocal(entry)) : argumentOf(entry));
    for (let guard = 0; guard < 8192; guard++) {
      if (limit !== null && limit !== undefined) {
        if (offset === limit) { flush(); return { steps, offset, wait: null, ended: false }; }
        if (offset > limit) return null;
      }
      if (offset === null || offset === undefined) return null;
      if (!nested) {
        if (seen.has(offset)) return null; // a loop that is not counted cannot be unrolled
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
        if (!waits) return null;
        // `DELAY` and `TAGWAIT` take their number off the stack; anything else left on it is
        // a value the next step would have needed, which a step boundary cannot carry.
        const raw = name === 'DELAY' || name === 'TAGWAIT' ? resolveLocal(pop()) : null;
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
        const target = Number(operands[0]);
        if (!(target > next)) return null;
        // A `for` loop: the test jumps *into* its body and the false path jumps past it.
        const test = peek();
        const loop = name === 'IFGOTO' ? countedLoop(offset, target, next, test) : null;
        if (loop) {
          if (!loop.holdsWait) {
            const unrolled = unroll(loop);
            if (!unrolled) return null;
            flush();
            for (const step of unrolled) steps.push(step);
            offset = loop.exit;
            continue;
          }
          // The body waits, so each iteration is a step of its own: this one joins the
          // segment being read, the rest are read after it on the timers the waits start.
          locals.set(loop.test.index, { kind: 'number', value: loop.test.from });
          const first = read(loop.bodyStart, loop.bodyEnd, { nested: true, guards: true });
          if (!first || !first.wait) return null;
          flush();
          for (const step of first.steps) if (step.actions.length) steps.push(step);
          const remaining = loop.test.count > 1;
          locals.set(loop.test.index, { kind: 'number', value: loop.test.from + loop.step.by });
          return { steps, offset: loop.exit, wait: first.wait, ended: false,
            loop: remaining ? { ...loop, iteration: 1, resumeAt: first.offset } : null };
        }
        if (!guards) return null;
        // `IFNOTGOTO` runs its block when the value is true; `IFGOTO` skips the block then.
        const guarded = conditionsFor(pop(), name === 'IFGOTO', resolveLocal);
        if (!guarded) return null;
        const inside = read(next, target, { nested: true, guards: false, waits: false });
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

      // The message a script prints, built one piece at a time.
      if (name === 'BEGINPRINT') { print.text = ''; print.open = true; offset = next; continue; }
      if (name === 'PRINTSTRING' || name === 'PRINTLOCALIZED') {
        const shown = resolveLocal(pop());
        if (!print.open || !shown) return null;
        // A string argument reaches PRINTSTRING as an index into the module's string table.
        if (shown.kind === 'string') print.text += String(shown.text);
        else if (shown.kind === 'number') print.text += lookupString(module, Number(shown.value) & 0xffff);
        else return null;
        offset = next; continue;
      }
      if (name === 'PRINTNUMBER' || name === 'PRINTFIXED' || name === 'PRINTCHARACTER') {
        const value = resolveLocal(pop());
        if (!print.open || value?.kind !== 'number') return null;
        const number = Number(value.value);
        print.text += name === 'PRINTNUMBER' ? String(number)
          : name === 'PRINTCHARACTER' ? String.fromCharCode(number & 0xff)
            : String(Math.round((number / 65536) * 1000) / 1000);
        offset = next; continue;
      }
      if (name === 'ENDPRINT' || name === 'ENDPRINTBOLD' || name === 'ENDLOG') {
        if (!print.open) return null;
        pending.actions.push({ type: 'showMessage', message: print.text.slice(0, 200), seconds: 4 });
        print.text = ''; print.open = false;
        offset = next; continue;
      }
      if (name === 'MOREHUDMESSAGE') { print.hud = true; offset = next; continue; }
      if (name === 'OPTHUDMESSAGE') { print.hudStart = stack.length; offset = next; continue; }
      if (name === 'SETFONT' || name === 'SETFONTDIRECT') {
        const entry = name === 'SETFONT' ? pop() : { kind: 'number', value: Number(operands[0]) || 0 };
        const resolved = resolveLocal(entry);
        if (resolved?.kind !== 'number') return null;
        const font = lookupString(module, Number(resolved.value) & 0xffff);
        print.font = font || null;
        offset = next; continue;
      }
      if (name === 'SETSTYLE' || name === 'SETSTYLEDIRECT') {
        if (name === 'SETSTYLE') pop();
        offset = next; continue;
      }
      if (name === 'SETHUDSIZE') {
        // Pushed width, height, wraparound; the size applies to the messages after it.
        const block = pop(), height = pop(), width = pop();
        const w = resolveLocal(width), h = resolveLocal(height);
        if (w?.kind !== 'number' || h?.kind !== 'number' || !block) return null;
        print.width = Math.abs(Number(w.value));
        print.height = Math.abs(Number(h.value));
        offset = next; continue;
      }
      if (name === 'ENDHUDMESSAGE' || name === 'ENDHUDMESSAGEBOLD') {
        const base = (print.hudStart ?? stack.length) - 6;
        if (base < 0 || stack.length < base + 7) return null;
        const [type, id, color, x, y, hold] = stack.slice(base, base + 6);
        const fade = stack[base + 6];
        const message = hudAction({ type, id, color, x, y, hold, fade }, print.text, print);
        if (!message) return null;
        pending.actions.push(message);
        stack.length = base;
        print.text = ''; print.open = false; print.hud = false; print.hudStart = null;
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
            // Kept symbolic: the value is known, but a `for` loop's test has to stay visible
            // until the jump reads it, or the loop cannot be recognised as counted.
            stack.push({ kind: 'local', index });
            offset = next; continue;
          }
          if (operation === 'ASSIGN') {
            // A script variable is a temporary here: it holds whatever the stack held, so a
            // random roll or a counter offset can be carried to the call that uses it.
            const assigned = resolveLocal(pop());
            if (!assigned) return null;
            locals.set(index, assigned);
            offset = next; continue;
          }
          // `i++`, `i += 2`: the value this walker carries moves with it, so a script that
          // keeps a base number in a variable can still be read past the increment.
          if (!['INC', 'DEC', 'ADD', 'SUB'].includes(operation)) return null;
          const amount = /^(INC|DEC)$/.test(operation) ? { kind: 'number', value: 1 } : resolveLocal(pop());
          if (amount?.kind !== 'number') return null;
          const current = locals.get(index);
          if (!current) return null;
          const delta = operation === 'DEC' ? -Number(amount.value) : Number(amount.value);
          const updated = fold(delta < 0 ? '-' : '+', { kind: 'number', value: Math.abs(delta) }, current);
          if (!updated) return null;
          locals.set(index, updated);
          offset = next; continue;
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
        // Arithmetic needs values, not variable names: a script variable resolves to what it holds.
        const right = resolveLocal(pop()), left = resolveLocal(pop());
        if (!right || !left) return null;
        const folded = fold(FOLDS[name], right, left);
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
      if (name === 'ANDLOGICAL' || name === 'ORLOGICAL') {
        const right = pop();
        const joined = logic(name, pop(), right);
        if (!joined) return null;
        stack.push(joined);
        offset = next; continue;
      }
      if (name === 'NEGATELOGICAL') {
        const of = resolveLocal(pop());
        if (!of) return null;
        // Kept as a test of its own: `!x` is the opposite question, not arithmetic.
        stack.push(of.kind === 'number' ? { kind: 'number', value: of.value ? 0 : 1 } : { kind: 'not', of });
        offset = next; continue;
      }
      // Trigonometry and shifts, in the units ACS uses: an angle is a 16.16 fraction of a
      // turn and a result is fixed point again, and `x >> 16` is the fixed-point drop.
      if (name === 'SIN' || name === 'COS') {
        const angle = textOf(pop(), resolveLocal);
        if (angle === null) return null;
        stack.push({ kind: 'value',
          text: `round(${name.toLowerCase()}(((${angle}) % 65536) / 65536 * 2 * pi) * 65536)` });
        offset = next; continue;
      }
      // Fixed-point multiply and divide, which ACS carries as 16.16 shifts of an integer.
      if (name === 'FIXEDMUL' || name === 'FIXEDDIV') {
        const right = textOf(resolveLocal(pop()), resolveLocal);
        const left = textOf(resolveLocal(pop()), resolveLocal);
        if (left === null || right === null) return null;
        stack.push({ kind: 'value', text: name === 'FIXEDMUL'
          ? `floor((${left}) * (${right}) / 65536)`
          : `floor((${left}) * 65536 / (${right}))` });
        offset = next; continue;
      }
      if (name === 'LSHIFT' || name === 'RSHIFT') {
        const by = resolveLocal(pop()), value = resolveLocal(pop());
        if (by?.kind !== 'number' || value === undefined) return null;
        const bits = Number(by.value);
        if (!Number.isInteger(bits) || bits < 0 || bits > 24) return null;
        const text = textOf(value, resolveLocal);
        if (text === null) return null;
        const factor = 2 ** bits;
        stack.push({ kind: 'value', text: name === 'RSHIFT'
          ? `floor((${text}) / ${factor})` : `((${text}) * ${factor})` });
        offset = next; continue;
      }
      if (name === 'UNARYMINUS') {
        const of = pop();
        if (!of) return null;
        stack.push(fold('-', of, { kind: 'number', value: 0 }));
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
      const query = QUERIES[name];
      if (query) {
        const value = query(stack, resolveLocal);
        if (!value) return null;
        stack.push(value);
        offset = next; continue;
      }

      const builtin = BUILTINS[name];
      if (builtin) {
        // A `*DIRECT` opcode carries its arguments as operands; the stack form pops them.
        const values = builtin.operands
          ? operands.slice(0, builtin.count).map(value => ({ kind: 'number', value: Number(value) || 0 }))
          : stack.splice(Math.max(0, stack.length - builtin.count));
        if (values.length !== builtin.count) return null;
        const action = builtin.action(values.map(resolveLocal), module);
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
          args = stack.splice(stack.length - count, count).map(argOf);
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

  /**
   * Recognises the counted `for` ACC compiles, and returns what is needed to unroll it:
   *
   * ```
   * header: PUSH counter; PUSH limit; LT        the test
   *         IFGOTO body                          jump into the body while it holds
   *         GOTO exit                            and past the loop when it does not
   *         continue: INC counter                (the `for` step)
   *   body: ... ; GOTO continue | GOTO header
   * exit:
   * ```
   *
   * Only the shapes a rule can express are accepted: a script-variable counter with a known
   * value, a constant limit, a step of one, a body with no waits and a bound that keeps the
   * unrolled script small. Everything else returns null and the script keeps its bytecode.
   */
  const countedLoop = (header, bodyStart, next, test) => {
    const afterTest = instructionAt(module, next);
    if (afterTest?.name !== 'GOTO') return null;
    const exit = Number(afterTest.operands[0]);
    if (!(exit > bodyStart)) return null;
    // The `for` step sits between the exit jump and the body; a `while` has none.
    const continueBlock = afterTest.end === bodyStart ? null : { start: afterTest.end, end: bodyStart };
    const back = findBackEdge(bodyStart, header);
    if (!back) return null;
    const step = continueBlock ? stepOf(continueBlock, back.target, header) : null;
    if (!step) return null;
    const counted = countOf(test, step);
    if (!counted) return null;
    return { header, bodyStart, bodyEnd: back.at, continueBlock, exit, step, test: counted,
      backTarget: back.target, holdsWait: containsWait(bodyStart, back.at) };
  };

  /** The first `GOTO` in the body that jumps back to the loop, which ends the body. */
  const findBackEdge = (start, header) => {
    let offset = start;
    for (let guard = 0; guard < 4096; guard++) {
      const instruction = instructionAt(module, offset);
      if (!instruction?.end) return null;
      if (instruction.name === 'GOTO') {
        const target = Number(instruction.operands[0]);
        // A jump back to the test, or back to the `for` step that leads to it, ends the body.
        if (target <= header || target < offset) return { at: offset, target };
        offset = target;
        continue;
      }
      if (ENDS.test(instruction.name)) return null;
      offset = instruction.end;
    }
    return null;
  };

  /**
   * What the `for` step does to the counter: `INC`/`DEC`, or `ADD`/`SUB` of a constant. The
   * counter has to be a script variable, because that is the only one this follows.
   */
  const stepOf = (block, backTarget, header) => {
    let offset = block.start;
    let found = null;
    for (let guard = 0; guard < 32; guard++) {
      const instruction = instructionAt(module, offset);
      if (!instruction?.end) return null;
      const variable = VARIABLE.exec(instruction.name);
      if (variable) {
        const [, operation, scopeName] = variable;
        if (SCOPE[scopeName] !== 'script') return null;
        if (found) return null; // two variables stepped at once is not a counted loop
        const by = operation === 'INC' ? 1 : operation === 'DEC' ? -1 : null;
        if (by === null) return null;
        found = { index: Number(instruction.operands[0]), by };
      } else if (instruction.name === 'GOTO' && Number(instruction.operands[0]) <= header) {
        // The step ends by jumping back to the test, which is what makes it the loop's step.
        offset = instruction.end;
        break;
      } else if (!/^NOP$/.test(instruction.name)) return null;
      offset = instruction.end;
      if (offset === block.end) break;
    }
    if (!found) return null;
    // The step must lead back to the header, or it is not this loop's own step.
    if (backTarget !== block.start || offset !== block.end) return null;
    return found;
  };

  /** Whether the loop's body waits, which decides whether its iterations are steps. */
  const containsWait = (start, end) => {
    let offset = start;
    for (let guard = 0; guard < 4096 && offset < end; guard++) {
      const instruction = instructionAt(module, offset);
      if (!instruction?.end) return true; // cannot tell: assume it waits, which is the safe path
      if (WAITS.test(instruction.name)) return true;
      offset = instruction.end;
    }
    return false;
  };

  /**
   * Turns `counter < limit` into "how many times": the counter must be the variable the step
   * changes, and the bound a constant. A loop longer than 32 iterations is refused, because an
   * unrolled rule with a hundred copies in it is not a sheet a creator can read.
   */
  const countOf = (test, step) => {
    if (test?.kind !== 'expr' || test.left?.kind !== 'local' || step.index === null) return null;
    if (test.left.index !== step.index || test.right?.kind !== 'number') return null;
    const from = resolveLocal(test.left);
    if (from?.kind !== 'number') return null;
    const start = Number(from.value), limit = Number(test.right.value);
    const up = step.by > 0;
    const forwards = { '<': limit - start, '<=': limit - start + 1 };
    const backwards = { '>': start - limit, '>=': start - limit + 1 };
    const count = (up ? forwards : backwards)[test.operator];
    if (!Number.isInteger(count) || count < 0 || count > 32) return null;
    return { index: test.left.index, from: start, count };
  };

  /**
   * The body of a counted loop, once per iteration, with the counter pinned to its value.
   *
   * The iterations run back to back in one tic, so they join the actions of a single step. A
   * body with a test in it would need a sub-event per iteration, which a flat list cannot say
   * in order — those loops keep their bytecode.
   */
  const unroll = loop => {
    const test = loop.test;
    if (!test) return null;
    const actions = [];
    for (let index = 0; index < test.count; index++) {
      locals.set(test.index, { kind: 'number', value: test.from + loop.step.by * index });
      const inside = read(loop.bodyStart, loop.bodyEnd, { nested: true, guards: true });
      if (!inside || inside.wait || inside.ended) return null;
      for (const step of inside.steps) {
        if (step.conditions.length) return null;
        actions.push(...step.actions);
      }
      if (actions.length > 256) return null;
    }
    locals.set(test.index, { kind: 'number', value: test.from + loop.step.by * test.count });
    return actions.length ? [{ conditions: [], actions }] : [];
  };

  // A loop whose body waits is read one iteration per step; `queue` carries it between them.
  // The code after the body's wait (the `for` step, usually) belongs to the next step, which is
  // why the queue remembers where the iteration resumes.
  let queue = null;
  let prefix = null;
  for (let guard = 0; guard < 1024; guard++) {
    let segment = null;
    const collected = [];
    if (queue) {
      const { loop, iteration, resumeAt } = queue;
      if (resumeAt !== null && resumeAt !== undefined) {
        const resume = read(resumeAt, loop.bodyEnd, { nested: true, guards: true });
        if (!resume || resume.wait) return null; // one wait per iteration is what a step can be
        for (const step of resume.steps) if (step.actions.length) collected.push(step);
      }
      const finished = iteration >= loop.test.count;
      if (finished) {
        // The last iteration's tail joins the code that follows the loop, in one step.
        locals.set(loop.test.index, { kind: 'number', value: loop.test.from + loop.step.by * loop.test.count });
        queue = null;
        offset = loop.exit;
        prefix = collected;
        continue;
      }
      locals.set(loop.test.index, { kind: 'number', value: loop.test.from + loop.step.by * iteration });
      const part = read(loop.bodyStart, loop.bodyEnd, { nested: true, guards: true });
      if (!part) return null;
      for (const step of part.steps) if (step.actions.length) collected.push(step);
      segments.push({ steps: collected, wait: part.wait });
      queue = { loop, iteration: iteration + 1, resumeAt: part.wait ? part.offset : null };
      if (!part.wait) return null; // a repeated body that does not wait cannot be a step
      continue;
    }
    segment = read(offset, null, 0);
    if (!segment) return null;
    const steps = [...(prefix || []), ...segment.steps].filter(step => step.actions.length);
    prefix = null;
    if (steps.length || segment.wait) segments.push({ steps, wait: segment.wait });
    if (segment.loop) {
      queue = { loop: segment.loop, iteration: segment.loop.iteration || 1, resumeAt: segment.loop.resumeAt };
      offset = segment.loop.exit;
      continue;
    }
    if (!segment.wait) {
      if (!segment.ended) return null; // more code after a step that nothing waits on
      break;
    }
    offset = segment.offset;
  }
  const actions = segments.flatMap(segment => segment.steps.flatMap(step => step.actions));
  return { actions, segments, instructions: seen.size };
}

/**
 * An argument as the value a rule passes: a plain number, or `acsvar("map", 3)` for a level
 * variable, which the runtime reads from the same store the rest of the scripts use.
 */
/** A script's `HudMessage` as the action that shows it, or null when a field is unreadable. */
function hudAction(fields, text, print) {
  const whole = entry => {
    const resolved = entry;
    return resolved?.kind === 'number' ? Number(resolved.value) : null;
  };
  const [, id, color] = [fields.type, fields.id, fields.color].map(whole);
  const [type] = [fields.type].map(whole);
  const x = fixed(fields.x, 1, value => value / 65536);
  const y = fixed(fields.y, 1, value => value / 65536);
  const holdTime = fixed(fields.hold, 600, value => value / 65536);
  const fade = fixed(fields.fade, 600, value => value / 65536);
  if ([type, id, color].some(value => value === null) || [x, y, holdTime, fade].some(value => value === null)) return null;
  // `messageType` rather than `type`: `type` is the action's own name.
  const action = { type: 'showHudMessage', text: String(text).slice(0, 500), messageType: type, id, color,
    x, y, holdTime, fade,
    hudWidth: print.width || 0, hudHeight: print.height || 0 };
  if (print.font) action.font = print.font;
  return action;
}

/** The expression text an entry reads as, resolving a script variable through its value. */
function textOf(entry, resolveLocal) {
  const resolved = resolveLocal ? resolveLocal(entry) : entry;
  return resolved ? expressionOf(resolved) : null;
}

function argumentOf(entry) {
  if (entry === undefined || entry === null) return 0;
  if (entry.kind === 'number') return Number(entry.value) || 0;
  if (entry.kind === 'local') return null; // a script variable is resolved by the caller
  const text = expressionOf(entry);
  return text === null ? null : { expr: text };
}

/** The expression text a stack entry reads as, or null when it is not something a rule can say. */
function expressionOf(entry) {
  if (entry?.kind === 'number') return String(Number(entry.value) || 0);
  if (entry?.kind === 'value') return entry.text;
  if (entry?.kind === 'random') return `floor(random(${entry.min}, ${entry.max}))`;
  if (entry?.kind === 'not') {
    const inner = expressionOf(entry.of);
    return inner === null ? null : `(${inner} == 0 ? 1 : 0)`;
  }
  if (entry?.kind === 'negate') {
    const inner = expressionOf(entry.of);
    return inner === null ? null : `(-(${inner}))`;
  }
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
/**
 * The reads a script makes: `GetActorZ(tid)` leaves the height where the tid was, and
 * `GetActorProperty(tid, p)` leaves the property. They become expressions the rule evaluates
 * through the same host functions the interpreter uses, so a rule reads live state, not a copy.
 */
const QUERIES = {
  GETACTORX: actorRead('x'), GETACTORY: actorRead('y'), GETACTORZ: actorRead('z'),
  GETACTORFLOORZ: actorRead('floorZ'), GETACTORCEILINGZ: actorRead('ceilingZ'),
  GETACTORANGLE: actorRead('angle'), GETACTORPITCH: actorRead('pitch'),
  GETACTORLIGHTLEVEL: actorRead('light'),
  GETACTORPROPERTY: (stack, resolve) => {
    const property = stack.pop(), tid = stack.pop();
    return call(['acsactorproperty', tid, property], resolve);
  },
  GETSECTORFLOORZ: sectorRead('floor'),
  GETSECTORCEILINGZ: sectorRead('ceiling'),
};

function actorRead(kind) {
  return (stack, resolve) => call(['acsactor', stack.pop(), { kind: 'name', text: kind }], resolve);
}

function sectorRead(surface) {
  return (stack, resolve) => {
    const y = stack.pop(), x = stack.pop(), tag = stack.pop();
    return call(['acssectorz', tag, x, y, { kind: 'name', text: surface }], resolve);
  };
}

/** `name(parts…)` as a value the rule can carry, or null when a part cannot be read. */
function call(parts, resolve) {
  const [name, ...args] = parts;
  const rendered = args.map(part => (part?.kind === 'name' ? `"${part.text}"` : textOf(part, resolve)));
  if (rendered.some(text => text === null)) return null;
  return { kind: 'value', text: `${name}(${rendered.join(', ')})` };
}

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
  // `FadeTo(red, green, blue, amount, seconds)`: ACS carries these as 16.16 fixed point, and
  // the action takes ordinary numbers, so a constant is converted here and a variable becomes
  // the expression the rule evaluates.
  FADETO: { count: 5, action: ([red, green, blue, amount, seconds]) => {
    const colour = entry => fixed(entry, 255, value => Math.round(value / 65536 || value));
    const colours = [red, green, blue].map(colour);
    const strength = fixed(amount, 1, value => value / 65536);
    const duration = fixed(seconds, 600, value => value / 65536);
    if (colours.some(value => value === null) || strength === null || duration === null) return null;
    return { type: 'fadeTo', red: colours[0], green: colours[1], blue: colours[2],
      amount: strength, seconds: duration };
  } },
  SETACTORPOSITION: { count: 5, action: ([tid, x, y, z, fog]) => ({
    type: 'setActorPosition', tid: argumentOf(tid), x: argumentOf(x), y: argumentOf(y),
    z: argumentOf(z), fog: argumentOf(fog) }) },
  // `FadeRange(r1, g1, b1, a1, r2, g2, b2, a2, seconds)`: the same fixed point as `FadeTo`,
  // twice — where the tint starts and where it ends.
  FADERANGE: { count: 9, action: ([r1, g1, b1, a1, r2, g2, b2, a2, seconds]) => {
    const colour = entry => fixed(entry, 255, value => Math.round(value / 65536 || value));
    const amount = entry => fixed(entry, 1, value => value / 65536);
    const from = [colour(r1), colour(g1), colour(b1), amount(a1)];
    const to = [colour(r2), colour(g2), colour(b2), amount(a2)];
    const duration = fixed(seconds, 600, value => value / 65536);
    if ([...from, ...to, duration].some(value => value === null)) return null;
    return { type: 'fadeRange', redFrom: from[0], greenFrom: from[1], blueFrom: from[2], amountFrom: from[3],
      red: to[0], green: to[1], blue: to[2], amount: to[3], seconds: duration };
  } },
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

/**
 * A 16.16 fixed-point argument as the number an action takes: a constant is converted now, a
 * variable becomes an expression that divides when the rule runs.
 */
function fixed(entry, max, convert = value => value) {
  if (entry?.kind === 'number') {
    return Math.max(0, Math.min(max, Math.round(convert(Number(entry.value)) * 1000) / 1000));
  }
  const text = expressionOf(entry);
  if (text === null) return null;
  return { expr: `min(${max}, max(0, (${text}) / 65536))` };
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

/** Constant folding; anything the expression language can read composes, a number stays one. */
function fold(operator, right, left) {
  // `0 - x` is a negation: keep the sign with the value it applies to.
  if (operator === '-' && left?.kind === 'number' && Number(left.value) === 0 &&
    ['variable', 'local'].includes(right?.kind)) {
    return right.kind === 'local' ? null : { kind: 'negate', of: right };
  }
  // `x + 1` and `x - 1` keep their offset, which is how a counter is read against a bound.
  if ((left?.kind === 'variable' || left?.kind === 'local') && right?.kind === 'number' &&
    (operator === '+' || operator === '-')) {
    return { ...left, add: (left.add || 0) + (operator === '+' ? right.value : -right.value) };
  }
  if (left?.kind === 'number' && right?.kind === 'number') {
    const a = Number(left.value), b = Number(right.value);
    const value = operator === '+' ? a + b : operator === '-' ? a - b : operator === '*' ? a * b
      : operator === '/' ? (b === 0 ? null : a / b) : (b === 0 ? null : a % b);
    return value === null ? null : { kind: 'number', value };
  }
  // Two values the expression language can read compose into one it can read.
  const leftText = expressionOf(left), rightText = expressionOf(right);
  if (leftText === null || rightText === null) return null;
  return { kind: 'value', text: `(${leftText} ${operator} ${rightText})` };
}

/** A comparison, folded to a number when both sides are constants. */
function compare(left, operator, right) {
  if (left?.kind === 'number' && right?.kind === 'number') {
    const holds = compareNumbers(Number(left.value), operator, Number(right.value));
    return { kind: 'number', value: holds ? 1 : 0 };
  }
  // Any other pair stays a test for `conditionsFor` to express — two variables included.
  if (left && right) return { kind: 'expr', operator, left, right };
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
function conditionsFor(entry, invert = false, resolveLocal = value => value) {
  if (entry?.kind === 'number') {
    return (Number(entry.value) !== 0) !== invert ? { conditions: [] } : { dead: true };
  }
  // `!x` is the opposite question: ask the inner test and expect the other answer.
  if (entry?.kind === 'not') return conditionsFor(entry.of, !invert, resolveLocal);
  // A value on its own is a test of whether it is zero: `if (mapVar) …`.
  if (entry?.kind === 'variable') {
    return { conditions: [{ type: 'acsVariable', scope: entry.scope, index: entry.index,
      module: entry.module || 0, operator: invert ? '=' : '!=', value: 0 - (entry.add || 0) }] };
  }
  if (entry?.kind === 'local' || entry?.kind === 'inventory') {
    const text = textOf(entry, resolveLocal);
    const resolved = entry.kind === 'local' ? resolveLocal(entry) : entry;
    if (resolved?.kind === 'number') return conditionsFor(resolved, invert, resolveLocal);
    if (text === null) return null;
    return { conditions: [{ type: 'expressionCompare', left: { expr: text },
      operator: invert ? '=' : '!=', right: { expr: '0' } }] };
  }
  if (entry?.kind !== 'expr') return null;
  if (entry.operator === '&&') {
    if (invert) return null;
    const left = conditionsFor(entry.left, false, resolveLocal);
    const right = conditionsFor(entry.right, false, resolveLocal);
    if (!left || !right) return null;
    return { conditions: [...left.conditions, ...right.conditions] };
  }
  const { left, right } = entry;
  // A script variable with a known value decides the test now, as it did in the bytecode.
  if (left?.kind === 'local') {
    const resolved = resolveLocal(left);
    if (resolved?.kind === 'number' && right?.kind === 'number') {
      const holds = compareNumbers(Number(resolved.value), entry.operator, Number(right.value));
      return holds !== invert ? { conditions: [] } : { dead: true };
    }
    // Not a constant test: fall through and let the expression language compare it.
  }
  // `CheckInventory("Shells") >= 5`: the count is the script's, asked through the same table.
  if (left?.kind === 'inventory' && right?.kind === 'number') {
    return { conditions: [{ type: 'acsInventory', item: left.item,
      operator: invert ? NEGATED[entry.operator] : entry.operator, value: Number(right.value) }] };
  }
  const operator = invert ? NEGATED[entry.operator] : entry.operator;
  if (left?.kind === 'variable' && right?.kind === 'number') {
    // `x + 1 >= 2` is the test for `if (++x >= 2)`: read the counter with the offset folded in.
    const threshold = Number(right.value) - (left.add || 0);
    return { conditions: [{ type: 'acsVariable', scope: left.scope, index: left.index,
      module: left.module || 0, operator, value: threshold }] };
  }
  // Anything else the expression language can say — two variables, a variable against a
  // random roll, a negation — is a comparison of two expressions, which the engine evaluates.
  const leftText = textOf(left, resolveLocal), rightText = textOf(right, resolveLocal);
  if (leftText === null || rightText === null) return null;
  return { conditions: [{ type: 'expressionCompare', left: { expr: leftText }, operator,
    right: { expr: rightText } }] };
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
