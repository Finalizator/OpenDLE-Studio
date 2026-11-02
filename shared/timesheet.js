/**
 * Timesheets: a timeline of cues that runs inside the game.
 *
 * A timesheet is the editor's answer to a video editor's timeline: tracks stacked over a single
 * clock, each holding cues at absolute times. A cue carries ordinary visual-script actions —
 * the same `ENGINE_ACTIONS` an event sheet uses — so a timeline can set a variable, move a
 * model, play a sound or start another timesheet without a second scripting language.
 *
 * Nothing here starts on its own. An event has to `startTimesheet`, which is the same rule the
 * engine applies to everything else: the map is data, and only rules make things happen. Once
 * started, the clock advances with the game's own `state.time`, so a timesheet pauses when the
 * game pauses and keeps its place through a save.
 *
 * Cues are executed by the rule runner, not by a second executor: `timesheetCueEvents` turns each
 * cue into an ordinary rule whose condition asks the runtime whether that cue is due this frame.
 * That way expressions, `$self` resolution, object targets and every action already written keep
 * working, and a cue is a rule the tests can drive like any other.
 */

import { pointAlong, sampleLengths, samplePath, waypointDistances } from './paths.js';

/** The private condition a cue's generated rule uses. Never offered in the editor. */
export const TIMESHEET_CUE_CONDITION = 'timesheetCue';

export const TIMESHEET_LIMITS = { duration: [.5, 3600], cues: 512, tracks: 8, name: 60 };
export const TIMESHEET_TRACK_COLORS = ['#6fa8dc', '#e0a45e', '#8bd17c', '#c98bdb', '#e07a7a', '#7ad4d0', '#c9c07a', '#9ba4e0'];
/** How close a cue has to be to the playhead before a drag snaps to it, in seconds. */
export const TIMESHEET_SNAP = .05;

const clampDuration = value => Math.min(TIMESHEET_LIMITS.duration[1],
  Math.max(TIMESHEET_LIMITS.duration[0], Number(value) || 30));

export function createTrack(index = 0, overrides = {}) {
  return { id: `track_${index + 1}`, name: `Track ${index + 1}`, ...overrides };
}

export function createTimesheet({ id, name = 'Timesheet 1', duration = 30, loop = false } = {}) {
  return { id, name, duration, loop, tracks: [createTrack(0)], cues: [] };
}

