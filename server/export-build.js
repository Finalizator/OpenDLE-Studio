import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { validateProject } from '../shared/project.js';

const MiB = 1024 * 1024;
export const BUILD_MAX_BYTES = 128 * MiB;
export const BUILD_MAX_FILES = 10000;
/** A bundled build also carries Electron - its own Node.js and Chromium - so it is far larger. */
export const BUILD_BUNDLED_MAX_BYTES = 768 * MiB;
export const BUILD_BUNDLED_MAX_FILES = 14000;
/** The project itself is bounded the same way whichever runtime carries it. */
const PROJECT_MAX_BYTES = BUILD_MAX_BYTES;
const DEFAULT_LIMITS = {
  portable: { maxBytes: BUILD_MAX_BYTES, maxFiles: BUILD_MAX_FILES },
  bundled: { maxBytes: BUILD_BUNDLED_MAX_BYTES, maxFiles: BUILD_BUNDLED_MAX_FILES },
};
const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Server modules that only use Node built-ins plus bundled engine code. Everything else
// (the studio HTTP server, MCP tools and importers) needs npm packages and is excluded.
const SERVER_MODULES = ['browser.js', 'export-launcher.js', 'store.js', 'project-folder.js', 'version.js'];
const THREE_BUILD_FILES = ['three.core.js', 'three.module.js', 'three.tsl.js', 'three.webgpu.js'];
const THREE_ADDON_SEEDS = [
  'environments/RoomEnvironment.js',
  'loaders/GLTFLoader.js',
  'transpiler/GLSLDecoder.js',
  'transpiler/TSLEncoder.js',
  'transpiler/Transpiler.js',
  'utils/BufferGeometryUtils.js',
  'utils/SkeletonUtils.js',
];
const MAX_THREE_ADDONS = 200;
const PLATFORM_TARGETS = new Map([
  ['win32', 'windows'], ['windows', 'windows'],
  ['darwin', 'macos'], ['macos', 'macos'], ['mac', 'macos'],
  ['linux', 'linux'],
  ['all', 'portable'], ['universal', 'portable'], ['portable', 'portable'],
]);

function check(value, message) {
  if (!value) throw new Error(message);
}

export function assertSafeBuildPath(path) {
  check(typeof path === 'string' && path.length > 0 && path.length <= 512, `Unsafe build path: ${path}`);
  check(!path.includes('\\'), `Unsafe build path uses a backslash: ${path}`);
  check(!path.includes('\0') && !/[\u0000-\u001f\u007f]/.test(path), `Unsafe build path uses control characters: ${path}`);
  check(!path.startsWith('/') && !/^[A-Za-z]:/.test(path), `Unsafe build path is absolute: ${path}`);
  check(!path.includes('//') && !path.endsWith('/'), `Unsafe build path has an empty segment: ${path}`);
  check(path.split('/').every(part => part !== '' && part !== '.' && part !== '..'), `Unsafe build path has a traversal segment: ${path}`);
  return path;
}

export function slugifyTitle(title) {
  const slug = String(title ?? '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return slug || 'opendle-game';
}

function checkVersion(version) {
  const text = typeof version === 'string' ? version.trim() : '';
  check(text.length > 0 && text.length <= 128 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text),
    'Portable build version must be SemVer, for example 0.1.0');
  return text;
}

/** Electron ships Windows and Linux distributions this build can carry; see electron-runtime.js. */
function checkBundledTarget(target) {
  check(target === 'windows' || target === 'linux',
    `A bundled build can be made for Windows or Linux. ${target === 'macos'
      ? 'macOS needs a signed .app bundle, which this build cannot produce; export a portable build for macOS.'
      : `Use windows or linux, not ${target}.`}`);
  return target;
}

function checkPlatform(platform) {
  const target = PLATFORM_TARGETS.get(typeof platform === 'string' ? platform.trim().toLowerCase() : platform);
  check(target, `Unsupported export platform: ${platform}. Use windows, macos, linux or portable.`);
  return target;
}

