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
  const start = range[1] ? Number(range[1]) : 0;
  const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
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
 * `port: 0` asks the system for a free port, which is what the launchers use: two exported games
 * must be able to run at the same time without one of them failing to bind.
 */
export async function startGameServer({ root = process.cwd(), port = 0, open = true, log = console.log } = {}) {
  const server = createServer(createGameHandler({ root, log }));
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  log(`Game ready at ${url}`);
  if (open) openBrowser(url, log);
  return {
    url, port: address.port,
    close: () => new Promise(done => server.close(() => done())),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 0);
  startGameServer({
    root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    port: Number.isSafeInteger(port) && port > 0 ? port : 0,
    open: process.env.OPENDLE_NO_BROWSER !== '1',
  }).catch(error => {
    console.error(`The game could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
