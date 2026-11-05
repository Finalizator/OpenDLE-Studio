/**
 * PixiEditor bridge.
 *
 * Every picture asset in a project is a PNG data URL, which no desktop editor can open,
 * so the artwork is written to disk first: one folder per project under
 * `data/pixieditor/`, keyed by the asset's own id so the same texture always lands on the
 * same file. PixiEditor is started on that file (its command line opens the first
 * supported image it is given), and once the artist exports the PNG back over it the
 * project reads it again with the reload call below.
 *
 * Nothing here touches the project: the edit itself stays an ordinary, undoable asset
 * change on the client.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { LIMITS } from '../shared/limits.js';

/** Kinds whose artwork is a bitmap a pixel editor can open. */
export const PIXIEDITOR_KINDS = Object.freeze(['texture', 'flat', 'sprite', 'image', 'sky', 'weapon', 'hud']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_NAME = 60;

/** Splits a `data:image/png;base64,...` source into bytes, refusing anything else. */
export function decodeImageSource(src) {
  if (typeof src !== 'string') throw new Error('That asset has no image data to edit');
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src.trim());
  if (!match) throw new Error('Only artwork stored in the project as base64 data can be edited; reimport this asset first');
  const [, mime, payload] = match;
  if (mime !== 'image/png') throw new Error(`PixiEditor takes the project's PNG artwork; this asset is ${mime}`);
  const data = Buffer.from(payload, 'base64');
  if (!data.length) throw new Error('That asset holds no image data');
  if (data.length > LIMITS.imageBytes) throw new Error('That image is too large to hand to a desktop editor');
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('That asset is not a PNG image');
  return { mime, data };
}

/** Width and height straight from the PNG header, so a reload needs no image decoder. */
export function pngSize(data) {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('ascii', 12, 16) !== 'IHDR')
    throw new Error('That file is not a PNG image');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height) throw new Error('That PNG image has no size');
  return { width, height };
}

const slug = (text, limit) => String(text ?? '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, limit);

/**
 * The file a texture is edited in: the readable name, plus a short digest of the asset id
 * so two flats that share a name never share a file. The id is what the digest comes from,
 * so renaming an asset keeps the file the editor already has open.
 */
export function textureFileName(asset) {
  const name = slug(asset?.name, MAX_NAME) || 'texture';
  const digest = createHash('sha1').update(String(asset?.id ?? '')).digest('hex').slice(0, 8);
  return `${name}-${digest}.png`;
}

/** The per-project folder the editable copies live in. */
export function editFolder(directory, project) {
  return join(directory, slug(project, 60) || 'project');
}

/**
 * PixiEditor's executable on this machine, in the order worth trying. `OPENDLE_PIXIEDITOR`
 * wins so a build installed somewhere unusual still works without touching the code.
 */
export function pixiEditorCandidates({ platform = process.platform, env = process.env,
  exists = existsSync, readdir = readdirSync } = {}) {
  if (env.OPENDLE_PIXIEDITOR) {
    const override = env.OPENDLE_PIXIEDITOR;
    return exists(override) ? [{ command: override, args: [], source: 'OPENDLE_PIXIEDITOR' }] : [];
  }
  // Candidate paths are built with the separators of the platform being looked at, not of
  // the machine doing the looking, so the same code describes a Windows install anywhere.
  const windows = platform === 'win32';
  const join = windows ? win32.join : posix.join;
  const home = env.HOME || env.USERPROFILE || homedir();
  const pathDirs = String(env.PATH || '').split(windows ? ';' : ':').filter(Boolean);
  const fromPath = names => pathDirs.flatMap(dir => names.map(name => join(dir, name)));
  const candidates = [];
  const add = (command, args = [], source = 'install') => {
    if (exists(command)) candidates.push({ command, args, source });
  };
  if (platform === 'win32') {
    const bases = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'PixiEditor'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'PixiEditor'),
      env.ProgramFiles && join(env.ProgramFiles, 'PixiEditor'),
      env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'PixiEditor'),
      env.ProgramFiles && join(env.ProgramFiles, 'Steam', 'steamapps', 'common', 'PixiEditor'),
      env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Steam', 'steamapps', 'common', 'PixiEditor')].filter(Boolean);
    for (const base of bases) add(join(base, 'PixiEditor.exe'), [], base.includes('Steam') ? 'steam' : 'install');
    for (const path of fromPath(['PixiEditor.exe', 'pixieditor.exe'])) add(path, [], 'PATH');
  } else if (platform === 'darwin') {
    for (const base of ['/Applications', join(home, 'Applications')])
      add(join(base, 'PixiEditor.app', 'Contents', 'MacOS', 'PixiEditor'), [], 'install');
    for (const path of fromPath(['pixieditor', 'PixiEditor'])) add(path, [], 'PATH');
  } else {
    for (const path of fromPath(['pixieditor', 'PixiEditor', 'pixieditor.AppImage'])) add(path, [], 'PATH');
    for (const path of ['/opt/PixiEditor/pixieditor', '/opt/PixiEditor/PixiEditor', '/opt/PixiEditor.AppImage',
      join(home, 'Applications', 'PixiEditor.AppImage')]) add(path, [], 'install');
    // An AppImage keeps whatever name it was downloaded with; the folder is the signal.
    for (const folder of [join(home, 'Applications'), '/opt']) {
      let entries = [];
      try { entries = readdir(folder); } catch { entries = []; }
      for (const entry of entries) {
        // Found by listing the folder, so it is there: no second existence check.
        if (/^PixiEditor.*\.AppImage$/i.test(entry))
          candidates.push({ command: join(folder, entry), args: [], source: 'appimage' });
      }
    }
    const flatpak = join(home, '.local', 'share', 'flatpak', 'app', 'net.pixieditor.PixiEditor');
    if (exists(flatpak) || exists('/var/lib/flatpak/app/net.pixieditor.PixiEditor'))
      candidates.push({ command: 'flatpak', args: ['run', 'net.pixieditor.PixiEditor'], source: 'flatpak' });
  }
  return candidates;
}

