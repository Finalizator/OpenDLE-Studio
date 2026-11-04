import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function scriptletFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && !/^[._]/.test(entry.name) && /\.(?:js|mjs)$/.test(entry.name))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(entry => {
      const version = createHash('sha256').update(readFileSync(join(directory, entry.name))).digest('hex');
      return { name: entry.name, url: `/scriptlets/${encodeURIComponent(entry.name)}?v=${version}` };
    });
}