/**
 * What the exported game runs on.
 *
 * `portable` is a folder that needs Node.js and a browser already installed. `bundled`
 * carries Electron with the game, so a machine with neither just runs the executable.
 */
const RUNTIMES = new Map([['portable', 'portable'], ['node', 'portable'], ['bundled', 'bundled'], ['app', 'bundled']]);

function checkRuntime(runtime) {
  const name = RUNTIMES.get(String(runtime ?? '').trim().toLowerCase());
  check(name, `Unsupported export runtime: ${runtime}. Use portable or bundled.`);
  return name;
}

function checkDate(now) {
  check(now instanceof Date && Number.isFinite(now.getTime()), 'Portable build export date must be a valid Date');
  check(now.getUTCFullYear() >= 1980 && now.getUTCFullYear() <= 2107, 'Portable build export date must be between 1980 and 2107');
  return now;
}

function checkLimits(limits, runtime = 'portable') {
  const bounds = { ...DEFAULT_LIMITS[runtime], ...limits };
  for (const key of ['maxBytes', 'maxFiles']) {
    check(Number.isSafeInteger(bounds[key]) && bounds[key] > 0, `Portable build limit ${key} must be a positive integer`);
  }
  return bounds;
}

export function importSpecifiers(source) {
  const specs = new Set();
  for (const pattern of [
    /\bimport\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\bexport\s+[^'"();]*?\s+from\s+['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) specs.add(match[1]);
  }
  return [...specs];
}

/**
 * The mode a copied file gets in the zip.
 *
 * Only two outcomes matter: something the operating system will run, and everything else.
 * The source is often 0777 — unwrapped archives are like that — and shipping that verbatim
 * would hand every player a world-writable game folder for no reason.
 */
function fileMode(file) {
  let mode = 0o644;
  try { mode = statSync(file).mode & 0o777; }
  catch { return 0o644; }
  return mode & 0o111 ? 0o755 : 0o644;
}

function readSource(file) {
  check(existsSync(file), `Missing portable build source: ${file}. Install dependencies and run the export from a full OpenDLE checkout.`);
  return readFileSync(file);
}

function listFiles(directory, prefix = '', depth = 0) {
  check(depth <= 8, `Portable build source directory is too deep: ${directory}`);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isSymbolicLink()) throw new Error(`Portable build sources must not contain symlinks: ${join(directory, entry.name)}`);
    if (entry.isDirectory()) {
      if (!prefix && entry.name === 'vendor') continue;
      files.push(...listFiles(join(directory, entry.name), `${prefix}${entry.name}/`, depth + 1));
    } else if (entry.isFile()) files.push(`${prefix}${entry.name}`);
  }
  return files;
}

