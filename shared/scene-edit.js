import { sectorAt, sectorGeometry } from './sectors.js';

export function transformSelection(project, selection, mode, delta, grid) {
  const snap = value => Math.round(value / grid) * grid;
  const collections = { entity: 'entities', vertex: 'vertices', wall: 'walls', sector: 'sectors' };
  const item = project.map[collections[selection.kind]]?.find(item => item.id === selection.id);
  if (!item) throw new Error('Selected scene element no longer exists');
  if (mode !== 'move' && selection.kind !== 'entity') throw new Error('Rotation and scale apply to objects only');
  if (mode === 'rotate') { item.angle += delta.angle; return; }
  if (mode === 'scale') {
    if (item.type === 'player') throw new Error('The player capsule has a fixed size');
    const key = item.modelAsset ? 'modelScale' : 'spriteScale';
    item[key] = Math.max(item.modelAsset ? .001 : .05, Math.min(item.modelAsset ? 4096 : 16,
      (item[key] ?? (item.modelAsset ? 32 : 1)) * delta.scale));
    return;
  }
  if (selection.kind === 'sector') {
    const key = selection.surface || 'floorHeight';
    item[key] = snap(item[key] + delta.z);
  } else if (selection.kind === 'wall') {
    for (const vertex of project.map.vertices.filter(vertex => vertex.id === item.a || vertex.id === item.b)) {
      if (delta.x) vertex.x = snap(vertex.x + delta.x);
      if (delta.y) vertex.y = snap(vertex.y + delta.y);
    }
  } else {
    const oldFloor = selection.kind === 'entity' ? sectorAt(sectorGeometry(project), item.x, item.y)?.floorHeight || 0 : 0;
    if (delta.x) item.x = snap(item.x + delta.x);
    if (delta.y) item.y = snap(item.y + delta.y);
    if (selection.kind === 'entity') {
      const newFloor = sectorAt(sectorGeometry(project), item.x, item.y)?.floorHeight || 0;
      const elevation = (item.elevation || 0) + oldFloor - newFloor;
      item.elevation = delta.z ? snap(elevation + delta.z) : elevation;
    }
  }
}
