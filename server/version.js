import { readFileSync } from 'node:fs';

const PRERELEASE = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(`^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)` +
  `(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/**
 * `0.4.0_alpha` and `0.4.0 alpha` are how people write a pre-release in a text file; SemVer spells
 * it `0.4.0-alpha`. Reading the separator generously keeps a hand-edited version from stopping the
 * studio — a build manifest still has to carry a valid one.
 */
function normalizeVersion(value) {
  const text = typeof value === 'string' ? value.replace(/^["']|["']$/g, '').replace(/[_\s]+/g, '-').trim() : '';
  return text && text.length <= 128 && SEMVER.test(text) ? text : null;
}

/**
 * Reads a `version.ini`, in either shape it is written in.
 *
 * The studio's own file is the one the author edits, and it has always been:
 *
 * ```ini
 * [engine]
 * version=0.4.87
 * ```
 *
 * An exported game writes both numbers, because a build is two things at once — the engine that
 * runs it and the game itself — and a bug report has to be able to say which of each:
 *
 * ```ini
 * [engine]
 * e_version=0.4.87
 * [game]
 * g_version=1.0.0
 * ```
 *
 * `game` is null when the file has no `[game]` section, which is every studio file.
 */
export function readVersionFile(file) {
  const source = readFileSync(file, 'utf8');
  const values = { engine: undefined, game: undefined };
  let section = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      if (!['engine', 'game'].includes(section)) throw new Error(`version.ini: unknown section [${header[1]}]`);
      if (values[section] !== undefined) throw new Error(`version.ini: [${section}] appears twice`);
      continue;
    }
    const entry = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)$/.exec(line);
    if (!entry || !section) throw new Error('version.ini: expected [engine] and one version entry');
    const [, key, value] = entry;
    // `version` is the studio's historical spelling; `e_version`/`g_version` are what a build
    // writes. Anything else is a typo, and a typo in a version file is worth stopping for.
    const expected = section === 'engine' ? ['version', 'e_version'] : ['g_version'];
    if (!expected.includes(key)) throw new Error(`version.ini: [${section}] does not take "${key}"`);
    if (values[section] !== undefined) throw new Error(`version.ini: expected [engine] and one version entry`);
    values[section] = normalizeVersion(value) ?? undefined;
    if (!values[section]) throw new Error('version.ini: version must be SemVer, for example 0.1.0 or 0.2.0-beta.1');
  }
  if (!values.engine) throw new Error('version.ini: expected [engine] and one version entry');
  return { engine: values.engine, game: values.game ?? null };
}

/** The engine version alone: what the studio displays, and what a build records as its builder. */
export function readEngineVersion(file) {
  return readVersionFile(file).engine;
}

/** The text an exported game ships: both numbers, in the shape the reader above accepts. */
export function gameVersionFile({ engine, game }) {
  if (!normalizeVersion(engine)) throw new Error('version.ini: engine version must be SemVer');
  if (!normalizeVersion(game)) throw new Error('version.ini: game version must be SemVer');
  return `[engine]\ne_version=${engine}\n[game]\ng_version=${game}\n`;
}
