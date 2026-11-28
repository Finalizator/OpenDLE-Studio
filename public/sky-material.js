// One sky material, built from the Skybox tab's record.
//
// The numbers here are the same ones `shared/skybox.js#skyTexel` computes on the CPU, so the tab's
// preview, the editor's 3D view and the running game agree about where a picture sits. Everything
// that varies per frame (the sky's clock, the view) is a uniform; everything structural (which
// pictures, how they blend, the window) is baked into the graph and rebuilt when the record changes.
//
// It lives on its own because two places draw a sky: the engine (`public/render.js`, as the
// background of the level) and the Skybox tab's own viewport (`public/skybox-viewport.js`). One
// builder means the tab cannot drift away from what the game draws.
import * as THREE from 'three/webgpu';
import { uniform, float, vec2, vec3, vec4, uv, positionGeometry, texture, cubeTexture, sin, cos, tan, atan, asin, clamp, mix,
  fract, pow, floor, step, smoothstep, max, min, abs, normalize, cross } from 'three/tsl';
import { coverageWindow, SKY_LAYER_DRAW_LIMIT, SKY_FACES } from '/shared/skybox.js';
import { skyDomeMapping, SKY_DOME_DEGREES } from '/shared/sky-dome.js';

const DEG = Math.PI / 180, TWO_PI = Math.PI * 2;

/** The direction a sun azimuth and elevation name, in the renderer's axis order (x east, y up, z north). */
export function directionFromAngles(azimuthDegrees, elevationDegrees) {
  const az = Number(azimuthDegrees) * DEG, el = Number(elevationDegrees) * DEG;
  return vec3(float(Math.cos(el) * Math.cos(az)), float(Math.sin(el)), float(Math.cos(el) * Math.sin(az)));
}

/** Combines one layer with what is under it; the same blend list the tab offers. */
export function blendSkyLayer(base, source, alpha, blend) {
  if (blend === 'add') return base.add(source.mul(alpha));
  if (blend === 'multiply') return mix(base, base.mul(source), alpha);
  if (blend === 'screen') return mix(base, base.oneMinus().mul(source.oneMinus()).oneMinus(), alpha);
  if (blend === 'overlay') {
    // `overlay(base, source)`: multiply where the base is dark, screen where it is light.
    const low = base.mul(2).mul(source);
    const high = base.mul(2).oneMinus().mul(source.oneMinus()).oneMinus();
    return mix(base, mix(low, high, step(.5, base)), alpha);
  }
  // `replace` and `alpha` are the same source-over: a picture with transparency shows what is
  // behind it, and an opaque one hides it.
  return mix(base, source, alpha);
}

/**
 * Builds the fragment program for one skybox record.
 *
 * `textures` is a `Map` from asset id to a three texture. Returns the material, the quad geometry it
 * is drawn with, the per-view uniforms and the cubes this call made (which the caller owns and must
 * dispose).
 */
