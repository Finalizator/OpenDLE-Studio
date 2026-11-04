/**
 * The runtime a *bundled* export carries with it.
 *
 * The portable build is a folder that needs Node.js and a browser already installed.
 * A bundled build is the same game with Electron beside it, so a clean machine — no
 * Node.js, no npm, no browser download — double-clicks the executable and plays. The
 * cost is size: Electron brings its own Node.js and Chromium, roughly 270 MB unpacked.
 *
 * Electron's own distribution is what gets copied; nothing is rebuilt or patched. The
 * studio and the exported game therefore run the same browser engine, which is why the
 * renderer behaves identically in both.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import yauzl from 'yauzl';

/** Export target name to the `process.platform` value Electron publishes builds for. */
const PLATFORMS = new Map([
  ['windows', 'win32'], ['win32', 'win32'],
  ['linux', 'linux'],
  ['macos', 'darwin'], ['darwin', 'darwin'],
]);

/**
 * Targets a bundled build can be made for today.
 *
 * macOS is left out deliberately: an `Electron.app` survives a zip only if its framework
 * symlinks do, and it has to be signed before a machine that did not build it will open
 * it. An unsigned copy would be an app the Finder refuses to launch.
 */
export const BUNDLED_TARGETS = ['windows', 'linux'];

/** Marks a cache directory as fully extracted, so an interrupted download is never reused. */
const COMPLETE = '.complete';

export function electronPlatform(target) {
  return PLATFORMS.get(String(target ?? '').trim().toLowerCase()) || null;
}

/** The Electron version the studio is installed with - the version games ship. */
export function installedVersion(root) {
  try { return JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

/** The distribution the studio itself runs on, unpacked for this machine only. */
export function installedDist(root) {
  const directory = join(root, 'node_modules', 'electron', 'dist');
  return existsSync(join(directory, 'version')) ? directory : null;
}

/** Extracts one Electron distribution zip, keeping the executable bits it carries. */
export function extractDist(zipPath, destination) {
  return new Promise((resolveExtract, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError) { reject(openError); return; }
      const inside = resolve(destination);
      zip.on('error', reject);
      zip.on('end', () => resolveExtract(destination));
      zip.on('entry', entry => {
        const target = resolve(inside, entry.fileName.replace(/\/$/, ''));
        // A zip is untrusted input even from a release URL: never write outside the folder.
        if (target !== inside && !target.startsWith(`${inside}/`)) {
          reject(new Error(`Refusing to extract ${entry.fileName} outside the extraction folder`));
          return;
        }
        if (entry.fileName.endsWith('/')) {
          mkdirSync(target, { recursive: true });
          zip.readEntry();
          return;
        }
        mkdirSync(dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { reject(streamError); return; }
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            writeFileSync(target, Buffer.concat(chunks));
            // Extracted on the export machine, which is not necessarily the build's target:
            // the mode comes from the archive so the executable stays executable.
            const mode = (entry.externalFileAttributes >>> 16) & 0o777;
            if (mode) chmodSync(target, mode);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/**
 * One Electron distribution for `target`, ready to copy into a build.
 *
 * The studio's own installation is used when the target is this machine - it is already
 * there and needs no network. Anything else downloads the release zip once and unpacks it
 * into `cacheDirectory`, so the second export for that platform is offline again.
 */
export async function resolveDist({ target, version = null, root = resolve(import.meta.dirname, '..'),
  cacheDirectory = join(root, 'data', '.electron-runtimes'), arch = process.arch, download = defaultDownload } = {}) {
  const platform = electronPlatform(target);
  if (!platform) throw new Error(`Unsupported bundled build platform: ${target}. Use windows or linux.`);
  const named = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform;
  if (!BUNDLED_TARGETS.includes(named)) {
    throw new Error(`Unsupported bundled build platform: ${target}. This build can carry Windows or Linux; `
      + 'macOS needs a signed .app bundle, so export a portable build for it.');
  }
  const wanted = version || installedVersion(root);
  if (!wanted) throw new Error('The Electron version to bundle is unknown: install dependencies with npm install before exporting a bundled build.');

  const cached = join(cacheDirectory, `v${wanted}-${platform}-${arch}`);
  if (existsSync(join(cached, COMPLETE))) return { directory: cached, platform, version: wanted, arch, source: 'cache' };

  if (platform === process.platform) {
    const installed = installedDist(root);
    if (installed) return { directory: installed, platform, version: wanted, arch, source: 'installed' };
  }

  const zipPath = await download({ version: wanted, platform, arch });
  // Unpacked under a temporary name and renamed at the end, so an interrupted download can
  // never look complete enough to reuse.
  const staging = `${cached}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  await extractDist(zipPath, staging);
  writeFileSync(join(staging, COMPLETE), `${wanted} ${platform} ${arch}\n`);
  rmSync(cached, { recursive: true, force: true });
  renameSync(staging, cached);
  return { directory: cached, platform, version: wanted, arch, source: 'downloaded' };
}

/** `@electron/get`'s downloader, isolated so tests never touch the network. */
async function defaultDownload({ version, platform, arch }) {
  const { downloadArtifact } = await import('@electron/get');
  return downloadArtifact({ version, platform, arch, artifactName: 'electron' });
}
