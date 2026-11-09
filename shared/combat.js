import { sectorAt, entitySector, containsPoint } from './sectors.js';
import { traceGrid, forEachCellAlong } from './trace-grid.js';
import { recordDamage } from './player-state.js';

/**
 * The id to sector map used by the traces below.
 *
 * `geometryDistance` runs once per enemy movement candidate, so on a level with a
 * hundred monsters it is called hundreds of times per frame. Rebuilding this map per
 * call allocated thousands of entries and objects per frame, which is what the major
 * GC pauses in the browser were collecting; the sectors themselves only change height
 * in place, so the array identity (plus its length) is a safe key.
 */
const sectorMaps = new WeakMap();
function sectorMapOf(state) {
  const cached = sectorMaps.get(state.sectors);
  if (cached && cached.length === state.sectors.length) return cached.map;
  const map = new Map(state.sectors.map(sector => [sector.id, sector]));
  sectorMaps.set(state.sectors, { length: state.sectors.length, map });
  return map;
}

export function damagePlayer(state, amount, direction = 'front') {
  if (state.playerStats.invulnerable > 0 || state.playerStats.health <= 0) return;
  if (state.settings?.difficulty === 1) amount = Math.floor(amount / 2);
  const stats = state.playerStats, absorbed = Math.min(stats.armor, Math.floor(amount / stats.armorDivisor));
  stats.armor -= absorbed; stats.health = Math.max(0, stats.health - (amount - absorbed));
  recordDamage(state, amount - absorbed, direction);
}
export function randomDamage(state, damage, sides) {
  state.randomSeed = (Math.imul(state.randomSeed, 1664525) + 1013904223) >>> 0;
  return damage * (1 + Math.floor(state.randomSeed / 4294967296 * sides));
}
export function soundEvent(state, name, volume = 1, position) {
  if (state.sounds.length >= 64) { state.soundOverflow = (state.soundOverflow || 0) + 1; return; }
  state.sounds.push({ name, volume, ...(position ? { x: position.x, y: position.y } : {}) });
}
/** The height a thing occupies: its own `z` when set, otherwise its sector floor. */
export function floorAt(state, position) {
  return position.z ?? (sectorAt(state.sectors, position.x, position.y)?.floorHeight ?? 0) + (position.elevation || 0);
}

export function entityHeight(entity) {
  return entity.type === 'player' ? 56 : entity.height ?? (entity.physics?.body !== 'none' ? entity.physics?.height : undefined) ?? 56;
}
/**
 * Sector floor directly under a position, ignoring the height the thing occupies.
 *
 * Spawning uses this: a map spot or spawner keeps its own `z` from whenever it was
 * moved, and copying that height put the new actor inside the floor.
 */
export function sectorFloorAt(state, position) {
  const sector = sectorAt(state.sectors, position.x, position.y);
  return sector ? sector.floorHeight : (position.z ?? 0);
}
/**
 * Whether the player can reach an item: inside the box around it, inside the
 * vertical window, and (unless `overSteps`) not separated from it by a wall. A
 * shelf or a ledge is a solid wall around a raised floor, so reaching up onto one
 * skips the trace — otherwise a chainsaw sitting on a ledge could never be taken.
 */
