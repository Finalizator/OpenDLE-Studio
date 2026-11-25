/**
 * PBR materials: a set of maps that belong together, drawn by walls and brushes.
 *
 * A Doom texture is one picture. A material is up to six, and the renderer needs to know which
 * one is which: base colour is what the eye calls "the texture", the normal map turns light
 * across the surface, roughness decides how tight the highlight is, metalness decides whether
 * the highlight carries the colour, and height and ambient occlusion are kept for baking and for
 * engines that use them.
 *
 * Two resolutions are stored. `channels` is what the project plays with — the baked set, at the
 * resolution the creator settled on. `preview` is the editor's cheap copy: the same maps
 * downscaled, so a 2K material does not cost 2K of texture memory on every wall while it is being
 * designed. `source` is a link and nothing more: where the material was authored (a MaterialCraft
 * project, a folder of exported maps), kept so the creator can find it again. It is never drawn
 * and never packed into a build.
 */

/** The maps a material can carry, in the order the interface lists them. */
export const MATERIAL_CHANNELS = ['baseColor', 'normal', 'roughness', 'metallic', 'height', 'ao'];

/** The channels a surface can be lit by. The rest are kept for baking and for other engines. */
export const SHADING_CHANNELS = ['baseColor', 'normal', 'roughness', 'metallic'];

/** How many materials a project may hold. */
export const MAX_MATERIALS = 256;

/** The editor's default preview resolution, the sizes it offers, and what a material may bake to. */
export const PREVIEW_SIZE = 256;
export const PREVIEW_SIZES = [64, 128, 256, 512];
export const BAKE_SIZES = [128, 256, 512, 1024, 2048];

/** A material's own tiling: how many times the maps repeat across its surface's own UVs. */
export const DEFAULT_SCALE = { u: 1, v: 1 };

export const materialChannel = (material, channel) => material?.channels?.[channel] || null;

/**
 * The maps to draw a material with.
 *
 * The editor draws the preview when there is one and the game draws the baked set, which is the
 * whole point of the preview: designing a material is a loop of small edits, and re-uploading a
 * 2048² normal map on every slider move is how that loop stops being one.
 */
export function materialDisplay(material, { editor = false } = {}) {
  const channels = (editor && material?.preview?.channels) || material?.channels || {};
  return {
    channels,
    // The base colour is the only map every surface needs: a material for a normal map alone is
    // a mistake the caller can report rather than a surface drawn black.
    baseColor: channels.baseColor || null,
    normal: channels.normal || null,
    roughness: channels.roughness || null,
    metallic: channels.metallic || null,
    size: (editor && material?.preview?.size) || material?.baked?.size || null,
  };
}

/** How the material's maps are tiled across the surface it is drawn on. */
export function materialScale(material) {
  const u = Number(material?.scale?.u), v = Number(material?.scale?.v);
  return { u: Number.isFinite(u) && u > 0 ? u : DEFAULT_SCALE.u, v: Number.isFinite(v) && v > 0 ? v : DEFAULT_SCALE.v };
}

export function materialById(project, id) {
  if (!id) return null;
  return (project?.materials || []).find(material => material.id === id) || null;
}

/**
 * A new material around maps the project already holds.
 *
 * The maps are ordinary image assets — an import, a MaterialCraft export, a picture dragged from
 * the desktop — so everything that already looks at an image (reference counting, deletion,
 * packing) keeps working, and a material is the record that says how they belong together.
 */
export function createMaterial(project, { name = 'Material', channels = {}, scale, source = null, id = null } = {}) {
  const material = {
    id: id || `material_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`,
    name: String(name).slice(0, 100),
    channels: pickChannels(channels),
    scale: materialScale({ scale }),
    preview: null,
    baked: null,
    source: source ? { name: String(source.name || '').slice(0, 200), path: String(source.path || '').slice(0, 1000) } : null,
  };
  project.materials ||= [];
  project.materials.push(material);
  return material;
}

/** The channel map without the empty strings a picker leaves behind. */
export function pickChannels(channels = {}) {
  const result = {};
  for (const channel of MATERIAL_CHANNELS) {
    const value = channels[channel];
    if (typeof value === 'string' && value) result[channel] = value;
  }
  return result;
}

/** Every material that draws one of these asset ids, so deleting an image can say what breaks. */
export function materialsUsing(project, assetIds) {
  const wanted = new Set(assetIds);
  return (project.materials || []).filter(material => {
    const sets = [material.channels, material.preview?.channels];
    return sets.some(channels => channels && Object.values(channels).some(id => wanted.has(id)));
  });
}

/**
 * Points at a material from a surface, and takes it away from every other surface.
 *
 * A surface draws one thing. A wall side or a brush face that named a material and a texture at
 * once would leave the renderer to guess which one the mapper meant.
 */
export function assignMaterial(project, materialId, target) {
  const ids = new Set((project.materials || []).map(material => material.id));
  if (materialId && !ids.has(materialId)) throw new Error('That material is no longer part of the project');
  if (target.kind === 'brushFace') {
    const brush = (project.map.brushes || []).find(item => item.id === target.brushId);
    const face = brush?.faces?.[target.faceIndex];
    if (!face) throw new Error('That brush face no longer exists');
    if (materialId) { face.material = materialId; face.texture = null; } else delete face.material;
    return face;
  }
  if (target.kind === 'wallSide') {
    const wall = (project.map.walls || []).find(item => item.id === target.wallId);
    const part = target.part || 'middle';
    if (!WALL_MATERIAL_PARTS[part]) throw new Error(`A wall side has no "${part}" part`);
    if (!wall?.[target.side || 'right']) throw new Error('That wall side no longer exists');
    const side = wall[target.side || 'right'];
    if (materialId) side[WALL_MATERIAL_PARTS[part]] = materialId; else delete side[WALL_MATERIAL_PARTS[part]];
    return side;
  }
  throw new Error('A material is assigned to a brush face or a wall side');
}

/** The field a wall side keeps each of its three material slots in. */
export const WALL_MATERIAL_PARTS = { upper: 'material_upper', middle: 'material_middle', lower: 'material_lower' };

/**
 * The material a wall side draws for one of its parts, or null.
 *
 * A sidedef has three surfaces — above, between and below the neighbouring sector — and any of them
 * can carry a material. The name of the field lives here and nowhere else: the assignment, the
 * removal, the validator and the renderer all ask this table, because a renderer reading
 * `material_mid` while the editor writes `material_middle` drew the old texture for ever.
 */
export function wallSideMaterial(project, side, part = 'middle') {
  const key = WALL_MATERIAL_PARTS[part];
  if (!key) throw new Error(`A wall side has no "${part}" part; use ${Object.keys(WALL_MATERIAL_PARTS).join(', ')}`);
  return materialById(project, side?.[key] || null);
}

/** The material a surface draws, or null. */
export function surfaceMaterial(project, surface) {
  if (!surface) return null;
  return materialById(project, surface.material || surface.material_middle || null);
}

/** Drops a material and every assignment that named it. */
export function removeMaterial(project, materialId) {
  project.materials = (project.materials || []).filter(material => material.id !== materialId);
  for (const brush of project.map.brushes || []) {
    for (const face of brush.faces || []) if (face.material === materialId) delete face.material;
  }
  for (const wall of project.map.walls || []) {
    for (const key of Object.values(WALL_MATERIAL_PARTS)) {
      if (wall.right?.[key] === materialId) delete wall.right[key];
      if (wall.left?.[key] === materialId) delete wall.left[key];
    }
  }
}
