// A ramp is a mesh, not a shape the engine has a special case for.
//
// The ramp tool's job is to generate a model from four numbers, and the model is then placed,
// lit and textured by exactly the code that places an imported .bbmodel — a ramp is a model with
// per-face collision, which is the only thing that makes it different from any other mesh. That
// way a ramp cut in Blockbench and a ramp built by the tool travel the same path, and there is no
// second geometry to keep in step.
import { dataURI, decodeDataURI, encodeGLB } from './gltf.js';

/**
 * A wedge ramp's six corners, named, in map units, y up, base centred on the origin.
 *
 * The shape is written down here once. The mesh is built from these corners, the collider is the
 * convex hull of them, and the editor draws the same faces — so the ramp the player slides on is
 * the ramp they can see, which is what two separate descriptions kept getting wrong.
 */
function wedgePoints({ width = 256, height = 0, depth, facing } = {}) {
  const halfWidth = width / 2, halfDepth = (depth ?? width) / 2;
  const rise = Math.max(0, Number(height) || 0);
  // 'right' falls towards +x, so its low edge is the +x one and the ridge is at -x.
  const low = facing === 'right' ? halfWidth : -halfWidth, high = -low;
  return {
    lowBack: [low, 0, -halfDepth], highBack: [high, 0, -halfDepth], ridgeBack: [high, rise, -halfDepth],
    lowFront: [low, 0, halfDepth], highFront: [high, 0, halfDepth], ridgeFront: [high, rise, halfDepth],
  };
}

/** The six corners, in the order the wedge mesh and hull index them. */
export function wedgeCorners(shape) {
  const points = wedgePoints(shape);
  return [points.lowBack, points.highBack, points.ridgeBack, points.lowFront, points.highFront, points.ridgeFront];
}

/** Triangles over `wedgeCorners`, wound so every face points outwards. */
export const WEDGE_INDICES = [0, 2, 5, 0, 5, 3, 0, 4, 1, 1, 4, 5, 1, 5, 2, 0, 3, 4];

/**
 * The five faces of a wedge ramp, in map units, with the base on the floor.
 *
 * Corners are wound the way the face's normal points. Four-corner faces are quads, three-corner
 * faces are the triangular ends; the surf face comes first because that is the one the player
 * slides on and the one a game asks about.
 */
export function rampFaces(shape) {
  const points = wedgePoints(shape);
  return [
    { name: 'surf', corners: [points.lowBack, points.ridgeBack, points.ridgeFront, points.lowFront] },
    { name: 'back', corners: [points.highBack, points.highFront, points.ridgeFront, points.ridgeBack] },
    { name: 'base', corners: [points.lowBack, points.lowFront, points.highFront, points.highBack] },
    { name: 'side-back', corners: [points.lowBack, points.highBack, points.ridgeBack] },
    { name: 'side-front', corners: [points.lowFront, points.ridgeFront, points.highFront] },
  ];
}

/** Map units of texture per tile, the size the collider textures were already tiled at. */
const TILE = 64;

/** Unit normal of a face, from its own winding. */
export function faceNormal(corners) {
  const [a, b, c] = corners;
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return [normal[0] / length, normal[1] / length, normal[2] / length];
}

/** Texture coordinates for a corner, measured in map units along the face's own axes. */
function faceUv(name, [x, y, z]) {
  if (name === 'surf') return [z / TILE, Math.hypot(y, x) / TILE];
  if (name === 'back') return [z / TILE, y / TILE];
  if (name === 'base') return [x / TILE, z / TILE];
  return [x / TILE, y / TILE];
}

/**
 * A glTF document holding the ramp as one mesh, in map units.
 *
 * Map units and not metres, with `modelScale: 1` on the object, so the mesh the collider is built
 * from needs no conversion between what is drawn and what is collided.
 */
