import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import { addonUrlKind, fetchAddon, githubTarget, readArchive, readTarGz, unpackAddon } from '../server/addons.js';
import { createZipArchive } from '../server/export-build.js';

/* ---------------------------------------------------------------- fixtures */

/** A tar.gz with the given entries, written the way tar means it (512-byte headers and padding). */
function tarGz(entries) {
  const blocks = [];
  for (const [name, body] of Object.entries(entries)) {
    const data = Buffer.from(body, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('ustar\0', 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

const manifest = {
  format: 'opendle-addon', version: 1, id: 'sparkle', name: 'Sparkle', entry: 'main.js',
  provides: { actions: [{ type: 'sparkle:burst', label: 'Addon: burst', fields: [] }] },
};
const addonFiles = {
  'sparkle-1.0/opendle-addon.json': JSON.stringify(manifest),
  'sparkle-1.0/main.js': 'export function activate() {}',
  'sparkle-1.0/ui/panel.js': 'export const name = "panel";',
  'sparkle-1.0/README.md': '# Sparkle',
  'sparkle-1.0/icon.png': 'not text',
  'LICENCE': 'outside the addon folder',
};
const archive = () => tarGz(addonFiles);

/** An HTTP server that answers with one body, on a port the tests own. */
async function serve(t, body, status = 200) {
  const server = createServer((request, response) => {
    response.writeHead(status, { 'content-type': 'application/gzip', 'content-length': body.length });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

/* ------------------------------------------------------------------- urls */

test('an addon URL is https, ftp or ftps — plain http only on this machine', () => {
  assert.equal(addonUrlKind('https://github.com/a/b'), 'https');
  assert.equal(addonUrlKind('ftp://host/a.zip'), 'ftp');
  assert.equal(addonUrlKind('ftps://host/a.zip'), 'ftps');
  assert.equal(addonUrlKind('http://localhost:3000/a.zip'), 'https');
  assert.throws(() => addonUrlKind('http://example.com/a.zip'), /https, ftp or ftps/);
  assert.throws(() => addonUrlKind('file:///etc/passwd'), /https, ftp or ftps/);
  assert.throws(() => addonUrlKind('not a url'), /not a URL/);
});

test('a GitHub URL names a repository and, optionally, a ref', () => {
  assert.deepEqual(githubTarget(new URL('https://github.com/owner/repo')), { owner: 'owner', repo: 'repo', ref: null });
  assert.deepEqual(githubTarget(new URL('https://github.com/owner/repo.git')), { owner: 'owner', repo: 'repo', ref: null });
  assert.equal(githubTarget(new URL('https://github.com/owner/repo/tree/dev')).ref, 'dev');
  assert.equal(githubTarget(new URL('https://github.com/owner/repo#feature/x')).ref, 'feature/x');
  assert.equal(githubTarget(new URL('https://github.com/owner/repo@v1.2')).ref, 'v1.2');
  assert.equal(githubTarget(new URL('https://example.com/owner/repo')), null);
  assert.throws(() => githubTarget(new URL('https://github.com/owner')), /must name a repository/);
});

/* --------------------------------------------------------------- archives */

test('a tar.gz is read into its files, refusing anything that leaves the archive', async () => {
  const files = await readArchive(archive());
  assert.deepEqual([...files.keys()].sort(), Object.keys(addonFiles).sort());
  assert.equal(files.get('sparkle-1.0/main.js').toString(), 'export function activate() {}');
  const hostile = tarGz({ '../escape.txt': 'x', 'good.txt': 'ok' });
  assert.throws(() => readTarGz(hostile), /not safe/);
  await assert.rejects(async () => readArchive(Buffer.from('not an archive')), /must be a zip or a tar\.gz/);
  await assert.rejects(async () => readArchive(Buffer.alloc(0)), /empty/);
});

test('a zip is read the same way', async () => {
  const zip = createZipArchive(Object.entries(addonFiles).map(([path, body]) => ({ path, data: Buffer.from(body), mode: 0o644 })), new Date());
  const files = await readArchive(zip);
  assert.equal(files.get('sparkle-1.0/opendle-addon.json').toString(), JSON.stringify(manifest));
  const hostile = createZipArchive([{ path: '../escape.txt', data: Buffer.from('x'), mode: 0o644 }], new Date());
  await assert.rejects(async () => readArchive(hostile), /not safe|invalid relative path/);
});

test('the shallowest manifest decides the addon folder, and only text travels', async () => {
  const files = await readArchive(archive());
  const addon = unpackAddon(files, { url: 'https://example.test/sparkle.tar.gz' });
  assert.equal(addon.manifest.id, 'sparkle');
  assert.deepEqual(Object.keys(addon.files), ['README.md', 'main.js', 'ui/panel.js'], 'the repository wrapper is stripped');
  assert.deepEqual(addon.ignored, ['icon.png'], 'a binary file is reported, not carried');
  assert.equal(addon.source.type, 'url');
  assert.match(addon.source.digest, /^[0-9a-f]{32}$/);
  // A folder of several addons installs the shallowest one, and a missing manifest says so.
  // Two manifests, and the shallower one wins: a repository that collects addons in
  // `addons/<name>/` still installs the one at the top of a folder someone arranges.
  const nested = await readArchive(tarGz({
    'repo/README.md': 'readme',
    'repo/addons/sparkle/opendle-addon.json': JSON.stringify(manifest),
    'repo/addons/sparkle/main.js': 'x',
    'repo/addons/other/deeper/opendle-addon.json': JSON.stringify({ ...manifest, id: 'other' }),
  }));
  assert.equal(unpackAddon(nested).manifest.id, 'sparkle');
  await assert.rejects(async () => unpackAddon(await readArchive(tarGz({ 'repo/README.md': 'x' }))), /no opendle-addon\.json/);
  await assert.rejects(async () => unpackAddon(await readArchive(tarGz({ 'opendle-addon.json': '{ not json' }))), /not valid JSON/);
  await assert.rejects(async () => unpackAddon(await readArchive(tarGz({ 'opendle-addon.json': JSON.stringify({ ...manifest, format: 'x' }) }))), /format/);
});

/* ------------------------------------------------------------------ fetch */

test('an addon is fetched from an archive URL and comes back installable', async t => {
  const base = await serve(t, archive());
  const addon = await fetchAddon(`${base}/sparkle.tar.gz`);
  assert.equal(addon.manifest.id, 'sparkle');
  assert.equal(addon.files['main.js'], 'export function activate() {}');
  assert.equal(addon.source.url, `${base}/sparkle.tar.gz`);
  const missing = await serve(t, Buffer.from('nope'), 404);
  await assert.rejects(() => fetchAddon(`${missing}/x.tar.gz`), /answered 404/);
});

test('a GitHub repository is read through codeload, with its default branch looked up', async t => {
  // The API answers with a default branch, codeload serves the tarball: both are the same URL
  // scheme the studio uses, so the test only has to answer them.
  const asked = [];
  const fetchImpl = async url => {
    asked.push(String(url));
    if (String(url).startsWith('https://api.github.com/repos/owner/repo')) {
      return { ok: true, status: 200, json: async () => ({ default_branch: 'trunk' }) };
    }
    if (String(url) === 'https://codeload.github.com/owner/repo/tar.gz/refs/heads/trunk') {
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => archive() };
    }
    return { ok: false, status: 404, headers: { get: () => null } };
  };
  const addon = await fetchAddon('https://github.com/owner/repo', { fetchImpl });
  assert.equal(addon.manifest.id, 'sparkle');
  assert.equal(addon.source.type, 'github');
  assert.equal(addon.source.ref, 'refs/heads/trunk');
  assert.ok(asked.some(url => url === 'https://codeload.github.com/owner/repo/tar.gz/refs/heads/trunk'));
  // A ref in the URL skips the lookup entirely.
  const pinned = [];
  await fetchAddon('https://github.com/owner/repo/tree/v2', { fetchImpl: async url => {
    pinned.push(String(url));
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => archive() };
  } });
  assert.deepEqual(pinned, ['https://codeload.github.com/owner/repo/tar.gz/v2']);
});

test('a download larger than the limit is refused', async t => {
  const big = Buffer.alloc(33 * 1024 * 1024);
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => String(big.length) }, arrayBuffer: async () => big });
  await assert.rejects(() => fetchAddon('https://example.test/big.zip', { fetchImpl }), /larger than 32 MiB/);
});

test('an FTP archive is downloaded over a passive data connection', async t => {
  const body = archive();
  const log = [];
  const server = createNetServer(socket => {
    socket.setEncoding('binary');
    socket.write('220 test ftp\r\n');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const [verb] = line.split(' ');
        log.push(line);
        if (verb === 'USER') socket.write('331 password required\r\n');
        else if (verb === 'PASS') socket.write('230 logged in\r\n');
        else if (verb === 'TYPE') socket.write('200 binary\r\n');
        else if (verb === 'PASV') {
          const data = createNetServer(connection => connection.end(body));
          data.listen(0, '127.0.0.1', () => {
            const port = data.address().port;
            socket.write(`227 Entering Passive Mode (127,0,0,1,${Math.floor(port / 256)},${port % 256})\r\n`);
            socket.once('close', () => data.close());
          });
        } else if (verb === 'RETR') socket.write('150 opening data connection\r\n');
        else if (verb === 'QUIT') { socket.write('221 goodbye\r\n'); socket.end(); }
        else socket.write('500 not understood\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const addon = await fetchAddon(`ftp://user:secret@127.0.0.1:${server.address().port}/addons/sparkle.tar.gz`);
  assert.equal(addon.manifest.id, 'sparkle');
  assert.equal(addon.source.type, 'ftp');
  assert.deepEqual(log.filter(line => /^(USER|TYPE|RETR)/.test(line)), ['USER user', 'TYPE I', 'RETR /addons/sparkle.tar.gz']);
  // The credentials were needed for this download and are not part of what was installed: a project
  // is a document people share.
  assert.equal(addon.source.url.includes('secret'), false, 'the password is not written into the project');
  assert.equal(addon.source.url.includes('user'), false, 'nor the user name');
  assert.match(addon.source.url, /^ftp:\/\/127\.0\.0\.1:\d+\/addons\/sparkle\.tar\.gz$/);
});

test('an FTP server that refuses, or a URL that names a folder, fails with a reason', async t => {
  const server = createNetServer(socket => {
    socket.write('220 test ftp\r\n');
    socket.on('data', () => socket.write('530 not today\r\n'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  await assert.rejects(() => fetchAddon(`ftp://u:p@127.0.0.1:${server.address().port}/a.zip`), /refused 530|would not let us in/);
  await assert.rejects(() => fetchAddon('ftp://127.0.0.1/addons/'), /name an archive file/);
});
