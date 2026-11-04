/**
 * The Shader Engine: a stack of full-screen effects ported from *3D Game Shaders For
 * Beginners* (Lettier).
 *
 * Every technique in that book that works as a full-screen pass is here — bloom, blur,
 * outlining, dilation, SSAO, screen-space reflection and refraction, depth of field,
 * motion blur, fog, film grain, chromatic aberration, gamma correction, posterization,
 * cel shading, pixelization, sharpen, a colour lookup table, flow mapping, foam, fresnel,
 * rim lighting, Blinn-Phong and normal mapping. The surface techniques are re-lit in
 * screen space from the depth buffer, which is what a forward renderer can do without a
 * geometry pass, and their math is the book's own.
 *
 * The chapter chapters on deferred rendering, render-to-texture and reference frames are
 * architecture, not passes: this engine already renders to a texture and reconstructs
 * view-space positions from depth, which is exactly what they describe. `Docs/shader-engine.md`
 * says so in the same words.
 *
 * A pass stack is project data, in draw order:
 *
 *   project.postFx = { enabled: true, passes: [{ kind: 'bloom', enabled: true, params: { intensity: 0.6 } }] }
 */

const param = (name, label, value, min, max, step = 0.01, hint = '') =>
  ({ name, label, value, min, max, step, ...(hint ? { hint } : {}) });

