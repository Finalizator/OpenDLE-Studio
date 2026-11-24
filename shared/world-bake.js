import { sectorGeometry } from './sectors.js';
import { brushGeometry } from './brushes.js';

function pushTriangle(out, a, b, c) {
  out.push(a, b, c);
}

function fanTriangle(out, ring, y) {
  if (!ring || ring.length < 3) return;
  for (let index = 1; index < ring.length - 1; index++) {
    pushTriangle(out,
      [ring[0].x, y, ring[0].y],
      [ring[index].x, y, ring[index].y],
      [ring[index + 1].x, y, ring[index + 1].y]);
  }
}

function wallQuad(out, a, b, low, high) {
  pushTriangle(out, [a.x, low, a.y], [b.x, low, b.y], [b.x, high, b.y]);
  pushTriangle(out, [a.x, low, a.y], [b.x, high, b.y], [a.x, high, a.y]);
}

export function bakeLevelGeometry(project) {
  const triangles = [];
  for (const sector of sectorGeometry(project)) {
    if (!sector.rings?.length) continue;
    for (const ring of sector.rings) {
      fanTriangle(triangles, ring, sector.floorHeight || 0);
      if ((sector.ceilingHeight || 0) > (sector.floorHeight || 0) && !sector.sky) {
        for (let index = 1; index < ring.length - 1; index++) {
          pushTriangle(triangles,
            [ring[index + 1].x, sector.ceilingHeight, ring[index + 1].y],
            [ring[index].x, sector.ceilingHeight, ring[index].y],
            [ring[0].x, sector.ceilingHeight, ring[0].y]);
        }
      }
    }
  }
  const vertices = new Map(project.map.vertices.map(vertex => [vertex.id, vertex]));
  for (const wall of project.map.walls || []) {
    if (wall.solid === false) continue;
    const a = vertices.get(wall.a), b = vertices.get(wall.b);
    if (!a || !b) continue;
    wallQuad(triangles, a, b, 0, wall.height || 128);
  }
  // Authored brushes travel with the bake: a level's own meshes must be in its GLB, otherwise
  // the exported file would show the imported geometry and none of what the mapper built.
  let brushCount = 0;
  for (const brush of (project.map.brushes || [])) {
    if (brush.visible === false) continue;
    let geometry;
    try { geometry = brushGeometry(brush); } catch { continue; }
    brushCount++;
    for (const face of geometry.faces) {
      if (face.points.length < 3) continue;
      for (let index = 1; index < face.points.length - 1; index++) {
        pushTriangle(triangles,
          [face.points[0][0], face.points[0][2], face.points[0][1]],
          [face.points[index][0], face.points[index][2], face.points[index][1]],
          [face.points[index + 1][0], face.points[index + 1][2], face.points[index + 1][1]]);
      }
    }
  }
  return {
    triangles,
    brushes: brushCount,
    sectors: (project.map.sectors || []).length,
    walls: (project.map.walls || []).length,
    entities: (project.map.entities || []).length,
  };
}

function flatNormals(triangles) {
  const normals = [];
  for (let index = 0; index < triangles.length; index += 3) {
    const a = triangles[index], b = triangles[index + 1], c = triangles[index + 2];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(...normal) || 1;
    const value = normal.map(component => component / length);
    normals.push(value, value, value);
  }
  return normals;
}

function align4(value) { return (value + 3) & ~3; }

export function bakeWorldGlb(project) {
  const bake = bakeLevelGeometry(project);
  const positions = bake.triangles.flat();
  const normals = flatNormals(bake.triangles);
  const positionBytes = new Uint8Array(positions.length * 4);
  const normalBytes = new Uint8Array(normals.length * 3 * 4);
  const positionView = new Float32Array(positionBytes.buffer);
  const normalView = new Float32Array(normalBytes.buffer);
  positions.forEach((value, index) => { positionView[index] = value; });
  normals.flat().forEach((value, index) => { normalView[index] = value; });

  const positionOffset = 0;
  const normalOffset = align4(positionBytes.length);
  const binLength = normalOffset + normalBytes.length;
  const bin = new Uint8Array(binLength);
  bin.set(positionBytes, positionOffset);
  bin.set(normalBytes, normalOffset);
  const json = {
    asset: { version: '2.0', generator: 'OpenDLE: Studio world bake' },
    scene: 0,
    scenes: [{ name: project.title || 'Baked level', nodes: [0] }],
    nodes: [{ name: 'Baked world', mesh: 0, extras: {
      sectors: bake.sectors, walls: bake.walls, entities: bake.entities, brushes: bake.brushes,
      editableSource: true,
    } }],
    meshes: [{ name: 'Level geometry', primitives: [{
      attributes: { POSITION: 0, NORMAL: 1 },
      material: 0,
      mode: 4,
    }] }],
    materials: [{ name: 'Baked level', pbrMetallicRoughness: {
      baseColorFactor: [0.55, 0.62, 0.68, 1],
      metallicFactor: 0,
      roughnessFactor: 0.9,
    } }],
    bufferViews: [
      { buffer: 0, byteOffset: positionOffset, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: normalOffset, byteLength: normalBytes.length, target: 34962 },
    ],
    buffers: [{ byteLength: binLength }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: normals.length, type: 'VEC3' },
    ],
  };

  const jsonText = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonChunkLength = align4(jsonBytes.length);
  const jsonChunk = new Uint8Array(jsonChunkLength);
  jsonChunk.set(jsonBytes);
  for (let index = jsonBytes.length; index < jsonChunkLength; index++) jsonChunk[index] = 0x20;

  const binChunkLength = align4(bin.length);
  const binChunk = new Uint8Array(binChunkLength);
  binChunk.set(bin);

  const length = 12 + 8 + jsonChunkLength + 8 + binChunkLength;
  const glb = new Uint8Array(length);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  view.setUint32(12, jsonChunkLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(jsonChunk, 20);
  const binChunkOffset = 20 + jsonChunkLength;
  view.setUint32(binChunkOffset, binChunkLength, true);
  view.setUint32(binChunkOffset + 4, 0x004e4942, true);
  glb.set(binChunk, binChunkOffset + 8);
  return glb;
}
