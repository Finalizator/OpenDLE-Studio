#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectStore } from './store.js';
import { readEngineVersion } from './version.js';
import { openLocalBrowser } from './browser.js';

const MAX_BODY = 128 * 1024 * 1024;
const LICENSE_ID = 'opendle-studio-commercial-1.0';
const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'], ['.md', 'text/markdown; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'],
  ['.wasm', 'application/wasm'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'],
  ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.wav', 'audio/wav'],
  ['.glb', 'model/gltf-binary'], ['.gltf', 'model/gltf+json'],
]);
// Three.js addons served by the studio are rewritten to the WebGL build, exactly as
// server/index.js does it, so portable builds render identically.
const REWRITTEN_ADDONS = new Set([
  'environments/RoomEnvironment.js', 'loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js',
]);

export function contentSecurityPolicy(html) {
  const hashes = [];
  for (const match of String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.push(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  }
  return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" +
    `${hashes.map(hash => ` ${hash}`).join('')}; style-src 'self'; img-src 'self' blob: data:; ` +
    "media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; " +
    "frame-ancestors 'none'; object-src 'none'; base-uri 'none'";
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left)), b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function resolveWithin(base, target) {
  if (target.includes('\0') || target.includes('\\')) return null;
  const resolved = resolve(base, `.${target.startsWith('/') ? target : `/${target}`}`);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) return null;
  return resolved;
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const error = new Error('Request is too large');
        error.status = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function createGameHandler({ root = bundleRoot, store, token, version, licenseText }) {
  if (!store) throw new Error('createGameHandler requires a project store');
  if (typeof token !== 'string' || !token) throw new Error('createGameHandler requires a session token');
  const publicDirectory = resolve(root, 'public');
  const sharedDirectory = resolve(root, 'shared');
  const indexHtml = readFileSync(resolve(publicDirectory, 'index.html'), 'utf8');
  const security = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': contentSecurityPolicy(indexHtml),
  };
  const license = { id: LICENSE_ID, text: licenseText, sha256: createHash('sha256').update(licenseText).digest('hex') };

  function sendJson(response, status, body) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    response.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, 'Cache-Control': 'no-store' });
    response.end(payload);
  }

  function sendFile(request, response, file, { rewriteThree = false } = {}) {
    const info = statSync(file, { throwIfNoEntry: false });
    if (!info?.isFile()) return sendJson(response, 404, { error: `Not found: ${request.url}` });
    let data = readFileSync(file);
    if (rewriteThree) data = Buffer.from(data.toString('utf8').replaceAll("from 'three'", "from '/vendor/three/three.module.js'"), 'utf8');
    const type = MIME_TYPES.get(extname(file).toLowerCase()) || 'application/octet-stream';
    response.writeHead(200, {
      ...security, 'Content-Type': type, 'Content-Length': data.length,
      'Cache-Control': extname(file) === '.html' ? 'no-store' : 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : data);
  }

  function authorized(request) {
    return sameSecret(request.headers.authorization || '', `Bearer ${token}`);
  }

  return async function handle(request, response) {
    const host = request.headers.host;
    if (!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      return sendJson(response, 403, { error: 'Only localhost access is supported' });
    }
    if ((request.headers.origin && request.headers.origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') {
      return sendJson(response, 403, { error: 'Cross-origin requests are not allowed' });
    }
    let url;
    try { url = new URL(request.url, `http://${host}`); }
    catch { return sendJson(response, 400, { error: 'Malformed request URL' }); }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return sendJson(response, 400, { error: 'Malformed request URL' }); }
    try {
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/session' && request.method === 'GET') {
          return sendJson(response, 200, { token, deepseekConfigured: false, model: '' });
        }
        if (pathname === '/api/health' && request.method === 'GET') {
          return sendJson(response, 200, { service: 'OpenDLE', version });
        }
        if (pathname === '/api/license' && request.method === 'GET') return sendJson(response, 200, license);
        if (!authorized(request)) return sendJson(response, 401, { error: 'A valid local bearer token is required' });
        if (pathname === '/api/project' && request.method === 'GET') return sendJson(response, 200, store.snapshot());
        if (pathname === '/api/project' && request.method === 'PUT') {
          const body = await readBody(request);
          let parsed;
          try { parsed = JSON.parse(body.toString('utf8')); }
          catch { return sendJson(response, 400, { error: 'Request body must be valid JSON' }); }
          const snapshot = store.update(parsed.project, parsed.revision);
          return sendJson(response, 200, snapshot);
        }
        if (pathname === '/api/open-browser' && request.method === 'POST') {
          return sendJson(response, 200, { url: `http://${host}/` });
        }
        if (pathname === '/api/wads' && request.method === 'GET') return sendJson(response, 200, { files: [] });
        if (pathname === '/api/packages' && request.method === 'GET') return sendJson(response, 200, { packages: [], wads: [] });
        return sendJson(response, 404, { error: `Unknown API endpoint: ${request.method} ${pathname}. Portable builds ship the game runtime only.` });
      }

      let file;
      if (pathname === '/' || pathname === '/index.html') {
        file = resolve(publicDirectory, 'index.html');
      } else if (pathname.startsWith('/shared/')) {
        file = resolveWithin(sharedDirectory, pathname.slice('/shared'.length));
      } else if (pathname.startsWith('/vendor/three-addons/')) {
        const inner = pathname.slice('/vendor/three-addons/'.length);
        file = resolveWithin(resolve(publicDirectory, 'vendor', 'three-addons'), `/${inner}`);
        if (file) return sendFile(request, response, file, { rewriteThree: REWRITTEN_ADDONS.has(inner) });
      } else {
        file = resolveWithin(publicDirectory, pathname);
      }
      if (!file) return sendJson(response, 404, { error: `Not found: ${pathname}` });
      const info = statSync(file, { throwIfNoEntry: false });
      if (info?.isDirectory()) return sendFile(request, response, join(file, 'index.html'));
      return sendFile(request, response, file);
    } catch (error) {
      const status = error.status || 400;
      return sendJson(response, status, { error: status === 413 ? 'Request is too large' : error.message });
    }
  };
}