export function playerReachesEntity(state, entity, distance, height, below, { overSteps = false, stepHeight = 24 } = {}) {
  const dx = entity.x - state.player.x, dy = entity.y - state.player.y;
  const playerFloor = floorAt(state, state.player), itemFloor = floorAt(state, entity);
  const rise = itemFloor - playerFloor;
  if (Math.abs(dx) >= distance || Math.abs(dy) >= distance || rise > height || rise < -below) return false;
  if (overSteps && rise > stepHeight) return true;
  const range = Math.hypot(dx, dy);
  const origin = { x: state.player.x, y: state.player.y, z: Math.max(playerFloor, itemFloor) + 1 };
  return geometryDistance(state, origin, { x: dx / (range || 1), y: dy / (range || 1), z: 0 }, range + .01, true) >= range;
}
export function entityDistance(state, origin, direction, entity, range, radius = entity.radius ?? 20) {
  const bottom = floorAt(state, entity), top = bottom + entityHeight(entity);
  const ox = origin.x - entity.x, oy = origin.y - entity.y;
  const a = direction.x ** 2 + direction.y ** 2, b = 2 * (ox * direction.x + oy * direction.y), c = ox ** 2 + oy ** 2 - radius ** 2;
  const discriminant = b * b - 4 * a * c;
  const candidates = c <= 0 && origin.z >= bottom && origin.z <= top ? [0] : [];
  if (a > 1e-9 && discriminant >= 0) candidates.push((-b - Math.sqrt(discriminant)) / (2 * a), (-b + Math.sqrt(discriminant)) / (2 * a));
  if (Math.abs(direction.z) > 1e-9) candidates.push((bottom - origin.z) / direction.z, (top - origin.z) / direction.z);
  let nearest = range;
  for (const distance of candidates) {
    const z = origin.z + direction.z * distance, x = ox + direction.x * distance, y = oy + direction.y * distance;
    if (distance >= 0 && distance < nearest && z >= bottom - 1e-7 && z <= top + 1e-7 && x * x + y * y <= radius ** 2 + 1e-7) nearest = distance;
  }
  return nearest < range ? nearest : null;
}
// Traces geometry in 3D so open portals do not behave like solid walls.
export function geometryDistance(state, origin, direction, range, movement = false) {
  let nearest = range;
  const sectors = sectorMapOf(state);
  const vertical = direction.z || 0;
  const testWall = wall => {
    const sx = wall.end.x - wall.start.x, sy = wall.end.y - wall.start.y;
    const cross = direction.x * sy - direction.y * sx;
    if (Math.abs(cross) < 1e-9) return;
    const qx = wall.start.x - origin.x, qy = wall.start.y - origin.y;
    const distance = (qx * sy - qy * sx) / cross, u = (qx * direction.y - qy * direction.x) / cross;
    if (distance <= 1e-5 || distance >= nearest || u < 0 || u > 1) return;
    const front = sectors.get(wall.right?.sectorId), back = sectors.get(wall.left?.sectorId);
    const height = origin.z + vertical * distance;
    if (!(movement && wall.solid) && front && back && height > Math.max(front.floorHeight, back.floorHeight) && height < Math.min(front.ceilingHeight, back.ceilingHeight)) return;
    if (!front && !back && !wall.solid) return;
    nearest = distance;
  };
  // Two height planes per sector, without building a two element array for each of them.
  const testSector = sector => {
    let distance = (sector.floorHeight - origin.z) / vertical;
    if (distance > 1e-5 && distance < nearest && containsPoint(sector.rings, origin.x + direction.x * distance, origin.y + direction.y * distance)) nearest = distance;
    if (sector.sky) return;
    distance = (sector.ceilingHeight - origin.z) / vertical;
    if (distance > 1e-5 && distance < nearest && containsPoint(sector.rings, origin.x + direction.x * distance, origin.y + direction.y * distance)) nearest = distance;
  };
  // Walls, floors and ceilings are only tested in the cells the ray crosses, stopping as
  // soon as every remaining cell is further away than the closest hit so far. A trace that
  // starts outside the level (a script spawning one) still gets the exhaustive sweep.
  const grid = traceGrid(state);
  const inside = origin.x >= grid.minX && origin.x <= grid.maxX && origin.y >= grid.minY && origin.y <= grid.maxY;
  if (inside) {
    const visited = vertical ? new Set() : null;
    forEachCellAlong(grid, origin.x, origin.y, direction.x, direction.y, range, (walls, cellSectors, exit) => {
      for (let index = 0; index < walls.length; index++) testWall(walls[index]);
      if (visited) for (let index = 0; index < cellSectors.length; index++) {
        const sector = cellSectors[index];
        if (visited.has(sector)) continue;
        visited.add(sector);
        testSector(sector);
      }
      return nearest <= exit;
    });
    if (visited) for (let index = 0; index < grid.oversizedSectors.length; index++) {
      const sector = grid.oversizedSectors[index];
      if (!visited.has(sector)) testSector(sector);
    }
    return nearest;
  }
  for (let index = 0; index < state.walls.length; index++) testWall(state.walls[index]);
  if (Math.abs(vertical) > 1e-9) for (const sector of state.sectors) testSector(sector);
  return nearest;
}
/**
 * How far Doom's `P_CheckSight` looks: as far as the level reaches.
 *
 * Doom has no sight radius at all — a monster notices a player across a courtyard as readily as
 * one in the next room — and what keeps a monster's vision short is that every wall, step and
 * shut door between the two blocks the trace. Range is therefore geometry, not a distance.
 */