/** Every technique, in the order the book presents them. */
export const POST_FX_CATALOG = [
  {
    kind: 'blinnPhong', section: 'blinn-phong', name: 'Blinn-Phong shading',
    summary: 'Re-lights the frame from the depth buffer with the Blinn-Phong model: diffuse plus a half-vector highlight. Adjustable like the book\'s material parameters.',
    params: [param('shininess', 'Shininess', 64, 2, 256, 1), param('specular', 'Specular', 0.6, 0, 3),
      param('diffuse', 'Diffuse', 0.5, 0, 2), param('lightAngle', 'Light angle', 40, 0, 360, 1)],
  },
  {
    kind: 'normalMapping', section: 'normal-mapping', name: 'Normal mapping',
    summary: 'Adds surface detail to that lighting with a procedural normal map, the book\'s tangent-space normal trick without the extra texture.',
    params: [param('strength', 'Strength', 0.6, 0, 2), param('scale', 'Detail scale', 24, 1, 200, 1)],
  },
  {
    kind: 'gamma', section: 'gamma-correction', name: 'Gamma correction',
    summary: 'Raises the frame to 1/gamma. 2.2 is the standard display gamma; 1.0 is the untouched image.',
    params: [param('gamma', 'Gamma', 2.2, 0.5, 4, 0.05)],
  },
  {
    kind: 'blur', section: 'blur', name: 'Box blur',
    summary: 'The mean of a square window around each fragment. Separation spreads the window out without taking more samples.',
    params: [param('size', 'Window half-size', 2, 1, 4, 1), param('separation', 'Separation (px)', 1, 1, 6, 0.1)],
  },
  {
    kind: 'bloom', section: 'bloom', name: 'Bloom',
    summary: 'Bright fragments are isolated, blurred, and added back so light bleeds into the nearby dark.',
    params: [param('threshold', 'Bright threshold', 0.55, 0, 1), param('intensity', 'Intensity', 0.75, 0, 3),
      param('separation', 'Spread (px)', 2.5, 1, 12, 0.1)],
  },
  {
    kind: 'outline', section: 'outlining', name: 'Outlining',
    summary: 'Compares the depth of the neighbours of each fragment; where it jumps, an edge is drawn. Separation grows with distance like the book\'s.',
    params: [param('thickness', 'Thickness (px)', 1, 1, 4, 1), param('minDistance', 'Min depth jump', 0.4, 0.01, 8, 0.01),
      param('maxDistance', 'Max depth jump', 2.5, 0.05, 40, 0.05), param('strength', 'Line strength', 0.85, 0, 1)],
  },
  {
    kind: 'dilation', section: 'dilation', name: 'Dilation',
    summary: 'The window around each fragment keeps its brightest colour, which grows highlights and feeds the outline glow.',
    params: [param('size', 'Window half-size', 2, 1, 4, 1), param('separation', 'Separation (px)', 2, 1, 8, 0.1),
      param('threshold', 'Threshold', 0.2, 0, 1), param('strength', 'Strength', 0.7, 0, 1)],
  },
  {
    kind: 'cel', section: 'cel-shading', name: 'Cel shading',
    summary: 'Quantises the frame into flat bands of light and dark and inks the silhouette, the toon look the book builds from a gradient map and an outline.',
    params: [param('steps', 'Bands', 4, 2, 10, 1), param('edge', 'Ink strength', 0.7, 0, 1),
      param('edgeThreshold', 'Ink threshold', 0.8, 0.05, 8, 0.05)],
  },
  {
    kind: 'posterize', section: 'posterization', name: 'Posterization',
    summary: 'Rounds every channel down to a fixed number of levels, giving flat colour bands.',
    params: [param('levels', 'Levels', 6, 2, 32, 1)],
  },
  {
    kind: 'pixelization', section: 'pixelization', name: 'Pixelization',
    summary: 'Samples one fragment per block, so the frame becomes chunky pixels of that size.',
    params: [param('size', 'Block size (px)', 4, 1, 32, 1)],
  },
  {
    kind: 'sharpen', section: 'sharpen', name: 'Sharpen',
    summary: 'An unsharp mask: the frame plus the difference between itself and its blurred self.',
    params: [param('amount', 'Amount', 1.2, 0, 4), param('separation', 'Radius (px)', 1, 1, 4, 0.1)],
  },
  {
    kind: 'chromaticAberration', section: 'chromatic-aberration', name: 'Chromatic aberration',
    summary: 'Splits the colour channels radially, the way a real lens bends red and blue differently, strongest at the edges.',
    params: [param('amount', 'Amount', 0.0025, 0, 0.03, 0.0005), param('falloff', 'Edge falloff', 1.4, 0.2, 4)],
  },
  {
    kind: 'lut', section: 'lookup-table', name: 'Lookup table (colour grading)',
    summary: 'Maps every colour through a 16x16x16 table — the book\'s grading technique — with a few ready-made grades.',
    params: [param('preset', 'Grade (0 neutral, 1 warm, 2 cool, 3 sepia)', 1, 0, 3, 1),
      param('amount', 'Amount', 1, 0, 1)],
  },
  {
    kind: 'fog', section: 'fog', name: 'Fog',
    summary: 'Blends towards a fog colour with distance, from the depth buffer.',
    params: [param('near', 'Start distance', 300, 0, 4000, 10), param('far', 'Full distance', 1800, 1, 8000, 10),
      param('density', 'Density', 0.85, 0, 1), param('red', 'Fog red', 0.55, 0, 1), param('green', 'Fog green', 0.6, 0, 1),
      param('blue', 'Fog blue', 0.68, 0, 1)],
  },
  {
    kind: 'depthOfField', section: 'depth-of-field', name: 'Depth of field',
    summary: 'A circle of confusion from the distance to the focus plane decides how far each fragment is blurred.',
    params: [param('focus', 'Focus distance', 700, 1, 4000, 10), param('range', 'Focus range', 900, 1, 4000, 10),
      param('blur', 'Blur strength (px)', 3, 0.5, 12, 0.1)],
  },
  {
    kind: 'motionBlur', section: 'motion-blur', name: 'Motion blur',
    summary: 'Keeps part of the previous frame, so anything that moves smears behind itself.',
    params: [param('amount', 'Trail', 0.45, 0, 0.9)],
  },
  {
    kind: 'ssao', section: 'ssao', name: 'Screen-space ambient occlusion',
    summary: 'Samples a hemisphere of screen positions around each fragment; where the neighbours are closer than the fragment, it is darkened.',
    params: [param('radius', 'Radius (world units)', 48, 1, 400, 1), param('intensity', 'Intensity', 1.1, 0, 3),
      param('bias', 'Bias', 0.6, 0, 20, 0.1)],
  },
  {
    kind: 'ssr', section: 'screen-space-reflection', name: 'Screen-space reflection',
    summary: 'Marches the reflected view ray through the depth buffer and picks up whatever surface it hits.',
    params: [param('strength', 'Strength', 0.6, 0, 1), param('rayLength', 'Ray length (world units)', 600, 10, 4000, 10),
      param('thickness', 'Surface thickness', 40, 1, 400, 1)],
  },
  {
    kind: 'ssrRefraction', section: 'screen-space-refraction', name: 'Screen-space refraction',
    summary: 'Bends the frame behind each surface with a normal taken from the depth buffer, glass and water without rendering the level twice.',
    params: [param('strength', 'Strength', 0.02, 0, 0.2, 0.001), param('dispersion', 'Dispersion', 0.35, 0, 2),
      param('depthScale', 'Thickness scale', 2, 0.1, 20, 0.1)],
  },
  {
    kind: 'fresnel', section: 'fresnel-factor', name: 'Fresnel factor',
    summary: 'Brightens surfaces seen edge-on and leaves them alone face-on, the fresnel term the book uses for edges and reflections.',
    params: [param('power', 'Power', 3, 0.5, 8), param('intensity', 'Intensity', 0.8, 0, 3)],
  },
  {
    kind: 'rim', section: 'rim-lighting', name: 'Rim lighting',
    summary: 'A light behind the subject that only catches its silhouette, drawn where the depth gradient is steepest.',
    params: [param('power', 'Power', 2.2, 0.5, 8), param('intensity', 'Intensity', 1.4, 0, 4),
      param('red', 'Rim red', 0.9, 0, 1), param('green', 'Rim green', 0.95, 0, 1), param('blue', 'Rim blue', 1, 0, 1)],
  },
  {
    kind: 'flow', section: 'flow-mapping', name: 'Flow mapping',
    summary: 'Scrolls two noise layers across each other and bends the frame with them: water, heat haze and warped glass.',
    params: [param('strength', 'Strength', 0.01, 0, 0.1, 0.001), param('speed', 'Speed', 0.25, 0, 3),
      param('scale', 'Scale', 6, 0.5, 40, 0.1)],
  },
  {
    kind: 'foam', section: 'foam', name: 'Foam',
    summary: 'Paints foam where the water meets geometry: a large depth jump in front of a surface, broken up by noise.',
    params: [param('threshold', 'Shore threshold', 1.2, 0.05, 12, 0.05), param('amount', 'Amount', 0.9, 0, 1),
      param('scale', 'Noise scale', 40, 1, 200, 1)],
  },
  {
    kind: 'filmGrain', section: 'film-grain', name: 'Film grain',
    summary: 'Adds per-fragment noise, the analogue film look of the book\'s grain pass.',
    params: [param('amount', 'Amount', 0.06, 0, 0.4), param('scale', 'Grain scale', 1.4, 0.2, 6)],
  },
];