export function createSkyMaterial(skybox, textures) {
  const cubes = new Set();
  const DEG = Math.PI / 180, TWO_PI = Math.PI * 2;
  // `vec3(new THREE.Color('#2b4a73'))` is not a colour: a `Color` is a JavaScript object, and
  // the node builder takes it as no known type and yields (0, 0, 0) — the whole sky came out
  // black. Its channels are numbers, which is what a node wants.
  const colourVector = value => {
    const colour = new THREE.Color(value);
    return vec3(float(colour.r), float(colour.g), float(colour.b));
  };
  const heading = uniform(0, 'float'), pitch = uniform(0, 'float'), aspect = uniform(800 / 450),
    tanFov = uniform(Math.tan(35 * DEG)), skyTime = uniform(0, 'float');
  const exposure = uniform(Math.max(0, Number(skybox.exposure === undefined ? 1 : skybox.exposure)), 'float');
  const zoom = uniform(Math.max(.01, Number(skybox.scale) || 1), 'float');
  const window = coverageWindow(skybox.coverage, 0);
  const doomSky = skybox.projection === 'doom';

  // The view ray, built exactly as the panorama path builds it.
  const p = uv().mul(2).sub(1).mul(tanFov);
  const forward = vec3(cos(pitch).mul(cos(heading)), sin(pitch), cos(pitch).mul(sin(heading)));
  const right = vec3(sin(heading).negate(), 0, cos(heading));
  const ray = normalize(forward.add(right.mul(p.x).mul(aspect)).add(cross(right, forward).mul(p.y)));
  const elevationWorld = asin(clamp(ray.y, -1, 1));
  let azimuthWorld = atan(ray.z, ray.x);
  azimuthWorld = azimuthWorld.sub(azimuthWorld.div(TWO_PI).floor().mul(TWO_PI));
  const spanTurn = (window.span / 360) * TWO_PI;

  const layers = [];
  for (const [index, layer] of (skybox.layers || []).entries()) {
    if (index >= SKY_LAYER_DRAW_LIMIT) break;
    const faces = layer.faces;
    const assetId = layer.assetId || (faces ? faces.px : null);
    const source = assetId ? textures.get(assetId) : null;
    if (!source) continue;
    // A `.dds` cubemap decodes to a cube already. A legacy six-face record stores six
    // separate pictures — the shape `environment.skybox` had before this record existed — so
    // the six of them are gathered into the cube the shader samples.
    let cubeTextureSource = source?.isCubeTexture ? source : null;
    if (!cubeTextureSource && faces) {
      const faceImages = SKY_FACES.map(face => textures.get(faces[face])?.image).filter(Boolean);
      const cube = faceImages.length === SKY_FACES.length && faceImages.every(image => image.complete !== false && image.width)
        ? new THREE.CubeTexture(faceImages) : null;
      if (cube) {
        cube.colorSpace = THREE.SRGBColorSpace;
        cube.needsUpdate = true;
        cubes.add(cube);
        cubeTextureSource = cube;
      }
    }
    const cube = Boolean(cubeTextureSource);
    if (cube) {
      // A cubemap covers the whole sphere by definition, so it has no window to fall outside
      // of: it is sampled with the view direction itself.
      const sampler = cubeTexture(cubeTextureSource, ray);
      layers.push({ layer, sampler, mask: null, blend: layer.blend, opacity: Number(layer.opacity) || 0 });
      continue;
    }
    // The window this layer is drawn in: its own, or the sky's.
    const own = layer.coverage?.enabled ? layer.coverage : null;
    const ownWindow = own ? coverageWindow(own, 0) : null;
    const azFrom = ((ownWindow ? ((ownWindow.from % 360) + 360) % 360 : ((window.from % 360) + 360) % 360)) * DEG;
    const azSpan = Math.max(1e-5, (ownWindow ? ownWindow.span : window.span) / 360) * TWO_PI;
    const elLow = (ownWindow ? ownWindow.lowElevation : window.lowElevation) * DEG;
    const elSpan = Math.max(1e-5, (ownWindow ? ownWindow.elevationSpan : window.elevationSpan)) * DEG;

    const across = fract(azimuthWorld.sub(azFrom).div(TWO_PI)).mul(TWO_PI).div(azSpan);
    // The vertical coordinate: a rectangle over the window, or GZDoom's dome where a ray at
    // elevation `e` meets the ellipsoid at `atan2(tan e, scale) - asin(shift / hypot(tan e, scale))`
    // and the picture's rows follow from that angle. `skyDomeV` in `shared/sky-dome.js` is the same
    // formula on the CPU, and the two are checked against each other.
    let up;
    if (doomSky) {
      const rows = Number(source.image?.height) || 240;
      const { scale, shift, textureScale } = skyDomeMapping(rows);
      const slope = tan(elevationWorld);
      const radius = pow(slope.mul(slope).add(scale * scale), float(.5));
      const angle = atan(slope, float(scale)).sub(asin(clamp(float(shift).div(radius), -1, 1)));
      const degrees = clamp(angle.mul(180 / Math.PI), 0, SKY_DOME_DEGREES);
      const raw = float(1).sub(degrees.div(SKY_DOME_DEGREES)).mul(textureScale);
      // A short picture tiles vertically (`textureScale > 1`); a full one clamps at its edges.
      up = textureScale === 1 ? clamp(raw, float(.001), float(.999)) : fract(raw);
    } else {
      up = elevationWorld.sub(elLow).div(elSpan);
    }
    // The picture slides inside its window and wraps round it: `rotation` pans it.
    const rotation = Number(skybox.rotation) || 0;
    const turned = fract(across.add(rotation / Math.max(1e-5, ownWindow ? ownWindow.span : window.span)));
    const uvRepeat = layer.uv || {};
    // The clock is a node, so it multiplies rather than being multiplied: `number * node` is
    // NaN, not a graph, and the whole sky failed to build with "drift.mul is not a function".
    const drift = skyTime.mul((Number(layer.spin?.azimuth) || 0) / 360);
    let u = turned.mul(Number(uvRepeat.repeatU ?? 1) || 1).add(Number(uvRepeat.offsetU) || 0).add(drift);
    let v = up.mul(Number(uvRepeat.repeatV ?? 1) || 1).add(Number(uvRepeat.offsetV) || 0)
      .add(skyTime.mul((Number(layer.spin?.elevation) || 0) / 360));
    // Zoom about the middle of the window, as the CPU does.
    u = u.sub(.5).mul(zoom).add(.5);
    v = v.sub(.5).mul(zoom).add(.5);
    // Rotate the layer's own tiling about the middle of the picture.
    const spin = (Number(uvRepeat.rotate) || 0) * DEG;
    if (spin) {
      const cu = u.sub(.5), cv = v.sub(.5);
      const rotatedU = cu.mul(Math.cos(spin)).sub(cv.mul(Math.sin(spin))).add(.5);
      const rotatedV = cu.mul(Math.sin(spin)).add(cv.mul(Math.cos(spin))).add(.5);
      u = rotatedU; v = rotatedV;
    }

    const edge = (own && skybox.coverage?.edge) || skybox.coverage?.edge || 'fade';
    const outsideWindow = max(0, across.oneMinus().negate().max(across.sub(1)), up.oneMinus().negate().max(up.sub(1)));
    // A wrapped picture has no outside; anything else fades or stops at its own edge.
    const wrapped = edge === 'wrap' || edge === 'mirror';
    const outsidePicture = wrapped ? float(0)
      : max(0, u.oneMinus().negate().max(u.sub(1)), v.oneMinus().negate().max(v.sub(1)));
    const outside = outsideWindow.max(outsidePicture);
    let mask = float(1);
    const featherValue = Math.max(0, Number(skybox.coverage?.feather) || 0) * DEG / Math.max(1e-5, elSpan);
    if (edge === 'none') mask = float(1).sub(step(1e-4, outside));
    else if (edge === 'fade') mask = featherValue > 1e-5
      ? smoothstep(0, featherValue, outside).oneMinus()
      : float(1).sub(step(1e-4, outside));
    // A layer whose tiling is not 1 repeats its picture, so its sample coordinate wraps: clamping
    // `u` of 3.2 to 1 read the whole sky as the picture's right-hand texel.
    const repeated = Number(uvRepeat.repeatU ?? 1) !== 1 || Number(uvRepeat.repeatV ?? 1) !== 1;
    let sampleU = clamp(u, 0, 1), sampleV = clamp(v, 0, 1);
    if (repeated || edge === 'wrap') { sampleU = fract(u); sampleV = fract(v); }
    if (edge === 'mirror') {
      sampleU = fract(u).mul(2).sub(1).abs().oneMinus();
      sampleV = fract(v).mul(2).sub(1).abs().oneMinus();
    }
    const sampler = texture(source, vec2(sampleU, sampleV));
    layers.push({ layer, sampler, mask, blend: layer.blend, opacity: Number(layer.opacity) || 0 });
  }

  const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);

  // The base: a flat colour, or a gradient with a sun and stars for a procedural sky.
  let colour = colourVector(skybox.coverage?.background || '#000000');
  if (skybox.shape === 'procedural') {
    const procedural = skybox.procedural || {};
    const top = colourVector(procedural.top || '#2b4a73');
    const horizon = colourVector(procedural.horizon || '#c8ccd2');
    const groundBottom = colourVector(procedural.groundBottom || '#33291f');
    const groundHorizon = colourVector(procedural.groundHorizon || '#a5a7a8');
    const skyCurve = Math.max(.01, Number(procedural.curve) || .15);
    const groundCurve = Math.max(.01, Number(procedural.groundCurve) || .02);
    const up = clamp(ray.y, -1, 1);
    // Godot's `ProceduralSkyMaterial` gradient: `pow(1 - y, curve)` toward the horizon and
    // `pow(1 + y, curve)` toward the ground, with the two halves chosen by the sign of y.
    const sky = mix(top, horizon, clamp(pow(up.oneMinus(), float(skyCurve)), 0, 1));
    const ground = mix(groundBottom, groundHorizon, clamp(pow(up.add(1), float(groundCurve)), 0, 1));
    colour = mix(ground, sky, step(0, ray.y));
    if (skybox.sun?.enabled) {
      const sunDirection = directionFromAngles(skybox.sun.azimuth || 0, skybox.sun.elevation || 0);
      const disc = step(Math.cos((Number(skybox.sun.size) || 3) * DEG), ray.dot(sunDirection));
      const glow = pow(clamp(ray.dot(sunDirection), 0, 1), float(24));
      const strength = Number(skybox.sun.intensity === undefined ? 1 : skybox.sun.intensity);
      colour = colour.add(colourVector(skybox.sun.color || '#fff4d6')
        .mul(disc.mul(strength).add(glow.mul(strength * .18))));
    }
    if (skybox.stars?.enabled) {
      const density = Math.max(.02, Math.min(1, Number(skybox.stars.density) || .5));
      const cell = floor(ray.mul(float(340)));
      const hash = fract(sin(cell.x.mul(12.9898).add(cell.y.mul(78.233)).add(cell.z.mul(37.719))).mul(43758.5453));
      const star = step(hash.mul(density).oneMinus().mul(.998).oneMinus(), float(1))
        .mul(step(hash, float(density)));
      colour = colour.add(vec3(star).mul(clamp(ray.y, 0, 1).mul(1.4)));
    }
  }

  // Fold each layer over the base, one blend at a time. `drawn` accumulates how much of the
  // view any layer actually covered, which becomes the fragment's alpha: outside the window
  // the sky must be *transparent* so the level's own background shows through, not an opaque
  // black band (which is what the first version looked like in the 3D view).
  let drawn = float(0);
  for (const entry of layers) {
    const sample = entry.sampler;
    const alpha = (sample.a ?? float(1)).mul(float(entry.opacity));
    const covered = entry.mask ? alpha.mul(entry.mask) : alpha;
    drawn = drawn.max(entry.mask || covered.oneMinus().oneMinus());
    colour = blendSkyLayer(colour, vec3(sample.rgb ?? sample), covered, entry.blend);
  }
  // A procedural sky and a solid colour need nothing behind them; a picture sky is only as
  // wide as its window.
  const alpha = skybox.shape === 'procedural' || skybox.shape === 'solid' ? float(1) : drawn;
  material.fragmentNode = vec4(colour.mul(colourVector(skybox.tint || '#ffffff')).mul(exposure), alpha);
  material.transparent = true;

  return { material, layers, geometry: new THREE.PlaneGeometry(2, 2), cubes,
    uniforms: { heading, pitch, aspect, tanFov, skyTime, zoom, exposure } };

}
