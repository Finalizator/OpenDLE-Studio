/**
 * DECORATE reader.
 *
 * Imported games describe their actors with DECORATE (and ZScript, which shares
 * the head/keyword syntax). Instead of emulating a fixed Doom bestiary, the
 * importer parses those definitions into editable native actor data so a mod's
 * monsters, weapons and props behave the way their author wrote them.
 *
 * This module is deliberately pure: it turns text into a definition tree and
 * never touches the project, the filesystem or the runtime.
 */

// DECORATE keywords that are shorthand for a group of actor flags.
const FLAG_COMBOS = new Set(['monster', 'projectile', 'weapon', 'inventory', 'custominventory', 'powerup',
  'powerupgiver', 'health', 'ammo', 'key', 'armor', 'puzzleitem', 'playerpawn', 'switchableDecoration',
  'explosivebarrel', 'spawnshot', 'casing']);

// Words that start a definition rather than a property line inside an actor.
const BLOCK_WORDS = new Set(['states', 'state', 'actor', 'class', 'default', 'const', 'enum', 'struct', 'version',
  'extend', 'mixin', 'flagdef', 'include', 'define']);

export function tokenizeDecorate(text) {
  const tokens = [];
  let line = 1, column = 1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '\n') { tokens.push({ kind: 'newline', value: '\n', line, column }); line++; column = 1; continue; }
    if (char === ' ' || char === '\t' || char === '\r') { column++; continue; }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      index--; continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) { if (text[index] === '\n') line++; index++; }
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char; let value = ''; const startColumn = column;
      index++;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\' && index + 1 < text.length) {
          const escape = text[index + 1];
          value += escape === 'n' ? '\n' : escape === 't' ? '\t' : escape;
          index += 2; column += 2; continue;
        }
        if (text[index] === '\n') break;
        value += text[index]; index++; column++;
      }
      tokens.push({ kind: 'string', value, line, column: startColumn });
      column++;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(text[index + 1] || '')) ||
      (char === '.' && /[0-9]/.test(text[index + 1] || '')) ||
      (char === '-' && text[index + 1] === '.' && /[0-9]/.test(text[index + 2] || ''))) {
      let value = char; index++;
      while (index < text.length && /[0-9a-fA-FxX._]/.test(text[index])) { value += text[index]; index++; }
      index--;
      tokens.push({ kind: 'number', value, line, column });
      column += value.length;
      continue;
    }
    if (/[A-Za-z_$@#]/.test(char)) {
      let value = char; index++;
      while (index < text.length && /[A-Za-z0-9_$@#:.]/.test(text[index])) {
        // `Label:` must not swallow the colon that ends a state label.
        if (text[index] === ':' && !/[A-Za-z0-9_$]./.test(text[index - 1] + (text[index + 1] || ''))) break;
        value += text[index]; index++;
      }
      index--;
      tokens.push({ kind: 'word', value, line, column });
      column += value.length;
      continue;
    }
    tokens.push({ kind: 'punct', value: char, line, column });
    column++;
  }
  return tokens;
}

/**
 * Splits a token stream into logical lines. State frames are line-oriented, so
 * the parser keeps the raw line grouping instead of flattening everything.
 */
function toLines(tokens) {
  const lines = [];
  let current = [];
  for (const token of tokens) {
    if (token.kind === 'newline') { lines.push(current); current = []; continue; }
    current.push(token);
  }
  lines.push(current);
  return lines;
}

function unquote(token) {
  if (!token) return null;
  if (token.kind === 'string') return token.value;
  if (token.kind === 'number' || token.kind === 'word') return token.value;
  return null;
}

/** Reads a value list such as `"A:B", 4` or `16` up to the end of the line. */
function readValues(line, start) {
  const values = [];
  for (let index = start; index < line.length; index++) {
    const token = line[index];
    if (token.kind === 'punct' && (token.value === ',' || token.value === '(' || token.value === ')')) continue;
    if (token.kind === 'punct' && token.value === '{') break;
    const value = unquote(token);
    if (value !== null) values.push(value);
  }
  return values;
}

function numeric(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value);
  if (/^-?0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(text)) return Number(text);
  return fallback;
}

/**
 * Parses one DECORATE (or ZScript `class`) actor head:
 *   actor NAME : PARENT 1234
 *   actor NAME replaces OTHER
 *   ACTOR NAME 1234
 */