export const SIGHT_RANGE = 1 << 24;

/**
 * Where a thing looks from and is looked at: Doom's `z + height - height/4`, three quarters of
 * the way up its own body. Using it for both ends is what stops a monster on a floor below
 * seeing the player's feet over the edge of a step.
 */
export function sightEyeHeight(state, thing) {
  const height = entityHeight(thing) || 56;
  return floorAt(state, thing) + height - (height >> 2);
}

/**
 * Doom's P_CheckSight: within range, inside the field of view, and not hidden
 * behind solid geometry. `target` is the player or another monster, which is what
 * lets monsters notice whoever is shooting at them.
 *
 * The trace runs from eye to eye, so a two-sided line only lets the sight through while the
 * opening between the two sectors covers the height the sight line crosses it at: a shut door,
 * a raised ledge and a lowered ceiling all hide what is behind them, and a wall between two
 * rooms hides the player completely instead of being something to shoot at.
 */
export function canSeeTarget(state, entity, target, range = SIGHT_RANGE, fov = 360) {
  if (!target) return false;
  const ox = entity.x, oy = entity.y, oz = sightEyeHeight(state, entity);
  const dx = target.x - ox, dy = target.y - oy;
  const horizontal = Math.hypot(dx, dy);
  const dz = sightEyeHeight(state, target) - oz;
  const distance = Math.hypot(horizontal, dz);
  // Doom's `P_LookForPlayers` refuses a target behind the monster's back, except one close
  // enough to touch: `dist > MELEERANGE` is what makes the angle matter at all.
  if (fov < 360 && horizontal > 64) {
    const facing = (entity.angle || 0) * Math.PI / 180;
    const delta = Math.atan2(Math.sin(Math.atan2(dy, dx) - facing), Math.cos(Math.atan2(dy, dx) - facing));
    if (Math.abs(delta) > fov * Math.PI / 360) return false;
  }
  if (!(distance <= range)) return false;
  if (!(distance > 0)) return true;
  return geometryDistance(state, { x: ox, y: oy, z: oz },
    { x: dx / distance, y: dy / distance, z: dz / distance }, distance + .01) >= distance;
}

/** Who a monster is hunting: the thing that hurt it, or else the player. */
function targetOf(state, entity) {
  if (entity?.targetId && entity.targetId !== '$player') {
    const other = state.entities.find(candidate => candidate.id === entity.targetId && (candidate.health ?? 0) > 0);
    if (other) return other;
  }
  return state.player;
}

/**
 * Doom's `P_CheckMeleeRange`: in reach **and** in sight.
 *
 * The sight test is the whole point of it. Without it a monster whose target stood on the other
 * side of a wall walked into that wall and punched it for as long as the fight lasted.
 */
