import { removeEventSheet } from './events.js';

export function removeScriptletSheet(project, name) {
  const sheet = (project.eventSheets || []).find(sheet => sheet.name === name);
  if (!sheet) return false;
  removeEventSheet(project, sheet.id);
  return true;
}

export function scriptletRuleCount(project, name) {
  const sheet = (project.eventSheets || []).find(sheet => sheet.name === name);
  return sheet ? project.events.filter(event => event.sheetId === sheet.id).length : 0;
}

export function validateScriptlet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Default export must be a scriptlet object');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.id)) throw new Error('Scriptlet id must use 1-80 letters, digits, hyphens or underscores');
  for (const key of ['name', 'summary', 'detail']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Scriptlet ${value.id} needs ${key} text`);
  }
  if (!Number.isSafeInteger(value.rules) || value.rules < 1) throw new Error(`Scriptlet ${value.id} needs a positive integer rules count`);
  for (const key of ['install', 'remove', 'installed', ...(value.build === undefined ? [] : ['build'])]) {
    if (typeof value[key] !== 'function' || ['AsyncFunction', 'AsyncGeneratorFunction', 'GeneratorFunction'].includes(value[key].constructor.name)) {
      throw new Error(`Scriptlet ${value.id} needs a synchronous ${key}(project) function`);
    }
  }
  for (const key of ['buildLabel', 'buildDetail']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`Scriptlet ${value.id} has invalid ${key} text`);
  }
  return value;
}

/** The folder manifest is data; local editor modules are only executed by the browser loader. */
export function createScriptletRegistry() {
  const scriptlets = [], errors = [];
  let generation = 0;
  const scriptletById = id => {
    const found = scriptlets.find(scriptlet => scriptlet.id === id);
    if (!found) throw new Error(`Unknown engine scriptlet: ${id}`);
    return found;
  };
  return {
    scriptlets, errors, scriptletById,
    installScriptlet(project, id) {
      const sheetId = scriptletById(id).install(project);
      if (typeof sheetId !== 'string' || !(project.eventSheets || []).some(sheet => sheet.id === sheetId)) {
        throw new Error(`Scriptlet ${id}: install(project) must return the installed event sheet id`);
      }
      return sheetId;
    },
    removeScriptlet(project, id) {
      const removed = scriptletById(id).remove(project);
      if (typeof removed !== 'boolean') throw new Error(`Scriptlet ${id}: remove(project) must return a boolean synchronously`);
      return removed;
    },
    async load(files, importModule = url => import(url)) {
      if (!Array.isArray(files)) throw new Error('Scriptlet folder response must contain a files list');
      const current = ++generation;
      const loaded = await Promise.all(files.map(async file => {
        try {
          if (!file || typeof file.name !== 'string' || typeof file.url !== 'string'
            || !/^\/scriptlets\/[^/?#]+\.(?:js|mjs)\?v=[0-9a-f]{64}$/.test(file.url)) {
            throw new Error('Invalid local scriptlet module URL');
          }
          return { name: file.name, scriptlet: validateScriptlet((await importModule(file.url)).default) };
        } catch (error) { return { name: file?.name || 'Unknown file', error: error instanceof Error ? error.message : String(error) }; }
      }));
      if (current !== generation) return;
      const counts = new Map();
      for (const item of loaded) if (item.scriptlet) counts.set(item.scriptlet.id, (counts.get(item.scriptlet.id) || 0) + 1);
      scriptlets.length = 0; errors.length = 0;
      for (const item of loaded) {
        if (item.scriptlet && counts.get(item.scriptlet.id) > 1) item.error = `Duplicate scriptlet id: ${item.scriptlet.id}`;
        if (item.error) errors.push({ name: item.name, message: item.error });
        else scriptlets.push(item.scriptlet);
      }
    },
  };
}
