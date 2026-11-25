// Reading a compiled Quake map into brushes.
//
// `.map` is source: planes and textures the mapper typed. A `.bsp` is what the compiler made of it —
// the same world, already split into convex leaves of solid and empty space, with the texture
// assignment baked into a per-surface texinfo. That split is *exactly* the shape of a brush, so a
// compiled Quake or Half-Life map imports as brushes rather than as a picture of one.
//
// Quake 1 and Half-Life (versions 29 and 30) keep the world only in the BSP tree: a solid leaf's
// volume is bounded by the planes of the nodes on the path to it, so walking the tree while
// clipping the model's bounding box by each node plane yields that leaf's convex hull — the classic
// `bsp2map` conversion. Quake 2 and Quake 3 (38, 46, 47) ship an explicit brush lump instead, and
// that is read directly.
//
// The result is the same shape `parseIdTechMap` returns, so everything downstream — brush
// conversion, entity handling, the layout importer — is shared with `.map` and cannot drift.

import { faceFromPlane } from './brushes.js';
import { parseIdTechMap } from './idtech-map.js';

/** `CONTENTS_SOLID` in Quake, Half-Life and Quake 2; every other leaf is air, water, slime or sky. */
const CONTENTS_SOLID = -2;
/** A face no texinfo named. The renderer falls back to its own material, as for any unknown texture. */
const DEFAULT_TEXTURE = null;
/** A compiled map that produced more brushes than this stops rather than exhausting memory. */
export const MAX_BSP_BRUSHES = 20000;
/**
 * How far off a plane a corner read from float32 planes may sit, in map units.
 *
 * A Quake map is measured in units a player is 56 of, so a hundredth of one is not geometry — but it
 * is the size of the error the file itself carries, and refusing it threw away nine brushes in ten.
 */
const CORNER_TOLERANCE = 1e-2;
/** No Quake map is a hundred thousand units across; a bigger corner is a broken plane set. */
const MAX_CORNER = 100000;
/**
 * The tool materials a compiled map draws nothing with.
 *
 * `clip` is solid and invisible, `caulk` is the back of a wall the compiler added, `hint` and
 * `lightgrid` are volumes the mapper never sees. A brush made only of these is real collision and no
 * artwork, so it imports invisible: the renderer skips it and the collider does not. Half-Life has
 * none of them — its materials are ordinary artwork names — so this only ever bites on Quake 2/3.
 */
const TOOL_MATERIAL = /(^|\/)(caulk|clip|weapclip|monsterclip|botclip|nodraw|hint|skip|lightgrid|trigger|areaportal|clusterportal|donotenter|origin|slick|nodrop)$/i;

/** A brush of nothing but tool materials is geometry the game hides. */
function invisibleBrush(faces) {
  return faces.length > 0 && faces.every(face => TOOL_MATERIAL.test(face.texture || ''));
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const magnitude = a => Math.hypot(a[0], a[1], a[2]);
const normalize = a => { const length = magnitude(a) || 1; return [a[0] / length, a[1] / length, a[2] / length]; };

/** The game a compiled BSP was made for, by the format version in its header. */
const BSP_FORMATS = new Map([
  [29, 'Quake'],
  [30, 'Half-Life'],
  [38, 'Quake 2'],
  [46, 'Quake 3'],
  [47, 'Quake 3 Team Arena'],
]);

export const bspEngine = version => BSP_FORMATS.get(Number(version)) || null;

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** How many lumps a file of this version has. */
const lumpCount = version => (version >= 46 ? 17 : version === 38 ? 19 : 15);

/**
 * The header of a compiled map, or null when the bytes are not one.
 *
 * Quake 1 and Half-Life start with the version itself; Quake 2 and Quake 3 start with the ASCII
 * magic `IBSP` and put the version next to it. After that comes a directory of lumps whose offsets
 * must land inside the file — a file whose version matches but whose offsets do not is not a BSP,
 * and calling it one would send someone hunting for a bug in the importer instead.
 */
export function bspInfo(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const view = viewOf(bytes);
  const magic = bytes[0] === 0x49 && bytes[1] === 0x42 && bytes[2] === 0x53 && bytes[3] === 0x50;
  const directory = magic ? 8 : 4;
  const version = view.getInt32(magic ? 4 : 0, true);
  const engine = bspEngine(version);
  if (!engine) return null;
  const count = lumpCount(version);
  if (bytes.length < directory + count * 8) return null;
  const lumps = [];
  for (let index = 0; index < count; index++) {
    const offset = view.getInt32(directory + index * 8, true);
    const length = view.getInt32(directory + index * 8 + 4, true);
    if (offset < directory + count * 8 || length < 0 || offset + length > bytes.length) return null;
    lumps.push({ offset, length });
  }
  return { version, engine, magic, directory, lumps, count };
}

/** One lump read as fixed-size records. */
function records(view, lump, size, read) {
  if (!lump || lump.length <= 0) return [];
  const count = Math.floor(lump.length / size);
  const out = new Array(count);
  for (let index = 0; index < count; index++) out[index] = read(view, lump.offset + index * size);
  return out;
}

/** A fixed-length C string at a lump offset. */
function text(bytes, offset, length) {
  if (offset < 0 || offset + length > bytes.length) return '';
  const slice = new Uint8Array(bytes.buffer, bytes.byteOffset + offset, length);
  return new TextDecoder('latin1').decode(slice).split('\0')[0];
}

const planeReader = (view, at) => ({
  normal: [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)],
  distance: view.getFloat32(at + 12, true),
});

