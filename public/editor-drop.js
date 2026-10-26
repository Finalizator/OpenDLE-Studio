import { sectorAt } from '../shared/sectors.js';
import { newId } from '../shared/project.js';

const IMAGE_KINDS = new Set(['texture', 'flat', 'sky', 'sprite', 'weapon']);
const KIND_LABELS = {
  texture: 'wall texture', flat: 'floor/ceiling flat', sky: 'sky image', sprite: 'sprite',
  weapon: 'weapon overlay', sound: 'sound', model: '3D model', font: 'font',
};
const label = kind => KIND_LABELS[kind] || kind;
const WALL_PARTS = new Set(['upper', 'middle', 'lower']);

export function snapValue(value, grid) {
  const step = Number(grid);
  return Number.isFinite(step) && step > 0 ? Math.round(value / step) * step : Math.round(value);
}

function assetOf(project, assetId) {
  const asset = (project.assets || []).find(candidate => candidate.id === assetId);
  if (!asset) throw new Error(`Asset ${assetId} is not part of this project`);
  return asset;
}

export function requireImageAsset(project, assetId, instead = 'drop a wall texture or floor/ceiling flat instead') {
  const asset = assetOf(project, assetId);
  if (!IMAGE_KINDS.has(asset.kind))
    throw new Error(`${asset.name} is a ${label(asset.kind)} asset, not an image; ${instead}`);
  return asset;
}

export function requireModelAsset(project, assetId) {
  const asset = assetOf(project, assetId);
  if (asset.kind !== 'model')
    throw new Error(`${asset.name} is a ${label(asset.kind)} asset, not a 3D model; drop a model asset onto an object`);
  return asset;
}

// The face a camera can see belongs to the sector the camera stands in; two-sided walls
// render one quad per side, so the hit quad alone cannot identify the side reliably.
// `camera` is a world position (x, height, z) - map Y is stored in the z component.
export function resolveWallSide(sectors, wall, camera) {
  const candidates = ['right', 'left'].filter(key => wall?.[key]);
  if (!candidates.length) return null;
  const sector = camera ? sectorAt(sectors, camera.x, camera.z) : null;
  if (sector) {
    const visible = candidates.find(key => wall[key].sectorId === sector.id);
    if (visible) return visible;
  }
  return candidates[0];
}

export function wallPartAt(sectorById, wall, sideKey, height) {
  const side = wall?.[sideKey];
  if (!side) return null;
  const front = sectorById.get(side.sectorId);
  const back = sectorById.get(wall[sideKey === 'right' ? 'left' : 'right']?.sectorId);
  if (!front || !back) return 'middle';
  const openingBottom = Math.max(front.floorHeight, back.floorHeight);
  const openingTop = Math.min(front.ceilingHeight, back.ceilingHeight);
  if (side.middle !== undefined && height >= openingBottom - .5 && height <= openingTop + .5) return 'middle';
  return height >= Math.max(front.floorHeight, back.ceilingHeight) - .5 ? 'upper' : 'lower';
}

export function wallTarget(wallId, side, part) {
  return { kind: 'wall', id: wallId, side, part: WALL_PARTS.has(part) ? part : 'middle' };
}

export function sectorTarget(sectorId, surface) {
  return { kind: 'sector', id: sectorId, surface: surface === 'ceilingHeight' ? 'ceilingHeight' : 'floorHeight' };
}

export function describeSurfaceTarget(target) {
  if (!target) return 'nothing';
  if (target.kind === 'sector') return `${target.surface === 'ceilingHeight' ? 'ceiling' : 'floor'} of ${target.id}`;
  return `wall ${target.id} (${target.side || 'right'} · ${target.part || 'middle'})`;
}

export function applySurfaceAsset(project, target, assetId) {
  const asset = requireImageAsset(project, assetId);
  if (target?.kind === 'sector') {
    const sector = (project.map.sectors || []).find(item => item.id === target.id);
    if (!sector) throw new Error('That sector no longer exists');
    sector[target.surface === 'ceilingHeight' ? 'ceilingAsset' : 'floorAsset'] = assetId;
  } else if (target?.kind === 'wall') {
    const wall = project.map.walls.find(item => item.id === target.id);
    if (!wall) throw new Error('That wall no longer exists');
    const side = target.side ? wall[target.side] : null;
    if (side) side[WALL_PARTS.has(target.part) ? target.part : 'middle'] = assetId;
    else wall.assetId = assetId;
  } else throw new Error('Drop the asset on a wall, floor or ceiling');
  return `Applied ${asset.name} to ${describeSurfaceTarget(target)}`;
}

export function applyEntitySprite(project, entityId, assetId) {
  const asset = requireImageAsset(project, assetId);
  const entity = project.map.entities.find(candidate => candidate.id === entityId);
  if (!entity) throw new Error('That object no longer exists');
  const hadModel = Boolean(entity.modelAsset);
  entity.spriteAsset = assetId;
  if (hadModel) { delete entity.modelAsset; delete entity.animation; }
  return `Sprite ${asset.name} set on ${entity.name}${hadModel ? ' (3D model removed)' : ''}`;
}

export function applyEntityModel(project, entityId, assetId) {
  const asset = requireModelAsset(project, assetId);
  const entity = project.map.entities.find(candidate => candidate.id === entityId);
  if (!entity) throw new Error('That object no longer exists');
  if (entity.type === 'player') throw new Error('Assign world models to a non-player object');
  entity.modelAsset = assetId;
  delete entity.animation;
  return `Model ${asset.name} set on ${entity.name}`;
}

export function moveEntityToFloor(project, entityId, x, y) {
  const entity = project.map.entities.find(candidate => candidate.id === entityId);
  if (!entity) throw new Error('That object no longer exists');
  entity.x = x;
  entity.y = y;
  entity.elevation = 0;
  return `${entity.name} moved to the floor at ${x}, ${y}`;
}

function uniqueName(entities, base) {
  const names = new Set(entities.map(entity => entity.name));
  if (!names.has(base)) return base;
  for (let index = 2; ; index++) if (!names.has(`${base} ${index}`)) return `${base} ${index}`;
}

/**
 * Dropping a model on the scene places a new object that already carries it. The
 * type stays editable afterwards, so a decoration is the neutral default.
 */
export function addEntityWithModel(project, { id, x, y, elevation = 0, assetId, type = 'decoration', name }) {
  const asset = requireModelAsset(project, assetId);
  if (type === 'player') throw new Error('The player object cannot be placed as a model');
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Drop the model on the scene to place it');
  const base = (name || asset.name.replace(/\.[^.]+$/, '') || 'Decoration').slice(0, 100);
  const entity = {
    id: id || newId('entity'), type, name: uniqueName(project.map.entities, base),
    x: Math.round(x), y: Math.round(y), elevation: Math.round(elevation) || 0, angle: 0, modelAsset: assetId,
  };
  project.map.entities.push(entity);
  return `${asset.name} placed as a ${type} at ${entity.x}, ${entity.y}`;
}

// Screen-space drag along a world axis, mirroring the axis handle behaviour:
// project a reference axis of `length` world units and take the pointer's projection on it.
export function axisDragAmount({ originX, originY, tipX, tipY, width, height, deltaX, deltaY, length = 50 }) {
  const dx = (tipX - originX) * width / 2, dy = -(tipY - originY) * height / 2;
  const screenLength = dx * dx + dy * dy;
  if (!(screenLength > 1)) return -deltaY;
  return (deltaX * dx + deltaY * dy) / screenLength * length;
}
