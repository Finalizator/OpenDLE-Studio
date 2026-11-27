/**
 * ACS source, compiled to the p-code a level already runs.
 *
 * An imported game ships its scripts as bytecode, so the editor can only show a disassembly.
 * This module is the other half: it reads ACC's language — macros, variables, functions,
 * control flow and the builtins a map script uses — and writes the stack-machine instructions
 * `shared/acs.js` executes. Nothing about the runtime changes, so a script written here runs at
 * 35 Hz beside the ones the WAD shipped, saves with them and can be called by them.
 *
 * ```acs
 * #include "zcommon.acs"            // ignored: the builtins below are what it declares
 * #define SPEED 16
 * int counter;                      // script-local
 * world int 0:totalKills;           // shared by every script
 *
 * function int twice(int value) { return value * 2; }
 *
 * script 5 OPEN (int tag) {
 *     Door_Open(tag, SPEED);
 *     delay(35);
 *     if (counter < 3) { counter++; restart; }
 *     PrintBold(s:"the door is open, hits: ", d:counter);
 * }
 * ```
 *
 * Fixed-point literals (`1.0`, `0.5`) are 16.16 integers, as ACC means them. Every argument
 * reaches a builtin in the units the interpreter already reads, so a speed of `16` in
 * `Door_Open` is the same 16 a linedef special carries.
 *
 * `compileAcsSource` is pure: it returns code and the strings and functions it added, and
 * `shared/map-scripts.js` merges them into the module. A compile error therefore cannot leave
 * a half-edited level behind.
 */

import { PCODE_NAMES } from './acs.js';
import { SPECIAL_NAMES } from './line-specials.js';

/** A compile failure that names the line a creator has to look at. */
export class AcsSourceError extends Error {
  constructor(message, line = 0, column = 0) {
    super(line ? `${message} (line ${line})` : message);
    this.name = 'AcsSourceError';
    this.line = line;
    this.column = column;
  }
}

const OPCODE = new Map(PCODE_NAMES.map((name, code) => [name, code]));

/** Constants ACC's headers define, so a pasted script does not need the include. */
const CONSTANTS = {
  true: 1, false: 0, TRUE: 1, FALSE: 0, ON: 1, OFF: 0, YES: 1, NO: 0, NULL: 0,
  CR_UNTRANSLATED: -1, CR_BRICK: 0, CR_TAN: 1, CR_GRAY: 2, CR_GREY: 2, CR_GREEN: 3, CR_BROWN: 4,
  CR_GOLD: 5, CR_RED: 6, CR_BLUE: 7, CR_ORANGE: 8, CR_WHITE: 9, CR_YELLOW: 10, CR_LIGHTBLUE: 11,
  CR_OLIVE: 12, CR_PURPLE: 13, CR_DARKRED: 14, CR_DARKBROWN: 15, CR_DARKGREEN: 16, CR_DARKGRAY: 17,
  CR_DARKGREY: 17, CR_CREAM: 18, CR_DARKBLUE: 19, CR_DARKORANGE: 20, CR_DARKYELLOW: 21,
  CR_DARKOLIVE: 22, CR_DARKPURPLE: 23, CR_DARKCYAN: 24, CR_ICE: 25, CR_FIRE: 26, CR_SAPPHIRE: 27,
  CR_TEAL: 28, HUDMSG_PLAIN: 0, HUDMSG_FADEOUT: 1, HUDMSG_TYPEON: 2, HUDMSG_FADEINOUT: 3,
  HUDMSG_LOG: 4, HUDMSG_COLORSTRING: 5, BLINKMASK: 8,
  OBJSTATE_DEAD: 0, OBJSTATE_NORMAL: 1, APROP_Health: 1, APROP_Speed: 2, APROP_Damage: 3,
  APROP_Alpha: 4, APROP_RenderStyle: 5, APROP_SeeSound: 6, APROP_AttackSound: 7, APROP_PainSound: 8,
  APROP_ActiveSound: 9, APROP_Ambush: 10, APROP_Invulnerable: 11, APROP_Friendly: 12, APROP_Score: 13,
  APROP_Notarget: 14, APROP_AttackZRange: 15, APROP_AttackDelay: 16, APROP_StencilColor: 17,
  APROP_Gravity: 18, APROP_Friction: 19, APROP_Accuracy: 20, APROP_Stamina: 21, APROP_Height: 22,
  APROP_Radius: 23, APROP_ReactionTime: 24, APROP_MeleeRange: 25, APROP_ViewHeight: 26,
  APROP_AttackSound2: 27, APROP_JumpZ: 28, APROP_Spread: 29, APROP_ForcedPainChance: 30,
  APROP_MaxTargetRange: 31, APROP_DamageMultiplier: 32, APROP_DamageType: 33, APROP_VisibleInMap: 34,
  APROP_ViewAngle: 35, APROP_WaterLevel: 36, APROP_TargetName: 37, APROP_HealthCap: 38,
};

const SCRIPT_TYPES = {
  OPEN: 'open', ENTER: 'enter', RESPAWN: 'respawn', DEATH: 'death', CLOSED: 'closed',
  LIGHTNING: 'lightning', UNLOADING: 'unloading', DISCONNECT: 'disconnect', RETURN: 'return',
  REOPEN: 'reopen', EVENT: 'event', KILL: 'kill', PICKUP: 'pickup',
};

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const PUNCTUATION = ['<<=', '>>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '<<', '>>', '==', '!=', '<=', '>=', '::', '{', '}', '(', ')', '[', ']', ';', ',', '.', '?', ':', '!', '~',
  '+', '-', '*', '/', '%', '<', '>', '=', '&', '|', '^', '#'];

function stripComments(text) {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      result += '\n';
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') result += '\n';
        index++;
      }
      index++;
      continue;
    }
    if (char === '"') {
      result += char;
      for (index++; index < text.length; index++) {
        result += text[index];
        if (text[index] === '\\') { result += text[index + 1] ?? ''; index++; continue; }
        if (text[index] === '"') break;
      }
      continue;
    }
    result += char;
  }
  return result;
}

function unescapeString(text) {
  return text.replace(/\\(.)/g, (whole, char) => ({
    n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"',
  })[char] ?? char);
}

