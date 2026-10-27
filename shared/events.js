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

function sameContext(a, b) {
  return a.sheetId === b.sheetId && a.groupId === b.groupId && a.ownerId === b.ownerId && a.forEachType === b.forEachType;
}

/**
 * Move a rule (with its sub-events) so it becomes a sibling of `targetId`, directly
 * before or after it. Used by dragging a row in the visual editor; the order of
 * `project.events` is the execution order, so this is also the order rules run in.
 */
export function moveEventBranchBeside(project, id, targetId, position = 'before') {
  if (id === targetId) return;
  if (position !== 'before' && position !== 'after') throw new Error(`Unknown drop position ${position}`);
  const event = project.events.find(item => item.id === id);
  const target = project.events.find(item => item.id === targetId);
  if (!event || !target) throw new Error('That rule no longer exists');
  const moved = eventBranch(project.events, id);
  if (moved.has(targetId)) throw new Error('A rule cannot be dropped inside itself');
  // Sub-events share their parent's sheet, group and object context, so a drop that
  // changed any of those would produce a structure the validator rejects.
  if (!sameContext(event, target)) throw new Error('Rules can only be reordered within the same sheet, group and object context');
  const branch = project.events.filter(item => moved.has(item.id));
  const remaining = project.events.filter(item => !moved.has(item.id));
  if (target.parentId === undefined) delete branch[0].parentId; else branch[0].parentId = target.parentId;
  const targetIndex = remaining.findIndex(item => item.id === targetId);
  const at = position === 'after'
    ? remaining.findLastIndex(item => eventBranch(remaining, targetId).has(item.id)) + 1
    : targetIndex;
  remaining.splice(at, 0, ...branch);
  project.events = remaining;
}

/** Re-parent a rule branch: indent it under another rule, or outdent it to top level. */
export function setEventParent(project, id, parentId = null) {
  const event = project.events.find(item => item.id === id);
  if (!event) throw new Error('That rule no longer exists');
  const moved = eventBranch(project.events, id);
  if (parentId !== null) {
    if (parentId === id || moved.has(parentId)) throw new Error('A rule cannot be dropped inside itself');
    const parent = project.events.find(item => item.id === parentId);
    if (!parent) throw new Error('That parent rule no longer exists');
    if (!sameContext(event, parent)) throw new Error('Sub-events must share the parent rule sheet, group and object context');
    event.parentId = parentId;
    const branch = project.events.filter(item => moved.has(item.id));
    const remaining = project.events.filter(item => !moved.has(item.id));
    // Sub-events must stay contiguous with their parent, so the branch goes after the
    // parent's existing children.
    const lastChild = remaining.findLastIndex(item => item.parentId === parentId);
    const at = lastChild >= 0 ? lastChild + 1 : remaining.findIndex(item => item.id === parentId) + 1;
    remaining.splice(at, 0, ...branch);
    project.events = remaining;
    return;
  }
  if (event.parentId === undefined) return;
  const oldParent = event.parentId;
  delete event.parentId;
  const branch = project.events.filter(item => moved.has(item.id));
  const remaining = project.events.filter(item => !moved.has(item.id));
  // Outdenting keeps the branch together and puts it straight after its old parent.
  const lastOfParent = remaining.findLastIndex(item => eventBranch(remaining, oldParent).has(item.id));
  const at = lastOfParent >= 0 ? lastOfParent + 1 : remaining.length;
  remaining.splice(at, 0, ...branch);
  project.events = remaining;
}

/** Reorder the additional conditions of one rule (the first condition stays first). */
export function moveCondition(event, from, to) {
  const list = [event.condition, ...(event.conditions || [])];
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) throw new Error('Condition position is out of range');
  if (from === to) return;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  event.condition = list[0];
  if (list.length > 1) event.conditions = list.slice(1); else delete event.conditions;
}

/** Reorder one action of a rule. */
export function moveAction(event, from, to) {
  if (from < 0 || from >= event.actions.length || to < 0 || to >= event.actions.length) throw new Error('Action position is out of range');
  if (from === to) return;
  const [moved] = event.actions.splice(from, 1);
  event.actions.splice(to, 0, moved);
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
