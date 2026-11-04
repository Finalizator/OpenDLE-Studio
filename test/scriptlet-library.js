import { createScriptletRegistry } from '../shared/scriptlets.js';
import { scriptletFiles } from '../server/scriptlets.js';
import { fileURLToPath } from 'node:url';

const registry = createScriptletRegistry();
await registry.load(scriptletFiles(fileURLToPath(new URL('../scriptlets/', import.meta.url))), url => import(new URL(`..${url}`, import.meta.url)));
if (registry.errors.length) throw new Error(JSON.stringify(registry.errors));

export const { scriptlets: ENGINE_SCRIPTLETS, installScriptlet, removeScriptlet, scriptletById } = registry;
