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
  // `0.4.0_alpha` and `0.4.0 alpha` are how people write a pre-release in a text file; SemVer
  // spells it `0.4.0-alpha`. Reading the separator generously keeps a hand-edited version
  // from stopping the studio — a build manifest still has to carry a valid one.
  const normalized = typeof version === 'string' ? version.replace(/^["']|["']$/g, '').replace(/[_\s]+/g, '-') : version;
  if (!normalized || normalized.length > 128 || !new RegExp(`^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`).test(normalized)) {
    throw new Error('version.ini: version must be SemVer, for example 0.1.0 or 0.2.0-beta.1');
  }
  return normalized;
}