function parseHead(line, index) {
  const keyword = line[index].value.toLowerCase();
  let cursor = index + 1;
  const name = line[cursor]?.value;
  if (!name || (line[cursor].kind !== 'word')) return null;
  cursor++;
  let parent = null, replaces = null, doomedNum = null;
  for (; cursor < line.length; cursor++) {
    const token = line[cursor];
    if (token.kind === 'punct' && token.value === ':') {
      parent = line[cursor + 1]?.value || null;
      cursor++;
      continue;
    }
    if (token.kind === 'word' && token.value.toLowerCase() === 'replaces') {
      replaces = line[cursor + 1]?.value || null;
      cursor++;
      continue;
    }
    if (token.kind === 'number') {
      const value = numeric(token.value);
      if (value !== null) doomedNum = value;
    }
  }
  return { keyword, name, parent, replaces, doomedNum };
}

/**
 * Parses a state action call. Named arguments (`A_LookEx(fov: 360)`) and plain
 * positional arguments both appear in real mods, and strings may contain the
 * characters that would otherwise split the call.
 */
function parseAction(line, start, source) {
  const tokens = line.slice(start);
  const nameToken = tokens[0];
  if (!nameToken || !/^A_|^ACS_|^[A-Za-z_][\w]*$/.test(nameToken.value)) return null;
  let cursor = 1;
  const args = [];
  const named = {};
  if (tokens[cursor]?.value === '(') {
    cursor++;
    let current = [];
    let depth = 0;
    let partIndex = 0;
    const flush = () => {
      if (!current.length) return;
      const keyToken = current[0];
      if (current[1]?.value === ':' && keyToken.kind === 'word' && current.length > 2) {
        named[keyToken.value] = actionValue(current.slice(2));
      } else {
        // Every argument is kept, including a bare number: `A_Jump(128, "Missile")`
        // used to lose the 128 because only word/string arguments were stored, which
        // turned a 50% chance into an unconditional jump and made every imported
        // monster take its first attack branch every time.
        const value = actionValue(current);
        if (value !== undefined) args[partIndex] = value;
      }
      partIndex++;
      current = [];
    };
    for (; cursor < tokens.length; cursor++) {
      const token = tokens[cursor];
      if (token.value === '(') { depth++; current.push(token); continue; }
      if (token.value === ')') {
        if (depth === 0) { flush(); break; }
        depth--; current.push(token); continue;
      }
      if (token.value === ',' && depth === 0) { flush(); continue; }
      current.push(token);
    }
  }
  return { name: nameToken.value, args, named, line: nameToken.line, source };
}

/** Converts a token slice into a JS value (number, string, flag name or raw text). */
function actionValue(tokens) {
  const cleaned = tokens.filter(token => !(token.kind === 'punct' && (token.value === '(' || token.value === ')')));
  if (!cleaned.length) return undefined;
  if (cleaned.length === 1) {
    const token = cleaned[0];
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') {
      const value = numeric(token.value);
      return value === null ? token.value : value;
    }
    if (token.kind === 'word') {
      if (/^(true|false)$/i.test(token.value)) return token.value.toLowerCase() === 'true';
      if (token.value === 'null' || token.value === 'NULL') return null;
      return token.value;
    }
  }
  // Complex expressions (ZScript arguments) are kept as source text for the
  // caller to interpret or report.
  return cleaned.map(token => token.kind === 'string' ? `"${token.value}"` : token.value).join('');
}

function readWordRun(line, start) {
  const words = [];
  for (let index = start; index < line.length; index++) {
    if (line[index].kind === 'punct' && line[index].value === '{') break;
    if (line[index].kind === 'word' || line[index].kind === 'number') words.push(line[index].value);
  }
  return words;
}

const STATE_END = { type: 'end' };

/**
 * Parses a `States { ... }` section: `Label:` lines introduce frame sequences,
 * and `goto`/`loop`/`stop`/`wait` terminate them.
 */