function collectThreeAddons(nodeModules) {
  const addonRoot = join(nodeModules, 'three', 'examples', 'jsm');
  const files = new Map();
  const pending = [...THREE_ADDON_SEEDS];
  while (pending.length) {
    const name = pending.shift();
    if (files.has(name)) continue;
    files.set(name, readSource(join(addonRoot, name)));
    check(files.size <= MAX_THREE_ADDONS, `Three.js addon dependency graph exceeds ${MAX_THREE_ADDONS} files`);
    for (const spec of importSpecifiers(files.get(name).toString('utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(name), spec));
      check(!target.startsWith('..') && !posix.isAbsolute(target), `Unsafe Three.js addon import: ${name} -> ${spec}`);
      pending.push(target);
    }
  }
  return [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function createCollector(limits) {
  const files = new Map();
  let total = 0;
  return {
    add(path, contents, mode = 0o644) {
      assertSafeBuildPath(path);
      check(!files.has(path), `Duplicate portable build path: ${path}`);
      const data = Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents), 'utf8');
      check(files.size + 1 <= limits.maxFiles, `OpenDLE portable build exceeds the ${limits.maxFiles} file limit`);
      total += data.length;
      check(total <= limits.maxBytes, `OpenDLE portable build exceeds the ${limits.maxBytes} byte limit`);
      files.set(path, { path, data, mode });
    },
    get total() { return total; },
    entries() { return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); },
  };
}

function projectDocument(projectJson, project, maxBytes) {
  let value;
  if (projectJson === undefined || projectJson === null) {
    check(project && typeof project === 'object' && !Array.isArray(project), 'Portable builds need a project or projectJson');
    value = project;
  } else if (typeof projectJson === 'string') {
    check(Buffer.byteLength(projectJson, 'utf8') <= maxBytes, `OpenDLE portable build exceeds the ${maxBytes} byte limit`);
    try { value = JSON.parse(projectJson); }
    catch (error) { throw new Error(`Exported project JSON is invalid: ${error.message}`); }
  } else {
    check(typeof projectJson === 'object' && !Array.isArray(projectJson) && !Buffer.isBuffer(projectJson),
      'projectJson must be an exported project JSON string or object');
    value = projectJson;
  }
  check(value && typeof value === 'object' && !Array.isArray(value), 'Exported project document must be a JSON object');
  const document = Object.hasOwn(value, 'project') && Object.hasOwn(value, 'revision')
    ? { project: value.project, revision: checkRevision(value.revision) }
    : { project: value, revision: 0 };
  try { validateProject(document.project); }
  catch (error) { throw new Error(`Exported project is invalid: ${error.message}`); }
  return document;
}

function checkRevision(revision) {
  check(Number.isSafeInteger(revision) && revision >= 0, 'Exported project revision must be a non-negative integer');
  return revision;
}

function projectTitle(project, documentProject) {
  const raw = (project && typeof project.title === 'string' && project.title.trim())
    || (typeof documentProject.title === 'string' && documentProject.title.trim()) || '';
  const title = String(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 100);
  return title || 'OpenDLE game';
}

/**
 * The URL the game serves a bundled file from, or null for a file it does not serve.
 *
 * `appRoot` is where the client and the engine modules sit in the build — the bundle root
 * for a portable build, and `resources/app` for one that carries Electron.
 */
function urlPathFor(path, appRoot) {
  const prefix = `${appRoot}/`;
  if (!path.startsWith(prefix)) return null;
  const rel = path.slice(prefix.length);
  if (rel.startsWith('public/')) return `/${rel.slice('public/'.length)}`;
  if (rel.startsWith('shared/') || rel.startsWith('server/')) return `/${rel}`;
  if (rel === 'main.js') return '/main.js';
  return null;
}

function validateBundleImports(entries, appRoot) {
  const urls = new Map();
  for (const entry of entries) {
    const url = urlPathFor(entry.path, appRoot);
    if (url) urls.set(url, entry);
  }
  const entryFile = `${appRoot}/main.js`;
  for (const entry of entries) {
    const from = urlPathFor(entry.path, appRoot);
    if (!from || !entry.path.endsWith('.js') || entry.path.includes('/public/vendor/')) continue;
    for (const spec of importSpecifiers(entry.data.toString('utf8'))) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        // `electron` is the shell itself, and only the desktop entry point may ask for it.
        if (entry.path === entryFile && spec === 'electron') continue;
        check(!entry.path.includes('/server/') && entry.path !== entryFile,
          `Bundled server module ${entry.path} imports "${spec}", which needs npm packages. Exclude the module or vendor the dependency.`);
        continue;
      }
      const target = spec.startsWith('/') ? spec : posix.resolve(posix.dirname(from), spec);
      check(urls.has(target), `Bundled module ${entry.path} imports ${spec}, which is missing from the portable build`);
    }
  }
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function readmeText({ title, slug, engineVersion, target, exportDate, runtime = 'portable', executable = null }) {
  if (runtime === 'bundled') return bundledReadme({ title, slug, engineVersion, target, exportDate, executable });
  return `# ${title}

Portable OpenDLE game build. Exported ${exportDate} with OpenDLE: Studio ${engineVersion} for ${target}.

## Requirements

- **Node.js 22 or newer** on your \`PATH\`. The launcher runs this build with the
  Node.js you already have installed; no Node.js runtime is included here and no
  \`npm install\` is needed. Get Node.js from https://nodejs.org/ and check it with
  \`node --version\`.
- **A Chromium-based browser** (Google Chrome, Microsoft Edge, Brave or Chromium).
  The launcher opens the game with \`--app=\`, which gives a native-looking window
  without browser toolbars. Without one, the game opens in your default browser
  and the terminal prints the address so you can copy it.

The engine code, shared modules and browser renderer assets are already inside this
folder, so the game runs offline on the local machine.

## Play

- **Windows:** double-click \`launch.cmd\`.
- **macOS and Linux:** run \`./launch.sh\` from a terminal.

The launcher starts a private server on a free \`127.0.0.1\` port and opens the game
window. Closing the terminal, or pressing Ctrl+C in it, stops the game server.
Set \`PORT\` to force a port, or \`OPENDLE_NO_BROWSER=1\` to start the server without
opening a window.

## What is inside

| Path | Contents |
| --- | --- |
| \`launch.cmd\`, \`launch.sh\` | Start scripts for Windows and macOS/Linux |
| \`server/export-launcher.js\` | Dependency-free local server and browser launcher |
| \`server/store.js\`, \`server/version.js\`, \`server/browser.js\` | Project storage, version and app-window/default-browser helpers |
| \`shared/\` | Engine modules shared by the runtime and the game |
| \`public/\` | Game client, styles and bundled \`public/vendor\` renderer assets |
| \`data/project.json\` | The exported project; saves are written back here |
| \`build.json\` | Build manifest: engine version, project title, export date and file list |
| \`LICENSE\` | OpenDLE: Studio license that travels with the engine runtime |
| \`licenses/\` | Third-party notices for the bundled browser assets |

## Limitations

- This is not a single executable: it needs Node.js 22+ and a browser installed.
  No Node.js runtime, installer or code-signing is bundled.
- The local server listens only on \`127.0.0.1\`, requires a fresh bearer token on
  every launch and rejects cross-origin requests. It is single-player only; there
  is no network or multiplayer support.
- AI assistance and MCP tooling are studio features and are unavailable here.
- Saves are written to \`data/project.json\`. When this folder is read-only (for
  example under Program Files) the launcher keeps saves in
  \`~/.opendle-games/${slug}/project.json\` instead.
- Redistribution follows \`LICENSE\`: shipping the OpenDLE runtime with your game is
  permitted, and this license must travel with the build. The editor client doubles
  as the game shell here, so redistributing this build as an engine or editor
  product is not permitted.
`;
}

