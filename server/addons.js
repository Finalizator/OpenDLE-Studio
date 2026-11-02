/**
 * Getting an addon from a URL.
 *
 * An addon is a folder with an `opendle-addon.json` in it, and "from a URL" means three shapes:
 *
 * - a **GitHub repository** — `https://github.com/owner/repo`, optionally `#ref` (or `/tree/ref`) —
 *   read as the tarball codeload serves for that ref;
 * - any **zip or tar.gz** over https;
 * - the same archive on an **FTP server**, `ftp://` or explicit-TLS `ftps://`.
 *
 * Everything here is data from outside the studio, so it is bounded before it is parsed (the
 * download, each entry, the whole unpacked text), paths are normalised and traversal is refused, and
 * only text files are accepted — an addon is source, not a binary payload. What comes back is a
 * manifest and its files; putting them into a project is `installAddon` in `shared/addons.js`, and
 * the project is the store, so nothing is written beside it.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { posix } from 'node:path';
import yauzl from 'yauzl';
import { ADDON_MANIFEST, ADDON_LIMITS, validateAddonManifest } from '../shared/addons.js';

const MiB = 1024 * 1024;
const MAX_DOWNLOAD = 32 * MiB;
const MAX_ENTRIES = 4096;
/** Text only: a file that does not decode as UTF-8 is not an addon's business. */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.css', '.html', '.txt', '.md', '.glsl', '.wgsl', '.frag', '.vert', '.tsl', '.svg']);

const fail = message => { throw new Error(message); };

/** A URL this studio will fetch: https anywhere, plain http only on this machine. */
export function addonUrlKind(value) {
  let url;
  try { url = new URL(String(value).trim()); }
  catch { fail('That is not a URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'ftp:') return 'ftp';
  if (url.protocol === 'ftps:') return 'ftps';
  if (url.protocol === 'https:') return 'https';
  if (url.protocol === 'http:' && local) return 'https';
  fail('An addon URL must be https, ftp or ftps (plain http is allowed only for localhost)');
}

/**
 * Reads an addon from a URL and returns `{ manifest, files, source }`, ready for `installAddon`.
 *
 * `fetchImpl` is injectable so the tests can answer from a local server instead of the internet.
 */
export async function fetchAddon(value, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const kind = addonUrlKind(value);
  const url = new URL(String(value).trim());
  if (kind === 'ftp' || kind === 'ftps') {
    const bytes = await ftpDownload(url, { timeoutMs, secure: kind === 'ftps' });
    return unpackAddon(await readArchive(bytes), { url: publicUrl(url) });
  }
  const github = githubTarget(url);
  if (github) {
    const { owner, repo, ref } = await resolveGithubRef(github, { fetchImpl, timeoutMs });
    const tarball = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
    const bytes = await download(tarball, { fetchImpl, timeoutMs, what: 'The GitHub repository' });
    const files = await readArchive(bytes);
    // GitHub wraps everything in `<repo>-<ref>/`, which the manifest search already ignores.
    return unpackAddon(files, { url: publicUrl(url), github: { owner, repo, ref } });
  }
  const bytes = await download(url.toString(), { fetchImpl, timeoutMs, what: 'The addon archive' });
  return unpackAddon(await readArchive(bytes), { url: publicUrl(url) });
}

/* ---------------------------------------------------------------- github */

/**
 * The URL as it is written into the project: without a user name or password.
 *
 * A project is a document people share, and an FTP password in it would be shared with it. The
 * credentials were needed once, for this download, and are not part of what was installed.
 */
export function publicUrl(url) {
  const clean = new URL(url.toString());
  clean.username = '';
  clean.password = '';
  return clean.toString();
}

/** `owner/repo` when the URL is a repository page, with the ref when it names one. */
export function githubTarget(url) {
  if (!/(^|\.)github\.com$/.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) fail('A GitHub URL must name a repository: https://github.com/owner/repo');
  const [owner, repo, ...rest] = parts;
  let ref = null;
  if (rest[0] === 'tree' && rest[1]) ref = decodeURIComponent(rest.slice(1).join('/'));
  // `#branch` and `@branch` both work, because a branch name with a slash cannot live in a
  // fragment-free path and both spellings are things people type.
  const hash = url.hash.replace(/^#/, '');
  const at = repo.includes('@') ? repo.slice(repo.indexOf('@') + 1) : '';
  if (hash) ref = decodeURIComponent(hash);
  else if (at) ref = decodeURIComponent(at);
  return { owner, repo: repo.replace(/\.git$/, '').split('@')[0], ref };
}

/** The default branch of a repository, so a bare repository URL needs no ref from the author. */
async function resolveGithubRef({ owner, repo, ref }, { fetchImpl, timeoutMs }) {
  if (ref) return { owner, repo, ref };
  try {
    const response = await withTimeout(fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'OpenDLE-Studio' },
    }), timeoutMs);
    if (response.ok) {
      const body = await response.json();
      if (typeof body?.default_branch === 'string' && body.default_branch) {
        return { owner, repo, ref: `refs/heads/${body.default_branch}` };
      }
    }
  } catch { /* fall through to the usual names */ }
  return { owner, repo, ref: 'refs/heads/main' };
}

