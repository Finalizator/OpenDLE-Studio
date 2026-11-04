/** Identifiers sharing the validator's global namespace; scene and route IDs are local. */
export function projectIds(project) {
  return new Set([
    ...['vertices', 'walls', 'sectors', 'entities'].flatMap(key => project.map?.[key] || []),
    ...['assets', 'spriteClips', 'shaders', 'events', 'eventSheets', 'eventGroups'].flatMap(key => project[key] || []),
    ...['elements', 'fonts', 'animations'].flatMap(key => project.hud?.[key] || []),
  ].map(item => item.id));
}