/** A file name a person can double-click: the title, minus what a file system refuses. */
function gameExecutableName(title, target) {
  const safe = String(title).replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64).replace(/[. ]+$/, '');
  return `${safe || 'OpenDLE game'}${target === 'windows' ? '.exe' : ''}`;
}

/**
 * The Electron entry point of a bundled build.
 *
 * It starts the very same game server a portable build's launcher starts — the handler,
 * the token, the CSP and the save format are shared code — and then shows it in a window
 * instead of an outside browser. Everything the studio's own desktop shell learned about
 * closing without losing edits applies here too: this window is the only place the game
 * can be saved, so it must not refuse to close and must not close silently.
 */
function electronMainScript({ title, slug }) {
  return `import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import { join } from 'node:path';
import { startGame } from './server/export-launcher.js';

const TITLE = ${JSON.stringify(title)};
const SLUG = ${JSON.stringify(slug)};
const permissions = new Set(['pointerLock', 'fullscreen', 'keyboardLock', 'clipboard-sanitized-write']);

// The window title, the paths and the folder saves live in all come from one name, set
// before Electron resolves any of them.
app.setName(TITLE);
app.setPath('userData', join(app.getPath('appData'), SLUG));

let gameWindow = null, closing = false, savedForClose = false;

if (!app.requestSingleInstanceLock()) {
  // A second double-click focuses the game already running instead of starting a second one.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!gameWindow || gameWindow.isDestroyed()) return;
    if (gameWindow.isMinimized()) gameWindow.restore();
    gameWindow.show();
    gameWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  start().catch(error => {
    console.error(\`\${TITLE} could not start: \${error.message}\`);
    dialog.showErrorBox(\`\${TITLE} could not start\`, error.message);
    app.exit(1);
  });
}

async function start() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  // OPENDLE_NO_BROWSER stops the shared launcher opening an outside browser: the window
  // below is the game. Saves land in this app's own data folder, which is always writable,
  // unlike the folder the game was unzipped into.
  const game = await startGame({
    env: { ...process.env, OPENDLE_NO_BROWSER: '1', OPENDLE_DATA_DIR: join(app.getPath('userData'), 'data') },
    log: () => {},
  });
  gameWindow = new BrowserWindow({
    title: TITLE, width: 1280, height: 800, minWidth: 960, minHeight: 600,
    backgroundColor: '#101418', show: false, autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  gameWindow.once('ready-to-show', () => gameWindow.show());
  gameWindow.on('closed', () => { gameWindow = null; });

  gameWindow.on('close', event => {
    if (savedForClose) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    saveBeforeClose()
      .then(done => {
        if (!done) return;
        savedForClose = true;
        if (gameWindow && !gameWindow.isDestroyed()) gameWindow.close();
      })
      .finally(() => { closing = false; });
  });

  const current = gameWindow.webContents.session;
  current.setPermissionRequestHandler((contents, permission, callback) => callback(permissions.has(permission)));
  current.setPermissionCheckHandler(() => false);
  const external = target => {
    if (target.startsWith('http://') || target.startsWith('https://')) shell.openExternal(target).catch(() => {});
  };
  gameWindow.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  const navigate = (event, target) => {
    if (!target.startsWith(game.url)) { event.preventDefault(); external(target); }
  };
  gameWindow.webContents.on('will-navigate', navigate);
  gameWindow.webContents.on('will-redirect', navigate);
  await gameWindow.loadURL(game.url);
}

/** Saves through the page, and answers whether closing may continue. */
async function saveBeforeClose() {
  if (!gameWindow || gameWindow.isDestroyed()) return true;
  try {
    const saved = await gameWindow.webContents.executeJavaScript(
      'typeof window.opendleSaveBeforeClose === "function" ? window.opendleSaveBeforeClose() : true');
    if (saved === true) return true;
    return offerClose('The project still has unsaved changes.');
  } catch (error) {
    return offerClose(error.message);
  }
}

/**
 * Offers to close anyway, and says what that costs: a campaign too large for browser
 * storage has no draft, so promising one would be a lie.
 */
async function offerClose(reason) {
  if (!gameWindow || gameWindow.isDestroyed()) return false;
  const backedUp = await gameWindow.webContents.executeJavaScript(
    'typeof window.opendleUnsavedEditsAreBackedUp === "function" ? window.opendleUnsavedEditsAreBackedUp() : false',
  ).catch(() => false);
  const choice = dialog.showMessageBoxSync(gameWindow, {
    type: 'warning', title: 'Unsaved changes',
    message: 'The project could not be saved, so the game was kept open.',
    detail: \`\${reason}\n\n\${backedUp
      ? 'Close anyway? Your unsaved edits stay in the browser draft and are offered back the next time this game is opened.'
      : 'Close anyway? These edits are not kept anywhere else and will be lost.'}\`,
    buttons: ['Keep playing', 'Close without saving'], defaultId: 0, cancelId: 0,
  });
  if (choice !== 1) { console.error(\`\${TITLE}: \${reason}\`); return false; }
  await gameWindow.webContents.executeJavaScript('window.opendleCloseWithoutSaving = true').catch(() => {});
  return true;
}
`;
}

