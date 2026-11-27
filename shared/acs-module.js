/**
 * Writing ACS modules, the counterpart of `parseBehavior`.
 *
 * A map's `BEHAVIOR` lump and every `LOADACS` library are bytecode containers, so a script
 * written in the editor has to leave here as one. The layout is the one the reader in
 * `shared/acs.js` accepts — header, code, named chunks — and it is written the same way for
 * a new level and for a script added to a module an import already produced:
 *
 * ```
 * "ACS\0" | directory offset        header
 * p-code                            everything the scripts and functions execute
 * SPTR | SNAM | FUNC | FNAM | LOAD | MINI | STRL    chunks
 * chunk offset | "ACSe" | padding   trailer the reader uses to find the chunks
 * ```
 *
 * Script addresses are absolute byte offsets from the start of the lump, so appending code
 * to an existing module never moves anything that was already there — which is what lets the
 * editor replace one script and leave the level's other scripts running.
 */

import { SCRIPT_KINDS } from './acs.js';

/** Where a module's p-code begins: right after `"ACS\0"` and the directory offset. */
export const CODE_START = 8;

const words = values => values.flatMap(value => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff]);
const chars = value => [...value].map(char => char.charCodeAt(0) & 0xff);

/** A NUL-terminated string table: an offset per entry, then the bytes. */
function stringTable(strings, header) {
  const offsets = [];
  const body = [];
  let cursor = header + 4 * strings.length;
  for (const value of strings) {
    offsets.push(cursor);
    const bytes = chars(value);
    body.push(...bytes, 0);
    cursor += bytes.length + 1;
  }
  return [...words(offsets), ...body];
}

function scriptKind(type) {
  if (typeof type === 'number') return type;
  const index = SCRIPT_KINDS.indexOf(type);
  return index < 0 ? 0 : index;
}

/**
 * Builds a module from the pieces the reader exposes.
 *
 * `scripts` entries carry `number` (negative for a named script, `-slot - 1`), `type`
 * (a kind name or its numeric code), `argCount`, `address` (an absolute lump offset),
 * and optionally `name`, `flags` and `varCount`.
 */
export function buildAcsModule({ data = [], scripts = [], functions = [], functionNames = [], strings = [],
  mapVars = [], requiredLibraries = [], jumps = null } = {}) {
  const bytes = [];
  const word = value => bytes.push(...words([value]));
  bytes.push(0x41, 0x43, 0x53, 0x00); // "ACS\0"
  const directoryAt = bytes.length;
  word(0);
  for (const byte of data) bytes.push(byte & 0xff);
  const chunkStart = bytes.length;
  const chunk = (id, content) => { bytes.push(...chars(id), ...words([content.length]), ...content); };

  const directory = [];
  for (const script of scripts) {
    const number = script.number | 0;
    directory.push(number & 0xff, (number >> 8) & 0xff, scriptKind(script.type) & 0xff, (script.argCount | 0) & 0xff);
    directory.push(...words([script.address | 0]));
  }
  chunk('SPTR', directory);

  const namedSlots = [];
  for (const script of scripts) {
    if (script.number >= 0 || !script.name) continue;
    namedSlots[-script.number - 1] = script.name;
  }
  if (namedSlots.some(Boolean)) {
    const names = Array.from({ length: namedSlots.length }, (_, index) => namedSlots[index] || '');
    chunk('SNAM', [...words([names.length]), ...stringTable(names, 4)]);
  }

  if (functions.length) {
    chunk('FUNC', functions.flatMap(fn => [fn.argCount | 0, fn.localCount | 0, fn.returns ? 1 : 0,
      fn.importNum | 0, ...words([fn.address | 0])]));
  }
  if (functionNames.length) {
    chunk('FNAM', [...words([functionNames.length]), ...stringTable(functionNames, 4)]);
  }
  if (requiredLibraries.length) {
    chunk('LOAD', [...requiredLibraries.flatMap(name => [...chars(name), 0]), 0]);
  }
  if (mapVars.length) {
    chunk('MINI', [...words([0]), ...words(mapVars.map(value => value | 0))]);
  }
  const flagged = scripts.filter(script => script.flags);
  if (flagged.length) {
    chunk('SFLG', flagged.flatMap(script =>
      [script.number & 0xff, (script.number >> 8) & 0xff, script.flags & 0xff, (script.flags >> 8) & 0xff]));
  }
  const counted = scripts.filter(script => script.varCount !== undefined);
  if (counted.length) {
    chunk('SVCT', counted.flatMap(script =>
      [script.number & 0xff, (script.number >> 8) & 0xff, script.varCount & 0xff, (script.varCount >> 8) & 0xff]));
  }
  if (strings.length) chunk('STRL', [0, 0, 0, 0, ...words([strings.length]), 0, 0, 0, 0, ...stringTable(strings, 12)]);
  if (jumps) chunk('JUMP', words(jumps));

  while (bytes.length % 4) bytes.push(0);
  word(chunkStart);
  bytes.push(...chars('ACSe'));
  bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
  const directoryOffset = bytes.length - 8;
  bytes[directoryAt] = directoryOffset & 0xff;
  bytes[directoryAt + 1] = (directoryOffset >> 8) & 0xff;
  bytes[directoryAt + 2] = (directoryOffset >> 16) & 0xff;
  bytes[directoryAt + 3] = (directoryOffset >> 24) & 0xff;
  return new Uint8Array(bytes);
}

/**
 * The module's own p-code with more code on the end, keeping every existing address valid.
 *
 * A recompiled script is placed at the end rather than in the hole it left, because offsets
 * are absolute and moving a script would move the branches inside it.
 */
export function appendCode(module, code) {
  const end = module.dataSize ?? module.bytes.length;
  return [...module.bytes.slice(CODE_START, end), ...code];
}

/** The module's strings, map variables, functions and libraries, ready to be written back. */
export function moduleParts(module) {
  const mapVars = [];
  if (module.mapVars?.size) {
    const first = Math.min(...module.mapVars.keys());
    for (let index = first; module.mapVars.has(index); index++) mapVars[index - first] = module.mapVars.get(index);
  }
  return {
    strings: [...(module.strings || [])],
    mapVars,
    functions: (module.functions || []).map(fn => ({ ...fn })),
    functionNames: [...(module.functionNames || [])],
    requiredLibraries: [...(module.requiredLibraries || [])],
    jumps: module.jumps?.length ? [...module.jumps] : null,
  };
}
