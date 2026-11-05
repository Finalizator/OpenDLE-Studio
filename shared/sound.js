import { projectIds } from './project-ids.js';

/**
 * The container signatures a sound may arrive in.
 *
 * These are the formats a browser decodes without a plugin: WAV, Ogg (Vorbis or Opus — both are
 * `OggS` streams), FLAC and MP3. `opus` shares the Ogg signature but keeps its own MIME type so
 * the player reports the format the author actually used.
 */
const SOUND_SIGNATURES = {
  wav: { mime: 'wav', test: (bytes, at) => at(82, 73, 70, 70) && bytes.length >= 44 && at(87, 65, 86, 69, 8) },
  ogg: { mime: 'ogg', test: (bytes, at) => at(79, 103, 103, 83) && bytes.length >= 27 },
  opus: { mime: 'ogg', test: (bytes, at) => at(79, 103, 103, 83) && bytes.length >= 27 },
  flac: { mime: 'flac', test: (bytes, at) => at(102, 76, 97, 67) && bytes.length >= 42 },
  mp3: { mime: 'mpeg', test: (bytes, at) => bytes.length >= 4 && (at(73, 68, 51) || bytes[0] === 255 && (bytes[1] & 224) === 224) },
};
/** Every extension `Import sounds` accepts. */
export const SOUND_FORMATS = Object.keys(SOUND_SIGNATURES);

export function encodeSound(bytes, format) {
  const signature = SOUND_SIGNATURES[format];
  if (!signature) throw new Error(`Unsupported sound format ${format}: use ${SOUND_FORMATS.join(', ')}`);
  const at = (...values) => {
    // A trailing offset argument lets a signature be checked inside the header rather than at byte 0.
    const offset = values.length === 5 ? values.pop() : 0;
    return values.every((value, index) => bytes[offset + index] === value);
  };
  const valid = signature.test(bytes, at) && bytes.length <= 8 * 1024 * 1024;
  if (!valid) throw new Error(`Invalid or oversized ${format} sound (maximum 8 MiB)`);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:audio/${signature.mime};base64,${btoa(binary)}`;
}

export function encodeMusic(bytes, format) {
  if (!['midi', 'mus'].includes(format)) throw new Error(`Unsupported music format ${format}`);
  const header = format === 'midi'
    ? bytes[0] === 77 && bytes[1] === 84 && bytes[2] === 104 && bytes[3] === 100
    : bytes[0] === 77 && bytes[1] === 85 && bytes[2] === 83 && bytes[3] === 0x1a;
  if (!header) throw new Error(`Invalid ${format === 'midi' ? 'MIDI' : 'MUS'} music data`);
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Music track exceeds 2 MiB');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return `data:audio/${format === 'midi' ? 'midi' : 'x-mus'};base64,${btoa(binary)}`;
}

export function wavSound(samples, sampleRate) {
  if (!(samples instanceof Uint8Array) || !samples.length || samples.length > 2 * 1024 * 1024 ||
    !Number.isInteger(sampleRate) || sampleRate < 4000 || sampleRate > 48000) throw new Error('Invalid PCM sound samples/rate');
  const bytes = new Uint8Array(44 + samples.length), view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((char, i) => { bytes[offset + i] = char.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, 'data'); view.setUint32(40, samples.length, true); bytes.set(samples, 44);
  return encodeSound(bytes, 'wav');
}

export function doomSound(bytes) {
  if (bytes.length < 8) throw new Error('Truncated Doom sound');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 3) throw new Error('Only Doom DMX PCM sounds are supported');
  const rate = view.getUint16(2, true), count = view.getUint32(4, true);
  if (count <= 32 || count > bytes.length - 8) throw new Error('Invalid Doom sound sample count');
  // The lump is the 8-byte header followed by `count` samples: real IWAD lumps
  // satisfy `count === lump.size - 8`, with no 16-byte name pad before the data.
  return wavSound(bytes.subarray(8, 8 + count), rate);
}

export const ENGINE_SOUNDS = ['DSPUNCH', 'DSPISTOL', 'DSSHOTGN', 'DSSGT2F', 'DSRLAUNC', 'DSPLASMA', 'DSBFG', 'DSSAWFUL',
  'DSBAREXP', 'DSFIRXPL', 'DSPLPAIN', 'DSPODTH1', 'DSITEMUP', 'DSDOROPN', 'DSPSTART'];

export function installEngineSounds(project) {
  project.assets ||= [];
  const used = projectIds(project);
  ENGINE_SOUNDS.forEach((name, index) => {
    if (project.assets.some(asset => asset.kind === 'sound' && asset.name === name)) return;
    const samples = new Uint8Array(1600);
    let seed = index + 1;
    for (let i = 0; i < samples.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[i] = 128 + Math.round((Math.sin(i * (.08 + index * .017)) * 30 + (seed / 4294967296 - .5) * 60) * (1 - i / samples.length));
    }
    let id = `engine_sound_${index}`;
    while (used.has(id)) id += '_';
    used.add(id);
    project.assets.push({ id, name, kind: 'sound', src: wavSound(samples, 11025), generated: true });
  });
}
