/**
 * Foliage in the terrain viewport: what a painted patch looks like while it is being painted.
 *
 * The runtime draws the same chunks with the game's own renderer (`public/render.js`); this one is
 * the authoring view, so it reads the same `shared/foliage.js` data and makes the same instanced
 * meshes out of it. The two never share a THREE build — the viewport is the classic module build
 * and the game is the WebGPU one — but they must agree on the data, and that is the module they
 * do share.
 *
 * A layer becomes one `InstancedMesh` per chunk:
 *
 *   - **sprites** are two quads crossed at right angles, which reads as grass from any side
 *     without a billboard shader and costs one draw per chunk;
 *   - **models** are the asset's own geometry, instanced the same way.
 *
 * Chunk meshes get the bounding sphere the chunk computed, so the viewport frustum-culls them for
 * free, and the far cut hides a field that is too small to see on screen.
 */
import * as THREE from '/vendor/three/three.module.js';
import { GLTFLoader } from '/vendor/three-addons/loaders/GLTFLoader.js';
import { chunkFoliage, chunkVisible, foliageSignature, instanceTransform, transformQuaternion } from '../shared/foliage.js';

/**
 * Two quads crossing at 90°, base at y = 0, centred on the origin.
 *
 * A single quad disappears when seen edge-on, which is exactly what a field looks like from a
 * low camera; two crossed quads never do.
 */
