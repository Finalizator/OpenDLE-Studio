import { emptyHUD } from './hud.js';

/**
 * Addons: what an extension may add to a project, and how the project holds it.
 *
 * An addon is a folder of files with a manifest (`opendle-addon.json`) that says what it brings:
 * event actions and conditions, shaders, HUD elements and artwork, and an optional JavaScript module
 * that runs in the editor. Two halves, on purpose:
 *
 * - the **declarative** half is data. It is copied into the project when the addon is installed and
 *   tagged with the addon's id, so it is ordinary, editable project content afterwards, and removing
 *   the addon takes back exactly what it added;
 * - the **script** half is the addon's own module, served from the project by
 *   `/api/addons/<id>/<file>` and loaded by [`public/addons-host.js`](../public/addons-host.js). That
 *   is what makes "no limits" true: the addon runs in the same page the editor runs in.
 *
 * Nothing here touches the network. Fetching a repository from a URL is `server/addons.js`; this
 * module only ever sees files that arrived.
 */

export const ADDON_FORMAT = 'opendle-addon';
export const ADDON_VERSION = 1;
export const ADDON_MANIFEST = 'opendle-addon.json';

/** Bounds for everything an addon may carry. A project is a document, not a build tree. */
export const ADDON_LIMITS = {
  addons: 32,
  files: 64,
  fileChars: 512 * 1024,
  totalChars: 4 * 1024 * 1024,
  manifestChars: 64 * 1024,
  commands: 128,
  fields: 24,
  requires: 16,
};

const FIELD_KINDS = ['number', 'value', 'choice', 'string', 'image', 'waypoint'];
const DEFINITION_FLAGS = ['target', 'variable', 'group', 'hudElement', 'hudAnimation', 'timesheet', 'path', 'sound', 'spriteClip', 'wall', 'sector', 'zone'];

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const addonIdPattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const assert = (value, message) => { if (!value) throw new Error(message); };
const text = (value, message, max) => assert(typeof value === 'string' && value.length > 0 && value.length <= max, message);

/* ---------------------------------------------------------------- manifest */

/**
 * Throws unless the manifest describes an addon this build can install.
 *
 * Every command it declares is checked the way a built-in one is used: a type, a label, and fields
 * whose kinds are ones the event sheet knows how to draw and `validateProject` knows how to check.
 */