function tokenize(text) {
  const tokens = [];
  let index = 0, line = 1, lineStart = 0;
  const column = () => index - lineStart + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\n') { index++; line++; lineStart = index; continue; }
    if (/\s/.test(char)) { index++; continue; }
    if (/[A-Za-z_]/.test(char)) {
      const start = index, columnAt = column();
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index++;
      tokens.push({ type: 'ident', value: text.slice(start, index), line, column: columnAt });
      continue;
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(text[index + 1] ?? ''))) {
      const start = index, columnAt = column();
      while (index < text.length && /[0-9A-Za-z_.]/.test(text[index])) index++;
      const raw = text.slice(start, index);
      let value;
      if (raw.includes('.')) value = Math.round(Number(raw) * 65536);
      else if (/^0[xX]/.test(raw)) value = parseInt(raw.slice(2), 16);
      else if (/^0[0-7]+$/.test(raw)) value = parseInt(raw, 8);
      else value = parseInt(raw, 10);
      if (!Number.isFinite(value)) throw new AcsSourceError(`"${raw}" is not a number`, line, columnAt);
      tokens.push({ type: 'number', value, line, column: columnAt });
      continue;
    }
    if (char === '"') {
      const columnAt = column();
      let cursor = index + 1, value = '';
      while (cursor < text.length && text[cursor] !== '"') {
        if (text[cursor] === '\n') throw new AcsSourceError('A string cannot span lines', line, columnAt);
        if (text[cursor] === '\\') { value += text[cursor] + (text[cursor + 1] ?? ''); cursor += 2; continue; }
        value += text[cursor++];
      }
      if (cursor >= text.length) throw new AcsSourceError('Unterminated string', line, columnAt);
      index = cursor + 1;
      tokens.push({ type: 'string', value: unescapeString(value), line, column: columnAt });
      continue;
    }
    const punctuation = PUNCTUATION.find(candidate => text.startsWith(candidate, index));
    if (!punctuation) throw new AcsSourceError(`Unexpected character "${char}"`, line, column());
    tokens.push({ type: 'op', value: punctuation, line, column: column() });
    index += punctuation.length;
  }
  tokens.push({ type: 'eof', value: '', line, column: column() });
  return tokens;
}

/**
 * `#define` and friends.
 *
 * Only object-like macros are expanded: a function-like macro stops the compile with its line
 * rather than being silently ignored, because a script that relied on one would otherwise
 * compile the macro's name as a variable and fail somewhere much less obvious.
 */
function preprocess(text, warnings) {
  const macros = new Map();
  const kept = [];
  for (const [number, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) { kept.push(line); continue; }
    const directive = trimmed.match(/^#\s*(\w+)\s*(.*)$/);
    if (!directive) { kept.push(line); continue; }
    const [, name, rest] = directive;
    if (name === 'include' || name === 'import') { kept.push(''); continue; }
    if (name === 'undef') { macros.delete(rest.trim()); kept.push(''); continue; }
    if (name === 'define' || name === 'libdefine') {
      const definition = rest.match(/^([A-Za-z_]\w*)(\s*\(([^)]*)\))?\s*(.*)$/);
      if (!definition) { warnings.push(`Line ${number + 1}: this #${name} was skipped.`); kept.push(''); continue; }
      if (definition[2]) {
        throw new AcsSourceError(`the function-like macro ${definition[1]} is not supported; write its body out`,
          number + 1, 1);
      }
      macros.set(definition[1], definition[4] ?? '');
      kept.push('');
      continue;
    }
    kept.push(''); // #region, #wadauthor and the rest are comments to a compiler
  }
  const tokens = tokenize(stripComments(kept.join('\n')));
  if (!macros.size) return tokens;
  const expand = (list, depth) => list.flatMap(token => {
    const body = token.type === 'ident' ? macros.get(token.value) : undefined;
    if (body === undefined || depth > 16) return [token];
    // A macro body is tokenized on its own, so its end-of-file marker must not end the file.
    return expand(tokenize(body).filter(entry => entry.type !== 'eof'), depth + 1);
  });
  return expand(tokens, 0);
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const BINARY_PRECEDENCE = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='],
  ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

const ASSIGNMENTS = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];