/* ---------------------------------------------------------------- download */

async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The addon download timed out')), timeoutMs); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

const MAX_REDIRECTS = 5;

/**
 * Downloads one document, with the size and time bounds applied to the *body*.
 *
 * `withTimeout` around `fetch` only covers the headers: a server that answers and then drips bytes
 * would otherwise hold the request open and grow the heap until the process died. A redirect is
 * followed by hand so the URL policy is re-applied at every hop — `redirect: 'follow'` let an https
 * URL bounce to `http://` an endpoint `addonUrlKind` exists to refuse.
 */
async function download(url, { fetchImpl, timeoutMs, what }) {
  const started = Date.now();
  let current = new URL(String(url));
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    addonUrlKind(current.href);
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) fail(`${what} took longer than ${Math.round(timeoutMs / 1000)} s`);
    let response;
    try {
      response = await withTimeout(fetchImpl(current.href, { redirect: 'manual', headers: { 'user-agent': 'OpenDLE-Studio' } }), remaining);
    } catch (error) { fail(`${what} could not be reached: ${error.message}`); }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location');
      if (!location) fail(`${what} answered ${response.status} without a destination`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) fail(`${what} answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD) fail(`${what} is larger than ${MAX_DOWNLOAD / MiB} MiB`);
    return await readBounded(response, { what, timeoutMs: timeoutMs - (Date.now() - started) });
  }
  fail(`${what} redirected more than ${MAX_REDIRECTS} times`);
}

/** Reads a response body, refusing it as soon as it passes the cap or the clock runs out. */
async function readBounded(response, { what, timeoutMs }) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // No stream to count (an injected `fetchImpl` in a test, usually): the buffer still has to be checked.
    const buffer = Buffer.from(await withTimeout(response.arrayBuffer(), Math.max(1, timeoutMs)));
    if (buffer.length > MAX_DOWNLOAD) fail(`${what} is larger than ${MAX_DOWNLOAD / MiB} MiB`);
    return buffer;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + Math.max(1, timeoutMs);
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) fail(`${what} took too long to download`);
      const step = await withTimeout(reader.read(), left);
      if (step.done) break;
      total += step.value?.length || 0;
      if (total > MAX_DOWNLOAD) fail(`${what} is larger than ${MAX_DOWNLOAD / MiB} MiB`);
      chunks.push(Buffer.from(step.value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* the connection is going anyway */ }
    throw error instanceof Error ? error : new Error(String(error));
  }
  return Buffer.concat(chunks);
}

/* --------------------------------------------------------------- archives */

/** Reads a zip or tar.gz into a name → bytes map, refusing anything that leaves the archive. */
export async function readArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) fail('The addon archive is empty');
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return readTarGz(buffer);
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return await readZip(buffer);
  fail('The addon archive must be a zip or a tar.gz');
}

function safeName(name) {
  const clean = posix.normalize(String(name).replace(/\\/g, '/')).replace(/^\.\//, '');
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('/') || clean.includes('..')) fail(`Archive path is not safe: ${name}`);
  return clean;
}

/** tar.gz: gunzip, then walk 512-byte headers. */
export function readTarGz(buffer) {
  let tar;
  try { tar = gunzipSync(buffer, { maxOutputLength: MAX_DOWNLOAD * 4 }); }
  catch (error) { fail(`The tar.gz could not be unpacked: ${error.message}`); }
  const files = new Map();
  let offset = 0, entries = 0;
  // A PAX header carries the values ustar cannot hold — a path longer than 100 bytes, a large size — in
  // its own entry, for the entry that follows. GitHub tarballs use them, so ignoring the records
  // silently truncated (or dropped) any addon path longer than 100 bytes.
  let extended = null;
  const paxRecords = body => {
    const records = {};
    let index = 0;
    while (index < body.length) {
      const space = body.indexOf(0x20, index);
      if (space < 0) break;
      const length = Number(body.subarray(index, space).toString('utf8'));
      if (!Number.isFinite(length) || length <= 0) break;
      const record = body.subarray(space + 1, index + length - 1).toString('utf8');
      const equals = record.indexOf('=');
      if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
      index += length;
    }
    return records;
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // Two zero blocks end the archive; a name of all zeroes is the same end.
    if (header.every(byte => byte === 0)) break;
    const read = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '').trim();
    let name = read(0, 100);
    const prefix = read(345, 155);
    let sizeField = read(124, 12).trim() || '0';
    const type = String.fromCharCode(header[156] || 48);
    const bodyStart = offset + 512;
    if (++entries > MAX_ENTRIES) fail(`The archive has more than ${MAX_ENTRIES} entries`);
    if (type === 'x' || type === 'g') {
      const declared = parseInt(sizeField, 8);
      if (!Number.isFinite(declared) || declared < 0) fail('A tar entry has an unreadable size');
      if (type === 'x') extended = paxRecords(tar.subarray(bodyStart, bodyStart + declared));
      offset = bodyStart + Math.ceil(declared / 512) * 512;
      continue;
    }
    if (extended) {
      if (typeof extended.path === 'string' && extended.path) name = extended.path;
      if (typeof extended.size === 'string' && /^\d+$/.test(extended.size)) sizeField = extended.size;
      extended = null;
    }
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size) || size < 0) fail('A tar entry has an unreadable size');
    // '0' and '\0' are ordinary files; everything else (directories, links, other headers) is skipped.
    if ((type === '0' || type === '\0') && name && !name.endsWith('/')) {
      files.set(safeName(prefix ? `${prefix}/${name}` : name), tar.subarray(bodyStart, bodyStart + size));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** zip, through the same reader the project importer uses, with the same bounds. */
export function readZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) { reject(new Error(`The zip could not be read: ${error.message}`)); return; }
      const files = new Map();
      let entries = 0, total = 0, done = false;
      const finish = failure => {
        if (done) return;
        done = true;
        zip.close();
        if (failure) reject(failure); else resolve(files);
      };
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', entry => {
        try {
          if (++entries > MAX_ENTRIES) throw new Error(`The archive has more than ${MAX_ENTRIES} entries`);
          const name = safeName(entry.fileName);
          if (name.endsWith('/')) { zip.readEntry(); return; }
          total += entry.uncompressedSize;
          if (total > MAX_DOWNLOAD * 4) throw new Error(`The archive expands past ${MAX_DOWNLOAD * 4 / MiB} MiB`);
          if (entry.generalPurposeBitFlag & 1) throw new Error(`Archive entry is encrypted: ${name}`);
          if (![0, 8].includes(entry.compressionMethod)) throw new Error(`Archive entry uses unsupported compression: ${name}`);
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) { finish(streamError); return; }
            const chunks = [];
            stream.on('error', finish);
            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => {
              if (done) return;
              files.set(name, Buffer.concat(chunks));
              zip.readEntry();
            });
          });
        } catch (failure) { finish(failure); }
      });
      zip.readEntry();
    });
  });
}

/* ---------------------------------------------------------------- unpack */

/**
 * Finds the manifest, takes the addon's own folder as its root, and returns text files only.
 *
 * A repository is usually one addon at its root, but a folder of several addons is common too; the
 * shallowest manifest wins, and everything under its directory travels with it. Anything above it
 * (a README at the repository root, a licence file) is reported as left behind rather than silently
 * dropped.
 */
export function unpackAddon(files, { url = null, github = null } = {}) {
  const manifests = [...files.keys()].filter(name => posix.basename(name) === ADDON_MANIFEST)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (!manifests.length) fail(`The addon has no ${ADDON_MANIFEST}`);
  const shallowest = manifests[0].split('/').length;
  const contenders = manifests.filter(name => name.split('/').length === shallowest);
  if (contenders.length > 1) fail(`The archive holds ${contenders.length} addons (${contenders.slice(0, 3).join(', ')}); install them one at a time`);
  const manifestPath = manifests[0];
  const root = posix.dirname(manifestPath) === '.' ? '' : `${posix.dirname(manifestPath)}/`;
  let manifest;
  try { manifest = JSON.parse(files.get(manifestPath).toString('utf8')); }
  catch (error) { fail(`${ADDON_MANIFEST} is not valid JSON (${error.message})`); }
  try { validateAddonManifest(manifest); }
  catch (error) { fail(`${ADDON_MANIFEST}: ${error.message}`); }
  const carried = {}, ignored = [];
  for (const [name, bytes] of files) {
    if (name === manifestPath) continue;
    if (!name.startsWith(root)) { ignored.push(name); continue; }
    const relative = name.slice(root.length);
    if (!relative) continue;
    const extension = posix.extname(relative).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) { ignored.push(relative); continue; }
    const text = bytes.toString('utf8');
    // A file that does not survive a UTF-8 round trip is binary by accident or by intent.
    if (Buffer.from(text, 'utf8').length !== bytes.length || text.includes('\u0000')) { ignored.push(relative); continue; }
    carried[relative] = text;
  }
  const source = { type: github ? 'github' : url && url.startsWith('ftp') ? 'ftp' : 'url',
    url, fetchedAt: new Date().toISOString() };
  if (github) source.ref = github.ref;
  const kept = Object.fromEntries(Object.entries(carried).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  // A digest of exactly what was installed, so the panel can say when a repository has moved on.
  const digest = createHash('sha256');
  for (const [name, body] of Object.entries(kept)) digest.update(`${name}\u0000${body}\u0000`);
  source.digest = digest.digest('hex').slice(0, 32);
  return { manifest, files: kept, source, ignored, root };
}

/* -------------------------------------------------------------------- ftp */

/**
 * A minimal FTP client: log in, ask for a passive data connection, pull one file.
 *
 * The studio has no FTP dependency and does not need one — this speaks the four commands every
 * server has had since 1985 (`USER`, `PASS`, `TYPE I`, `PASV`, `RETR`) and reads the reply codes the
 * way `RFC 959` numbers them. `ftps://` upgrades the control connection with `AUTH TLS` after the
 * greeting, which is what "explicit FTPS" means; implicit FTPS on port 990 is not supported and says
 * so rather than hanging.
 */
export function ftpDownload(url, { timeoutMs = 30_000, secure = false } = {}) {
  const port = Number(url.port) || 21;
  const user = decodeURIComponent(url.username || 'anonymous');
  const password = decodeURIComponent(url.password || 'openDLE@example.invalid');
  const path = decodeURIComponent(url.pathname || '/');
  if (!path || path.endsWith('/')) return Promise.reject(new Error('An FTP addon URL must name an archive file, not a folder'));
  return new Promise((resolve, reject) => {
    let socket = null, buffer = '', queue = [], finished = false, upgraded = false;
    const timer = setTimeout(() => finish(new Error('The FTP server did not answer in time')), timeoutMs);
    const finish = (error, data) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already gone */ }
      if (error) reject(error); else resolve(data);
    };
    /** Sends one command and resolves with its reply, so each step can be read in order. */
    const command = line => new Promise((done, boom) => { queue.push({ done, boom }); socket.write(`${line}\r\n`); });
    let reply = [];
    const onData = chunk => {
      buffer += chunk.toString('binary');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        reply.push(line);
        // A reply is complete when a line carries a three-digit code and a space.
        if (/^\d{3} /.test(line)) {
          const lines = reply.join('\n');
          reply = [];
          const pending = queue.shift();
          const code = Number(line.slice(0, 3));
          if (code >= 400) pending?.boom(new Error(`The FTP server refused ${line.slice(0, 3)}: ${line.slice(4) || 'no reason given'}`));
          else pending?.done({ code, lines });
        }
      }
    };
    const start = () => {
      socket = netConnect({ host: url.hostname, port });
      socket.setEncoding('binary');
      socket.setTimeout(timeoutMs, () => finish(new Error('The FTP server did not answer in time')));
      socket.on('error', error => finish(new Error(`The FTP server could not be reached: ${error.message}`)));
      // The greeting arrives without a command, so it is one more reply to read.
      queue.push({ done: () => step(), boom: error => finish(error) });
      socket.on('data', onData);
    };
    const upgrade = () => {
      const plain = socket;
      plain.removeAllListeners('data');
      socket = tlsConnect({ socket: plain, servername: url.hostname });
      upgraded = true;
      socket.setEncoding('binary');
      socket.on('error', error => finish(new Error(`The FTP TLS handshake failed: ${error.message}`)));
      socket.on('data', onData);
      step();
    };
    const step = async () => {
      try {
        if (secure && !upgraded) {
          const auth = await command('AUTH TLS');
          if (auth.code !== 234) throw new Error('This FTP server does not offer TLS');
          upgrade();
          return;
        }
        if (!(await command(`USER ${user}`)).code.toString().startsWith('2')) {
          // 331 means "password required", which is the normal path.
        }
        await command(`PASS ${password}`).catch(error => {
          if (!(error instanceof Error)) throw error;
          throw new Error(`The FTP server would not let us in: ${error.message}`);
        });
        await command('TYPE I');
        const passive = await command('PASV');
        const match = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(passive.lines);
        if (!match) throw new Error('The FTP server did not offer a passive data connection');
        // RFC 959 lets the client ignore the address in the PASV reply, and it must: a server (or anyone
        // who can interfere with `ftp://`, which has no TLS) could otherwise make the studio open a
        // connection to any host and port it names. The port is the server's to choose; the host is not.
        const dataPort = Number(match[5]) * 256 + Number(match[6]);
        let receivedBytes = 0;
        const chunks = [];
        const data = netConnect({ host: url.hostname, port: dataPort });
        data.on('error', error => finish(new Error(`The FTP data connection failed: ${error.message}`)));
        data.on('data', chunk => {
          chunks.push(chunk);
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_DOWNLOAD) finish(new Error('The addon is larger than 32 MiB'));
        });
        // Resolves on failure too: the error is reported once through `finish`, and a second rejection
        // nobody awaits would take the whole service down.
        const received = new Promise(done => {
          data.on('end', done);
          data.on('close', done);
          data.on('error', done);
        });
        await command(`RETR ${path}`);
        await received;
        const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'binary')));
        await command('QUIT').catch(() => {});
        finish(null, bytes);
      } catch (error) { finish(error); }
    };
    start();
  });
}
