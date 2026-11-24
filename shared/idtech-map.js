// Reading id Tech `.map` files: Quake, Half-Life (Valve 220), Quake 2 and Quake 3.
//
// The format is a plain-text tree of entities and brushes:
//
//   { "classname" "worldspawn"
//     { ( x y z ) ( x y z ) ( x y z ) texture xoff yoff rot xscale yscale }
//     { "classname" "info_player_start" "origin" "0 0 32" }
//   }
//
// Every face form Quad-era mappers write is read here:
//   * Standard (Quake 1)   — texture, then offset/rotate/scale numbers.
//   * Valve 220            — the same, followed by two explicit texture axes.
//   * Quake 2 / Hexen 2    — the Standard form plus a contents/flags/value triplet.
//   * Quake 3 legacy       — Quake 2's face text; Quake 3 Valve is Valve 220's.
//   * Quake 3 brush primitive (`brushDef`) — three plane points, then the face's texture basis in
//     parentheses. TrenchBroom parses these and drops the brush (its TODO 2427); here they are kept.
//
// The geometry TrenchBroom edits *is* these faces, so a parsed face maps onto our brush model one
// to one: three plane points plus a texture frame. Nothing is triangulated on the way in, which is
// what lets an imported brush be clipped, retextured and CSG'd like one drawn in the editor.

import { newId, MIN_TEXTURE_SCALE, MAX_TEXTURE_SCALE } from './project.js';
import { brushBounds, brushVertices, facePlane } from './brushes.js';
import { brushUvAxes, BRUSH_TEXTURE_SIZE } from './uv.js';

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/**
 * Split the text into tokens. Line numbers are carried so a broken file says where it broke.
 * Comments (`// …`) and entity comments (`// brush 0`) are dropped — they carry no geometry.
 */
