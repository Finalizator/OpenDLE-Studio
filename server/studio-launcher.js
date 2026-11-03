import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localEditorURL, spawnWindow } from './browser.js';

export function studioProfileDirectory(platform = process.platform, env = process.env) {
  if (env.OPENDLE_STUDIO_PROFILE) return resolve(env.OPENDLE_STUDIO_PROFILE);
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
  const base = platform === 'win32' ? env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    : platform === 'darwin' ? join(home, 'Library', 'Application Support') : env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'OpenDLE', 'Studio');
}

export async function openStudioWindow(url, { platform = process.platform, env = process.env, spawnImpl = spawnWindow, executable } = {}) {
  const target = localEditorURL(url);
  if (!executable) {
    try { executable = (await import('electron')).default; }
    catch (error) { throw new Error('OpenDLE desktop runtime is unavailable. Run npm ci to install it, or use --browser.', { cause: error }); }
  }
  const childEnv = { ...env };
  // VS Code can export this flag; the desktop shell must run as Electron, not as plain Node.
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const entry = fileURLToPath(new URL('../scripts/studio-desktop.js', import.meta.url));
  const error = await spawnImpl(executable, [entry, '--url', target, '--profile', studioProfileDirectory(platform, env)], { env: childEnv });
  if (error) throw new Error(`OpenDLE Studio window could not open (${error.code || error.message}). ` +
    'Run npm ci to restore the Electron desktop runtime. ' +
    `Use --browser to open a normal browser explicitly, or open ${target} manually.`);
  return { opened: true, command: executable };
}