export function validateAddonManifest(manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'An addon manifest must be an object');
  // The manifest is where an addon can carry artwork, so its size is bounded like the files are: an
  // embedded data URL is copied into `project.assets` on install and would otherwise double.
  let size = 0;
  try { size = JSON.stringify(manifest).length; }
  catch { assert(false, 'An addon manifest must be plain data'); }
  assert(size <= ADDON_LIMITS.manifestChars, `An addon manifest must be at most ${ADDON_LIMITS.manifestChars} characters (this one is ${size})`);
  assert(manifest.format === ADDON_FORMAT, `An addon manifest must say "format": "${ADDON_FORMAT}"`);
  assert(manifest.version === ADDON_VERSION, `Addon format version ${manifest.version} is not supported (this build reads ${ADDON_VERSION})`);
  assert(typeof manifest.id === 'string' && addonIdPattern.test(manifest.id), 'An addon needs an id of 2-64 lowercase letters, digits or dashes');
  text(manifest.name, 'An addon needs a name', 100);
  for (const key of ['description', 'author', 'homepage', 'engine']) {
    if (manifest[key] !== undefined) text(manifest[key], `Addon ${key} must be text`, 2000);
  }
  if (manifest.entry !== undefined) {
    text(manifest.entry, 'An addon entry must be a file name', 200);
    assert(!manifest.entry.includes('..') && !manifest.entry.startsWith('/'), 'An addon entry must stay inside the addon');
  }
  if (manifest.requires !== undefined) {
    assert(Array.isArray(manifest.requires) && manifest.requires.length <= ADDON_LIMITS.requires, 'Addon requirements must be a list');
    for (const id of manifest.requires) assert(typeof id === 'string' && addonIdPattern.test(id), 'A requirement must be an addon id');
    assert(!manifest.requires.includes(manifest.id), 'An addon cannot require itself');
  }
  const provides = manifest.provides === undefined ? {} : manifest.provides;
  assert(provides && typeof provides === 'object' && !Array.isArray(provides), 'Addon provides must be an object');
  for (const key of Object.keys(provides)) {
    assert(['actions', 'conditions', 'shaders', 'hud', 'assets'].includes(key), `An addon cannot provide "${key}"`);
  }
  // One type is one command: declaring it as both a condition and an action would make the sheet's
  // pickers disagree and give `validateProject` a message blaming a second addon that does not exist.
  const seenTypes = new Set();
  for (const kind of ['actions', 'conditions']) {
    const list = provides[kind];
    if (list === undefined) continue;
    assert(Array.isArray(list) && list.length <= ADDON_LIMITS.commands, `Addon ${kind} must be a list of at most ${ADDON_LIMITS.commands}`);
    for (const definition of list) {
      validateCommandDefinition(definition, kind);
      assert(!seenTypes.has(definition.type), `Duplicate addon command ${definition.type}`);
      seenTypes.add(definition.type);
    }
  }
  if (provides.shaders !== undefined) {
    assert(Array.isArray(provides.shaders) && provides.shaders.length <= ADDON_LIMITS.commands, 'Addon shaders must be a list');
    for (const shader of provides.shaders) {
      assert(shader && typeof shader === 'object', 'Every addon shader must be an object');
      assert(typeof shader.id === 'string' && identifierPattern.test(shader.id), 'An addon shader needs an id');
      text(shader.name, 'An addon shader needs a name', 100);
      assert(['glsl', 'tsl'].includes(shader.language), 'An addon shader must be glsl or tsl');
      assert(typeof shader.source === 'string' && shader.source.length > 0 && shader.source.length <= ADDON_LIMITS.fileChars, 'An addon shader needs source');
    }
  }
  if (provides.assets !== undefined) {
    assert(Array.isArray(provides.assets) && provides.assets.length <= ADDON_LIMITS.commands, 'Addon assets must be a list');
    for (const asset of provides.assets) {
      assert(asset && typeof asset === 'object', 'Every addon asset must be an object');
      assert(typeof asset.id === 'string' && identifierPattern.test(asset.id), 'An addon asset needs an id');
      text(asset.name, 'An addon asset needs a name', 100);
      assert(typeof asset.src === 'string' && asset.src.startsWith('data:'), 'An addon asset must embed its bytes as a data URL');
      assert(asset.src.length <= ADDON_LIMITS.fileChars * 2, `Addon asset ${asset.id} carries more than ${ADDON_LIMITS.fileChars * 2} characters`);
    }
  }
  if (provides.hud !== undefined) {
    assert(provides.hud && typeof provides.hud === 'object' && !Array.isArray(provides.hud), 'Addon HUD content must be an object');
    for (const key of ['elements', 'animations']) {
      if (provides.hud[key] === undefined) continue;
      assert(Array.isArray(provides.hud[key]) && provides.hud[key].length <= ADDON_LIMITS.commands, `Addon HUD ${key} must be a list`);
      for (const item of provides.hud[key]) {
        assert(item && typeof item === 'object', `Every addon HUD ${key} entry must be an object`);
        assert(typeof item.id === 'string' && identifierPattern.test(item.id), `An addon HUD ${key} entry needs an id`);
        text(item.name, `An addon HUD ${key} entry needs a name`, 100);
      }
    }
  }
  return manifest;
}