function tokenize(text, name) {
  const tokens = [];
  let index = 0, line = 1;
  const length = text.length;
  while (index < length) {
    const character = text[index];
    if (character === '\n') { line++; index++; continue; }
    if (character === ' ' || character === '\t' || character === '\r') { index++; continue; }
    if (character === '/' && text[index + 1] === '/') {
      while (index < length && text[index] !== '\n') index++;
      continue;
    }
    if (character === '"') {
      let value = '', startLine = line;
      index++;
      while (index < length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < length) { value += text[index + 1]; index += 2; continue; }
        if (text[index] === '\n') line++;
        value += text[index++];
      }
      if (index >= length) throw new Error(`${name}: line ${startLine}: unterminated string`);
      index++;
      tokens.push({ type: 'string', value, line: startLine });
      continue;
    }
    if (character === '{' || character === '}' || character === '(' || character === ')' ||
      character === '[' || character === ']') {
      tokens.push({ type: 'punct', value: character, line });
      index++;
      continue;
    }
    let end = index;
    while (end < length && !/[\s{}()\[\]"]/.test(text[end])) end++;
    const word = text.slice(index, end);
    if (!word) { index++; continue; }
    if (NUMBER.test(word)) tokens.push({ type: 'number', value: Number(word), raw: word, line });
    else tokens.push({ type: 'word', value: word, line });
    index = end;
  }
  return tokens;
}

function reader(tokens, name) {
  let position = 0;
  const peek = (offset = 0) => tokens[position + offset];
  const next = () => tokens[position++];
  const eof = () => position >= tokens.length;
  const fail = (token, expected) => {
    const at = token ? `line ${token.line}` : 'end of file';
    throw new Error(`${name}: ${at}: expected ${expected}`);
  };
  const accept = value => {
    const token = peek();
    if (token && token.type === 'punct' && token.value === value) { position++; return true; }
    return false;
  };
  const expect = value => { if (!accept(value)) fail(peek(), `"${value}"`); };
  const number = () => {
    const token = peek();
    if (!token || token.type !== 'number') fail(token, 'a number');
    position++;
    return token.value;
  };
  /** A texture name: a bare word, or a quoted string that may contain spaces. */
  const word = () => {
    const token = peek();
    if (!token || (token.type !== 'word' && token.type !== 'string')) fail(token, 'a value');
    position++;
    return token.value;
  };
  return { peek, next, eof, accept, expect, number, word, fail, get position() { return position; } };
}

/** `( x y z )` */
function readPoint(io) {
  io.expect('(');
  const point = [io.number(), io.number(), io.number()];
  io.expect(')');
  return point;
}

/**
 * A texture axis pair: `[ ux uy uz uoffset ] [ vx vy vz voffset ]`.
 *
 * This is how Valve 220 and TrenchBroom's Quake 3 output write the texture frame. Unlike a brush
 * primitive's basis it keeps the offset/rotate/scale shorthand and only adds the axes, so the face
 * converts to our fields exactly.
 */
function readAxes(io) {
  const groups = [];
  while (groups.length < 2 && io.peek()?.type === 'punct' && io.peek().value === '[') {
    io.expect('[');
    groups.push([io.number(), io.number(), io.number(), io.number()]);
    io.expect(']');
  }
  return { u: groups[0], v: groups[1] };
}

/** `( x y z [shift] )` — one axis of a Quake 3 texture basis, shift in texels when present. */
function readAxisVector(io) {
  io.expect('(');
  const axis = [];
  while (io.peek()?.type === 'number' && axis.length < 4) axis.push(io.number());
  io.expect(')');
  return axis;
}

/**
 * One Quake 3 brush-primitive face:
 *
 *   `( p ) ( p ) ( p ) ( ( ux uy uz [shift] ) ( vx vy vz [shift] ) ) material [contents flags value]`
 *
 * The three points are ordinary plane points — often nowhere near the brush — so the geometry is
 * read exactly like any other face. The bracketed pair is the whole texture projection: `s` is
 * `dot(p, u)` and `t` is `dot(p, v)` in texture repeats, with the axis length carrying the scale
 * (0.015625 is one repeat per 64 units, the same as scale 1) and its direction carrying the
 * rotation. The basis is kept on the face as `uvBasis`, because offset/rotation/scale cannot express
 * every basis; the inspector's numbers are derived from it once the outward normal is known.
 */
function readPrimitiveFace(io) {
  const points = [readPoint(io), readPoint(io), readPoint(io)];
  io.expect('(');
  const u = readAxisVector(io);
  const v = readAxisVector(io);
  io.expect(')');
  const texture = io.word();
  // Quake 3's surface triplet. Nothing in the editor reads it yet, but dropping it would lose
  // `SURF_NODRAW` and friends, so it is carried on the face as written.
  const surface = [];
  while (io.peek()?.type === 'number' && surface.length < 3) surface.push(io.number());
  return { points, texture, uvBasis: { u, v }, ...(surface.length ? { surface } : {}) };
}

/**
 * One brush face.
 *
 * Two forms are read, and they differ only in what comes after the texture:
 *   * `texture xoff yoff rot xscale yscale [contents flags value]` — Quake 1, Quake 2, Quake 3 legacy.
 *   * `texture [ ux uy uz uoff ] [ vx vy vz voff ] rot xscale yscale` — Valve 220, and the Quake 3
 *     form TrenchBroom writes.
 *
 * Everything after the texture is read leniently: exporters disagree about which trailing numbers
 * they include, and a missing one is a default, not a broken file.
 */
function readFace(io) {
  const points = [readPoint(io), readPoint(io), readPoint(io)];
  const texture = io.word();
  if (io.peek()?.type === 'punct' && io.peek().value === '[') {
    const axes = readAxes(io);
    const trailing = [];
    while (io.peek()?.type === 'number' && trailing.length < 3) trailing.push(io.number());
    const [rotation = 0, scaleX = 1, scaleY = 1] = trailing;
    return {
      points, texture, axes,
      offsetX: axes.u?.[3] ?? 0, offsetY: axes.v?.[3] ?? 0,
      rotation: rotation || 0, scaleX: scaleX || 1, scaleY: scaleY || 1,
    };
  }
  const numbers = [];
  while (io.peek()?.type === 'number') numbers.push(io.number());
  const [offsetX = 0, offsetY = 0, rotation = 0, scaleX = 1, scaleY = 1] = numbers;
  return { points, texture, offsetX, offsetY, rotation: rotation || 0, scaleX: scaleX || 1, scaleY: scaleY || 1 };
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = a => { const length = Math.hypot(...a) || 1; return a.map(value => value / length); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * A brush is `{ … }` of faces. A Quake 3 patch is written in the same block; it is recorded and
 * skipped, but the block still has to be closed here — returning early once left the brush's own
 * `}` behind and the rest of the file was then read as entities.
 */
function readBrush(io) {
  const opening = io.peek();
  io.expect('{');
  const faces = [];
  let patch = null, primitive = null;
  while (true) {
    if (io.accept('}')) break;
    if (io.eof()) io.fail(opening, `"}" to close the brush opened on line ${opening.line}`);
    const token = io.peek();
    if (token?.type === 'word' && /^patchDef[23]$/i.test(token.value)) {
      io.next();
      patch = { kind: token.value };
      if (io.peek()?.value === '{') skipBlock(io);
      else while (!io.eof() && !(io.peek().type === 'punct' && io.peek().value === '}')) io.next();
      continue;
    }
    // Quake 3 writes a brush as `brushDef { … }`, with each face carrying a texture basis instead of
    // offset/rotate/scale. Doom 3 and Quake 4 use the same word for a plane pair rather than three
    // points, which is a different format and is refused rather than misread.
    if (token?.type === 'word' && /^brushDef\d*$/i.test(token.value)) {
      io.next();
      if (io.peek()?.value !== '{') io.fail(io.peek(), `"{" after ${token.value}`);
      // A Quake 3 face opens `( x y z )`, a Doom 3 one `( ( nx ny nz ) ( distance ) )`.
      const doomPlane = io.peek(2)?.type === 'punct' && io.peek(2).value === '(';
      if (doomPlane) {
        skipBlock(io);
        primitive = { kind: token.value, reason: `${token.value} plane form (Doom 3 / Quake 4) is not a Quake 3 brush primitive` };
        continue;
      }
      const primitiveStart = io.peek();
      io.expect('{');
      while (!io.accept('}')) {
        if (io.eof()) io.fail(primitiveStart, `"}" to close the ${token.value} opened on line ${primitiveStart.line}`);
        faces.push(readPrimitiveFace(io));
      }
      primitive = { kind: token.value };
      continue;
    }
    faces.push(readFace(io));
  }
  return { faces, patch, primitive };
}

function skipBlock(io) {
  const opening = io.peek();
  io.expect('{');
  let depth = 1;
  while (depth > 0) {
    if (io.eof()) io.fail(opening, `"}" to close the block opened on line ${opening.line}`);
    const token = io.next();
    if (token.type === 'punct' && token.value === '{') depth++;
    if (token.type === 'punct' && token.value === '}') depth--;
  }
}

/**
 * Parse a whole map file.
 *
 * Returns entities in file order with their properties and brushes. Callers convert; nothing here
 * knows about projects, which keeps the parser testable against real map text.
 */
export function parseIdTechMap(text, { name = 'map' } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${name}: the file is empty`);
  const io = reader(tokenize(text, name), name);
  const entities = [];
  const warnings = [];
  while (!io.eof()) {
    if (!io.peek() || io.peek().type !== 'punct' || io.peek().value !== '{') io.fail(io.peek(), 'an entity "{"');
    const opening = io.peek();
    io.expect('{');
    const entity = { properties: {}, brushes: [], patches: 0 };
    while (true) {
      if (io.accept('}')) break;
      // A file that ends here is a truncated download or a bad edit, not a complete map. Ending the
      // loop at end-of-file used to accept half an entity — and half a level — as if it were whole.
      if (io.eof()) io.fail(opening, `"}" to close the entity opened on line ${opening.line}`);
      const token = io.peek();
      if (token.type === 'punct' && token.value === '{') {
        const brush = readBrush(io);
        if (brush.patch) { entity.patches++; warnings.push(`${name}: ${brush.patch.kind} patch skipped (patches are Quake 3 curve surfaces)`); }
        else if (brush.faces.length) {
          entity.brushes.push(brush);
          if (brush.primitive) entity.primitives = (entity.primitives || 0) + 1;
        } else if (brush.primitive) {
          entity.primitives = (entity.primitives || 0) + 1;
          warnings.push(`${name}: ${brush.primitive.reason || `${brush.primitive.kind} brush has no faces and was skipped`}`);
        }
        continue;
      }
      if (token.type === 'string' || token.type === 'word') {
        const key = io.word();
        const value = io.word();
        // Repeated keys are legal; the last one wins, as every compiler does.
        entity.properties[key] = value;
        continue;
      }
      io.fail(token, 'a property or a brush');
    }
    entities.push(entity);
  }
  if (!entities.length) throw new Error(`${name}: no entities found`);
  const worldspawn = entities.find(entity => entity.properties.classname === 'worldspawn');
  const formats = new Set();
  let faceCount = 0, brushCount = 0, primitiveCount = 0;
  for (const entity of entities) {
    primitiveCount += entity.primitives || 0;
    for (const brush of entity.brushes) {
      brushCount++;
      for (const face of brush.faces) {
        faceCount++;
        formats.add(face.uvBasis ? 'primitive' : face.axes ? 'valve' : 'standard');
      }
    }
  }
  if (!worldspawn) warnings.push(`${name}: no worldspawn entity; the map may be malformed`);
  return {
    name, entities, warnings,
    stats: { entities: entities.length, brushes: brushCount, faces: faceCount, primitives: primitiveCount },
    format: formats.size === 1 ? [...formats][0] : formats.size ? 'mixed' : 'standard',
  };
}

// ---------------------------------------------------------------------------------------------------
// Converting a parsed map into project content
// ---------------------------------------------------------------------------------------------------

/** Entity classes that mean "the player starts here", across the games this reads. */
const PLAYER_CLASSES = new Set([
  'info_player_start', 'info_player_start2', 'info_player_deathmatch', 'info_player_coop',
  'info_player_teamspawn', 'info_player_team1', 'info_player_team2', 'info_player_allied',
  'info_player_axis', 'info_player_rebel', 'info_player_observer',
]);

/** A light entity in any of these games. */
const isLight = classname => /^light/i.test(classname) || /_light$/i.test(classname);

const toNumber = (value, fallback = 0) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * A colour key from a Quake map: `_color` is `"r g b"` in 0-1 floats, `color` in 0-255.
 * Anything unreadable falls back to white, which is what the engine's own default is.
 */
function quakeColor(properties) {
  const hex = (r, g, b) => `#${[r, g, b].map(value =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
  if (typeof properties._color === 'string') {
    const parts = properties._color.trim().split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      const scaled = parts.every(value => value <= 1 && value >= 0) ? parts.map(value => value * 255) : parts;
      return hex(...scaled);
    }
  }
  if (typeof properties.color === 'string') {
    const parts = properties.color.trim().split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) return hex(...parts);
  }
  return '#ffffff';
}

/** `"0 0 32"` → `[0, 0, 32]`. */
function readVector(value, fallback = [0, 0, 0]) {
  if (typeof value !== 'string') return fallback;
  const parts = value.trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : fallback;
}

const clampTextureScale = value => {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.max(value, MIN_TEXTURE_SCALE), MAX_TEXTURE_SCALE);
};