export function crossQuadGeometry(width = 64, height = 64) {
  const halfWidth = width / 2;
  const positions = [], uvs = [], indices = [];
  const quad = (ax, az, bx, bz) => {
    const at = positions.length / 3;
    positions.push(ax * halfWidth, 0, az * halfWidth, bx * halfWidth, 0, bz * halfWidth,
      bx * halfWidth, height, bz * halfWidth, ax * halfWidth, height, az * halfWidth);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(at, at + 1, at + 2, at, at + 2, at + 3);
  };
  quad(-1, 0, 1, 0);
  quad(0, -1, 0, 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The matrix one instance stands at: its scale, its lean and its turn, standing on its base.
 *
 * The placement itself is `shared/foliage.js`, so the preview and the game agree to the degree.
 */
export function instanceMatrix(instance, target = new THREE.Matrix4()) {
  const placed = instanceTransform(instance);
  const q = transformQuaternion(placed);
  return target.compose(
    new THREE.Vector3(placed.position.x, placed.position.y, placed.position.z),
    new THREE.Quaternion(q[0], q[1], q[2], q[3]),
    new THREE.Vector3(placed.scale, placed.scale, placed.scale));
}

/**
 * Builds and keeps the preview meshes.
 *
 * `resolveAsset(layer)` answers `{ kind, src, width, height }` for a layer's asset, and is the
 * only thing the caller has to supply: the project's own asset list is the authority on art.
 */
export function createFoliagePreview({ resolveAsset = () => null, maxDistance = Infinity } = {}) {
  const group = new THREE.Group();
  group.name = 'foliage';
  const meshes = new Map();
  const assetCache = new Map();
  const loader = new GLTFLoader();
  let signature = null, building = false, pending = null;

  function disposeMesh(mesh) {
    if (mesh.geometry?.userData?.shared !== true) mesh.geometry?.dispose?.();
    // Materials are cached per asset, so they outlive the chunk that used them.
    mesh.dispose?.();
  }

  async function assetFor(layer, project) {
    const id = layer.assetId;
    if (!id) return null;
    const cached = assetCache.get(`${layer.kind}:${id}`);
    if (cached) return cached;
    const meta = resolveAsset(layer, project);
    if (!meta?.src) return null;
    let entry = null;
    if (layer.kind === 'sprite') {
      const texture = await new Promise(resolve => {
        new THREE.TextureLoader().load(meta.src, resolve, undefined, () => resolve(null));
      });
      if (!texture) return null;
      texture.colorSpace = THREE.SRGBColorSpace;
      const height = Math.max(1, meta.height || 64);
      const width = Math.max(1, meta.width || height);
      const geometry = crossQuadGeometry(width, height);
      geometry.userData.shared = true;
      entry = {
        kind: 'sprite', geometry,
        material: new THREE.MeshBasicMaterial({ map: texture, transparent: true, alphaTest: .35,
          side: THREE.DoubleSide, depthWrite: false }),
        height,
      };
    } else {
      try {
        const data = meta.src.startsWith('data:') ? atob(meta.src.split(',')[1] || '') : null;
        if (!data) return null;
        const bytes = new Uint8Array(data.length);
        for (let index = 0; index < data.length; index++) bytes[index] = data.charCodeAt(index);
        const gltf = await loader.parseAsync(bytes.buffer, '');
        let geometry = null, material = null, height = 64;
        gltf.scene?.traverse(node => {
          if (geometry || !node.geometry) return;
          geometry = node.geometry;
          const source = Array.isArray(node.material) ? node.material[0] : node.material;
          material = source ? source.clone() : new THREE.MeshBasicMaterial({ color: '#7fbf6a' });
          material.side = THREE.DoubleSide;
        });
        if (!geometry) return null;
        const box = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
        height = Number.isFinite(box.max.y) ? Math.max(1, box.max.y) : 64;
        entry = { kind: 'model', geometry, material, height };
      } catch { return null; }
    }
    assetCache.set(`${layer.kind}:${id}`, entry);
    return entry;
  }

  function buildChunk(chunk, asset) {
    const count = chunk.instances.length;
    if (!count) return null;
    const mesh = new THREE.InstancedMesh(asset.geometry, asset.material, count);
    mesh.name = `foliage ${chunk.key}`;
    mesh.frustumCulled = true;
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < count; index++) {
      mesh.setMatrixAt(index, instanceMatrix(chunk.instances[index], matrix));
    }
    mesh.instanceMatrix.needsUpdate = true;
    // The bounding sphere the chunk computed is what the frustum test uses; three would otherwise
    // derive one from the whole instance buffer on every frame.
    mesh.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(chunk.centre.x, chunk.centre.y, chunk.centre.z), chunk.radius);
    mesh.userData.chunk = chunk.key;
    return mesh;
  }

  /**
   * Brings the meshes in line with the field.
   *
   * A stroke only ever *adds* tufts to the chunks it crosses, so a chunk whose count and art are
   * unchanged is left alone: painting across a big field redraws the handful of chunks under the
   * brush, not the whole board.
   */
  async function rebuild(next, project) {
    const nextSignature = foliageSignature(next);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const seen = new Set();
    for (const chunk of chunkFoliage(next)) {
      seen.add(chunk.key);
      const layer = next.layers.find(item => item.id === chunk.layerId);
      if (!layer) continue;
      const existing = meshes.get(chunk.key);
      if (existing && existing.count === chunk.instances.length &&
        existing.userData.assetId === layer.assetId) continue;
      if (existing) { group.remove(existing); disposeMesh(existing); meshes.delete(chunk.key); }
      const asset = await assetFor(layer, project);
      if (!asset) continue;
      const mesh = buildChunk(chunk, asset);
      if (!mesh) continue;
      mesh.userData.assetId = layer.assetId;
      meshes.set(chunk.key, mesh);
      group.add(mesh);
    }
    for (const [key, mesh] of [...meshes]) {
      if (seen.has(key)) continue;
      group.remove(mesh);
      disposeMesh(mesh);
      meshes.delete(key);
    }
  }

  /** Rebuilds the preview from a field; a build already running is queued once, never stacked. */
  async function update(next, project) {
    if (building) { pending = { next, project }; return; }
    building = true;
    try {
      await rebuild(next, project);
    } finally {
      building = false;
      const queued = pending;
      pending = null;
      if (queued) void update(queued.next, queued.project);
    }
  }

  /** Hides the chunks past `maxDistance` from the camera, and reports what is drawn. */
  function cull(camera) {
    let drawn = 0, instances = 0;
    for (const mesh of meshes.values()) {
      // The mesh already carries its chunk's bounding sphere, so the distance test and the
      // renderer's own frustum test read the same numbers.
      const bounds = mesh.boundingSphere;
      const visible = !camera || chunkVisible({ centre: bounds.center, radius: bounds.radius },
        { x: camera.position.x, z: camera.position.z, maxDistance });
      mesh.visible = visible;
      if (visible) { drawn++; instances += mesh.count; }
    }
    return { chunks: drawn, instances, total: meshes.size };
  }

  return {
    object: group,
    update,
    cull,
    meshes,
    /** Drops the cached meshes and art; the caller owns the scene the group sits in. */
    dispose() {
      for (const mesh of meshes.values()) { group.remove(mesh); disposeMesh(mesh); }
      meshes.clear();
      for (const asset of assetCache.values()) {
        asset.geometry?.dispose?.();
        asset.material?.map?.dispose?.();
        asset.material?.dispose?.();
      }
      assetCache.clear();
      group.removeFromParent();
      signature = null;
    },
    /** What the preview is currently showing, for the tab's status line. */
    report() {
      let instances = 0;
      for (const mesh of meshes.values()) instances += mesh.count;
      return { chunks: meshes.size, instances };
    },
  };
}
