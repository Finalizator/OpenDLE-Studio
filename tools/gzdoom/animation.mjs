// Turns a GZDoom trace into an animation table, and compares it with OpenDLE's actors.
//
//   node tools/gzdoom/animation.mjs logs/gzdoom/actor-zombieman.trace
//   node tools/gzdoom/animation.mjs logs/gzdoom/actor-zombieman.trace --compare
//
// GZDoom reports, for every label of an actor class, the frames it plays and how long each
// lasts (`ODT STATE`). That is the animation: a clip is a label's frames in order with their
// durations, which is exactly what OpenDLE's actor records store. `--compare` runs the same
// actor through the importer and reports every place the two disagree, which is how an
// animation that plays too fast (or stops on the wrong frame) gets found without watching it.
import { readFileSync } from 'node:fs';
import { readTrace } from './trace.mjs';

/**
 * The animation table of every class a trace described.
 *
 * `{ Zombieman: { Spawn: [{ sprite: 31, letter: 'A', tics: 10 }, …], … } }`
 *
 * A frame is `{ sprite, letter, tics }`, where `sprite` is GZDoom's sprite index (names are
 * not exposed to ZScript) and `letter` is the frame letter, `A` upwards. `tics` is the
 * duration; `-1` marks a state that holds forever (the last corpse frame).
 */
export function readAnimation(trace) {
  const classes = {};
  for (const line of lines(trace)) {
    const match = /^ODT STATE (\S+) label=(\S+) i=(\d+) spr=(-?\d+) frame=(\d+) tics=(-?\d+)$/.exec(line);
    if (!match) continue;
    const [, name, label, index, sprite, frame, tics] = match;
    const entry = classes[name] ||= {};
    const frames = entry[label] ||= [];
    frames[Number(index)] = { sprite: Number(sprite), letter: frameLetter(Number(frame)), tics: Number(tics) };
  }
  for (const labels of Object.values(classes)) {
    for (const [label, frames] of Object.entries(labels)) labels[label] = frames.filter(Boolean);
  }
  return classes;
}

function lines(trace) {
  return typeof trace === 'string' ? trace.split('\n') : (trace.lines || trace.log.split('\n'));
}

/** GZDoom's frame index is an offset from 'A'; the letter is what DECORATE writes. */
export function frameLetter(frame) {
  return frame >= 0 && frame < 26 ? String.fromCharCode(65 + frame) : `?${frame}`;
}

/** A clip as readable text: `A×10 B×8 …`, with `∞` for a state that holds forever. */
export function describeClip(frames) {
  return frames.map(({ letter, tics }) => `${letter}×${tics === -1 ? '∞' : tics}`).join(' ');
}

/** The duration a label runs for in total, ignoring a final hold-forever frame. */
export function clipDuration(frames) {
  return frames.reduce((total, frame) => total + (frame.tics > 0 ? frame.tics : 0), 0);
}

/**
 * Compares one measured label against the same label in an OpenDLE actor record.
 *
 * Returns a list of problems, each naming what differs, so a caller can print them all
 * instead of stopping at the first. Durations matter more than letters: a letter that is
 * off shows a wrong picture, a duration that is off makes the animation play at the wrong
 * speed and desynchronises every timing built on it.
 */
export function compareClip(label, measured, openDLE) {
  const problems = [];
  // A `Tics 0` state is Doom's "no delay": the actor advances out of it immediately, which
  // still costs the tic it entered on. OpenDLE's runtime costs one tic for it too, so the two
  // are compared as one tic rather than dropping the frame — dropping it made every actor
  // with a no-delay state look like it had a frame too many.
  const observed = measured.map(frame => ({ ...frame, tics: frame.tics === 0 ? 1 : frame.tics }));
  if (!openDLE || openDLE.length === 0) {
    if (observed.length) problems.push({ label, kind: 'missing', detail: `OpenDLE has no ${label} frames` });
    return problems;
  }
  const actual = openDLE.map(frame => ({ ...frame, tics: frame.tics === 0 ? 1 : frame.tics }));
  if (observed.length !== actual.length) {
    problems.push({ label, kind: 'length', detail: `${observed.length} frame(s) in GZDoom, ${actual.length} in OpenDLE` });
  }
  const count = Math.min(observed.length, actual.length);
  for (let index = 0; index < count; index++) {
    const a = observed[index], b = actual[index];
    if (a.letter !== b.letter) problems.push({ label, index, kind: 'letter', detail: `frame ${index}: ${a.letter} vs ${b.letter}` });
    if (a.tics !== b.tics) problems.push({ label, index, kind: 'tics', detail: `frame ${index} (${a.letter}): ${a.tics === -1 ? 'holds forever' : `${a.tics} tics`} vs ${b.tics === -1 ? 'holds forever' : `${b.tics} tics`}` });
  }
  return problems;
}

