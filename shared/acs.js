/**
 * ACS — Hexen's scripting language, in the bytecode form GZDoom executes.
 *
 * A map's `BEHAVIOR` lump is not source code: ACC compiles scripts to a stack
 * machine (the "p-code" list in GZDoom's `p_acs.cpp`) with a chunked directory
 * for script numbers, names, functions, arrays and the string table. This module
 * parses that module, disassembles it for the editor, and interprets it at the
 * same 35 Hz tic rate Doom uses, so imported maps run their real scripts instead
 * of a hand-translated approximation.
 *
 * Values are 32-bit integers; fixed-point numbers are integers scaled by 65536,
 * exactly as in ACS 1.x. Strings are indexes into the module's string table.
 */

const ACS_MAGIC = [0x41, 0x43, 0x53];

/** Opcode mnemonics in declaration order, which is also their numeric value. */
const PCODE_NAMES = (`
  NOP TERMINATE SUSPEND PUSHNUMBER LSPEC1 LSPEC2 LSPEC3 LSPEC4 LSPEC5 LSPEC1DIRECT LSPEC2DIRECT LSPEC3DIRECT
  LSPEC4DIRECT LSPEC5DIRECT ADD SUBTRACT MULTIPLY DIVIDE MODULUS EQ NE LT GT LE GE ASSIGNSCRIPTVAR ASSIGNMAPVAR
  ASSIGNWORLDVAR PUSHSCRIPTVAR PUSHMAPVAR PUSHWORLDVAR ADDSCRIPTVAR ADDMAPVAR ADDWORLDVAR SUBSCRIPTVAR SUBMAPVAR
  SUBWORLDVAR MULSCRIPTVAR MULMAPVAR MULWORLDVAR DIVSCRIPTVAR DIVMAPVAR DIVWORLDVAR MODSCRIPTVAR MODMAPVAR
  MODWORLDVAR INCSCRIPTVAR INCMAPVAR INCWORLDVAR DECSCRIPTVAR DECMAPVAR DECWORLDVAR GOTO IFGOTO DROP DELAY
  DELAYDIRECT RANDOM RANDOMDIRECT THINGCOUNT THINGCOUNTDIRECT TAGWAIT TAGWAITDIRECT POLYWAIT POLYWAITDIRECT
  CHANGEFLOOR CHANGEFLOORDIRECT CHANGECEILING CHANGECEILINGDIRECT RESTART ANDLOGICAL ORLOGICAL ANDBITWISE
  ORBITWISE EORBITWISE NEGATELOGICAL LSHIFT RSHIFT UNARYMINUS IFNOTGOTO LINESIDE SCRIPTWAIT SCRIPTWAITDIRECT
  CLEARLINESPECIAL CASEGOTO BEGINPRINT ENDPRINT PRINTSTRING PRINTNUMBER PRINTCHARACTER PLAYERCOUNT GAMETYPE
  GAMESKILL TIMER SECTORSOUND AMBIENTSOUND SOUNDSEQUENCE SETLINETEXTURE SETLINEBLOCKING SETLINESPECIAL
  THINGSOUND ENDPRINTBOLD ACTIVATORSOUND LOCALAMBIENTSOUND SETLINEMONSTERBLOCKING PLAYERBLUESKULL PLAYERREDSKULL
  PLAYERYELLOWSKULL PLAYERMASTERSKULL PLAYERBLUECARD PLAYERREDCARD PLAYERYELLOWCARD PLAYERMASTERCARD
  PLAYERBLACKSKULL PLAYERSILVERSKULL PLAYERGOLDSKULL PLAYERBLACKCARD PLAYERSILVERCARD ISNETWORKGAME PLAYERTEAM
  PLAYERHEALTH PLAYERARMORPOINTS PLAYERFRAGS PLAYEREXPERT BLUETEAMCOUNT REDTEAMCOUNT BLUETEAMSCORE REDTEAMSCORE
  ISONEFLAGCTF LSPEC6 LSPEC6DIRECT PRINTNAME MUSICCHANGE CONSOLECOMMANDDIRECT CONSOLECOMMAND SINGLEPLAYER
  FIXEDMUL FIXEDDIV SETGRAVITY SETGRAVITYDIRECT SETAIRCONTROL SETAIRCONTROLDIRECT CLEARINVENTORY GIVEINVENTORY
  GIVEINVENTORYDIRECT TAKEINVENTORY TAKEINVENTORYDIRECT CHECKINVENTORY CHECKINVENTORYDIRECT SPAWN SPAWNDIRECT
  SPAWNSPOT SPAWNSPOTDIRECT SETMUSIC SETMUSICDIRECT LOCALSETMUSIC LOCALSETMUSICDIRECT PRINTFIXED PRINTLOCALIZED
  MOREHUDMESSAGE OPTHUDMESSAGE ENDHUDMESSAGE ENDHUDMESSAGEBOLD SETSTYLE SETSTYLEDIRECT SETFONT SETFONTDIRECT
  PUSHBYTE LSPEC1DIRECTB LSPEC2DIRECTB LSPEC3DIRECTB LSPEC4DIRECTB LSPEC5DIRECTB DELAYDIRECTB RANDOMDIRECTB
  PUSHBYTES PUSH2BYTES PUSH3BYTES PUSH4BYTES PUSH5BYTES SETTHINGSPECIAL ASSIGNGLOBALVAR PUSHGLOBALVAR
  ADDGLOBALVAR SUBGLOBALVAR MULGLOBALVAR DIVGLOBALVAR MODGLOBALVAR INCGLOBALVAR DECGLOBALVAR FADETO FADERANGE
  CANCELFADE PLAYMOVIE SETFLOORTRIGGER SETCEILINGTRIGGER GETACTORX GETACTORY GETACTORZ STARTTRANSLATION
  TRANSLATIONRANGE1 TRANSLATIONRANGE2 ENDTRANSLATION CALL CALLDISCARD RETURNVOID RETURNVAL PUSHMAPARRAY
  ASSIGNMAPARRAY ADDMAPARRAY SUBMAPARRAY MULMAPARRAY DIVMAPARRAY MODMAPARRAY INCMAPARRAY DECMAPARRAY DUP SWAP
  WRITETOINI GETFROMINI SIN COS VECTORANGLE CHECKWEAPON SETWEAPON TAGSTRING PUSHWORLDARRAY ASSIGNWORLDARRAY
  ADDWORLDARRAY SUBWORLDARRAY MULWORLDARRAY DIVWORLDARRAY MODWORLDARRAY INCWORLDARRAY DECWORLDARRAY
  PUSHGLOBALARRAY ASSIGNGLOBALARRAY ADDGLOBALARRAY SUBGLOBALARRAY MULGLOBALARRAY DIVGLOBALARRAY MODGLOBALARRAY
  INCGLOBALARRAY DECGLOBALARRAY SETMARINEWEAPON SETACTORPROPERTY GETACTORPROPERTY PLAYERNUMBER ACTIVATORTID
  SETMARINESPRITE GETSCREENWIDTH GETSCREENHEIGHT THING_PROJECTILE2 STRLEN SETHUDSIZE GETCVAR CASEGOTOSORTED
  SETRESULTVALUE GETLINEROWOFFSET GETACTORFLOORZ GETACTORANGLE GETSECTORFLOORZ GETSECTORCEILINGZ LSPEC5RESULT
  GETSIGILPIECES GETLEVELINFO CHANGESKY PLAYERINGAME PLAYERISBOT SETCAMERATOTEXTURE ENDLOG GETAMMOCAPACITY
  SETAMMOCAPACITY PRINTMAPCHARARRAY PRINTWORLDCHARARRAY PRINTGLOBALCHARARRAY SETACTORANGLE GRABINPUT
  SETMOUSEPOINTER MOVEMOUSEPOINTER SPAWNPROJECTILE GETSECTORLIGHTLEVEL GETACTORCEILINGZ SETACTORPOSITION
  CLEARACTORINVENTORY GIVEACTORINVENTORY TAKEACTORINVENTORY CHECKACTORINVENTORY THINGCOUNTNAME SPAWNSPOTFACING
  PLAYERCLASS ANDSCRIPTVAR ANDMAPVAR ANDWORLDVAR ANDGLOBALVAR ANDMAPARRAY ANDWORLDARRAY ANDGLOBALARRAY
  EORSCRIPTVAR EORMAPVAR EORWORLDVAR EORGLOBALVAR EORMAPARRAY EORWORLDARRAY EORGLOBALARRAY ORSCRIPTVAR ORMAPVAR
  ORWORLDVAR ORGLOBALVAR ORMAPARRAY ORWORLDARRAY ORGLOBALARRAY LSSCRIPTVAR LSMAPVAR LSWORLDVAR LSGLOBALVAR
  LSMAPARRAY LSWORLDARRAY LSGLOBALARRAY RSSCRIPTVAR RSMAPVAR RSWORLDVAR RSGLOBALVAR RSMAPARRAY RSWORLDARRAY
  RSGLOBALARRAY GETPLAYERINFO CHANGELEVEL SECTORDAMAGE REPLACETEXTURES NEGATEBINARY GETACTORPITCH SETACTORPITCH
  PRINTBIND SETACTORSTATE THINGDAMAGE2 USEINVENTORY USEACTORINVENTORY CHECKACTORCEILINGTEXTURE
  CHECKACTORFLOORTEXTURE GETACTORLIGHTLEVEL SETMUGSHOTSTATE THINGCOUNTSECTOR THINGCOUNTNAMESECTOR
  CHECKPLAYERCAMERA MORPHACTOR UNMORPHACTOR GETPLAYERINPUT CLASSIFYACTOR PRINTBINARY PRINTHEX CALLFUNC
  SAVESTRING PRINTMAPCHRANGE PRINTWORLDCHRANGE PRINTGLOBALCHRANGE STRCPYTOMAPCHRANGE STRCPYTOWORLDCHRANGE
  STRCPYTOGLOBALCHRANGE PUSHFUNCTION CALLSTACK SCRIPTWAITNAMED TRANSLATIONRANGE3 GOTOSTACK ASSIGNSCRIPTARRAY
  PUSHSCRIPTARRAY ADDSCRIPTARRAY SUBSCRIPTARRAY MULSCRIPTARRAY DIVSCRIPTARRAY MODSCRIPTARRAY INCSCRIPTARRAY
  DECSCRIPTARRAY ANDSCRIPTARRAY EORSCRIPTARRAY ORSCRIPTARRAY LSSCRIPTARRAY RSSCRIPTARRAY PRINTSCRIPTCHARARRAY
  PRINTSCRIPTCHRANGE STRCPYTOSCRIPTCHRANGE LSPEC5EX LSPEC5EXRESULT TRANSLATIONRANGE4 TRANSLATIONRANGE5
`).trim().split(/\s+/);

const P = Object.fromEntries(PCODE_NAMES.map((name, code) => [name, code]));

/** ACS script types, indexed by the type byte in the script directory. */
export const SCRIPT_KINDS = ['closed', 'open', 'respawn', 'death', 'enter', 'pickup', 'blueReturn', 'redReturn',
  'whiteReturn', 'unknown', 'unknown', 'unknown', 'lightning', 'unloading', 'disconnect', 'return', 'event', 'kill',
  'reopen'];