/**
 * The offset / rotation / scale a basis looks like in the face inspector.
 *
 * Faces keep their basis (see `brushFaceUv`), which is what keeps the projection exact; these
 * numbers are the equivalent the panel shows, and what takes over if a mapper edits them.
 */
export function paraxialFromBasis(basis, normal) {
  const frame = brushUvAxes(normal);
  const alpha = dot(basis.u, frame.u), beta = dot(basis.u, frame.v);
  const gamma = dot(basis.v, frame.u), delta = dot(basis.v, frame.v);
  const uLength = Math.hypot(alpha, gamma), vLength = Math.hypot(beta, delta);
  const usable = uLength > 1e-9 && vLength > 1e-9;
  return {
    rotation: usable ? Math.atan2(gamma, alpha) * 180 / Math.PI : 0,
    scaleX: clampTextureScale(usable ? 1 / (BRUSH_TEXTURE_SIZE * uLength) : 1),
    scaleY: clampTextureScale(usable ? 1 / (BRUSH_TEXTURE_SIZE * vLength) : 1),
    offsetX: (Number(basis.u?.[3]) || 0) * BRUSH_TEXTURE_SIZE,
    offsetY: (Number(basis.v?.[3]) || 0) * BRUSH_TEXTURE_SIZE,
  };
}

