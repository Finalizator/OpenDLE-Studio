/**
 * Turns a package's MODELDEF into model assets the renderer can draw.
 *
 * A MODELDEF block names an actor class, so the imported actor record gets a `model` field
 * holding the asset and the way it moves: `ROTATING` with a `Rotation-Vector` and
 * `Rotation-Speed`, and any `RollOffset`. Nothing about a particular mod is encoded here —
 * whatever the block says is what the actor does.
 */
import { dataURI } from './gltf.js';
import { objToGlb } from './obj-model.js';
import { parseModelDefs } from './modeldef.js';

const MESH_FORMATS = new Set(['obj']);

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'model';
}

/** The package entry whose path ends with `file`, matched the way GZDoom matches names. */
function findMesh(files, file) {
  const wanted = String(file).replace(/\\/g, '/').toLowerCase();
  const base = wanted.split('/').pop();
  for (const [name, entry] of files) {
    const path = name.toLowerCase();
    if (path === wanted || path.endsWith(`/${wanted}`) || path.split('/').pop() === base) return { name, entry };
  }
  return null;
}

/**
 * Adds a model asset for one MODELDEF mesh and returns its id, or null when the package does
 * not carry the file (a common, harmless case: a mod ships MD3s we cannot read yet).
 */
/** Every image a model's `usemtl` names may refer to, keyed by the name GZDoom looks up. */
function skinTextures(project) {
  const textures = new Map();
  // Flats first, then textures: GZDoom prefers a texture when both exist under one name.
  for (const asset of project.assets || []) {
    if (!asset.src || !['texture', 'flat'].includes(asset.kind)) continue;
    const key = String(asset.name || '').toUpperCase();
    if (asset.kind === 'texture' || !textures.has(key)) textures.set(key, asset);
  }
  return textures;
}

function importMesh(project, files, file, { warnings, owner, textures }) {
  const found = findMesh(files, file);
  if (!found?.entry?.data) {
    warnings.push(`${owner}: model ${file} is not in the package; the actor is drawn as a sprite.`);
    return null;
  }
  const format = String(file).split('.').pop().toLowerCase();
  if (!MESH_FORMATS.has(format)) {
    warnings.push(`${owner}: model ${file} uses .${format}, which is not imported yet; the actor is drawn as a sprite.`);
    return null;
  }
  let bytes;
  try {
    bytes = objToGlb(Buffer.from(found.entry.data).toString('latin1'), { name: file, textures });
  } catch (error) {
    warnings.push(`${owner}: model ${file} could not be converted (${error.message}).`);
    return null;
  }
  const name = String(file).split('/').pop().slice(0, 100);
  const existing = project.assets.find(asset => asset.kind === 'model' && asset.name === name);
  if (existing) return existing.id;
  const id = `asset_model_${slug(file)}`;
  const unique = project.assets.some(asset => asset.id === id) ? `${id}_${project.assets.length}` : id;
  project.assets.push({ id: unique, name, kind: 'model', format: 'glb', src: dataURI(bytes, 'model/gltf-binary'), animations: [] });
  return unique;
}

/**
 * Applies every MODELDEF block to the actor of the same name. Returns the definitions that
 * matched an actor, for reporting.
 */
export function importModelDefs(project, { sources = [], files, warnings = [] } = {}) {
  if (!sources.length || !project?.actors?.length || !files) return [];
  const applied = [];
  const textures = skinTextures(project);
  const byName = new Map(project.actors.map(actor => [String(actor.name).toLowerCase(), actor]));
  for (const definition of parseModelDefs(sources)) {
    const actor = byName.get(definition.name.toLowerCase());
    if (!actor) continue;
    // Only the meshes a frame actually shows are converted.
    const used = new Set(definition.frames.map(frame => frame.model));
    const assets = new Map();
    for (const model of definition.models) {
      if (used.size && !used.has(model.index)) continue;
      const assetId = importMesh(project, files, model.file, { warnings, owner: `MODELDEF ${definition.name}`, textures });
      if (assetId) assets.set(model.index, assetId);
    }
    if (!assets.size) continue;
    const frames = definition.frames
      .filter(frame => assets.has(frame.model))
      .map(frame => ({ sprite: frame.sprite, letter: frame.letter, frame: frame.frame, assetId: assets.get(frame.model) }));
    if (!frames.length) continue;
    actor.model = {
      frames,
      rotating: definition.rotating,
      // GZDoom models are Z-up; the engine's world is (x, z, y), so the axis goes through the
      // same swap the mesh did.
      rotationVector: [definition.rotationVector[0], definition.rotationVector[2], definition.rotationVector[1]],
      rotationSpeed: definition.rotationSpeed,
      rollOffset: definition.rollOffset,
      pitchOffset: definition.pitchOffset,
      angleOffset: definition.angleOffset,
      scale: definition.scale,
      offset: [definition.offset[0], definition.offset[2], definition.offset[1]],
    };
    applied.push({ name: definition.name, assetId: frames[0].assetId, rotating: definition.rotating });
  }
  return applied;
}

/** The model asset an actor shows on a sprite frame, or null. */
export function actorModelFor(actor, sprite, letter) {
  const model = actor?.model;
  if (!model) return null;
  const wanted = `${String(sprite || '').toUpperCase()}${String(letter || '').toUpperCase()}`;
  const frame = model.frames.find(entry => `${entry.sprite}${entry.letter}` === wanted);
  return frame ? frame.assetId : null;
}