/** One event action or condition an addon adds, in the shape the engine catalogue uses. */
function validateCommandDefinition(definition, kind) {
  assert(definition && typeof definition === 'object' && !Array.isArray(definition), `Every addon ${kind} entry must be an object`);
  assert(typeof definition.type === 'string' && identifierPattern.test(definition.type),
    `An addon ${kind} needs a type of letters, digits, "_", ".", ":" or "-"`);
  text(definition.label, `Addon ${kind} ${definition.type} needs a label`, 100);
  for (const flag of Object.keys(definition)) {
    assert(['type', 'label', 'fields', ...DEFINITION_FLAGS].includes(flag), `Addon ${kind} ${definition.type} has an unknown key "${flag}"`);
    if (DEFINITION_FLAGS.includes(flag)) assert(typeof definition[flag] === 'boolean', `Addon ${kind} ${definition.type}: ${flag} must be true or false`);
  }
  const fields = definition.fields === undefined ? [] : definition.fields;
  assert(Array.isArray(fields) && fields.length <= ADDON_LIMITS.fields, `Addon ${kind} ${definition.type} may have at most ${ADDON_LIMITS.fields} fields`);
  const names = new Set();
  for (const field of fields) {
    assert(field && typeof field === 'object', `Addon ${kind} ${definition.type} has a field that is not an object`);
    assert(typeof field.name === 'string' && identifierPattern.test(field.name), `Addon ${kind} ${definition.type} has an invalid field name`);
    assert(!names.has(field.name), `Addon ${kind} ${definition.type} repeats the field ${field.name}`);
    names.add(field.name);
    assert(FIELD_KINDS.includes(field.kind), `Addon ${kind} ${definition.type}: field ${field.name} must be one of ${FIELD_KINDS.join(', ')}`);
    text(field.label ?? field.name, `Addon ${kind} ${definition.type}: field ${field.name} needs a label`, 100);
    if (field.kind === 'number') {
      for (const key of ['value', 'min', 'max']) {
        if (field[key] !== undefined) assert(Number.isFinite(field[key]), `Addon ${kind} ${definition.type}: ${field.name}.${key} must be a number`);
      }
    }
    if (field.kind === 'choice') {
      assert(Array.isArray(field.options) && field.options.length > 0 && field.options.length <= 64,
        `Addon ${kind} ${definition.type}: field ${field.name} needs 1-64 options`);
      for (const option of field.options) assert(typeof option === 'string' && option.length <= 100, `Addon ${kind} ${definition.type}: ${field.name} options must be text`);
      assert(field.value === undefined || field.options.includes(field.value), `Addon ${kind} ${definition.type}: ${field.name} default must be one of its options`);
    }
    for (const key of ['optional', 'allowLast']) {
      assert(field[key] === undefined || typeof field[key] === 'boolean', `Addon ${kind} ${definition.type}: ${field.name}.${key} must be true or false`);
    }
  }
  return definition;
}

/* ------------------------------------------------------------- the record */

/**
 * The record a project keeps: the manifest verbatim, its files as text, and where it came from.
 *
 * The manifest is kept as the addon wrote it rather than normalised, so a project stays readable and
 * re-exporting the addon reproduces it.
 */
export function normalizeAddon({ manifest, files = {}, source = null }) {
  validateAddonManifest(manifest);
  const names = Object.keys(files);
  assert(names.length <= ADDON_LIMITS.files, `An addon may carry at most ${ADDON_LIMITS.files} files`);
  let total = 0;
  const copy = {};
  for (const name of names) {
    assert(typeof name === 'string' && name.length <= 200 && !name.includes('..') && !name.startsWith('/'),
      `Addon file name ${name} must stay inside the addon`);
    const body = files[name];
    assert(typeof body === 'string', `Addon file ${name} must be text`);
    assert(body.length <= ADDON_LIMITS.fileChars, `Addon file ${name} is larger than ${Math.round(ADDON_LIMITS.fileChars / 1024)} KiB`);
    total += body.length;
    assert(total <= ADDON_LIMITS.totalChars, `An addon may carry at most ${Math.round(ADDON_LIMITS.totalChars / 1048576)} MiB of files`);
    copy[name] = body;
  }
  if (manifest.entry !== undefined) assert(copy[manifest.entry] !== undefined, `The addon entry ${manifest.entry} is not one of its files`);
  const record = { id: manifest.id, name: manifest.name, version: manifest.version, enabled: true,
    manifest: structuredClone(manifest), files: copy };
  if (manifest.description !== undefined) record.description = manifest.description;
  if (manifest.author !== undefined) record.author = manifest.author;
  if (source) record.source = source;
  return record;
}

/** The addon records a project holds, in the order they were installed. */
export function projectAddons(project) {
  return Array.isArray(project?.addons) ? project.addons : [];
}

