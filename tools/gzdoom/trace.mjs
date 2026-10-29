// Parses a GZDoom `.trace` file (or an OpenDLE one, they use the same lines) into
// structured samples, so a comparison never has to re-parse text.
//
//   node tools/gzdoom/trace.mjs logs/gzdoom/map01-idle.trace
//
// Line shape, printed by tools/gzdoom/trace/zscript.zs and by opendle-trace.mjs:
//   ODT <tic> <tag> cls=<class> x=… y=… z=… vx=… vy=… vz=… angle=… pitch=… health=… tics=…
//   ODT EVENT <tic> damaged=<class> damage=<n> health=<n> type=<name>
//   ODT EVENT <tic> died=<class> inflictor=<class>
import { readFileSync } from 'node:fs';

const NUMERIC = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'angle', 'pitch'];

/** One sample per tic and tag; later tics win, so a source can print a tic twice. */
export function parseTrace(text) {
  const header = { map: null, tics: null, action: '', watch: '', tid: 0 };
  const samples = new Map();
  const events = [];
  let ended = false;

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('ODT')) continue;
    if (line.startsWith('ODT START')) {
      header.map = /map=(\S+)/.exec(line)?.[1] ?? null;
      header.tics = Number(/tics=(-?\d+)/.exec(line)?.[1] ?? 0);
      header.action = /action=(\S*)/.exec(line)?.[1] ?? '';
      header.watch = /watch=(\S*)/.exec(line)?.[1] ?? '';
      header.tid = Number(/tid=(-?\d+)/.exec(line)?.[1] ?? 0);
      continue;
    }
    if (line.startsWith('ODT END')) { ended = true; continue; }
    if (line.startsWith('ODT EVENT')) {
      const fields = fieldsOf(line);
      events.push({ tic: Number(fields.tic), ...numberise(fields) });
      continue;
    }
    const match = /^ODT (-?\d+) (\S+) (.*)$/.exec(line);
    if (!match) continue;
    const fields = fieldsOf(match[3]);
    samples.set(`${Number(match[1])}/${match[2]}`, { tic: Number(match[1]), tag: match[2], ...numberise(fields) });
  }

  return { header, ended, samples: [...samples.values()].sort((a, b) => a.tic - b.tic), events };
}

function fieldsOf(text) {
  const fields = {};
  for (const token of text.split(/\s+/)) {
    const at = token.indexOf('=');
    if (at > 0) fields[token.slice(0, at)] = token.slice(at + 1);
  }
  const head = text.split(/\s+/)[0];
  if (/^\d+$/.test(head) || /^-?\d+$/.test(head)) fields.tic = head;
  return fields;
}

function numberise(fields) {
  const result = { ...fields };
  // `frame` and `spr` are numbers too: leaving `frame` a string made `frameLetter('0')`
  // produce a letter that matched nothing, and the actor's starting state was never aligned.
  for (const key of [...NUMERIC, 'health', 'tics', 'damage', 'tic', 'frame', 'spr']) {
    if (result[key] !== undefined && result[key] !== '' && Number.isFinite(Number(result[key]))) result[key] = Number(result[key]);
  }
  return result;
}

export function readTrace(path) {
  return parseTrace(readFileSync(path, 'utf8'));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node tools/gzdoom/trace.mjs <file.trace>');
    process.exit(2);
  }
  const trace = readTrace(path);
  const tags = new Set(trace.samples.map(sample => sample.tag));
  console.log(`map ${trace.header.map} | ${trace.samples.length} samples | tags ${[...tags].join(',')} | ${trace.events.length} events | ended ${trace.ended}`);
  console.log(JSON.stringify(trace.samples.slice(0, 3), null, 1));
}
