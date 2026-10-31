import { parseDecorate, resolveActorInheritance } from './decorate.js';

/**
 * ZScript reader.
 *
 * ZScript is a full C-like language; emulating it is out of scope and would be a
 * second engine. What imported games actually use it for, though, is narrow:
 * declaring actors (`class Foo : Bar`), setting `Default` properties, writing
 * `States`, and small `override` helpers. This module extracts exactly that
 * declarative part, and keeps function bodies as source so the runtime can run
 * the handful of shapes that matter (tick overrides, custom damage helpers) or
 * report a precise limitation instead of silently misbehaving.
 */

function stripComments(text) {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      result += '\n';
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) { if (text[index] === '\n') result += '\n'; index++; }
      index++;
      continue;
    }
    if (char === '"') {
      result += char;
      index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') { result += text[index]; index++; }
        result += text[index]; index++;
      }
      result += '"';
      continue;
    }
    result += char;
  }
  return result;
}

/** Finds the brace that closes the block opened at `open`, skipping strings. */
function matchBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      index++;
      while (index < text.length && text[index] !== '"') { if (text[index] === '\\') index++; index++; }
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') { depth--; if (depth === 0) return index; }
  }
  return -1;
}

function splitStatements(body) {
  const statements = [];
  let current = '', depth = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '"') {
      current += char; index++;
      while (index < body.length && body[index] !== '"') { if (body[index] === '\\') { current += body[index]; index++; } current += body[index]; index++; }
      current += '"';
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (char === ';' && depth === 0) { statements.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function parseValue(text) {
  const value = text.trim();
  if (!value) return true;
  if (/^".*"$/s.test(value)) return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (/^-?0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(value)) return Number(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (value === 'null' || value === 'NULL') return null;
  return value;
}

/**
 * `Default { Radius 16; Health 100; +MONSTER }` becomes a property/flag record
 * that matches the DECORATE shape, so both languages share one resolver.
 */
function parseDefaults(body) {
  const properties = {}, flags = {};
  for (const statement of splitStatements(body)) {
    // Statements are separated by `;`, but flags such as `+FLOORCLIP` have none,
    // so a statement may still contain several newline-separated entries.
    for (const entry of statement.split('\n').map(line => line.trim()).filter(Boolean)) {
      parseDefaultEntry(entry, properties, flags);
    }
  }
  return { properties, flags };
}

function parseDefaultEntry(statement, properties, flags) {
  {
    const flag = /^([+-])\s*([A-Za-z_][\w.]*)\s*$/.exec(statement);
    if (flag) { flags[flag[2]] = flag[1] === '+'; return; }
    const assignment = /^([A-Za-z_][\w.]*)\s*=\s*([\s\S]*)$/.exec(statement);
    if (assignment) { properties[assignment[1]] = parseValue(assignment[2]); return; }
    const parts = statement.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
    if (!parts.length) return;
    const key = parts[0];
    const values = parts.slice(1).map(part => parseValue(part));
    if (!values.length) { properties[key] = true; return; }
    properties[key] = values.length === 1 ? values[0] : values;
  }
}

// A label may share its line with the first frame: `Ready: SHTG A 1 A_WeaponReady;`.
const STATE_LABEL = /^([A-Za-z_]\w*)\s*:/;

/**
 * Parses `States { Spawn: FRAM A 4 A_Look; ... }`.
 *
 * Labels are line-based (they are not terminated by `;`), frames are `;`
 * separated, and ZScript frames may carry a `{ }` action body that can span
 * lines. The body is preserved as source for the runtime to interpret or to
 * report precisely.
 */
function parseStates(body) {
  const labels = [];
  let current = null;
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].trim();
    while (line) {
      if (!line) break;
      const label = STATE_LABEL.exec(line);
      if (label) {
        current = { label: label[1], frames: [] };
        labels.push(current);
        // `Ready: SHTG A 1 A_WeaponReady;` puts the first frame on the label line.
        line = line.slice(label[0].length).trim();
        if (!line) break;
        continue;
      }
      const keyword = /^(loop|stop|wait|fail)\s*;?$/i.exec(line);
      if (keyword) {
        if (current) current.frames.push({ type: 'keyword', keyword: keyword[1].toLowerCase(), target: null });
        line = '';
        break;
      }
      const goto = /^goto\s+([\w.#+-]+)\s*;?$/i.exec(line);
      if (goto) {
        if (current) current.frames.push({ type: 'keyword', keyword: 'goto', target: goto[1] });
        line = '';
        break;
      }
      const frame = /^([A-Za-z0-9_#-]{1,5})\s+([A-Za-z#-]+)\s+(-?[0-9.]+)/.exec(line);
      if (!frame) { line = ''; break; }
      let rest = line.slice(frame[0].length);
      // A frame body may open here and continue on following lines.
      let source = null;
      if (rest.includes('{')) {
        const collected = [rest.slice(rest.indexOf('{') + 1)];
        let resolved = false;
        const firstClose = collected[0].indexOf('}');
        if (firstClose >= 0) { source = collected[0].slice(0, firstClose).trim(); rest = collected[0].slice(firstClose + 1); resolved = true; }
        while (!resolved && index + 1 < lines.length) {
          index++;
          const next = lines[index];
          const close = next.indexOf('}');
          if (close >= 0) { collected.push(next.slice(0, close)); source = collected.join('\n').trim(); rest = next.slice(close + 1).trim(); resolved = true; break; }
          collected.push(next);
        }
        if (!resolved) { source = collected.join('\n').trim(); rest = ''; }
      }
      const entry = { type: 'frame', sprite: frame[1].toUpperCase(), letters: frame[2],
        duration: Number(frame[3]), flags: [], action: null };
      if (source !== null) entry.body = { source };
      if (current) current.frames.push(entry);
      // Everything after the duration is a `;`-separated list of flags, action
      // calls and state keywords that continue the same line.
      const parts = rest.split(';').map(part => part.trim()).filter(Boolean);
      line = '';
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        // A frame line writes its flags space separated from the action that
        // follows them (`STEA A 2 Bright A_SpawnItemEx(...)`), so peel those off
        // before looking for a call; treating the part as one token lost both.
        let part = parts[partIndex];
        for (;;) {
          const leading = /^(bright|fast|slow|nodelay|canraise)\s+/i.exec(part);
          if (!leading) break;
          entry.flags.push(leading[1].toLowerCase());
          part = part.slice(leading[0].length).trim();
        }
        // Some sources write the flags after the call (`A_Look Bright`).
        for (;;) {
          const trailing = /(?:^|\s)(bright|fast|slow|nodelay|canraise)$/i.exec(part);
          if (!trailing) break;
          entry.flags.push(trailing[1].toLowerCase());
          part = part.slice(0, trailing.index).trim();
        }
        const flagWord = /^(bright|fast|slow|nodelay|canraise)$/i.exec(part);
        if (flagWord) { entry.flags.push(flagWord[1].toLowerCase()); continue; }
        if (!part) continue;
        const nextFrame = /^([A-Za-z0-9_#-]{1,5})\s+([A-Za-z#-]+)\s+(-?[0-9.]+)([\s\S]*)$/.exec(part);
        // Another frame on the same line: keep it and everything after it for
        // the next pass through the frame parser.
        if (nextFrame) { line = [part, ...parts.slice(partIndex + 1)].join('; '); break; }
        const keyword = /^(loop|stop|wait|fail)$/i.exec(part);
        if (keyword) { if (current) current.frames.push({ type: 'keyword', keyword: keyword[1].toLowerCase(), target: null }); continue; }
        const goto = /^goto\s+([\w.#+-]+)$/i.exec(part);
        if (goto) { if (current) current.frames.push({ type: 'keyword', keyword: 'goto', target: goto[1] }); continue; }
        const action = parseFrameAction(part, 0);
        if (action) {
          if (!entry.action) entry.action = action;
          else {
            // Additional calls on one frame become an inline body, which the
            // runtime executes in order.
            entry.body = { source: `${entry.body?.source ? `${entry.body.source}\n` : ''}${part};` };
          }
          continue;
        }
        if (current) current.frames.push({ type: 'raw', source: part });
      }
    }
  }
  return labels;
}

function parseFrameAction(statement, offset) {
  const rest = statement.slice(offset).replace('{BODY}', '').trim();
  if (!rest) return null;
  const call = /^([A-Za-z_][\w.]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(rest);
  if (!call) return null;
  const args = [], named = {};
  if (call[2] !== undefined) {
    for (const part of splitArguments(call[2])) {
      // ZScript supports named arguments: `A_LookEx(fov: 360, minrange: 128)`.
      const labelled = /^([a-z_]\w*)\s*:\s*([\s\S]+)$/i.exec(part);
      if (labelled) { named[labelled[1]] = parseValue(labelled[2]); continue; }
      args.push(parseValue(part));
    }
  }
  return { name: call[1].replace(/^self\./, ''), args, named, source: 'zscript' };
}

/** Splits a call argument list without breaking nested calls, arrays or strings. */
function splitArguments(text) {
  const parts = [];
  let current = '', depth = 0, quote = null;
  for (const char of text) {
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '(' || char === '[' || char === '{') depth++;
    if (char === ')' || char === ']' || char === '}') depth--;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Splits `class X : Y { ... }` bodies, ignoring nested `null`/`version` blocks. */
function splitClassBody(body) {
  const sections = { defaults: null, states: null, functions: [], properties: {} };
  let index = 0;
  while (index < body.length) {
    const rest = body.slice(index);
    const keywordMatch = /^\s*(Default|States|State)\s*\{/.exec(rest);
    if (keywordMatch) {
      const open = index + keywordMatch[0].length - 1;
      const close = matchBrace(body, open);
      const inner = body.slice(open + 1, close < 0 ? body.length : close);
      if (keywordMatch[1].toLowerCase() === 'default') sections.defaults = inner;
      else sections.states = (sections.states || '') + `\n${inner}`;
      index = close < 0 ? body.length : close + 1;
      continue;
    }
    const functionMatch = /^\s*((?:(?:override|virtual|static|private|protected|native|action|final|transient|deprecated|clearscope|play|ui)\s+)*)([A-Za-z_][\w<>\[\],\s]*?)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/.exec(rest);
    if (functionMatch) {
      const open = index + functionMatch[0].length - 1;
      const close = matchBrace(body, open);
      sections.functions.push({
        name: functionMatch[3], modifiers: functionMatch[1].trim().split(/\s+/).filter(Boolean),
        parameters: functionMatch[4], returns: functionMatch[2].trim(),
        source: body.slice(open + 1, close < 0 ? body.length : close).trim(),
      });
      index = close < 0 ? body.length : close + 1;
      continue;
    }
    const member = /^\s*([A-Za-z_][\w.]*)\s*=\s*([^;]+);/.exec(rest);
    if (member) { sections.properties[member[1]] = parseValue(member[2]); index += member[0].length; continue; }
    const declaration = /^\s*([A-Za-z_][\w.<>\[\]]*)\s+([A-Za-z_]\w*)\s*(?:=\s*([^;]+))?;/.exec(rest);
    if (declaration) {
      if (declaration[3] !== undefined) sections.properties[declaration[2]] = parseValue(declaration[3]);
      index += declaration[0].length;
      continue;
    }
    index++;
  }
  return sections;
}

/**
 * Parses ZScript source into actor records shaped like DECORATE ones, plus the
 * class functions and constants found along the way.
 */
export function parseZScript(text, { source = 'ZSCRIPT' } = {}) {
  const clean = stripComments(text);
  const actors = [], warnings = [], constants = {}, includes = [];
  // ZScript keywords are matched case-insensitively: Lullaby writes `Class RotStar`, and
  // requiring lowercase silently skipped every actor the mod defines.
  const classPattern = /(?:^|\n)\s*(?:abstract\s+|final\s+|native\s+|play\s+|ui\s+|internal\s+|protected\s+|private\s+|version\s*\([^)]*\)\s*)*class\s+([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_]\w*)\s*)?/gi;
  let match;
  while ((match = classPattern.exec(clean))) {
    const name = match[1], parent = match[2] || null;
    const open = clean.indexOf('{', match.index + match[0].length);
    if (open < 0) continue;
    const close = matchBrace(clean, open);
    const body = clean.slice(open + 1, close < 0 ? clean.length : close);
    const sections = splitClassBody(body);
    const defaults = sections.defaults !== null ? parseDefaults(sections.defaults) : { properties: {}, flags: {} };
    const labels = sections.states ? parseStates(sections.states) : [];
    actors.push({
      name, parent, replaces: defaults.properties.Replaces || null,
      doomedNum: typeof defaults.properties.DoomedNum === 'number' ? defaults.properties.DoomedNum
        : typeof defaults.properties.EditorNumber === 'number' ? defaults.properties.EditorNumber : null,
      properties: { ...defaults.properties, ...sections.properties }, flags: defaults.flags,
      states: labels, functions: sections.functions, source, line: 1, language: 'zscript',
      abstract: /\babstract\s+class\b/.test(match[0]),
    });
  }
  for (const constant of clean.matchAll(/(?:^|\n)\s*(?:(?:const|static)\s+)?(?:int|float|double|uint|bool|string|name|voidptr)\s+([A-Za-z_]\w*)\s*=\s*(-?[0-9.]+|true|false|"[^"]*")\s*;/g)) {
    constants[constant[1]] = parseValue(constant[2]);
  }
  if (/^\s*#include\s+/m.test(clean)) {
    for (const include of clean.matchAll(/#include\s+("([^"]+)"|<([^>]+)>)/g)) includes.push(include[2] || include[3]);
  }
  if (/class\s+\w+\s*:\s*\w+/.test(clean) === false && /^\s*version\s+/m.test(clean)) {
    warnings.push(`${source}: only a version directive was found`);
  }
  return { actors, warnings, constants, includes };
}

/**
 * Parses every actor-definition source a WAD or PK3 provides and resolves the
 * combined inheritance tree. ZScript is parsed into DECORATE records first so a
 * single resolver handles both languages, which is also how GZDoom behaves.
 */
export function parseActorDefinitions(sources, { sourceName = 'actors' } = {}) {
  const records = [];
  const warnings = [], constants = {};
  for (const { name, text } of sources) {
    const lower = name.toLowerCase();
    const isZScript = /\.(zc|zs|zsc)$/.test(lower) || /zscript/.test(lower);
    if (isZScript) {
      const parsed = parseZScript(text, { source: name });
      records.push(...parsed.actors);
      warnings.push(...parsed.warnings);
      Object.assign(constants, parsed.constants);
    } else {
      const parsed = parseDecorate(text, { source: name });
      records.push(...parsed.actors);
      warnings.push(...parsed.warnings);
    }
  }
  const resolved = resolveActorInheritance(records);
  warnings.push(...resolved.warnings);
  return { actors: resolved.actors, records, warnings, constants, sourceName };
}