/** The addons that are switched on, in install order. */
export function enabledAddons(project) {
  return projectAddons(project).filter(addon => addon?.enabled !== false);
}

export function findAddon(project, id) {
  return projectAddons(project).find(addon => addon.id === id) || null;
}

/**
 * Every command type the installed addons declare, including switched-off ones.
 *
 * A rule that names one stays valid while its addon is installed: switching the addon off is a
 * choice about the game, not a reason to make the project unreadable.
 */
export function declaredAddonTypes(project) {
  const types = new Set();
  for (const addon of projectAddons(project)) {
    for (const kind of ['actions', 'conditions']) {
      for (const definition of addon.manifest?.provides?.[kind] || []) types.add(definition.type);
    }
  }
  return types;
}

/* -------------------------------------------------------------- catalogue */

/** Every event action or condition an enabled addon declares, tagged with the addon it came from. */
export function addonCommands(project, kind) {
  const list = [];
  for (const addon of enabledAddons(project)) {
    for (const definition of addon.manifest?.provides?.[kind] || []) {
      list.push({ ...structuredClone(definition), addonId: addon.id, addon: true });
    }
  }
  return list;
}

/**
 * The addon command with this type, or null.
 *
 * A switched-off addon is still consulted: its type stays valid (`declaredAddonTypes` says so), and a
 * rule it left behind must keep being checked — otherwise switching the addon back on would reject a
 * field that was written while it was off. Only the *runtime* and the pickers care about `enabled`.
 */
export function addonCommand(project, type) {
  const installed = projectAddons(project);
  const enabled = installed.filter(addon => addon.enabled !== false);
  const find = (addons, kind) => {
    for (const addon of addons) {
      const definition = (addon.manifest?.provides?.[kind] || []).find(command => command.type === type);
      if (definition) return { ...structuredClone(definition), addonId: addon.id, addon: true, enabled: addon.enabled !== false };
    }
    return null;
  };
  return find(enabled, 'actions') || find(enabled, 'conditions')
    || find(installed, 'actions') || find(installed, 'conditions') || null;
}

/**
 * The rules that use an addon's commands, so the panel can say what switching it off would leave
 * behind rather than silently turning those rules into no-ops.
 */
export function addonUsage(project, id) {
  const addon = findAddon(project, id);
  const types = new Set([...(addon?.manifest?.provides?.actions || []), ...(addon?.manifest?.provides?.conditions || [])]
    .map(definition => definition.type));
  if (!types.size) return [];
  const uses = [];
  const walk = (rule, sheet) => {
    const commands = [...(rule.conditions || []), rule.condition, ...(rule.actions || [])].filter(Boolean);
    const used = commands.filter(command => types.has(command.type)).map(command => command.type);
    if (used.length) uses.push({ rule, sheet, commands: used });
  };
  for (const rule of project?.events || []) walk(rule, 'Layout');
  for (const sheet of project?.timesheets || []) for (const cue of ruleList(sheet)) walk(cue, sheet.name);
  for (const scene of project?.scenes || []) for (const rule of scene.events || []) walk(rule, scene.name);
  // The levels that are not open are kept as snapshots on the game, and their rules are stripped with
  // the open level's, so the count the panel shows has to see them too.
  for (const level of project?.game?.levels || []) {
    // The open level's snapshot is what it looked like when it was left, not what it holds now, so
    // counting it would count its rules twice.
    if (level.id === project?.game?.active) continue;
    const data = level.data || {};
    for (const rule of data.events || []) walk(rule, level.id);
    for (const sheet of data.timesheets || []) for (const cue of ruleList(sheet)) walk(cue, `${level.id} · ${sheet.name}`);
    for (const scene of data.scenes || []) for (const rule of scene.events || []) walk(rule, `${level.id} · ${scene.name}`);
  }
  return uses;
}

const ruleList = sheet => sheet?.cues || [];

/* ---------------------------------------------------------------- install */