export function rampModelDocument(shape) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (const face of rampFaces(shape)) {
    const normal = faceNormal(face.corners), first = positions.length / 3;
    for (const corner of face.corners) {
      positions.push(corner[0], corner[1], corner[2]);
      normals.push(normal[0], normal[1], normal[2]);
      uvs.push(...faceUv(face.name, corner));
    }
    // A quad is two triangles, wound the same way as the face; an end is already one.
    if (face.corners.length === 4) indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    else indices.push(first, first + 1, first + 2);
  }
  const arrays = [new Float32Array(positions), new Float32Array(normals), new Float32Array(uvs), new Uint16Array(indices)];
  const buffer = new Uint8Array(arrays.reduce((size, array) => size + array.byteLength, 0));
  let offset = 0;
  const bufferViews = arrays.map(array => {
    const view = { buffer: 0, byteOffset: offset, byteLength: array.byteLength };
    buffer.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), offset);
    offset += array.byteLength;
    return view;
  });
  const axis = index => positions.filter((_, position) => position % 3 === index);
  const json = {
    asset: { version: '2.0', generator: 'OpenDLE ramp tool' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'Ramp', mesh: 0 }],
    meshes: [{ name: 'Ramp', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'Ramp', doubleSided: false,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: .9 } }],
    buffers: [{ byteLength: buffer.length }], bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3',
        min: [0, 1, 2].map(index => Math.min(...axis(index))), max: [0, 1, 2].map(index => Math.max(...axis(index))) },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
  };
  return { json, binary: buffer };
}

/**
 * The asset id a ramp's mesh gets, derived from the numbers that shape it.
 *
 * Two ramps with the same slope, length, width and facing are the same mesh, so they share one
 * asset; change a number and the id changes, which is what tells the renderer to reload.
 */
export function rampModelId({ width = 0, height = 0, depth = 0, facing = 'right' } = {}) {
  const round = value => Math.round(Number(value) * 100) / 100;
  return `ramp_mesh_${round(width)}x${round(height)}x${round(depth)}_${facing === 'left' ? 'l' : 'r'}`.replaceAll('.', '_');
}

/** A model asset for a ramp, ready to sit in `project.assets`. */
export function rampModelAsset(shape, { id } = {}) {
  const { json, binary } = rampModelDocument(shape);
  const glb = encodeGLB(json, binary);
  return { id: id || rampModelId(shape), name: 'Ramp', kind: 'model', format: 'glb',
    src: dataURI(glb, 'model/gltf-binary'), animations: [] };
}

/**
 * Make sure a ramp's generated model exists and is the one its numbers describe.
 *
 * The asset is shared between ramps of the same shape, so editing an angle gives a new asset and
 * the old one stays for whichever other ramp still uses it; `pruneRampModels` drops the rest.
 */
export function ensureRampModel(project, entity) {
  if (!entity || entity.type !== 'ramp' || !entity.physics) return null;
  const shape = { width: entity.physics.width, height: entity.physics.height,
    depth: entity.physics.depth, facing: entity.physics.wedge?.facing };
  const id = rampModelId(shape);
  project.assets ||= [];
  if (!project.assets.some(asset => asset.id === id)) project.assets.push(rampModelAsset(shape, { id }));
  entity.modelAsset = id;
  entity.modelScale = 1;
  // A ramp is drawn from its mesh, and its collision comes from that same mesh.
  entity.physics.shape = 'model';
  return id;
}

/** Every ramp in the project gets the model its numbers describe. */
export function syncRampModels(project) {
  for (const entity of project.map?.entities || []) ensureRampModel(project, entity);
  pruneRampModels(project);
}

/** Drop generated ramp meshes nothing references any more, so edits do not pile up assets. */
export function pruneRampModels(project) {
  if (!Array.isArray(project.assets)) return;
  const used = new Set();
  const collect = entities => { for (const entity of entities || []) if (entity.modelAsset) used.add(entity.modelAsset); };
  collect(project.map?.entities);
  for (const scene of project.scenes || []) collect(scene.entities);
  project.assets = project.assets.filter(asset => !asset.id.startsWith('ramp_mesh_') || used.has(asset.id));
}

/** A ramp's generated GLB bytes, for tests and for the collision reader. */
export function rampModelBytes(shape) {
  return decodeDataURI(rampModelAsset(shape).src);
}