export function checkMeleeRange(state, entity, target = null, radius = null) {
  const who = target || targetOf(state, entity);
  if (!who) return false;
  if (Math.hypot(who.x - entity.x, who.y - entity.y) >= 64 - 20 + (radius ?? entity.radius ?? 20)) return false;
  return canSeeTarget(state, entity, who, SIGHT_RANGE);
}
export function canSeePlayer(state, entity, range, fov = 360) {
  // A monster's sight is asked about several times in one frame — the See rule, the alert
  // rule and the hearing check — and answering it traces the geometry under the whole level.
  // Everything it depends on is compared here, and the memo is dropped at the start of every
  // frame so a door that opens is never missed.
  const player = state.player, memo = state.sightMemo ||= new Map();
  const previous = memo.get(entity.id);
  if (previous && previous.range === range && previous.fov === fov && previous.ex === entity.x &&
    previous.ey === entity.y && previous.ez === entity.z && previous.angle === entity.angle &&
    previous.px === player.x && previous.py === player.y && previous.pz === player.z) return previous.value;
  const value = canSeeTarget(state, entity, player, range, fov);
  memo.set(entity.id, { range, fov, ex: entity.x, ey: entity.y, ez: entity.z, angle: entity.angle,
    px: player.x, py: player.y, pz: player.z, value });
  return value;
}
// The sector the current noise came from, worked out once per shot rather than per object.
const noiseSectors = new WeakMap();
function noiseSector(state, noise) {
  const cached = noiseSectors.get(noise);
  if (cached && cached.sectors === state.sectors) return cached.sector;
  const sector = sectorAt(state.sectors, noise.x, noise.y);
  noiseSectors.set(noise, { sectors: state.sectors, sector });
  return sector;
}
export function canHearPlayer(state, entity) {
  const noise = state.playerNoise;
  // A shot is fired inside the actor step, which runs after the event rules that
  // ask this question, so a noise within the last couple of tics still counts.
  if (!noise || state.time - noise.time > .06) return false;
  if (entity.ambush && !canSeePlayer(state, entity, 65536)) return false;
  // Every object in the level asks this question on the tic a shot lands, so the two
  // sector lookups are cached: the noise stays put, and an object that has not moved
  // keeps the sector it reported a moment ago.
  const source = noiseSector(state, noise);
  const target = entitySector(state.sectors, entity);
  if (!source || !target) return !state.sectors.length && canSeePlayer(state, entity, 65536);
  if (state.soundFlood?.noise !== noise || state.soundFlood.revision !== state.worldRevision) {
    const sectors = sectorMapOf(state);
    const links = new Map();
    for (const wall of state.walls) {
      const a = sectors.get(wall.right?.sectorId), b = sectors.get(wall.left?.sectorId);
      if (!a || !b || a.id === b.id || Math.min(a.ceilingHeight, b.ceilingHeight) <= Math.max(a.floorHeight, b.floorHeight)) continue;
      for (const [from, to] of [[a.id, b.id], [b.id, a.id]]) {
        if (!links.has(from)) links.set(from, []);
        links.get(from).push({ to, blocks: wall.flags & 64 ? 1 : 0 });
      }
    }
    const reached = new Map([[source.id, 0]]), queue = [source.id];
    for (let i = 0; i < queue.length; i++) for (const { to, blocks } of links.get(queue[i]) || []) {
      const count = reached.get(queue[i]) + blocks;
      if (count > 1 || (reached.has(to) && reached.get(to) <= count)) continue;
      reached.set(to, count); queue.push(to);
    }
    state.soundFlood = { noise, revision: state.worldRevision, reached };
  }
  return state.soundFlood.reached.has(target.id);
}
/** The object that fired a missile: the player, or the monster entity. */
export function projectileSource(state, projectile) {
  if (!projectile?.ownerId || projectile.ownerId === '$player') return state.player;
  return state.entities.find(entity => entity.id === projectile.ownerId) || null;
}

// Doom's monster types, by the numbers its maps place them with, grouped by what
// `P_CheckMissileRange` asks of each of them.
const MELEE_MONSTERS = new Set([3002, 58, 3003, 69, 66]);   // demon, spectre, baron, hell knight, revenant
const ARCHVILE = 64, REVENANT = 66, LOST_SOUL = 3006, CYBERDEMON = 16, SPIDER_MASTERMIND = 7;

/**
 * Doom's `P_CheckMissileRange`: whether a monster may fire this tic.
 *
 * It begins with `P_CheckSight`, and that is the whole reason a monster stops firing: a target
 * it cannot see is a target it does not shoot at, so a wall between the two ends the attack
 * instead of collecting hitscan after hitscan that never leaves the room.
 *
 * `missile`/`melee` come from the actor's own states when the rule was generated; without them
 * the Doom thing number decides, which is what a campaign imported before the hints existed has.
 */