function parseStates(lines, start, { zscript = false } = {}) {
  let index = start + 1;
  const states = [];
  let current = null;
  let pendingBlock = null;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.length) { index++; continue; }
    const first = line[0];
    if (first.kind === 'punct' && first.value === '}') break;
    // ZScript frame bodies span multiple lines and were captured while reading.
    if (pendingBlock) {
      const closing = line.findIndex(token => token.kind === 'punct' && token.value === '}');
      if (closing < 0) { pendingBlock.tokens.push(...line); index++; continue; }
      pendingBlock.tokens.push(...line.slice(0, closing));
      states.at(-1).frames.at(-1).body = {
        source: pendingBlock.tokens.map(token => token.kind === 'string' ? `"${token.value}"` : token.value).join(' '),
        line: pendingBlock.line,
      };
      pendingBlock = null;
      // A `}` closing the frame body can also be followed by the states `}`.
      if (line.slice(closing + 1).some(token => token.kind === 'punct' && token.value === '}')) break;
      index++; continue;
    }
    if (first.kind === 'word' && line[1]?.kind === 'punct' && line[1].value === ':') {
      current = { label: first.value, frames: [], line: first.line };
      states.push(current);
      index++; continue;
    }
    if (!current) { index++; continue; }
    const keyword = first.value.toLowerCase();
    if (keyword === 'goto' || keyword === 'loop' || keyword === 'stop' || keyword === 'wait' || keyword === 'fail') {
      current.frames.push({ type: 'keyword', keyword, target: readWordRun(line, 1)[0] || null, line: first.line });
      index++; continue;
    }
    // Sprite frames: SPRT AABB 4 [flags/action] or # / - continuation forms.
    const sprite = first.value;
    const letters = line[1]?.value;
    if (sprite === undefined || letters === undefined) { index++; continue; }
    if (!/^[A-Z0-9_#\-]{4}$/i.test(sprite) || !/^[A-Za-z#\-]+$/.test(letters)) { index++; continue; }
    const durationToken = line[2];
    const duration = durationToken?.kind === 'number' ? numeric(durationToken.value, 0) : 0;
    const flags = []; let action = null;
    let cursor = 3;
    if (durationToken && durationToken.kind === 'word') cursor = 2;
    for (; cursor < line.length; cursor++) {
      const token = line[cursor];
      if (token.kind === 'punct' && token.value === '{') {
        pendingBlock = { tokens: [], line: token.line };
        break;
      }
      if (token.kind === 'word') {
        const lower = token.value.toLowerCase();
        if (['bright', 'fast', 'slow', 'nodelay', 'canraise'].includes(lower)) { flags.push(lower); continue; }
        if (/^(A_|ACS_)/.test(token.value) || /^[A-Za-z_]\w*$/.test(token.value) && line[cursor + 1]?.value === '(') {
          action = parseAction(line, cursor, null);
          break;
        }
        flags.push(lower);
      }
    }
    current.frames.push({ type: 'frame', sprite, letters, duration, flags, action, line: first.line });
    index++;
  }
  return { states, index };
}

/** Parses one actor block body into properties, flags and states. */
function parseActorBody(lines, start, head, sourceName) {
  const properties = {};
  const flags = {};
  const stateBlocks = [];
  let index = start;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (!line.length) continue;
    const first = line[0];
    if (first.kind === 'punct' && first.value === '}') return { properties, flags, stateBlocks, index };
    const keyword = first.kind === 'word' ? first.value.toLowerCase() : '';
    if (keyword === 'states' || keyword === 'state') {
      // The opening brace may sit on its own line (`States` then `{`), which is
      // how almost every real mod writes it.
      let brace = index;
      while (brace < lines.length && !lines[brace].some(token => token.kind === 'punct' && token.value === '{')) {
        if (lines[brace].some(token => token.kind === 'punct' && token.value === '}')) break;
        brace++;
      }
      if (brace < lines.length && lines[brace].some(token => token.kind === 'punct' && token.value === '{')) {
        const parsed = parseStates(lines, brace);
        stateBlocks.push(...parsed.states);
        index = parsed.index;
        continue;
      }
    }
    if (first.kind === 'punct' && (first.value === '+' || first.value === '-')) {
      const name = line[1]?.value;
      if (name) flags[name.replace(/^[+-]/, '')] = first.value === '+';
      continue;
    }
    if (keyword === 'if' || keyword === 'else' || keyword === 'override' || keyword === 'virtual' ||
      keyword === 'protected' || keyword === 'private' || keyword === 'readonly' || keyword === 'static' ||
      keyword === 'action' || keyword === 'native' || keyword === 'transient' || keyword === 'deprecated') {
      // ZScript decorations/clauses on properties; the following line carries the value.
      const rest = readValues(line, 1);
      if (rest.length >= 2) properties[rest[0]] = rest.length === 2 ? rest[1] : rest.slice(1);
      continue;
    }
    if (line.some(token => token.kind === 'punct' && token.value === '{')) {
      // Nested named blocks (Default/States in ZScript, or a property list).
      continue;
    }
    if (line.length === 1 && first.kind === 'word') {
      // Bare keyword such as `Monster` or `Projectile`.
      properties[first.value] = true;
      continue;
    }
    const key = first.value;
    if (!/^[A-Za-z_][\w.]*$/.test(key)) continue;
    const values = readValues(line, 1);
    if (!values.length) { properties[key] = true; continue; }
    const scalar = values.length === 1 ? values[0] : null;
    if (scalar !== null) {
      const number = numeric(scalar);
      properties[key] = number !== null && /^-?[0-9]/.test(String(scalar)) ? number : scalar;
    } else properties[key] = values;
  }
  return { properties, flags, stateBlocks, index };
}

