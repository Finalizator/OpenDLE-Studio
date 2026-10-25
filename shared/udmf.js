const limits = { vertex: 20000, linedef: 20000, sidedef: 40000, sector: 20000, thing: 5000 };
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);

export function parseUDMF(text) {
  if (typeof text !== 'string' || text.length > 16 * 1024 * 1024) throw new Error('UDMF TEXTMAP exceeds 16 MiB');
  let position = 0, tokens = 0;
  const globals = {}, blocks = [], counts = {};
  const fail = message => { throw new Error(`UDMF at character ${position}: ${message}`); };
  function next() {
    while (position < text.length) {
      const rest = text.slice(position);
      const whitespace = /^\s+/.exec(rest);
      if (whitespace) { position += whitespace[0].length; continue; }
      if (rest.startsWith('//')) {
        const end = text.indexOf('\n', position + 2); position = end < 0 ? text.length : end + 1; continue;
      }
      if (rest.startsWith('/*')) {
        const end = text.indexOf('*/', position + 2);
        if (end < 0) fail('Unterminated comment');
        position = end + 2; continue;
      }
      break;
    }
    if (++tokens > 2000000) fail('Token budget exceeded');
    if (position === text.length) return { type: 'end' };
    const char = text[position];
    if ('{}=;'.includes(char)) { position++; return { type: char }; }
    if (char === '"') {
      position++;
      let value = '';
      while (position < text.length) {
        const char = text[position++];
        if (char === '"') return { type: 'value', value };
        if (char === '\\') {
          if (position === text.length) fail('Unterminated string escape');
          const escaped = text[position++];
          value += ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' })[escaped] ?? `\\${escaped}`;
        } else value += char;
        if (value.length > 65536) fail('String exceeds 65536 characters');
      }
      fail('Unterminated string');
    }
    const rest = text.slice(position);
    const number = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
    if (number) {
      position += number[0].length;
      const sign = number[0].startsWith('-') ? -1 : 1;
      const unsigned = number[0].replace(/^[+-]/, '');
      const value = /^0x/i.test(unsigned) ? sign * Number.parseInt(unsigned.slice(2), 16) : Number(number[0]);
      if (!Number.isFinite(value)) fail('Non-finite number');
      return { type: 'value', value };
    }
    const identifier = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(rest);
    if (!identifier) fail(`Unexpected character ${JSON.stringify(char)}`);
    position += identifier[0].length;
    const value = identifier[0].toLowerCase();
    if (value === 'true' || value === 'false') return { type: 'value', value: value === 'true' };
    if (unsafe.has(value)) fail('Reserved property name');
    return { type: 'identifier', value };
  }
  function expect(type) {
    const token = next();
    if (token.type !== type) fail(`Expected ${type}, found ${token.type}`);
    return token;
  }
  function assignment(object, name) {
    expect('=');
    object[name] = expect('value').value;
    expect(';');
  }
  while (true) {
    const token = next();
    if (token.type === 'end') break;
    if (token.type !== 'identifier') fail('Expected a property or block name');
    const following = next();
    if (following.type === '=') {
      globals[token.value] = expect('value').value; expect(';'); continue;
    }
    if (following.type !== '{') fail('Expected assignment or block');
    const type = token.value;
    counts[type] = (counts[type] || 0) + 1;
    if (counts[type] > (limits[type] || 1000) || blocks.length >= 105000) fail(`${type} exceeds geometry/block limits`);
    const properties = {};
    let fields = 0;
    while (true) {
      const key = next();
      if (key.type === '}') break;
      if (key.type !== 'identifier') fail('Expected block property');
      if (++fields > 256) fail('Block property limit exceeded');
      assignment(properties, key.value);
    }
    blocks.push({ type, properties });
  }
  if (typeof globals.namespace !== 'string' || !globals.namespace.length) fail('Missing namespace');
  const namespace = globals.namespace.toLowerCase();
  if (!['doom', 'zdoom', 'zdoomtranslated', 'hexen', 'heretic', 'strife'].includes(namespace)) fail(`Unknown namespace ${namespace}`);
  return { namespace, globals, blocks };
}

export function udmfRecords(document) {
  const byType = type => document.blocks.filter(block => block.type === type).map(block => block.properties);
  function number(p, key, fallback, { integer = false, min = -65536, max = 65536 } = {}) {
    const value = p[key] ?? fallback;
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`UDMF ${key} has invalid numeric value`);
    return value;
  }
  function bool(p, key, fallback = false) {
    const value = p[key] ?? fallback;
    if (typeof value !== 'boolean') throw new Error(`UDMF ${key} must be boolean`);
    return value;
  }
  function texture(p, key) {
    const value = p[key] ?? '-';
    if (typeof value !== 'string' || !value.length || value.length > 256) throw new Error(`UDMF ${key} must be a texture name`);
    return value.toUpperCase();
  }
  const index = (p, key, fallback) => number(p, key, fallback, { integer: true, min: -1 });
  return {
    vertices: byType('vertex').map(p => ({ x: number(p, 'x'), y: number(p, 'y') })),
    sectors: byType('sector').map(p => ({
      floorHeight: number(p, 'heightfloor', 0, { min: -32768, max: 32767 }),
      ceilingHeight: number(p, 'heightceiling', 0, { min: -32768, max: 32767 }),
      floor: texture(p, 'texturefloor'), ceiling: texture(p, 'textureceiling'),
      light: number(p, 'lightlevel', 160, { integer: true }),
      special: number(p, 'special', 0, { integer: true, min: 0 }), tag: number(p, 'id', 0, { integer: true, min: 0 }),
    })),
    sides: byType('sidedef').map(p => ({ sector: index(p, 'sector'),
      offsetX: number(p, 'offsetx', 0), offsetY: number(p, 'offsety', 0),
      upper: texture(p, 'texturetop'), lower: texture(p, 'texturebottom'), middle: texture(p, 'texturemiddle') })),
    lines: byType('linedef').map(p => ({ a: index(p, 'v1'), b: index(p, 'v2'), right: index(p, 'sidefront', -1), left: index(p, 'sideback', -1),
      special: number(p, 'special', 0, { integer: true, min: 0, max: 65535 }),
      tag: number(p, 'id', 0, { integer: true, min: 0, max: 65535 }),
      args: Array.from({ length: 5 }, (_, i) => number(p, `arg${i}`, 0, { integer: true, min: -32768, max: 32767 })),
      activationModes: [['playercross', 'cross'], ['playeruse', 'use'], ['playeruseback', 'use'], ['impact', 'shoot']]
        .filter(([key]) => bool(p, key)).map(([, mode]) => mode),
      flags: (bool(p, 'blocking') || bool(p, 'blockplayers') || bool(p, 'blockeverything') ? 1 : 0) |
        (bool(p, 'dontpegtop') ? 8 : 0) | (bool(p, 'dontpegbottom') ? 16 : 0) })),
    things: byType('thing').map(p => ({
      x: number(p, 'x'), y: number(p, 'y'), angle: number(p, 'angle', 0, { min: -3600, max: 3600 }),
      elevation: number(p, 'height', 0, { min: -32768, max: 32767 }), type: number(p, 'type', 0, { integer: true, min: 0, max: 65535 }),
      flags: (bool(p, 'skill1') || bool(p, 'skill2') ? 1 : 0) | (bool(p, 'skill3') ? 2 : 0) |
        (bool(p, 'skill4') || bool(p, 'skill5') ? 4 : 0) | (bool(p, 'ambush', false) ? 8 : 0) | (bool(p, 'single') ? 0 : 16),
    })),
  };
}
