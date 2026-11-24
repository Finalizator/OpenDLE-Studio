import { newId } from './project.js';
import { entityGroups, membersOf, groupEntities, ungroup } from './entity-groups.js';

export function selectedBounds(project, ids) {
  const entities = (project.map.entities || []).filter(entity => ids.includes(entity.id));
  if (!entities.length) return null;
  return {
    minX: Math.min(...entities.map(entity => entity.x || 0)),
    maxX: Math.max(...entities.map(entity => entity.x || 0)),
    minY: Math.min(...entities.map(entity => entity.y || 0)),
    maxY: Math.max(...entities.map(entity => entity.y || 0)),
  };
}

export function alignWorldSelection(project, ids, mode) {
  if (!ids.length) throw new Error('Select objects before aligning');
  const bounds = selectedBounds(project, ids);
  if (!bounds) throw new Error('Select objects before aligning');
  const wanted = new Set(ids);
  for (const entity of project.map.entities) {
    if (!wanted.has(entity.id)) continue;
    if (mode === 'left') entity.x = bounds.minX;
    if (mode === 'right') entity.x = bounds.maxX;
    if (mode === 'top') entity.y = bounds.minY;
    if (mode === 'bottom') entity.y = bounds.maxY;
    if (mode === 'centerX') entity.x = (bounds.minX + bounds.maxX) / 2;
    if (mode === 'centerY') entity.y = (bounds.minY + bounds.maxY) / 2;
  }
}

export function distributeWorldSelection(project, ids, axis) {
  if (ids.length < 3) throw new Error('Select at least three objects to distribute');
  const entities = project.map.entities.filter(entity => ids.includes(entity.id));
  entities.sort((a, b) => (axis === 'x' ? (a.x || 0) - (b.x || 0) : (a.y || 0) - (b.y || 0)));
  const first = entities[0], last = entities.at(-1);
  const start = axis === 'x' ? first.x || 0 : first.y || 0;
  const end = axis === 'x' ? last.x || 0 : last.y || 0;
  for (let index = 0; index < entities.length; index++) {
    const value = start + (end - start) * index / (entities.length - 1);
    if (axis === 'x') entities[index].x = value;
    else entities[index].y = value;
  }
}

export function flipWorldSelection(project, ids, axis) {
  if (!ids.length) throw new Error('Select objects before flipping');
  const bounds = selectedBounds(project, ids);
  if (!bounds) throw new Error('Select objects before flipping');
  const wanted = new Set(ids);
  for (const entity of project.map.entities) {
    if (!wanted.has(entity.id)) continue;
    if (axis === 'x') entity.x = bounds.minX + bounds.maxX - (entity.x || 0);
    else entity.y = bounds.minY + bounds.maxY - (entity.y || 0);
  }
}

export function mergeWorldSectors(project, ids) {
  const wanted = new Set(ids);
  if (wanted.size < 2) throw new Error('Select at least two sectors to merge');
  const sectors = (project.map.sectors || []).filter(sector => wanted.has(sector.id));
  if (!sectors.length || sectors.some(sector => !wanted.has(sector.id))) throw new Error('Only sectors can be merged');
  const target = sectors[0];
  target.floorHeight = Math.max(...sectors.map(sector => sector.floorHeight || 0));
  target.ceilingHeight = Math.min(...sectors.map(sector => sector.ceilingHeight || 128));
  target.light = Math.round(sectors.reduce((sum, sector) => sum + (sector.light || 0), 0) / sectors.length);
  for (const wall of project.map.walls || []) {
    if (wanted.has(wall.right?.sectorId)) wall.right.sectorId = target.id;
    if (wanted.has(wall.left?.sectorId)) wall.left.sectorId = target.id;
  }
  project.map.sectors = project.map.sectors.filter(sector => !wanted.has(sector.id) || sector.id === target.id);
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return target.id;
}

export function hollowWorldRoom(project, { x, y, width, depth, thickness = 32 }) {
  if (width <= thickness * 2 || depth <= thickness * 2) throw new Error('Room is too small to hollow');
  const minX = x, minY = y, maxX = x + width, maxY = y + depth;
  const rooms = [
    { x: minX, y: minY, width, depth: thickness },
    { x: minX, y: maxY - thickness, width, depth: thickness },
    { x: minX, y: minY + thickness, width: thickness, depth: depth - thickness * 2 },
    { x: maxX - thickness, y: minY + thickness, width: thickness, depth: depth - thickness * 2 },
  ];
  for (const room of rooms) {
    const first = project.map.vertices.length;
    const vertices = [
      { id: newId('v'), x: room.x, y: room.y },
      { id: newId('v'), x: room.x + room.width, y: room.y },
      { id: newId('v'), x: room.x + room.width, y: room.y + room.depth },
      { id: newId('v'), x: room.x, y: room.y + room.depth },
    ];
    project.map.vertices.push(...vertices);
    const sectorId = newId('sector');
    project.map.sectors.push({ id: sectorId, floorHeight: 0, ceilingHeight: 128, light: 208, sky: false });
    project.map.walls.push(...vertices.map((vertex, index) => ({
      id: newId('w'), a: vertex.id, b: vertices[(index + 1) % 4].id,
      color: '#597b9a', height: 128, solid: true,
      right: { sectorId, offsetX: 0, offsetY: 0 },
    })));
  }
  project.map.worldRevision = (project.map.worldRevision || 0) + 1;
  return rooms.length;
}


export function lockWorldEntities(project, ids) {
  project.worldLockedEntityIds = [...new Set([...(project.worldLockedEntityIds || []), ...ids])];
}

export function unlockWorldEntities(project, ids) {
  const wanted = new Set(ids);
  project.worldLockedEntityIds = (project.worldLockedEntityIds || []).filter(id => !wanted.has(id));
}

export function worldLayers(project) {
  project.worldLayers ||= [{ id: 'default', name: 'World', visible: true, locked: false }];
  return project.worldLayers;
}

export function createWorldLayer(project, name) {
  const layers = worldLayers(project);
  if (layers.length >= 64) throw new Error('A world can contain at most 64 layers');
  const base = (name || `Layer ${layers.length}`).trim().slice(0, 100);
  const id = `layer_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const layer = { id, name: base || 'Layer', visible: true, locked: false };
  layers.push(layer);
  return layer;
}

export function setWorldLayer(project, id, patch) {
  const layer = worldLayers(project).find(item => item.id === id);
  if (!layer) throw new Error('That world layer no longer exists');
  if (patch.name !== undefined) layer.name = String(patch.name).trim().slice(0, 100) || layer.name;
  if (patch.visible !== undefined) layer.visible = Boolean(patch.visible);
  if (patch.locked !== undefined) layer.locked = Boolean(patch.locked);
  if (patch.delete && id !== 'default') project.worldLayers = worldLayers(project).filter(item => item.id !== id);
  return layer;
}

export function assignWorldLayer(project, ids, layerId) {
  if (!worldLayers(project).some(layer => layer.id === layerId)) throw new Error('Unknown world layer');
  const wanted = new Set(ids);
  for (const entity of project.map.entities || []) if (wanted.has(entity.id)) entity.worldLayerId = layerId;
  for (const wall of project.map.walls || []) if (wanted.has(wall.id)) wall.worldLayerId = layerId;
  for (const sector of project.map.sectors || []) if (wanted.has(sector.id)) sector.worldLayerId = layerId;
}