export function enemyAttackChance(state, entity, { missile = null, melee = null } = {}) {
  const target = targetOf(state, entity);
  if (!target) return false;
  const meleeOnly = missile === false || (missile === null && [3002, 58].includes(entity.doomType));
  // A monster with no missile state never rolls for one in Doom: its only attack is the melee,
  // so the honest answer is whether it is in reach of one.
  if (meleeOnly) return checkMeleeRange(state, entity, target);
  if (!canSeeTarget(state, entity, target, SIGHT_RANGE)) return false;
  // Doom's MF_JUSTHIT: a monster that was just hurt always fights back on its next chance.
  if (entity.justHit) { entity.justHit = false; return true; }
  let distance = Math.hypot(target.x - entity.x, target.y - entity.y) - 64;
  const hasMelee = melee === null ? MELEE_MONSTERS.has(entity.doomType) : Boolean(melee);
  if (!hasMelee) distance -= 128;
  // The archvile works at a distance and gives up past 896 units; the revenant refuses to fire
  // when it is close enough to punch instead.
  if (entity.doomType === ARCHVILE && distance > 14 * 64) return false;
  if (entity.doomType === REVENANT) {
    if (distance < 196) return false;
    distance = Math.floor(distance / 2);
  }
  if ([CYBERDEMON, SPIDER_MASTERMIND, LOST_SOUL].includes(entity.doomType)) distance = Math.floor(distance / 2);
  if (distance > 200) distance = 200;
  if (entity.doomType === CYBERDEMON && distance > 160) distance = 160;
  // P_Random() < dist means "hold fire", so the nearer the target the likelier the shot.
  return randomDamage(state, 1, 256) - 1 >= distance;
}
export function enemyHitscan(state, entity, action) {
  if (entity.health <= 0 || !canSeePlayer(state, entity, action.range)) return;
  const origin = { x: entity.x, y: entity.y, z: sightEyeHeight(state, entity) };
  const dx = state.player.x - entity.x, dy = state.player.y - entity.y;
  const angle = Math.atan2(dy, dx);
  const pitch = Math.atan2(floorAt(state, state.player) + 28 - origin.z, Math.hypot(dx, dy));
  for (let i = 0; i < (action.pellets ?? 1); i++) {
    // Doom's blur sphere: `P_LineAttack` fires a blurred target's attacker wide, which is what
    // makes the player hard to hit while the sphere runs.
    const blurred = state.playerStats.invisible > 0 ? (randomDamage(state, 1, 256) - randomDamage(state, 1, 256)) * 12 * Math.PI / 180 : 0;
    const offset = blurred + (action.spread ? (randomDamage(state, 1, 256) - randomDamage(state, 1, 256)) * action.spread / 256 * Math.PI / 180 : 0);
    const direction = { x: Math.cos(angle + offset) * Math.cos(pitch), y: Math.sin(angle + offset) * Math.cos(pitch), z: Math.sin(pitch) };
    const limit = geometryDistance(state, origin, direction, action.range);
    const damage = randomDamage(state, action.damage, action.diceSides);
    if (entityDistance(state, origin, direction, state.player, limit, 16) !== null) damagePlayer(state, damage);
  }
}
// The eight directions a monster can step in, in the order Doom tries them.
const ENEMY_DIRECTIONS = Array.from({ length: 8 }, (unused, index) => ({ x: Math.cos(index * Math.PI / 4), y: Math.sin(index * Math.PI / 4) }));
const ENEMY_SEARCH = [0, 1, 7, 2, 6, 3, 5, 4];

/** Doom's `FLOATSPEED`: four map units a tic, the rate a flying monster rises or sinks. */
const FLOAT_SPEED = 4 * 35;

/**
 * Whether a monster flies: Doom's `MF_FLOAT`.
 *
 * A flying thing ignores floor steps when it moves (`P_TryMove` waives the 24-unit limit for
 * `FLOAT`), needs only the air above it rather than a room it fits in, and hovers towards its
 * target instead of standing on the floor. `A_ChangeFlag` overrides the actor's own flag.
 */
export function enemyFloats(entity) {
  const overrides = entity?.actorFlags;
  if (overrides) for (const name of Object.keys(overrides)) {
    if (name.toLowerCase() === 'float') return Boolean(overrides[name]);
  }
  return entity?.floating === true;
}