export function createCue({ id, time = 0, trackId, name = 'Cue', ownerId = null, actions = [] } = {}) {
  return { id, name, trackId, time, ownerId, actions };
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

/**
 * Validates one timesheet. `trackIds` is passed in so a project-level check can look at every
 * sheet at once and still report the cue that is wrong.
 */
export function validateTimesheet(sheet, project = {}) {
  if (!plain(sheet)) fail('A timesheet must be an object');
  if (typeof sheet.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(sheet.id)) fail('A timesheet needs a simple id');
  if (typeof sheet.name !== 'string' || !sheet.name.trim() || sheet.name.length > TIMESHEET_LIMITS.name) fail('A timesheet needs a name of 1-60 characters');
  const duration = Number(sheet.duration);
  if (!Number.isFinite(duration) || duration < TIMESHEET_LIMITS.duration[0] || duration > TIMESHEET_LIMITS.duration[1])
    fail(`Timesheet "${sheet.name}" duration must be ${TIMESHEET_LIMITS.duration[0]}-${TIMESHEET_LIMITS.duration[1]} seconds`);
  if (typeof sheet.loop !== 'boolean') fail(`Timesheet "${sheet.name}" loop must be a yes/no choice`);
  const tracks = Array.isArray(sheet.tracks) ? sheet.tracks : fail(`Timesheet "${sheet.name}" needs a track list`);
  if (!tracks.length || tracks.length > TIMESHEET_LIMITS.tracks) fail(`Timesheet "${sheet.name}" needs 1-${TIMESHEET_LIMITS.tracks} tracks`);
  const trackIds = new Set();
  for (const track of tracks) {
    if (!plain(track) || typeof track.id !== 'string' || !track.id) fail(`Timesheet "${sheet.name}" has a track with no id`);
    if (trackIds.has(track.id)) fail(`Timesheet "${sheet.name}" repeats track ${track.id}`);
    if (typeof track.name !== 'string' || track.name.length > TIMESHEET_LIMITS.name) fail(`Timesheet "${sheet.name}" track ${track.id} needs a name`);
    trackIds.add(track.id);
  }
  const cues = Array.isArray(sheet.cues) ? sheet.cues : fail(`Timesheet "${sheet.name}" needs a cue list`);
  if (cues.length > TIMESHEET_LIMITS.cues) fail(`Timesheet "${sheet.name}" has more than ${TIMESHEET_LIMITS.cues} cues`);
  const cueIds = new Set();
  for (const cue of cues) {
    if (!plain(cue) || typeof cue.id !== 'string' || !cue.id) fail(`Timesheet "${sheet.name}" has a cue with no id`);
    if (cueIds.has(cue.id)) fail(`Timesheet "${sheet.name}" repeats cue ${cue.id}`);
    cueIds.add(cue.id);
    if (!trackIds.has(cue.trackId)) fail(`Timesheet "${sheet.name}" cue "${cue.name}" is on a track that does not exist`);
    const time = Number(cue.time);
    if (!Number.isFinite(time) || time < 0 || time > duration + 1e-9)
      fail(`Timesheet "${sheet.name}" cue "${cue.name}" must be between 0 and ${duration} seconds`);
    if (cue.ownerId !== null && cue.ownerId !== undefined &&
      !(project.map?.entities || []).some(entity => entity.id === cue.ownerId))
      fail(`Timesheet "${sheet.name}" cue "${cue.name}" targets an object that does not exist`);
    if (!Array.isArray(cue.actions)) fail(`Timesheet "${sheet.name}" cue "${cue.name}" needs an action list`);
  }
}

/** A stable key for the rule cache: two equal timelines must produce the same string. */
export function timesheetSignature(timesheets = []) {
  return timesheets.map(sheet => `${sheet.id}/${sheet.duration}/${sheet.cues.length}/` +
    sheet.cues.map(cue => `${cue.id}@${Number(cue.time)}#${cue.trackId}#${cue.ownerId || ''}#${cue.actions.length}`).join(',')).join('|');
}

/**
 * One ordinary rule per cue, for `ruleTree`.
 *
 * The rule's id is namespaced so it can never collide with a user rule — and sanitised to the
 * character set an event id allows, because a project id may carry dots or colons — and it
 * carries no sheet, so it runs in the default `afterPhysics` phase like a hand-written event.
 */
const safeId = value => String(value).replace(/[^a-zA-Z0-9_-]/g, '_');

export function timesheetCueEvents(timesheets = []) {
  const events = [];
  for (const sheet of timesheets) for (const cue of sheet.cues || []) {
    events.push({
      id: `timesheet_${safeId(sheet.id)}__${safeId(cue.id)}`,
      enabled: true,
      once: false,
      // `undefined`, not null: an owner-less rule must not claim an owner it does not have.
      ownerId: cue.ownerId || undefined,
      condition: { type: TIMESHEET_CUE_CONDITION, timesheetId: sheet.id, cueId: cue.id },
      conditions: [],
      actions: cue.actions || [],
      // Not part of the rule language: these let diagnostics name the cue that ran.
      timesheetId: sheet.id,
      cueId: cue.id,
    });
  }
  return events;
}

/** Cues whose time falls in `(from, to]`, which is how a clock crossing them is detected. */
export function cuesBetween(cues, from, to) {
  return (cues || []).filter(cue => cue.time > from + 1e-9 && cue.time <= to + 1e-9);
}

function runs(state) {
  return state.timesheets || (state.timesheets = new Map());
}

/** The live run of a timesheet, or null when it is not running. */
export function timesheetRun(state, id) {
  return state.timesheets?.get(id) || null;
}

/**
 * Whether a cue is due, consuming it when it is.
 *
 * Consuming on the question rather than on a frame boundary is what makes a cue exactly-once
 * per crossing: the rule runner evaluates the cue's condition once per frame, and a cue queued
 * by `startTimesheetRun` (a cue at 0 seconds) cannot be cleared by a clock step that has not
 * executed it yet.
 */
export function cueDue(state, timesheetId, cueId) {
  const run = state.timesheets?.get(timesheetId);
  if (!run?.due?.has(cueId)) return false;
  run.due.delete(cueId);
  return true;
}

/**
 * Starts (or restarts) a timesheet.
 *
 * `restart` is the default because a cue that says "start" almost always means "from the top";
 * a run that is already going and is asked to continue keeps its clock, which is what makes
 * `restart: no` useful for resuming after a stop.
 */
export function startTimesheetRun(project, state, timesheetId, { loop = null, restart = true } = {}) {
  const sheet = (project.timesheets || []).find(item => item.id === timesheetId);
  if (!sheet) return false;
  const book = runs(state);
  const existing = book.get(timesheetId);
  if (existing && !restart && existing.playing) return true;
  const run = {
    time: existing && !restart ? existing.time : 0,
    playing: true,
    paused: false,
    loop: loop === null ? Boolean(sheet.loop) : Boolean(loop),
    passes: existing && !restart ? existing.passes || 0 : 0,
    due: new Set(),
  };
  // Cues on the first frame have not been crossed by a clock, so they are queued here; without
  // this a cue at 0 seconds — the usual "set the scene up" cue — would never fire.
  if (run.time === 0) for (const cue of sheet.cues || []) if (cue.time <= 1e-9) run.due.add(cue.id);
  book.set(timesheetId, run);
  return true;
}

export function stopTimesheetRun(state, timesheetId) {
  const book = state.timesheets;
  if (!book) return false;
  if (timesheetId === 'all' || timesheetId === undefined || timesheetId === null) {
    const had = book.size > 0;
    book.clear();
    return had;
  }
  return book.delete(timesheetId);
}

export function setTimesheetPaused(state, timesheetId, paused) {
  const run = state.timesheets?.get(timesheetId);
  if (!run) return false;
  run.paused = Boolean(paused);
  return true;
}

/** The action types that name a timeline; `stopTimesheet` may also say "all" and name none. */
const SHEET_ACTIONS = new Set(['startTimesheet', 'stopTimesheet', 'setTimesheetPaused']);

const namesSheet = (action, timesheetId) => Boolean(action) && SHEET_ACTIONS.has(action.type) && action.timesheetId === timesheetId;

/**
 * Everything that points at one timeline, in rules and in other timelines' cues.
 *
 * A rule that starts a timeline names it, and a project that names a timeline it does not have is
 * invalid — which is why deleting a timeline has to know about its references instead of leaving
 * them behind for the validator.
 */
export function timesheetReferences(project, timesheetId) {
  const actions = [];
  for (const event of project.events || []) for (const action of event.actions || []) if (namesSheet(action, timesheetId)) actions.push(action);
  for (const sheet of project.timesheets || [])
    for (const cue of sheet.cues || []) for (const action of cue.actions || []) if (namesSheet(action, timesheetId)) actions.push(action);
  return { actions };
}

/**
 * Deletes a timeline from a draft project, releasing what referenced it.
 *
 * Any action that named this timeline is dropped, the same way deleting a route drops the actions
 * that walked it. A rule whose actions were *only* that one goes with it — a rule that existed to
 * start this timeline has nothing left to say, and leaving it behind is the "stray start I cannot
 * remove" the editor used to produce. A rule that does anything else, or that owns sub-events,
 * keeps its place. Both counts come back so the editor can say what the delete took with it.
 * Returns null when the timeline is already gone.
 */
export function removeTimesheet(project, timesheetId) {
  const sheet = (project.timesheets || []).find(item => item.id === timesheetId);
  if (!sheet) return null;
  const { actions } = timesheetReferences(project, timesheetId);
  const drop = list => (list || []).filter(action => !namesSheet(action, timesheetId));
  const emptied = new Set();
  for (const event of project.events || []) {
    const before = (event.actions || []).length;
    event.actions = drop(event.actions);
    if (before && !event.actions.length) emptied.add(event.id);
  }
  for (const other of project.timesheets) for (const cue of other.cues || []) cue.actions = drop(cue.actions);
  // A rule that owns sub-events is a parent, not a start button, so it survives.
  const parents = new Set((project.events || []).map(event => event.parentId).filter(Boolean));
  const before = (project.events || []).length;
  project.events = (project.events || []).filter(event => !emptied.has(event.id) || parents.has(event.id));
  project.timesheets = project.timesheets.filter(item => item.id !== timesheetId);
  return { sheet, actions: actions.length, rules: before - project.events.length };
}

/**
 * Advances every running timesheet by `dt` seconds and marks the cues the clock crossed.
 *
 * A loop wraps the clock, and a step that straddles the end of the timeline is split so the cues
 * on both sides of the boundary fire in the right order — otherwise a frame rate of 30 fps would
 * step over the wrap and silently skip everything in the seconds it covered.
 */
export function advanceTimesheets(project, state, dt) {
  const book = state.timesheets;
  if (!book?.size) return 0;
  const byId = new Map((project.timesheets || []).map(sheet => [sheet.id, sheet]));
  let fired = 0;
  for (const [id, run] of book) {
    // `due` is not cleared here: a cue is consumed by the rule that runs it (`cueDue`), so a
    // cue queued by `startTimesheetRun` survives until the frame that executes it.
    if (!run.due) run.due = new Set();
    if (!run.playing || run.paused) continue;
    const sheet = byId.get(id);
    // A timeline deleted while it was running stops rather than throwing every frame.
    if (!sheet) { run.playing = false; continue; }
    const duration = Math.max(.001, Number(sheet.duration) || 0);
    let remaining = Math.max(0, dt), guard = 0;
    while (remaining > 0 && guard++ < 64) {
      const step = Math.min(remaining, duration - run.time);
      const to = run.time + step;
      for (const cue of cuesBetween(sheet.cues, run.time, to)) { run.due.add(cue.id); fired++; }
      run.time = to; remaining -= step;
      if (run.time >= duration - 1e-9) {
        if (!run.loop) { run.time = duration; run.playing = false; remaining = 0; break; }
        // The wrap is a crossing of 0, so a cue sitting exactly on 0 fires on every pass.
        run.time = 0; run.passes = (run.passes || 0) + 1;
        for (const cue of sheet.cues || []) if (cue.time <= 1e-9) { run.due.add(cue.id); fired++; }
      }
    }
  }
  return fired;
}

/* ---------------------------------------------------------------------------------------------
   Moving an object along a route between two of its waypoints
   --------------------------------------------------------------------------------------------- */

export const PATH_EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut'];

/** The easing curves a path move can use, all mapping 0..1 onto 0..1. */
export function easingValue(name, t) {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  switch (name) {
    case 'easeIn': return x * x;
    case 'easeOut': return 1 - (1 - x) * (1 - x);
    case 'easeInOut': return x < .5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
    default: return x;
  }
}

/**
 * Sends an object along a route from one waypoint to another over `seconds`.
 *
 * `fromPoint`/`toPoint` are waypoint indices; a negative `toPoint` means the last waypoint, so
 * "walk this whole route" needs no arithmetic in the cue. The move is measured by arc length, so
 * the object travels at an even speed along a curve with unevenly spaced points, and it replaces
 * any move already running for that object rather than stacking two on top of each other.
 */
export function startPathTween(state, { entityId, pathId, fromPoint = 0, toPoint = -1, seconds = 2,
  easing = 'linear', faceDirection = true, yawOffset = 0, useModelFacing = true } = {}) {
  const tweens = state.pathTweens || (state.pathTweens = []);
  const keep = tweens.filter(tween => tween.entityId !== entityId);
  // The route is a *shape*, and the object travels it from wherever it already stands: a cue that
  // sends three decorations along the same curve moves all three, instead of stacking them on the
  // route's first waypoint. The offset is taken now, before the first sample moves anything.
  const entity = (state.entities || []).find(item => item.id === entityId);
  keep.push({ entityId, pathId, fromPoint, toPoint, seconds: Math.max(.05, Number(seconds) || 2),
    easing: PATH_EASINGS.includes(easing) ? easing : 'linear', faceDirection: faceDirection !== false, elapsed: 0,
    // Whether the object's declared model facing turns the body onto the route (exact) or the
    // model keeps the pose it was given and is turned by however much the route bends.
    useModelFacing: useModelFacing !== false,
    yawOffset: Number.isFinite(Number(yawOffset)) ? Number(yawOffset) : 0,
    // How the object was posed before the trip: a model keeps that pose and is turned by how much
    // the route bends, where a sprite (whose forward the engine defines) is turned onto the route.
    authoredAngle: entity ? Number(entity.angle) || 0 : 0, startHeading: null,
    origin: entity ? { x: entity.x, y: entity.y, z: entity.z || 0 } : null, anchor: null });
  state.pathTweens = keep;
  return true;
}

const wrap360 = value => ((value % 360) + 360) % 360;

/**
 * Which way a tweened object faces at a given point of its route.
 *
 * A sprite's forward is the engine's — Doom's 0° is east, and the sprite frames are drawn for it —
 * so a sprite is turned *onto* the route. An imported model's forward is whatever the file says,
 * and the author poses it in the editor to make that readable; snapping such a model to the route
 * heading made a pre-rotated truck drive sideways, so a model keeps the pose it was given and is
 * turned by however much the route bends. `yawOffset` is added on top for a model whose own
 * forward still needs a correction.
 *
 * `useModelFacing: false` on the tween asks for the pose rule even when a facing is declared, which
 * is what an author wants when the model was posed for this route by hand and the facing belongs to
 * some other trip.
 */
export function tweenAngle(entity, tween, heading) {
  // A declared facing makes the model's nose the object's angle, so the angle is simply the route's
  // — exact, and the same rule a sprite follows. Without one, an imported model keeps the pose the
  // author gave it and is turned by how much the road bends.
  const declared = tween?.useModelFacing !== false
    && entity?.modelFacing !== undefined && Number.isFinite(Number(entity.modelFacing));
  const route = entity?.modelAsset && !declared
    ? (Number(tween.authoredAngle) || 0) + (heading - (tween.startHeading ?? heading))
    : heading;
  return wrap360(route + (Number(tween.yawOffset) || 0));
}

/** Advances every tween and leaves `state.pathCompleted` naming the ones that just finished. */
export function advancePathTweens(project, state, dt) {
  const tweens = state.pathTweens;
  if (!tweens?.length) return 0;
  const finished = [];
  let moved = 0;
  const remaining = [];
  for (const tween of tweens) {
    const entity = (state.entities || []).find(item => item.id === tween.entityId);
    const path = (project.paths || []).find(item => item.id === tween.pathId);
    if (!entity || !path) { finished.push(tween.entityId); continue; }
    tween.elapsed = Math.min(tween.seconds, tween.elapsed + Math.max(0, dt));
    const { distances, total } = waypointDistances(path);
    if (!(total > 0)) { finished.push(tween.entityId); continue; }
    const fromIndex = Math.min(Math.max(0, Math.round(tween.fromPoint) || 0), distances.length - 1);
    const toIndex = tween.toPoint < 0 ? distances.length - 1 : Math.min(Math.round(tween.toPoint) || 0, distances.length - 1);
    const startDistance = distances[fromIndex], endDistance = distances[toIndex];
    const progress = easingValue(tween.easing, tween.elapsed / tween.seconds);
    const distance = startDistance + (endDistance - startDistance) * progress;
    const where = pointAlong(path, distance / total);
    if (!where) { finished.push(tween.entityId); continue; }
    // Where the route's `from` waypoint is, so the object keeps its own starting position and
    // only the route's shape moves it.
    if (!tween.anchor) {
      const start = pointAlong(path, startDistance / total);
      tween.anchor = start ? { x: start.x, y: start.y, z: start.z || 0 } : { x: 0, y: 0, z: 0 };
    }
    // The object's own displacement from the route is taken from where it was *authored*, once,
    // not from wherever the previous trip left it: reading the live position made a looping
    // timeline carry an object off the end of its road (100, 200, 300 for a route ending at 100)
    // and doubled the distance of a trip restarted halfway.
    if (!tween.originFrom) {
      const authored = (project.map.entities || []).find(item => item.id === tween.entityId);
      tween.originFrom = authored
        ? { x: authored.x, y: authored.y, z: authored.z || 0 }
        // An object the level made during play has no authored position, so it keeps the one it
        // had when the trip started.
        : { ...(tween.origin || { x: 0, y: 0, z: 0 }) };
    }
    const origin = tween.originFrom;
    entity.x = origin.x + (where.x - tween.anchor.x);
    entity.y = origin.y + (where.y - tween.anchor.y);
    entity.z = origin.z + ((where.z || 0) - tween.anchor.z);
    if (tween.startHeading === null || tween.startHeading === undefined) tween.startHeading = where.angle;
    if (tween.faceDirection) entity.angle = tweenAngle(entity, tween, where.angle);
    moved++;
    if (tween.elapsed >= tween.seconds - 1e-9) finished.push(tween.entityId);
    else remaining.push(tween);
  }
  state.pathTweens = remaining;
  state.pathCompleted = finished;
  return moved;
}