/** The Electron app manifest: enough for the runtime to find its entry point. */
function electronAppManifest({ title, slug, engineVersion }) {
  return `${JSON.stringify({
    name: slug, productName: title, version: engineVersion, private: true, type: 'module', main: 'main.js',
  }, null, 2)}\n`;
}

/** Starts the bundled executable; the mode is repaired when an unzip tool drops it. */
function bundledLaunchUnix(executable) {
  return `#!/bin/sh
set -eu
cd "$(dirname "$0")"
[ -x "./${executable}" ] || chmod +x "./${executable}"
exec "./${executable}" "$@"
`;
}

function bundledLaunchWindows(executable) {
  return `@echo off
cd /d "%~dp0"
if not exist "${executable}" (
  echo ${executable} is missing from this folder. Unzip the whole download before playing.
  pause
  exit /b 1
)
start "" "${executable}"
`;
}

/**
 * The README of a build that carries its own runtime.
 *
 * It says nothing about installing anything, because there is nothing to install — that is
 * the whole point of this build — and it says where saves go, because they do not land in
 * the folder the game was unzipped into.
 */
function bundledReadme({ title, slug, engineVersion, target, exportDate, executable }) {
  const windows = target === 'windows';
  const savePath = windows ? `%APPDATA%\\${slug}\\data\\project.json` : `~/.config/${slug}/data/project.json`;
  return `# ${title}

Standalone OpenDLE game. Exported ${exportDate} with OpenDLE: Studio ${engineVersion} for ${target}.

Nothing has to be installed: this folder carries its own runtime (Electron, which includes
Node.js and the Chromium browser the game draws with). No Node.js, no npm, no browser
download, and no internet connection is needed to play.

## Play

${windows
    ? `- **Double-click \`${executable}\`** (or \`launch.cmd\`).`
    : `- **Run \`./launch.sh\`**, or \`./${executable}\` directly. Unzip the whole folder first:
  the game needs the files beside the executable.`}

