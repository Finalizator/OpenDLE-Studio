import { mediaNodeKind, isNonvisualMediaNode } from '../shared/media-nodes.js';
import { modelOrientation as sharedModelOrientation } from '../shared/entity-visuals.js';
import { emitSignal } from '../shared/signals.js';

export function runtimeQuaternionToMapZUp([x, y, z, w]) {
  return [-x, -z, -y, w];
}

function planeGeometry(THREE, width, height, upAxis = 'y') {
  const geometry = new THREE.PlaneGeometry(width, height);
  if (upAxis === 'z') geometry.rotateX(Math.PI / 2);
  return geometry;
}

function makeMaterial(THREE, config, materialFactory) {
  return materialFactory
    ? materialFactory(config)
    : new THREE.MeshBasicMaterial(config);
}

function centeredPrimitiveGeometry(THREE, mesh, upAxis = 'y') {
  const { shape, width, height, depth } = mesh;
  const isZUp = upAxis === 'z';
  let geometry;
  if (shape === 'box') geometry = isZUp
    ? new THREE.BoxGeometry(width, depth, height)
    : new THREE.BoxGeometry(width, height, depth);
  else if (shape === 'sphere') {
    geometry = new THREE.SphereGeometry(.5, 24, 16);
    geometry.scale(width, isZUp ? depth : height, isZUp ? height : depth);
  } else if (shape === 'cylinder' || shape === 'cone') {
    geometry = shape === 'cone'
      ? new THREE.ConeGeometry(.5, 1, 24)
      : new THREE.CylinderGeometry(.5, .5, 1, 24);
    geometry.scale(width, height, depth);
    if (isZUp) geometry.rotateX(Math.PI / 2);
  } else if (shape === 'capsule' && THREE.CapsuleGeometry) {
    geometry = new THREE.CapsuleGeometry(.5, .5, 4, 12);
    geometry.scale(width, height / 2, depth);
    if (isZUp) geometry.rotateX(Math.PI / 2);
  } else {
    geometry = new THREE.PlaneGeometry(width, depth);
    if (!isZUp) geometry.rotateX(-Math.PI / 2);
  }
  return geometry;
}

function addSurface(THREE, geometry, { texture = null, color = '#ffffff', opacity = 1, doubleSided = true } = {}, materialFactory) {
  const material = makeMaterial(THREE, {
    map: texture,
    color: texture ? '#ffffff' : color,
    transparent: Boolean(texture) || opacity < 1,
    opacity,
    depthWrite: !texture && opacity >= 1,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  }, materialFactory);
  return { object: new THREE.Mesh(geometry, material), geometry, material };
}

/**
 * Draws a terminal's complete, local UI into a CanvasTexture. It contains no executable
 * content: keypad buttons only edit the input or assign the configured variable.
 */
