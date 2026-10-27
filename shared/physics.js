import { sectorAt, sectorGeometry, sectorShapes } from './sectors.js';
import {
  PLAYER_CYLINDER, SURFACE_REACH, WORLD_UP, dot as dotMap, playerBasis, surfaceKind, upVector,
} from './gravity.js';

export const PHYSICS_SCALE = 64;
export const FIXED_STEP = 1 / 60;
export const pairKey = (a, b) => JSON.stringify([a, b].sort());
// Heights identify a sector's collision geometry, so a change is easy to spot.
const sectorHeights = sector => `${sector.floorHeight}/${sector.ceilingHeight}`;

// This portable snapshot deliberately contains no Rapier handles or WASM memory.
export function validatePhysicsState(snapshot, expectedIds) {
  const fail = message => { throw new Error(`Invalid physics save: ${message}`); };
  const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
  const vector = (value, keys) => object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Number.isFinite(value[key]));
  if (!object(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.bodies)) fail('unsupported snapshot');
  const ids = new Set();
  for (const body of snapshot.bodies) {
    if (!object(body) || typeof body.id !== 'string' || ids.has(body.id) ||
      !vector(body.translation, ['x', 'y', 'z']) || !vector(body.rotation, ['x', 'y', 'z', 'w']) ||
      !vector(body.linvel, ['x', 'y', 'z']) || !vector(body.angvel, ['x', 'y', 'z']) ||
      typeof body.sleeping !== 'boolean') fail('invalid body');
    const length = Math.hypot(...Object.values(body.rotation));
    if (Math.abs(length - 1) > .001) fail('invalid body quaternion');
    ids.add(body.id);
  }
  if (expectedIds && (ids.size !== expectedIds.size || [...ids].some(id => !expectedIds.has(id)))) fail('body IDs do not match level');
  for (const field of ['active', 'contacts', 'started', 'ended']) {
    if (!Array.isArray(snapshot[field]) || new Set(snapshot[field]).size !== snapshot[field].length) fail(`invalid ${field}`);
    for (const key of snapshot[field]) {
      let pair;
      try { pair = JSON.parse(key); } catch { fail(`invalid ${field} pair`); }
      if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1] ||
        !pair.every(id => typeof id === 'string' && (id === '$world' || ids.has(id))) ||
        key !== pairKey(...pair)) fail(`invalid ${field} pair`);
    }
  }
  if (!Array.isArray(snapshot.forces)) fail('invalid forces');
  const forceIds = new Set();
  for (const entry of snapshot.forces) {
    if (!Array.isArray(entry) || entry.length !== 2 || !ids.has(entry[0]) || forceIds.has(entry[0]) ||
      !vector(entry[1], ['x', 'y', 'z'])) fail('invalid force');
    forceIds.add(entry[0]);
  }
  if (!Number.isFinite(snapshot.accumulator) || snapshot.accumulator < -1e-9 || snapshot.accumulator > FIXED_STEP * 8 ||
    !Number.isFinite(snapshot.verticalSpeed) || typeof snapshot.grounded !== 'boolean') fail('invalid stepping state');
  if (snapshot.up !== undefined && (!Array.isArray(snapshot.up) || snapshot.up.length !== 3 ||
    !snapshot.up.every(Number.isFinite) || Math.abs(Math.hypot(...snapshot.up) - 1) > .001)) fail('invalid player up axis');
  return snapshot;
}

