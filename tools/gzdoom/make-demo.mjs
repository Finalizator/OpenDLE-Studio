// Writes a GZDoom demo (`.lmp`) from a scripted input timeline.
//
//   node tools/gzdoom/make-demo.mjs walk      # writes tools/gzdoom/demos/walk.lmp
//
// A demo is the only way to give GZDoom *exact* input. Writing the player's velocity from
// ZScript is not input — it bypasses the movement code, and doing it every tic wedged the
// engine — and there is no key-injection tool on this machine. The container is GZDoom's
// own IFF format, read by `G_ProcessIFFDemo` / `G_ReadDemoTiccmd` in src/g_game.cpp:
//
//   FORM <len> ZDEM
//     ZDHD  version:int16, min:int8, kind:int8, map:string, rngseed:int32, console:int8
//     UINF  player:int8, "\" + \key\value pairs   (a bare "\" means "all defaults")
//     BODY  per tic, per player: DEM_USERCMD then a flags byte and the changed fields
//
// so a timeline is a byte stream rather than a recording: the same file always plays back
// identically, and OpenDLE can replay the same timeline through its own key state.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Protocol ids and ticcmd flag bits, from src/d_protocol.h. */
const ID = {
  DEM_USERCMD: 1, DEM_EMPTYUSERCMD: 2, DEM_STOP: 7,
  BUTTONS: 0x01, PITCH: 0x02, YAW: 0x04, FORWARD: 0x08, SIDE: 0x10, UPMOVE: 0x20, ROLL: 0x40,
};

/** `DEMOGAMEVERSION` from src/version.h. */
const DEMO_VERSION = 0x221;

/**
 * A keyboard axis value, in the units a demo stores it in.
 *
 * `G_BuildTiccmd` ends with `cmd->forwardmove <<= 8`, so a demo's movement fields are 256
 * times the familiar Doom number: `u(25)` is a walk and `u(50)` a run. Writing the bare 25
 * instead produced a demo whose player never moved, because 25 of a 1/256th unit is 0.1%.
 */
const u = value => value * 256;

/**
 * Named input timelines.
 *
 * `forward`/`side` are movement axes in the units `u()` describes, `yaw` is a turn rate in
 * 1/65536 of a turn per tic (the engine applies `angle += yaw * 360 / 65536`), and
 * `buttons` uses Doom's button bits.
 */
export const TIMELINES = {
  // Hold forward for two seconds: the baseline for top speed, acceleration and the first
  // step the player meets.
  walk: { map: 'MAP01', ticks: [{ tics: 120, forward: u(25) }] },
  // The same with the running axis: Doom's two speeds differ by a factor of two in input
  // but not in output, because the acceleration curve is not linear.
  run: { map: 'MAP01', ticks: [{ tics: 120, forward: u(50) }] },
  // Walk a dozen tics, then let go: short enough that the player never reaches MAP01's
  // first step, so the coast to a halt is measured on flat ground.
  stop: { map: 'MAP01', ticks: [{ tics: 6, forward: u(25) }, { tics: 70 }] },
  // Strafe right: sideways speed has its own constants (`normsidemove`).
  strafe: { map: 'MAP01', ticks: [{ tics: 80, side: u(24) }] },
  // Hold the turn-right key, then walk. Doom's yaw is counter-clockwise, so turning right
  // is negative, and holding the key ramps: six tics at 320 before 640 (`SLOWTURNTICS`).
  turn: { map: 'MAP01', ticks: [{ tics: 6, yaw: -320 }, { tics: 29, yaw: -640 }, { tics: 80, forward: u(25) }] },
  // Walk into the first wall and keep pushing.
  wall: { map: 'MAP01', ticks: [{ tics: 200, forward: u(25) }] },
};

/**
 * One tic's command as bytes, relative to the tic before it.
 *
 * A demo stores a *difference*, not a snapshot: `UnpackUserCmd` starts from the previous
 * command and only overwrites the fields the flags name. `DEM_EMPTYUSERCMD` therefore means
 * "unchanged", not "no input" — a timeline that released a key by writing empty commands
 * kept the player walking forever, and the friction that was supposed to be measured never
 * happened. A field that becomes zero has to be written as a zero with its flag set.
 */