export function createTerminalCanvas(document, terminal, THREE = null, entity = null) {
  const canvas = document.createElement('canvas');
  canvas.width = terminal.resolutionWidth;
  canvas.height = terminal.resolutionHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable for terminal surfaces');
  let input = terminal.inputVariable ? entity?.variables?.[terminal.inputVariable] ?? '' : '';
  let message = 'Enter access code', unlocked = false, pointer = null;
  const controls = [];
  const padding = Math.max(12, Math.round(canvas.width * .035));
  const header = Math.max(38, Math.round(canvas.height * .14));
  const button = (label, action, x, y, width, height) => {
    controls.push({ label, action, x, y, width, height });
    context.fillStyle = unlocked ? '#16352c' : '#17303a';
    context.fillRect(x, y, width, height);
    context.strokeStyle = terminal.foreground;
    context.lineWidth = Math.max(1, canvas.width / 512);
    context.strokeRect(x, y, width, height);
    context.fillStyle = terminal.foreground;
    context.font = `600 ${Math.max(12, Math.round(canvas.width * .035))}px monospace`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, x + width / 2, y + height / 2, width - 8);
  };
  const draw = () => {
    controls.length = 0;
    context.fillStyle = terminal.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = terminal.foreground;
    context.lineWidth = Math.max(2, canvas.width / 128);
    context.strokeRect(padding / 2, padding / 2, canvas.width - padding, canvas.height - padding);
    context.fillStyle = '#14252c';
    context.fillRect(padding, padding, canvas.width - padding * 2, header);
    context.fillStyle = terminal.foreground;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.font = `600 ${Math.max(16, Math.round(canvas.width * .045))}px monospace`;
    context.fillText(terminal.title, padding * 1.6, padding + header / 2, canvas.width - padding * 3);
    const displayY = padding + header + Math.max(10, padding * .7);
    const displayHeight = Math.max(30, Math.round(canvas.height * .14));
    context.fillStyle = '#03090d';
    context.fillRect(padding * 1.5, displayY, canvas.width - padding * 3, displayHeight);
    context.fillStyle = terminal.foreground;
    context.font = `600 ${Math.max(16, Math.round(canvas.width * .04))}px monospace`;
    const prompt = terminal.mode === 'terminal'
      ? `> login ${'*'.repeat(input.length) || '_'}`
      : `${message}: ${'*'.repeat(input.length)}`;
    context.fillText(unlocked ? message : prompt, padding * 2, displayY + displayHeight / 2,
      canvas.width - padding * 4);
    const actionTop = displayY + displayHeight + padding;
    if (unlocked && terminal.buttons?.length) {
      const gap = padding / 2, columns = Math.min(3, terminal.buttons.length);
      const rows = Math.ceil(terminal.buttons.length / columns);
      const width = (canvas.width - padding * 3 - gap * (columns - 1)) / columns;
      const height = Math.max(24, (canvas.height - padding - actionTop - gap * (rows - 1)) / rows);
      terminal.buttons.forEach((entry, index) => {
        const row = Math.floor(index / columns), column = index % columns;
        button(entry.label, { type: 'assign', value: entry.value },
          padding * 1.5 + column * (width + gap), actionTop + row * (height + gap), width, height);
      });
    } else if (!unlocked) {
      const keyTop = canvas.height - padding - Math.round(canvas.height * .34);
      const gap = padding / 2;
      const width = (canvas.width - padding * 3 - gap * 2) / 3;
      const height = Math.max(24, Math.round(canvas.height * .075));
      const submitLabel = terminal.mode === 'terminal' ? 'Run' : 'Enter';
      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Clear', '0', submitLabel];
      keys.forEach((label, index) => {
        const row = Math.floor(index / 3), column = index % 3;
        const action = label === 'Clear' ? { type: 'clear' } : label === submitLabel ? { type: 'enter' } :
          { type: 'digit', value: label };
        button(label, action, padding * 1.5 + column * (width + gap), keyTop + row * (height + gap), width, height);
      });
    }
    if (pointer) {
      const x = pointer.u * canvas.width, y = (1 - pointer.v) * canvas.height;
      const size = Math.max(8, canvas.width / 40);
      context.beginPath();
      context.moveTo(x, y); context.lineTo(x, y + size);
      context.lineTo(x + size * .3, y + size * .7);
      context.lineTo(x + size * .7, y + size * .7); context.closePath();
      context.fillStyle = '#ffffff'; context.fill();
      context.strokeStyle = '#071014'; context.lineWidth = Math.max(1, canvas.width / 256); context.stroke();
    }
    if (THREE) texture.needsUpdate = true;
  };
  const texture = THREE ? new THREE.CanvasTexture(canvas) : null;
  if (texture) texture.colorSpace = THREE.SRGBColorSpace;
  draw();
  return {
    canvas, texture,
    draw,
    pointer(u, v) {
      const next = Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
      if (pointer?.u === next?.u && pointer?.v === next?.v) return;
      pointer = next;
      draw();
    },
    hit(u, v, state, target = entity) {
      const x = u * canvas.width, y = (1 - v) * canvas.height;
      const item = controls.find(entry => x >= entry.x && x <= entry.x + entry.width && y >= entry.y && y <= entry.y + entry.height);
      if (!item) return false;
      if (terminal.inputVariable) {
        if (typeof target?.variables?.[terminal.inputVariable] !== 'string') {
          throw new Error('Terminal digits need a declared text local variable');
        }
        input = target.variables[terminal.inputVariable];
      }
      if (item.action.type === 'digit' && !unlocked) input = `${input}${item.action.value}`.slice(0, 64);
      else if (item.action.type === 'clear' && !unlocked) { input = ''; message = 'Enter access code'; }
      else if (item.action.type === 'enter' && !unlocked) {
        unlocked = input === terminal.code;
        message = unlocked ? 'Access granted' : 'Access denied';
        if (unlocked && state?.variables && terminal.variable) state.variables[terminal.variable] = 1;
        if (terminal.submitSignal) emitSignal(state, target.id, terminal.submitSignal, input);
      } else if (item.action.type === 'assign' && unlocked && state?.variables) {
        if (terminal.variable) state.variables[terminal.variable] = item.action.value;
        if (terminal.submitSignal) emitSignal(state, target.id, terminal.submitSignal, item.action.value);
        message = `${item.label} selected`;
      } else return false;
      if (terminal.inputVariable) target.variables[terminal.inputVariable] = input;
      draw();
      return true;
    },
    get unlocked() { return unlocked; },
    get message() { return message; },
    dispose() { texture?.dispose(); },
  };
}

