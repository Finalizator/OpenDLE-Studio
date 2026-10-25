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
export function floorAt(state, position) {
  return position.z ?? (sectorAt(state.sectors, position.x, position.y)?.floorHeight ?? 0) + (position.elevation || 0);
}
export function playerReachesEntity(state, entity, distance, height, below) {
  const dx = entity.x - state.player.x, dy = entity.y - state.player.y;
  const playerFloor = floorAt(state, state.player), itemFloor = floorAt(state, entity);
  if (Math.abs(dx) >= distance || Math.abs(dy) >= distance || itemFloor - playerFloor > height || itemFloor - playerFloor < -below) return false;
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
export function canSeePlayer(state, entity, range, fov = 360) {
  const origin = { x: entity.x, y: entity.y, z: floorAt(state, entity) + 36 };
  const dx = state.player.x - origin.x, dy = state.player.y - origin.y, dz = floorAt(state, state.player) + 36 - origin.z;
  const distance = Math.hypot(dx, dy, dz);
  const facing = (entity.angle || 0) * Math.PI / 180;
  const delta = Math.atan2(Math.sin(Math.atan2(dy, dx) - facing), Math.cos(Math.atan2(dy, dx) - facing));
  if (Math.hypot(dx, dy) > 64 && Math.abs(delta) > fov * Math.PI / 360) return false;
  return distance <= range && geometryDistance(state, origin, { x: dx / (distance || 1), y: dy / (distance || 1), z: dz / (distance || 1) }, distance + .01) >= distance;
}
export function canHearPlayer(state, entity) {
  const noise = state.playerNoise;
  if (!noise || noise.time !== state.time) return false;
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
export function moveEnemy(state, entity, speed, dt) {
  if (entity.health <= 0 || speed <= 0 || dt <= 0) return;
  const angle = Math.atan2(state.player.y - entity.y, state.player.x - entity.x);
  const distance = Math.hypot(state.player.x - entity.x, state.player.y - entity.y);
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
  const origin = owner || state.player, z = floorAt(state, origin) + (owner ? 32 : 40);
  const angle = owner ? Math.atan2(state.player.y - owner.y, state.player.x - owner.x) : state.player.angle;
  const pitch = owner ? Math.atan2(floorAt(state, state.player) + 32 - z, Math.hypot(state.player.x - owner.x, state.player.y - owner.y)) : state.player.pitch;
  state.projectiles.push({ id: ++state.projectileSequence, ownerId: owner?.id || '$player', x: origin.x, y: origin.y, z,
    dx: Math.cos(angle) * Math.cos(pitch), dy: Math.sin(angle) * Math.cos(pitch), dz: Math.sin(pitch),
    age: 0, ...action });
  state.lastShot = owner ? state.lastShot : { time: state.time, hits: [] };
  if (!owner) state.playerNoise = { time: state.time, x: origin.x, y: origin.y };
}
export function advanceProjectiles(state, dt) {
  const survivors = [];
  for (const projectile of state.projectiles) {
    const travel = projectile.speed * dt;
    let nearest = geometryDistance(state, projectile, { x: projectile.dx, y: projectile.dy, z: projectile.dz }, travel);
    let target = null;
    const targets = projectile.ownerId === '$player'
      ? state.entities.filter(entity => entity.type === 'enemy' && entity.health > 0)
      : state.playerStats.health > 0 ? [state.player] : [];
    for (const entity of targets) {
      const distance = entityDistance(state, projectile, { x: projectile.dx, y: projectile.dy, z: projectile.dz }, entity, nearest);
      if (distance !== null) { nearest = distance; target = entity; }
    }
    projectile.x += projectile.dx * nearest; projectile.y += projectile.dy * nearest; projectile.z += projectile.dz * nearest; projectile.age += dt;
    if (target || nearest < travel) {
      const hit = entity => {
        const damage = randomDamage(state, projectile.damage, projectile.diceSides);
        if (entity === state.player) damagePlayer(state, damage);
        else entity.health = Math.max(0, (entity.health ?? 20) - damage);
      };
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
          if (entity === state.player) damagePlayer(state, amount, 'self');
          else entity.health = Math.max(0, entity.health - amount);
        }
      }
      if (projectile.sound) soundEvent(state, projectile.sound, .7, projectile);
      if (projectile.impactClipId) {
        if (state.impacts.length >= 256) state.impacts.shift();
        state.impacts.push({ id: `impact_${projectile.id}`, x: projectile.x, y: projectile.y, z: projectile.z, clipId: projectile.impactClipId, start: state.time });
      }
    } else if (projectile.age < 8) survivors.push(projectile);
  }
  state.projectiles = survivors;
}
