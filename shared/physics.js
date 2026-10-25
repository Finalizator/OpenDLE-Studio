import { sectorAt, sectorGeometry, sectorShapes } from './sectors.js';

export const PHYSICS_SCALE = 64;
export const FIXED_STEP = 1 / 60;
export const pairKey = (a, b) => JSON.stringify([a, b].sort());

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

export function createPhysics(project, state, R, triangulate) {
  const initialUnbodiedHeights = new Map(state.entities.filter(entity => entity.type !== 'player' &&
    (!entity.physics || entity.physics.body === 'none') && Number.isFinite(entity.z)).map(entity => [entity.id, entity.z]));
  const world = new R.World({ x: 0, y: -9.81, z: 0 }), events = new R.EventQueue(true);
  world.timestep = FIXED_STEP;
  const moving = new Set(project.events.flatMap(event => event.actions.filter(action => action.type === 'moveSector').map(action => action.sectorId)));
  const mesh = collisionMesh(project, triangulate, { sectors: state.sectors, moving });
  const worldCollider = mesh.indices.length ? world.createCollider(R.ColliderDesc.trimesh(mesh.positions, mesh.indices).setFriction(.7)
    .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(R.ActiveCollisionTypes.ALL)) : null;
  const colliderIds = new Map(worldCollider ? [[worldCollider.handle, '$world']] : []), bodies = new Map(), colliders = new Map();
  let dynamicCollider = null, worldRevision = -1;
  function syncWorld() {
    if (!moving.size || worldRevision === state.worldRevision) return;
    const updated = collisionMesh(project, triangulate, { sectors: state.sectors, moving, dynamic: true });
    if (dynamicCollider) { colliderIds.delete(dynamicCollider.handle); world.removeCollider(dynamicCollider, true); }
    dynamicCollider = updated.indices.length ? world.createCollider(R.ColliderDesc.trimesh(updated.positions, updated.indices).setFriction(.7)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(R.ActiveCollisionTypes.ALL)) : null;
    if (dynamicCollider) colliderIds.set(dynamicCollider.handle, '$world');
    worldRevision = state.worldRevision;
  }
  syncWorld();
  const active = new Set(), forces = new Map();
  let contacts = new Set(), started = new Set(), ended = new Set(), accumulator = 0, verticalSpeed = 0, grounded = false;
  function floorAt(entity) { return sectorAt(mesh.sectors, entity.x, entity.y)?.floorHeight || 0; }
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
    if (player) descriptor.lockRotations();
    if (!player && config.lockRotation) descriptor.lockRotations();
    if (bodyType === 'dynamic') descriptor.setCcdEnabled(true);
    const body = world.createRigidBody(descriptor);
    const shape = player || config.shape === 'capsule'
      ? R.ColliderDesc.capsule(Math.max(0, height / 2 - radius) / PHYSICS_SCALE, radius / PHYSICS_SCALE)
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
      entity.z = position.y * PHYSICS_SCALE - height / 2;
      entity.rotation = { x: q.x, y: q.y, z: q.z, w: q.w };
      if (entity.type === 'player') {
        state.player.x = entity.x; state.player.y = entity.y; state.player.z = entity.z;
      }
    }
  }
  sync();
  const api = {
    world, bodies,
    syncWorld,
    get contacts() { return contacts; }, get started() { return started; }, get ended() { return ended; }, get grounded() { return grounded; },
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
      events.clear();
      world.propagateModifiedBodyPositionsToColliders();
      sync();
      for (const entity of state.entities) if (!bodies.has(entity.id) && initialUnbodiedHeights.has(entity.id))
        entity.z = initialUnbodiedHeights.get(entity.id);
    },
    step(dt, movement) {
      started = new Set(); ended = new Set();
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
        controller.computeColliderMovement(collider, {
          x: movement.x / PHYSICS_SCALE * FIXED_STEP, y: verticalSpeed * FIXED_STEP, z: movement.y / PHYSICS_SCALE * FIXED_STEP,
        }, R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, candidate => candidate.parent()?.handle !== body.handle);
        const corrected = controller.computedMovement(), position = body.translation();
        body.setNextKinematicTranslation({ x: position.x + corrected.x, y: position.y + corrected.y, z: position.z + corrected.z });
        grounded = controller.computedGrounded();
        const characterContacts = new Set();
        for (let i = 0; i < controller.numComputedCollisions(); i++) {
          const collision = controller.computedCollision(i);
          const other = colliderIds.get(collision.collider.handle);
          if (other) characterContacts.add(pairKey(playerId, other));
        }
        world.step(events);
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
      const position = { x: x / PHYSICS_SCALE, y: (bottom + height / 2 + .4) / PHYSICS_SCALE, z: y / PHYSICS_SCALE };
      body.setTranslation(position, true);
      if (body.isKinematic()) body.setNextKinematicTranslation(position);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      world.propagateModifiedBodyPositionsToColliders();
      if (id === playerId) verticalSpeed = 0;
      sync();
    },
    rotate(id, angle) {
      const entity = state.entities.find(entity => entity.id === id), body = bodies.get(id);
      if (!entity || !body) return;
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