export function createWorldTerminalController({ state, getEntity }) {
  let active = null;
  const close = () => {
    if (!active) return false;
    active.entry.terminal.pointer?.(null, null);
    active = null;
    state.worldTerminalActive = false;
    delete state.worldTerminalId;
    return true;
  };
  const validEntity = () => {
    if (!active || state.gameScreen !== 'playing') return null;
    const entity = getEntity(active.id);
    if (!entity || entity.terminal !== active.terminal) return null;
    const player = state.player || {};
    const distance = Math.hypot(entity.x - (player.x || 0), entity.y - (player.y || 0),
      (entity.z ?? entity.elevation ?? 0) - (player.z || 0));
    return distance <= (entity.terminal.range || 160) ? entity : null;
  };
  const open = (entry, entity) => {
    if (state.gameScreen !== 'playing' || !entity?.terminal || !entry?.terminal) return false;
    const player = state.player || {};
    const distance = Math.hypot(entity.x - (player.x || 0), entity.y - (player.y || 0),
      (entity.z ?? entity.elevation ?? 0) - (player.z || 0));
    if (distance > (entity.terminal.range || 160)) return false;
    if (active?.entry === entry && validEntity()) return true;
    close();
    active = { id: entity.id, entry, terminal: entity.terminal };
    state.worldTerminalActive = true;
    state.worldTerminalId = entity.id;
    return true;
  };
  return {
    open,
    close,
    pointer(u, v) { active?.entry.terminal.pointer?.(u, v); },
    hit(u, v) {
      const entity = validEntity();
      if (!entity) { close(); return false; }
      state.variables ||= {};
      return active.entry.terminal.hit(u, v, state, entity);
    },
    update() { if (active && !validEntity()) close(); },
    dispose: close,
    get active() { return Boolean(active); },
  };
}

export function gameplayCrosshairVisible(project, state) {
  if (state.gameScreen !== 'playing' || state.hudState?.cursor || state.worldTerminalActive) return false;
  return !state.hud || !(project.hud?.elements || []).some(source => {
    const element = state.hudState?.elements?.get(source.id) || source;
    return source.name === 'Crosshair' && element.visible && element.opacity > 0 &&
      ['game', 'always'].includes(element.display);
  });
}

/**
 * Creates a real Three.js object for a 3D scene node. The same factory is used by the
 * game renderer and the scene preview so geometry, anchors, textures and sidedness match.
 *
 * @param {object} THREE Three.js namespace (either three or three/webgpu).
 * @param {object} entity Project entity with spritePlane, projector, terminal or mesh.
 * @param {object} options Optional texture, document and materialFactory.
 * @returns {{object: object, geometry?: object, material?: object, terminal?: object, texture?: object, nodeKind: string}|null}
 */
export function createWorldNodeObject(THREE, entity, {
  texture = null, materialFactory = null, document = globalThis.document, upAxis = 'y',
} = {}) {
  const kind = mediaNodeKind(entity);
  if (entity.spritePlane) {
    const component = entity.spritePlane;
    const surface = addSurface(THREE, planeGeometry(THREE, component.width, component.height, upAxis), {
      texture, opacity: component.opacity ?? 1, doubleSided: component.doubleSided ?? true,
    }, materialFactory);
    surface.object.userData.billboard = component.billboard === true;
    return { ...surface, nodeKind: 'spritePlane' };
  }
  if (entity.projector) {
    const component = entity.projector;
    const surface = addSurface(THREE, planeGeometry(THREE, component.width, component.height, upAxis), {
      texture, opacity: component.opacity ?? 1, doubleSided: true,
    }, materialFactory);
    return { ...surface, nodeKind: 'projector' };
  }
  if (entity.terminal) {
    if (!document) throw new Error('Terminal surfaces need a browser document');
    const terminal = createTerminalCanvas(document, entity.terminal, THREE, entity);
    const surface = addSurface(THREE, planeGeometry(THREE, entity.terminal.width, entity.terminal.height, upAxis), {
      texture: terminal.texture, opacity: 1, doubleSided: true,
    }, materialFactory);
    surface.object.userData.terminal = true;
    return { ...surface, nodeKind: 'terminal', terminal };
  }
  if (entity.mesh) {
    const component = entity.mesh;
    const surface = addSurface(THREE, centeredPrimitiveGeometry(THREE, component, upAxis), {
      texture, color: component.color, opacity: component.opacity ?? 1,
      doubleSided: true,
    }, materialFactory);
    return { ...surface, nodeKind: 'mesh' };
  }
  if (isNonvisualMediaNode(entity)) {
    const object = new THREE.Group();
    object.userData.nodeKind = kind;
    return { object, nodeKind: kind };
  }
  return null;
}

export function setWorldNodePose(entry, entity, floorHeight = 0, orientationForEntity = sharedModelOrientation, { upAxis = 'y' } = {}) {
  const component = entity.spritePlane || entity.projector || entity.terminal || entity.mesh;
  if (!entry?.object || !component) return;
  const height = entity.spritePlane?.height || entity.projector?.height || entity.terminal?.height || entity.mesh?.height || 0;
  const bottom = entity.z ?? floorHeight + (entity.elevation || 0);
  if (upAxis === 'z') entry.object.position.set(entity.x, entity.y, bottom + height / 2);
  else entry.object.position.set(entity.x, bottom + height / 2, entity.y);
  if (entity.spritePlane?.billboard && entry.camera) entry.object.lookAt(entry.camera.position);
  else {
    const orientation = orientationForEntity?.(entity) || sharedModelOrientation(entity);
    entry.object.quaternion.fromArray(upAxis === 'z' ? runtimeQuaternionToMapZUp(orientation) : orientation);
  }
}
