import { sectorAt, containsPoint } from './sectors.js';
import { recordDamage } from './player-state.js';

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
export function entityDistance(state, origin, direction, entity, range, radius = 20) {
  const bottom = floorAt(state, entity), top = bottom + 56;
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
  const sectors = new Map(state.sectors.map(sector => [sector.id, sector]));
  for (const wall of state.walls) {
    const sx = wall.end.x - wall.start.x, sy = wall.end.y - wall.start.y;
    const cross = direction.x * sy - direction.y * sx;
    if (Math.abs(cross) < 1e-9) continue;
    const qx = wall.start.x - origin.x, qy = wall.start.y - origin.y;
    const distance = (qx * sy - qy * sx) / cross, u = (qx * direction.y - qy * direction.x) / cross;
    if (distance <= 1e-5 || distance >= nearest || u < 0 || u > 1) continue;
    const front = sectors.get(wall.right?.sectorId), back = sectors.get(wall.left?.sectorId);
    const height = origin.z + (direction.z || 0) * distance;
    if (!(movement && wall.solid) && front && back && height > Math.max(front.floorHeight, back.floorHeight) && height < Math.min(front.ceilingHeight, back.ceilingHeight)) continue;
    if (!front && !back && !wall.solid) continue;
    nearest = distance;
  }
  if (Math.abs(direction.z || 0) > 1e-9) for (const sector of state.sectors) {
    for (const height of [sector.floorHeight, ...(sector.sky ? [] : [sector.ceilingHeight])]) {
      const distance = (height - origin.z) / direction.z;
      if (distance > 1e-5 && distance < nearest && containsPoint(sector.rings, origin.x + direction.x * distance, origin.y + direction.y * distance)) nearest = distance;
    }
  }
  return nearest;
}
/**
 * Doom's P_CheckSight: within range, inside the field of view, and not hidden
 * behind solid geometry. `target` is the player or another monster, which is what
 * lets monsters notice whoever is shooting at them.
 */
