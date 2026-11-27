import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const directories = ['shared', 'server', 'public', 'test', 'scripts', 'scriptlets', 'tools'];
let failed = false;
for (const directory of directories) {
  // Every directory is walked to the bottom: `recursive: false` returns the *names* of subfolders,
  // which the extension filter drops, so `public/game/` — the whole exported player — and the test
  // fixtures were never syntax-checked while the script still said everything passed.
  for (const file of readdirSync(directory, { recursive: true }).filter(name => /\.(?:js|mjs)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('All JavaScript syntax checks passed.');