/**
 * Adds an addon to a project, and everything declarative it brings.
 *
 * Artwork, shaders and HUD content are copied in as ordinary project content with `addonId` on each
 * item, which is what makes `removeAddon` exact. Nothing is merged silently: an id that already
 * exists is an error, because guessing which of the two the author meant is worse than saying so.
 *
 * `engineTypes` is the set of command types the build already has; an addon may not declare one of
 * those, or an event written against the engine would quietly start running the addon's version.
 */
export function installAddon(project, { manifest, files = {}, source = null }, { engineTypes = new Set() } = {}) {
  const record = normalizeAddon({ manifest, files, source });
  project.addons ||= [];
  assert(!project.addons.some(addon => addon.id === record.id), `The addon "${record.id}" is already installed`);
  assert(project.addons.length < ADDON_LIMITS.addons, `A project holds at most ${ADDON_LIMITS.addons} addons`);
  for (const required of record.manifest.requires || []) {
    const dependency = project.addons.find(addon => addon.id === required);
    assert(dependency, `The addon "${record.id}" requires "${required}", which is not installed`);
    assert(dependency.enabled !== false, `The addon "${record.id}" requires "${required}", which is switched off`);
  }
  for (const kind of ['actions', 'conditions']) {
    for (const definition of record.manifest.provides?.[kind] || []) {
      assert(!engineTypes.has(definition.type), `The addon "${record.id}" declares ${definition.type}, which the engine already has`);
      assert(!addonCommand(project, definition.type), `The addon "${record.id}" declares ${definition.type}, which another addon already adds`);
    }
  }
  addContent(project, record);
  project.addons.push(record);
  return record;
}

/** Copies what the addon provides into the project, tagged so it can be taken back out. */
function addContent(project, record) {
  const provides = record.manifest.provides || {};
  if (provides.assets?.length) {
    project.assets ||= [];
    for (const asset of provides.assets) {
      assert(!project.assets.some(existing => existing.id === asset.id),
        `The addon "${record.id}" brings the asset ${asset.id}, which already exists`);
      project.assets.push({ ...structuredClone(asset), addonId: record.id });
    }
  }
  if (provides.shaders?.length) {
    project.shaders ||= [];
    for (const shader of provides.shaders) {
      assert(!project.shaders.some(existing => existing.id === shader.id),
        `The addon "${record.id}" brings the shader ${shader.id}, which already exists`);
      project.shaders.push({ ...structuredClone(shader), addonId: record.id });
    }
  }
  if (provides.hud) {
    // A project with no HUD gets an empty canvas, not an object missing its size: the element has to be
    // usable the moment it lands, or installing the addon leaves a project that cannot be saved.
    project.hud ||= emptyHUD();
    project.hud.elements ||= [];
    project.hud.animations ||= [];
    for (const element of provides.hud.elements || []) {
      assert(!project.hud.elements.some(existing => existing.id === element.id),
        `The addon "${record.id}" brings the HUD element ${element.id}, which already exists`);
      project.hud.elements.push({ ...structuredClone(element), addonId: record.id });
    }
    for (const animation of provides.hud.animations || []) {
      assert(!project.hud.animations.some(existing => existing.id === animation.id),
        `The addon "${record.id}" brings the HUD animation ${animation.id}, which already exists`);
      project.hud.animations.push({ ...structuredClone(animation), addonId: record.id });
    }
  }
}

/**
 * Takes the addon's commands out of the rules that used them.
 *
 * Removing an addon without this would leave rules naming a command no installed addon declares,
 * which is a project that can no longer be saved. A rule this emptied is dropped; one that still
 * says something keeps what it has, the same way deleting a HUD element releases a rule.
 */