export function collisionMesh(project, triangulate, { sectors: liveSectors, moving, dynamic = false } = {}) {
  const positions = [], indices = [];
  function triangle(a, b, c) {
    const index = positions.length / 3;
    for (const point of [a, b, c]) positions.push(...point.map(value => value / PHYSICS_SCALE));
    indices.push(index, index + 1, index + 2, index + 2, index + 1, index);
  }
  const sectors = liveSectors || sectorGeometry(project), sectorMap = new Map(sectors.map(sector => [sector.id, sector]));
  for (const sector of sectors) {
    if (moving && moving.has(sector.id) !== dynamic) continue;
    if (sector.ceilingHeight <= sector.floorHeight) continue;
    for (const shape of sectorShapes(sector.rings)) {
      const points = [...shape.outer, ...shape.holes.flat()];
      for (const face of triangulate(shape.outer, shape.holes)) {
        const [a, b, c] = face.map(index => points[index]);
        triangle([a.x, sector.floorHeight, a.y], [b.x, sector.floorHeight, b.y], [c.x, sector.floorHeight, c.y]);
        if (!sector.sky) triangle([a.x, sector.ceilingHeight, a.y], [b.x, sector.ceilingHeight, b.y], [c.x, sector.ceilingHeight, c.y]);
      }
    }
  }
  if (!sectors.length) {
    triangle([-20000, 0, -20000], [20000, 0, -20000], [20000, 0, 20000]);
    triangle([-20000, 0, -20000], [20000, 0, 20000], [-20000, 0, 20000]);
  }
  const vertices = new Map(project.map.vertices.map(vertex => [vertex.id, vertex]));
  function wall(a, b, bottom, top) {
    if (top <= bottom) return;
    triangle([a.x, bottom, a.y], [b.x, bottom, b.y], [b.x, top, b.y]);
    triangle([a.x, bottom, a.y], [b.x, top, b.y], [a.x, top, a.y]);
  }
  for (const line of project.map.walls) {
    if (moving && (moving.has(line.right?.sectorId) || moving.has(line.left?.sectorId)) !== dynamic) continue;
    const a = vertices.get(line.a), b = vertices.get(line.b);
    const front = sectorMap.get(line.right?.sectorId), back = sectorMap.get(line.left?.sectorId);
    if (!front && !back) { if (line.solid) wall(a, b, 0, line.height); continue; }
    if (!front || !back || line.solid) {
      wall(a, b, Math.min(front?.floorHeight ?? Infinity, back?.floorHeight ?? Infinity),
        Math.max(front?.ceilingHeight ?? -Infinity, back?.ceilingHeight ?? -Infinity));
    } else {
      wall(a, b, Math.min(front.floorHeight, back.floorHeight), Math.max(front.floorHeight, back.floorHeight));
      if (!(front.sky && back.sky)) wall(a, b, Math.min(front.ceilingHeight, back.ceilingHeight), Math.max(front.ceilingHeight, back.ceilingHeight));
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), sectors };
}

// Doom lets a thing into a gap that exactly matches its height (`P_CheckPosition` only
// refuses a gap smaller than the height), so the capsule is a hair under the 56 unit
// player height: the MAP01 exit sign sits in a 56 unit niche in front of the door, and a
// full-height capsule plus the character controller's query offset could not enter it.
const PLAYER_CAPSULE_HEIGHT = 55;