/**
 * Fill the inspector's numbers for every face that arrived as a basis.
 *
 * The normal is only final after `convertBrush` has decided the winding, and the frame depends on
 * the normal, so this runs last. The basis itself stays on the face untouched, because it is the
 * projection that is actually drawn.
 */
function materialiseUv(faces) {
  return faces.map(face => {
    if (!face.uvBasis) return face;
    return { ...face, ...paraxialFromBasis(face.uvBasis, facePlane(face).normal) };
  });
}

/**
 * Turn one parsed brush into our brush, or explain why it cannot be one.
 *
 * A Quake face lists its three plane points clockwise seen from outside, which is the opposite
 * winding to ours, so the points are swapped on the way in. The result is then checked: a brush
 * with no closed corner set (a malformed or non-convex brush, which a compiler would split) is
 * refused with a reason instead of being drawn as garbage.
 */
function convertBrush(brush, index, warnings, fileName) {
  const faces = [];
  for (const face of brush.faces) {
    const [a, b, c] = face.points;
    // Reject a degenerate plane up front: three collinear points cannot bound anything.
    const normal = cross(sub(b, a), sub(c, a));
    if (Math.hypot(...normal) < 1e-6) {
      warnings.push(`${fileName}: brush ${index}: a face has no area and was dropped`);
      continue;
    }
    faces.push({
      points: [a, c, b],
      texture: null,
      textureName: face.texture,
      offsetX: face.offsetX || 0,
      offsetY: face.offsetY || 0,
      scaleX: face.scaleX || 1,
      scaleY: face.scaleY || 1,
      rotation: face.rotation || 0,
      ...(face.axes ? { axes: face.axes } : {}),
      ...(face.uvBasis ? { uvBasis: face.uvBasis } : {}),
      ...(face.surface ? { surface: face.surface } : {}),
    });
  }
  if (faces.length < 4) return { error: 'fewer than four faces' };
  const candidate = { id: newId('brush'), name: `Brush ${index}`, layerId: 'default',
    visible: true, locked: false, faces };
  let vertices = brushVertices(candidate);
  if (vertices.length < 4) {
    // Some exporters write the opposite winding; flipping every face is cheaper than failing.
    const flipped = { ...candidate, faces: faces.map(face => ({ ...face, points: [face.points[0], face.points[2], face.points[1]] })) };
    if (brushVertices(flipped).length >= 4) { candidate.faces = flipped.faces; vertices = brushVertices(candidate); }
  }
  if (vertices.length < 4) return { error: 'its faces do not enclose a volume' };
  if (candidate.faces.some(face => face.uvBasis)) candidate.faces = materialiseUv(candidate.faces);
  candidate.bounds = brushBounds(candidate);
  return { brush: candidate };
}