Nothing else in this folder has to be opened, moved or configured.

## Where the game is kept

- **The game itself:** \`resources/app\` — the client, the engine modules and
  \`data/project.json\` with every texture, sprite, sound and level inside it.
- **Saves:** \`${savePath}\` — outside the unzipped folder, so replacing the game with a
  newer build does not lose your progress, and the game still saves when it is installed
  somewhere read-only.

## What is inside

| Path | Contents |
| --- | --- |
| \`${executable}\` | The game: Electron with this project inside it |
| \`${windows ? 'launch.cmd' : 'launch.sh'}\` | The start script for this build |
| \`resources/app/server/export-launcher.js\` | The local game server |
| \`resources/app/shared/\`, \`resources/app/public/\` | Engine modules and the game client |
| \`resources/app/data/project.json\` | The exported project; this is the copy the game opens |
| \`build.json\` | Build manifest: engine version, Electron version, export date, every file and its SHA-256 |
| \`LICENSE\`, \`LICENSES.chromium.html\` | The OpenDLE: Studio license and the runtime's own notices |

## Limits

- Single-player only. The local server listens on \`127.0.0.1\` with a fresh token on every
  launch and rejects cross-origin requests; there is no network or multiplayer support.
- AI assistance and MCP tooling are studio features and are absent here.
- The window is the same client the studio uses, so the project can also be edited in this
  build. Redistribution follows \`LICENSE\`: shipping the OpenDLE runtime with your game is
  permitted and this license must travel with it; redistributing the build as an engine or
  editor product is not.
`;
}

function launchScriptWindows() {
  return `@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo This OpenDLE game requires Node.js 22 or newer.
  echo Install it from https://nodejs.org/ and run launch.cmd again.
  pause
  exit /b 1
)
node "server\\export-launcher.js"
if errorlevel 1 pause
`;
}

function launchScriptUnix() {
  return `#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || {
  printf 'This OpenDLE game requires Node.js 22 or newer.\\nInstall it from https://nodejs.org/ and run ./launch.sh again.\\n' >&2
  exit 1
}
exec node server/export-launcher.js
`;
}

function noticeText() {
  return `OpenDLE portable build: third-party browser runtime assets
=========================================================

The following libraries are bundled under public/vendor so the exported game can
render without an npm install. They are not part of the OpenDLE engine.

Electron - MIT License (bundled runtime builds only)
  Source: https://github.com/electron/electron
  Bundled files: the runtime beside resources/app, including LICENSES.chromium.html
  and LICENSE at the top of this folder. Electron carries Chromium, which ships with
  its own notices there.

three.js (r180) - MIT License
  Source: https://github.com/mrdoob/three.js
  Bundled files: public/vendor/three/*, public/vendor/three-addons/*
  License text: licenses/three-LICENSE.txt

Rapier 3D (@dimforge/rapier3d-compat 0.19.3) - Apache License 2.0
  Source: https://github.com/dimforge/rapier.js
  Bundled files: public/vendor/rapier/rapier.mjs (WebAssembly module embedded)
  License text: https://www.apache.org/licenses/LICENSE-2.0
`;
}

