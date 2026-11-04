/**
 * The runtime a bundled export carries.
 *
 * Nothing here downloads anything: `resolveDist` takes its downloader as an argument, so the
 * network path can be exercised with a fixture zip, and the fast paths (an installed runtime,
 * an already-unpacked one) are pure file system work.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { BUNDLED_TARGETS, electronPlatform, extractDist, installedDist, installedVersion, resolveDist } from '../server/electron-runtime.js';
import { createZipArchive } from '../server/export-build.js';

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'opendle-runtime-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** A minimal stored-entry zip, so a hostile entry name can be tested without a real archive. */
function rawZip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const data = Buffer.from(contents);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBytes.length, 28);
    directory.writeUInt32LE(((0o100755) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, data);
    central.push(directory, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('the export target names map to the platforms Electron publishes', () => {
  assert.equal(electronPlatform('windows'), 'win32');
  assert.equal(electronPlatform('win32'), 'win32');
  assert.equal(electronPlatform('linux'), 'linux');
  assert.equal(electronPlatform('macos'), 'darwin');
  assert.equal(electronPlatform('solaris'), null);
  assert.equal(electronPlatform(undefined), null);
  assert.deepEqual(BUNDLED_TARGETS, ['windows', 'linux'], 'only what this build can carry and verify');
});

test('the installed runtime is reported with the version games will ship', t => {
  const root = scratch(t);
  assert.equal(installedVersion(root), null);
  assert.equal(installedDist(root), null);
  const dist = join(root, 'node_modules', 'electron', 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'electron'), 'binary');
  assert.equal(installedDist(root), null, 'a folder without the version marker is not a usable runtime');
  writeFileSync(join(dist, 'version'), '45.2.1\n');
  writeFileSync(join(root, 'node_modules', 'electron', 'package.json'), JSON.stringify({ version: '45.2.1' }));
  assert.equal(installedDist(root), dist);
  assert.equal(installedVersion(root), '45.2.1');
});

test('an extracted runtime keeps the executable bit it shipped with', async t => {
  const directory = scratch(t);
  const zip = join(directory, 'electron.zip');
  writeFileSync(zip, createZipArchive([
    { path: 'electron', data: Buffer.from('#!/bin/true\n'), mode: 0o755 },
    { path: 'icudtl.dat', data: Buffer.from('icu'), mode: 0o644 },
    { path: 'locales/en-US.pak', data: Buffer.from('locale'), mode: 0o644 },
  ], new Date()));
  const target = join(directory, 'out');
  await extractDist(zip, target);
  assert.ok(existsSync(join(target, 'electron')));
  assert.ok(existsSync(join(target, 'locales', 'en-US.pak')), 'nested folders are created');
  assert.ok(statSync(join(target, 'electron')).mode & 0o111, 'the runtime is executable');
  assert.equal(statSync(join(target, 'icudtl.dat')).mode & 0o111, 0, 'data files are not');
});

test('an archive cannot write outside the folder it is extracted into', async t => {
  const directory = scratch(t);
  const zip = join(directory, 'hostile.zip');
  writeFileSync(zip, rawZip([['../../escaped.txt', 'no']]));
  // yauzl rejects a traversal name before it is read, and extractDist checks the resolved
  // path as well; either refusal is fine, but nothing may land outside the folder.
  await assert.rejects(extractDist(zip, join(directory, 'out')), /outside the extraction folder|invalid relative path/);
  assert.equal(existsSync(join(directory, 'escaped.txt')), false);
  assert.equal(existsSync(join(tmpdir(), 'escaped.txt')), false);
});

test('a runtime is downloaded once, unpacked, and reused from the cache afterwards', async t => {
  const directory = scratch(t);
  const zip = join(directory, 'electron.zip');
  writeFileSync(zip, createZipArchive([
    { path: 'version', data: Buffer.from('45.2.1\n'), mode: 0o644 },
    { path: 'electron', data: Buffer.from('binary'), mode: 0o755 },
  ], new Date()));
  const downloads = [];
  const options = {
    target: 'windows', version: '45.2.1', root: directory,
    cacheDirectory: join(directory, 'cache'),
    download: async request => { downloads.push(request); return zip; },
  };
  const first = await resolveDist(options);
  assert.equal(first.source, 'downloaded');
  assert.equal(first.platform, 'win32');
  assert.deepEqual(downloads, [{ version: '45.2.1', platform: 'win32', arch: process.arch }]);
  assert.ok(existsSync(join(first.directory, 'electron')));

  const second = await resolveDist(options);
  assert.equal(second.source, 'cache', 'a second export of the same platform needs no network');
  assert.equal(second.directory, first.directory);
  assert.equal(downloads.length, 1);
});

test('an interrupted extraction is never reused', async t => {
  const directory = scratch(t);
  const cache = join(directory, 'cache');
  // Something claimed the folder and died before finishing.
  mkdirSync(join(cache, `v45.2.1-linux-${process.arch}`), { recursive: true });
  writeFileSync(join(cache, `v45.2.1-linux-${process.arch}`, 'electron'), 'half a file');
  const zip = join(directory, 'electron.zip');
  writeFileSync(zip, createZipArchive([{ path: 'version', data: Buffer.from('45.2.1\n') }], new Date()));
  const resolved = await resolveDist({
    target: 'linux', version: '45.2.1', root: directory, cacheDirectory: cache,
    download: async () => zip,
  });
  assert.equal(resolved.source, 'downloaded');
  assert.equal(readFileSync(join(resolved.directory, 'version'), 'utf8'), '45.2.1\n');
});

test('a runtime that cannot be resolved says why', async t => {
  const directory = scratch(t);
  await assert.rejects(resolveDist({ target: 'macos', root: directory }), /Unsupported bundled build platform/);
  await assert.rejects(resolveDist({ target: 'windows', root: directory }), /version to bundle is unknown/);
  await assert.rejects(resolveDist({
    target: 'windows', version: '45.2.1', root: directory, cacheDirectory: join(directory, 'cache'),
    download: async () => { throw new Error('offline'); },
  }), /offline/);
});
