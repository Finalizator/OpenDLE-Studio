/**
 * ACS libraries: the compiled `acs/*.o` modules a game loads through `LOADACS`.
 *
 * A library is a module like a map's BEHAVIOR, but it belongs to the game rather
 * than a level. GZDoom reads every LOADACS list in load order and loads the named
 * modules for each map, so their scripts, strings and map variables are separate
 * from the map's own.
 */

const ACS_LIBRARY = /^acs\/(.+)\.o$/i;

function ascii(bytes, start, length) {
  let text = '';
  for (let index = 0; index < length; index++) {
    const code = bytes[start + index];
    if (!code) break;
    text += String.fromCharCode(code);
  }
  return text;
}

/** Splits LOADACS text into library names, ignoring comments and blank lines. */
export function loadacsNames(text) {
  return String(text).replace(/\/\/[^\n]*/g, ' ').split(/[\s,;]+/)
    .map(name => name.trim()).filter(name => name && !name.startsWith('//'));
}

/** Library modules from an unpacked package: `files` maps entry paths to data. */
export function acsLibrariesFromFiles(files, { budget = 8 * 1024 * 1024 } = {}) {
  const libraries = [], lists = [];
  let total = 0;
  for (const [name, file] of files) {
    if (!file?.data) continue;
    if (/^loadacs(\.[a-z]{2,3})?(\.txt)?$/i.test(name)) lists.push(ascii(file.data, 0, Math.min(file.data.length, 1024 * 1024)));
    const match = ACS_LIBRARY.exec(name);
    if (!match) continue;
    if (file.data.length > 2 * 1024 * 1024) continue;
    total += file.data.length;
    if (total > budget) break;
    libraries.push({ name: match[1], bytes: new Uint8Array(file.data) });
  }
  return { libraries, lists };
}

/**
 * Library modules and LOADACS lists from a WAD. ZDoom reads libraries from the
 * `A_START`/`A_END` namespace, keyed by lump name.
 */
export function acsLibrariesFromWad(wad) {
  const bytes = new Uint8Array(wad.buffer);
  const libraries = [], lists = [];
  let inside = false;
  for (const lump of wad.lumps || []) {
    if (lump.name === 'A_START') { inside = true; continue; }
    if (lump.name === 'A_END') { inside = false; continue; }
    if (lump.name === 'LOADACS' && lump.size <= 1024 * 1024) {
      lists.push(ascii(bytes, lump.start, lump.size));
      continue;
    }
    if (!inside || lump.size > 2 * 1024 * 1024) continue;
    libraries.push({ name: lump.name, bytes: bytes.subarray(lump.start, lump.start + lump.size) });
  }
  return { libraries, lists };
}

/**
 * Picks the libraries a game actually loads: LOADACS order and spelling win, so a
 * package that names `THEACS` gets `acs/THEACS.o` even on a case-sensitive
 * filesystem. Libraries nobody loads are ignored, exactly as GZDoom ignores them.
 */
export function selectAcsLibraries(lists, libraries) {
  const byName = new Map(libraries.map(library => [library.name.toLowerCase(), library]));
  const selected = [], missing = [];
  for (const text of Array.isArray(lists) ? lists : [lists]) {
    for (const name of loadacsNames(text)) {
      const library = byName.get(name.toLowerCase());
      if (!library) { missing.push(name); continue; }
      if (!selected.some(entry => entry.name.toLowerCase() === library.name.toLowerCase())) selected.push(library);
    }
  }
  return { libraries: selected, missing };
}
