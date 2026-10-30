/**
 * ZDoom's ANIMDEFS: which surfaces animate, and how fast.
 *
 * Doom's own animations are hard-coded lump ranges (`NUKAGE1`-`NUKAGE3`, and whatever an
 * ANIMATED lump adds). A PK3 usually defines its animations here instead, and it is not
 * decoration: Lullaby's waterfalls, teal walls and spinning stars are three ANIMDEFS
 * entries, and without them those surfaces sit frozen on their first frame.
 *
 * Only the picture-frame forms are animations this engine can draw — `pic`/`tics` and the
 * `range` shorthand. GZDoom's shader animations (`warp`, `warp2`, `fbm`, `noise`, `stripe`)
 * move texels over a still image and are named in the report instead of being faked.
 */

const MAX_SOURCES = 32;
const MAX_SEQUENCES = 256;
const MAX_FRAMES = 4096;
const DEFAULT_TICS = 8;

/**
 * The names a `X Range Y` declaration covers.
 *
 * The lumps between the two names animate, not just the endpoints, and the names are
 * numbered: `PSTAR01 Range PSTAR12` is twelve frames. A pair that is not numbered that way
 * falls back to the two names it names.
 */
export function rangeNames({ from, to }) {
  const parse = name => {
    const match = /^(.*?)(\d+)$/.exec(String(name));
    return match ? { prefix: match[1].toUpperCase(), value: Number(match[2]), width: match[2].length } : null;
  };
  const start = parse(from), end = parse(to);
  if (!start || !end || start.prefix !== end.prefix || end.value <= start.value || end.value - start.value > 255) return [from, to];
  const names = [];
  for (let value = start.value; value <= end.value; value++) names.push(`${start.prefix}${String(value).padStart(start.width, '0')}`);
  return names;
}

/** Strips comments the way the engine's own parsers do, so quoting does not confuse them. */
function tokenize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Reads one or more ANIMDEFS sources.
 *
 * Returns `{ sequences, effects, switches }`: `sequences` in declaration order, each
 * `{ kind, frames: [{ name, tics }] }`; `effects` the shader animations that were named;
 * `switches` how many switch definitions were seen (a switch is not an animation).
 */
export function parseSurfaceAnimations(sources = [], { warn } = {}) {
  const sequences = [], effects = new Set();
  let switches = 0, framesSeen = 0;
  for (const source of sources.slice(0, MAX_SOURCES)) {
    if (!source) continue;
    const tokens = tokenize(String(source));
    for (let index = 0; index < tokens.length; index++) {
      const keyword = tokens[index].toLowerCase();
      if (keyword === 'flat' || keyword === 'texture') {
        const kind = keyword;
        let cursor = index + 1;
        if ((tokens[cursor] || '').toLowerCase() === 'optional') cursor++;
        const name = tokens[cursor++];
        if (!name) break;
        const frames = [];
        let tics = DEFAULT_TICS, range = null;
        if ((tokens[cursor] || '').toLowerCase() === 'range') {
          cursor++;
          const end = tokens[cursor++];
          if (!end) break;
          if ((tokens[cursor] || '').toLowerCase() === 'tics') { tics = Number(tokens[cursor + 1]) || DEFAULT_TICS; cursor += 2; }
          // `X Range Y` names every lump between the two, so the caller expands the run
          // against the artwork it actually imported; the two names keep it readable.
          range = { from: name, to: end, tics };
          frames.push({ name, tics }, { name: end, tics });
        } else if (tokens[cursor] === '{') {
          cursor++;
          while (cursor < tokens.length && tokens[cursor] !== '}') {
            const directive = tokens[cursor++].toLowerCase();
            if (directive === 'pic') {
              const frame = tokens[cursor++];
              let frameTics = tics;
              if ((tokens[cursor] || '').toLowerCase() === 'tics') { frameTics = Number(tokens[cursor + 1]) || tics; cursor += 2; }
              if (frame) frames.push({ name: frame, tics: frameTics });
            } else if (directive === 'allowdecals') continue;
            else if (directive === 'tics') { tics = Number(tokens[cursor + 1]) || tics; cursor += 2; }
            else if (directive === 'rand') cursor++;   // GZDoom random frames: keep the order it lists
          }
        } else {
          if ((tokens[cursor] || '').toLowerCase() === 'tics') { tics = Number(tokens[cursor + 1]) || DEFAULT_TICS; cursor += 2; }
          frames.push({ name, tics });
        }
        index = Math.max(index, cursor - 1);
        framesSeen += frames.length;
        if (!frames.length || frames.length > 64 || framesSeen > MAX_FRAMES) continue;
        if (sequences.length >= MAX_SEQUENCES) break;
        // Consecutive duplicates are what a `range` over missing artwork produces; they are
        // harmless but pointless, so they collapse to one frame (a still picture).
        const cleaned = frames.filter((frame, position) => frame.name !== frames[position - 1]?.name);
        if (cleaned.length) sequences.push({ kind, frames: cleaned, ...(range ? { range } : {}) });
      } else if (['warp', 'warp2', 'fbm', 'noise', 'stripe'].includes(keyword)) {
        // `warp picture X` / `warp2 texture X` / `fbm flat X` …: a shader over one image.
        const target = tokens[index + 2] || tokens[index + 1];
        if (target) effects.add(target);
        index += 2;
      } else if (keyword === 'switch') {
        switches++;
        // Consume until the next top-level keyword so the switch's `on pic` is not read as
        // an animation frame.
        let cursor = index + 1;
        while (cursor < tokens.length && !/^(switch|flat|texture|warp|warp2|fbm|noise|stripe)$/i.test(tokens[cursor])) cursor++;
        index = cursor - 1;
      } else if (keyword === 'cameratexture' || keyword === 'animateddoor') {
        // Read elsewhere; skipping the line keeps the parser from mistaking their names for
        // animation frames.
        index += keyword === 'cameratexture' ? 2 : 1;
      }
    }
  }
  if (effects.size && warn) warn(`${effects.size} surface animation(s) use GZDoom's shader effects (warp/fbm/noise/stripe), which are drawn as still frames: ${[...effects].slice(0, 6).join(', ')}${effects.size > 6 ? ', ...' : ''}.`);
  return { sequences, effects: [...effects], switches };
}
