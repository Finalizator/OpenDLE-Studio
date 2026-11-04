import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const directories = ['shared', 'server', 'public', 'test', 'scripts', 'scriptlets'];
let failed = false;
for (const directory of directories) {
  for (const file of readdirSync(directory, { recursive: directory === 'scriptlets' }).filter(name => /\.(?:js|mjs)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('All JavaScript syntax checks passed.');