/** Line specials that only make sense as ACS calls. */
export const ACS_SPECIALS = {
  80: 'ACS_Execute', 81: 'ACS_Suspend', 82: 'ACS_Terminate', 83: 'ACS_LockedExecute', 84: 'ACS_ExecuteWithResult',
  85: 'ACS_LockedExecuteDoor', 226: 'ACS_ExecuteAlways', 228: 'ACS_ExecuteWithResultAlways',
};

const INT32 = value => value | 0;
const LITTLE_ENHANCED = 'little';

function text(bytes, start, length) {
  let result = '';
  for (let index = 0; index < length; index++) {
    const code = bytes[start + index];
    if (!code) break;
    result += String.fromCharCode(code);
  }
  return result;
}

/** C-style escape sequences inside an ACS string table entry. */
function unescape(source) {
  if (!source.includes('\\')) return source;
  let result = '';
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char !== '\\') { result += char; continue; }
    const next = source[++index];
    switch (next) {
      case 'n': result += '\n'; break;
      case 't': result += '\t'; break;
      case 'r': result += '\r'; break;
      case 'a': result += '\x07'; break;
      case 'b': result += '\b'; break;
      case 'f': result += '\f'; break;
      case 'v': result += '\v'; break;
      case 'x': {
        const hex = source.slice(index + 1, index + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) { result += String.fromCharCode(parseInt(hex, 16)); index += 2; }
        else result += 'x';
        break;
      }
      case undefined: result += '\\'; break;
      default:
        if (/[0-7]/.test(next)) {
          const octal = source.slice(index, index + 3).match(/^[0-7]{1,3}/)[0];
          result += String.fromCharCode(parseInt(octal, 8));
          index += octal.length - 1;
        } else result += next;
    }
  }
  return result;
}

/**
 * Parses a BEHAVIOR lump. Throws when the module is malformed, because a broken
 * script directory would otherwise silently disable every script on the map.
 */
export function parseBehavior(input) {
  const bytes = input instanceof Uint8Array ? input
    : input instanceof ArrayBuffer ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset ?? 0, input.byteLength ?? input.length ?? 0);
  if (bytes.length < 32) throw new Error('BEHAVIOR lump is truncated');
  if (ACS_MAGIC.some((value, index) => bytes[index] !== value)) throw new Error('BEHAVIOR lump is not an ACS module');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dirofs = view.getInt32(4, true);
  if (dirofs < 8 || dirofs > bytes.length) throw new Error('BEHAVIOR directory offset is out of range');
  let format;
  let chunkStart;
  let dataSize = bytes.length;
  let directory = dirofs;
  const tag = dirofs >= 4 ? text(bytes, dirofs - 4, 4) : '';
  if (bytes[3] === 0x65) format = LITTLE_ENHANCED;
  else if (bytes[3] === 0x45) format = 'enhanced';
  else if (bytes[3] === 0) {
    if (dirofs >= 24 && (tag === 'ACSe' || tag === 'ACSE')) {
      format = tag === 'ACSe' ? LITTLE_ENHANCED : 'enhanced';
      chunkStart = view.getInt32(dirofs - 8, true);
      dataSize = dirofs - 8;
      directory = dirofs;
    } else format = 'old';
  } else throw new Error('BEHAVIOR uses an unknown ACS version');

  const behavior = { format, bytes, view, dataSize, name: 'BEHAVIOR', strings: [], scripts: [],
    functions: [], functionNames: [], requiredLibraries: [], imports: [], jumps: [], mapVars: new Map() };
  if (format === 'old') {
    readOldDirectory(behavior, directory);
    readOldStrings(behavior);
    return behavior;
  }
  if (chunkStart < 8 || chunkStart > dataSize) throw new Error('BEHAVIOR chunk table is out of range');
  const chunks = readChunks(behavior, chunkStart);
  readScriptDirectory(behavior, chunks);
  readStrings(behavior, chunks);
  readFunctions(behavior, chunks);
  behavior.functionNames = readFunctionNames(behavior, chunks);
  behavior.requiredLibraries = readRequiredLibraries(behavior, chunks);
  const jump = chunks.get('JUMP');
  if (jump) for (let index = 0; index + 4 <= jump.length; index += 4) behavior.jumps.push(behavior.view.getInt32(jump.start + index, true));
  for (const mini of chunks.all.filter(chunk => chunk.id === 'MINI')) {
    const count = Math.trunc(mini.length / 4) - 1;
    const first = behavior.view.getInt32(mini.start, true);
    for (let index = 0; index < count; index++) {
      behavior.mapVars.set(first + index, behavior.view.getInt32(mini.start + 4 + index * 4, true));
    }
  }
  return behavior;
}

function readChunks(behavior, start) {
  const chunks = { all: [], get: id => chunks.all.find(chunk => chunk.id === id)?.data || null };
  const top = Math.min(behavior.dataSize, behavior.bytes.length);
  for (let offset = start; offset + 8 <= top;) {
    const id = text(behavior.bytes, offset, 4);
    const length = behavior.view.getInt32(offset + 4, true);
    if (length < 0 || offset + 8 + length > top) break;
    chunks.all.push({ id, start: offset + 8, length, data: { start: offset + 8, length } });
    offset += 8 + length;
  }
  return chunks;
}

function readScriptDirectory(behavior, chunks) {
  const chunk = chunks.get('SPTR');
  if (!chunk) return;
  const library = !(behavior.bytes[0] === 0x41 && behavior.bytes[1] === 0x43 && behavior.bytes[2] === 0x53 && behavior.bytes[3] === 0);
  const size = library ? 12 : 8;
  const count = Math.trunc(chunk.length / size);
  behavior.scripts = Array.from({ length: count }, (_, index) => {
    const at = chunk.start + index * size;
    if (library) {
      return { number: behavior.view.getInt16(at, true), type: behavior.view.getInt16(at + 2, true) & 0xff,
        argCount: behavior.view.getInt32(at + 4, true), address: behavior.view.getInt32(at + 8, true) };
    }
    return { number: behavior.view.getInt16(at, true), type: behavior.bytes[at + 2],
      argCount: behavior.bytes[at + 3], address: behavior.view.getInt32(at + 4, true) };
  });
  const flags = chunks.get('SFLG');
  if (flags) for (let index = 0; index + 4 <= flags.length; index += 4) {
    const number = behavior.view.getInt16(flags.start + index, true);
    const script = behavior.scripts.find(entry => entry.number === number);
    if (script) script.flags = behavior.view.getInt16(flags.start + index + 2, true);
  }
  const counts = chunks.get('SVCT');
  if (counts) for (let index = 0; index + 4 <= counts.length; index += 4) {
    const number = behavior.view.getInt16(counts.start + index, true);
    const script = behavior.scripts.find(entry => entry.number === number);
    if (script) script.varCount = behavior.view.getInt16(counts.start + index + 2, true);
  }
  const names = chunks.get('SNAM');
  if (names) {
    const countOfNames = behavior.view.getInt32(names.start, true);
    behavior.scripts.forEach(script => {
      if (script.number >= 0) return;
      const slot = -script.number - 1;
      if (slot >= countOfNames) return;
      const offset = behavior.view.getInt32(names.start + 4 + slot * 4, true);
      script.name = unescape(text(behavior.bytes, names.start + offset, 256));
    });
  }
  for (const script of behavior.scripts) {
    script.type = SCRIPT_KINDS[script.type] || 'unknown';
    script.varCount = script.varCount ?? 20;
  }
  behavior.scripts.sort((a, b) => a.number - b.number);
}

function readOldDirectory(behavior, dirofs) {
  const count = behavior.view.getInt32(dirofs, true);
  if (count < 0 || count > 4096) throw new Error('BEHAVIOR script directory is out of range');
  behavior.scripts = Array.from({ length: count }, (_, index) => {
    const at = dirofs + 4 + index * 12;
    if (at + 12 > behavior.bytes.length) throw new Error('BEHAVIOR script directory is truncated');
    const number = behavior.view.getInt32(at, true);
    return { number: number % 1000, type: SCRIPT_KINDS[Math.floor(number / 1000)] || 'unknown',
      argCount: behavior.view.getInt32(at + 8, true), address: behavior.view.getInt32(at + 4, true), varCount: 20 };
  });
  behavior.scripts.sort((a, b) => a.number - b.number);
}

function readOldStrings(behavior) {
  const directory = behavior.view.getInt32(4, true);
  const table = directory + behavior.view.getInt32(directory, true) * 12 + 4;
  if (table <= 0 || table + 4 > behavior.bytes.length) return;
  const count = behavior.view.getInt32(table, true);
  for (let index = 0; index < count; index++) {
    const offset = behavior.view.getInt32(table + 4 + index * 4, true);
    if (offset <= 0 || offset >= behavior.bytes.length) { behavior.strings.push(''); continue; }
    behavior.strings.push(unescape(text(behavior.bytes, offset, 65536)));
  }
}

