import { readFileSync } from 'node:fs';

export function readEngineVersion(file) {
  const source = readFileSync(file, 'utf8');
  let section = '', version;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line === '[engine]' && !section) { section = 'engine'; continue; }
    const match = section === 'engine' && /^version\s*=\s*(\S+)$/.exec(line);
    if (!match || version !== undefined) throw new Error('version.ini: expected [engine] and one version entry');
    version = match[1];
  }
  const number = '(?:0|[1-9][0-9]*)';
  const prerelease = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  if (!version || version.length > 128 || !new RegExp(`^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(version)) {
    throw new Error('version.ini: version must be SemVer, for example 0.1.0 or 0.2.0-beta.1');
  }
  return version;
}