/**
 * The project content of a parsed map: brushes, objects, and a record of the source.
 *
 * `offset` shifts everything by a world vector, which is how an imported map is dropped beside an
 * existing one instead of inside it.
 */
export function idTechContent(parsed, { offset = [0, 0, 0], keepPlayer = true } = {}) {
  const warnings = [...parsed.warnings];
  const brushes = [];
  const entities = [];
  const worldspawn = parsed.entities.find(entity => entity.properties.classname === 'worldspawn');
  let brushIndex = 0;
  let skipped = 0;
  let playerSeen = false;
  for (const entity of parsed.entities) {
    for (const brush of entity.brushes) {
      const result = convertBrush(brush, brushIndex++, warnings, parsed.name);
      if (result.error) { skipped++; warnings.push(`${parsed.name}: brush ${brushIndex - 1} skipped: ${result.error}`); continue; }
      if (offset.some(value => value)) {
        result.brush.faces = result.brush.faces.map(face => ({
          ...face,
          points: face.points.map(point => [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]]),
        }));
        result.brush.bounds = brushBounds(result.brush);
      }
      brushes.push(result.brush);
    }
    const classname = entity.properties.classname;
    if (!classname || classname === 'worldspawn') continue;
    const origin = readVector(entity.properties.origin, [0, 0, 0]);
    const position = { x: origin[0] + offset[0], y: origin[1] + offset[1], z: origin[2] + offset[2] };
    const angle = toNumber(entity.properties.angle, 0);
    let type = 'decoration';
    if (isLight(classname)) type = 'light';
    if (PLAYER_CLASSES.has(classname) && keepPlayer && !playerSeen) { type = 'player'; playerSeen = true; }
    const entity_ = {
      id: newId('entity'),
      name: classname,
      type,
      x: Math.round(position.x * 100) / 100,
      y: Math.round(position.y * 100) / 100,
      angle,
    };
    // Our model stores elevation above the sector floor; a brush map has no sectors, so the
    // absolute height is kept as elevation and nothing is lost on the way in.
    if (position.z) entity_.elevation = Math.round(position.z * 100) / 100;
    if (type === 'light') {
      // Quake's `light` is a brightness in its own units (300 is a room light); ours is 0-10, so it
      // is scaled rather than copied. `light_radius`/`_color` are kept in mapProperties as well.
      entity_.light = {
        color: quakeColor(entity.properties),
        intensity: Math.max(0, Math.min(10, toNumber(entity.properties.light, 300) / 300)),
        radius: Math.max(1, Math.min(8192, toNumber(entity.properties.light_radius ?? entity.properties._radius, 300))),
      };
    }
    entity_.mapClassname = classname;
    entity_.mapProperties = { ...entity.properties };
    delete entity_.mapProperties.classname;
    entities.push(entity_);
  }
  if (!playerSeen && keepPlayer) {
    // Every project needs a player start. Put it where the map's geometry is, not at the origin of
    // a world that may be thousands of units away.
    const box = brushes.length ? brushes.reduce((bounds, brush) => {
      const b = brush.bounds;
      return { minX: Math.min(bounds.minX, b.x), maxX: Math.max(bounds.maxX, b.x + b.width),
        minY: Math.min(bounds.minY, b.y), maxY: Math.max(bounds.maxY, b.y + b.depth) };
    }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
      : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    entities.push({
      id: newId('entity'), name: 'Player start', type: 'player',
      x: Math.round((box.minX + box.maxX) / 2), y: Math.round((box.minY + box.maxY) / 2), angle: 0,
    });
    warnings.push(`${parsed.name}: no player start in the map; one was placed at its centre`);
  }
  return {
    brushes, entities, warnings,
    source: {
      format: 'idtech', dialect: parsed.format, file: parsed.name,
      worldspawn: { ...(worldspawn?.properties || {}) },
      stats: { ...parsed.stats, brushes: brushes.length, skippedBrushes: skipped },
    },
  };
}

