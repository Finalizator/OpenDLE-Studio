// Installs the exact GZDoom build this harness compares against, without root.
//
//   node tools/gzdoom/fetch.mjs
//
// The official .deb is unpacked into tools/gzdoom/dist instead of being installed
// system-wide: no root, no package manager, and the version the traces came from is pinned
// in tools/gzdoom/version.json. GZDoom links a libbz2 name that recent distributions no
// longer ship, so a symlink shim is created next to the binary and used via LD_LIBRARY_PATH
// (run.mjs sets that itself).
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const isSymlink = path => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const VERSION = 'g4.14.2';
const ASSET = 'gzdoom_4.14.2_amd64.deb';
const URL_BASE = `https://github.com/ZDoom/gzdoom/releases/download/${VERSION}`;

/**
 * True when the file is a 64-bit ELF object.
 *
 * Distributions keep both widths of libbz2 in `/usr/lib` and `/usr/lib64` under the same
 * name, so picking by path alone can hand a 64-bit game a 32-bit library (the loader then
 * says `wrong ELF class: ELFCLASS32`). The ELF class byte decides it, not the directory.
 */
function isElf64(path) {
  try {
    const header = readFileSync(path, { encoding: null, flag: 'r' }).subarray(0, 5);
    return header.length === 5 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46 && header[4] === 2;
  } catch { return false; }
}

/** Places `libbz2.so.1.0` next to the binary, sourced from whatever the system has. */
function shimBz2() {
  const lib = join(here, 'dist/lib');
  mkdirSync(lib, { recursive: true });
  const target = join(lib, 'libbz2.so.1.0');
  const candidates = [
    '/usr/lib64/libbz2.so.1', '/usr/lib/libbz2.so.1',
    '/usr/lib/x86_64-linux-gnu/libbz2.so.1', '/lib/x86_64-linux-gnu/libbz2.so.1',
    '/usr/lib64/libbz2.so.1.0.8', '/usr/lib/libbz2.so.1.0.8',
  ];
  const found = candidates.find(candidate => existsSync(candidate) && isElf64(realpathSync(candidate)));
  if (!found) {
    console.warn('no 64-bit libbz2.so.1 found: GZDoom may not start. Install bzip2-libs and re-run.');
    return;
  }
  // Re-point an existing shim: an earlier run may have chosen the wrong width.
  if (existsSync(target) || isSymlink(target)) unlinkSync(target);
  symlinkSync(found, target);
  console.log(`libbz2 shim: ${target} -> ${found}`);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  await pipeline(response.body, createWriteStream(destination));
}

async function main() {
  if (existsSync(join(here, 'dist/gzdoom'))) {
    console.log('GZDoom is already installed in tools/gzdoom/dist');
    shimBz2();
    return;
  }
  const cache = join(here, 'cache');
  mkdirSync(cache, { recursive: true });
  const deb = join(cache, ASSET);
  if (!existsSync(deb)) {
    console.log(`downloading ${URL_BASE}/${ASSET}`);
    await download(`${URL_BASE}/${ASSET}`, deb);
  }
  console.log('unpacking');
  execFileSync('dpkg-deb', ['-x', deb, join(here, 'dist')], { stdio: 'inherit' });
  // The .deb puts the game in /opt/gzdoom and its data next to it; keep that layout flat.
  const nested = join(here, 'dist/opt/gzdoom');
  if (existsSync(nested)) execFileSync('cp', ['-r', `${nested}/.`, join(here, 'dist')], { stdio: 'inherit' });
  shimBz2();
  writeFileSync(join(here, 'version.json'), `${JSON.stringify({ release: VERSION, asset: ASSET, installedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`GZDoom ${VERSION} installed in tools/gzdoom/dist`);
  if (readdirSync(here).includes('.state') === false) mkdirSync(join(here, '.state/saves'), { recursive: true });
}

await main();