function parseTokens(tokens) {
  let at = 0;
  const token = (offset = 0) => tokens[Math.min(at + offset, tokens.length - 1)];
  const next = () => tokens[at++];
  const isOp = value => token().type === 'op' && token().value === value;
  const isWord = value => token().type === 'ident' && token().value === value;
  const eat = value => { if (isOp(value)) { at++; return true; } return false; };
  const fail = message => { throw new AcsSourceError(message, token().line, token().column); };
  const expect = value => {
    if (!isOp(value)) fail(`Expected "${value}" but found "${token().value || 'end of file'}"`);
    at++;
  };
  const expectName = () => {
    if (token().type !== 'ident') fail(`Expected a name but found "${token().value || 'end of file'}"`);
    return next().value;
  };
  const type = () => (token().type === 'ident' && ['int', 'str', 'bool', 'void'].includes(token().value)
    ? next().value : null);

  /** `s:"text"` and the `d:`/`f:`/`c:` forms — ACS's typed call arguments. */
  function prefixed() {
    const current = token();
    if (current.type === 'ident' && current.value.length === 1 && 'sdfca'.includes(current.value)
      && token(1).type === 'op' && token(1).value === ':') {
      at += 2;
      return { prefix: current.value, value: expression() };
    }
    return { prefix: null, value: expression() };
  }

  function expression() {
    const left = binary(0);
    if (!isOp('?')) return left;
    next();
    const yes = expression();
    expect(':');
    return { k: 'cond', test: left, yes, no: expression() };
  }

  function binary(level) {
    if (level >= BINARY_PRECEDENCE.length) return unary();
    let left = binary(level + 1);
    for (;;) {
      const operator = token().type === 'op' ? token().value : null;
      if (!operator || !BINARY_PRECEDENCE[level].includes(operator)) return left;
      next();
      left = { k: 'bin', op: operator, a: left, b: binary(level + 1) };
    }
  }

  function unary() {
    if (isOp('-') || isOp('!') || isOp('~') || isOp('+')) return { k: 'un', op: next().value, e: unary() };
    if (isOp('++') || isOp('--')) return { k: 'pre', op: next().value, target: unary() };
    return postfix();
  }

  function postfix() {
    let node = primary();
    for (;;) {
      if (isOp('[')) { next(); const index = expression(); expect(']'); node = { k: 'index', target: node, index }; continue; }
      if (isOp('++') || isOp('--')) { node = { k: 'post', op: next().value, target: node }; continue; }
      if (token().type === 'op' && ASSIGNMENTS.includes(token().value)) {
        node = { k: 'assign', op: next().value, target: node, value: expression() };
        continue;
      }
      return node;
    }
  }

  function primary() {
    const current = token();
    if (current.type === 'number') { next(); return { k: 'num', v: current.value }; }
    if (current.type === 'string') { next(); return { k: 'str', v: current.value }; }
    if (isOp('(')) { next(); const inner = expression(); expect(')'); return inner; }
    if (current.type !== 'ident') fail(`Unexpected "${current.value || 'end of file'}"`);
    const name = next().value;
    if (!isOp('(')) return { k: 'id', name, line: current.line };
    next();
    const args = [];
    if (!isOp(')')) {
      for (;;) {
        args.push(prefixed());
        if (!eat(',')) break;
      }
    }
    expect(')');
    return { k: 'call', name, args, line: current.line };
  }

  function block() {
    expect('{');
    const body = [];
    while (!isOp('}')) {
      if (token().type === 'eof') fail('Unclosed block');
      body.push(statement());
    }
    expect('}');
    return { k: 'block', body };
  }

  function declaration() {
    const valueType = type() ?? 'int';
    const declarations = [];
    for (;;) {
      const name = expectName();
      let size = null;
      if (isOp('[')) { next(); size = expression(); expect(']'); }
      let value = null;
      if (eat('=')) value = expression();
      declarations.push({ k: 'decl', type: valueType, name, size, value });
      if (!eat(',')) break;
    }
    expect(';');
    return declarations.length === 1 ? declarations[0] : { k: 'block', body: declarations };
  }

  function params() {
    expect('(');
    const list = [];
    if (!isOp(')')) {
      for (;;) {
        const valueType = type() ?? 'int';
        list.push({ name: expectName(), type: valueType });
        if (!eat(',')) break;
      }
    }
    expect(')');
    return list;
  }

  function statement() {
    if (isOp('{')) return block();
    if (isOp(';')) { next(); return { k: 'empty' }; }
    const word = token().type === 'ident' ? token().value : '';
    if (word === 'if') {
      next(); expect('(');
      const test = expression();
      expect(')');
      const whenTrue = statement();
      return { k: 'if', test, then: whenTrue, else: isWord('else') ? (next(), statement()) : null };
    }
    if (word === 'while') {
      next(); expect('(');
      const test = expression();
      expect(')');
      return { k: 'while', test, body: statement() };
    }
    if (word === 'do') {
      next();
      const body = statement();
      if (!isWord('while')) fail('Expected "while" after a do block');
      next(); expect('(');
      const test = expression();
      expect(')'); expect(';');
      return { k: 'do', body, test };
    }
    if (word === 'for') {
      next(); expect('(');
      let init = null;
      if (!isOp(';')) {
        init = token().type === 'ident' && ['int', 'str', 'bool'].includes(token().value)
          ? declaration() : { k: 'expr', value: expression() };
      }
      if (init?.k !== 'decl' && init?.k !== 'block') expect(';');
      const test = isOp(';') ? null : expression();
      expect(';');
      const step = isOp(')') ? null : expression();
      expect(')');
      return { k: 'for', init, test, step, body: statement() };
    }
    if (word === 'switch') {
      next(); expect('(');
      const disc = expression();
      expect(')'); expect('{');
      const cases = [];
      let current = null;
      while (!isOp('}')) {
        if (token().type === 'eof') fail('Unclosed switch');
        if (isWord('case')) {
          next();
          current = { value: expression(), body: [] };
          expect(':');
          cases.push(current);
          continue;
        }
        if (isWord('default')) {
          next(); expect(':');
          current = { value: null, body: [] };
          cases.push(current);
          continue;
        }
        if (!current) fail('A switch needs a case before its statements');
        current.body.push(statement());
      }
      expect('}');
      return { k: 'switch', disc, cases };
    }
    if (word === 'break') { next(); expect(';'); return { k: 'break' }; }
    if (word === 'continue') { next(); expect(';'); return { k: 'continue' }; }
    if (word === 'return') {
      next();
      const value = isOp(';') ? null : expression();
      expect(';');
      return { k: 'return', value };
    }
    if (['restart', 'suspend', 'terminate'].includes(word)
      && token(1).type === 'op' && token(1).value === ';') {
      at += 2;
      return { k: 'control', kind: word };
    }
    if (['int', 'str', 'bool'].includes(word) && token(1).type === 'ident') return declaration();
    const value = expression();
    expect(';');
    return { k: 'expr', value };
  }

  function script() {
    const start = next();
    let number = null, name = null;
    if (token().type === 'number') number = next().value;
    else if (token().type === 'string') name = next().value;
    else fail('A script needs a number or a name');
    let kind = 'closed';
    const kindWord = token().type === 'ident' ? token().value.toUpperCase() : '';
    if (SCRIPT_TYPES[kindWord]) { kind = SCRIPT_TYPES[kindWord]; next(); }
    const args = isOp('(') ? params() : [];
    return { k: 'script', number, name, type: kind, params: args, body: block(), line: start.line };
  }

  function fn() {
    const start = next();
    const returns = type() ?? 'void';
    const name = expectName();
    const args = params();
    return { k: 'function', name, returns, params: args, body: block(), line: start.line };
  }

  function globalVariable() {
    const scope = next().value;
    const valueType = type() ?? 'int';
    if (token().type !== 'number') fail(`${scope} variables need an index, as in ${scope} int 0:name;`);
    const index = next().value;
    expect(':');
    const name = expectName();
    let size = null;
    if (isOp('[')) { next(); size = expression(); expect(']'); }
    expect(';');
    return { k: 'global', scope, type: valueType, index, name, size };
  }

  const program = { scripts: [], functions: [], globals: [] };
  while (token().type !== 'eof') {
    const word = token().type === 'ident' ? token().value : '';
    if (word === 'script') program.scripts.push(script());
    else if (word === 'function') program.functions.push(fn());
    else if ((word === 'world' || word === 'global') && token(1).type === 'ident') program.globals.push(globalVariable());
    else fail(`Expected a script, a function or a definition but found "${token().value || 'end of file'}"`);
  }
  return program;
}

/** The structure of a source file, without compiling it. Used by the editor and by tests. */
export function parseAcsSource(text) {
  const warnings = [];
  return { ...parseTokens(preprocess(text, warnings)), warnings };
}

/* ------------------------------------------------------------------ */
/* Compiling                                                           */
/* ------------------------------------------------------------------ */

/** The builtins that leave an answer on the stack; everything else is used as a statement. */
const VALUE_BUILTINS = new Set([
  'checkinventory', 'checkweapon', 'setweapon', 'spawn', 'spawnspot', 'spawnspotfacing', 'spawnprojectile',
  'thingdamage2', 'getactorproperty', 'getactorx', 'getactory', 'getactorz', 'getactorangle', 'getactorpitch',
  'getactorfloorz', 'getactorceilingz', 'getactorlightlevel', 'getsectorfloorz', 'getsectorceilingz',
  'getsectorlightlevel', 'thingcount', 'thingcountname', 'timer', 'random', 'getcvar', 'sin', 'cos',
  'vectorangle', 'fixedmul', 'fixeddiv', 'playernumber', 'activatortid', 'playercount', 'gametype',
  'gameskill', 'getscreenwidth', 'getscreenheight', 'setactorposition',
]);

const BINARY_OPCODE = {
  '+': 'ADD', '-': 'SUBTRACT', '*': 'MULTIPLY', '/': 'DIVIDE', '%': 'MODULUS',
  '==': 'EQ', '!=': 'NE', '<': 'LT', '>': 'GT', '<=': 'LE', '>=': 'GE',
  '&': 'ANDBITWISE', '|': 'ORBITWISE', '^': 'EORBITWISE', '<<': 'LSHIFT', '>>': 'RSHIFT',
};

const COMPOUND = {
  '+=': 'ADD', '-=': 'SUB', '*=': 'MUL', '/=': 'DIV', '%=': 'MOD', '&=': 'AND', '|=': 'OR',
  '^=': 'EOR', '<<=': 'LS', '>>=': 'RS',
};

