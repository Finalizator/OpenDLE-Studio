export const HUD_CSS_PROPERTIES = ['color', 'background-color', 'border-color', 'border-width', 'border-style',
  'border-radius', 'box-shadow', 'text-shadow', 'letter-spacing', 'line-height', 'font-weight', 'font-style',
  'text-transform', 'text-decoration', 'padding', 'outline-color', 'outline-width', 'outline-style'];

export function validateHUDStyle(style, assert) {
  assert(style && typeof style === 'object' && !Array.isArray(style), 'HUD CSS style must be an object');
  assert(typeof style.name === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/.test(style.name), 'HUD CSS class name is invalid');
  assert(style.properties && typeof style.properties === 'object' && !Array.isArray(style.properties), 'HUD CSS properties must be an object');
  for (const [property, value] of Object.entries(style.properties)) {
    assert(HUD_CSS_PROPERTIES.includes(property), `Unsupported HUD CSS property: ${property}`);
    assert(typeof value === 'string' && value.length <= 300 &&
      !/[{};\\@]|url\s*\(|expression\s*\(|var\s*\(|attr\s*\(/i.test(value), `Unsafe HUD CSS value for ${property}`);
  }
}

// Restrict imported CSS to named visual classes: no page selectors, network loads or layout overrides.
export function parseHUDCSS(source) {
  if (typeof source !== 'string' || source.length > 128 * 1024) throw new Error('HUD CSS exceeds 128 KiB');
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const styles = [];
  let position = 0;
  const pattern = /\s*\.([a-zA-Z_][a-zA-Z0-9_-]{0,79})\s*\{([^{}]*)\}\s*/gy;
  while (position < clean.length && clean.slice(position).trim()) {
    pattern.lastIndex = position;
    const match = pattern.exec(clean);
    if (!match) throw new Error('HUD CSS supports only .class { visual-property: value; } rules; no @rules, URLs or compound selectors');
    position = pattern.lastIndex;
    const properties = {};
    for (const declaration of match[2].split(';')) {
      if (!declaration.trim()) continue;
      const colon = declaration.indexOf(':');
      if (colon < 0) throw new Error('Invalid HUD CSS declaration');
      const property = declaration.slice(0, colon).trim().toLowerCase(), value = declaration.slice(colon + 1).trim();
      if (!HUD_CSS_PROPERTIES.includes(property)) throw new Error(`Unsupported HUD CSS property: ${property}`);
      properties[property] = value;
    }
    const style = { name: match[1], properties };
    validateHUDStyle(style, (valid, message) => { if (!valid) throw new Error(message); });
    const existing = styles.find(item => item.name === style.name);
    if (existing) Object.assign(existing.properties, properties); else styles.push(style);
    if (styles.length > 128) throw new Error('HUD CSS supports at most 128 classes');
  }
  if (!styles.length) throw new Error('CSS file contains no supported HUD classes');
  return styles;
}