/** Every label of a measured class against an OpenDLE actor record's `states`. */
export function compareActor(name, measured, record) {
  const problems = [];
  if (!record) return [{ label: null, kind: 'actor', detail: `OpenDLE has no actor named ${name}` }];
  const frames = record.states?.frames || [];
  const labels = record.states?.labels || {};
  for (const [label, observed] of Object.entries(measured)) {
    const start = labels[label];
    const clip = start === undefined ? [] : collectLabel(frames, start);
    problems.push(...compareClip(label, observed, clip));
  }
  return problems;
}

/** The frames of one label: from its start until the next label or a jump. */
export function collectLabel(frames, start) {
  const result = [];
  for (let index = start; index < frames.length; index++) {
    const frame = frames[index];
    if (!frame) continue;
    if (frame.kind !== 'frame') {
      // `loop` back to this label ends it; `goto` elsewhere ends it too.
      if (frame.kind === 'loop' && result.length) break;
      if (frame.kind === 'goto' || frame.kind === 'stop') break;
      continue;
    }
    if (result.length && frame.label !== frames[start].label) break;
    result.push({ letter: frame.letter, tics: frame.duration, sprite: frame.sprite });
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--all')) {
    // Every measured class against a fresh import: the check that the generated table and
    // the actor records agree, without needing one trace per class.
    void (async () => {
      const { VANILLA_ANIMATIONS } = await import('/home/allukard/Code/OpenDLE/shared/vanilla-animations.js');
      const { importWad } = await import('/home/allukard/Code/OpenDLE/server/import.js');
      const iwad = args.find(arg => arg.endsWith('.wad')) || 'Projects/Doom2.wad';
      const { project } = importWad(readFileSync(iwad), 'MAP01');
      let total = 0;
      for (const [name, labels] of Object.entries(VANILLA_ANIMATIONS)) {
        const record = project.actors.find(actor => actor.name.toLowerCase() === name.toLowerCase());
        const problems = compareActor(name, labels, record);
        total += problems.length;
        if (!problems.length) { console.log(`${name.padEnd(18)} matches`); continue; }
        console.log(`${name.padEnd(18)} ${problems.length} difference(s)`);
        for (const problem of problems.slice(0, 6)) console.log(`  ${problem.kind.padEnd(7)} ${problem.detail}`);
      }
      console.log(total ? `${total} difference(s) in total` : 'all measured classes match');
      process.exitCode = total ? 1 : 0;
    })();
    return;
  }
  const path = args.find(arg => !arg.startsWith('--'));
  if (!path) {
    console.error('usage: node tools/gzdoom/animation.mjs <trace> [--compare] | --all');
    process.exit(2);
  }
  const trace = readFileSync(path, 'utf8');
  const animation = readAnimation(trace);
  for (const [name, labels] of Object.entries(animation)) {
    console.log(name);
    for (const [label, frames] of Object.entries(labels)) {
      console.log(`  ${label.padEnd(8)} ${String(frames.length).padStart(2)} frames, ${String(clipDuration(frames)).padStart(4)} tics  ${describeClip(frames)}`);
    }
  }
  if (!args.includes('--compare')) return;
  // Comparison needs an imported project, which is slower than reading a trace; it is
  // loaded here so a plain `animation.mjs <trace>` stays instant.
  void (async () => {
    const { readFileSync: read } = await import('node:fs');
    const { importWad } = await import('/home/allukard/Code/OpenDLE/server/import.js');
    const iwad = args.find(arg => arg.endsWith('.wad')) || 'Projects/Doom2.wad';
    const buffer = read(iwad);
    const { project } = importWad(buffer, 'MAP01');
    let total = 0;
    for (const [name, labels] of Object.entries(animation)) {
      const record = project.actors.find(actor => actor.name.toLowerCase() === name.toLowerCase());
      const problems = compareActor(name, labels, record);
      total += problems.length;
      if (!problems.length) { console.log(`${name}: matches`); continue; }
      console.log(`${name}: ${problems.length} difference(s)`);
      for (const problem of problems) console.log(`  ${problem.kind.padEnd(7)} ${problem.detail}`);
    }
    console.log(total ? `${total} difference(s) in total` : 'no differences');
    process.exitCode = total ? 1 : 0;
  })();
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
