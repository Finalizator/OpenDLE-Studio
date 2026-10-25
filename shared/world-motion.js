import { sectorAt } from './sectors.js';
import { floorAt, soundEvent } from './combat.js';

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
    if (wall.specialFormat === 'zdoom') { unhandled.add(`zdoom:${special}`); continue; }
    const local = manual.has(special), door = doors.get(special), lift = lifts.get(special);
    const lower = floorLower.get(special), raise = floorRaise.get(special), perpetual = [53, 87].includes(special);
    if (!local && !door && !lift && !lower && !raise && !perpetual) { unhandled.add(special); continue; }
    const targets = local ? project.map.sectors.filter(sector => sector.id === wall.left?.sectorId)
      : project.map.sectors.filter(sector => wall.tag > 0 && sector.tag === wall.tag);
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
  if (unhandled.size) warnings.push(`Linedef specials not yet translated into visual rules: ${[...unhandled].join(', ')}.`);
}