/**
 * Parses DECORATE text.
 * @returns {{actors: object[], includes: string[], warnings: string[]}}
 */
export function parseDecorate(text, { source = 'DECORATE' } = {}) {
  const lines = toLines(tokenizeDecorate(text));
  const actors = [], includes = [], warnings = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.length) continue;
    const first = line[0];
    if (first.kind !== 'word') continue;
    const keyword = first.value.toLowerCase();
    if (keyword === 'include' || keyword === '#include') {
      const target = line[1]?.value || line[1]?.value;
      if (target) includes.push(target.replace(/^["']|["']$/g, ''));
      continue;
    }
    if (keyword === 'actor') {
      // A new actor starts here, so an unterminated previous block ends.
      const head = parseHead(line, 0);
      if (!head) { warnings.push(`${source}:${first.line}: unreadable actor declaration`); continue; }
      const body = parseActorBody(lines, index + 1, head, source);
      index = body.index;
      actors.push({
        name: head.name, parent: head.parent, replaces: head.replaces, doomedNum: head.doomedNum,
        properties: body.properties, flags: body.flags, states: body.stateBlocks,
        source, line: first.line, language: 'decorate',
      });
      continue;
    }
    if (keyword === 'clearactors' || keyword === 'clearmapthings') {
      actors.push({ name: `#${keyword}`, command: keyword, source, line: first.line, language: 'decorate' });
    }
  }
  return { actors, includes, warnings };
}

/**
 * Applies DECORATE's inheritance model. Properties and flags merge down the
 * chain; state blocks concatenate so later `States` blocks add labels, and a
 * redefined label replaces the inherited one (matching GZDoom).
 */
export function resolveActorInheritance(definitions) {
  const byName = new Map();
  const warnings = [];
  for (const definition of definitions) {
    if (definition.command) continue;
    if (byName.has(definition.name)) {
      // Later definitions win, which is how loading a second PK3 overrides a mod.
      const previous = byName.get(definition.name);
      if (previous.replaces && !definition.replaces) definition.replaces = previous.replaces;
      if (previous.doomedNum !== null && definition.doomedNum === null) definition.doomedNum = previous.doomedNum;
    }
    byName.set(definition.name, definition);
  }
  const resolving = new Set(), resolved = new Map();
  // DECORATE and ZScript class names are case-insensitive, and mods mix casing
  // (`ACTOR FURFireBall` parented by `FURFireball2`), so lookup ignores case.
  const folded = new Map();
  for (const name of byName.keys()) {
    const key = name.toLowerCase();
    if (!folded.has(key)) folded.set(key, name);
  }
  function resolve(name) {
    if (resolved.has(name)) return resolved.get(name);
    const definition = byName.get(name) || byName.get(folded.get(String(name || '').toLowerCase()));
    if (definition && !byName.has(name)) name = definition.name;
    if (!definition) return null;
    if (resolving.has(name)) { warnings.push(`Circular actor inheritance at ${name}`); return null; }
    resolving.add(name);
    const parent = definition.parent ? resolve(definition.parent) : null;
    const result = {
      name,
      parent: definition.parent || null,
      doomedNum: definition.doomedNum ?? null,
      replaces: definition.replaces || null,
      properties: { ...(parent?.properties || {}), ...definition.properties },
      flags: { ...(parent?.flags || {}), ...definition.flags },
      labels: new Map(parent ? [...parent.labels] : []),
      ownLabels: new Set(definition.states.map(state => state.label)),
      source: definition.source,
      line: definition.line,
      language: definition.language,
    };
    for (const state of definition.states) {
      result.labels.set(state.label, state.frames.map(frame => ({ ...frame })));
    }
    // Flag combos expand into the individual flags they imply.
    for (const [key, value] of Object.entries(result.properties)) {
      if (FLAG_COMBOS.has(key.toLowerCase()) && value === true) {
        result.flags[key] = true;
      }
    }
    resolving.delete(name);
    resolved.set(name, result);
    return result;
  }
  for (const name of byName.keys()) resolve(name);
  return { actors: resolved, warnings, byName };
}

const COMMON_ALIASES = {
  spawn: ['spawn'], see: ['see'], melee: ['melee'], missile: ['missile'], pain: ['pain'],
  death: ['death'], xdeath: ['xdeath'], burn: ['burn'], raise: ['raise'], crash: ['crash'],
  ready: ['ready'], select: ['select'], deselect: ['deselect'], fire: ['fire'], flash: ['flash'],
  altfire: ['altfire'], altflash: ['altflash'], hold: ['hold'], reload: ['reload'], zoom: ['zoom'],
  user1: ['user1'], user2: ['user2'], user3: ['user3'], user4: ['user4'],
};
export const STANDARD_LABELS = [...new Set(Object.values(COMMON_ALIASES).flat())];

/**
 * Builds the linear frame list an actor actually executes. GZDoom flattens the
 * state blocks in declaration order and resolves `goto`/`loop`/`A_Jump` against
 * that list, so the runtime can work with plain indexes.
 */
export function compileActorStates(actor, { parentLookup = () => null } = {}) {
  const frames = [];
  const labels = new Map();
  const source = actor.labels instanceof Map ? actor.labels : new Map(Object.entries(actor.labels || {}));
  // `SPRT AABB 4 A_Chase` is shorthand for four states that all share the
  // duration and action, so every letter becomes its own executable frame and
  // `goto Label+2` / `A_Jump(256, 1)` count them individually.
  let lastSprite = null, lastLetter = null;
  for (const [label, entries] of source) {
    if (labels.has(label)) continue;
    labels.set(label, frames.length);
    for (const frame of entries) {
      if (frame.type === 'frame') {
        const sprite = frame.sprite === '#' || frame.sprite === '-' ? lastSprite : frame.sprite;
        if (sprite) lastSprite = sprite;
        for (const rawLetter of String(frame.letters || '')) {
          const letter = rawLetter === '#' || rawLetter === '-' ? lastLetter : rawLetter;
          if (!letter) continue;
          lastLetter = letter;
          frames.push({ kind: 'frame', sprite: sprite || lastSprite, letter, duration: frame.duration,
            flags: frame.flags || [], action: frame.action || null, body: frame.body || null, label, line: frame.line });
        }
        continue;
      }
      if (frame.type === 'end') { frames.push({ kind: 'stop', label, line: frame.line }); continue; }
      // Unrecognised statements (stray braces, comments) carry no executable
      // meaning, so they are not part of the compiled machine.
      if (!frame.keyword) continue;
      frames.push({ kind: frame.keyword, target: frame.target || null, label, line: frame.line });
    }
  }
  // Resolve keysword targets to frame indexes.
  const resolveLabel = (target, from) => {
    if (!target) return frames.length;
    const clean = String(target).trim();
    const base = clean.replace(/[+-]\d+$/, '');
    const offset = Number(clean.slice(base.length)) || 0;
    if (base.toLowerCase() === 'super') {
      const parent = parentLookup(actor?.parent);
      if (!parent) return null;
      const parentIndex = parent.labels?.get(from)?.index ?? null;
      return parentIndex === null || parentIndex === undefined ? null : parentIndex + offset;
    }
    if (!labels.has(base)) {
      // Case-insensitive fallback: DECORATE label matching is case sensitive but
      // many mods mix casing across files.
      const found = [...labels.keys()].find(key => key.toLowerCase() === base.toLowerCase());
      return found ? labels.get(found) + offset : null;
    }
    return labels.get(base) + offset;
  };
  frames.forEach((frame, index) => {
    if (frame.kind === 'goto' || frame.kind === 'loop') {
      const target = frame.kind === 'loop' ? frame.label : frame.target;
      const resolved = resolveLabel(target, frame.label);
      frame.targetIndex = resolved === null ? index : resolved;
      if (frame.kind === 'loop') frame.targetIndex = labels.get(frame.label) ?? index;
    } else if (frame.kind === 'wait') frame.targetIndex = index;
  });
  return { frames, labels, resolveLabel };
}

/**
 * Splits an inline frame body (`{ A_StartSound("x"); A_FireBullets(...); }`) into
 * the action calls it performs. Simple bodies made only of action calls run
 * directly; anything else (locals, `return`, control flow) is reported so the
 * importer can warn instead of silently behaving differently from GZDoom.
 */
export function frameBodyActions(body) {
  if (!body?.source) return { actions: [], unsupported: null };
  const statements = [];
  let current = '', depth = 0, quote = null;
  for (const char of body.source) {
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ';' && depth === 0) { if (current.trim()) statements.push(current.trim()); current = ''; continue; }
    if (char === '\n' && depth === 0) { if (current.trim()) statements.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  const actions = [];
  for (const statement of statements) {
    const call = /^([A-Za-z_]\w*)\s*(?:\(([\s\S]*)\))?$/.exec(statement);
    if (!call || !/^A_|^ACS_/.test(call[1])) return { actions: [], unsupported: statement.slice(0, 120) };
    const args = []; const named = {};
    if (call[2] !== undefined) {
      let part = '', level = 0, innerQuote = null;
      const parts = [];
      for (const char of call[2]) {
        if (innerQuote) { part += char; if (char === innerQuote) innerQuote = null; continue; }
        if (char === '"' || char === "'") { innerQuote = char; part += char; continue; }
        if (char === '(' || char === '[') level++;
        if (char === ')' || char === ']') level--;
        if (char === ',' && level === 0) { parts.push(part.trim()); part = ''; continue; }
        part += char;
      }
      if (part.trim()) parts.push(part.trim());
      for (const item of parts) {
        const labelled = /^([a-z_]\w*)\s*:\s*([\s\S]+)$/i.exec(item);
        if (labelled) {
          const raw = labelled[2].trim();
          const numeric = Number(raw);
          named[labelled[1]] = Number.isFinite(numeric) && raw !== '' && /^-?[0-9.]+$/.test(raw) ? numeric
            : raw.startsWith('"') ? raw.slice(1, -1) : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === 'true' : raw;
          continue;
        }
        const number = Number(item);
        args.push(Number.isFinite(number) && item !== '' ? number
          : item.startsWith('"') ? item.slice(1, -1) : /^(true|false)$/i.test(item) ? item.toLowerCase() === 'true'
          : item === 'null' ? null : item);
      }
    }
    actions.push({ name: call[1], args, named, source: 'zscript' });
  }
  return { actions, unsupported: null };
}

/** Collects the sprite prefixes an actor references, for asset resolution. */
export function actorSpritePrefixes(actor) {
  const prefixes = new Set();
  for (const frames of actor.labels.values()) {
    for (const frame of frames) {
      if (frame.type !== 'frame') continue;
      if (frame.sprite && /^[A-Za-z0-9_]{4}$/.test(frame.sprite)) prefixes.add(frame.sprite.toUpperCase());
    }
  }
  return [...prefixes];
}

/** Maps a Doom doomednum to the actor that defines it (last definition wins). */
export function actorByDoomedNum(actors) {
  const map = new Map();
  for (const actor of actors.values()) if (actor.doomedNum !== null && actor.doomedNum !== undefined) map.set(actor.doomedNum, actor);
  return map;
}

/** Resolves `replaces` chains: a mod actor takes over the class it replaces. */
export function replacementMap(actors) {
  const map = new Map();
  for (const actor of actors.values()) if (actor.replaces) map.set(actor.replaces.toLowerCase(), actor);
  return map;
}