const STORE = {
  script: { ASSIGN: 'ASSIGNSCRIPTVAR', ADD: 'ADDSCRIPTVAR', SUB: 'SUBSCRIPTVAR', MUL: 'MULSCRIPTVAR',
    DIV: 'DIVSCRIPTVAR', MOD: 'MODSCRIPTVAR', AND: 'ANDSCRIPTVAR', EOR: 'EORSCRIPTVAR', OR: 'ORSCRIPTVAR',
    LS: 'LSSCRIPTVAR', RS: 'RSSCRIPTVAR', INC: 'INCSCRIPTVAR', DEC: 'DECSCRIPTVAR' },
  world: { ASSIGN: 'ASSIGNWORLDVAR', ADD: 'ADDWORLDVAR', SUB: 'SUBWORLDVAR', MUL: 'MULWORLDVAR',
    DIV: 'DIVWORLDVAR', MOD: 'MODWORLDVAR', AND: 'ANDWORLDVAR', EOR: 'EORWORLDVAR', OR: 'ORWORLDVAR',
    LS: 'LSWORLDVAR', RS: 'RSWORLDVAR', INC: 'INCWORLDVAR', DEC: 'DECWORLDVAR' },
  global: { ASSIGN: 'ASSIGNGLOBALVAR', ADD: 'ADDGLOBALVAR', SUB: 'SUBGLOBALVAR', MUL: 'MULGLOBALVAR',
    DIV: 'DIVGLOBALVAR', MOD: 'MODGLOBALVAR', AND: 'ANDGLOBALVAR', EOR: 'EORGLOBALVAR', OR: 'ORGLOBALVAR',
    LS: 'LSGLOBALVAR', RS: 'RSGLOBALVAR', INC: 'INCGLOBALVAR', DEC: 'DECGLOBALVAR' },
  map: { ASSIGN: 'ASSIGNMAPVAR', ADD: 'ADDMAPVAR', SUB: 'SUBMAPVAR', MUL: 'MULMAPVAR', DIV: 'DIVMAPVAR',
    MOD: 'MODMAPVAR', AND: 'ANDMAPVAR', EOR: 'EORMAPVAR', OR: 'ORMAPVAR', LS: 'LSMAPVAR', RS: 'RSMAPVAR',
    INC: 'INCMAPVAR', DEC: 'DECMAPVAR' },
};

const ARRAY_STORE = {
  script: { ASSIGN: 'ASSIGNSCRIPTARRAY', ADD: 'ADDSCRIPTARRAY', SUB: 'SUBTRACTSCRIPTARRAY',
    MUL: 'MULSCRIPTARRAY', DIV: 'DIVSCRIPTARRAY', MOD: 'MODSCRIPTARRAY', AND: 'ANDSCRIPTARRAY',
    EOR: 'EORSCRIPTARRAY', OR: 'ORSCRIPTARRAY', LS: 'LSSCRIPTARRAY', RS: 'RSSCRIPTARRAY',
    INC: 'INCSCRIPTARRAY', DEC: 'DECSCRIPTARRAY' },
  world: { ASSIGN: 'ASSIGNWORLDARRAY', ADD: 'ADDWORLDARRAY', SUB: 'SUBWORLDARRAY', MUL: 'MULWORLDARRAY',
    DIV: 'DIVWORLDARRAY', MOD: 'MODWORLDARRAY', AND: 'ANDWORLDARRAY', EOR: 'EORWORLDARRAY',
    OR: 'ORWORLDARRAY', LS: 'LSWORLDARRAY', RS: 'RSWORLDARRAY', INC: 'INCWORLDARRAY', DEC: 'DECWORLDARRAY' },
  global: { ASSIGN: 'ASSIGNGLOBALARRAY', ADD: 'ADDGLOBALARRAY', SUB: 'SUBGLOBALARRAY',
    MUL: 'MULGLOBALARRAY', DIV: 'DIVGLOBALARRAY', MOD: 'MODGLOBALARRAY', AND: 'ANDGLOBALARRAY',
    EOR: 'EORGLOBALARRAY', OR: 'ORGLOBALARRAY', LS: 'LSGLOBALARRAY', RS: 'RSGLOBALARRAY',
    INC: 'INCGLOBALARRAY', DEC: 'DECGLOBALARRAY' },
  map: { ASSIGN: 'ASSIGNMAPARRAY', ADD: 'ADDMAPARRAY', SUB: 'SUBMAPARRAY', MUL: 'MULMAPARRAY',
    DIV: 'DIVMAPARRAY', MOD: 'MODMAPARRAY', AND: 'ANDMAPARRAY', EOR: 'EORMAPARRAY', OR: 'ORMAPARRAY',
    LS: 'LSMAPARRAY', RS: 'RSMAPARRAY', INC: 'INCMAPARRAY', DEC: 'DECMAPARRAY' },
};

const PUSH_VAR = { script: 'PUSHSCRIPTVAR', world: 'PUSHWORLDVAR', global: 'PUSHGLOBALVAR', map: 'PUSHMAPVAR' };
const PUSH_ARRAY = { script: 'PUSHSCRIPTARRAY', world: 'PUSHWORLDARRAY', global: 'PUSHGLOBALARRAY', map: 'PUSHMAPARRAY' };

/** The level's own special table, as names a script can call. */
const SPECIALS = new Map();
for (const [index, name] of SPECIAL_NAMES.entries()) {
  if (!name || name === 'NOP' || SPECIALS.has(name)) continue;
  SPECIALS.set(name, index);
}

/**
 * Builtins that compile to "push the arguments in order, then run the opcode".
 *
 * `[opcode, minArgs, maxArgs, defaults]` — a missing optional argument is pushed as its
 * default, and the opcode is the one the interpreter already implements.
 */
