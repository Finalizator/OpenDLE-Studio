export function importedGameplayGaps(project) {
  if (!project.map.entities.some(entity => entity.doomType !== undefined)) return [];
  const actions = project.events.flatMap(event => event.actions);
  const gaps = [];
  if (!project.hud?.elements.length) gaps.push('HUD');
  if (!project.assets?.some(asset => asset.kind === 'sound') || !actions.some(action => action.type === 'playSound')) gaps.push('sound playback');
  if (!actions.some(action => action.type === 'launchProjectile')) gaps.push('complete weapon starter');
  if (!project.events.some(event => event.condition.type === 'enemySeesPlayer')) gaps.push('enemy combat starter');
  if (!project.spriteClips?.length) gaps.push('sprite animations');
  if (project.map.walls.some(wall => wall.special > 0) && !actions.some(action => action.type === 'moveSector')) gaps.push('door/lift rules');
  return gaps;
}