export function findPixiEditor(options = {}) {
  return pixiEditorCandidates(options)[0] || null;
}

/** The message a machine without PixiEditor gets, with the one thing that always works. */
export function missingPixiEditorMessage(platform = process.platform) {
  const hint = platform === 'win32' ? 'Install it from pixieditor.net, or set OPENDLE_PIXIEDITOR to PixiEditor.exe.'
    : platform === 'darwin' ? 'Install it in /Applications, or set OPENDLE_PIXIEDITOR to the executable inside PixiEditor.app.'
      : 'Install the AppImage or the Flatpak, or set OPENDLE_PIXIEDITOR to the executable.';
  return `PixiEditor was not found on this machine. ${hint}`;
}

/** Starts the editor on `file` and lets go of it: the studio does not own that window. */
export function launchPixiEditor({ launcher, file, spawnImpl = spawn, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnImpl(launcher.command, [...launcher.args, file], { detached: true, stdio: 'ignore' });
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    // A launcher that exits straight away (a wrapper script, a Flatpak) is not a failure:
    // the editor it started outlives it, so success is decided at spawn time.
    const timer = setTimeout(() => finish(), timeout);
    timer.unref?.();
    child.once?.('error', error => finish(new Error(`PixiEditor could not start (${error.message}). ${missingPixiEditorMessage()}`)));
    child.once?.('spawn', () => { child.unref?.(); finish(); });
  });
}

/**
 * The three calls the routes make. Everything is injectable, so a test can point the
 * bridge at a temporary folder and a fake executable.
 */
export function createPixiEditorBridge({ directory, platform = process.platform, env = process.env,
  exists = existsSync, spawnImpl = spawn, mkdir = mkdirSync, write = writeFileSync,
  read = readFileSync, stat = statSync, readdir = readdirSync } = {}) {
  const launcherFor = () => pixiEditorCandidates({ platform, env, exists }).find(Boolean) || null;

  function fileFor(project, asset) {
    return join(editFolder(directory, project), textureFileName(asset));
  }

  /**
   * The file an asset was last opened in. It normally sits in this project's folder, but a
   * project that has been saved under a new name keeps its artwork in the folder it had at
   * the time — so the rest of the scratch root is searched for the same asset before the
   * reload gives up. The digest in the name is what makes that match exact.
   */
  function findEditedFile(project, asset) {
    const name = textureFileName(asset);
    const own = join(editFolder(directory, project), name);
    if (exists(own)) return own;
    let entries = [];
    try { entries = readdir(directory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (entry?.isDirectory && !entry.isDirectory()) continue;
      const folder = join(directory, typeof entry === 'string' ? entry : entry.name);
      const candidate = join(folder, name);
      if (exists(candidate)) return candidate;
    }
    return null;
  }

  function requireAsset(asset) {
    if (!asset || typeof asset !== 'object') throw new Error('An asset is required');
    if (!PIXIEDITOR_KINDS.includes(asset.kind))
      throw new Error(`${asset.kind || 'That'} assets are not artwork; PixiEditor edits bitmaps`);
    if (typeof asset.id !== 'string' || !asset.id) throw new Error('That asset has no id');
    return asset;
  }

  function status() {
    const launcher = launcherFor();
    return { available: Boolean(launcher), command: launcher?.command ?? null, source: launcher?.source ?? null,
      directory };
  }

  /** Writes the artwork out and opens it, answering with where it went. */
  async function open(project, asset) {
    requireAsset(asset);
    const launcher = launcherFor();
    const { data } = decodeImageSource(asset.src);
    const path = fileFor(project, asset);
    mkdir(editFolder(directory, project), { recursive: true });
    write(path, data);
    const { width, height } = pngSize(data);
    // The PNG is written before the editor is looked for, so even a machine without one can
    // take the artwork elsewhere; the message says where it is.
    if (!launcher) throw Object.assign(new Error(`${missingPixiEditorMessage(platform)} The PNG is at ${path}.`), { path, written: true });
    await launchPixiEditor({ launcher, file: path, spawnImpl });
    return { path, width, height, command: launcher.command, source: launcher.source };
  }

  /** Reads the file back after the artist exported over it. */
  function reload(project, asset) {
    requireAsset(asset);
    const path = findEditedFile(project, asset);
    const hint = `${textureFileName(asset)} is not on disk yet: export the PNG from PixiEditor over the file it was opened from`;
    if (!path) throw new Error(hint);
    let data;
    try { data = read(path); } catch { throw new Error(hint); }
    if (data.length > LIMITS.imageBytes) throw new Error('That image is too large to hand back into the project');
    const { width, height } = pngSize(data);
    const modified = stat(path).mtimeMs;
    return { path, width, height, modified, src: `data:image/png;base64,${data.toString('base64')}` };
  }

  return { status, open, reload, fileFor, directory };
}
