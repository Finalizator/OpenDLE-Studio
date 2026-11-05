/**
 * Save files: the documents a game writes from an event and reads back.
 *
 * Two kinds travel in the same envelope, because a player keeps "a save file" and should not
 * have to know which one it is:
 *
 * - `variables` — the project variables the rule asked for (or all of them), so a game can
 *   checkpoint exactly the numbers it cares about and load them on another machine.
 * - `game` — a full runtime record from `captureGameSave`, which is what the studio's save
 *   slots already hold.
 *
 * The envelope is plain JSON on purpose: it is a file the player can copy, mail, edit or
 * inspect. Everything that reads one is strict, because a save that loads half-way is worse
 * than one that is refused with a sentence saying why.
 */

export const SAVE_FILE_FORMAT = 'opendle-save-file';
export const SAVE_FILE_VERSION = 1;
/** One save file is a small document; the whole-game kind carries a runtime record inside it. */
export const MAX_SAVE_FILE_BYTES = 16 * 1024 * 1024;
export const SAVE_FILE_KINDS = ['variables', 'game'];
/** A name the event sheet can hold: the identifier rules the editor already applies to names,
 * kept here too because a downloaded file is named after it on every platform the game lands on. */
export const SAVE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

const fail = message => { throw new Error(`Invalid save file: ${message}`); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Trims and checks a save file's name; the same rule the event sheet asks for. */
export function saveFileName(value) {
  const name = String(value ?? '').trim();
  if (!SAVE_FILE_NAME.test(name)) {
    throw new Error('A save file needs a name of 1-60 letters, digits, dots, dashes or underscores');
  }
  return name;
}

/** The variables a save should carry: all of them, or the comma-separated names a rule listed. */
export function saveVariableNames(project, list = '') {
  const available = Object.keys(project.variables || {});
  const wanted = String(list ?? '').split(',').map(name => name.trim()).filter(Boolean);
  if (!wanted.length) return available;
  const unknown = wanted.filter(name => !available.includes(name));
  if (unknown.length) throw new Error(`Save file names unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  return [...new Set(wanted)];
}

/** What a `variables` save file carries: the current value of each named variable. */
export function variableSnapshot(project, state, list = '') {
  const names = saveVariableNames(project, list);
  return Object.fromEntries(names.map(name => [name, state.variables?.[name] ?? project.variables[name]]));
}

/**
 * A saved value has to survive a JSON round trip unchanged: `NaN`, `Infinity` and `undefined`
 * all turn into `null` (or nothing at all) through `JSON.stringify`, so the file would hold a
 * value the load then refuses to apply — and the rule that saved it would have said "saved".
 */
function checkSavedValue(value, path) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Cannot save ${path}: a number has to be finite (it would be saved as null)`);
  }
  if (value === undefined) throw new Error(`Cannot save ${path}: it is undefined`);
  if (typeof value === 'function' || typeof value === 'symbol') throw new Error(`Cannot save ${path}: it is not data`);
  if (Array.isArray(value)) { value.forEach((item, index) => checkSavedValue(item, `${path}[${index}]`)); return; }
  if (value === null || typeof value !== 'object') return;
  if (!plain(value)) throw new Error(`Cannot save ${path}: it is not plain data`);
  for (const [key, item] of Object.entries(value)) checkSavedValue(item, `${path}.${key}`);
}

/** Builds the document both kinds share. `record` is only used by the `game` kind. */
export function saveFileDocument({ kind, name, identity = null, levelId = null, variables = null, record = null,
  createdAt = new Date().toISOString() }) {
  if (!SAVE_FILE_KINDS.includes(kind)) fail(`unknown kind ${kind}`);
  const document = { format: SAVE_FILE_FORMAT, version: SAVE_FILE_VERSION, kind, name: saveFileName(name),
    identity: typeof identity === 'string' && identity ? identity : null,
    levelId: typeof levelId === 'string' ? levelId : null, createdAt };
  if (!Number.isFinite(Date.parse(document.createdAt))) fail('missing creation time');
  if (kind === 'variables') {
    if (!plain(variables)) fail('missing variables');
    for (const [name, value] of Object.entries(variables)) checkSavedValue(value, name);
    document.variables = variables;
  } else {
    if (!plain(record)) fail('missing game record');
    document.record = record;
  }
  return document;
}

/** The text a save file holds. Refused rather than truncated when it would be too large to keep. */
export function serializeSaveFile(document) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (text.length > MAX_SAVE_FILE_BYTES) {
    fail(`a save of this size (${(text.length / 1024 / 1024).toFixed(1)} MiB) is larger than the ${MAX_SAVE_FILE_BYTES / 1024 / 1024} MiB limit`);
  }
  return text;
}

/**
 * Reads a save file's text. A file that is not one of these, is from a newer build, or is
 * missing the fields its kind needs is refused by name — a half-read save is worse than none.
 */
export function parseSaveFile(text) {
  if (typeof text !== 'string' || !text.trim()) fail('the file is empty');
  if (text.length > MAX_SAVE_FILE_BYTES) fail('the file is larger than the save-file limit');
  let document;
  try { document = JSON.parse(text); }
  catch (error) { fail(`it is not JSON (${error.message})`); }
  if (!plain(document)) fail('it is not a save file');
  if (document.format !== SAVE_FILE_FORMAT) fail('it was not written by this engine');
  if (document.version !== SAVE_FILE_VERSION) fail(`it was written by another version (${document.version})`);
  if (!SAVE_FILE_KINDS.includes(document.kind)) fail(`unknown kind ${document.kind}`);
  saveFileName(document.name);
  if (typeof document.createdAt !== 'string' || !Number.isFinite(Date.parse(document.createdAt))) fail('missing creation time');
  if (document.kind === 'variables' && !plain(document.variables)) fail('it has no variables');
  if (document.kind === 'game' && !plain(document.record)) fail('it has no game record');
  return document;
}

/**
 * Puts a `variables` save file back into the running game.
 *
 * A saved value replaces the live one of the same type — that is the whole point of the
 * action — and anything that no longer fits is skipped and reported instead of being written.
 * A project that renamed a variable, or changed a number into text, must not be able to load
 * a value its own rules would then choke on.
 */
export function applyVariableSave(project, state, document) {
  const saved = document.kind === 'variables' ? document.variables : {};
  const applied = [], skipped = [];
  for (const [name, value] of Object.entries(saved)) {
    if (!Object.hasOwn(project.variables || {}, name)) { skipped.push(`${name} (no longer in the project)`); continue; }
    const declared = project.variables[name];
    if (typeof value !== typeof declared) { skipped.push(`${name} (was ${typeof declared}, saved as ${typeof value})`); continue; }
    if (typeof value === 'number' && !Number.isFinite(value)) { skipped.push(`${name} (not a finite number)`); continue; }
    state.variables[name] = value;
    applied.push(name);
  }
  return { applied, skipped };
}
