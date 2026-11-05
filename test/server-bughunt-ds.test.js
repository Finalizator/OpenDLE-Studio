import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { normalizeLogEntry } from '../shared/playtest-log.js';
import { readFolderFile, unpackProject } from '../server/project-folder.js';
import { readProjectArchive } from '../server/project-archive.js';
import { readTarGz } from '../server/addons.js';
import { createZipArchive } from '../server/export-build.js';
import { createProject } from '../shared/project.js';

function scratch(t) {
  const directory = mkdtempSync(join(process.cwd(), '.server-bughunt-ds-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A folder document small enough to be parsed but never saved to disk. */
function folderDocument(title) {
  const project = createProject();
  project.title = title;
  return { version: 2, format: 'project-folder', revision: 0, sections: {}, project };
}

/* -------------------------------------------------------------- playtest */

test('playtest log records refuse an out-of-range timestamp instead of crashing the service', () => {
  // A browser page can post anything; a finite number outside Date's range used to
  // reach Date#toISOString and throw a RangeError, dropping the whole batch.
  const record = normalizeLogEntry({ message: 'boom', time: 1e20 }, {});
  assert.equal(typeof record.time, 'string');
  assert.doesNotThrow(() => new Date(record.time).toISOString());
});

test('playtest log records keep a valid timestamp and a string falls back to now', () => {
  const kept = normalizeLogEntry({ message: 'ok', time: Date.parse('2026-01-02T03:04:05.000Z') }, {});
  assert.equal(kept.time, '2026-01-02T03:04:05.000Z');
  const fallback = normalizeLogEntry({ message: 'ok', time: 'not-a-number' }, {});
  assert.doesNotThrow(() => new Date(fallback.time).toISOString());
});

/* ------------------------------------------------------------ folder read */

test('a folder reader returns null for a non-string asset path instead of crashing', () => {
  // A hand-edited project.json can name any value as a file; the reader's contract is
  // "a missing file is null", not an uncaught TypeError from path.resolve.
  assert.equal(readFolderFile('.', 123), null);
  assert.equal(readFolderFile('.', null), null);
  assert.equal(readFolderFile('.', undefined), null);
});

test('unpacking a folder document with a non-string asset file reports a missing file', () => {
  const document = { version: 2, format: 'project-folder', revision: 0, sections: {},
    project: { ...createProject(), assets: [{ id: 'a', name: 'a', kind: 'sound', file: 123 }] } };
  assert.throws(() => unpackProject(document, path => readFolderFile('.', path)), /missing/);
});

/* --------------------------------------------------------------- archive */

test('a project archive rejects duplicate entry names instead of silently keeping the last', async () => {
  const first = JSON.stringify(folderDocument('FIRST'));
  const second = JSON.stringify(folderDocument('SECOND'));
  const zip = createZipArchive([
    { path: 'project.json', data: Buffer.from(first), mode: 0o644 },
    { path: 'project.json', data: Buffer.from(second), mode: 0o644 },
  ], new Date());
  await assert.rejects(() => readProjectArchive(zip), /duplicate|more than one/i);
});

test('a project archive still reads a single unambiguous document', async () => {
  const zip = createZipArchive([
    { path: 'project.json', data: Buffer.from(JSON.stringify(folderDocument('ONLY'))), mode: 0o644 },
  ], new Date());
  const unpacked = await readProjectArchive(zip);
  assert.equal(unpacked.project.title, 'ONLY');
});

/* ---------------------------------------------------------------- tar.gz */

/** A tar.gz with one PAX `size` record followed by a file, the way a real tarball does. */
function paxSizedTarGz(fileName, byteCount) {
  const header = (name, size, type) => {
    const block = Buffer.alloc(512);
    block.write(name, 0);
    block.write('0000644\0', 100);
    block.write('0000000\0', 108);
    block.write('0000000\0', 116);
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    block.write('00000000000\0', 136);
    block.write(type, 156);
    block.write('ustar\0', 257);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return block;
  };
  const blocks = [];
  const record = `size=${byteCount}`;
  let prefix = String(Buffer.byteLength(record) + 2);
  while (Buffer.byteLength(`${prefix} ${record}\n`) !== Number(prefix)) {
    prefix = String(Buffer.byteLength(`${prefix} ${record}\n`));
  }
  const pax = Buffer.from(`${prefix} ${record}\n`, 'utf8');
  blocks.push(header('PaxHeader', pax.length, 'x'), pax, Buffer.alloc((512 - (pax.length % 512)) % 512));
  const data = Buffer.alloc(byteCount, 0x41);
  blocks.push(header(fileName, byteCount, '0'), data, Buffer.alloc((512 - (byteCount % 512)) % 512));
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test('a tar.gz PAX size record is decimal, so a large file is not truncated', () => {
  const files = readTarGz(paxSizedTarGz('data.txt', 1000));
  assert.equal(files.get('data.txt')?.length, 1000);
});

test('a tar.gz without a PAX size record still reads its octal size', () => {
  const blocks = [];
  const data = Buffer.alloc(500, 0x42);
  const header = Buffer.alloc(512);
  header.write('plain.txt', 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('0', 156);
  header.write('ustar\0', 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024));
  const files = readTarGz(gzipSync(Buffer.concat(blocks)));
  assert.equal(files.get('plain.txt')?.length, 500);
});