export function stripAddonCommands(project, types) {
  const removed = { commands: 0, rules: 0 };
  if (!types || !types.size) return removed;
  const dropped = new Set();
  const keep = rule => {
    const conditions = [rule.condition, ...(rule.conditions || [])].filter(Boolean);
    const before = (rule.actions || []).length + conditions.length;
    const drop = list => list.filter(command => {
      if (!types.has(command?.type)) return true;
      removed.commands += 1;
      return false;
    });
    rule.actions = drop(rule.actions || []);
    const kept = drop(conditions);
    rule.condition = kept[0] || null;
    rule.conditions = kept.slice(1);
    const after = rule.actions.length + kept.length;
    if (after < before && (!rule.actions.length || !kept.length)) { removed.rules += 1; dropped.add(rule.id); return false; }
    return true;
  };
  // A game keeps the levels that are not open as snapshots, and a rule naming the command may be
  // written on any of them: stripping only the open level would leave the project invalid the
  // moment validation walked the dormant ones.
  // A rule's sub-events belong to it: dropping the parent and leaving the children behind is a
  // project that fails validation ("Sub-event parent must precede it"), so the branch goes together.
  const stripRules = rules => {
    const kept = [];
    for (const rule of rules) {
      if (rule?.parentId && dropped.has(rule.parentId)) { dropped.add(rule.id); removed.rules += 1; continue; }
      if (keep(rule)) kept.push(rule);
    }
    return kept;
  };
  const sweep = data => {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.events)) data.events = stripRules(data.events);
    for (const scene of data.scenes || []) {
      if (Array.isArray(scene.events)) scene.events = stripRules(scene.events);
    }
    for (const sheet of data.timesheets || []) {
      if (Array.isArray(sheet.cues)) sheet.cues = stripRules(sheet.cues);
    }
  };
  sweep(project);
  for (const level of project.game?.levels || []) sweep(level.data);
  return removed;
}

/**
 * The project validator, registered by `shared/project.js` when it loads.
 *
 * It is handed over rather than imported because `project.js` already imports this module: importing it
 * back would make the two depend on each other's evaluation order, and one of them (`project.js`) reads
 * the command catalogue at load time. A project cannot exist without `project.js`, so in every caller a
 * project object reaches here the validator is registered too.
 */
let projectValidator = null;
export function setProjectValidator(validate) { projectValidator = validate; }

/** The content an addon added, taken back out. Ids, not references: the record is already gone. */
function removeContent(project, id) {
  if (project.assets) project.assets = project.assets.filter(asset => asset.addonId !== id);
  if (project.shaders) project.shaders = project.shaders.filter(shader => shader.addonId !== id);
  if (project.hud) {
    project.hud.elements = (project.hud.elements || []).filter(element => element.addonId !== id);
    project.hud.animations = (project.hud.animations || []).filter(animation => animation.addonId !== id);
  }
}

/** Puts a project back the way it was. The caller's own references into it are stale afterwards. */
function restoreProject(project, backup) {
  for (const key of Object.keys(project)) delete project[key];
  Object.assign(project, backup);
}

/**
 * Validates the project as it is *now*, rather than as its stored level snapshots remember it.
 *
 * The open level is validated as the live project; its snapshot is only what the level looked like
 * when it was last left, so checking it would refuse an edit over artwork the level no longer uses.
 */
function validateLive(project) {
  if (!projectValidator) return undefined;
  const validate = projectValidator;
  if (!project.game) return validate(project);
  return validate({ ...project, game: { ...project.game, levels: project.game.levels.map(level =>
    level.id === project.game.active ? { ...level, data: {} } : level) } });
}

/**
 * Takes an addon back out: its record, the content it added, and its commands in rules.
 *
 * `strip` defaults to true because the alternative leaves a project naming commands nothing declares.
 * The panel asks first, and shows what would go with `addonUsage`; the return value says what it took.
 *
 * A removal that would break the project — artwork an object still draws with, a HUD element a rule
 * still clicks — throws instead of leaving it broken. Content can be named from places commands are
 * not, so rather than keep a second list of every such place (and get it wrong the first time a new
 * one is added) the removal is applied and the project validated: a project this broke is put back and
 * the removal is refused with the reason. A caller that catches the error must read the project again
 * rather than hold a reference into the contents that were put back.
 */