/** Add a parsed map to a project, keeping what is already there. */
export function applyIdTechMap(project, parsed, { offset = [0, 0, 0] } = {}) {
  // A project has exactly one player start. An imported map's own starts become ordinary objects
  // carrying their class, so nothing is lost and the existing start keeps working.
  const keepPlayer = !project.map.entities.some(entity => entity.type === 'player');
  const content = idTechContent(parsed, { offset, keepPlayer });
  project.map.brushes = [...(project.map.brushes || []), ...content.brushes];
  project.map.entities = [...project.map.entities, ...content.entities];
  project.mapSource = content.source;
  return content;
}

/**
 * A fresh project holding only the imported map.
 *
 * The starter room, its objects and their rules are deliberately absent: an imported Quake map is
 * the level, and leaving a Doom starter room behind would put a hole in someone else's geometry.
 */
export function projectFromIdTechMap(parsed, { createProject }) {
  const project = createProject();
  const message = parsed.entities.find(entity => entity.properties.classname === 'worldspawn')?.properties.message;
  project.title = (message && message.trim()) || parsed.name.replace(/\.map$/i, '');
  project.map = { vertices: [], walls: [], sectors: [], entities: [], brushes: [] };
  project.events = [];
  applyIdTechMap(project, parsed);
  return project;
}
