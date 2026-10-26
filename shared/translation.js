/**
 * DECORATE/ZScript actor translations.
 *
 * A translation remaps palette colours, either by palette index range
 * (`128:151=80:111`), by a single target (`208:223=1`) or with direct RGB
 * (`0:255=[0,0,0]:[255,255,255]`). Sprites are baked with the game's palette, so
 * a translation is turned into a colour lookup and applied to the decoded pixels
 * when the asset is created.
 */

/** Pack an 8-bit colour into one integer key. */
export function packColour(red, green, blue) {
  return (red << 16) | (green << 8) | blue;
}

/** The translation specs an actor declares, flattened. A single `Translation`
 * property is a string; several become an array; a number or a name refers to the
 * game's translation table. */
export function translationSpecs(value) {
  if (Array.isArray(value)) return value.flatMap(entry => translationSpecs(entry));
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/**
 * Parses a `TRANSLATION` / `TRNSLATE` lump: `Name = "spec", "spec";` or one entry
 * per line. Returns the table in declaration order, because a numeric translation
 * indexes it.
 */
export function parseTranslationTable(sources) {
  const named = new Map(), ordered = [];
  for (const source of sources) {
    if (typeof source !== 'string' || !source) continue;
    for (const line of source.split('\n')) {
      const clean = line.replace(/\/\/[^\n]*/g, '').trim();
      if (!clean) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?);?$/.exec(clean);
      if (!match) continue;
      const specs = [...match[2].matchAll(/"([^"]*)"/g)].map(entry => entry[1].trim()).filter(Boolean);
      if (!specs.length) continue;
      named.set(match[1].toLowerCase(), specs);
      ordered.push({ name: match[1], specs });
    }
  }
  return { named, ordered };
}

const RANGE = /^(\d{1,3}):(\d{1,3})=(\d{1,3}):(\d{1,3})$/;
const RANGE_TO_ONE = /^(\d{1,3}):(\d{1,3})=(\d{1,3})$/;
const ONE = /^(\d{1,3})=(\d{1,3})$/;

/**
 * Turns translation specs into a colour lookup for one palette.
 * `palette` is a 768-byte PLAYPAL. Returns the lookup plus the specs that use
 * syntax this parser does not model, so the importer can report them.
 */
export function translationLookup(specs, palette) {
  const colours = [];
  for (let index = 0; index < 256; index++) {
    colours.push([palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]]);
  }
  const remap = new Map(), unsupported = [];
  const entries = specs.flatMap(spec => spec.split(',')).map(entry => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    let match;
    if ((match = RANGE.exec(entry))) {
      const [from, to, targetFrom, targetTo] = match.slice(1).map(Number);
      if (from > to || targetFrom > targetTo) { unsupported.push(entry); continue; }
      const span = Math.min(to - from, targetTo - targetFrom);
      for (let offset = 0; offset <= span; offset++) remap.set(from + offset, targetFrom + offset);
      continue;
    }
    if ((match = RANGE_TO_ONE.exec(entry))) {
      const [from, to, target] = match.slice(1).map(Number);
      if (from > to) { unsupported.push(entry); continue; }
      for (let index = from; index <= to; index++) remap.set(index, target);
      continue;
    }
    if ((match = ONE.exec(entry))) {
      const [from, target] = match.slice(1).map(Number);
      remap.set(from, target);
      continue;
    }
    unsupported.push(entry);
  }
  const lookup = new Map();
  for (const [from, to] of remap) {
    if (from > 255 || to > 255) continue;
    lookup.set(packColour(...colours[from]), packColour(...colours[to]));
  }
  return { lookup, unsupported, changed: lookup.size };
}

/** Applies a translation lookup to decoded RGBA pixels, returning a new buffer. */
export function applyTranslation(pixels, lookup) {
  const result = new Uint8ClampedArray(pixels);
  for (let offset = 0; offset < result.length; offset += 4) {
    if (!result[offset + 3]) continue;
    const target = lookup.get(packColour(result[offset], result[offset + 1], result[offset + 2]));
    if (target === undefined) continue;
    result[offset] = (target >> 16) & 0xff;
    result[offset + 1] = (target >> 8) & 0xff;
    result[offset + 2] = target & 0xff;
  }
  return result;
}
