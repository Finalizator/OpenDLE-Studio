// The main menu of an exported game.
//
// Everything here is data: no DOM, no engine. `game.js` draws what these functions return, which is
// what lets the menu be tested without a browser, and what keeps "which level comes next" in one
// place instead of in a click handler.

/** Where this game remembers how far the player got. One key per game, so two games do not mix. */
export function progressKey(title) {
  return `opendle-game-progress:${String(title || 'game').slice(0, 80)}`;
}

/** The stored progress, normalised: a level id that the project still has, or null. */
export function gameProgress(project, stored) {
  const value = stored && typeof stored === 'object' ? stored : null;
  const levelId = typeof value?.levelId === 'string' ? value.levelId : null;
  if (!levelId) return null;
  const level = (project?.game?.levels || []).find(entry => entry.id === levelId);
  return level ? { levelId: level.id, name: level.name || level.id } : null;
}

/**
 * The boot menu: a title, a line of context, and the buttons in the order a player expects.
 *
 * Continue is only offered when progress points at a level the game still has — offering it into a
 * deleted level is how a menu button becomes a crash.
 */
export function mainMenu(project, { progress = null } = {}) {
  const levels = project?.game?.levels || [];
  const actions = [];
  if (levels.length) {
    actions.push({ id: 'new', label: 'New game', hint: project?.game?.entry ? `Start at ${project.game.entry}` : 'Start at the first level' });
    if (progress) actions.push({ id: 'continue', label: 'Continue', hint: `Resume ${progress.name}` });
    actions.push({ id: 'levels', label: 'Levels', hint: `${levels.length} level${levels.length === 1 ? '' : 's'}` });
  } else {
    actions.push({ id: 'new', label: 'Play', hint: 'Start the level' });
  }
  actions.push({ id: 'options', label: 'Options', hint: 'Video, sound and controls' });
  actions.push({ id: 'quit', label: 'Quit', hint: 'Leave the game' });
  return {
    title: String(project?.title || 'OpenDLE game'),
    subtitle: levels.length
      ? `${levels.length} level${levels.length === 1 ? '' : 's'}${project?.game?.active ? ` · ${project.game.active}` : ''}`
      : 'Single level',
    actions,
  };
}

/** The level picker: every level, in campaign order, with the one that will run marked. */
export function levelEntries(project, { current = null, progress = null } = {}) {
  const levels = project?.game?.levels || [];
  const active = current || project?.game?.entry || null;
  return levels.map((level, index) => ({
    id: level.id,
    label: level.name || level.id,
    hint: `${level.id}${level.id === active ? ' · start' : ''}${progress?.levelId === level.id ? ' · reached' : ''}`,
    current: Boolean(level.id === active || (index === 0 && !active)),
  }));
}

/** Where a completed level leads. `null` means the campaign ends here. */
export function nextLevelId(project, levelId) {
  const level = (project?.game?.levels || []).find(entry => entry.id === levelId);
  if (!level) return null;
  const next = typeof level.next === 'string' ? level.next : null;
  if (!next) return null;
  return (project.game.levels || []).some(entry => entry.id === next) ? next : null;
}

/**
 * The rows the options panel shows, described by the same metadata the engine uses.
 *
 * A setting the engine does not define is not offered: a menu that shows a value it cannot store is
 * worse than one that omits it.
 */
export function optionRows(settings, definitions = {}) {
  const order = ['masterVolume', 'volume', 'musicVolume', 'sensitivity', 'invertY', 'fov', 'brightness',
    'renderResolution', 'viewSize', 'difficulty', 'alwaysRun', 'jumping', 'messages', 'muted'];
  return order.filter(name => definitions[name]).map(name => {
    const definition = definitions[name];
    const value = settings?.[name] ?? definition.value;
    const kind = definition.options ? 'choice' : typeof definition.value === 'boolean' ? 'toggle' : 'range';
    return {
      name,
      kind,
      value,
      min: definition.min,
      max: definition.max,
      step: definition.step,
      options: definition.options || null,
    };
  });
}

/** Difficulty, named the way Doom names its skills. */
export const SKILLS = ['I am too young to die', 'Hey, not too rough', 'Hurt me plenty', 'Ultra-Violence', 'Nightmare!'];
export function skillLabel(value) {
  const index = Math.round(Number(value) || 4) - 1;
  return SKILLS[Math.max(0, Math.min(SKILLS.length - 1, index))];
}