export function canSeeTarget(state, entity, target, range, fov = 360) {
  if (!target) return false;
  const origin = { x: entity.x, y: entity.y, z: floorAt(state, entity) + 36 };
  const dx = target.x - origin.x, dy = target.y - origin.y, dz = floorAt(state, target) + 36 - origin.z;
  const distance = Math.hypot(dx, dy, dz);
  const facing = (entity.angle || 0) * Math.PI / 180;
  const delta = Math.atan2(Math.sin(Math.atan2(dy, dx) - facing), Math.cos(Math.atan2(dy, dx) - facing));
  if (Math.hypot(dx, dy) > 64 && Math.abs(delta) > fov * Math.PI / 360) return false;
  return distance <= range && geometryDistance(state, origin, { x: dx / (distance || 1), y: dy / (distance || 1), z: dz / (distance || 1) }, distance + .01) >= distance;
}
export function canSeePlayer(state, entity, range, fov = 360) {
  return canSeeTarget(state, entity, state.player, range, fov);
}
export function canHearPlayer(state, entity) {
  const noise = state.playerNoise;
  // A shot is fired inside the actor step, which runs after the event rules that
  // ask this question, so a noise within the last couple of tics still counts.
  if (!noise || state.time - noise.time > .06) return false;
  if (entity.ambush && !canSeePlayer(state, entity, 65536)) return false;
  const source = sectorAt(state.sectors, noise.x, noise.y);
  const target = sectorAt(state.sectors, entity.x, entity.y);
  if (!source || !target) return !state.sectors.length && canSeePlayer(state, entity, 65536);
  if (state.soundFlood?.noise !== noise || state.soundFlood.revision !== state.worldRevision) {
    const sectors = new Map(state.sectors.map(sector => [sector.id, sector]));
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

export function enemyAttackChance(state, entity) {
  let distance = Math.max(0, Math.hypot(state.player.x - entity.x, state.player.y - entity.y) - 64);
  if ([3002, 58].includes(entity.doomType)) return distance < 0.001;
  if (![3001, 3003, 69, 66].includes(entity.doomType)) distance -= 128;
  if ([16, 7, 3006].includes(entity.doomType)) distance /= 2;
  return randomDamage(state, 1, 256) - 1 >= Math.min(200, Math.max(0, distance));
}
export function enemyHitscan(state, entity, action) {
  if (entity.health <= 0 || !canSeePlayer(state, entity, action.range)) return;
  const origin = { x: entity.x, y: entity.y, z: floorAt(state, entity) + 36 };
  const dx = state.player.x - entity.x, dy = state.player.y - entity.y;
  const angle = Math.atan2(dy, dx);
  const pitch = Math.atan2(floorAt(state, state.player) + 28 - origin.z, Math.hypot(dx, dy));
  for (let i = 0; i < (action.pellets ?? 1); i++) {
    const offset = action.spread ? (randomDamage(state, 1, 256) - randomDamage(state, 1, 256)) * action.spread / 256 * Math.PI / 180 : 0;
    const direction = { x: Math.cos(angle + offset) * Math.cos(pitch), y: Math.sin(angle + offset) * Math.cos(pitch), z: Math.sin(pitch) };
    const limit = geometryDistance(state, origin, direction, action.range);
    const damage = randomDamage(state, action.damage, action.diceSides);
    if (entityDistance(state, origin, direction, state.player, limit, 16) !== null) damagePlayer(state, damage);
  }
}
export function moveEnemy(state, entity, speed, dt, target = state.player) {
  if (entity.health <= 0 || speed <= 0 || dt <= 0) return;
  const angle = Math.atan2(target.y - entity.y, target.x - entity.x);
  const distance = Math.hypot(target.x - entity.x, target.y - entity.y);
  const step = Math.min(speed * dt, Math.max(0, distance - 36));
  if (!step) return;
  const origin = { ...entity, z: floorAt(state, entity) + 28 };
  const previous = state.enemyMoves.get(entity.id);
  const toward = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
  const reverse = previous ? (previous.direction + 4) % 8 : -1;
  const candidates = previous?.remaining > 0 ? [previous.direction] : [];
  const preferred = [toward, (toward + 1) % 8, (toward + 7) % 8, (toward + 2) % 8, (toward + 6) % 8,
    (toward + 3) % 8, (toward + 5) % 8, (toward + 4) % 8];
  candidates.push(...preferred.filter(direction => direction !== reverse), reverse);
  for (const index of new Set(candidates.filter(direction => direction >= 0))) {
    const direction = { x: Math.cos(index * Math.PI / 4), y: Math.sin(index * Math.PI / 4) };
    if (geometryDistance(state, origin, direction, step + 16, true) < step + 16) continue;
    const x = entity.x + direction.x * step, y = entity.y + direction.y * step;
    const sector = sectorAt(state.sectors, x, y);
    if (state.sectors.length && (!sector || sector.ceilingHeight - sector.floorHeight < 56 || Math.abs(sector.floorHeight - floorAt(state, entity)) > 24)) continue;
    if (state.entities.some(other => other !== entity && other.type === 'enemy' && other.health > 0 && Math.hypot(other.x - x, other.y - y) < 32)) continue;
    if (state.walls.some(wall => {
      const dx = wall.end.x - wall.start.x, dy = wall.end.y - wall.start.y;
      const t = Math.max(0, Math.min(1, ((x - wall.start.x) * dx + (y - wall.start.y) * dy) / (dx * dx + dy * dy)));
      if (Math.hypot(x - wall.start.x - t * dx, y - wall.start.y - t * dy) >= 16) return false;
      const front = state.sectors.find(sector => sector.id === wall.right?.sectorId), back = state.sectors.find(sector => sector.id === wall.left?.sectorId);
      if (!wall.solid && front && back && Math.min(front.ceilingHeight, back.ceilingHeight) - Math.max(front.floorHeight, back.floorHeight) >= 56 &&
        Math.max(front.floorHeight, back.floorHeight) - floorAt(state, entity) <= 24) return false;
      if (!wall.solid && !front && !back) return false;
      return true;
    })) continue;
    entity.x = x; entity.y = y; entity.angle = index * 45;
    state.enemyMoves.set(entity.id, { direction: index, remaining: previous?.direction === index && previous.remaining > 0
      ? previous.remaining - step : speed * (4 / 35) * randomDamage(state, 1, 16) });
    entity.z = sector?.floorHeight ?? floorAt(state, entity);
    state.physics?.teleport(entity.id, x, y, sector?.floorHeight);
    return;
  }
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
  // `onDamage(entity, amount, source)` lets the actor runtime apply pain and
  // infighting; without it the engine still lowers health.
  const hurt = (entity, amount, source) => {
    if (entity === state.player) { damagePlayer(state, amount); return; }
    if (onDamage) onDamage(entity, amount, source);
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
      const hit = entity => hurt(entity, randomDamage(state, projectile.damage, projectile.diceSides), source);
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
          hurt(entity, amount, source);
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
