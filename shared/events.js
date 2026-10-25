/**
 * Two authoring scopes, both ordinary editable events:
 * - "object": logic owned by one object instance (`ownerId`) or applied to every
 *   instance of an object type (`forEachType`). This is local behaviour.
 * - "game": scene/engine-wide rules that are not bound to an object instance.
 * The runtime executes both in one top-to-bottom order; the split is authoring
 * structure, not a hidden engine difference.
 */
export function eventScope(event) {
  return event.ownerId !== undefined || event.forEachType ? 'object' : 'game';
}

export function eventScopeCounts(events) {
  const counts = { object: 0, game: 0, sheets: { engine: 0, game: 0, object: 0 } };
  for (const event of events) counts[eventScope(event)]++;
  return counts;
}

export function eventDepth(events, event) {
  const byId = new Map(events.map(event => [event.id, event]));
  let depth = 0;
  while (event.parentId) { event = byId.get(event.parentId); depth++; }
  return depth;
}

export function eventBranch(events, id) {
  const ids = new Set([id]);
  for (const event of events) if (ids.has(event.parentId)) ids.add(event.id);
  return ids;
}

export function removeEventBranch(project, id) {
  const ids = eventBranch(project.events, id);
  project.events = project.events.filter(event => !ids.has(event.id));
}

export function moveEventBranch(project, id, direction) {
  const event = project.events.find(event => event.id === id);
  const siblings = project.events.filter(item => item.parentId === event.parentId && item.sheetId === event.sheetId && item.groupId === event.groupId);
  const target = siblings[siblings.indexOf(event) + direction];
  if (!target) throw new Error('No adjacent sibling event');
  const ids = eventBranch(project.events, id), branch = project.events.filter(event => ids.has(event.id));
  const remaining = project.events.filter(event => !ids.has(event.id));
  const targetIds = eventBranch(remaining, target.id);
  const position = direction < 0 ? remaining.findIndex(event => event.id === target.id)
    : remaining.findLastIndex(event => targetIds.has(event.id)) + 1;
  remaining.splice(position, 0, ...branch); project.events = remaining;
}

export function validateEventStructure(project, assert) {
  const sheets = new Map((project.eventSheets || []).map(sheet => [sheet.id, sheet]));
  const groups = new Map((project.eventGroups || []).map(group => [group.id, group]));
  const previous = new Map(), stack = [];
  for (const group of groups.values()) {
    if (group.sheetId !== undefined) assert(sheets.has(group.sheetId), 'Group references an unknown sheet');
  }
  for (const event of project.events) {
    if (event.groupId !== undefined) {
      const group = groups.get(event.groupId);
      assert(group && group.sheetId === event.sheetId, 'Event group must exist in the same sheet');
    }
    // Object-scope sheets are contracts: they only hold object-local rules.
    // Engine/game sheets remain permissive so imported projects stay valid.
    if (sheets.get(event.sheetId)?.section === 'object') {
      assert(event.ownerId !== undefined || event.forEachType,
        'An object script sheet can only contain object-owned or for-each rules');
    }
    if (event.parentId !== undefined) {
      const parent = previous.get(event.parentId);
      assert(parent, 'Sub-event parent must precede it');
      assert(stack.includes(parent.id), 'Sub-events must remain contiguous with their parent');
      assert(parent.sheetId === event.sheetId && parent.groupId === event.groupId, 'Sub-events must share their parent sheet and group');
      assert(parent.ownerId === event.ownerId && parent.forEachType === event.forEachType, 'Sub-events must share their parent object context');
      while (stack.at(-1) !== parent.id) stack.pop();
    } else stack.length = 0;
    assert(stack.length < 16, 'Sub-events may nest at most 16 levels');
    stack.push(event.id); previous.set(event.id, event);
  }
}