/**
 * Rises or sinks towards the target's middle, as `P_Move` does for a float monster.
 *
 * Doom only floats while the target is under it (`dist < delta*3`), which is why a Cacodemon
 * closes in near the floor and lifts as it arrives. The floor under it and the ceiling above
 * it stop it; a room with no ceiling above the thing's height leaves it where it is.
 */
function floatTowards(state, entity, target, distance, floor, dt) {
  const sector = sectorAt(state.sectors, entity.x, entity.y);
  const height = entity.height ?? 56;
  const rate = FLOAT_SPEED * dt;
  const delta = floorAt(state, target) + entityHeight(target) / 2 - floor;
  let height2 = floor;
  if (delta < 0 && distance < -delta * 3) height2 = Math.max(sector?.floorHeight ?? floor, floor - rate);
  else if (delta > 0 && distance < delta * 3) {
    const ceiling = sector ? sector.ceilingHeight : floor + height;
    height2 = Math.min(Math.max(floor, ceiling - height), floor + rate);
  }
  if (height2 === entity.z) return false;
  entity.z = height2;
  return true;
}

export function moveEnemy(state, entity, speed, dt, target = state.player) {
  if (entity.health <= 0 || speed <= 0 || dt <= 0) return;
  const angle = Math.atan2(target.y - entity.y, target.x - entity.x);
  const distance = Math.hypot(target.x - entity.x, target.y - entity.y);
  const step = Math.min(speed * dt, Math.max(0, distance - 36));
  if (!step) return;
  // Every monster is moved every frame, so this stays allocation-free apart from one
  // small origin object: no candidate arrays, no Sets and no sector scans per wall.
  const flying = enemyFloats(entity);
  if (flying && !Number.isFinite(entity.z)) entity.z = floorAt(state, entity);
  const entityFloor = floorAt(state, entity);
  const hovered = flying && floatTowards(state, entity, target, distance, entityFloor, dt);
  // A flyer's own height is what its body occupies; a walker's is the floor it stands on.
  const floor = flying ? entity.z : entityFloor;
  const origin = { x: entity.x, y: entity.y, z: floor + 28 };
  const previous = state.enemyMoves.get(entity.id);
  const toward = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  const reverse = previous ? (previous.direction + 4) % 8 : -1;
  const sectors = sectorMapOf(state);
  const walkable = index => {
    const direction = ENEMY_DIRECTIONS[index];
    if (geometryDistance(state, origin, direction, step + 16, true) < step + 16) return false;
    const x = entity.x + direction.x * step, y = entity.y + direction.y * step;
    const sector = sectorAt(state.sectors, x, y);
    if (state.sectors.length) {
      if (!sector) return false;
      // A walker needs a room it fits in and no step it cannot climb. A flyer only needs the
      // air it occupies: the pit under it and the floor on the far side are not in its way.
      if (flying ? sector.ceilingHeight - floor < 56
        : sector.ceilingHeight - sector.floorHeight < 56 || Math.abs(sector.floorHeight - entityFloor) > 24) return false;
    }
    for (const other of state.entities) {
      if (other !== entity && other.type === 'enemy' && other.health > 0 && Math.hypot(other.x - x, other.y - y) < 32) return false;
    }
    for (const wall of state.walls) {
      const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
      const t = Math.max(0, Math.min(1, ((x - wall.start.x) * dx + (y - wall.start.y) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(x - wall.start.x - t * dx, y - wall.start.y - t * dy) >= 16) continue;
      if (wall.flags & 2) {
        // ML_BLOCKMONSTERS: stop a step that crosses the line or closes in on it, but let a
        // monster that starts beside one walk away.
        const length = Math.hypot(dx, dy) || 1;
        const before = ((entity.x - wall.start.x) * dy - (entity.y - wall.start.y) * dx) / length;
        const after = ((x - wall.start.x) * dy - (y - wall.start.y) * dx) / length;
        if (Math.sign(before) !== Math.sign(after) || Math.abs(after) < Math.abs(before)) return false;
      }
      const front = sectors.get(wall.right?.sectorId), back = sectors.get(wall.left?.sectorId);
      if (!wall.solid && front && back && (flying
        ? Math.min(front.ceilingHeight, back.ceilingHeight) - floor >= 56
        : Math.min(front.ceilingHeight, back.ceilingHeight) - Math.max(front.floorHeight, back.floorHeight) >= 56 &&
          Math.max(front.floorHeight, back.floorHeight) - entityFloor <= 24)) continue;
      if (!wall.solid && !front && !back) continue;
      return false;
    }
    entity.x = x; entity.y = y; entity.angle = index * 45;
    state.enemyMoves.set(entity.id, { direction: index, remaining: previous?.direction === index && previous.remaining > 0
      ? previous.remaining - step : speed * (4 / 35) * randomDamage(state, 1, 16) });
    if (flying) {
      // A flyer keeps its own height; teleporting it to the sector floor is what pinned it
      // to the ground and made it walk through a level it was supposed to fly over.
      state.physics?.teleport(entity.id, x, y, entity.z);
    } else {
      entity.z = sector?.floorHeight ?? entityFloor;
      state.physics?.teleport(entity.id, x, y, sector?.floorHeight);
    }
    return true;
  };
  // Keep a direction that still has ground to cover, otherwise search from the way the
  // target lies, and try the opposite of the last direction last.
  if (previous?.remaining > 0 && previous.direction !== reverse && walkable(previous.direction)) return;
  for (const offset of ENEMY_SEARCH) {
    const index = (toward + offset) % 8;
    if (index === reverse) continue;
    if (walkable(index)) return;
  }
  if (reverse >= 0) walkable(reverse);
  // A flyer that is boxed in still hovers towards its target, which is what lifts a Cacodemon
  // over the ledge it cannot climb.
  if (hovered) state.physics?.teleport(entity.id, entity.x, entity.y, entity.z);
}
export function launchProjectile(state, action, owner) {
  if (state.projectiles.length >= 256) throw new Error('Projectile limit exceeded');
  const { angleOffset = 0, spawnOffset = 0, spawnHeight = 0, pitchOffset = 0, seeker = false, ...shot } = action;
  const origin = owner || state.player;
  // A weapon can fire from beside the player instead of through the middle, and a
  // mod can raise or lower the spawn point (A_FireCustomMissile's spawnofs/spawnheight).
  const facing = owner ? Math.atan2(state.player.y - owner.y, state.player.x - owner.x) : state.player.angle;
  const side = facing - Math.PI / 2;
  const x = origin.x + Math.cos(side) * spawnOffset, y = origin.y + Math.sin(side) * spawnOffset;
  const z = floorAt(state, origin) + (owner ? 32 : 40) + spawnHeight;
  const aim = owner ? facing : state.player.angle;
  const angle = angleOffset ? aim + angleOffset * Math.PI / 180 : aim;
  const pitch = owner
    ? Math.atan2(floorAt(state, state.player) + 32 - z, Math.hypot(state.player.x - x, state.player.y - y))
    : Math.max(-1.4, Math.min(1.4, state.player.pitch + pitchOffset * Math.PI / 180));
  const projectile = { id: ++state.projectileSequence, ownerId: owner?.id || '$player', x, y, z,
    dx: Math.cos(angle) * Math.cos(pitch), dy: Math.sin(angle) * Math.cos(pitch), dz: Math.sin(pitch), age: 0, ...shot };
  // A seeking missile locks onto the nearest enemy the player is looking at.
  if (seeker && !owner) projectile.tracerId = lockOn(state)?.id || null;
  state.projectiles.push(projectile);
  state.lastShot = owner ? state.lastShot : { time: state.time, hits: [] };
  if (!owner) state.playerNoise = { time: state.time, x: origin.x, y: origin.y };
  return projectile;
}

/** The enemy a homing shot should follow: nearest to the aim line, in front. */
function lockOn(state) {
  const player = state.player, eye = floorAt(state, player) + 48;
  let best = null, bestDistance = 1024;
  for (const entity of state.entities) {
    if (entity.type !== 'enemy' || (entity.health ?? 0) <= 0) continue;
    const distance = Math.hypot(entity.x - player.x, entity.y - player.y);
    if (distance >= bestDistance) continue;
    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(entity.y - player.y, entity.x - player.x) - player.angle),
      Math.cos(Math.atan2(entity.y - player.y, entity.x - player.x) - player.angle)));
    if (off > 20 * Math.PI / 180) continue;
    if (geometryDistance(state, { x: player.x, y: player.y, z: eye },
      { x: (entity.x - player.x) / (distance || 1), y: (entity.y - player.y) / (distance || 1), z: 0 }, distance) < distance) continue;
    best = entity; bestDistance = distance;
  }
  return best;
}
/**
 * Moves every projectile. `onDeath` runs where a shot lands: the actor runtime
 * passes its Death-state handler so a missile explodes from its own definition.
 */
