// The payload of an exported game: the player, the engine modules it actually imports, and the
// project data split into files.
//
// The editor's build used to copy all of `public/` — the whole studio, its panels and its API — and
// hand the game one hydrated JSON holding every texture and sound as base64. This module builds the
// other thing: a folder that contains a game and nothing else, with the level data beside it.

import { readFileSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { packProject } from './project-folder.js';

/** The page a person opens. It lives at the build root, next to the engine modules it imports. */
export const GAME_PAGE = 'game/index.html';
/** The file the game fetches first: a small document that names everything else. */
export const GAME_DATA_DIRECTORY = 'data';

const THREE_BUILD_FILES = ['three.core.js', 'three.module.js', 'three.tsl.js', 'three.webgpu.js'];
const THREE_ADDON_PREFIX = 'three/addons/';
/** Bare specifiers the game page's import map provides, so no file has to be added for them. */
const MAPPED_PACKAGES = new Set(['three', 'three/webgpu', 'three/tsl']);
const MAX_ADDONS = 400;

/** Every `import`/`export … from` specifier in a module, in source order. */
export function importSpecifiers(source) {
  const specs = [];
  for (const match of String(source).matchAll(/^\s*import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/gm)) specs.push(match[1]);
  for (const match of String(source).matchAll(/\bexport\s+[^'"();]*?\s+from\s+['"]([^'"\n]+)['"]/g)) specs.push(match[1]);
  for (const match of String(source).matchAll(/\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g)) specs.push(match[1]);
  return specs;
}

/**
 * Where a module's import comes from, in the source tree.
 *
 * The game page sits at the build root, so a `/shared/x.js` import is the studio's `shared/x.js` and
 * a `/x.js` import is `public/x.js`. Anything absolute that is not one of those, and any npm package
 * the page does not map itself, would be a file the exported game could not serve: that is an error
 * here rather than a 404 in a player's browser.
 */
export function resolveGameImport(from, spec) {
  if (typeof spec !== 'string' || !spec) throw new Error(`Empty import in ${from}`);
  if (spec.startsWith('node:')) return { skip: 'node builtin' };
  // Addons are copied from the three package; the renderer and Rapier files are already in the
  // build, so an absolute URL to those needs no look-up.
  if (spec.startsWith('/vendor/three-addons/')) return { addon: spec.slice('/vendor/three-addons/'.length) };
  if (spec.startsWith('/vendor/three/') || spec.startsWith('/vendor/rapier/')) return { skip: 'vendor runtime' };
  if (spec.startsWith('/vendor/')) throw new Error(`${from} imports ${spec}, which no game build ships`);
  if (spec === '/shared' || spec.startsWith('/shared/')) return { source: `shared/${spec.slice('/shared/'.length)}` };
  if (spec.startsWith('/')) return { source: `public/${spec.slice(1)}` };
  if (spec.startsWith('.')) return { source: posix.normalize(posix.join(posix.dirname(from), spec)) };
  if (MAPPED_PACKAGES.has(spec)) return { skip: 'import map' };
  if (spec.startsWith(THREE_ADDON_PREFIX)) return { addon: spec.slice(THREE_ADDON_PREFIX.length) };
  throw new Error(`The game imports "${spec}" from ${from}, which an exported game cannot serve`);
}

/**
 * What a page loads from beside itself: its stylesheets and its module scripts.
 *
 * The page is the entry point, so its own references are the seeds — a stylesheet nobody links and
 * a module nobody imports stay out of the build for the same reason the editor does.
 */
function pageSeeds(html) {
  const seeds = [];
  for (const match of String(html).matchAll(/<script[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/gi)) seeds.push(match[1]);
  for (const match of String(html).matchAll(/<link[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/gi)) seeds.push(match[1]);
  return seeds.map(href => {
    if (/^[a-z]+:/i.test(href)) throw new Error(`A game page cannot load ${href}: it must ship with the build`);
    // `/x` is the build root (the studio's public folder); `./x` is the page's own folder.
    if (href.startsWith('/')) return `public/${href.slice(1)}`;
    return posix.normalize(posix.join(posix.dirname(`public/${GAME_PAGE}`), href));
  });
}

/**
 * The build path of a source file.
 *
 * The studio's public root becomes the game's root, and the player page is lifted out of its
 * `public/game/` folder to sit beside the engine modules it imports by absolute URL.
 */
export function gamePathFor(source) {
  if (source.startsWith('public/game/')) return source.slice('public/game/'.length);
  if (source.startsWith('public/')) return source.slice('public/'.length);
  return source;
}

function readModule(root, source) {
  const file = join(root, ...source.split('/'));
  if (!existsSync(file)) throw new Error(`The exported game needs ${source}, which is missing from the checkout`);
  return readFileSync(file);
}

/**
 * Every module the game page needs, transitively, as `[{ path, source, data }]`.
 *
 * This is what keeps the editor out of the build: a module no game file imports is simply not in the
 * list, so `app.js`, the scene editor and the panels cannot leak in by being in the same folder.
 */
export function gameModuleClosure(root, { entry = GAME_PAGE } = {}) {
  const page = `public/${entry}`;
  // The served page, whatever it links, and the server the launcher runs: the server is not imported
  // by the page, so its own imports have to be walked too — a module it gains (the port the game
  // keeps its storage on, for one) is otherwise missing from the build and the game does not start.
  const pending = [page, ...pageSeeds(readModule(root, page).toString('utf8')), 'server/game-serve.js'];
  const seen = new Map();
  const addons = new Set();
  while (pending.length) {
    const from = pending.shift();
    if (seen.has(from)) continue;
    const data = readModule(root, from);
    seen.set(from, data);
    if (!from.endsWith('.js')) continue;
    for (const spec of importSpecifiers(data.toString('utf8'))) {
      const resolved = resolveGameImport(from, spec);
      if (resolved.addon) { addons.add(resolved.addon); continue; }
      if (resolved.source) pending.push(resolved.source);
    }
  }
  // An addon pulls its own relative imports: `three/addons/…` files import each other by path.
  const addonRoot = join(root, 'node_modules', 'three', 'examples', 'jsm');
  const addonFiles = new Map();
  const addonQueue = [...addons];
  while (addonQueue.length) {
    const name = addonQueue.shift();
    if (addonFiles.has(name)) continue;
    const file = join(addonRoot, ...name.split('/'));
    if (!existsSync(file)) throw new Error(`The game needs the Three.js addon ${name}, which the installed three package does not have`);
    const data = readFileSync(file);
    addonFiles.set(name, data);
    if (addonFiles.size > MAX_ADDONS) throw new Error(`The game's Three.js addon graph exceeds ${MAX_ADDONS} files`);
    for (const spec of importSpecifiers(data.toString('utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(name), spec));
      if (target.startsWith('..')) throw new Error(`Unsafe Three.js addon import: ${name} -> ${spec}`);
      addonQueue.push(target);
    }
  }
  const files = [...seen].map(([from, data]) => ({ path: gamePathFor(from), source: from, data }));
  for (const [name, data] of addonFiles) files.push({ path: `vendor/three-addons/${name}`, data });
  return files;
}

/**
 * The vendor runtime the game page loads without an npm install: Three (the import map points at
 * these exact files) and Rapier, whose WebAssembly is embedded in the module.
 */
export function gameVendorFiles(root, { packagesDir = join(root, 'node_modules') } = {}) {
  const read = (directory, relative) => {
    const file = join(packagesDir, ...directory.split('/'), ...relative.split('/'));
    if (!existsSync(file)) throw new Error(`An exported game needs ${file}; install dependencies and export again`);
    return readFileSync(file);
  };
  return [
    ...THREE_BUILD_FILES.map(name => ({ path: `vendor/three/${name}`, data: read('three/build', name) })),
    { path: 'vendor/rapier/rapier.mjs', data: read('@dimforge/rapier3d-compat', 'rapier.mjs') },
  ];
}

/**
 * The project as files: a small document, the campaign and actor tables beside it, and one file per
 * asset. Asset `src` values become URLs the page can fetch — that is what takes a hundred-megabyte
 * JSON and turns it into a folder a person can browse.
 */
export function gameDataFiles(project, { revision = 0 } = {}) {
  const packed = packProject(project, { revision });
  const document = packed.document;
  for (const asset of document.project.assets || []) {
    if (typeof asset.file !== 'string' || !asset.file) continue;
    // The game page lives at the build root, so a payload is addressed from there.
    asset.src = `${GAME_DATA_DIRECTORY}/${asset.file}`;
    delete asset.file;
  }
  return {
    document,
    files: packed.files.map(file => ({ path: `${GAME_DATA_DIRECTORY}/${file.path}`, bytes: file.bytes })),
    assets: packed.assets,
    inline: packed.inline,
  };
}

/** What a game build says about itself in `build.json`, for the launcher and for a person. */
export function gameBuildLayout() {
  return {
    page: 'index.html',
    server: 'server/game-serve.js',
    data: `${GAME_DATA_DIRECTORY}/project.json`,
    document: `${GAME_DATA_DIRECTORY}/project.json`,
    assets: `${GAME_DATA_DIRECTORY}/assets`,
    modules: 'root and /shared (only what the game imports)',
    vendor: 'vendor/three, vendor/three-addons, vendor/rapier',
  };
}

/** A one-line description of what is in a game build, for the status line and the README. */
export function gameBuildSummary(files) {
  const bytes = files.reduce((sum, file) => sum + (file.data?.length || file.size || 0), 0);
  const assets = files.filter(file => file.path.startsWith(`${GAME_DATA_DIRECTORY}/assets/`)).length;
  return { files: files.length, bytes, assets };
}