export const POST_FX_BY_KIND = new Map(POST_FX_CATALOG.map(entry => [entry.kind, entry]));
export const POST_FX_KINDS = POST_FX_CATALOG.map(entry => entry.kind);

/** Ready-made stacks: the whole point of a chain is that a look is more than one pass. */
export const POST_FX_PRESETS = [
  { id: 'off', name: 'Off (engine default)', passes: [] },
  { id: 'toon', name: 'Toon', passes: [{ kind: 'cel', params: { steps: 4, edge: 0.8 } }, { kind: 'posterize', params: { levels: 8 } }] },
  { id: 'cinematic', name: 'Cinematic', passes: [{ kind: 'lut', params: { preset: 1, amount: 0.8 } },
    { kind: 'fog', params: { near: 500, far: 2400, density: 0.5, red: 0.5, green: 0.55, blue: 0.66 } },
    { kind: 'bloom', params: { threshold: 0.6, intensity: 0.5 } }, { kind: 'filmGrain', params: { amount: 0.03 } }] },
  { id: 'retro', name: 'Retro shooter', passes: [{ kind: 'pixelization', params: { size: 3 } },
    { kind: 'posterize', params: { levels: 5 } }, { kind: 'dilation', params: { size: 2, separation: 1.5, threshold: 0.35, strength: 0.5 } }] },
  { id: 'underwater', name: 'Underwater', passes: [{ kind: 'ssrRefraction', params: { strength: 0.03, dispersion: 0.7, depthScale: 3 } },
    { kind: 'flow', params: { strength: 0.02, speed: 0.5, scale: 8 } },
    { kind: 'fog', params: { near: 120, far: 1400, density: 0.8, red: 0.1, green: 0.28, blue: 0.36 } },
    { kind: 'foam', params: { threshold: 1.4, amount: 0.7 } }] },
  { id: 'dream', name: 'Dream', passes: [{ kind: 'bloom', params: { threshold: 0.45, intensity: 1.1, separation: 4 } },
    { kind: 'chromaticAberration', params: { amount: 0.004 } }, { kind: 'depthOfField', params: { focus: 600, range: 700, blur: 4 } }] },
  { id: 'noir', name: 'Noir', passes: [{ kind: 'lut', params: { preset: 3, amount: 0.9 } },
    { kind: 'sharpen', params: { amount: 1.6 } }, { kind: 'filmGrain', params: { amount: 0.1 } }] },
];