export function removeAddon(project, id, { strip = true } = {}) {
  const record = findAddon(project, id);
  if (!record) return null;
  const provides = record.manifest?.provides || {};
  const brings = Boolean(provides.assets?.length || provides.shaders?.length
    || provides.hud?.elements?.length || provides.hud?.animations?.length);
  const backup = brings ? structuredClone(project) : null;
  const types = declaredTypesOf(record);
  project.addons = projectAddons(project).filter(addon => addon.id !== id);
  // Another addon may declare the same command only if this one did not (install rejects that), so
  // the types are safe to strip while the record that declared them is already gone.
  const stripped = strip ? stripAddonCommands(project, types) : { commands: 0, rules: 0 };
  // An addon that needed it cannot keep running without it.
  for (const dependent of projectAddons(project)) {
    if (dependent.manifest?.requires?.includes(id)) dependent.enabled = false;
  }
  removeContent(project, id);
  // A level remembers which assets it draws with. The list is bookkeeping rather than authorship, so a
  // stale entry is pruned instead of refusing the removal over artwork the level no longer has.
  const gone = new Set((backup?.assets || []).filter(asset => asset.addonId === id).map(asset => asset.id));
  for (const level of project.game?.levels || []) {
    if (Array.isArray(level.assetIds) && gone.size) level.assetIds = level.assetIds.filter(assetId => !gone.has(assetId));
  }
  if (backup) {
    try { validateLive(project); }
    catch (error) {
      restoreProject(project, backup);
      throw new Error(`Cannot remove "${record.name}": ${error.message}. Point what still uses it at something else first`);
    }
  }
  return { addon: record, ...stripped };
}

/**
 * Swaps an installed addon for a newer copy of itself.
 *
 * Updating is one edit, not a removal followed by an install: the rules that call the addon stay
 * valid throughout, and a copy that cannot be installed leaves the previous one exactly as it was.
 */
export function replaceAddon(project, id, { manifest, files = {}, source = null }, { engineTypes = new Set() } = {}) {
  const record = findAddon(project, id);
  if (!record) throw new Error(`The addon "${id}" is not installed`);
  if (validateAddonManifest(manifest).id !== id) throw new Error(`That URL now holds "${manifest.id}", not "${id}"`);
  const backup = structuredClone(project);
  project.addons = projectAddons(project).filter(addon => addon.id !== id);
  removeContent(project, id);
  try {
    installAddon(project, { manifest, files, source: source || record.source }, { engineTypes });
    validateLive(project);
  } catch (error) {
    restoreProject(project, backup);
    throw new Error(`Cannot update "${record.name}": ${error.message}`);
  }
  return findAddon(project, id);
}

/** The command types one addon declares. */
function declaredTypesOf(record) {
  return new Set([...(record?.manifest?.provides?.actions || []), ...(record?.manifest?.provides?.conditions || [])]
    .map(definition => definition.type));
}

/** Switches an addon on or off. Content it already added stays: it is the project's now. */
export function setAddonEnabled(project, id, enabled) {
  const record = findAddon(project, id);
  if (!record) return null;
  // Two addons may both declare a command as long as only one is switched on (installing the second
  // while the first is off is allowed). Switching the first back on would leave the project with a
  // command two addons claim, which `validateProject` refuses — so it is refused here, where the
  // person can see why, instead of on the next save.
  if (enabled) {
    const mine = declaredTypesOf(record);
    for (const other of projectAddons(project)) {
      if (other.id === id || other.enabled === false) continue;
      for (const type of declaredTypesOf(other)) {
        assert(!mine.has(type), `"${other.name}" already adds ${type}; switch it off before switching "${record.name}" on`);
      }
    }
  }
  record.enabled = Boolean(enabled);
  if (record.enabled) {
    for (const required of record.manifest?.requires || []) {
      const dependency = findAddon(project, required);
      assert(dependency, `This addon requires "${required}", which is not installed`);
      dependency.enabled = true;
    }
  }
  return record;
}

/** Files of one addon, for the route that serves its script. */
export function addonFile(project, id, name) {
  const record = findAddon(project, id);
  if (!record || record.enabled === false) return null;
  const body = record.files?.[name];
  return typeof body === 'string' ? body : null;
}

/** True when every addon this one requires is installed and switched on. */
export function addonReady(project, id) {
  const record = findAddon(project, id);
  if (!record || record.enabled === false) return false;
  return (record.manifest?.requires || []).every(required => {
    const dependency = findAddon(project, required);
    return Boolean(dependency) && dependency.enabled !== false;
  });
}