const PLAIN = {
  setactorposition: ['SETACTORPOSITION', 4, 5, [null, null, null, null, 0]],
  setactorangle: ['SETACTORANGLE', 2, 2],
  setactorproperty: ['SETACTORPROPERTY', 3, 3],
  getactorproperty: ['GETACTORPROPERTY', 2, 2],
  getactorx: ['GETACTORX', 1, 1], getactory: ['GETACTORY', 1, 1], getactorz: ['GETACTORZ', 1, 1],
  getactorangle: ['GETACTORANGLE', 1, 1], getactorpitch: ['GETACTORPITCH', 1, 1],
  getactorfloorz: ['GETACTORFLOORZ', 1, 1], getactorceilingz: ['GETACTORCEILINGZ', 1, 1],
  getactorlightlevel: ['GETACTORLIGHTLEVEL', 1, 1],
  getsectorfloorz: ['GETSECTORFLOORZ', 3, 3], getsectorceilingz: ['GETSECTORCEILINGZ', 3, 3],
  getsectorlightlevel: ['GETSECTORLIGHTLEVEL', 1, 1],
  thingdamage2: ['THINGDAMAGE2', 2, 3, [null, null, 0]],
  sectordamage: ['SECTORDAMAGE', 2, 5, [null, null, 0, 0, 0]],
  fadeto: ['FADETO', 5, 5], fade: ['FADETO', 5, 5], faderange: ['FADERANGE', 9, 9],
  giveinventory: ['GIVEINVENTORY', 1, 2, [null, 1]], takeinventory: ['TAKEINVENTORY', 1, 2, [null, 1]],
  checkinventory: ['CHECKINVENTORY', 1, 1], clearinventory: ['CLEARINVENTORY', 0, 0],
  checkweapon: ['CHECKWEAPON', 1, 1], setweapon: ['SETWEAPON', 1, 1],
  spawn: ['SPAWN', 6, 6], spawnspot: ['SPAWNSPOT', 3, 4, [null, null, null, 0]],
  spawnspotfacing: ['SPAWNSPOTFACING', 3, 3], spawnprojectile: ['SPAWNPROJECTILE', 7, 7],
  thingsound: ['THINGSOUND', 3, 3], ambientsound: ['AMBIENTSOUND', 2, 2],
  localsound: ['LOCALAMBIENTSOUND', 2, 2], sectorsound: ['SECTORSOUND', 2, 2],
  activatorsound: ['ACTIVATORSOUND', 2, 2],
  changefloor: ['CHANGEFLOOR', 2, 2], changeceiling: ['CHANGECEILING', 2, 2],
  setlinetexture: ['SETLINETEXTURE', 4, 4], setlineblocking: ['SETLINEBLOCKING', 2, 2],
  setlinemonsterblocking: ['SETLINEMONSTERBLOCKING', 2, 2],
  replacetextures: ['REPLACETEXTURES', 2, 3, [null, null, 0]],
  setgravity: ['SETGRAVITY', 1, 1], setaircontrol: ['SETAIRCONTROL', 1, 1],
  setresultvalue: ['SETRESULTVALUE', 1, 1], changesky: ['CHANGESKY', 2, 2],
  getcvar: ['GETCVAR', 1, 1], sin: ['SIN', 1, 1], cos: ['COS', 1, 1], vectorangle: ['VECTORANGLE', 2, 2],
  fixedmul: ['FIXEDMUL', 2, 2], fixeddiv: ['FIXEDDIV', 2, 2], random: ['RANDOM', 2, 2],
  timer: ['TIMER', 0, 0], playernumber: ['PLAYERNUMBER', 0, 0], activatortid: ['ACTIVATORTID', 0, 0],
  playercount: ['PLAYERCOUNT', 0, 0], gametype: ['GAMETYPE', 0, 0], gameskill: ['GAMESKILL', 0, 0],
  getscreenwidth: ['GETSCREENWIDTH', 0, 0], getscreenheight: ['GETSCREENHEIGHT', 0, 0],
  musicchange: ['MUSICCHANGE', 2, 2],
  thingcount: ['THINGCOUNT', 2, 2], thingcountname: ['THINGCOUNTNAME', 2, 2],
  setfont: ['SETFONT', 1, 1], setstyle: ['SETSTYLE', 1, 1],
  sethudsize: ['SETHUDSIZE', 3, 3],
  setlinespecial: ['SETLINESPECIAL', 5, 7, [null, null, 0, 0, 0, 0, 0]],
  clearlinespecial: ['CLEARLINESPECIAL', 0, 0],
  cancelfade: ['CANCELFADE', 0, 0],
};

/** A short reference of the language, for the editor's help panel. */
export function acsBuiltinReference() {
  const builtins = [...new Set([...Object.keys(PLAIN),
    'print', 'printbold', 'log', 'printfixed', 'printname', 'hudmessage', 'hudmessagebold', 'delay', 'tagwait',
    'scriptwait', 'polywait', 'random', 'acs_execute', 'acs_executealways', 'acs_terminate', 'acs_suspend',
    'acs_executewithresult'])].sort();
  const specials = [...SPECIALS.keys()];
  return [
    'script <number> OPEN|ENTER|RESPAWN|DEATH|CLOSED|LIGHTNING|UNLOADING [(int a, ...)] { ... }',
    'script "name" OPEN { ... }            a named script',
    'function int name(int a) { return a; }',
    'world int 0:name;   global int 1:name;   world int 2:array[16];',
    '',
    'Statements: if/else, while, do..while, for, switch/case, break, continue, return,',
    '            restart; suspend; terminate;',
    'Values:      int, str, bool, arrays, + - * / % == != < > <= >= && || & | ^ << >> ~ ! ?:',
    '             fixed-point literals are 16.16: 1.0 is 65536, 0.5 is 32768',
    'Messages:    Print(s:"text", d:value), PrintBold(...), Log(...),',
    '             HudMessage(s:"text", type, id, color, x, y, hold[, fade])',
    '',
    `Builtins (${builtins.length}):`,
    `  ${builtins.join(', ')}`,
    '',
    `Line specials (${specials.length}) may be called by name, in linedef units:`,
    `  ${specials.join(', ')}`,
  ].join('\n');
}

/**
 * Compiles a source file into code the level's interpreter runs.
 *
 * `baseAddress` is the absolute lump offset the code will be written at (8 + the module's
 * existing data), `strings` and `functionNames` are the module's tables so a call into a
 * library keeps working, and `selector` names the script being replaced — a number or a name.
 */