export function advanceProjectiles(state, dt, onDeath, onDamage) {
  // `onDamage(entity, amount, source, damageType)` lets the actor runtime apply
  // pain, infighting and damage-type factors; without it the engine still lowers health.
  const hurt = (entity, amount, source, damageType) => {
    if (entity === state.player) { damagePlayer(state, amount); return; }
    if (onDamage) onDamage(entity, amount, source, damageType);
    else entity.health = Math.max(0, (entity.health ?? 20) - amount);
  };
  const survivors = [];
  for (const projectile of state.projectiles) {
    const travel = projectile.speed * dt;
    let nearest = geometryDistance(state, projectile, { x: projectile.dx, y: projectile.dy, z: projectile.dz }, travel);
    let target = null;
    // A player missile hits monsters; a monster missile hits the player and other
    // monsters, which is how a stray rocket starts an infight.
    const fromPlayer = !projectile.ownerId || projectile.ownerId === '$player';
    const targets = fromPlayer
      ? state.entities.filter(entity => entity.type === 'enemy' && entity.health > 0)
      : [...state.entities.filter(entity => entity.type === 'enemy' && entity.health > 0 && entity.id !== projectile.ownerId),
        ...(state.playerStats.health > 0 ? [state.player] : [])];
    for (const entity of targets) {
      const distance = entityDistance(state, projectile, { x: projectile.dx, y: projectile.dy, z: projectile.dz }, entity, nearest);
      if (distance !== null) { nearest = distance; target = entity; }
    }
    projectile.x += projectile.dx * nearest; projectile.y += projectile.dy * nearest; projectile.z += projectile.dz * nearest; projectile.age += dt;
    if (target || nearest < travel) {
      const source = projectileSource(state, projectile);
      const hit = entity => hurt(entity, randomDamage(state, projectile.damage, projectile.diceSides), source, projectile.damageType);
      if (target) hit(target);
      if (projectile.radius > 0) {
        const victims = [...state.entities.filter(e => e.type === 'enemy' && e.health > 0), ...(state.playerStats.health > 0 ? [state.player] : [])];
        for (const entity of victims) {
          const z = floorAt(state, entity) + 28, distance = Math.hypot(entity.x - projectile.x, entity.y - projectile.y, z - projectile.z);
          if (distance >= projectile.radius) continue;
          const direction = { x: (entity.x - projectile.x) / (distance || 1), y: (entity.y - projectile.y) / (distance || 1), z: (z - projectile.z) / (distance || 1) };
          const start = { x: projectile.x - projectile.dx * .1, y: projectile.y - projectile.dy * .1, z: projectile.z - projectile.dz * .1 };
          if (geometryDistance(state, start, direction, distance + .1) < distance) continue;
          const amount = Math.max(0, Math.round(projectile.radius - distance));
          hurt(entity, amount, source, projectile.damageType);
        }
      }
      if (projectile.sound) soundEvent(state, projectile.sound, .7, projectile);
      if (projectile.impactClipId) {
        if (state.impacts.length >= 256) state.impacts.shift();
        state.impacts.push({ id: `impact_${projectile.id}`, x: projectile.x, y: projectile.y, z: projectile.z, clipId: projectile.impactClipId, start: state.time });
      }
      // The missile's own Death states carry its explosion (A_Explode) and the BFG
      // spray, so they run where the shot lands.
      if (projectile.actorId) onDeath?.(projectile);
    } else if (projectile.age < 8) survivors.push(projectile);
  }
  state.projectiles = survivors;
}