export function createPhysics(project, state, R, triangulate) {
  const initialUnbodiedHeights = new Map(state.entities.filter(entity => entity.type !== 'player' &&
    (!entity.physics || entity.physics.body === 'none') && Number.isFinite(entity.z)).map(entity => [entity.id, entity.z]));
  const world = new R.World({ x: 0, y: -9.81, z: 0 }), events = new R.EventQueue(true);
  world.timestep = FIXED_STEP;
  // Sectors whose heights can change end up in the dynamic collider, because a
  // trimesh cannot be edited in place: the static one is rebuilt without them once,
  // and their current geometry is rebuilt as they move. Events, line specials and
  // ACS all move sectors through the same live sector list, so the set is discovered
  // from the heights themselves instead of from one of those three sources.
  const spawnHeights = new Map(state.sectors.map(sector => [sector.id, sectorHeights(sector)]));
  const movableSectors = new Set(), moving = movableSectors;
  const mesh = collisionMesh(project, triangulate, { sectors: state.sectors, moving });
  let worldCollider = createWorldCollider(mesh);
  const colliderIds = new Map(worldCollider ? [[worldCollider.handle, '$world']] : []), bodies = new Map(), colliders = new Map();
  let dynamicCollider = null, worldRevision = -1;
  function createWorldCollider(built) {
    if (!built.indices.length) return null;
    return world.createCollider(R.ColliderDesc.trimesh(built.positions, built.indices).setFriction(.7)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(R.ActiveCollisionTypes.ALL));
  }
  function replaceCollider(current, built) {
    if (current) { colliderIds.delete(current.handle); world.removeCollider(current, true); }
    const next = createWorldCollider(built);
    if (next) colliderIds.set(next.handle, '$world');
    return next;
  }
  function syncWorld() {
    if (worldRevision === state.worldRevision) return;
    worldRevision = state.worldRevision;
    // A sector that left its spawn height joins the movable set. That is the only
    // time the static mesh has to be rebuilt, so a door opening costs one full
    // rebuild and every following frame only re-triangulates the moving sectors.
    let added = false;
    for (const sector of state.sectors) {
      if (movableSectors.has(sector.id) || spawnHeights.get(sector.id) === sectorHeights(sector)) continue;
      movableSectors.add(sector.id); added = true;
    }
    if (!movableSectors.size) return;
    if (added) {
      worldCollider = replaceCollider(worldCollider,
        collisionMesh(project, triangulate, { sectors: state.sectors, moving: movableSectors }));
    }
    dynamicCollider = replaceCollider(dynamicCollider,
      collisionMesh(project, triangulate, { sectors: state.sectors, moving: movableSectors, dynamic: true }));
    return added;
  }
  const active = new Set(), forces = new Map();
  let contacts = new Set(), started = new Set(), ended = new Set(), accumulator = 0, verticalSpeed = 0, grounded = false;
  // The player's own up axis. Rapier capsules always grow along +Y, so walking on
  // a wall means rotating the character and moving along its plane, not the world's.
  let upMap = [...WORLD_UP];
  // Map space is x/y with z up in map units; Rapier is metres with y up.
  const toRapier = v => ({ x: v[0], y: v[2], z: v[1] });
  const toRapierPoint = v => ({ x: v[0] / PHYSICS_SCALE, y: v[2] / PHYSICS_SCALE, z: v[1] / PHYSICS_SCALE });
  const toMap = v => [v.x, v.z, v.y];
  const contactRay = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  function floorAt(entity) { return sectorAt(mesh.sectors, entity.x, entity.y)?.floorHeight || 0; }
  // Shortest-arc rotation from the capsule's +Y axis to `axis` (Rapier space).
  function capsuleRotation(axis) {
    if (axis.y > .999999) return { x: 0, y: 0, z: 0, w: 1 };
    if (axis.y < -.999999) return { x: 1, y: 0, z: 0, w: 0 };
    const x = axis.z, z = -axis.x, w = 1 + axis.y, length = Math.hypot(x, z, w);
    return { x: x / length, y: 0, z: z / length, w: w / length };
  }
  // How far a capsule whose axis is `axis` reaches from its centre along `direction`
  // (both Rapier space), in map units: the rounded cap plus the cylinder projection.
  function capsuleExtent(axis, direction) {
    return Math.abs(axis.x * direction.x + axis.y * direction.y + axis.z * direction.z) *
      (PLAYER_CYLINDER.halfHeight - PLAYER_CYLINDER.radius) + PLAYER_CYLINDER.radius;
  }
  // `direction` is in map space; the returned distance is the clearance between the
  // capsule surface and the hit, so "touching" means a small number rather than a
  // per-direction threshold.
  function castSurface(origin, direction, distance) {
    const playerCollider = colliders.get(playerId), rayDirection = toRapier(direction);
    contactRay.origin = toRapierPoint(origin);
    contactRay.dir = rayDirection;
    const hit = world.castRayAndGetNormal(contactRay, distance / PHYSICS_SCALE, true,
      R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, playerCollider);
    if (!hit) return null;
    const normal = toMap(hit.normal);
    return { normal, distance: hit.timeOfImpact * PHYSICS_SCALE - capsuleExtent(toRapier(upMap), rayDirection),
      kind: surfaceKind(normal) };
  }
  function rotation(entity) {
    const angle = -(entity.angle || 0) * Math.PI / 180;
    return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
  }
  for (const entity of state.entities) {
    const player = entity.type === 'player', config = entity.physics;
    if (!player && (!config || config.body === 'none')) continue;
    const height = player ? 56 : config.height, radius = player ? 12 : config.radius;
    const bodyType = player ? 'kinematic' : config.body;
    const descriptor = bodyType === 'dynamic' ? R.RigidBodyDesc.dynamic() : bodyType === 'fixed' ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.kinematicPositionBased();
    const bottom = floorAt(entity) + (entity.elevation || 0);
    descriptor.setTranslation(entity.x / PHYSICS_SCALE, (bottom + height / 2 + (player ? .4 : 0)) / PHYSICS_SCALE, entity.y / PHYSICS_SCALE);
    descriptor.setRotation(rotation(entity));
    // The player capsule is re-oriented onto the surface it stands on, so its
    // rotation follows the up axis instead of being locked upright.
    if (!player && config.lockRotation) descriptor.lockRotations();
    if (bodyType === 'dynamic') descriptor.setCcdEnabled(true);
    const body = world.createRigidBody(descriptor);
    const shape = player || config.shape === 'capsule'
      ? R.ColliderDesc.capsule(Math.max(0, (player ? PLAYER_CAPSULE_HEIGHT : height) / 2 - radius) / PHYSICS_SCALE, radius / PHYSICS_SCALE)
      : config.shape === 'ball' ? R.ColliderDesc.ball(radius / PHYSICS_SCALE)
        : R.ColliderDesc.cuboid(config.width / 2 / PHYSICS_SCALE, height / 2 / PHYSICS_SCALE, config.depth / 2 / PHYSICS_SCALE);
    shape.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);
    if (!player) {
      shape.setSensor(config.sensor).setFriction(config.friction).setRestitution(config.restitution);
      if (bodyType === 'dynamic') shape.setMass(config.mass);
    }
    const collider = world.createCollider(shape, body);
    colliderIds.set(collider.handle, entity.id); bodies.set(entity.id, body); colliders.set(entity.id, collider);
    entity.z = bottom;
  }
  const spawn = state.entities.find(entity => entity.type === 'player'), playerId = spawn.id;
  const controller = world.createCharacterController(.005);
  controller.enableAutostep(24 / PHYSICS_SCALE, 12 / PHYSICS_SCALE, true);
  controller.enableSnapToGround(4 / PHYSICS_SCALE);
  controller.setApplyImpulsesToDynamicBodies(true);
  controller.setCharacterMass(80);
  controller.setMaxSlopeClimbAngle(Math.PI / 4);
  controller.setMinSlopeSlideAngle(Math.PI / 4);
  // Populate the broad phase before the first character query.
  world.step(events);
  events.clear();
  function sync() {
    for (const entity of state.entities) {
      const body = bodies.get(entity.id);
      if (!body) { entity.z = floorAt(entity) + (entity.elevation || 0); continue; }
      const position = body.translation(), q = body.rotation();
      const height = entity.type === 'player' ? 56 : entity.physics.height;
      entity.x = position.x * PHYSICS_SCALE; entity.y = position.z * PHYSICS_SCALE;
      // Feet are half a capsule below the centre along the player's own up axis, so
      // a player lying on a wall reports the height their body actually occupies.
      entity.z = position.y * PHYSICS_SCALE - (entity.type === 'player'
        ? PLAYER_CYLINDER.halfHeight * upMap[2] : height / 2);
      entity.rotation = { x: q.x, y: q.y, z: q.z, w: q.w };
      if (entity.type === 'player') {
        state.player.x = entity.x; state.player.y = entity.y; state.player.z = entity.z;
      }
    }
  }
  sync();
  /**
   * Rotate the player capsule onto a new up axis and slide it so the point it was
   * resting on stays put: a capsule rotated in place would end 16 units inside the
   * wall it just stepped onto.
   */
  function orientPlayer(up, clearance = 0) {
    const next = upVector(up), body = bodies.get(playerId), collider = colliders.get(playerId);
    if (!body) { upMap = next; return false; }
    const axis = toRapier(next), previous = toRapier(upMap);
    // Reach of the *old* capsule along the *new* axis: a horizontal capsule only
    // reaches its radius towards a wall it is about to stand on. `clearance` is the
    // measured gap to that surface, so the feet land exactly on it.
    const extent = capsuleExtent(previous, axis) + clearance, position = body.translation();
    const shift = (PLAYER_CYLINDER.halfHeight - extent) / PHYSICS_SCALE;
    const target = { x: position.x + axis.x * shift, y: position.y + axis.y * shift, z: position.z + axis.z * shift };
    const quaternion = capsuleRotation(axis);
    body.setTranslation(target, true); body.setRotation(quaternion, true);
    body.setNextKinematicTranslation(target); body.setNextKinematicRotation(quaternion);
    world.propagateModifiedBodyPositionsToColliders();
    upMap = next; verticalSpeed = 0;
    sync();
    return true;
  }
  // Sample points around the capsule: centre, then 8 units out along both axes. One
  // ray misses ledges and corners, and a wall spike between two rays is inaudible.
  function contactOrigins(centre, basis) {
    const origins = [];
    for (const offset of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]]) {
      origins.push([centre[0] + basis.forward[0] * offset[0] + basis.right[0] * offset[1],
        centre[1] + basis.forward[1] * offset[0] + basis.right[1] * offset[1],
        centre[2] + basis.forward[2] * offset[0] + basis.right[2] * offset[1]]);
    }
    return origins;
  }
  const GROUND_SNAP = 4;
  /** True while a surface is under the capsule, measured along the player's up axis. */
  function standingOnSurface() {
    const body = bodies.get(playerId);
    if (!body) return false;
    const axis = upVector(upMap), position = body.translation();
    const centre = [position.x * PHYSICS_SCALE, position.z * PHYSICS_SCALE, position.y * PHYSICS_SCALE];
    const basis = playerBasis(axis);
    for (const origin of contactOrigins(centre, basis)) {
      const hit = castSurface(origin, [-axis[0], -axis[1], -axis[2]], PLAYER_CYLINDER.halfHeight + GROUND_SNAP);
      if (hit && hit.distance <= GROUND_SNAP && dotMap(hit.normal, axis) > .7071) return true;
    }
    return false;
  }
  /** Surfaces the capsule is touching or nearly touching, nearest contact first. */
  function probeSurfaces(up = upMap, reach = SURFACE_REACH) {
    const axis = upVector(up), body = bodies.get(playerId);
    if (!body || !colliders.get(playerId)) return [];
    const basis = playerBasis(axis), position = body.translation();
    const centre = [position.x * PHYSICS_SCALE, position.z * PHYSICS_SCALE, position.y * PHYSICS_SCALE];
    const found = [], seen = new Set();
    const record = hit => {
      if (!hit || hit.distance > reach) return;
      const key = `${hit.kind}|${hit.normal.map(value => value.toFixed(3)).join(',')}`;
      if (seen.has(key)) return;
      seen.add(key); found.push(hit);
    };
    // Feet, head and eight sides: a capsule can touch a wall, a floor and a ceiling
    // at once in a corner, and each classified contact drives a different rule.
    for (const origin of contactOrigins(centre, basis))
      record(castSurface(origin, [-axis[0], -axis[1], -axis[2]], PLAYER_CYLINDER.halfHeight + reach));
    record(castSurface(centre, axis, PLAYER_CYLINDER.halfHeight + reach));
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1], [.7071, .7071], [-.7071, .7071], [.7071, -.7071], [-.7071, -.7071]];
    for (const [forward, right] of sides) {
      const direction = [
        basis.forward[0] * forward + basis.right[0] * right,
        basis.forward[1] * forward + basis.right[1] * right,
        basis.forward[2] * forward + basis.right[2] * right,
      ];
      const length = Math.hypot(...direction) || 1;
      record(castSurface(centre, [direction[0] / length, direction[1] / length, direction[2] / length],
        PLAYER_CYLINDER.radius + reach));
    }
    return found.sort((a, b) => a.distance - b.distance);
  }
  const api = {
    world, bodies,
    syncWorld,
    get contacts() { return contacts; }, get started() { return started; }, get ended() { return ended; }, get grounded() { return grounded; },
    get up() { return [...upMap]; },
    orientPlayer, probeSurfaces,
    saveState() {
      const vector = value => ({ x: value.x || 0, y: value.y || 0, z: value.z || 0 });
      return {
        version: 1,
        bodies: [...bodies].map(([id, body]) => ({
          id, translation: vector(body.translation()), rotation: { ...vector(body.rotation()), w: body.rotation().w },
          linvel: vector(body.linvel()), angvel: vector(body.angvel()), sleeping: body.isSleeping(),
        })),
        active: [...active], contacts: [...contacts], started: [...started], ended: [...ended],
        forces: [...forces].map(([id, force]) => [id, { ...force }]), accumulator, verticalSpeed, grounded,
        up: [...upMap],
      };
    },
    restoreState(snapshot) {
      validatePhysicsState(snapshot, new Set(bodies.keys()));
      syncWorld();
      for (const saved of snapshot.bodies) {
        const body = bodies.get(saved.id);
        body.setTranslation(saved.translation, false); body.setRotation(saved.rotation, false);
        if (body.isKinematic()) {
          body.setNextKinematicTranslation(saved.translation); body.setNextKinematicRotation(saved.rotation);
          // Rapier ignores velocity setters for position-based kinematics.
          body.setBodyType(R.RigidBodyType.KinematicVelocityBased, false);
          body.setLinvel(saved.linvel, false); body.setAngvel(saved.angvel, false);
          body.setBodyType(R.RigidBodyType.KinematicPositionBased, false);
        } else {
          body.setLinvel(saved.linvel, false); body.setAngvel(saved.angvel, false);
        }
        if (saved.sleeping) body.sleep(); else body.wakeUp();
      }
      active.clear(); for (const key of snapshot.active) active.add(key);
      contacts = new Set(snapshot.contacts); started = new Set(snapshot.started); ended = new Set(snapshot.ended);
      forces.clear(); for (const [id, force] of snapshot.forces) forces.set(id, { ...force });
      ({ accumulator, verticalSpeed, grounded } = snapshot);
      upMap = upVector(snapshot.up);
      events.clear();
      world.propagateModifiedBodyPositionsToColliders();
      sync();
      for (const entity of state.entities) if (!bodies.has(entity.id) && initialUnbodiedHeights.has(entity.id))
        entity.z = initialUnbodiedHeights.get(entity.id);
    },
    step(dt, movement) {
      started = new Set(); ended = new Set();
      if (movement.up && dotMap(upVector(movement.up), upMap) < .999999) orientPlayer(movement.up);
      const axis = toRapier(upMap);
      // Movement arrives in map space; gravity and the move both follow the up axis.
      const velocity = toRapier([movement.x || 0, movement.y || 0, movement.z || 0]);
      accumulator = Math.min(accumulator + dt, FIXED_STEP * 8);
      if (movement.jump && grounded) { verticalSpeed = 5; grounded = false; }
      while (accumulator + 1e-9 >= FIXED_STEP) {
        for (const [id, body] of bodies) if (body.isDynamic()) {
          body.resetForces(true);
          const force = forces.get(id);
          if (force) body.addForce({ x: force.x, y: force.z, z: force.y }, true);
        }
        forces.clear();
        const body = bodies.get(playerId), collider = colliders.get(playerId);
        verticalSpeed = grounded ? -.5 : Math.max(-50, verticalSpeed - 9.81 * FIXED_STEP);
        const fall = verticalSpeed * FIXED_STEP;
        controller.computeColliderMovement(collider, {
          x: velocity.x / PHYSICS_SCALE * FIXED_STEP + axis.x * fall,
          y: velocity.y / PHYSICS_SCALE * FIXED_STEP + axis.y * fall,
          z: velocity.z / PHYSICS_SCALE * FIXED_STEP + axis.z * fall,
        }, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, candidate => candidate.parent()?.handle !== body.handle);
        const corrected = controller.computedMovement(), position = body.translation();
        body.setNextKinematicTranslation({ x: position.x + corrected.x, y: position.y + corrected.y, z: position.z + corrected.z });
        world.step(events);
        // Rapier's own grounded test follows world +Y, so it only answers for an
        // upright player; on a wall the contact rays decide instead.
        grounded = axis.y > .999 ? controller.computedGrounded() || standingOnSurface() : standingOnSurface();
        const characterContacts = new Set();
        for (let i = 0; i < controller.numComputedCollisions(); i++) {
          const collision = controller.computedCollision(i);
          const other = colliderIds.get(collision.collider.handle);
          if (other) characterContacts.add(pairKey(playerId, other));
        }
        events.drainCollisionEvents((a, b, begin) => {
          const left = colliderIds.get(a), right = colliderIds.get(b);
          if (!left || !right || left === right) return;
          const key = pairKey(left, right);
          if (begin) active.add(key); else active.delete(key);
        });
        const next = new Set([...active, ...characterContacts]);
        for (const key of next) if (!contacts.has(key)) started.add(key);
        for (const key of contacts) if (!next.has(key)) ended.add(key);
        contacts = next;
        accumulator -= FIXED_STEP;
      }
      sync();
    },
    teleport(id, x, y, z) {
      const entity = state.entities.find(entity => entity.id === id);
      const body = bodies.get(id);
      if (!entity) return;
      const bottom = z ?? floorAt({ x, y }) + (entity.elevation || 0);
      if (!body) { entity.x = x; entity.y = y; entity.z = bottom; entity.elevation = bottom - floorAt(entity); return; }
      const height = entity.type === 'player' ? 56 : entity.physics.height;
      const position = entity.type === 'player'
        ? { x: x / PHYSICS_SCALE, y: (bottom + PLAYER_CYLINDER.halfHeight * upMap[2] + .4) / PHYSICS_SCALE, z: y / PHYSICS_SCALE }
        : { x: x / PHYSICS_SCALE, y: (bottom + height / 2 + .4) / PHYSICS_SCALE, z: y / PHYSICS_SCALE };
      body.setTranslation(position, true);
      if (body.isKinematic()) body.setNextKinematicTranslation(position);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      world.propagateModifiedBodyPositionsToColliders();
      if (id === playerId) verticalSpeed = 0;
      sync();
    },
    rotate(id, angle) {
      const entity = state.entities.find(entity => entity.id === id), body = bodies.get(id);
      if (!entity || !body || id === playerId) return;
      body.setRotation(rotation({ angle }), true); world.propagateModifiedBodyPositionsToColliders(); sync();
      if (body.isKinematic()) body.setNextKinematicRotation(rotation({ angle }));
    },
    impulse(id, vector) {
      const body = bodies.get(id);
      if (body?.isDynamic()) body.applyImpulse({ x: vector.x, y: vector.z, z: vector.y }, true);
    },
    velocity(id, vector) {
      const body = bodies.get(id);
      if (body?.isDynamic()) body.setLinvel({ x: vector.x, y: vector.z, z: vector.y }, true);
    },
    gravityScale(id, scale) {
      const body = bodies.get(id);
      if (body) body.setGravityScale(scale, true);
    },
    damping(id, value) {
      const body = bodies.get(id);
      if (!body) return;
      body.setLinearDamping(value);
      body.setAngularDamping(value);
    },
    force(id, vector) {
      if (!bodies.get(id)?.isDynamic()) return;
      const previous = forces.get(id) || { x: 0, y: 0, z: 0 };
      forces.set(id, { x: previous.x + vector.x, y: previous.y + vector.y, z: previous.z + vector.z });
    },
    remove(id) {
      const body = bodies.get(id), collider = colliders.get(id);
      if (!body) return;
      colliderIds.delete(collider.handle); world.removeRigidBody(body); bodies.delete(id); colliders.delete(id);
      forces.delete(id);
      for (const key of active) if (JSON.parse(key).includes(id)) active.delete(key);
      for (const set of [contacts, started, ended]) for (const key of set) if (JSON.parse(key).includes(id)) set.delete(key);
    },
    dispose() { world.removeCharacterController(controller); events.free(); world.free(); },
  };
  return api;
}
