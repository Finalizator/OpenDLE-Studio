/**
 * LANGUAGE string tables.
 *
 * GZDoom games replace user-visible text with keywords (`$TXT_MAP1`,
 * `$GOTSHOTGUN`, `$OB_IMP`) and keep the actual strings in LANGUAGE files or a
 * LANGUAGE lump. Resolving them is what turns an imported menu, level name or
 * DEHACKED string back into the text the game author wrote.
 */

const SECTION = /^\[([^\]]*)\]\s*$/;

/** Index of the first unescaped closing quote, or -1 when the value continues. */
function findClosingQuote(text) {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '"') return index;
  }
  return -1;
}

/**
 * Parses a LANGUAGE resource into a keyword map. Later definitions win, which is
 * how GZDoom's per-language tables layer over the defaults.
 */
export function parseLanguage(text) {
  const source = String(text ?? '');
  // GZDoom 4.x ships `language.csv` instead of `language.def`: a header row naming the columns and
  // then one row per string. Reading it as `KEY = "value"` produced nothing at all, so every
  // `$KEYWORD` in such a mod fell back to its own name.
  if (/^[^\n]*, *Identifier *[,\r\n]/i.test(source)) return parseLanguageCsv(source);
  const strings = {};
  const priorities = new Map();
  let section = 'default';
  const lines = String(text).replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    token => token.startsWith('"') ? token : token.replace(/[^\n]/g, ' ')).split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const header = SECTION.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    const assignment = /^([A-Za-z0-9_$.]+)\s*=\s*([\s\S]*)$/.exec(line);
    if (!assignment) continue;
    let value = assignment[2].trim();
    if (value.startsWith('"')) {
      let joined = '';
      while (value.startsWith('"')) {
        let collected = value.slice(1);
        let closing = findClosingQuote(collected);
        while (closing < 0 && index + 1 < lines.length) {
          collected += `\n${lines[++index]}`;
          closing = findClosingQuote(collected);
        }
        joined += closing < 0 ? collected : collected.slice(0, closing);
        value = closing < 0 ? '' : collected.slice(closing + 1).trim();
        if (!value) {
          let next = index + 1;
          while (next < lines.length && !lines[next].trim()) next++;
          if (lines[next]?.trim().startsWith('"')) {
            index = next;
            value = lines[index].trim();
          }
        }
      }
      value = joined;
    } else value = value.replace(/;\s*$/, '');
    value = value.replace(/\\(x[0-9a-fA-F]{1,2}|[\\"nrt])/g, (_escape, char) => {
      if (char[0] === 'x') {
        const code = Number.parseInt(char.slice(1), 16);
        // `\x00` is a dropped NUL, as in GZDoom's ProcessEscapes.
        return code === 0 ? '' : String.fromCharCode(code);
      }
      return ({ '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' })[char];
    });
    const languages = section.split(/\s+/);
    const priority = languages.includes('enu') ? 2 : languages.includes('default') ? 1 : 0;
    if (priority >= (priorities.get(assignment[1]) ?? -1)) {
      strings[assignment[1]] = value;
      priorities.set(assignment[1], priority);
    }
  }
  return strings;
}

/**
 * The rows of a CSV table, with quoted fields that may hold commas and line breaks.
 *
 * GZDoom's file quotes any translation containing a comma or a quote, and several hold a line
 * break inside the quotes, so splitting on commas and lines would cut a string in half.
 */
function csvRows(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++; continue; }
      if (character === '"') { quoted = false; continue; }
      field += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ',') { row.push(field); field = ''; continue; }
    if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; continue; }
    field += character;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

/**
 * A `language.csv` table: `default, Identifier, Remarks, Filter, <language columns…>`.
 *
 * Column 0 is the string itself and column 1 the `$KEYWORD` other files refer to; the rest are
 * per-language translations, which this engine has no selector for, so the default text is what a
 * keyword resolves to.
 */
function parseLanguageCsv(text) {
  const strings = {};
  const rows = csvRows(text);
  for (const row of rows.slice(1)) {
    const identifier = String(row[1] ?? '').trim().replace(/^\$/, '');
    if (!/^[A-Za-z0-9_]+$/.test(identifier)) continue;
    const value = row[0];
    if (value === undefined || value === '') continue;
    strings[identifier] = value;
  }
  return strings;
}

/** True when a value is a `$KEYWORD` reference rather than literal text. */
export const isKeyword = value => typeof value === 'string' && /^\$[A-Za-z0-9_]/.test(value.trim());

/**
 * Resolves a `$KEYWORD` against the project string table, falling back to the
 * keyword itself minus the `$` so the editor never shows an empty label.
 */
export function resolveString(strings, value, fallback = null) {
  if (typeof value !== 'string') return value ?? fallback;
  if (!isKeyword(value)) return value;
  const key = value.trim().slice(1);
  const found = strings?.[key] ?? strings?.[key.toUpperCase()];
  if (found !== undefined) return found;
  if (key.includes('_')) {
    const spaced = key.split('_').slice(1).join(' ');
    if (spaced) return spaced.charAt(0) + spaced.slice(1).toLowerCase();
  }
  return fallback ?? key;
}

/** Collects language tables from every source the import found. */
export function buildStringTable(sources) {
  const strings = {};
  for (const source of sources) {
    const text = typeof source === 'string' ? source : source.text;
    if (!text) continue;
    Object.assign(strings, parseLanguage(text));
  }
  return strings;
}