/** A pass with the catalogue's default parameters. */
export function createPostFxPass(kind, overrides = {}) {
  const entry = POST_FX_BY_KIND.get(kind);
  if (!entry) throw new Error(`Unknown post effect ${kind}`);
  return {
    kind, enabled: true,
    params: Object.fromEntries(entry.params.map(spec => [spec.name,
      Number.isFinite(overrides[spec.name]) ? overrides[spec.name] : spec.value])),
  };
}

/** The stack a project starts with: no passes, and the engine renders exactly as before. */
export function defaultPostFx() {
  return { enabled: true, passes: [] };
}

/** A preset as project data. Unknown passes are dropped rather than smuggled in. */
export function postFxPreset(id) {
  const preset = POST_FX_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error(`Unknown post effect preset ${id}`);
  return { enabled: preset.passes.length > 0, passes: preset.passes.map(pass => createPostFxPass(pass.kind, pass.params)) };
}

/** The passes that actually run, in draw order. */
export function activePostFxPasses(postFx) {
  if (!postFx || postFx.enabled === false) return [];
  return (postFx.passes || []).filter(pass => pass && pass.enabled !== false);
}

/** A stable signature, so the renderer rebuilds only when the stack really changed. */
export function postFxSignature(postFx) {
  if (!postFx) return '';
  return JSON.stringify([postFx.enabled !== false,
    (postFx.passes || []).map(pass => [pass.kind, pass.enabled !== false, Object.entries(pass.params || {}).sort()])]);
}

export function validatePostFx(project) {
  const postFx = project?.postFx;
  if (postFx === undefined || postFx === null) return [];
  const errors = [];
  if (typeof postFx !== 'object' || Array.isArray(postFx)) return ['postFx must be an object'];
  if (postFx.enabled !== undefined && typeof postFx.enabled !== 'boolean') errors.push('postFx.enabled must be true or false');
  const passes = postFx.passes ?? [];
  if (!Array.isArray(passes)) return [...errors, 'postFx.passes must be an array'];
  if (passes.length > POST_FX_CATALOG.length) errors.push('postFx.passes holds more passes than there are techniques');
  const seen = new Set();
  for (const pass of passes) {
    const label = `Post effect ${pass?.kind || '(unnamed)'}`;
    if (!pass || typeof pass !== 'object' || Array.isArray(pass)) { errors.push(`${label} must be an object`); continue; }
    const entry = POST_FX_BY_KIND.get(pass.kind);
    if (!entry) { errors.push(`${label} is not a technique the shader engine has`); continue; }
    if (seen.has(pass.kind)) errors.push(`${label} appears more than once in the stack`);
    seen.add(pass.kind);
    if (pass.enabled !== undefined && typeof pass.enabled !== 'boolean') errors.push(`${label} enabled must be true or false`);
    if (pass.params !== undefined && (typeof pass.params !== 'object' || pass.params === null || Array.isArray(pass.params)))
      { errors.push(`${label} params must be an object`); continue; }
    for (const [name, value] of Object.entries(pass.params || {})) {
      const spec = entry.params.find(item => item.name === name);
      if (!spec) { errors.push(`${label} has no parameter named ${name}`); continue; }
      if (!Number.isFinite(value)) { errors.push(`${label} parameter ${name} must be a number`); continue; }
      if (value < spec.min || value > spec.max) errors.push(`${label} parameter ${name} must be between ${spec.min} and ${spec.max}`);
    }
  }
  return errors;
}

/** The default value of one parameter, for the editor and for runtime resets. */
export function postFxParamDefault(kind, name) {
  return POST_FX_BY_KIND.get(kind)?.params.find(spec => spec.name === name)?.value ?? 0;
}

/** Every (pass, parameter) pair, so the renderer can keep one uniform per value. */
export function postFxParamNames(pass) {
  return (POST_FX_BY_KIND.get(pass.kind)?.params || []).map(spec => spec.name);
}
