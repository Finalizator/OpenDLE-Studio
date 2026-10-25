import { execFile } from 'node:child_process';

export async function openLocalBrowser(url, { execute = execFile, platform = process.platform } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Only the local OpenDLE editor URL can be opened');
  }
  const commands = platform === 'darwin' ? [['open', parsed.href]]
    : platform === 'win32' ? [['rundll32.exe', 'url.dll,FileProtocolHandler', parsed.href]]
      : [['xdg-open', parsed.href], ['gio', 'open', parsed.href], ['brave-browser', parsed.href], ['firefox', parsed.href], ['google-chrome', parsed.href], ['chromium', parsed.href]];
  const failures = [];
  for (const [command, ...args] of commands) {
    const error = await new Promise(resolve => execute(command, args, { timeout: 10000 }, error => resolve(error)));
    if (!error) return;
    failures.push(`${command}: ${error.code || error.message}`);
  }
  throw new Error(`System browser could not open (${failures.join('; ')}). Open ${parsed.href} manually. Check your desktop's default HTTP browser association.`);
}