export function encodeTic(input = {}, previous = {}) {
  const fields = [];
  let flags = 0;
  const push16 = (flag, value) => { flags |= flag; fields.push(...int16(value | 0)); };
  const value = name => input[name] | 0, before = name => previous[name] | 0;
  const head = [];
  if (value('buttons') !== before('buttons')) { flags |= ID.BUTTONS; head.push(value('buttons') & 0x7f); }
  // Fields are written in the order `UnpackUserCmd` reads them.
  if (value('pitch') !== before('pitch')) push16(ID.PITCH, value('pitch'));
  if (value('yaw') !== before('yaw')) push16(ID.YAW, value('yaw'));
  if (value('forward') !== before('forward')) push16(ID.FORWARD, value('forward'));
  if (value('side') !== before('side')) push16(ID.SIDE, value('side'));
  if (value('upmove') !== before('upmove')) push16(ID.UPMOVE, value('upmove'));
  if (!flags) return Uint8Array.of(ID.DEM_EMPTYUSERCMD);
  return Uint8Array.from([ID.DEM_USERCMD, flags, ...head, ...fields]);
}

/**
 * Idle tics written before a timeline starts.
 *
 * GZDoom consumes a demo's first eight commands while the level is starting and none of
 * them reach the player, so a timeline written without a preroll loses its first eight
 * tics of input: a "hold turn for six tics then turn faster" demo arrived with the slow
 * phase already gone. Leading with eight idle commands puts the stream and the game back
 * in step, and an engine replaying the same list sees idle tics where GZDoom discarded
 * its own.
 */
export const DEMO_PREROLL = 8;

/** Every tic of a timeline, with the segments ({ tics, ...input }) expanded. */
export function ticInputs(timeline) {
  const list = [];
  for (let index = 0; index < DEMO_PREROLL; index++) {
    list.push({ forward: 0, side: 0, yaw: 0, upmove: 0, pitch: 0, buttons: 0 });
  }
  for (const segment of timeline.ticks || []) {
    for (let index = 0; index < Math.max(0, segment.tics | 0); index++) {
      list.push({
        forward: segment.forward || 0, side: segment.side || 0, yaw: segment.yaw || 0,
        upmove: segment.upmove || 0, pitch: segment.pitch || 0, buttons: segment.buttons || 0,
      });
    }
  }
  return list;
}

/* ------------------------------------------------------------------ the IFF container */

const ascii = text => Uint8Array.from(text, character => character.charCodeAt(0));

// The demo stream is big-endian: `UncheckedWriteInt16` puts `v >> 8` in the first byte, and
// the int32 writer does the same. Writing little-endian produced a file GZDoom read as a
// mangled form and then segfaulted on.
const int32 = value => Uint8Array.of((value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
const int16 = value => Uint8Array.of((value >> 8) & 0xff, value & 0xff);

/** A chunk: its id, its payload length, its payload, and the pad byte IFF needs when odd. */
function chunk(id, payload) {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const padded = body.length % 2 === 1 ? Uint8Array.from([...body, 0]) : body;
  return Uint8Array.from([...ascii(id), ...int32(body.length), ...padded]);
}

/** A one-player ZDoom demo that plays `timeline` when it is loaded. */
export function buildDemo(timeline, { rngSeed = 1, player = 0 } = {}) {
  const map = timeline.map || 'MAP01';
  // The header carries the map and the seed, so the demo reproduces the run it describes.
  const header = chunk('ZDHD', Uint8Array.from([
    ...int16(DEMO_VERSION), 2, 3, ...ascii(map), 0, ...int32(rngSeed), player,
  ]));
  // A lone backslash means "every userinfo value stays at its default" — but the chunk has
  // to exist: G_ProcessIFFDemo counts UINF chunks and rejects a demo that has none.
  const userinfo = chunk('UINF', Uint8Array.from([player, 0x5c]));
  const bytes = [];
  let previous = {};
  for (const input of ticInputs(timeline)) {
    bytes.push(...encodeTic(input, previous));
    previous = input;
  }
  const tics = bytes;
  const contents = Uint8Array.from([
    ...ascii('ZDEM'), ...header, ...userinfo,
    ...chunk('BODY', Uint8Array.from([...tics, ID.DEM_STOP])),
  ]);
  return Uint8Array.from([...ascii('FORM'), ...int32(contents.length), ...contents]);
}

/** Writes one named timeline and returns its path. */
export function writeDemo(name, { directory = join(here, 'demos') } = {}) {
  const timeline = TIMELINES[name];
  if (!timeline) throw new Error(`Unknown timeline ${name}; known: ${Object.keys(TIMELINES).join(', ')}`);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.lmp`);
  writeFileSync(path, buildDemo(timeline));
  return path;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
  for (const name of names.length ? names : Object.keys(TIMELINES)) console.log(writeDemo(name));
}
