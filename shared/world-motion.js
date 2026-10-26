import { sectorAt } from './sectors.js';
import { floorAt, soundEvent } from './combat.js';
import { doomSpecialBehaviour, doomSpecialName } from './doom-specials.js';

function intersection(a, b, wall) {
  const dx = b.x - a.x, dy = b.y - a.y, sx = wall.end.x - wall.start.x, sy = wall.end.y - wall.start.y;
  const cross = dx * sy - dy * sx;
  if (Math.abs(cross) < 1e-9) return null;
  const qx = wall.start.x - a.x, qy = wall.start.y - a.y;
  const t = (qx * sy - qy * sx) / cross, u = (qx * dy - qy * dx) / cross;
  return t > 1e-6 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

export function useWall(state) {
  const a = state.player, b = { x: a.x + Math.cos(a.angle) * 64, y: a.y + Math.sin(a.angle) * 64 };
  let nearest = 2, selected = null;
  for (const wall of state.walls) {
    const t = intersection(a, b, wall);
    if (t === null || t >= nearest) continue;
    const front = state.sectors.find(sector => sector.id === wall.right?.sectorId);
    const back = state.sectors.find(sector => sector.id === wall.left?.sectorId);
    if (!wall.special && front && back && !wall.solid && Math.min(front.ceilingHeight, back.ceilingHeight) > floorAt(state, a) + 48) continue;
    nearest = t; selected = wall.id;
  }
  return selected;
}

export function crossedWalls(state, previous) {
  return new Set(state.walls.filter(wall => intersection(previous, state.player, wall) !== null).map(wall => wall.id));
}

export function moveSector(state, action) {
  const key = `${action.sectorId}:${action.surface}`, sector = state.sectors.find(sector => sector.id === action.sectorId);
  const existing = state.sectorMotions.get(key);
  if (existing) {
    if (action.surface === 'ceilingHeight' && existing.direction === 'return') existing.direction = 'out';
    return;
  }
  if (!sector) throw new Error(`Unknown moving sector ${action.sectorId}`);
  state.sectorMotions.set(key, { ...action, origin: action.returnHeight ?? sector[action.surface], direction: 'out', waiting: 0 });
  if (action.sound) soundEvent(state, action.sound, .7);
}

export function advanceSectors(state, dt) {
  for (const [key, motion] of state.sectorMotions) {
    const sector = state.sectors.find(sector => sector.id === motion.sectorId);
    if (motion.waiting > 0) { motion.waiting -= dt; continue; }
    const old = sector[motion.surface], target = motion.direction === 'out' ? motion.height : motion.origin;
    const next = old + Math.sign(target - old) * Math.min(Math.abs(target - old), motion.speed * dt);
    const occupants = [...state.entities.filter(entity => entity.type === 'enemy' && entity.health > 0), state.player]
      .filter(entity => sectorAt(state.sectors, entity.x, entity.y)?.id === sector.id);
    if (motion.surface === 'ceilingHeight' && next < old && occupants.some(entity => floorAt(state, entity) + 56 > next)) {
      motion.direction = motion.direction === 'out' ? 'return' : 'out'; continue;
    }
    if (motion.surface === 'floorHeight' && next > old && occupants.some(entity => Math.max(floorAt(state, entity), next) + 56 > sector.ceilingHeight)) continue;
    sector[motion.surface] = next;
    if (next !== old) {
      state.worldRevision++;
      if (motion.surface === 'floorHeight') for (const entity of [...state.entities.filter(e => e.type !== 'player'), state.player]) {
        if (sectorAt(state.sectors, entity.x, entity.y)?.id !== sector.id) continue;
        const bottom = entity.z ?? old + (entity.elevation || 0);
        if (Math.abs(bottom - old) > 2 && bottom > next) continue;
        const z = bottom + next - old;
        if (entity === state.player) {
          entity.z = z;
          const playerEntity = state.entities.find(e => e.type === 'player');
          if (state.physics) state.physics.teleport(playerEntity.id, entity.x, entity.y, z);
          else playerEntity.z = z;
        } else {
          entity.z = z; state.physics?.teleport(entity.id, entity.x, entity.y, z);
        }
      }
    }
    if (next !== target) continue;
    if (motion.direction === 'out' && motion.returnMode !== 'stay') {
      motion.direction = 'return'; motion.waiting = motion.wait;
    } else if (motion.returnMode === 'cycle') {
      motion.direction = 'out'; motion.waiting = motion.wait;
    } else state.sectorMotions.delete(key);
  }
}

const manual = new Map([[1, null], [26, 'blue'], [27, 'yellow'], [28, 'red'], [31, null], [32, 'blue'], [33, 'red'], [34, 'yellow'], [117, null], [118, null]]);
const doors = new Map([
  [2, ['cross', 'stay']], [3, ['cross', 'close']], [4, ['cross', 'return']], [16, ['cross', 'close']],
  [29, ['use', 'return']], [42, ['use', 'close']], [46, ['shoot', 'stay']], [50, ['use', 'close']], [61, ['use', 'stay']],
  [63, ['use', 'return']], [75, ['cross', 'close']], [76, ['cross', 'close']], [86, ['cross', 'stay']], [90, ['cross', 'return']],
  [103, ['use', 'stay']], [105, ['cross', 'return']], [106, ['cross', 'stay']], [107, ['cross', 'close']],
  [108, ['cross', 'return']], [109, ['cross', 'stay']], [110, ['cross', 'close']], [111, ['use', 'return']], [112, ['use', 'stay']],
  [113, ['use', 'close']], [114, ['use', 'return']], [115, ['use', 'stay']], [116, ['use', 'close']],
]);
const lifts = new Map([[10, 'cross'], [21, 'use'], [62, 'use'], [88, 'cross'], [120, 'cross'], [121, 'cross'], [122, 'use'], [123, 'use']]);
const floorLower = new Map([[19, 'cross'], [23, 'use'], [36, 'cross'], [37, 'cross'], [38, 'cross'], [60, 'use'], [70, 'use'], [71, 'use'], [82, 'cross'], [83, 'cross'], [84, 'cross'], [98, 'cross'], [102, 'use']]);
const floorRaise = new Map([[5, 'cross'], [18, 'use'], [24, 'shoot'], [30, 'cross'], [45, 'use'], [56, 'cross'], [58, 'cross'], [59, 'cross'], [64, 'use'], [65, 'use'], [69, 'use'], [91, 'cross'], [92, 'cross'], [93, 'cross'], [94, 'cross'], [96, 'cross'], [101, 'use'], [119, 'cross'], [128, 'cross'], [129, 'cross'], [130, 'cross'], [131, 'use'], [132, 'use']]);
const repeatable = new Set([1, 26, 27, 28, 42, 46, 60, 61, 62, 63, 64, 65, 69, 70, 75, 76, 82, 83, 84, 86, 88, 90, 91, 92, 93, 94, 96, 98, 105, 106, 107, 114, 115, 116, 117, 120, 123, 128, 129, 132]);

/**
 * Whether the classic rule translator performs a Doom special. Reporting uses it
 * so a classic number is never judged against the Hexen table.
 */
export function classicSpecialSupported(special) {
  return manual.has(special) || doors.has(special) || lifts.has(special) || floorLower.has(special) ||
    floorRaise.has(special) || [53, 87, 11, 51, 52, 124, 197, 198].includes(special) ||
    Boolean(doomSpecialBehaviour(special));
}

export function installWorldScripts(project, warnings) {
  const sheetId = project.eventSheets.find(sheet => sheet.name === 'World').id;
  const groupId = project.eventGroups.find(group => group.sheetId === sheetId).id;
  const used = new Set(project.events.map(event => event.id));
  let sequence = 0;
  function rule(name, condition, actions, extra = {}) {
    let id;
    do { id = `world_special_${sequence++}`; } while (used.has(id));
    used.add(id);
    project.events.push({ id, name, sheetId, groupId, enabled: true, once: false, condition, conditions: [], actions, ...extra });
    return id;
  }
  const unhandled = new Set();
  for (const wall of project.map.walls) {
    const special = wall.special || 0;
    if (!special) continue;
    // UDMF and Hexen-format lines carry Hexen special numbers with explicit
    // arguments and activation flags, so the runtime executes them directly
    // through the line-special table instead of generating a visual rule.
    if (wall.specialFormat === 'zdoom') continue;
    const classicExit = [11, 51, 52, 124, 197, 198].includes(special);
    if (classicExit) {
      const modes = [[52, 124].includes(special) ? 'cross' : [197, 198].includes(special) ? 'shoot' : 'use'];
      for (const mode of modes) rule(`Exit level / ${wall.id}`, { type: 'wallActivated', wallId: wall.id, mode },
        [{ type: 'finishLevel', exit: [51, 124, 198, 244].includes(special) ? 'secret' : 'normal' }], { once: true });
      continue;
    }
    const local = manual.has(special), door = doors.get(special), lift = lifts.get(special);
    const lower = floorLower.get(special), raise = floorRaise.get(special), perpetual = [53, 87].includes(special);
    const targets = local ? project.map.sectors.filter(sector => sector.id === wall.left?.sectorId)
      : project.map.sectors.filter(sector => wall.tag > 0 && sector.tag === wall.tag);
    if (!local && !door && !lift && !lower && !raise && !perpetual) {
      // Specials Doom defines but the height rules above do not cover: teleports,
      // key doors, crush ceilings, stairs and "raise and change" floors.
      const behaviour = doomSpecialBehaviour(special);
      // Doom's key doors open the sector behind the line itself; the rest act on
      // every sector carrying the line's tag.
      const classicTargets = behaviour?.effect.key
        ? project.map.sectors.filter(sector => sector.id === wall.left?.sectorId) : targets;
      if (behaviour && !classicTargets.length) {
        warnings.push(`Linedef ${wall.id} special ${special} (${doomSpecialName(special)}) has no target sector.`);
        continue;
      }
      const classic = behaviour && classicActions(project, wall, behaviour, classicTargets, warnings);
      if (!classic?.length) { unhandled.add(special); continue; }
      const classicCondition = { type: 'wallActivated', wallId: wall.id, mode: behaviour.mode };
      const classicName = `Linedef ${wall.id} / ${doomSpecialName(special) || `special ${special}`}`.slice(0, 100);
      if (behaviour.effect.key) {
        const parentId = rule(classicName, classicCondition, []);
        rule(`${classicName} / key`, { type: 'keyOwned', key: `${behaviour.effect.key}Card` }, classic,
          { parentId, conditionMode: 'or', conditions: [{ type: 'keyOwned', key: `${behaviour.effect.key}Skull` }] });
        rule(`${classicName} / locked`, { type: 'keyOwned', key: `${behaviour.effect.key}Card`, inverted: true },
          [{ type: 'showMessage', message: `You need the ${behaviour.effect.key} key.` }],
          { parentId, conditions: [{ type: 'keyOwned', key: `${behaviour.effect.key}Skull`, inverted: true }] });
      } else rule(classicName, classicCondition, classic, { once: behaviour.once });
      continue;
    }
    if (!targets.length) { warnings.push(`Linedef ${wall.id} special ${special} has no target sector.`); continue; }
    const actions = [];
    for (const sector of targets) {
      const adjacentIds = new Set(project.map.walls.filter(w => w.right?.sectorId === sector.id || w.left?.sectorId === sector.id)
        .flatMap(w => [w.right?.sectorId, w.left?.sectorId]).filter(id => id && id !== sector.id));
      const neighbors = project.map.sectors.filter(s => adjacentIds.has(s.id));
      if (!neighbors.length) continue;
      const ceiling = local || door;
      const closing = door?.[1] === 'close';
      let height = ceiling ? closing ? sector.floorHeight : Math.min(...neighbors.map(s => s.ceilingHeight)) - 4
        : lower || lift || perpetual ? Math.min(sector.floorHeight, ...neighbors.map(s => s.floorHeight))
          : Math.min(...neighbors.map(s => s.floorHeight).filter(height => height > sector.floorHeight));
      if (raise && [5, 56, 64, 65, 101, 94].includes(special)) height = Math.min(...neighbors.map(s => s.ceilingHeight), sector.ceilingHeight);
      if (raise && [58, 59, 92, 93].includes(special)) height = sector.floorHeight + 24;
      if (!Number.isFinite(height)) { warnings.push(`Linedef ${wall.id}: no neighboring height for special ${special}.`); continue; }
      actions.push({ type: 'moveSector', sectorId: sector.id, surface: ceiling ? 'ceilingHeight' : 'floorHeight', height,
        speed: special >= 105 && special <= 123 ? 280 : ceiling ? 70 : 35,
        wait: ceiling ? 4 : 3, returnMode: perpetual ? 'cycle' : lift || local && [1, 26, 27, 28, 117].includes(special) || door?.[1] === 'return' ? 'return' : 'stay',
        ...(perpetual ? { returnHeight: Math.max(sector.floorHeight, ...neighbors.map(s => s.floorHeight)) } : {}),
        sound: ceiling ? 'DSDOROPN' : 'DSPSTART' });
    }
    if (!actions.length) continue;
    const condition = { type: 'wallActivated', wallId: wall.id, mode: local ? 'use' : door?.[0] || lift || lower || raise || 'cross' };
    const name = `Linedef ${wall.id} / ${local || door ? 'door' : lift || perpetual ? 'lift' : 'floor'} ${special}`;
    const key = manual.get(special);
    if (key) {
      const parentId = rule(name, condition, []);
      rule(`${name} / key`, { type: 'keyOwned', key: `${key}Card` }, actions,
        { parentId, conditionMode: 'or', conditions: [{ type: 'keyOwned', key: `${key}Skull` }] });
      rule(`${name} / locked`, { type: 'keyOwned', key: `${key}Card`, inverted: true },
        [{ type: 'showMessage', message: `You need the ${key} key.` }], { parentId, conditions: [{ type: 'keyOwned', key: `${key}Skull`, inverted: true }] });
    } else rule(name, condition, actions, { once: !repeatable.has(special) });
  }
  if (unhandled.size) {
    const named = [...unhandled].sort((a, b) => a - b)
      .map(special => `${special} ${doomSpecialName(special) || 'Boom/ZDoom extension'}`);
    warnings.push(`Linedef specials not yet translated into visual rules: ${named.join(', ')}.`);
  }
  return { unhandled, performed: new Set(project.map.walls.map(wall => wall.special || 0).filter(Boolean)) };
}

/**
 * Turns one classic special the height tables do not cover into rule actions.
 * Targets are resolved at import because a Doom teleport destination and a stair
 * run are fixed geometry, not runtime state.
 */
function classicActions(project, wall, behaviour, targets, warnings) {
  const effect = behaviour.effect;
  if (effect.kind === 'teleport') {
    const destination = targets[0];
    if (!destination) { warnings.push(`Linedef ${wall.id} special ${wall.special}: teleport has no destination sector.`); return []; }
    const landing = teleportLanding(project, destination);
    return [{ type: 'teleport', x: landing.x, y: landing.y, z: landing.z, angle: landing.angle }];
  }
  if (effect.kind === 'door') {
    return targets.map(sector => {
      const neighbours = neighbouringSectors(project, sector);
      const open = neighbours.length ? Math.min(...neighbours.map(s => s.ceilingHeight)) - 4 : sector.ceilingHeight + 64;
      return { type: 'moveSector', sectorId: sector.id, surface: 'ceilingHeight', height: open,
        speed: effect.speed || 280, wait: 0, returnMode: 'stay', sound: 'DSDOROPN' };
    });
  }
  if (effect.kind === 'stairs') {
    // Stairs climb away from the line, one step per tagged sector.
    const ordered = [...targets].sort((a, b) => (a.bounds?.minX ?? 0) - (b.bounds?.minX ?? 0)
      || (a.bounds?.minY ?? 0) - (b.bounds?.minY ?? 0));
    const base = Math.min(...targets.map(sector => sector.floorHeight));
    return ordered.map((sector, index) => ({ type: 'moveSector', sectorId: sector.id, surface: 'floorHeight',
      height: base + effect.step * (index + 1), speed: effect.speed || 35, wait: 0, returnMode: 'stay', sound: 'DSPSTART' }));
  }
  const actions = [];
  for (const sector of targets) {
    // An isolated target sector (a switch dummy, say) still crushes between its
    // own floor and ceiling instead of being skipped.
    const neighbours = neighbouringSectors(project, sector);
    const heights = neighbours.length ? neighbours : [sector];
    const lowest = Math.min(...heights.map(s => s.floorHeight));
    if (effect.kind === 'ceiling' || effect.kind === 'ceilingThenFloor') {
      const target = effect.target === 'floor' ? sector.floorHeight : Math.min(...heights.map(s => s.ceilingHeight)) - 4;
      actions.push({ type: 'moveSector', sectorId: sector.id, surface: 'ceilingHeight', height: target,
        speed: effect.speed || 70, wait: effect.wait || 0, returnMode: effect.cycle ? 'cycle' : 'stay',
        ...(effect.cycle ? { returnHeight: Math.max(sector.ceilingHeight, ...heights.map(s => s.ceilingHeight)) } : {}),
        sound: 'DSDOROPN' });
    }
    if (effect.kind === 'floor' || effect.kind === 'ceilingThenFloor') {
      const target = effect.by ? sector.floorHeight + effect.by
        : effect.target === 'nearest' ? lowest
          : Math.min(...heights.map(s => s.ceilingHeight));
      actions.push({ type: 'moveSector', sectorId: sector.id, surface: 'floorHeight', height: target,
        speed: effect.speed || 35, wait: 0, returnMode: 'stay', sound: 'DSPSTART' });
    }
  }
  return actions;
}

/** Sectors sharing a two-sided line with this one. */
function neighbouringSectors(project, sector) {
  const ids = new Set();
  for (const wall of project.map.walls) {
    const front = wall.right?.sectorId, back = wall.left?.sectorId;
    if (front === sector.id && back) ids.add(back);
    else if (back === sector.id && front) ids.add(front);
  }
  return project.map.sectors.filter(candidate => ids.has(candidate.id));
}

/** The teleport landing spot a tagged sector holds, or its centre. */
function teleportLanding(project, sector) {
  const marker = (project?.map.entities || []).find(entity => entity.doomType === 14 &&
    entity.x >= (sector.bounds?.minX ?? -Infinity) && entity.x <= (sector.bounds?.maxX ?? Infinity) &&
    entity.y >= (sector.bounds?.minY ?? -Infinity) && entity.y <= (sector.bounds?.maxY ?? Infinity));
  if (marker) return { x: marker.x, y: marker.y, z: sector.floorHeight + 24, angle: marker.angle ?? 0 };
  const bounds = sector.bounds;
  if (!bounds) return { x: 0, y: 0, z: sector.floorHeight + 24, angle: 0 };
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, z: sector.floorHeight + 24, angle: 0 };
}
