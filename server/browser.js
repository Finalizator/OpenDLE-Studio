import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function localEditorURL(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Only the local OpenDLE editor URL can be opened');
  }
  return parsed.href;
}

export async function openLocalBrowser(url, { execute = execFile, platform = process.platform } = {}) {
  const target = localEditorURL(url);
  const commands = platform === 'darwin' ? [['open', target]]
    : platform === 'win32' ? [['rundll32.exe', 'url.dll,FileProtocolHandler', target]]
      : [['xdg-open', target], ['gio', 'open', target], ['brave-browser', target], ['firefox', target], ['google-chrome', target], ['chromium', target]];
  const failures = [];
  for (const [command, ...args] of commands) {
    const error = await new Promise(resolve => execute(command, args, { timeout: 10000 }, error => resolve(error)));
    if (!error) return;
    failures.push(`${command}: ${error.code || error.message}`);
  }
  throw new Error(`System browser could not open (${failures.join('; ')}). Open ${target} manually. Check your desktop's default HTTP browser association.`);
}

export function spawnWindow(command, args, options = {}) {
  return new Promise(resolveSpawn => {
    const child = spawn(command, args, { ...options, stdio: 'ignore' });
    let timer, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSpawn(error);
    };
    child.once('error', finish);
    child.once('exit', (code, signal) => finish(code === 0 ? null
      : new Error(signal ? `stopped by ${signal}` : `exited with code ${code}`)));
    child.once('spawn', () => {
      child.unref();
      // Some browser wrappers spawn successfully, then immediately fail without opening a window.
      timer = setTimeout(() => finish(null), 1000);
    });
  });
}

export function chromiumCandidates(platform = process.platform, env = process.env) {
  if (env.OPENDLE_BROWSER) return [env.OPENDLE_BROWSER];
  if (platform === 'win32') {
    const home = env.USERPROFILE || homedir(), candidates = [];
    for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]) {
      if (!base) continue;
      candidates.push(
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      );
    }
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'));
    candidates.push(join(home, 'scoop', 'apps', 'googlechrome', 'current', 'chrome.exe'));
    return [...candidates, 'chrome.exe', 'msedge.exe', 'brave.exe'];
  }
  if (platform === 'darwin') {
    const home = env.HOME || homedir();
    return [
      join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      'google-chrome', 'chromium', 'microsoft-edge',
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'];
}

export async function openInAppWindow(url, { platform = process.platform, env = process.env, spawnImpl = spawnWindow } = {}) {
  const target = localEditorURL(url), failures = [];
  for (const candidate of chromiumCandidates(platform, env)) {
    if ((candidate.includes('/') || candidate.includes('\\')) && !existsSync(candidate)) {
      failures.push(`${candidate} (not installed)`);
      continue;
    }
    const error = await spawnImpl(candidate, [`--app=${target}`, '--no-first-run', '--no-default-browser-check']);
    if (!error) return { opened: true, command: candidate, failures };
    failures.push(`${candidate} (${error.code || error.message})`);
  }
  return { opened: false, failures };
}