function dosTimestamp(date) {
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export function createZipArchive(entries, when) {
  check(typeof zlib.crc32 === 'function', 'Portable builds need Node.js 22.2 or newer for CRC-32 support');
  check(entries.length <= 0xffff, 'ZIP entry count exceeds 65535');
  const stamp = dosTimestamp(when), local = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    check(entry.data.length <= 0xffffffff, `ZIP entry is too large: ${entry.path}`);
    const name = Buffer.from(entry.path, 'utf8');
    check(name.length <= 0xffff, `ZIP entry name is too long: ${entry.path}`);
    const crc = zlib.crc32(entry.data) >>> 0;
    const packed = zlib.deflateRawSync(entry.data, { level: 9 });
    const method = packed.length < entry.data.length ? 8 : 0;
    const body = method === 8 ? packed : entry.data;
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(stamp.time, 12);
    directory.writeUInt16LE(stamp.date, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(((0o100000 | entry.mode) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, body);
    central.push(directory, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  check(offset <= 0xffffffff && directory.length <= 0xffffffff, 'Portable build archive exceeds the ZIP size limit');
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, directory, end]);
}

export async function createPortableBuild({
  project, projectJson, version, platform = 'portable', runtime = 'portable',
  now = new Date(), root = engineRoot, limits = {}, electronDist = null, electronVersion = null,
} = {}) {
  const kind = checkRuntime(runtime);
  const bounds = checkLimits(limits, kind);
  const target = checkPlatform(platform);
  if (kind === 'bundled') checkBundledTarget(target);
  const engineVersion = checkVersion(version);
  const exportedAt = checkDate(now);
  check(typeof zlib.crc32 === 'function', 'Portable builds need Node.js 22.2 or newer for CRC-32 support');
  // The project is bounded by its own cap, and by a caller's smaller one when it sets one.
  const document = projectDocument(projectJson, project, Math.min(PROJECT_MAX_BYTES, bounds.maxBytes));
  const title = projectTitle(project, document.project);
  const slug = slugifyTitle(title);
  const nodeModules = join(root, 'node_modules');
  const collector = createCollector(bounds);
  for (const directory of ['server', 'shared', 'public']) {
    check(existsSync(join(root, directory)), `Missing portable build source directory: ${directory}`);
  }
  if (kind === 'bundled') {
    check(typeof electronDist === 'string' && existsSync(join(electronDist, 'version')),
      'A bundled build needs an unpacked Electron runtime. Call resolveDist() from server/electron-runtime.js and pass its directory as electronDist.');
  }

  // A bundled build is an Electron app, so the game sits in `resources/app` beside the
  // runtime the way Electron looks for it; a portable build is served from its own root.
  const appRoot = kind === 'bundled' ? `${slug}/resources/app` : slug;
  const add = (relative, contents, mode) => collector.add(`${appRoot}/${relative}`, contents, mode);

  for (const name of SERVER_MODULES) add(`server/${name}`, readSource(join(root, 'server', name)));
  for (const name of readdirSync(join(root, 'shared')).filter(name => name.endsWith('.js')).sort()) {
    add(`shared/${name}`, readSource(join(root, 'shared', name)));
  }
  for (const name of listFiles(join(root, 'public'))) {
    add(`public/${name}`, readSource(join(root, 'public', name)));
  }
  for (const name of THREE_BUILD_FILES) {
    add(`public/vendor/three/${name}`, readSource(join(nodeModules, 'three', 'build', name)));
  }
  add('public/vendor/rapier/rapier.mjs', readSource(join(nodeModules, '@dimforge', 'rapier3d-compat', 'rapier.mjs')));
  for (const [name, source] of collectThreeAddons(nodeModules)) {
    add(`public/vendor/three-addons/${name}`, source);
  }
  add('licenses/three-LICENSE.txt', readSource(join(nodeModules, 'three', 'LICENSE')));
  add('licenses/THIRD-PARTY-NOTICES.txt', noticeText());
  add('version.ini', `[engine]\nversion=${engineVersion}\n`);
  add('data/project.json', `${JSON.stringify(document)}\n`);
  add('LICENSE', readSource(join(root, 'LICENSE')));

  const executable = kind === 'bundled' ? gameExecutableName(title, target) : null;
  if (kind === 'bundled') {
    // The runtime is copied as Electron ships it; only the executable is renamed so the
    // unzipped folder reads as a game rather than as a browser. `default_app.asar` is left
    // out: it is the placeholder app Electron shows when it was not given one.
    for (const name of listFiles(electronDist)) {
      if (name === 'resources/default_app.asar' || name.startsWith('.complete')) continue;
      const renamed = name === 'electron' || name === 'electron.exe' ? executable : name;
      // The runtime sits beside `resources/`, not inside it, so these bypass the app prefix.
      collector.add(`${slug}/${renamed}`, readSource(join(electronDist, name)), fileMode(join(electronDist, name)));
    }
    add('main.js', electronMainScript({ title, slug }));
    add('package.json', electronAppManifest({ title, slug, engineVersion }));
    // One launcher, for the platform the runtime was built for: a shell script inside a Windows
    // build would only be a file that cannot run.
    if (target === 'windows') collector.add(`${slug}/launch.cmd`, bundledLaunchWindows(executable), 0o644);
    else collector.add(`${slug}/launch.sh`, bundledLaunchUnix(executable), 0o755);
  } else {
    collector.add(`${slug}/launch.cmd`, launchScriptWindows());
    collector.add(`${slug}/launch.sh`, launchScriptUnix(), 0o755);
  }
  collector.add(`${slug}/README.md`, readmeText({
    title, slug, engineVersion, target, exportDate: exportedAt.toISOString(), runtime: kind, executable,
  }));

  validateBundleImports(collector.entries(), appRoot);

  const listed = collector.entries();
  const manifest = {
    format: kind === 'bundled' ? 'opendle-bundled-build/1' : 'opendle-portable-build/1',
    engine: { name: 'OpenDLE: Studio', version: engineVersion },
    project: { title, slug },
    exportDate: exportedAt.toISOString(),
    target,
    runtime: kind === 'bundled'
      ? { kind, electron: electronVersion || null, application: `${appRoot}/main.js`, executable: `${slug}/${executable}` }
      : { kind },
    manifest: `${slug}/build.json`,
    entry: {
      page: `${appRoot}/public/index.html`,
      server: `${appRoot}/server/export-launcher.js`,
      data: `${appRoot}/data/project.json`,
    },
    launchers: kind === 'bundled'
      ? { [target]: `${slug}/${target === 'windows' ? 'launch.cmd' : 'launch.sh'}` }
      : { windows: `${slug}/launch.cmd`, unix: `${slug}/launch.sh` },
    requirements: kind === 'bundled'
      ? { install: 'nothing: the game carries its own runtime', os: target === 'windows' ? 'Windows 10 or newer' : 'Linux (x64)' }
      : { node: '>=22.2', browser: 'Chromium-based browser for app mode; other browsers open in a tab' },
    fileCount: listed.length,
    totalBytes: listed.reduce((sum, entry) => sum + entry.data.length, 0),
    files: listed.map(entry => ({ path: entry.path, size: entry.data.length, sha256: sha256(entry.data) })),
  };
  collector.add(`${slug}/build.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  const entries = collector.entries();
  for (const entry of entries) assertSafeBuildPath(entry.path);
  return {
    filename: `${slug}-${engineVersion}-${target}${kind === 'bundled' ? '-app' : ''}.zip`,
    bytes: createZipArchive(entries, exportedAt),
    files: entries.map(entry => ({ path: entry.path, size: entry.data.length })),
    manifest,
  };
}
