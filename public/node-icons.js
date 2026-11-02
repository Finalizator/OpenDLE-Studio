/**
 * The little pictograms Godot draws beside every node in its scene tree.
 *
 * A type is read at a glance from the icon, not from a word: Godot shows a sun for a light, a
 * picture for a sprite, a skull for an enemy, and puts the type name in the row's tooltip. The
 * editor used to draw a letter in a coloured square, which said nothing about the node and made
 * a tree of them look like a list of codes.
 *
 * Each icon is line art on a 14×14 grid drawn in `currentColor`, so the colour comes from the
 * stylesheet per type and an icon inherits whatever theme the studio is using. Everything is
 * built with the DOM API — the studio's CSP refuses inline styles and the codebase has no
 * `innerHTML` anywhere — so nothing here can inject markup.
 */

const SVG = 'http://www.w3.org/2000/svg';

/** `d` paths and circles, per node type. Anything unknown gets the plain node square. */
const ICONS = {
  // A node: two linked joints, which is what a scene is.
  scene: { circles: [[4, 4, 1.9], [10, 10, 1.9]], paths: ['M5.4 5.4l3.2 3.2'] },
  // A sprite: a framed picture with a sun and a horizon in it.
  decoration: {
    paths: ['M2.6 3.4h8.8v7.2H2.6z', 'M2.6 9.1l2.7-2.6 2.1 2 1.4-1.3 2.6 2.4'],
    circles: [[5.2, 5.7, 1.1]],
  },
  // A monster: a skull, the same shorthand Doom itself uses.
  enemy: {
    circles: [[7, 6.1, 3.3], [5.7, 5.8, .75], [8.3, 5.8, .75]],
    paths: ['M5.5 11.9h3'],
  },
  // A pickup: a gem, because what it puts in the inventory is the point.
  pickup: { paths: ['M7 2.4l3.4 3-1.5 6.2h-3.8L3.6 5.4z', 'M4.6 5.4h4.8'] },
  // A light: a sun with rays.
  light: {
    circles: [[7, 7, 2.3]],
    paths: ['M7 3.5V2.1M7 10.5v1.4M3.5 7H2.1M10.5 7h1.4M4.6 4.6L3.6 3.6M9.4 4.6l1-1M4.6 9.4l-1 1M9.4 9.4l1 1'],
  },
  // The player start: a thing with a direction, drawn as one.
  player: { paths: ['M4.4 2.7l6.4 4.3-6.4 4.3z'] },
  // A ramp: a wedge seen from the side.
  ramp: { paths: ['M2.5 11.4h9L2.5 5.1z'] },
  // An interaction area: a volume, dashed because it is not solid.
  zone: { paths: ['M2.6 3.4h8.8v7.2H2.6z'], dashed: true },
};

const FALLBACK = { paths: ['M3.4 3.4h7.2v7.2H3.4z'] };

function shape(tag, attributes) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

/**
 * The icon for one node type, as a `span.node-icon` holding an SVG.
 *
 * Returns a fresh element every call: the tree is rebuilt on every edit, so a shared node would
 * be moved from row to row instead of copied.
 */
export function nodeIcon(type) {
  const span = document.createElement('span');
  span.className = `node-icon node-icon-${type || 'node'}`;
  span.setAttribute('aria-hidden', 'true');
  const icon = ICONS[type] || FALLBACK;
  const svg = shape('svg', { viewBox: '0 0 14 14', width: '14', height: '14', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  for (const d of icon.paths || []) svg.append(shape('path', { d, ...(icon.dashed ? { 'stroke-dasharray': '2 1.6' } : {}) }));
  for (const [cx, cy, r] of icon.circles || []) svg.append(shape('circle', { cx, cy, r }));
  span.append(svg);
  return span;
}
