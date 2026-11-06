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
 * is understood. Anything else — a jump, a loop, a variable, a wait — returns null and the
 * script keeps its `runScript` rule, because a rule that runs half a script is worse than
 * one that runs none of it. Coverage therefore grows by teaching this module one construct
 * at a time, and the import report can say how many scripts are still bytecode.
 */

import { instructionAt } from './acs.js';

const PUSHES = {
  PUSHBYTE: 1, PUSH2BYTES: 2, PUSH3BYTES: 3, PUSH4BYTES: 4, PUSH5BYTES: 5,
};
const SPECIALS = /^LSPEC([1-5])(DIRECT|DIRECTB)?$/;

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
  const actions = [];
  const stack = [];
  const seen = new Set();
  let offset = script.address;
  for (let guard = 0; guard < 4096; guard++) {
    if (offset === null || offset === undefined) return null;
    if (seen.has(offset)) return null;
    seen.add(offset);
    const instruction = instructionAt(module, offset);
    if (!instruction?.supported) return null;
    const name = instruction.name;
    const operands = instruction.operands || [];
    if (name === 'TERMINATE' || name === 'RETURNVOID' || name === 'RETURNVAL' || name === 'END') {
      return { actions, instructions: seen.size };
    }
    const pushed = PUSHES[name];
    if (pushed) {
      // A push of N bytes hands the caller N arguments, in the order they are written.
      for (const value of operands.slice(0, pushed)) stack.push(value);
      offset = instruction.end;
      continue;
    }
    const special = SPECIALS.exec(name);
    if (special) {
      const count = Number(special[1]);
      let args;
      if (special[2]) args = operands.slice(1, 1 + count);
      else {
        // The stack form pops its arguments, so the last pushed is the last argument.
        if (stack.length < count) return null;
        args = stack.splice(stack.length - count, count);
      }
      if (!args.length && count > 0) return null;
      actions.push({ type: 'runLineSpecial', special: Number(operands[0]), arg1: args[0] ?? 0, arg2: args[1] ?? 0,
        arg3: args[2] ?? 0, arg4: args[3] ?? 0, arg5: args[4] ?? 0 });
      offset = instruction.end;
      continue;
    }
    // Anything else — jumps, loops, variables, waits, stack juggling — is not translated.
    return null;
  }
  return null;
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
