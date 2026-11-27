#!/usr/bin/env node
// The server an exported game ships with.
//
// It serves the game folder over HTTP — ES modules, WebAssembly and pointer lock all need a real
// origin — and opens a browser window on it. Nothing else: no editor, no project store, no APIs.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { gamePortCandidates, gamePortFor } from './game-port.js';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'],
  ['.tga', 'image/tga'],
  ['.wasm', 'application/wasm'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
  ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.opus', 'audio/opus'], ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'], ['.m4a', 'audio/mp4'], ['.mid', 'audio/midi'], ['.mus', 'audio/x-mus'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
  ['.glb', 'model/gltf-binary'], ['.gltf', 'model/gltf+json'], ['.obj', 'model/obj'],
]);

/** A URL path resolved inside the game folder, or null when it would leave it. */
export function resolveGameFile(root, pathname) {
  const base = resolve(root);
  let decoded;
  try { decoded = decodeURIComponent(pathname.split('?')[0].split('#')[0]); }
  catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const target = resolve(base, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (target !== base && !target.startsWith(`${base}${sep}`)) return null;
  return target;
}

function mimeType(file) {
  return MIME_TYPES.get(extname(file).toLowerCase()) || 'application/octet-stream';
}

function sendFile(request, response, file) {
  let info;
  try { info = statSync(file); } catch { response.writeHead(404).end('Not found'); return; }
  if (info.isDirectory()) {
    const index = join(file, 'index.html');
    if (existsSync(index)) return sendFile(request, response, index);
    response.writeHead(404).end('Not found');
    return;
  }
  const headers = {
    'Content-Type': mimeType(file),
    // The game's own files are shipped with the game: never serve a stale one after an update.
    'Cache-Control': 'no-cache',
    'Accept-Ranges': 'bytes',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ''));
  if (!range) {
    headers['Content-Length'] = String(info.size);
    response.writeHead(200, headers);
    if (request.method === 'HEAD') return response.end();
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
    return;
  }
  // `bytes=-N` asks for the *last* N bytes (RFC 9110 14.1.2), and the empty first group used to
  // read as "from the start": a tail request was answered with the head of the file, labelled as
  // if it were the tail. Media loaders and resumable fetchers ask this way.
  const suffix = range[1] === '' && range[2] !== '';
  const start = suffix ? Math.max(0, info.size - Number(range[2]))
    : range[1] ? Number(range[1]) : 0;
  const end = suffix ? info.size - 1
    : range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
    response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
    return;
  }
  headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  headers['Content-Length'] = String(end - start + 1);
  response.writeHead(206, headers);
  if (request.method === 'HEAD') return response.end();
  createReadStream(file, { start, end }).on('error', () => response.destroy()).pipe(response);
}

export function createGameHandler({ root, log = () => {} } = {}) {
  const base = resolve(root);
  return (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = String(request.url || '/').split('?')[0];
    // A page the game asks for beyond its folder is a mistake, not a directory to list.
    const file = resolveGameFile(base, pathname === '/' ? '/index.html' : pathname);
    if (!file) { response.writeHead(403).end('Forbidden'); return; }
    if (!existsSync(file)) log(`404 ${pathname}`);
    sendFile(request, response, file);
  };
}

function openBrowser(url, log) {
  const command = process.platform === 'win32' ? 'cmd'
    : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => log(`Open ${url} in a browser to play.`));
    child.unref();
  } catch { log(`Open ${url} in a browser to play.`); }
}

/**
 * Serves a game folder and returns where it is.
 *
 * **The port is the game's storage.** A browser keeps `localStorage` per origin, and the origin of
 * this server is `http://127.0.0.1:<port>`. The game used to ask for a free port on every launch
 * (`port: 0`), so every run was a new origin and the player's settings, save files and save slots
 * were gone at the next start. `slug` (the game's name, or its folder name) picks a stable port;
 * passing an explicit `port` still wins, and `port: 0` still means "any free port", which is what
 * a test or a second copy of a game running beside the first needs.
 */
export async function startGameServer({ root = process.cwd(), port = null, slug = null, open = true, log = console.log } = {}) {
  const wanted = Number.isSafeInteger(port) && port >= 0 ? port : null;
  const candidates = wanted === null ? gamePortCandidates(slug || basename(resolve(root))) : [wanted];
  let lastError = null;
  for (const [index, candidate] of candidates.entries()) {
    const server = createServer(createGameHandler({ root, log }));
    try {
      await new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(candidate, '127.0.0.1', done);
      });
    } catch (error) {
      server.removeAllListeners();
      try { server.close(); } catch { /* never listened */ }
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
      // The game's own port is taken by something else. Walk to the next one: a game that refuses
      // to start is worse than a game whose saves this one session do not keep, but say so.
      // Name the port it will try *next*, not the one it just failed on: the old message printed
      // `gamePortFor()`, which is the first candidate, so a player whose game found two ports busy
      // was told to look at a port that was already known to be taken.
      const next = candidates[index + 1];
      log(next === undefined ? `Port ${candidate} is in use, and no port is left to try.`
        : `Port ${candidate} is in use; trying ${next}…`);
      continue;
    }
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/`;
    if (candidates.length > 1 && candidate !== candidates[0]) {
      log(`Another program holds this game's usual port, so this session runs on ${address.port}: saves and settings made now will not be kept.`);
      log('Close the other program and start the game again to save normally.');
    }
    log(`Game ready at ${url}`);
    if (open) openBrowser(url, log);
    return {
      url, port: address.port,
      /** Whether this session landed on the game's own port, and so keeps its storage. */
      stable: wanted === null && candidate === candidates[0],
      close: () => new Promise(done => server.close(() => done())),
    };
  }
  throw new Error(`The game could not open a port on 127.0.0.1 (${lastError?.code || 'unknown error'})`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const asked = process.env.PORT;
  const port = asked === undefined || asked === '' ? null
    : Number.isSafeInteger(Number(asked)) && Number(asked) >= 0 ? Number(asked) : null;
  startGameServer({
    root,
    port,
    // The folder the game was unzipped into names its storage, so a copy keeps its saves.
    slug: basename(root),
    open: process.env.OPENDLE_NO_BROWSER !== '1',
  }).catch(error => {
    console.error(`The game could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