// ---------------------------------------------------------------------------------------------------
// Polygons and convex hulls
// ---------------------------------------------------------------------------------------------------

/**
 * A brush as the half-spaces it is: every plane points outward and its volume is where
 * `dot(normal, p) <= distance` holds for all of them.
 *
 * This is how a compiled map describes space — a leaf's planes, or a Quake 3 brush's sides — so it is
 * what is carried while walking the tree. No clipping is needed and no corner is invented: the planes
 * are the file's own numbers, and the brush's corners are derived from them, exactly as they are for
 * a brush the mapper drew.
 */
function boxPlanes(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  return [
    { normal: [-1, 0, 0], distance: -x0, texture: DEFAULT_TEXTURE },
    { normal: [1, 0, 0], distance: x1, texture: DEFAULT_TEXTURE },
    { normal: [0, -1, 0], distance: -y0, texture: DEFAULT_TEXTURE },
    { normal: [0, 1, 0], distance: y1, texture: DEFAULT_TEXTURE },
    { normal: [0, 0, -1], distance: -z0, texture: DEFAULT_TEXTURE },
    { normal: [0, 0, 1], distance: z1, texture: DEFAULT_TEXTURE },
  ];
}

/**
 * The corners three planes meet at, kept when every other plane still contains them.
 *
 * Compiled planes are floats: a corner three of them agree on can miss a fourth by a hundredth of a
 * unit, and demanding more precision threw away nine brushes in ten of a real map.
 */
function polytopeCorners(planes) {
  const corners = [];
  for (let a = 0; a < planes.length - 2; a++) {
    for (let b = a + 1; b < planes.length - 1; b++) {
      for (let c = b + 1; c < planes.length; c++) {
        const point = planeIntersection(planes[a], planes[b], planes[c]);
        if (!point) continue;
        if (!planes.every(plane => dot(plane.normal, point) - plane.distance <= CORNER_TOLERANCE)) continue;
        if (!corners.some(other => magnitude(sub(other, point)) < CORNER_TOLERANCE)) corners.push(point);
      }
    }
  }
  return corners;
}

/**
 * Turn a set of half-spaces into brush faces, each face emitted from its own plane.
 *
 * A plane that no corner touches is redundant — the walk to a leaf accumulates a plane per step, and
 * most of them are cut away by the ones below — so those are dropped instead of becoming a face with
 * no area. The three points of each face come from the plane itself rather than from corners, which
 * keeps a brush's geometry exactly the file's numbers.
 */
