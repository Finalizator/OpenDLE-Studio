// Flat panels: the geometry a sprite cannot provide.
//
// A panel is a thin, flat, translucent slab standing on the floor — plastic strip
// curtains, glass, banners, screens. It is a visual like `spriteAsset` or `modelAsset`
// but has no artwork to import: its size, colour and transparency are numbers the editor
// edits and the renderer turns into a box with a physical material. Because it is a real
// box, it can also be a rigid body, which is what makes a hanging strip curtain solid
// enough to push through.
export const PANEL_DEFAULTS = {
  width: 128, height: 192, thickness: 2,
  color: '#d7e8f2', opacity: .35, roughness: .18, metalness: .05,
};

/** Limits shared by validation and the inspector sliders. */
export const PANEL_LIMITS = {
  width: [1, 8192], height: [1, 8192], thickness: [.5, 512],
  opacity: [0, 1], roughness: [0, 1], metalness: [0, 1],
};

const COLOR = /^#[0-9a-fA-F]{6}$/;

/** A panel with the given overrides, clamped so it is always drawable. */
export function newPanel(overrides = {}) {
  const panel = { ...PANEL_DEFAULTS, ...overrides };
  for (const [key, [min, max]] of Object.entries(PANEL_LIMITS)) {
    const value = Number(panel[key]);
    panel[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : PANEL_DEFAULTS[key];
  }
  if (!COLOR.test(panel.color)) panel.color = PANEL_DEFAULTS.color;
  return panel;
}

/** Throws with a readable message when a saved panel is not drawable. */
export function validatePanel(panel) {
  if (!panel || typeof panel !== 'object' || Array.isArray(panel)) throw new Error('Panel must be an object');
  for (const [key, [min, max]] of Object.entries(PANEL_LIMITS)) {
    const value = panel[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Panel ${key} must be a number between ${min} and ${max}`);
    }
  }
  if (panel.color !== undefined && !COLOR.test(panel.color)) throw new Error('Panel color must be #rrggbb');
  return panel;
}

/** The physics box a panel-shaped object uses when it is made of matter. */
export function panelPhysics(panel, { body = 'dynamic', mass = 2 } = {}) {
  return {
    body, shape: 'box',
    width: panel.width, height: panel.height, depth: Math.max(.5, panel.thickness),
    radius: Math.max(.5, panel.width / 2), mass,
    friction: .45, restitution: 0, sensor: false, lockRotation: false,
  };
}

/**
 * The strips of a plastic curtain across `width`, laid out along the object's facing.
 * Every strip is its own object, so every strip swings on its own.
 */
export function curtainStrips({
  x = 0, y = 0, elevation = 0, angle = 0, width = 320, height = 192,
  stripWidth = 30, gap = 6, panel = {}, name = 'Curtain strip',
} = {}) {
  const pitch = stripWidth + gap;
  const count = Math.max(1, Math.min(64, Math.floor((width + gap) / pitch)));
  const span = count * pitch - gap;
  const radians = (Number(angle) || 0) * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  const strips = [];
  for (let index = 0; index < count; index++) {
    const offset = -span / 2 + stripWidth / 2 + index * pitch;
    strips.push({
      name: `${name} ${index + 1}`,
      x: Math.round(x + offset * cos),
      y: Math.round(y + offset * sin),
      elevation: Math.round(elevation),
      angle: Number(angle) || 0,
      panel: newPanel({ width: stripWidth, height, thickness: 2, ...panel }),
    });
  }
  return strips;
}