function defaultSpawn(command, args) {
  return new Promise(resolveSpawn => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', error => resolveSpawn(error));
    child.once('spawn', () => {
      child.unref();
      resolveSpawn(null);
    });
  });
}

export function chromiumCandidates(platform = process.platform, env = process.env) {
  if (env.OPENDLE_BROWSER) return [env.OPENDLE_BROWSER];
  if (platform === 'win32') {
    const home = env.USERPROFILE || homedir(), candidates = [];
    for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (!base) continue;
      candidates.push(
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      );
    }
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'));
    candidates.push(join(home, 'scoop', 'apps', 'googlechrome', 'current', 'chrome.exe'));
    return [...candidates, 'chrome.exe', 'msedge.exe', 'brave.exe'];
  }
  if (platform === 'darwin') {
    const home = env.HOME || homedir();
    return [
      join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      'google-chrome', 'chromium', 'microsoft-edge',
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
}

export async function openInAppWindow(url, { platform = process.platform, env = process.env, spawnImpl = defaultSpawn } = {}) {
  const failures = [];
  for (const candidate of chromiumCandidates(platform, env)) {
    if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) {
      failures.push(`${candidate} (not installed)`);
      continue;
    }
    const error = await spawnImpl(candidate, [`--app=${url}`, '--no-first-run', '--no-default-browser-check']);
    if (!error) return { opened: true, command: candidate, failures };
    failures.push(`${candidate} (${error.code || error.message})`);
  }
  return { opened: false, failures };
}

function writable(file) {
  try {
    closeSync(openSync(file, 'a'));
    return true;
  } catch { return false; }
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

export function resolveDataFile(root = bundleRoot, env = process.env) {
  const bundled = join(root, 'data', 'project.json');
  if (!existsSync(bundled)) throw new Error('This build is incomplete: data/project.json is missing.');
  const useDirectory = directory => {
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'project.json');
    if (!existsSync(file)) copyFileSync(bundled, file);
    return file;
  };
  if (env.OPENDLE_DATA_DIR) return useDirectory(resolve(env.OPENDLE_DATA_DIR));
  if (writable(bundled)) return bundled;
  return useDirectory(join(homedir(), '.opendle-games', safeName(basename(root))));
}

function parsePort(value) {
  if (value === undefined || value === '') return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535');
  return port;
}

export async function startGame({
  root = bundleRoot, port = 0, env = process.env, dataFile = resolveDataFile(root, env),
  platform = process.platform, log = console.log, openInApp = openInAppWindow, openDefault = openLocalBrowser,
} = {}) {
  const version = readEngineVersion(join(root, 'version.ini'));
  const licenseText = readFileSync(join(root, 'LICENSE'), 'utf8');
  const store = new ProjectStore(dataFile);
  const token = randomBytes(32).toString('hex');
  const server = createServer(createGameHandler({ root, store, token, version, licenseText }));
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  log(`OpenDLE game: ${url}`);
  log(`Project: ${store.snapshot().project.title}`);
  log(`Saves: ${dataFile}`);
  log('Press Ctrl+C to stop the game server.');
  if (env.OPENDLE_NO_BROWSER !== '1') {
    const app = await openInApp(url, { platform, env });
    if (!app.opened) {
      log('No Chromium-based browser was found, so the game is opening in your default browser.');
      try {
        await openDefault(url);
      } catch (error) {
        log(`The default browser could not be opened either (${error.message}).`);
      }
      log('Install Google Chrome, Microsoft Edge, Brave or Chromium for a native-looking game window,');
      log(`or open this address yourself: ${url}`);
    }
  }
  return { server, url, store, token, dataFile };
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    console.error('This OpenDLE game requires Node.js 22 or newer. Install it from https://nodejs.org/ and try again.');
    process.exitCode = 1;
    return;
  }
  try {
    const { server } = await startGame({ port: parsePort(process.env.PORT) });
    const stop = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    console.error(`OpenDLE could not start this game: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