function planesToBrush(planes) {
  const unique = [];
  const seen = new Set();
  for (const plane of planes) {
    const length = magnitude(plane.normal);
    if (!Number.isFinite(length) || length < 1e-6 || !Number.isFinite(plane.distance)) continue;
    const normal = normalize(plane.normal), distance = plane.distance / length;
    const key = `${normal.map(value => value.toFixed(3)).join(',')}|${distance.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ normal, distance, texture: plane.texture ?? DEFAULT_TEXTURE });
  }
  if (unique.length < 4) return null;
  const corners = polytopeCorners(unique);
  if (corners.length < 4) return null;
  // A set of nearly parallel planes ("skip", "caulk", bot clip) meets at absurd distances.
  if (corners.some(point => magnitude(point) > MAX_CORNER)) return null;
  const faces = [];
  for (const plane of unique) {
    let on = 0;
    for (const point of corners) {
      if (Math.abs(dot(plane.normal, point) - plane.distance) <= CORNER_TOLERANCE) on++;
    }
    if (on < 3) continue;
    const face = faceFromPlane(plane.normal, plane.distance, { textureName: plane.texture ?? undefined });
    faces.push({ points: face.points, texture: plane.texture ?? DEFAULT_TEXTURE });
  }
  return faces.length >= 4 ? { faces } : null;
}

function planeIntersection(a, b, c) {
  const bc = cross(b.normal, c.normal);
  const denominator = dot(a.normal, bc);
  if (Math.abs(denominator) < 1e-6) return null;
  const ca = cross(c.normal, a.normal), ab = cross(a.normal, b.normal);
  return mul(add(add(mul(bc, a.distance), mul(ca, b.distance)), mul(ab, c.distance)), 1 / denominator);
}

// ---------------------------------------------------------------------------------------------------
// Quake 1 and Half-Life: the world lives in the tree
// ---------------------------------------------------------------------------------------------------

/**
 * A face record, by whichever layout its lump length proves.
 *
 * Half-Life writes a 16-bit plane index (20 bytes a face); Quake's own writer uses a 32-bit one
 * (22 bytes). Only the plane and texinfo are read from a face, so an unrecognised layout costs the
 * texture assignment and nothing else — the geometry comes from the node planes.
 */
const FACE_LAYOUTS = [
  { size: 20, plane: (v, at) => v.getInt16(at, true), texinfo: (v, at) => v.getInt16(at + 10, true) },
  { size: 22, plane: (v, at) => v.getInt32(at, true), texinfo: (v, at) => v.getInt16(at + 12, true) },
  { size: 20, plane: (v, at) => v.getInt32(at, true), texinfo: (v, at) => v.getInt16(at + 12, true) },
];

function faceLayout(view, lump, planes, texinfoCount) {
  for (const layout of FACE_LAYOUTS) {
    if (lump.length < layout.size || lump.length % layout.size !== 0) continue;
    const count = Math.min(Math.floor(lump.length / layout.size), 256);
    let sane = 0;
    for (let index = 0; index < count; index++) {
      const at = lump.offset + index * layout.size;
      const plane = layout.plane(view, at), info = layout.texinfo(view, at);
      if (plane >= 0 && plane < planes && info >= 0 && info < texinfoCount) sane++;
    }
    if (sane === count) return layout;
  }
  return null;
}

/** The name of the texture a miptex index refers to. */
function miptexNames(view, bytes, lump) {
  const names = [];
  if (!lump || lump.length < 8) return names;
  let count = view.getInt32(lump.offset, true);
  // Quake 2 writes a short count in front of the same offsets; a count that does not fit the lump
  // is the other one.
  if (count < 0 || 4 + count * 4 > lump.length) count = view.getUint16(lump.offset, true);
  if (count < 0 || 4 + count * 4 > lump.length) return names;
  for (let index = 0; index < count; index++) {
    const offset = view.getInt32(lump.offset + 4 + index * 4, true);
    const at = lump.offset + offset;
    if (offset <= 0 || at + 16 > lump.offset + lump.length) { names.push(null); continue; }
    names.push(text(bytes, at, 16) || null);
  }
  return names;
}

function quakeWorld(view, bytes, info) {
  const { lumps, version } = info;
  const planes = records(view, lumps[1], 20, planeReader);
  const texinfo = records(view, lumps[6], 40, (data, at) => ({ miptex: data.getInt32(at + 32, true) }));
  const textureNames = miptexNames(view, bytes, lumps[2]);
  const layout = faceLayout(view, lumps[7], planes.length, texinfo.length);
  const faces = layout ? records(view, lumps[7], layout.size, (data, at) => ({
    plane: layout.plane(data, at), texinfo: layout.texinfo(data, at),
  })) : [];
  // Half-Life's leaf carries four ambient-sound bytes Quake's does not: 28 bytes against 24.
  const leafSizes = version >= 30 ? [28, 24] : [24, 28];
  const leafSize = leafSizes.find(size => lumps[10].length % size === 0) || 24;
  const nodes = records(view, lumps[5], 24, (data, at) => ({
    plane: data.getInt32(at, true),
    children: [data.getInt16(at + 4, true), data.getInt16(at + 6, true)],
    firstFace: data.getUint16(at + 20, true),
    faces: data.getUint16(at + 22, true),
  }));
  const leafs = records(view, lumps[10], leafSize, (data, at) => ({ contents: data.getInt32(at, true) }));
  const models = records(view, lumps[14], 64, (data, at) => ({
    mins: [data.getFloat32(at, true), data.getFloat32(at + 4, true), data.getFloat32(at + 8, true)],
    maxs: [data.getFloat32(at + 12, true), data.getFloat32(at + 16, true), data.getFloat32(at + 20, true)],
    headnode: [0, 1, 2, 3].map(index => data.getInt32(at + 36 + index * 4, true)),
  }));
  return { lumps, planes, texinfo, textureNames, faces, nodes, leafs, models, faceLayout: Boolean(layout) };
}

/** The texture each plane is drawn with, taken from the faces that lie on it. */
function planeTextures(quake) {
  const byPlane = new Map();
  for (const face of quake.faces) {
    if (byPlane.has(face.plane)) continue;
    const info = quake.texinfo[face.texinfo];
    const name = info ? quake.textureNames[info.miptex] : null;
    if (name) byPlane.set(face.plane, name);
  }
  return byPlane;
}

/** The texture a node names for its own plane, preferring a face the node actually owns. */
function nodeTexture(quake, node, textures) {
  for (let index = 0; index < node.faces; index++) {
    const face = quake.faces[node.firstFace + index];
    if (face && face.plane === node.plane) {
      const info = quake.texinfo[face.texinfo];
      const name = info ? quake.textureNames[info.miptex] : null;
      if (name) return name;
    }
  }
  return textures.get(node.plane) ?? DEFAULT_TEXTURE;
}

/**
 * Every piece of solid space in one model, as a brush.
 *
 * A BSP needs only one solid leaf — solid space is never subdivided for drawing — so the same leaf
 * index is reached by hundreds of different paths, each a different room's wall. The hull is
 * therefore built per *tree position*, not per leaf, which is what makes the walls come out as
 * walls. An explicit stack keeps a deep tree off the call stack.
 *
 * A model is the world, or one brush entity: Half-Life puts every door, platform and breakable wall
 * in its own model with its own tree, sharing this file's planes, nodes and leafs. Walking them all
 * is what makes a door a door instead of a hole in the level.
 */
function leafBrushes(quake, model, textures) {
  const counts = { solid: 0, degenerate: 0, missed: 0, truncated: false };
  const brushes = [];
  if (!model) { counts.missed++; return { brushes, counts }; }
  if (model.headnode[0] < 0) return { brushes, counts };
  // The tree's own bounds, grown a little: the compiler puts the outer hull exactly on them, and a
  // hull clipped exactly on a plane leaves faces with no area.
  const min = model.mins.map(value => value - 8), max = model.maxs.map(value => value + 8);
  if (![...min, ...max].every(Number.isFinite)) { counts.missed++; return { brushes, counts }; }

  const stack = [{ node: model.headnode[0], planes: boxPlanes(min, max) }];
  while (stack.length) {
    const { node: index, planes } = stack.pop();
    const node = quake.nodes[index];
    const plane = node ? quake.planes[node.plane] : null;
    if (!node || !plane || !plane.normal.every(Number.isFinite) || !Number.isFinite(plane.distance)) { counts.missed++; continue; }
    const texture = nodeTexture(quake, node, textures);
    for (const side of [0, 1]) {
      const child = node.children[side];
      if (!child) continue;
      // The child's half-space, written outward-first: going to the front of the plane means the
      // solid side is behind it, so the outward normal is the plane's own, negated.
      const outward = side === 0
        ? { normal: mul(plane.normal, -1), distance: -plane.distance, texture }
        : { normal: plane.normal, distance: plane.distance, texture };
      const next = [...planes, outward];
      if (child > 0) { stack.push({ node: child, planes: next }); continue; }
      const leaf = quake.leafs[-child - 1];
      if (!leaf) { counts.missed++; continue; }
      if (leaf.contents !== CONTENTS_SOLID) continue;
      counts.solid++;
      const brush = planesToBrush(next);
      if (!brush) counts.degenerate++;
      else brushes.push(invisibleBrush(brush.faces) ? { ...brush, visible: false } : brush);
      if (brushes.length >= MAX_BSP_BRUSHES) { counts.truncated = true; return { brushes, counts }; }
    }
  }
  return { brushes, counts };
}

// ---------------------------------------------------------------------------------------------------
// Quake 2 and Quake 3: the brushes are in the file
// ---------------------------------------------------------------------------------------------------

/** Quake 3's 72-byte shader records: the name, then the surface and contents flags the compiler set. */
function shaders(view, bytes, lump) {
  const out = [];
  if (!lump || lump.length < 72) return out;
  for (let index = 0; index < Math.floor(lump.length / 72); index++) {
    const at = lump.offset + index * 72;
    out.push({ name: text(bytes, at, 64) || null, contents: view.getInt32(at + 68, true) });
  }
  return out;
}

/** Quake 3's `CONTENTS_SOLID`: a shader without it is a volume the compiler made, not a wall. */
const CONTENTS_SOLID_BIT = 1;
/** `CONTENTS_PLAYERCLIP`: invisible to the eye and solid to the player, which is what a clip brush is. */
const CONTENTS_PLAYERCLIP = 0x10000;
/**
 * Entities whose model is a volume and not a wall.
 *
 * A trigger brush is stored in the BSP exactly like a door is — the compiler gives it a model tree of
 * solid leaves — and the *game* is what decides it cannot be walked into, by classname. Importing a
 * trigger as geometry put an invisible wall across the room it was built to detect. These keep their
 * entity, so the mapper still sees where they are, and lose only the brushes.
 */
const VOLUME_ENTITY = /^(trigger_.*|func_(illusionary|water|ladder|areaportal|areaportalwater|portal|fog|light|detail|trainpath|rotating_light))$/i;

/** The lumps a Quake 2 / Quake 3 brush map is built from, read once and shared by every model. */
function brushSource(view, bytes, info) {
  const { lumps, version } = info;
  const quake3 = version >= 46;
  const planes = records(view, lumps[quake3 ? 2 : 1], quake3 ? 16 : 20, planeReader);
  const materials = quake3 ? shaders(view, bytes, lumps[1]) : miptexNames(view, bytes, lumps[2]);
  const texinfo = quake3 ? [] : records(view, lumps[6], 76, (data, at) => ({ name: text(bytes, at + 40, 32) || null }));
  // Quake 2 puts a brush's contents in the brush record; Quake 3 puts it on the shader each side uses.
  const brushes = records(view, lumps[quake3 ? 8 : 15], 12, (data, at) => ({
    firstSide: data.getInt32(at, true), sides: data.getInt32(at + 4, true),
    ...(quake3 ? {} : { contents: data.getInt32(at + 8, true) }),
  }));
  const sides = quake3
    ? records(view, lumps[9], 8, (data, at) => ({ plane: data.getInt32(at, true), texture: data.getInt32(at + 4, true) }))
    : records(view, lumps[16], 4, (data, at) => ({ plane: data.getUint16(at, true), texture: data.getInt16(at + 2, true) }));
  const textureOf = side => {
    if (side.texture < 0) return DEFAULT_TEXTURE;
    if (!quake3) return texinfo[side.texture]?.name ?? DEFAULT_TEXTURE;
    return materials[side.texture]?.name ?? DEFAULT_TEXTURE;
  };
  /**
   * Whether a brush is a wall at all.
   *
   * Quake 3's brush lump also carries the compilers' own volumes — `lightgrid`, `hint`, triggers —
   * which are marked non-solid in their shader precisely so nothing collides with them. Importing
   * them as geometry filled rooms with invisible slabs and put the player start inside one. A brush
   * is kept when any of its sides is solid or blocks the player, which is the collision test the
   * game itself answers.
   */
  const solid = record => {
    if (!quake3) return ((record.contents ?? 0) & (CONTENTS_SOLID_BIT | CONTENTS_PLAYERCLIP)) !== 0;
    for (let index = 0; index < record.sides; index++) {
      const side = sides[record.firstSide + index];
      const material = side ? materials[side.texture] : null;
      if (material && (material.contents & (CONTENTS_SOLID_BIT | CONTENTS_PLAYERCLIP))) return true;
    }
    return false;
  };
  return { brushes, sides, planes, solid, textureOf };
}

/**
 * The brushes one model owns.
 *
 * Quake 3 keeps a brush list per model as a range of the same lump, so a door's brushes are a slice;
 * a brush the compiler marked non-solid is counted and dropped either way.
 */
function modelBrushes(source, from, count, counters) {
  const out = [];
  for (let index = from; index < from + count && index < source.brushes.length; index++) {
    const record = source.brushes[index];
    if (!source.solid(record)) { counters.compilerVolumes++; continue; }
    counters.solid++;
    const faces = [], seen = new Set();
    for (let side = 0; side < record.sides; side++) {
      const entry = source.sides[record.firstSide + side];
      if (!entry) continue;
      const plane = source.planes[entry.plane];
      if (!plane || !plane.normal.every(Number.isFinite) || !Number.isFinite(plane.distance)) continue;
      const key = `${plane.normal.map(value => value.toFixed(3)).join(',')}|${plane.distance.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      faces.push({ normal: plane.normal, distance: plane.distance, texture: source.textureOf(entry) });
    }
    const hull = planesToBrush(faces);
    if (!hull) { counters.degenerate++; continue; }
    out.push(invisibleBrush(hull.faces) ? { ...hull, visible: false } : hull);
    if (out.length >= MAX_BSP_BRUSHES) { counters.truncated = true; break; }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// The whole file
// ---------------------------------------------------------------------------------------------------

/**
 * Read a compiled map into the shape `parseIdTechMap` returns, so the importer cannot tell them apart.
 *
 * Entities come from the file's own entity lump — the player start, lights, and every key the mapper
 * typed are still there — and the brushes are attached to `worldspawn`, which is where a `.map`
 * would have had them.
 */
export function parseBsp(bytes, { name = 'map' } = {}) {
  const info = bspInfo(bytes);
  if (!info) throw new Error(`${name}: not a compiled Quake map (no readable BSP header)`);
  const view = viewOf(bytes);
  const warnings = [];
  const entities = parseEntityLump(text(bytes, info.lumps[0].offset, info.lumps[0].length), name);
  const worldspawn = entities.find(entity => entity.properties.classname === 'worldspawn') || entities[0];
  if (!worldspawn) throw new Error(`${name}: the compiled map has no entities`);
  if (!worldspawn.properties.classname) worldspawn.properties.classname = 'worldspawn';

  // A model the world does not own belongs to the entity that names it: `"model" "*3"` is the fourth
  // model, and that is where a door's brushes live in Half-Life and Quake 3 alike.
  const owner = index => entities.find(entity => String(entity.properties.model || '') === `*${index}`);
  const counters = { solid: 0, degenerate: 0, missed: 0, truncated: false, compilerVolumes: 0, attached: 0, orphans: 0, volumes: 0 };
  let brushes;
  const extra = {};
  if (info.version >= 38) {
    const source = brushSource(view, bytes, info);
    extra.brushModels = 0;
    if (!source.brushes.length) {
      warnings.push(`${name}: the file has no brush lump; Quake 2 and Quake 3 also draw curves and patches, which are not imported`);
    }
    const models = info.version >= 46
      ? records(view, info.lumps[7], 40, (data, at) => ({
        firstBrush: data.getInt32(at + 32, true), brushes: data.getInt32(at + 36, true),
      }))
      : [];
    // Without a model list every brush is the world's, which is what Quake 2 files usually are.
    const ranges = models.length ? models.map((model, index) => ({ index, ...model })) : [{ index: 0, firstBrush: 0, brushes: source.brushes.length }];
    for (const range of ranges) {
      const own = modelBrushes(source, range.firstBrush, range.brushes, counters);
      if (range.index === 0) { brushes = own; continue; }
      if (!own.length) continue;
      const entity = owner(range.index);
      if (!entity) { counters.orphans += own.length; continue; }
      if (VOLUME_ENTITY.test(entity.properties.classname || '')) { counters.volumes += own.length; continue; }
      entity.brushes = [...(entity.brushes || []), ...own.map(brush => ({
        ...brush, name: entity.properties.classname || brush.name,
      }))];
      counters.attached += own.length;
      extra.brushModels++;
    }
    brushes ||= [];
  } else {
    const quake = quakeWorld(view, bytes, info);
    const textures = planeTextures(quake);
    const world = leafBrushes(quake, quake.models[0], textures);
    brushes = world.brushes;
    Object.assign(counters, { solid: world.counts.solid, missed: world.counts.missed,
      degenerate: world.counts.degenerate, truncated: world.counts.truncated });
    extra.models = quake.models.length;
    extra.brushModels = 0;
    for (let index = 1; index < quake.models.length; index++) {
      const model = leafBrushes(quake, quake.models[index], textures);
      counters.solid += model.counts.solid;
      counters.missed += model.counts.missed;
      counters.degenerate += model.counts.degenerate;
      if (!model.brushes.length) continue;
      const entity = owner(index);
      if (!entity) { counters.orphans += model.brushes.length; continue; }
      if (VOLUME_ENTITY.test(entity.properties.classname || '')) { counters.volumes += model.brushes.length; continue; }
      entity.brushes = [...(entity.brushes || []), ...model.brushes.map(brush => ({
        ...brush, name: entity.properties.classname || brush.name,
      }))];
      counters.attached += model.brushes.length;
      extra.brushModels++;
    }
  }
  worldspawn.brushes = brushes;
  const report = describeModels(counters, extra, name);
  warnings.push(...report);
  let faceCount = 0;
  for (const entity of entities) for (const brush of entity.brushes || []) faceCount += brush.faces.length;
  let brushCount = 0;
  for (const entity of entities) brushCount += (entity.brushes || []).length;
  return {
    name,
    entities,
    warnings,
    stats: { entities: entities.length, brushes: brushCount, faces: faceCount, primitives: 0 },
    format: 'bsp',
    bsp: { version: info.version, game: info.engine, ...extra },
  };
}

/** What the walk found, said once: how much of the file became brushes and what did not. */
function describeModels(counters, extra, name) {
  const warnings = [];
  if (counters.truncated) warnings.push(`${name}: stopped at ${MAX_BSP_BRUSHES} brushes; the rest of the map was not imported`);
  if (counters.missed) warnings.push(`${name}: ${counters.missed} tree records pointed outside the file and were skipped`);
  if (counters.degenerate) warnings.push(`${name}: ${counters.degenerate} pieces of solid space had no usable volume and became no brush`);
  if (counters.compilerVolumes) {
    warnings.push(`${name}: ${counters.compilerVolumes} compiler volumes (lightgrid, hint, triggers) are not solid and were not imported`);
  }
  if (!counters.solid && !counters.compilerVolumes && !counters.truncated) {
    warnings.push(`${name}: no solid space was found in the compiled map`);
  }
  if (extra.brushModels) {
    warnings.push(`${name}: ${extra.brushModels} brush models (doors, platforms and other moving parts) imported from their own trees`);
  }
  if (counters.orphans) warnings.push(`${name}: ${counters.orphans} pieces of brush-model geometry belonged to no entity and were not imported`);
  if (counters.volumes) {
    warnings.push(`${name}: ${counters.volumes} trigger and illusionary volumes kept their entity and imported no brushes; the game does not let anything stand in them`);
  }
  return warnings;
}

/**
 * The entity lump: ordinary `.map` entity text, read by the ordinary reader.
 *
 * A compiled map's brush entities have no brushes left in the lump — the geometry moved into the
 * world or into a model — so what matters here is the keys. Some compilers still write an empty
 * `{ }` block per entity, which the source reader refuses; a lenient pass covers that.
 */
function parseEntityLump(source, name) {
  if (!source.trim()) return [{ properties: { classname: 'worldspawn' }, brushes: [] }];
  try {
    return parseIdTechMap(source, { name }).entities;
  } catch (error) {
    const entities = [];
    for (const match of source.matchAll(/\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
      const body = match[1].replace(/\{[^{}]*\}/g, '');
      const properties = {};
      for (const pair of body.match(/"[^"]*"\s+(?:"[^"]*"|[^\s{}]+)/g) || []) {
        const end = pair.indexOf('"', 1);
        if (end < 0) continue;
        properties[pair.slice(1, end)] = pair.slice(end + 1).replace(/"/g, '').trim();
      }
      if (Object.keys(properties).length) entities.push({ properties, brushes: [] });
    }
    if (!entities.length) throw error;
    return entities;
  }
}