function readStrings(behavior, chunks) {
  const encrypted = chunks.get('STRE');
  if (encrypted) {
    const bytes = behavior.bytes.slice(encrypted.start, encrypted.start + encrypted.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getInt32(4, true);
    for (let index = 0; index < count; index++) {
      const offset = view.getInt32(8 + index * 4, true);
      if (offset <= 0 || offset >= bytes.length) continue;
      const key = (offset * 157135) & 0xff;
      for (let cursor = offset; cursor < bytes.length; cursor++) {
        const value = bytes[cursor] ^ ((key + ((cursor - offset) >> 1)) & 0xff);
        bytes[cursor] = value;
        if (!value) break;
      }
    }
    readStringTable(behavior, bytes, view, 0);
    return;
  }
  const plain = chunks.get('STRL');
  if (plain) readStringTable(behavior, behavior.bytes, behavior.view, plain.start);
}

/** STRL layout: padding, count, one unused word, then byte offsets from `start`. */
function readStringTable(behavior, bytes, view, start) {
  const count = view.getInt32(start + 4, true);
  if (count < 0 || count > 100000) return;
  for (let index = 0; index < count; index++) {
    const offset = view.getInt32(start + 12 + index * 4, true);
    if (offset <= 0 || start + offset >= bytes.length) { behavior.strings.push(''); continue; }
    behavior.strings.push(unescape(text(bytes, start + offset, 65536)));
  }
}

/** Function names, so a module can import a function from a library by name. */
/** FNAM layout: a count, then offsets relative to the chunk, then the names. */
function readFunctionNames(behavior, chunks) {
  const chunk = chunks.get('FNAM');
  if (!chunk) return [];
  const count = behavior.view.getInt32(chunk.start, true);
  if (count < 0 || count > 100000) return [];
  const names = [];
  for (let index = 0; index < count; index++) {
    const offset = behavior.view.getInt32(chunk.start + 4 + index * 4, true);
    if (offset <= 0 || chunk.start + offset >= behavior.bytes.length) { names.push(''); continue; }
    names.push(text(behavior.bytes, chunk.start + offset, 1024));
  }
  return names;
}

/** `#include`d libraries this module calls functions from, in import order. */
function readRequiredLibraries(behavior, chunks) {
  const chunk = chunks.get('LOAD');
  if (!chunk) return [];
  const names = [];
  let current = '';
  for (let index = 0; index < chunk.length; index++) {
    const code = behavior.bytes[chunk.start + index];
    if (code) { current += String.fromCharCode(code); continue; }
    if (current) { names.push(current); current = ''; }
  }
  if (current) names.push(current);
  return names;
}

function readFunctions(behavior, chunks) {
  const chunk = chunks.get('FUNC');
  if (!chunk) return;
  const count = Math.trunc(chunk.length / 8);
  for (let index = 0; index < count; index++) {
    const at = chunk.start + index * 8;
    behavior.functions.push({ argCount: behavior.bytes[at], localCount: behavior.bytes[at + 1],
      returns: behavior.bytes[at + 2], importNum: behavior.bytes[at + 3], address: behavior.view.getInt32(at + 4, true) });
  }
}

/**
 * Every opcode this runtime understands, with its operand layout.
 * `b`, `s` and `w` mean a byte, a 16-bit and a 32-bit operand (each 4 bytes in
 * the pre-ZDoom ACS formats). `null` means the handler decodes its own operands.
 */
const OPS = new Map();

function define(code, spec, run) {
  OPS.set(code, { spec, run });
}

function run(vm, script) {
  const definition = OPS.get(vm.code);
  if (!definition) {
    vm.unsupported.add(PCODE_NAMES[vm.code] || `#${vm.code}`);
    return fail(vm, 'unsupported instruction');
  }
  return definition.run(vm, script);
}

function fail(vm, message) {
  vm.script.state = 'terminated';
  vm.errors.push(`${describeScript(vm.script)}: ${message}`);
}

function describeScript(script) {
  return script.name ? `script "${script.name}"` : `script ${script.number}`;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function decode(behavior, offset) {
  const bytes = behavior.bytes, little = behavior.format === LITTLE_ENHANCED;
  if (offset < 0 || offset >= bytes.length) return null;
  let code = little ? bytes[offset] : behavior.view.getInt32(offset, true);
  let cursor = offset + (little ? 1 : 4);
  if (little && code >= 0xf0) {
    code = 240 + (code - 240) * 256 + bytes[cursor];
    cursor++;
  }
  return { code, cursor };
}

function operands(behavior, cursor, spec) {
  const bytes = behavior.bytes, little = behavior.format === LITTLE_ENHANCED, values = [];
  let at = cursor;
  for (const kind of spec) {
    if (kind === 'w') { values.push(behavior.view.getInt32(at, true)); at += 4; continue; }
    if (!little) { values.push(behavior.view.getInt32(at, true)); at += 4; continue; }
    if (kind === 's') { values.push(behavior.view.getInt16(at, true)); at += 2; continue; }
    values.push(bytes[at]); at += 1;
  }
  return { values, end: at };
}

/** Decodes one instruction at an address, or null at the end of the module. */
export function instructionAt(behavior, offset) {
  const decoded = decode(behavior, offset);
  if (!decoded) return null;
  const definition = OPS.get(decoded.code);
  if (!definition) return { offset, code: decoded.code, name: PCODE_NAMES[decoded.code] || `#${decoded.code}`, operands: [], end: decoded.cursor, supported: false };
  if (definition.spec === null) return { offset, code: decoded.code, name: PCODE_NAMES[decoded.code], operands: [], end: null, supported: true, custom: definition };
  const { values, end } = operands(behavior, decoded.cursor, definition.spec);
  return { offset, code: decoded.code, name: PCODE_NAMES[decoded.code], operands: values, end, supported: true };
}

/**
 * A program is everything ACS can run on one level: the map's own BEHAVIOR
 * module first, then every `LOADACS` library in load order. GZDoom gives each
 * module its own script numbers, string table, functions and map variables, so
 * scripts are tracked with the module they came from.
 */
export function createProgram(entries = []) {
  const modules = entries.filter(Boolean).map((entry, index) => ({
    index,
    name: entry.name || (index === 0 ? 'BEHAVIOR' : `library${index}`),
    module: entry.module || parseBehavior(entry.bytes),
  }));
  for (const { name, module } of modules) module.name = name;
  const program = { modules, scripts: [], primary: modules[0]?.module ?? null };
  resolveFunctionImports(program);
  for (const { index, name, module } of modules) {
    for (const script of module.scripts) program.scripts.push({ ...script, moduleIndex: index, moduleName: name });
  }
  return program;
}

/**
 * A `#include`d library can declare a function it does not define, and libraries
 * imported by LOAD are searched in order for the real body — the same resolution
 * GZDoom performs when it loads a module.
 */
function resolveFunctionImports(program) {
  for (const { module } of program.modules) {
    module.imports = (module.requiredLibraries || []).map(name =>
      program.modules.find(candidate => candidate.name.toLowerCase() === name.toLowerCase())?.module ?? null);
    module.functions.forEach((fn, index) => {
      if (fn.address !== 0 || fn.importNum) return;
      const name = module.functionNames[index];
      if (!name) return;
      module.imports.forEach((library, importIndex) => {
        if (!library || fn.importNum) return;
        const target = library.functionNames.indexOf(name);
        if (target < 0) return;
        const real = library.functions[target];
        if (!real || real.address === 0 || real.importNum) return;
        fn.address = target;
        fn.importNum = importIndex + 1;
        fn.localCount = real.localCount;
        fn.returns = real.returns;
        fn.argCount = real.argCount;
      });
    });
  }
}

/** Follows an imported function to the module that really defines it. */
function resolveFunction(module, index) {
  let owner = module, fn = module.functions[index];
  const seen = new Set();
  while (fn?.importNum) {
    const key = `${owner.name}:${index}`;
    if (seen.has(key)) return null;
    seen.add(key);
    owner = owner.imports[fn.importNum - 1];
    if (!owner) return null;
    index = fn.address;
    fn = owner.functions[index];
  }
  // A declared-but-undefined function keeps address 0; running it would execute
  // the module header, so it is reported as missing instead.
  return fn && fn.address ? { module: owner, fn } : null;
}

const asProgram = value => value?.modules ? value : createProgram([value?.bytes ? { name: value.name, module: value } : null]);

/**
 * Disassembles a script, so the editor and MCP tools can show what a map's
 * scripts do without shipping a compiler.
 */
export function disassemble(program, selector, limit = 4000) {
  const container = asProgram(program);
  const script = findScript(container, selector);
  if (!script) throw new Error(`Unknown ACS script ${selector}`);
  const module = container.modules[script.moduleIndex].module;
  const lines = [];
  let offset = script.address;
  const seen = new Set();
  while (offset !== null && offset >= 0 && offset < module.dataSize && lines.length < limit) {
    if (seen.has(offset)) { lines.push(`${hexOffset(offset)}  ... loop`); break; }
    seen.add(offset);
    const instruction = instructionAt(module, offset);
    if (!instruction) break;
    lines.push(`${hexOffset(offset)}  ${formatInstruction(module, instruction)}`);
    if (!instruction.end) break;
    if (instruction.name === 'TERMINATE' || instruction.name === 'RETURNVOID' || instruction.name === 'RETURNVAL') break;
    offset = instruction.end;
  }
  return lines;
}

function hexOffset(value) {
  return value.toString(16).padStart(4, '0');
}

function formatInstruction(behavior, instruction) {
  if (!instruction.supported) return `${instruction.name} (unsupported)`;
  const parts = instruction.operands.map(value => String(value));
  if (instruction.name === 'PUSHSTRING' || instruction.name === 'PRINTSTRING') {
    const text = lookupString(behavior, instruction.operands[0]);
    if (text) parts[0] = `${instruction.operands[0]} "${text.replace(/"/g, '\\"')}"`;
  }
  return parts.length ? `${instruction.name} ${parts.join(', ')}` : instruction.name;
}

/**
 * Scripts are searched in load order: the map's own module first, then libraries.
 * A selector can be a number, a script name, or `library:number` to address a
 * library script whose number also exists in the map.
 */
export function findScript(program, selector) {
  if (!program) return null;
  const scripts = program.scripts;
  if (!scripts) return null;
  if (typeof selector === 'string') {
    const qualified = /^([^:]+):(-?\d+|[A-Za-z_]\w*)$/.exec(selector);
    if (qualified) {
      const library = qualified[1].toLowerCase(), target = qualified[2];
      return scripts.find(script => String(script.moduleName).toLowerCase() === library &&
        (/^-?\d+$/.test(target) ? script.number === Number(target) : script.name === target)) || null;
    }
    if (!/^-?\d+$/.test(selector)) return scripts.find(script => script.name === selector) || null;
    selector = Number(selector);
  }
  return scripts.find(script => script.number === selector) || null;
}

/** Doom button bits, as `GetPlayerInput(0, INPUT_BUTTONS)` reports them. */
export const BT = { ATTACK: 1 << 0, USE: 1 << 1, JUMP: 1 << 2, CROUCH: 1 << 3, TURN180: 1 << 4,
  ALTATTACK: 1 << 5, RELOAD: 1 << 6, ZOOM: 1 << 7, SPEED: 1 << 8, STRAFE: 1 << 9, MOVERIGHT: 1 << 10,
  MOVELEFT: 1 << 11, BACK: 1 << 12, FORWARD: 1 << 13, RIGHT: 1 << 14, LEFT: 1 << 15, LOOKUP: 1 << 16,
  LOOKDOWN: 1 << 17, MOVEUP: 1 << 18, MOVEDOWN: 1 << 19 };

/** Tag that marks a string interned into the shared pool by `TAGSTRING`. */
const POOL_TAG = 0x40000000;

/** Resolves a string operand: pool-tagged values first, then the active module. */
function vmString(vm, index) {
  if (!Number.isFinite(index)) return '';
  if ((index >>> 0) >= POOL_TAG) return vm.pool[index & 0xffff] ?? '';
  return lookupString(vm.module, index & 0xffff);
}

function internString(vm, text) {
  const existing = vm.poolIndex.get(text);
  if (existing !== undefined) return POOL_TAG | existing;
  const index = vm.pool.push(text) - 1;
  vm.poolIndex.set(text, index);
  return POOL_TAG | index;
}

/** String table lookup, tolerating the tagged indexes ACS uses for libraries. */
export function lookupString(behavior, index) {
  if (!behavior || !Number.isFinite(index)) return '';
  const value = behavior.strings[index & 0xffff];
  return value === undefined ? '' : value;
}

/**
 * Static pass over every script: reports the opcodes this runtime cannot run, so
 * an import can warn up front instead of failing the first time a script waits.
 */
export function scanBehavior(program) {
  const container = asProgram(program);
  const unsupported = new Set();
  let instructions = 0;
  let functions = 0;
  for (const script of container.scripts) {
    const behavior = container.modules[script.moduleIndex].module;
    let offset = script.address;
    const seen = new Set();
    while (offset >= 0 && offset < behavior.dataSize && !seen.has(offset)) {
      seen.add(offset);
      if (offset % 4 === 0 && behavior.jumps.includes(offset) && offset !== script.address) continue;
      const instruction = instructionAt(behavior, offset);
      if (!instruction) break;
      instructions++;
      if (!instruction.supported) { unsupported.add(instruction.name); break; }
      if (instruction.operands.length && (instruction.name === 'CALL' || instruction.name === 'CALLDISCARD')) functions++;
      if (instruction.end === null) break;
      if (instruction.name === 'TERMINATE' || instruction.name === 'RETURNVOID' || instruction.name === 'RETURNVAL') break;
      offset = instruction.end;
    }
  }
  return { unsupported: [...unsupported], instructions, functions };
}

/* ------------------------------------------------------------------ */
/* Interpreter                                                         */
/* ------------------------------------------------------------------ */

const STACK_LIMIT = 4096;
const VARIABLE_SCOPES = { SCRIPT: 'script', MAP: 'map', WORLD: 'world', GLOBAL: 'global' };
const VARIABLE_KINDS = ['ASSIGN', 'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'INC', 'DEC', 'AND', 'EOR', 'OR', 'LS', 'RS'];

/** Map variables and arrays are module-local, exactly as in GZMod's FBehavior. */
const moduleMapVars = (vm, index = vm.moduleIndex) => vm.mapVars[index] ||= new Int32Array(128);

function variableFor(vm, script, scope) {
  if (scope === 'script') return { get: index => script.locals[index] | 0, set: (index, value) => { script.locals[index] = value | 0; } };
  if (scope === 'map') {
    const store = moduleMapVars(vm);
    return { get: index => store[index] | 0, set: (index, value) => { store[index] = value | 0; } };
  }
  if (scope === 'world') return { get: index => vm.worldVars[index] | 0, set: (index, value) => { vm.worldVars[index] = value | 0; } };
  return { get: index => vm.globalVars[index] | 0, set: (index, value) => { vm.globalVars[index] = value | 0; } };
}

function arrayFor(vm, script, scope) {
  const bag = scope === 'script' ? vm.scriptArrays
    : scope === 'map' ? (vm.mapArrays[vm.moduleIndex] ||= new Map())
      : scope === 'world' ? vm.worldArrays : vm.globalArrays;
  return {
    get: (id, index) => bag.get(id)?.get(index) | 0,
    set: (id, index, value) => {
      let store = bag.get(id);
      if (!store) { store = new Map(); bag.set(id, store); }
      store.set(index, value | 0);
    },
  };
}

for (const [suffix, scope] of Object.entries(VARIABLE_SCOPES)) {
  define(P[`PUSH${suffix}VAR`], 'b', (vm, script, [index]) => push(vm, script, variableFor(vm, script, scope).get(index)));
  define(P[`PUSH${suffix}ARRAY`], 'b', (vm, script, [slot]) => {
    const target = arrayFor(vm, script, scope);
    push(vm, script, target.get(targetId(vm, script, scope, slot), pop(vm, script)));
  });
  for (const kind of VARIABLE_KINDS) {
    const scalarCode = P[`${kind}${suffix}VAR`];
    const arrayCode = P[`${kind}${suffix}ARRAY`];
    if (scalarCode !== undefined) {
      define(scalarCode, 'b', (vm, script, [index]) => {
        const target = variableFor(vm, script, scope);
        applyVariable(kind, target, index, vm, script);
      });
    }
    if (arrayCode !== undefined) {
      define(arrayCode, 'b', (vm, script, [slot]) => {
        const target = arrayFor(vm, script, scope);
        const id = targetId(vm, script, scope, slot);
        const index = pop(vm, script);
        if (kind === 'ASSIGN') {
          const value = pop(vm, script);
          target.set(id, index, value);
          return;
        }
        if (kind === 'INC' || kind === 'DEC') {
          target.set(id, index, target.get(id, index) + (kind === 'INC' ? 1 : -1));
          return;
        }
        const value = pop(vm, script);
        target.set(id, index, apply(kind, target.get(id, index), value));
      });
    }
  }
}

/** Map/world/global arrays are indexed by the *value* of a variable slot. */
function targetId(vm, script, scope, slot) {
  if (scope === 'script') return slot;
  return variableFor(vm, script, scope).get(slot);
}

function apply(kind, left, right) {
  switch (kind) {
    case 'ADD': return INT32(left + right);
    case 'SUB': return INT32(left - right);
    case 'MUL': return INT32(Math.imul(left, right));
    case 'DIV': return right === 0 ? 0 : INT32(Math.trunc(left / right));
    case 'MOD': return right === 0 ? 0 : INT32(left % right);
    case 'AND': return left & right;
    case 'EOR': return left ^ right;
    case 'OR': return left | right;
    case 'LS': return left << right;
    default: return left >> right;
  }
}

function applyVariable(kind, target, index, vm, script) {
  if (kind === 'ASSIGN') { target.set(index, pop(vm, script)); return; }
  if (kind === 'INC') { target.set(index, target.get(index) + 1); return; }
  if (kind === 'DEC') { target.set(index, target.get(index) - 1); return; }
  if ((kind === 'DIV' || kind === 'MOD') && peek(vm, script, 1) === 0) { fail(vm, 'division by zero'); return; }
  target.set(index, apply(kind, target.get(index), pop(vm, script)));
}

function push(vm, script, value) {
  if (script.sp >= STACK_LIMIT) { fail(vm, 'stack overflow'); return; }
  script.stack[script.sp++] = INT32(Number(value) || 0);
}

function pop(vm, script) {
  if (script.sp <= 0) { fail(vm, 'stack underflow'); return 0; }
  return script.stack[--script.sp];
}

/** 1-based access from the top of the stack, matching ACS's STACK(n). */
function peek(vm, script, depth) {
  return script.stack[script.sp - depth] | 0;
}

function setTop(vm, script, depth, value) {
  script.stack[script.sp - depth] = INT32(value);
}

/** Sector/line/thing actions needed by `LSPEC` opcodes, resolved through the host. */
function executeSpecial(vm, script, special, args, { result = false } = {}) {
  const value = vm.host.executeSpecial(special, args, { script, activator: script.activator, line: script.line, backSide: script.backSide });
  if (result) return INT32(value || 0);
  return 0;
}

function binary(vm, script, operation) {
  const right = pop(vm, script), left = pop(vm, script);
  push(vm, script, operation(left, right));
}

function defineArithmetic() {
  define(P.ADD, '', (vm, script) => binary(vm, script, (a, b) => INT32(a + b)));
  define(P.SUBTRACT, '', (vm, script) => binary(vm, script, (a, b) => INT32(a - b)));
  define(P.MULTIPLY, '', (vm, script) => binary(vm, script, (a, b) => Math.imul(a, b)));
  define(P.DIVIDE, '', (vm, script) => {
    const right = pop(vm, script), left = pop(vm, script);
    if (!right) { fail(vm, 'division by zero'); return; }
    push(vm, script, Math.trunc(left / right));
  });
  define(P.MODULUS, '', (vm, script) => {
    const right = pop(vm, script), left = pop(vm, script);
    if (!right) { fail(vm, 'modulus by zero'); return; }
    push(vm, script, left % right);
  });
  define(P.EQ, '', (vm, script) => binary(vm, script, (a, b) => (a === b ? 1 : 0)));
  define(P.NE, '', (vm, script) => binary(vm, script, (a, b) => (a !== b ? 1 : 0)));
  define(P.LT, '', (vm, script) => binary(vm, script, (a, b) => (a < b ? 1 : 0)));
  define(P.GT, '', (vm, script) => binary(vm, script, (a, b) => (a > b ? 1 : 0)));
  define(P.LE, '', (vm, script) => binary(vm, script, (a, b) => (a <= b ? 1 : 0)));
  define(P.GE, '', (vm, script) => binary(vm, script, (a, b) => (a >= b ? 1 : 0)));
  define(P.ANDLOGICAL, '', (vm, script) => binary(vm, script, (a, b) => (a && b ? 1 : 0)));
  define(P.ORLOGICAL, '', (vm, script) => binary(vm, script, (a, b) => (a || b ? 1 : 0)));
  define(P.ANDBITWISE, '', (vm, script) => binary(vm, script, (a, b) => a & b));
  define(P.ORBITWISE, '', (vm, script) => binary(vm, script, (a, b) => a | b));
  define(P.EORBITWISE, '', (vm, script) => binary(vm, script, (a, b) => a ^ b));
  define(P.LSHIFT, '', (vm, script) => binary(vm, script, (a, b) => a << b));
  define(P.RSHIFT, '', (vm, script) => binary(vm, script, (a, b) => a >> b));
  define(P.NEGATELOGICAL, '', (vm, script) => { setTop(vm, script, 1, peek(vm, script, 1) ? 0 : 1); });
  define(P.NEGATEBINARY, '', (vm, script) => { setTop(vm, script, 1, ~peek(vm, script, 1)); });
  define(P.UNARYMINUS, '', (vm, script) => { setTop(vm, script, 1, -peek(vm, script, 1)); });
  define(P.FIXEDMUL, '', (vm, script) => binary(vm, script, (a, b) => INT32(Number((BigInt(a) * BigInt(b)) >> 16n))));
  define(P.FIXEDDIV, '', (vm, script) => binary(vm, script, (a, b) => (b === 0 ? 0 : INT32(Number((BigInt(a) << 16n) / BigInt(b))))) );
  define(P.SIN, '', (vm, script) => {
    const angle = pop(vm, script);
    push(vm, script, Math.round(Math.sin(((angle & 0xffff) / 65536) * Math.PI * 2) * 65536));
  });
  define(P.COS, '', (vm, script) => {
    const angle = pop(vm, script);
    push(vm, script, Math.round(Math.cos(((angle & 0xffff) / 65536) * Math.PI * 2) * 65536));
  });
  define(P.VECTORANGLE, '', (vm, script) => {
    const y = pop(vm, script), x = pop(vm, script);
    push(vm, script, Math.round((Math.atan2(y, x) / (Math.PI * 2)) * 65536) & 0xffff);
  });
}

function defineStack() {
  define(P.NOP, '', () => {});
  define(P.TERMINATE, '', (vm, script) => { script.state = 'terminated'; });
  define(P.SUSPEND, '', (vm, script) => { script.state = 'suspended'; });
  define(P.PUSHNUMBER, 'w', (vm, script, [value]) => push(vm, script, value));
  define(P.PUSHBYTE, 'b', (vm, script, [value]) => push(vm, script, value));
  define(P.PUSHBYTES, null, (vm, script) => {
    const count = vm.module.bytes[vm.pc++];
    for (let index = 0; index < count; index++) push(vm, script, vm.module.bytes[vm.pc++]);
  });
  for (const count of [2, 3, 4, 5]) {
    define(P[`PUSH${count}BYTES`], 'b'.repeat(count), (vm, script, values) => values.forEach(value => push(vm, script, value)));
  }
  define(P.DUP, '', (vm, script) => push(vm, script, peek(vm, script, 1)));
  define(P.SWAP, '', (vm, script) => {
    const top = script.stack[script.sp - 1];
    script.stack[script.sp - 1] = script.stack[script.sp - 2];
    script.stack[script.sp - 2] = top;
  });
  define(P.DROP, '', (vm, script) => { pop(vm, script); });
  define(P.LINESIDE, '', (vm, script) => push(vm, script, script.backSide ? 1 : 0));
}

function defineFlow() {
  define(P.GOTO, 'w', (vm, script, [target]) => { vm.pc = target; });
  define(P.GOTOSTACK, '', (vm, script) => { vm.pc = vm.module.jumps[pop(vm, script)] ?? vm.pc; });
  define(P.IFGOTO, 'w', (vm, script, [target]) => { if (pop(vm, script)) vm.pc = target; });
  define(P.IFNOTGOTO, 'w', (vm, script, [target]) => { if (!pop(vm, script)) vm.pc = target; });
  define(P.CASEGOTO, 'ww', (vm, script, [value, target]) => { if (peek(vm, script, 1) === value) { pop(vm, script); vm.pc = target; } });
  define(P.CASEGOTOSORTED, null, (vm, script) => {
    let at = (vm.pc + 3) & ~3;
    const count = vm.module.view.getInt32(at, true);
    at += 4;
    const needle = peek(vm, script, 1);
    let low = 0, high = count - 1, found = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const value = vm.module.view.getInt32(at + middle * 8, true);
      if (value === needle) { found = vm.module.view.getInt32(at + middle * 8 + 4, true); break; }
      if (value < needle) low = middle + 1; else high = middle - 1;
    }
    if (found === null) vm.pc = at + count * 8;
    else { pop(vm, script); vm.pc = found; }
  });
  define(P.CALL, 'b', (vm, script, [index]) => callFunction(vm, script, index, false));
  define(P.CALLDISCARD, 'b', (vm, script, [index]) => callFunction(vm, script, index, true));
  define(P.RETURNVOID, '', (vm, script) => returnFromFunction(vm, script, 0));
  define(P.RETURNVAL, '', (vm, script) => returnFromFunction(vm, script, pop(vm, script)));
  define(P.SETRESULTVALUE, '', (vm, script) => { script.result = peek(vm, script, 1); });
  define(P.RESTART, '', (vm, script) => { vm.pc = script.entry.address; });
  define(P.DELAY, '', (vm, script) => {
    script.delay = pop(vm, script);
    if (script.delay > 0) script.state = 'delayed';
  });
  define(P.DELAYDIRECT, 'w', (vm, script, [tics]) => { script.delay = tics; if (tics > 0) script.state = 'delayed'; });
  define(P.DELAYDIRECTB, 'b', (vm, script, [tics]) => { script.delay = tics; if (tics > 0) script.state = 'delayed'; });
  define(P.TAGWAIT, '', (vm, script) => { script.stateData = pop(vm, script); script.state = 'tagwait'; });
  define(P.TAGWAITDIRECT, 'w', (vm, script, [tag]) => { script.stateData = tag; script.state = 'tagwait'; });
  define(P.POLYWAIT, '', (vm, script) => { pop(vm, script); script.state = 'running'; });
  define(P.POLYWAITDIRECT, 'w', () => {});
  define(P.SCRIPTWAIT, '', (vm, script) => { script.stateData = pop(vm, script); waitForScript(vm, script); });
  define(P.SCRIPTWAITDIRECT, 'w', (vm, script, [number]) => { script.stateData = number; waitForScript(vm, script); });
  define(P.SCRIPTWAITNAMED, '', (vm, script) => {
    const named = findScript(vm.program, vmString(vm, pop(vm, script)));
    script.stateData = named ? named.number : -1;
    waitForScript(vm, script);
  });
  define(P.CLEARLINESPECIAL, '', (vm, script) => { if (script.line) vm.host.clearLineSpecial(script.line); });
}

function waitForScript(vm, script) {
  script.state = vm.running(script.stateData) ? 'scriptwait' : 'scriptwaitpre';
}

function callFunction(vm, script, index, discard) {
  const name = vm.module.functionNames?.[index];
  const resolved = resolveFunction(vm.module, index);
  if (!resolved) {
    fail(vm, `call to function ${name ? `"${name}"` : index}, which no loaded module defines`);
    return;
  }
  const { module, fn } = resolved;
  if (script.sp + fn.localCount + 64 > STACK_LIMIT) { fail(vm, 'out of stack space'); return; }
  // A function's arguments live at the bottom of its own locals.
  const args = script.stack.slice(script.sp - fn.argCount, script.sp);
  script.locals = new Int32Array(fn.argCount + fn.localCount);
  for (let position = 0; position < fn.argCount; position++) script.locals[position] = args[position] | 0;
  script.stack.length = script.sp - fn.argCount;
  script.sp -= fn.argCount;
  script.calls.push({ pc: vm.pc, locals: script.locals, arrays: script.scriptArrays, discard,
    module: vm.module, moduleIndex: vm.moduleIndex });
  script.scriptArrays = new Map();
  // The callee runs with its own module active, so its map variables and strings
  // are the library's even when the caller lives in the map.
  vm.module = module;
  vm.moduleIndex = vm.program.modules.findIndex(entry => entry.module === module);
  if (vm.moduleIndex < 0) vm.moduleIndex = 0;
  vm.pc = fn.address;
}

function returnFromFunction(vm, script, value) {
  const frame = script.calls.pop();
  if (!frame) { script.state = 'terminated'; return; }
  script.locals = frame.locals instanceof Int32Array ? frame.locals : new Int32Array(0);
  script.scriptArrays = frame.arrays;
  if (frame.module) { vm.module = frame.module; vm.moduleIndex = frame.moduleIndex ?? vm.moduleIndex; }
  vm.pc = frame.pc;
  script.stack.length = script.sp;
  if (!frame.discard) push(vm, script, value);
}

function definePrinting() {
  define(P.BEGINPRINT, '', (vm, script) => { script.print = ''; });
  for (const code of [P.PRINTSTRING, P.PRINTLOCALIZED]) {
    define(code, '', (vm, script) => {
      const value = vmString(vm, pop(vm, script));
      script.print = (script.print || '') + value;
    });
  }
  define(P.PRINTNUMBER, '', (vm, script) => { script.print += String(pop(vm, script)); });
  define(P.PRINTCHARACTER, '', (vm, script) => { script.print += String.fromCharCode(pop(vm, script) & 0xff); });
  define(P.PRINTFIXED, '', (vm, script) => { script.print += String(Math.round((pop(vm, script) / 65536) * 1000) / 1000); });
  define(P.PRINTBINARY, '', (vm, script) => { script.print += (pop(vm, script) >>> 0).toString(2); });
  define(P.PRINTHEX, '', (vm, script) => { script.print += (pop(vm, script) >>> 0).toString(16).toUpperCase(); });
  define(P.PRINTNAME, '', (vm, script) => {
    const who = pop(vm, script);
    script.print += who === -1 ? vm.host.levelName() : who === -2 ? vm.host.mapName()
      : who === -3 ? vm.host.skillName() : who <= 0 || who > 8 ? vm.host.playerName() : vm.host.playerName(who - 1);
  });
  define(P.PRINTBIND, '', (vm, script) => { pop(vm, script); script.print += '?'; });
  for (const code of [P.PRINTMAPCHARARRAY, P.PRINTWORLDCHARARRAY, P.PRINTGLOBALCHARARRAY,
    P.PRINTMAPCHRANGE, P.PRINTWORLDCHRANGE, P.PRINTGLOBALCHRANGE,
    P.PRINTSCRIPTCHARARRAY, P.PRINTSCRIPTCHRANGE]) {
    const ranged = code === P.PRINTMAPCHRANGE || code === P.PRINTWORLDCHRANGE || code === P.PRINTGLOBALCHRANGE ||
      code === P.PRINTSCRIPTCHRANGE;
    define(code, '', (vm, script) => {
      let capacity = 0x7fffffff, offset = 0;
      if (ranged) {
        capacity = peek(vm, script, 1); offset = peek(vm, script, 2);
        script.sp -= 2;
        if (capacity < 1 || offset < 0) { script.sp -= 2; return; }
      }
      const slot = pop(vm, script);
      offset += pop(vm, script);
      const store = code === P.PRINTMAPCHARARRAY || code === P.PRINTMAPCHRANGE ? arrayFor(vm, script, 'map')
        : code === P.PRINTWORLDCHARARRAY || code === P.PRINTWORLDCHRANGE ? arrayFor(vm, script, 'world')
          : code === P.PRINTGLOBALCHARARRAY || code === P.PRINTGLOBALCHRANGE ? arrayFor(vm, script, 'global')
            : arrayFor(vm, script, 'script');
      const id = code === P.PRINTSCRIPTCHARARRAY || code === P.PRINTSCRIPTCHRANGE ? slot : targetId(vm, script, 'map', slot);
      let character;
      while (capacity-- > 0 && (character = store.get(id, offset))) { script.print += String.fromCharCode(character); offset++; }
    });
  }
  for (const code of [P.ENDPRINT, P.ENDPRINTBOLD, P.ENDLOG]) {
    define(code, '', (vm, script) => {
      const body = script.print || '';
      script.print = '';
      vm.host.print(body, { bold: code === P.ENDPRINTBOLD, log: code === P.ENDLOG });
      script.message = null;
    });
  }
  define(P.MOREHUDMESSAGE, '', (vm, script) => { script.hud = { pending: true }; });
  define(P.OPTHUDMESSAGE, '', (vm, script) => { script.hudStart = script.sp; });
  for (const code of [P.ENDHUDMESSAGE, P.ENDHUDMESSAGEBOLD]) {
    define(code, '', (vm, script) => {
      const body = script.print || '';
      script.print = '';
      // `optstart` is where OPTHUDMESSAGE left the stack; without that opcode — which some
      // scripts omit — the six parameters are simply the last six values pushed. A negative
      // hudStart is the "never set" marker, not an offset.
      const start = script.hudStart >= 0 ? script.hudStart : script.sp;
      const base = start - 6;
      const read = depth => (base >= 0 ? script.stack[base + depth] | 0 : 0);
      const message = {
        type: read(0) & 0xff, id: read(1), color: read(2),
        x: read(3) / 65536, y: read(4) / 65536, holdTime: read(5) / 65536,
        bold: code === P.ENDHUDMESSAGEBOLD, text: body,
        width: script.hudWidth || 0, height: script.hudHeight || 0,
        fade: (script.stack[(script.hudStart ?? script.sp)] | 0) / 65536,
        // SetFont names a font, and a name that is only a picture is a one-picture font:
        // that is how a mod draws a title logo without any font definition.
        font: script.hudFontName ?? null, style: script.hudStyle ?? null,
      };
      vm.host.hudMessage(message);
      script.sp = Math.max(0, base);
      script.hudStart = -1;
    });
  }
  define(P.SETSTYLE, '', (vm, script) => { script.hudStyle = pop(vm, script); });
  define(P.SETSTYLEDIRECT, 'w', (vm, script, [style]) => { script.hudStyle = style; });
  // ACS `SetFont` takes a string-table index, not a font number: `PUSHBYTE 0; SETFONT`
  // with string 0 = "LULLABY" asks for a font called LULLABY, which GZDoom satisfies with
  // the picture of that name.
  define(P.SETFONT, '', (vm, script) => {
    const index = pop(vm, script);
    script.hudFont = index;
    script.hudFontName = vmString(vm, index) || null;
  });
  define(P.SETFONTDIRECT, 'w', (vm, script, [font]) => {
    script.hudFont = font;
    script.hudFontName = typeof font === 'string' ? font : vmString(vm, font) || null;
  });
  define(P.SETHUDSIZE, '', (vm, script) => {
    // Pushed in the order width, height, wraparound, so the stack pops them back to front:
    // reading them in call order made every hud size a wrong one (350x270 arrived as 270x0).
    const block = pop(vm, script), height = pop(vm, script), width = pop(vm, script);
    script.hudWidth = Math.abs(width);
    script.hudHeight = Math.abs(height);
    script.hudBlock = Boolean(block);
  });
}

function defineSpecials() {
  for (let count = 1; count <= 5; count++) {
    define(P[`LSPEC${count}`], 'b', (vm, script, [special]) => {
      const args = [];
      for (let index = count; index >= 1; index--) args.push(peek(vm, script, index));
      script.sp -= count;
      executeSpecial(vm, script, special, args);
    });
    define(P[`LSPEC${count}DIRECT`], 'b' + 'w'.repeat(count), (vm, script, [special, ...args]) => executeSpecial(vm, script, special, args));
    define(P[`LSPEC${count}DIRECTB`], 'b'.repeat(count + 1), (vm, script, [special, ...args]) => executeSpecial(vm, script, special, args));
  }
  define(P.LSPEC5RESULT, 'b', (vm, script, [special]) => {
    const args = [];
    for (let index = 5; index >= 1; index--) args.push(peek(vm, script, index));
    script.sp -= 4;
    setTop(vm, script, 1, executeSpecial(vm, script, special, args, { result: true }));
  });
  define(P.LSPEC5EX, 'w', (vm, script, [special]) => {
    const args = [];
    for (let index = 5; index >= 1; index--) args.push(peek(vm, script, index));
    script.sp -= 5;
    executeSpecial(vm, script, special, args);
  });
  define(P.LSPEC5EXRESULT, 'w', (vm, script, [special]) => {
    const args = [];
    for (let index = 5; index >= 1; index--) args.push(peek(vm, script, index));
    script.sp -= 4;
    setTop(vm, script, 1, executeSpecial(vm, script, special, args, { result: true }));
  });
}

function defineQueries() {
  define(P.RANDOM, '', (vm, script) => { const max = pop(vm, script), min = pop(vm, script); push(vm, script, randomBetween(vm, min, max)); });
  define(P.RANDOMDIRECT, 'ww', (vm, script, [min, max]) => push(vm, script, randomBetween(vm, min, max)));
  define(P.RANDOMDIRECTB, 'bb', (vm, script, [min, max]) => push(vm, script, randomBetween(vm, min, max)));
  define(P.THINGCOUNT, '', (vm, script) => {
    const tid = pop(vm, script), type = pop(vm, script);
    push(vm, script, vm.host.thingCount({ type, tid }));
  });
  define(P.THINGCOUNTDIRECT, 'ww', (vm, script, [type, tid]) => push(vm, script, vm.host.thingCount({ type, tid })));
  define(P.THINGCOUNTNAME, '', (vm, script) => {
    const tid = pop(vm, script), name = vmString(vm, pop(vm, script));
    push(vm, script, vm.host.thingCount({ name, tid }));
  });
  define(P.THINGCOUNTSECTOR, '', (vm, script) => {
    const tag = pop(vm, script), tid = pop(vm, script), type = pop(vm, script);
    push(vm, script, vm.host.thingCount({ type, tid, tag }));
  });
  define(P.THINGCOUNTNAMESECTOR, '', (vm, script) => {
    const tag = pop(vm, script), tid = pop(vm, script), name = vmString(vm, pop(vm, script));
    push(vm, script, vm.host.thingCount({ name, tid, tag }));
  });
  define(P.PLAYERCOUNT, '', (vm, script) => push(vm, script, 1));
  define(P.GAMETYPE, '', (vm, script) => push(vm, script, 0));
  define(P.GAMESKILL, '', (vm, script) => push(vm, script, vm.host.skill()));
  define(P.TIMER, '', (vm, script) => push(vm, script, Math.floor(vm.host.levelTime() * 35)));
  define(P.PLAYERTEAM, '', (vm, script) => push(vm, script, 0));
  define(P.PLAYERHEALTH, '', (vm, script) => push(vm, script, vm.host.playerHealth()));
  define(P.PLAYERARMORPOINTS, '', (vm, script) => push(vm, script, vm.host.playerArmor()));
  define(P.PLAYERFRAGS, '', (vm, script) => push(vm, script, 0));
  define(P.PLAYEREXPERT, '', (vm, script) => push(vm, script, vm.host.skill() >= 4 ? 1 : 0));
  define(P.SINGLEPLAYER, '', (vm, script) => push(vm, script, 1));
  define(P.ISNETWORKGAME, '', (vm, script) => push(vm, script, 0));
  define(P.ISONEFLAGCTF, '', (vm, script) => push(vm, script, 0));
  define(P.BLUETEAMCOUNT, '', (vm, script) => push(vm, script, 0));
  define(P.REDTEAMCOUNT, '', (vm, script) => push(vm, script, 0));
  define(P.BLUETEAMSCORE, '', (vm, script) => push(vm, script, 0));
  define(P.REDTEAMSCORE, '', (vm, script) => push(vm, script, 0));
  define(P.PLAYERNUMBER, '', (vm, script) => push(vm, script, 0));
  define(P.ACTIVATORTID, '', (vm, script) => push(vm, script, script.activator?.tid || 0));
  define(P.GETSCREENWIDTH, '', (vm, script) => push(vm, script, 320));
  define(P.GETSCREENHEIGHT, '', (vm, script) => push(vm, script, 200));
  define(P.GETCVAR, '', (vm, script) => { pop(vm, script); push(vm, script, 0); });
  define(P.GETLEVELINFO, '', (vm, script) => { setTop(vm, script, 1, vm.host.levelInfo(peek(vm, script, 1))); });
  define(P.STRLEN, '', (vm, script) => { setTop(vm, script, 1, vmString(vm, peek(vm, script, 1)).length); });
  define(P.GETLINEROWOFFSET, '', (vm, script) => push(vm, script, script.line ? vm.host.lineRowOffset(script.line) : 0));
  define(P.PLAYERINGAME, '', (vm, script) => { setTop(vm, script, 1, peek(vm, script, 1) === 1 ? 1 : 0); });
  define(P.PLAYERISBOT, '', (vm, script) => push(vm, script, 0));
  define(P.PLAYERCLASS, '', (vm, script) => push(vm, script, 0));
  define(P.GETPLAYERINFO, '', (vm, script) => { pop(vm, script); push(vm, script, 0); });
  // GetPlayerInput(player, input): buttons, view deltas and movement, so scripts
  // can react to jump/crouch/attack state.
  define(P.GETPLAYERINPUT, '', (vm, script) => {
    const input = pop(vm, script);
    setTop(vm, script, 1, vm.host.playerInput(peek(vm, script, 1), input));
  });
  define(P.CHECKPLAYERCAMERA, '', (vm, script) => { pop(vm, script); push(vm, script, 0); });
  define(P.GETAMMOCAPACITY, '', (vm, script) => { pop(vm, script); push(vm, script, 0); });
  const keyCodes = {
    PLAYERBLUESKULL: 'blueSkull', PLAYERREDSKULL: 'redSkull', PLAYERYELLOWSKULL: 'yellowSkull',
    PLAYERMASTERSKULL: 'masterSkull', PLAYERBLUECARD: 'blueCard', PLAYERREDCARD: 'redCard',
    PLAYERYELLOWCARD: 'yellowCard', PLAYERMASTERCARD: 'masterCard', PLAYERBLACKSKULL: 'blackSkull',
    PLAYERSILVERSKULL: 'silverSkull', PLAYERGOLDSKULL: 'goldSkull', PLAYERBLACKCARD: 'blackCard',
    PLAYERSILVERCARD: 'silverCard',
  };
  for (const [name, key] of Object.entries(keyCodes)) define(P[name], '', (vm, script) => push(vm, script, vm.host.hasKey(key)));
}

function randomBetween(vm, min, max) {
  if (max < min) return 0;
  const span = max - min + 1;
  return min + Math.floor(vm.random() * span);
}

function defineWorld() {
  define(P.CHANGEFLOOR, '', (vm, script) => {
    const flat = pop(vm, script), tag = pop(vm, script);
    vm.host.changeFlat(tag, vmString(vm, flat), false);
  });
  define(P.CHANGEFLOORDIRECT, 'ww', (vm, script, [tag, flat]) => vm.host.changeFlat(tag, vmString(vm, flat), false));
  define(P.CHANGECEILING, '', (vm, script) => {
    const flat = pop(vm, script), tag = pop(vm, script);
    vm.host.changeFlat(tag, vmString(vm, flat), true);
  });
  define(P.CHANGECEILINGDIRECT, 'ww', (vm, script, [tag, flat]) => vm.host.changeFlat(tag, vmString(vm, flat), true));
  define(P.SETLINETEXTURE, '', (vm, script) => {
    const texture = pop(vm, script), part = pop(vm, script), side = pop(vm, script), line = pop(vm, script);
    vm.host.setLineTexture(line, side, part, vmString(vm, texture));
  });
  define(P.SETLINEBLOCKING, '', (vm, script) => {
    const tag = pop(vm, script), mode = pop(vm, script);
    vm.host.setLineBlocking(tag, mode);
  });
  define(P.SETLINEMONSTERBLOCKING, '', (vm, script) => {
    const tag = pop(vm, script), on = pop(vm, script);
    vm.host.setLineMonsterBlocking(tag, Boolean(on));
  });
  define(P.SETLINESPECIAL, '', (vm, script) => {
    const args = [pop(vm, script), pop(vm, script), pop(vm, script), pop(vm, script), pop(vm, script)];
    const special = pop(vm, script), tag = pop(vm, script);
    vm.host.setLineSpecial(tag, special, args);
  });
  define(P.SETTHINGSPECIAL, '', (vm, script) => {
    const args = [pop(vm, script), pop(vm, script), pop(vm, script), pop(vm, script), pop(vm, script)];
    const special = pop(vm, script), tid = pop(vm, script);
    vm.host.setThingSpecial(tid, special, args, script.activator);
  });
  define(P.SETMUSIC, '', (vm, script) => {
    const order = pop(vm, script), name = pop(vm, script);
    pop(vm, script);
    vm.host.setMusic(vmString(vm, name), order);
  });
  define(P.SETMUSICDIRECT, 'www', (vm, script, [name, order]) => vm.host.setMusic(vmString(vm, name), order));
  define(P.LOCALSETMUSIC, '', (vm, script) => {
    const order = pop(vm, script), name = pop(vm, script);
    pop(vm, script);
    vm.host.setMusic(vmString(vm, name), order);
  });
  define(P.LOCALSETMUSICDIRECT, 'www', (vm, script, [name, order]) => vm.host.setMusic(vmString(vm, name), order));
  define(P.MUSICCHANGE, '', (vm, script) => {
    const order = pop(vm, script), name = pop(vm, script);
    vm.host.setMusic(vmString(vm, name), order);
  });
  define(P.CHANGESKY, '', (vm, script) => {
    const second = vmString(vm, pop(vm, script)), first = vmString(vm, pop(vm, script));
    vm.host.changeSky(first, second);
  });
  define(P.SETGRAVITY, '', (vm, script) => vm.host.setGravity(pop(vm, script) / 65536));
  define(P.SETGRAVITYDIRECT, 'w', (vm, script, [value]) => vm.host.setGravity(value / 65536));
  define(P.SETAIRCONTROL, '', (vm, script) => vm.host.setAirControl(pop(vm, script) / 65536));
  define(P.SETAIRCONTROLDIRECT, 'w', (vm, script, [value]) => vm.host.setAirControl(value / 65536));
  for (const [name, ceiling] of [['GETSECTORFLOORZ', false], ['GETSECTORCEILINGZ', true]]) {
    define(P[name], '', (vm, script) => {
      const y = pop(vm, script), x = pop(vm, script);
      setTop(vm, script, 1, vm.host.getSectorZ(peek(vm, script, 1), x / 65536, y / 65536, ceiling));
    });
  }
  define(P.GETSECTORLIGHTLEVEL, '', (vm, script) => {
    setTop(vm, script, 1, vm.host.getSectorLight(peek(vm, script, 1)));
  });
  define(P.SECTORDAMAGE, '', (vm, script) => {
    vm.host.sectorDamage(pop(vm, script), pop(vm, script), pop(vm, script), pop(vm, script), pop(vm, script));
  });
  define(P.SECTORSOUND, '', (vm, script) => {
    const volume = pop(vm, script), sound = pop(vm, script);
    vm.host.sectorSound(vmString(vm, sound), volume);
  });
  define(P.AMBIENTSOUND, '', (vm, script) => {
    const volume = pop(vm, script), sound = pop(vm, script);
    vm.host.sectorSound(vmString(vm, sound), volume);
  });
  define(P.LOCALAMBIENTSOUND, '', (vm, script) => {
    const volume = pop(vm, script), sound = pop(vm, script);
    vm.host.sectorSound(vmString(vm, sound), volume);
  });
  define(P.ACTIVATORSOUND, '', (vm, script) => {
    const volume = pop(vm, script), sound = pop(vm, script);
    vm.host.thingSound(0, vmString(vm, sound), volume, script.activator);
  });
  define(P.THINGSOUND, '', (vm, script) => {
    const volume = pop(vm, script), sound = pop(vm, script), tid = pop(vm, script);
    vm.host.thingSound(tid, vmString(vm, sound), volume);
  });
  define(P.SOUNDSEQUENCE, '', (vm, script) => { pop(vm, script); });
  define(P.REPLACETEXTURES, '', (vm, script) => { pop(vm, script); pop(vm, script); pop(vm, script); });
  define(P.SETFLOORTRIGGER, '', (vm, script) => { for (let index = 0; index < 8; index++) pop(vm, script); });
  define(P.SETCEILINGTRIGGER, '', (vm, script) => { for (let index = 0; index < 8; index++) pop(vm, script); });
  define(P.FADETO, '', (vm, script) => { for (let index = 0; index < 5; index++) pop(vm, script); });
  define(P.FADERANGE, '', (vm, script) => { for (let index = 0; index < 9; index++) pop(vm, script); });
  define(P.CANCELFADE, '', () => {});
  define(P.PLAYMOVIE, '', (vm, script) => { pop(vm, script); push(vm, script, -1); });
  define(P.CHANGELEVEL, '', (vm, script) => {
    const position = pop(vm, script), flags = pop(vm, script), skill = pop(vm, script), map = pop(vm, script);
    vm.host.changeLevel(vmString(vm, map), skill, flags, position);
  });
  define(P.WRITETOINI, '', (vm, script) => { pop(vm, script); pop(vm, script); });
  define(P.GETFROMINI, '', (vm, script) => { pop(vm, script); push(vm, script, 0); });
}

function defineActors() {
  define(P.SPAWN, '', (vm, script) => {
    const type = pop(vm, script), x = pop(vm, script), y = pop(vm, script), z = pop(vm, script);
    const tid = pop(vm, script), angle = pop(vm, script);
    push(vm, script, vm.host.spawn({ type, x, y, z, tid, angle }));
  });
  define(P.SPAWNDIRECT, 'wwwwww', (vm, script, [type, x, y, z, tid, angle]) => {
    push(vm, script, vm.host.spawn({ type: vmString(vm, type), x, y, z, tid, angle }));
  });
  define(P.SPAWNSPOT, '', (vm, script) => {
    const type = pop(vm, script), spot = pop(vm, script), tid = pop(vm, script), angle = pop(vm, script);
    push(vm, script, vm.host.spawnSpot({ type, spot, tid, angle }));
  });
  define(P.SPAWNSPOTDIRECT, 'wwww', (vm, script, [type, spot, tid, angle]) => {
    push(vm, script, vm.host.spawnSpot({ type: vmString(vm, type), spot, tid, angle }));
  });
  define(P.SPAWNSPOTFACING, '', (vm, script) => {
    const type = pop(vm, script), spot = pop(vm, script), tid = pop(vm, script);
    push(vm, script, vm.host.spawnSpot({ type, spot, tid, facing: true }));
  });
  define(P.SPAWNPROJECTILE, '', (vm, script) => {
    const tid = pop(vm, script), type = pop(vm, script), angle = pop(vm, script), speed = pop(vm, script), vspeed = pop(vm, script);
    const newTid = pop(vm, script), gravity = pop(vm, script);
    vm.host.projectile({ tid, type: vmString(vm, type), angle, speed, vspeed, newTid, gravity });
  });
  define(P.THING_PROJECTILE2, '', (vm, script) => {
    const tid = pop(vm, script), type = pop(vm, script), angle = pop(vm, script), speed = pop(vm, script), vspeed = pop(vm, script);
    const newTid = pop(vm, script), gravity = pop(vm, script);
    vm.host.projectile({ tid, type, angle, speed, vspeed, newTid, gravity });
  });
  for (const [name, kind] of [['GETACTORX', 'x'], ['GETACTORY', 'y'], ['GETACTORZ', 'z'],
    ['GETACTORFLOORZ', 'floorZ'], ['GETACTORCEILINGZ', 'ceilingZ'], ['GETACTORANGLE', 'angle'],
    ['GETACTORPITCH', 'pitch'], ['GETACTORLIGHTLEVEL', 'light']]) {
    define(P[name], '', (vm, script) => {
      setTop(vm, script, 1, vm.host.getActor(peek(vm, script, 1), kind, script.activator));
    });
  }
  define(P.SETACTORPOSITION, '', (vm, script) => {
    // Arguments sit on the stack in call order (tid, x, y, z, fog), so they are popped
    // back to front. Reading them in push order moved an actor to x = fog and z = y.
    const fog = pop(vm, script), z = pop(vm, script), y = pop(vm, script), x = pop(vm, script), tid = pop(vm, script);
    push(vm, script, vm.host.setActorPosition(tid, x, y, z, fog, script.activator));
  });
  define(P.SETACTORANGLE, '', (vm, script) => {
    pop(vm, script); pop(vm, script);
  });
  define(P.SETACTORPITCH, '', (vm, script) => { pop(vm, script); pop(vm, script); });
  // SetActorProperty(tid, property, value) / GetActorProperty(tid, property):
  // mods poll these every tic, so the properties the engine really tracks are
  // answered from live state instead of a constant zero.
  define(P.SETACTORPROPERTY, '', (vm, script) => {
    const value = pop(vm, script), property = pop(vm, script), tid = pop(vm, script);
    vm.host.setActorProperty(tid, property, value, script.activator);
  });
  define(P.GETACTORPROPERTY, '', (vm, script) => {
    const property = pop(vm, script), tid = pop(vm, script);
    push(vm, script, vm.host.getActorProperty(tid, property, script.activator));
  });
  define(P.THINGDAMAGE2, '', (vm, script) => {
    const tid = pop(vm, script), amount = pop(vm, script), type = pop(vm, script);
    push(vm, script, vm.host.damageThing(tid, amount, vmString(vm, type), script.activator));
  });
  define(P.CLEARINVENTORY, '', (vm, script) => vm.host.clearInventory(script.activator));
  define(P.GIVEINVENTORY, '', (vm, script) => {
    const amount = pop(vm, script), name = pop(vm, script);
    vm.host.giveInventory(vmString(vm, name), amount, script.activator);
  });
  define(P.GIVEINVENTORYDIRECT, 'ww', (vm, script, [name, amount]) =>
    vm.host.giveInventory(vmString(vm, name), amount, script.activator));
  define(P.TAKEINVENTORY, '', (vm, script) => {
    const amount = pop(vm, script), name = pop(vm, script);
    vm.host.takeInventory(vmString(vm, name), amount, script.activator);
  });
  define(P.TAKEINVENTORYDIRECT, 'ww', (vm, script, [name, amount]) =>
    vm.host.takeInventory(vmString(vm, name), amount, script.activator));
  define(P.CHECKINVENTORY, '', (vm, script) => {
    setTop(vm, script, 1, vm.host.checkInventory(vmString(vm, peek(vm, script, 1)), script.activator));
  });
  define(P.CHECKINVENTORYDIRECT, 'w', (vm, script, [name]) =>
    push(vm, script, vm.host.checkInventory(vmString(vm, name), script.activator)));
  define(P.CLEARACTORINVENTORY, '', (vm, script) => { pop(vm, script); vm.host.clearInventory(script.activator); });
  define(P.GIVEACTORINVENTORY, '', (vm, script) => {
    const tid = pop(vm, script), amount = pop(vm, script), name = pop(vm, script);
    vm.host.giveInventory(vmString(vm, name), amount, script.activator, tid);
  });
  define(P.TAKEACTORINVENTORY, '', (vm, script) => {
    const tid = pop(vm, script), amount = pop(vm, script), name = pop(vm, script);
    vm.host.takeInventory(vmString(vm, name), amount, script.activator, tid);
  });
  define(P.CHECKACTORINVENTORY, '', (vm, script) => {
    const tid = pop(vm, script), name = pop(vm, script);
    setTop(vm, script, 1, vm.host.checkInventory(vmString(vm, name), script.activator, tid));
  });
  define(P.CHECKWEAPON, '', (vm, script) => {
    setTop(vm, script, 1, vm.host.checkWeapon(vmString(vm, peek(vm, script, 1))));
  });
  define(P.SETWEAPON, '', (vm, script) => { setTop(vm, script, 1, vm.host.setWeapon(vmString(vm, peek(vm, script, 1)))); });
  define(P.USEINVENTORY, '', (vm, script) => { setTop(vm, script, 1, vm.host.useInventory(vmString(vm, peek(vm, script, 1)))); });
  define(P.SETMARINEWEAPON, '', (vm, script) => { pop(vm, script); pop(vm, script); });
  define(P.SETMARINESPRITE, '', (vm, script) => { pop(vm, script); pop(vm, script); });
  define(P.CHECKACTORCEILINGTEXTURE, '', (vm, script) => { pop(vm, script); setTop(vm, script, 1, 0); });
  define(P.CHECKACTORFLOORTEXTURE, '', (vm, script) => { pop(vm, script); setTop(vm, script, 1, 0); });
}

function defineConversions() {
  // ACC emits this after pushing a string constant so that a library's own string
  // table is used rather than the map's: the value is interned into the shared
  // pool and tagged, which is what GZMod's TAGSTRING p-code does.
  define(P.TAGSTRING, '', (vm, script) => {
    setTop(vm, script, 1, internString(vm, lookupString(vm.module, peek(vm, script, 1))));
  });
  // MorphActor(tid, class, duration, style, morphflash, unmorphflash) and
  // UnMorphActor(tid, force): the flashes are decorative and skipped.
  define(P.MORPHACTOR, '', (vm, script) => {
    pop(vm, script); pop(vm, script);
    const style = pop(vm, script), duration = pop(vm, script), name = pop(vm, script), tid = pop(vm, script);
    push(vm, script, vm.host.morphActor(tid, vmString(vm, name), duration, style, script.activator) ? 1 : 0);
  });
  // SetCameraToTexture(camera_tid, "TEXTURE", fov): the renderer draws that
  // camera's view into the texture, which ANIMDEFS reserved.
  define(P.SETCAMERATOTEXTURE, '', (vm, script) => {
    const fov = pop(vm, script), name = pop(vm, script), tid = pop(vm, script);
    push(vm, script, vm.host.setCameraToTexture(tid, vmString(vm, name), fov) ? 1 : 0);
  });
  define(P.UNMORPHACTOR, '', (vm, script) => {
    const force = pop(vm, script), tid = pop(vm, script);
    push(vm, script, vm.host.unmorphActor(tid, force, script.activator) ? 1 : 0);
  });
  for (const code of [P.CALLFUNC, P.PUSHFUNCTION, P.CALLSTACK, P.SAVESTRING,
    P.STRCPYTOMAPCHRANGE, P.STRCPYTOSCRIPTCHRANGE, P.STRCPYTOWORLDCHRANGE, P.STRCPYTOGLOBALCHRANGE,
    P.CLASSIFYACTOR, P.SETACTORSTATE, P.SETMUGSHOTSTATE,
    P.GRABINPUT, P.SETMOUSEPOINTER, P.MOVEMOUSEPOINTER, P.SETAMMOCAPACITY,
    P.STARTTRANSLATION, P.TRANSLATIONRANGE1, P.TRANSLATIONRANGE2, P.TRANSLATIONRANGE3,
    P.TRANSLATIONRANGE4, P.TRANSLATIONRANGE5, P.ENDTRANSLATION, P.USEACTORINVENTORY]) {
    if (OPS.has(code)) continue;
    define(code, null, (vm) => { vm.unsupported.add(PCODE_NAMES[code]); fail(vm, `${PCODE_NAMES[code]} is not implemented`); });
  }
}

export { PCODE_NAMES };

const HOST_DEFAULTS = {
  executeSpecial: () => 0,
  morphActor: () => false,
  unmorphActor: () => false,
  setCameraToTexture: () => false,
  print: () => {},
  hudMessage: () => {},
  thingCount: () => 0,
  skill: () => 2,
  skillName: () => 'Hurt me plenty',
  levelName: () => '',
  mapName: () => '',
  playerName: () => 'Marine',
  levelTime: () => 0,
  playerHealth: () => 0,
  playerArmor: () => 0,
  hasKey: () => 0,
  changeFlat: () => {},
  setLineTexture: () => {},
  setLineBlocking: () => {},
  setLineMonsterBlocking: () => {},
  setLineSpecial: () => {},
  setThingSpecial: () => {},
  clearLineSpecial: () => {},
  lineRowOffset: () => 0,
  setMusic: () => {},
  changeSky: () => {},
  setGravity: () => {},
  setAirControl: () => {},
  sectorDamage: () => {},
  sectorSound: () => {},
  thingSound: () => {},
  spawn: () => 0,
  spawnSpot: () => 0,
  projectile: () => {},
  getActor: () => 0,
  getActorProperty: () => 0,
  setActorProperty: () => {},
  setActorPosition: () => false,
  damageThing: () => 0,
  giveInventory: () => {},
  takeInventory: () => {},
  checkInventory: () => 0,
  clearInventory: () => {},
  checkWeapon: () => 0,
  setWeapon: () => 0,
  useInventory: () => 0,
  levelInfo: () => 0,
  changeLevel: () => {},
  sectorBusy: () => false,
  getSectorZ: () => 0,
  getSectorLight: () => -1,
  playerInput: () => 0,
};

/**
 * A level's ACS interpreter.
 *
 * Scripts run one tic at a time (`tick`), exactly like GZDoom's ACS thinker:
 * `Delay` parks a script, `TagWait` waits for the tagged sectors to stop moving,
 * and `ACS_Execute` on a suspended script resumes it instead of starting a copy.
 */
export function createAcsVm(program, host = {}) {
  const container = asProgram(program);
  const vm = {
    program: container,
    module: container.primary,
    moduleIndex: 0,
    host: { ...HOST_DEFAULTS, ...host },
    active: [],
    mapVars: [],
    worldVars: new Int32Array(256),
    globalVars: new Int32Array(64),
    mapArrays: [],
    pool: [],
    poolIndex: new Map(),
    worldArrays: new Map(),
    globalArrays: new Map(),
    scriptArrays: new Map(),
    unsupported: new Set(),
    errors: [],
    seed: 0x2545f491,
    tics: 0,
    started: false,
    code: 0,
    pc: 0,
    script: null,
    running(number) { return vm.active.some(script => script.number === number && script.state !== 'terminated'); },
    random() {
      vm.seed ^= vm.seed << 13; vm.seed ^= vm.seed >>> 17; vm.seed ^= vm.seed << 5;
      return ((vm.seed >>> 0) % 100000) / 100000;
    },
  };
  container.modules.forEach(({ index, module }) => {
    const store = moduleMapVars(vm, index);
    for (const [slot, value] of module.mapVars) store[slot] = value;
  });
  return vm;
}

/**
 * Starts a script. Returns `false` when it is already running (matching GZDoom,
 * which silently ignores a second `ACS_Execute` of a live script unless it was
 * started with `ACS_ExecuteAlways`).
 */
export function startScript(vm, selector, options = {}) {
  const entry = findScript(vm.program, selector);
  if (!entry) {
    vm.errors.push(`Unknown ACS script ${selector}`);
    return options.wantResult ? 0 : false;
  }
  return startEntry(vm, entry, options);
}

function startEntry(vm, entry, { args = [], activator = null, line = null, backSide = false, always = false, wantResult = false } = {}) {
  const existing = vm.active.find(script => script.number === entry.number &&
    script.moduleIndex === entry.moduleIndex && script.state !== 'terminated');
  if (existing && !always) {
    // GZDoom treats a second execute of a live script as a no-op, except that a
    // suspended script resumes where it stopped.
    if (existing.state === 'suspended') { existing.state = 'running'; return wantResult ? existing.result : true; }
    return wantResult ? existing.result : false;
  }
  if (vm.active.length > 64) return false;
  const script = {
    number: entry.number, name: entry.name, entry, kind: entry.type,
    moduleIndex: entry.moduleIndex, moduleName: entry.moduleName,
    locals: new Int32Array(Math.max(entry.varCount || 20, entry.argCount)),
    stack: [], sp: 0, calls: [], scriptArrays: new Map(),
    pc: entry.address, state: 'running', delay: 0, stateData: 0, result: 1,
    activator, line, backSide, print: '', hudStart: -1, hudWidth: 0, hudHeight: 0,
    startedAt: vm.tics,
  };
  for (let index = 0; index < Math.min(args.length, script.locals.length); index++) script.locals[index] = args[index] | 0;
  vm.active.push(script);
  if (wantResult) {
    // Running for a result happens inline, so the caller's program counter and
    // script must be restored afterwards: starting scripts from inside a script
    // is the normal way ACS chains map behaviour.
    const caller = { pc: vm.pc, script: vm.script, module: vm.module, moduleIndex: vm.moduleIndex };
    runScript(vm, script);
    Object.assign(vm, caller);
    return script.result | 0;
  }
  return true;
}

function runScript(vm, script) {
  vm.script = script;
  vm.moduleIndex = script.moduleIndex ?? 0;
  vm.module = vm.program.modules[vm.moduleIndex]?.module ?? vm.program.primary;
  vm.pc = script.pc;
  let executed = 0;
  while (script.state === 'running') {
    if (++executed > 500000) { fail(vm, 'runaway script terminated'); break; }
    const decoded = decode(vm.module, vm.pc);
    if (!decoded) { script.state = 'terminated'; break; }
    const definition = OPS.get(decoded.code);
    if (!definition) {
      vm.unsupported.add(PCODE_NAMES[decoded.code] || `#${decoded.code}`);
      fail(vm, `unsupported instruction ${PCODE_NAMES[decoded.code] || decoded.code}`);
      break;
    }
    vm.code = decoded.code;
    vm.pc = decoded.cursor;
    if (definition.spec === null) definition.run(vm, script);
    else {
      const { values, end } = operands(vm.module, decoded.cursor, definition.spec);
      vm.pc = end;
      definition.run(vm, script, values);
    }
  }
  // The interpreter keeps the live program counter in `vm.pc`, which is shared by
  // every script; publishing it on the script lets saves and the editor resume
  // (and inspect) the exact instruction each script stopped on.
  script.pc = vm.pc;
}

/** Advances every live script by one tic. */
export function tickAcs(vm) {
  vm.tics++;
  for (const script of [...vm.active]) {
    switch (script.state) {
      case 'delayed':
        if (--script.delay <= 0) script.state = 'running';
        break;
      case 'tagwait':
        if (!vm.host.sectorBusy(script.stateData)) script.state = 'running';
        break;
      case 'scriptwaitpre':
        if (vm.running(script.stateData)) script.state = 'scriptwait';
        break;
      case 'scriptwait':
        if (!vm.running(script.stateData)) script.state = 'running';
        break;
      default:
        break;
    }
    if (script.state === 'running') runScript(vm, script);
  }
  vm.active = vm.active.filter(script => script.state !== 'terminated');
}

/** Runs every script of a type, as the level does for OPEN and ENTER scripts. */
export function startScriptsOfKind(vm, kind, activator = null) {
  let started = 0;
  // Libraries carry their own OPEN/ENTER scripts (Furdoom's double jump is an
  // ENTER script in acs/DoubleJump.o), so every module is started, in load order.
  for (const entry of vm.program.scripts) {
    if (entry.type !== kind) continue;
    if (startEntry(vm, entry, { activator })) started++;
  }
  return started;
}

export function terminateScript(vm, selector) {
  const entry = findScript(vm.program, selector);
  if (!entry) return 0;
  let count = 0;
  for (const script of vm.active) {
    if (script.number !== entry.number || script.moduleIndex !== entry.moduleIndex) continue;
    script.state = 'terminated';
    count++;
  }
  return count;
}

export function suspendScript(vm, selector) {
  const entry = findScript(vm.program, selector);
  if (!entry) return 0;
  let count = 0;
  for (const script of vm.active) {
    if (script.number !== entry.number || script.moduleIndex !== entry.moduleIndex || script.state === 'terminated') continue;
    script.state = 'suspended';
    count++;
  }
  return count;
}

/** Human-readable summary used by the importer, the editor and MCP tools. */
export function describeBehavior(program) {
  if (!program) return null;
  const container = asProgram(program);
  const modules = container.modules.map(({ name, module }) => ({
    name, format: module.format, scripts: module.scripts.length, functions: module.functions.length,
    strings: module.strings.length, mapVars: module.mapVars.size,
  }));
  const kinds = {};
  for (const script of container.scripts) kinds[script.type] = (kinds[script.type] || 0) + 1;
  const format = modules[0]?.format ?? 'little';
  return {
    modules,
    ...describeTotals(container, modules, kinds, format),
  };
}

function describeTotals(container, modules, kinds, format) {
  return {
    format,
    scripts: container.scripts.length,
    kinds,
    functions: modules.reduce((total, module) => total + module.functions, 0),
    strings: modules.reduce((total, module) => total + module.strings, 0),
    mapVars: modules.reduce((total, module) => total + module.mapVars, 0),
  };
}

defineArithmetic();
defineStack();
defineFlow();
definePrinting();
defineSpecials();
defineQueries();
defineWorld();
defineActors();
defineConversions();
