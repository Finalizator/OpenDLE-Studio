// Reading id Tech `.map` files: Quake, Half-Life (Valve 220), Quake 2 and Quake 3.
//
// The format is a plain-text tree of entities and brushes:
//
//   { "classname" "worldspawn"
//     { ( x y z ) ( x y z ) ( x y z ) texture xoff yoff rot xscale yscale }
//     { "classname" "info_player_start" "origin" "0 0 32" }
//   }
//
// Three dialects matter and all three are read here:
//   * Standard (Quake 1)   — texture, then offset/rotate/scale numbers.
//   * Valve 220            — the same, followed by two explicit texture axes.
//   * Quake 3              — brush primitives, with the texture matrix in parentheses.
//
// The geometry TrenchBroom edits *is* these faces, so a parsed face maps onto our brush model one
// to one: three plane points plus a texture frame. Nothing is triangulated on the way in, which is
// what lets an imported brush be clipped, retextured and CSG'd like one drawn in the editor.

import { newId } from './project.js';
import { brushBounds, brushVertices } from './brushes.js';

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
 * This is how Valve 220 and TrenchBroom's Quake 3 output write the texture frame, and it is the
 * only face form in these games that carries real UV axes instead of offset/rotate/scale shorthand.
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
  io.expect('{');
  const faces = [];
  let patch = null, primitive = null;
  while (!io.eof() && !io.accept('}')) {
    const token = io.peek();
    if (token?.type === 'word' && /^patchDef[23]$/i.test(token.value)) {
      io.next();
      patch = { kind: token.value };
      if (io.peek()?.value === '{') skipBlock(io);
      else while (!io.eof() && !(io.peek().type === 'punct' && io.peek().value === '}')) io.next();
      continue;
    }
    // Quake 3 brush primitives carry a texture matrix instead of plane points. TrenchBroom does not
    // read them either ("Skipping brush primitive: currently not supported"), so they are skipped
    // with a warning rather than guessed at — a wrong plane would silently deform the map.
    if (token?.type === 'word' && /^brushDef[23x]?$/i.test(token.value)) {
      io.next();
      primitive = { kind: token.value };
      if (io.peek()?.value === '{') skipBlock(io);
      else while (!io.eof() && !(io.peek().type === 'punct' && io.peek().value === '}')) io.next();
      continue;
    }
    faces.push(readFace(io));
  }
  return { faces, patch, primitive };
}

function skipBlock(io) {
  io.expect('{');
  let depth = 1;
  while (!io.eof() && depth > 0) {
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
    io.expect('{');
    const entity = { properties: {}, brushes: [], patches: 0 };
    while (!io.eof() && !io.accept('}')) {
      const token = io.peek();
      if (token.type === 'punct' && token.value === '{') {
        const brush = readBrush(io);
        if (brush.patch) { entity.patches++; warnings.push(`${name}: ${brush.patch.kind} patch skipped (patches are Quake 3 curve surfaces)`); }
        else if (brush.primitive) {
          entity.primitives = (entity.primitives || 0) + 1;
          warnings.push(`${name}: ${brush.primitive.kind} brush primitive skipped (no plane points to read)`);
        } else if (brush.faces.length) entity.brushes.push(brush);
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
  let faceCount = 0, brushCount = 0;
  for (const entity of entities) for (const brush of entity.brushes) {
    brushCount++;
    for (const face of brush.faces) { faceCount++; formats.add(face.axes ? 'valve' : 'standard'); }
  }
  if (!worldspawn) warnings.push(`${name}: no worldspawn entity; the map may be malformed`);
  return {
    name, entities, warnings,
    stats: { entities: entities.length, brushes: brushCount, faces: faceCount },
    format: formats.has('valve') ? (formats.size > 1 ? 'mixed' : 'valve') : 'standard',
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