export function compileAcsSource(text, { baseAddress = 8, strings = [], functionNames = [], selector = null } = {}) {
  const program = parseAcsSource(text);
  const warnings = [...program.warnings];
  const code = [];
  const table = [...strings];
  const stringIndex = new Map(strings.map((value, index) => [value, index]));
  const names = [...functionNames];
  const globals = new Map();
  const compiledFunctions = [];
  const compiledScripts = [];

  const intern = value => {
    if (stringIndex.has(value)) return stringIndex.get(value);
    const index = table.length;
    table.push(value);
    stringIndex.set(value, index);
    return index;
  };

  for (const declaration of program.globals) {
    if (globals.has(declaration.name)) throw new AcsSourceError(`"${declaration.name}" is declared twice`);
    globals.set(declaration.name, { scope: declaration.scope, index: declaration.index, size: declaration.size ? 1 : null });
  }

  for (const fn of program.functions) {
    if (names.includes(fn.name)) {
      // A function the module already has (an import's own, or a library's) keeps its slot; the
      // source's body replaces it, which is what editing an imported function means.
      continue;
    }
    names.push(fn.name);
  }

  const at = () => baseAddress + code.length;
  const byte = value => { code.push(value & 0xff); };
  const words = value => { byte(value); byte(value >> 8); byte(value >> 16); byte(value >> 24); };
  const opcode = name => {
    const value = OPCODE.get(name);
    if (value === undefined) throw new AcsSourceError(`The compiler does not know the instruction ${name}`);
    if (value >= 240) { byte(0xf0); byte(value - 240); } else byte(value);
  };
  const ins = name => opcode(name);
  const insB = (name, value) => { opcode(name); byte(value); };
  const insW = (name, value) => { opcode(name); words(value); };
  const pushConstant = value => {
    const number = value | 0;
    if (number >= 0 && number <= 0xff) insB('PUSHBYTE', number);
    else insW('PUSHNUMBER', number);
  };

  function constantValue(node) {
    if (!node) return null;
    switch (node.k) {
      case 'num': return node.v;
      case 'str': return intern(node.v);
      case 'id': return Object.hasOwn(CONSTANTS, node.name) ? CONSTANTS[node.name] : null;
      case 'un': {
        const inner = constantValue(node.e);
        if (inner === null) return null;
        return node.op === '-' ? (-inner) | 0 : node.op === '!' ? (inner ? 0 : 1) : node.op === '~' ? ~inner : inner;
      }
      case 'bin': {
        const a = constantValue(node.a), b = constantValue(node.b);
        if (a === null || b === null) return null;
        switch (node.op) {
          case '+': return (a + b) | 0;
          case '-': return (a - b) | 0;
          case '*': return Math.imul(a, b);
          case '/': return b === 0 ? null : Math.trunc(a / b) | 0;
          case '%': return b === 0 ? null : (a % b) | 0;
          case '<<': return a << b;
          case '>>': return a >> b;
          case '&': return a & b;
          case '|': return a | b;
          case '^': return a ^ b;
          default: return null;
        }
      }
      default: return null;
    }
  }

  /** One script or function: its labels, its locals, and where a break goes. */
  function unitFor(declaration, kind) {
    const locals = new Map();
    const arrays = new Map();
    let nextLocal = 0, nextTemp = 0;
    const scope = {
      name: declaration.name ?? String(declaration.number),
      returns: kind,
      args: declaration.params?.length ?? 0,
      label: null,
      labels: [],
      jumps: [],
      declare(name) {
        if (locals.has(name)) throw new AcsSourceError(`"${name}" is declared twice in this ${kind}`);
        const index = nextLocal++;
        locals.set(name, { scope: 'script', index, size: null });
        return index;
      },
      setSize(name, size) {
        const variable = locals.get(name);
        if (!variable) return;
        variable.size = size;
        if (!arrays.has(name)) { arrays.set(name, 0); }
      },
      lookup(name) {
        const local = locals.get(name);
        if (local) return local;
        const global = globals.get(name);
        return global || null;
      },
      get localCount() { return nextLocal; },
      /** A hidden local for a construct that needs somewhere to keep a value. */
      temporary() { let name = `$temp${nextTemp++}`; while (locals.has(name)) name = `$temp${nextTemp++}`; return name; },
      get arraySlots() { return arrays; },
    };
    for (const param of declaration.params ?? []) scope.declare(param.name);
    return scope;
  }

  let scope = null;

  function jumpTo(name, id) {
    opcode(name);
    const position = code.length;
    words(0);
    scope.jumps.push({ position, id });
  }

  function expr(node) {
    if (!node) { pushConstant(0); return; }
    switch (node.k) {
      case 'num': pushConstant(node.v); return;
      case 'str': pushConstant(intern(node.v)); return;
      case 'id': {
        const variable = scope.lookup(node.name);
        if (variable) {
          if (variable.size !== null) throw new AcsSourceError(`"${node.name}" is an array; index it, as in ${node.name}[0]`);
          insB(PUSH_VAR[variable.scope], variable.index);
          return;
        }
        if (Object.hasOwn(CONSTANTS, node.name)) { pushConstant(CONSTANTS[node.name]); return; }
        throw new AcsSourceError(`"${node.name}" is not a variable or a constant here`, node.line);
      }
      case 'index': {
        const variable = resolve(node.target);
        if (!variable || variable.size === null) throw new AcsSourceError('Only an array can be indexed');
        expr(node.index);
        insB(PUSH_ARRAY[variable.scope], variable.index);
        return;
      }
      case 'un': {
        if (node.op === '+') { expr(node.e); return; }
        expr(node.e);
        ins(node.op === '-' ? 'UNARYMINUS' : node.op === '!' ? 'NEGATELOGICAL' : 'NEGATEBINARY');
        return;
      }
      case 'bin': {
        if (node.op === '&&' || node.op === '||') { logical(node); return; }
        expr(node.a);
        expr(node.b);
        ins(BINARY_OPCODE[node.op]);
        return;
      }
      case 'cond': {
        expr(node.test);
        const otherwise = newLabel();
        jumpTo('IFNOTGOTO', otherwise);
        expr(node.yes);
        const done = newLabel();
        jumpTo('GOTO', done);
        place(otherwise);
        expr(node.no);
        place(done);
        return;
      }
      case 'post':
      case 'pre': {
        if (node.target.k !== 'index') {
          throw new AcsSourceError(`"${node.op}" changes a variable and has no value of its own here`);
        }
        const array = resolve(node.target.target);
        if (!array || array.size === null) throw new AcsSourceError('Only an array can be indexed');
        // The index is evaluated once into a hidden local, so `a[i++]++` still reads one element.
        const scratch = scope.declare(scope.temporary());
        expr(node.target.index);
        insB('ASSIGNSCRIPTVAR', scratch);
        const store = ARRAY_STORE[array.scope];
        if (node.k === 'pre') {
          insB('PUSHSCRIPTVAR', scratch);
          insB(store[node.op === '++' ? 'INC' : 'DEC'], array.index);
          insB('PUSHSCRIPTVAR', scratch);
          insB(PUSH_ARRAY[array.scope], array.index);
          return;
        }
        insB('PUSHSCRIPTVAR', scratch);
        insB(PUSH_ARRAY[array.scope], array.index);
        insB('PUSHSCRIPTVAR', scratch);
        insB(store[node.op === '++' ? 'INC' : 'DEC'], array.index);
        return;
      }
      case 'assign':
        throw new AcsSourceError('An assignment has no value of its own here');
      case 'call':
        if (!leavesValue(node)) throw new AcsSourceError(`${node.name} does not return a value`);
        return call(node);
      default: throw new AcsSourceError(`Cannot evaluate ${node.k}`);
    }
  }

  function storeIndexed(target, operator, valueNode) {
    const variable = resolve(target.target);
    if (!variable || variable.size === null) throw new AcsSourceError('Only an array element can be assigned this way');
    const kind = operator === '=' ? 'ASSIGN' : COMPOUND[operator];
    if (!kind || !ARRAY_STORE[variable.scope][kind]) {
      throw new AcsSourceError(`An array element cannot use "${operator}"`);
    }
    expr(target.index);
    expr(valueNode);
    insB(ARRAY_STORE[variable.scope][kind], variable.index);
  }

  function resolve(node) {
    if (!node || node.k !== 'id') return null;
    return scope.lookup(node.name);
  }

  /** Whether a call leaves a value, so a statement knows if it has one to drop. */
  function leavesValue(node) {
    if (node.k !== 'call') return true;
    const lower = node.name.toLowerCase();
    if (VALUE_BUILTINS.has(lower)) return true;
    if (lower === 'printname' || lower === 'printfixed') return false;
    if (['acs_execute', 'acs_executealways', 'acs_lockedexecute', 'acs_terminate', 'acs_suspend',
      'acs_executewithresult', 'acs_executealwayswithresult'].includes(lower)) return false;
    const declaration = program.functions.find(fn => fn.name === node.name);
    if (declaration) return declaration.returns !== 'void';
    return false;
  }

  /**
   * A statement whose whole job is a side effect: an assignment, an increment, or a call.
   *
   * `expr` always leaves a value, and a store is compiled without one on purpose — the
   * interpreter's store opcodes pop and push nothing — so the two are told apart here instead
   * of leaving a stale slot on the stack for a `DROP` to eat.
   */
  function exprStatement(node) {
    if (node.k === 'assign') {
      if (node.target.k === 'index') { storeIndexed(node.target, node.op, node.value); return; }
      const variable = resolve(node.target);
      if (!variable) throw new AcsSourceError(`Cannot assign to "${node.target.name ?? 'this'}"`);
      if (variable.size !== null) throw new AcsSourceError(`"${node.target.name}" is an array; assign one element`);
      const kind = node.op === '=' ? 'ASSIGN' : COMPOUND[node.op];
      if (!kind) throw new AcsSourceError(`Unknown assignment "${node.op}"`);
      expr(node.value);
      insB(STORE[variable.scope][kind], variable.index);
      return;
    }
    if (node.k === 'pre' || node.k === 'post') {
      const variable = resolve(node.target);
      if (!variable || variable.size !== null) throw new AcsSourceError('Only a variable can be incremented');
      insB(STORE[variable.scope][node.op === '++' ? 'INC' : 'DEC'], variable.index);
      return;
    }
    if (node.k === 'call') {
      if (leavesValue(node)) { expr(node); ins('DROP'); } else call(node);
      return;
    }
    expr(node);
    ins('DROP');
  }

  function logical(node) {
    // Short-circuit the way ACC evaluates it: the right side only runs when the left decides
    // nothing, and each test pops its own value, so the result is an explicit 0 or 1.
    const yes = newLabel(), no = newLabel(), done = newLabel();
    expr(node.a);
    jumpTo(node.op === '&&' ? 'IFNOTGOTO' : 'IFGOTO', node.op === '&&' ? no : yes);
    expr(node.b);
    jumpTo('IFNOTGOTO', no);
    place(yes);
    pushConstant(1);
    jumpTo('GOTO', done);
    place(no);
    pushConstant(0);
    place(done);
  }

  function newLabel() { scope.labels.push(null); return scope.labels.length - 1; }
  function place(id) { scope.labels[id] = code.length; }

  /** `s:`, `d:`, `f:` and `c:` — how ACS prints each part of a message. */
  function printPart(arg, opcodes) {
    const value = arg.value;
    if (arg.prefix === 'd') { expr(value); ins('PRINTNUMBER'); return; }
    if (arg.prefix === 'f') { expr(value); ins('PRINTFIXED'); return; }
    if (arg.prefix === 'c') { expr(value); ins('PRINTCHARACTER'); return; }
    if (arg.prefix === 's' || value.k === 'str') { expr(value); ins('PRINTSTRING'); return; }
    expr(value);
    ins(opcodes.number);
  }

  function print(call, end) {
    if (!call.args.length) throw new AcsSourceError(`${call.name} needs something to print`);
    ins('BEGINPRINT');
    for (const arg of call.args) printPart(arg, { number: 'PRINTNUMBER' });
    ins(end);
  }

  function hudMessage(call, end) {
    const [text, ...rest] = call.args;
    if (!text) throw new AcsSourceError(`${call.name} needs a message and six parameters`);
    for (let index = 0; index < 6; index++) {
      if (rest[index]) expr(rest[index].value);
      else pushConstant(0);
    }
    ins('OPTHUDMESSAGE');
    ins('BEGINPRINT');
    expr(text.value);
    ins('PRINTSTRING');
    ins(end);
  }

  function callSpecial(number, args, { result = false } = {}) {
    const list = [...args];
    if (result) {
      while (list.length < 5) list.push({ k: 'num', v: 0 });
      for (const node of list) expr(node);
      insB('LSPEC5RESULT', number);
      return;
    }
    if (!list.length) throw new AcsSourceError(`Line special ${number} needs arguments`);
    if (list.length > 5) throw new AcsSourceError(`Line special ${number} takes at most five arguments`);
    for (const node of list) expr(node);
    insB(`LSPEC${list.length}`, number);
  }

  function call(node) {
    const name = node.name;
    const args = node.args.map(arg => arg.value);
    const lower = name.toLowerCase();

    if (lower === 'print' || lower === 'printbold' || lower === 'log') {
      print(node, lower === 'printbold' ? 'ENDPRINTBOLD' : lower === 'log' ? 'ENDLOG' : 'ENDPRINT');
      return;
    }
    if (lower === 'hudmessage' || lower === 'hudmessagebold') {
      hudMessage(node, lower === 'hudmessagebold' ? 'ENDHUDMESSAGEBOLD' : 'ENDHUDMESSAGE');
      return;
    }
    if (lower === 'delay') {
      const value = constantValue(args[0]);
      if (value !== null && value >= 0 && value < 256) insB('DELAYDIRECTB', value);
      else { expr(args[0]); ins('DELAY'); }
      return;
    }
    if (lower === 'tagwait') {
      const value = constantValue(args[0]);
      if (value !== null) insW('TAGWAITDIRECT', value);
      else { expr(args[0]); ins('TAGWAIT'); }
      return;
    }
    if (lower === 'scriptwait') {
      const value = constantValue(args[0]);
      if (value !== null) insW('SCRIPTWAITDIRECT', value);
      else { expr(args[0]); ins('SCRIPTWAIT'); }
      return;
    }
    if (lower === 'polywait') { expr(args[0]); ins('POLYWAIT'); return; }
    if (lower === 'printname') { ins('BEGINPRINT'); expr(args[0]); ins('PRINTNAME'); ins('ENDPRINT'); return; }
    if (lower === 'printfixed') { ins('BEGINPRINT'); expr(args[0]); ins('PRINTFIXED'); ins('ENDPRINT'); return; }
    if (lower === 'random') {
      expr(args[0]); expr(args[1]); ins('RANDOM'); return;
    }
    if (lower === 'acs_executewithresult' || lower === 'acs_executealwayswithresult') {
      callSpecial(lower === 'acs_executealwayswithresult' ? 228 : 84, args, { result: true });
      return;
    }
    if (lower === 'acs_execute' || lower === 'acs_executealways' || lower === 'acs_lockedexecute') {
      const number = lower === 'acs_executealways' ? 226 : lower === 'acs_lockedexecute' ? 83 : 80;
      callSpecial(number, args);
      return;
    }
    if (lower === 'acs_terminate') { callSpecial(82, args); return; }
    if (lower === 'acs_suspend') { callSpecial(81, args); return; }

    const plain = PLAIN[lower];
    if (plain) {
      const [opcodeName, minimum, maximum, defaults = []] = plain;
      if (args.length < minimum || args.length > maximum) {
        throw new AcsSourceError(`${name} takes ${minimum === maximum ? minimum : `${minimum} to ${maximum}`}`
          + ` argument${maximum === 1 ? '' : 's'}, not ${args.length}`);
      }
      for (let index = 0; index < maximum; index++) {
        if (args[index]) expr(args[index]);
        else pushConstant(defaults[index] ?? 0);
      }
      ins(opcodeName);
      return;
    }

    const special = SPECIALS.get(name);
    if (special !== undefined) { callSpecial(special, args); return; }

    const index = names.indexOf(name);
    if (index < 0) {
      throw new AcsSourceError(`"${name}" is not a builtin, a line special or a function in this file`, node.line);
    }
    const declared = program.functions.some(fn => fn.name === name);
    for (const argument of args) expr(argument);
    // A function this file does not declare comes from the module or a library: its return type
    // is not written anywhere a compiler can read, so a call used as a statement discards it.
    insB(declared ? 'CALL' : 'CALLDISCARD', index);
  }

  function statement(node, flow) {
    switch (node.k) {
      case 'empty': return;
      case 'block': for (const child of node.body) statement(child, flow); return;
      case 'decl': {
        const index = scope.declare(node.name);
        if (node.size) {
          const size = constantValue(node.size);
          if (size === null || size <= 0) throw new AcsSourceError(`"${node.name}" needs a constant size`);
          scope.setSize(node.name, size);
        }
        if (node.value) {
          expr(node.value);
          insB('ASSIGNSCRIPTVAR', index);
        }
        return;
      }
      case 'expr': exprStatement(node.value); return;
      case 'if': {
        expr(node.test);
        const otherwise = newLabel();
        jumpTo('IFNOTGOTO', otherwise);
        statement(node.then, flow);
        if (!node.else) { place(otherwise); return; }
        const done = newLabel();
        jumpTo('GOTO', done);
        place(otherwise);
        statement(node.else, flow);
        place(done);
        return;
      }
      case 'while': {
        const start = newLabel(), done = newLabel();
        place(start);
        expr(node.test);
        jumpTo('IFNOTGOTO', done);
        statement(node.body, { breaks: [...flow.breaks, done], continues: [...flow.continues, start] });
        jumpTo('GOTO', start);
        place(done);
        return;
      }
      case 'do': {
        const start = newLabel(), test = newLabel(), done = newLabel();
        place(start);
        statement(node.body, { breaks: [...flow.breaks, done], continues: [...flow.continues, test] });
        place(test);
        expr(node.test);
        jumpTo('IFGOTO', start);
        place(done);
        return;
      }
      case 'for': {
        const start = newLabel(), step = newLabel(), done = newLabel();
        if (node.init) statement(node.init, flow);
        place(start);
        if (node.test) { expr(node.test); jumpTo('IFNOTGOTO', done); }
        statement(node.body, { breaks: [...flow.breaks, done], continues: [...flow.continues, step] });
        place(step);
        if (node.step) exprStatement(node.step);
        jumpTo('GOTO', start);
        place(done);
        return;
      }
      case 'switch': {
        const scratch = scope.declare(scope.temporary());
        expr(node.disc);
        insB('ASSIGNSCRIPTVAR', scratch);
        const done = newLabel();
        const targets = node.cases.map(() => newLabel());
        node.cases.forEach((entry, index) => {
          if (!entry.value) return;
          insB('PUSHSCRIPTVAR', scratch);
          expr(entry.value);
          ins('EQ');
          jumpTo('IFGOTO', targets[index]);
        });
        const fallback = node.cases.findIndex(entry => !entry.value);
        jumpTo('GOTO', fallback >= 0 ? targets[fallback] : done);
        node.cases.forEach((entry, index) => {
          place(targets[index]);
          statement({ k: 'block', body: entry.body }, { breaks: [...flow.breaks, done], continues: flow.continues });
        });
        place(done);
        return;
      }
      case 'break': {
        const target = flow.breaks[flow.breaks.length - 1];
        if (target === undefined) throw new AcsSourceError('"break" outside a loop or switch');
        jumpTo('GOTO', target);
        return;
      }
      case 'continue': {
        const target = flow.continues[flow.continues.length - 1];
        if (target === undefined) throw new AcsSourceError('"continue" outside a loop');
        jumpTo('GOTO', target);
        return;
      }
      case 'return': {
        if (scope.returns === 'function') {
          if (node.value) { expr(node.value); ins('RETURNVAL'); }
          else ins('RETURNVOID');
          return;
        }
        // A `return` inside a script ends it, which is what ACC does with the same word.
        ins('TERMINATE');
        return;
      }
      case 'control': {
        ins(node.kind === 'restart' ? 'RESTART' : node.kind === 'suspend' ? 'SUSPEND' : 'TERMINATE');
        return;
      }
      default: throw new AcsSourceError(`Cannot compile ${node.k}`);
    }
  }

  function beginUnit(declaration, kind) {
    scope = unitFor(declaration, kind);
    return { address: null, declaration };
  }

  function finishUnit(unit, { returns = false } = {}) {
    for (const entry of scope.jumps) {
      const target = scope.labels[entry.id];
      if (target === null || target === undefined) throw new AcsSourceError('Internal: a jump has no target');
      const value = baseAddress + target;
      code[entry.position] = value & 0xff;
      code[entry.position + 1] = (value >> 8) & 0xff;
      code[entry.position + 2] = (value >> 16) & 0xff;
      code[entry.position + 3] = (value >> 24) & 0xff;
    }
    // A body that runs off its end returns nothing rather than falling into whatever follows.
    if (returns) ins('RETURNVOID');
    else ins('TERMINATE');
    const compiled = { address: unit.address, localCount: scope.localCount - (unit.declaration.params?.length ?? 0) };
    return compiled;
  }

  for (const declaration of program.functions) {
    const unit = beginUnit(declaration, 'function');
    unit.address = at();
    statement(declaration.body, { breaks: [], continues: [] });
    const compiled = finishUnit(unit, { returns: true });
    compiledFunctions.push({
      name: declaration.name,
      index: names.indexOf(declaration.name),
      argCount: declaration.params.length,
      localCount: Math.max(0, compiled.localCount),
      returns: declaration.returns !== 'void',
      address: unit.address,
    });
  }

  const selected = [];
  for (const declaration of program.scripts) {
    const key = declaration.name ?? String(declaration.number);
    if (selector !== null && selector !== undefined && String(selector) !== key
      && String(selector) !== String(declaration.number)) continue;
    selected.push(declaration);
  }
  if (selector !== null && selector !== undefined && !program.scripts.length) {
    throw new AcsSourceError('There is no script in this file to compile');
  }
  if (!selected.length) {
    throw new AcsSourceError(`There is no script ${selector} in this file`);
  }
  for (const declaration of selected) {
    const unit = beginUnit(declaration, 'script');
    unit.address = at();
    statement(declaration.body, { breaks: [], continues: [] });
    finishUnit(unit);
    compiledScripts.push({
      key: declaration.name ?? String(declaration.number),
      number: declaration.number ?? null,
      name: declaration.name ?? null,
      type: declaration.type,
      argCount: declaration.params.length,
      varCount: Math.max(20, scope.localCount),
      address: unit.address,
    });
  }

  return { code, strings: table, functionNames: names, scripts: compiledScripts,
    functions: compiledFunctions, warnings, program };
}
