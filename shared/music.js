// Standard MIDI and Doom MUS reading, normalised to one note-event score.
// No synthesis happens here: this module is pure data so it is testable in Node.

const MAX_EVENTS = 200000;
const MAX_SECONDS = 900;
const MAX_TRACKS = 128;

function text(data, offset, length) {
  if (offset + length > data.length) return '';
  let value = '';
  for (let index = 0; index < length; index++) value += String.fromCharCode(data[offset + index]);
  return value;
}

function variableLength(data, offset, end) {
  let value = 0, count = 0, byte;
  do {
    if (offset >= end) throw new Error('Truncated music variable-length value');
    byte = data[offset++];
    value = (value << 7) | (byte & 0x7f);
    if (++count > 4) throw new Error('Oversized music variable-length value');
  } while (byte & 0x80);
  return { value, offset };
}

const midiProgramFamily = program => program < 8 ? 'piano' : program < 16 ? 'chromatic' : program < 24 ? 'organ'
  : program < 32 ? 'guitar' : program < 40 ? 'bass' : program < 48 ? 'strings' : program < 56 ? 'ensemble'
    : program < 64 ? 'brass' : program < 72 ? 'reed' : program < 80 ? 'pipe' : program < 88 ? 'synthlead'
      : program < 96 ? 'synthpad' : program < 104 ? 'synthfx' : program < 112 ? 'ethnic' : program < 120 ? 'percussive' : 'effect';

const midiNote = note => 440 * Math.pow(2, (note - 69) / 12);

function secondsAt(ticksToSeconds, tick) {
  return ticksToSeconds(tick);
}

/** Convert absolute MIDI ticks to seconds using the collected tempo map. */
function tempoConverter(tempoEvents, division) {
  const map = [...tempoEvents].sort((a, b) => a.tick - b.tick);
  if (!map.length || map[0].tick !== 0) map.unshift({ tick: 0, tempo: 500000 });
  const marks = [{ tick: 0, seconds: 0, tempo: map[0].tempo }];
  for (const event of map.slice(1)) {
    // A second tempo change on the same tick replaces the previous one instead of
    // adding a mark; indexing marks by loop counter would then read a hole.
    const last = marks[marks.length - 1];
    if (event.tick === last.tick) { last.tempo = event.tempo; continue; }
    const seconds = last.seconds + ((event.tick - last.tick) * last.tempo) / (division * 1e6);
    marks.push({ tick: event.tick, seconds, tempo: event.tempo });
  }
  return tick => {
    let low = 0, high = marks.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (marks[middle].tick <= tick) low = middle; else high = middle - 1;
    }
    const mark = marks[low];
    return mark.seconds + ((tick - mark.tick) * mark.tempo) / (division * 1e6);
  };
}

function score(notes, seconds, format, name) {
  const usable = notes.filter(note => Number.isFinite(note.time) && Number.isFinite(note.duration) &&
    note.duration > 0 && note.note >= 0 && note.note <= 127 && note.time <= MAX_SECONDS);
  usable.sort((a, b) => a.time - b.time || a.channel - b.channel || a.note - b.note);
  const length = Math.max(0, Math.min(MAX_SECONDS, seconds));
  return { format, name, seconds: length || (usable.length ? usable[usable.length - 1].time + usable[usable.length - 1].duration : 0), notes: usable };
}

export function parseMidi(data, name = 'music') {
  if (data.length < 14 || text(data, 0, 4) !== 'MThd') throw new Error(`${name}: missing MIDI header`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint32(4);
  if (headerLength < 6 || 8 + headerLength > data.length) throw new Error(`${name}: malformed MIDI header`);
  const tracks = view.getUint16(10);
  const division = view.getInt16(12);
  if (!tracks || tracks > MAX_TRACKS) throw new Error(`${name}: unsupported MIDI track count ${tracks}`);
  if (division <= 0) throw new Error(`${name}: SMPTE MIDI timing is not supported`);
  const events = [];
  let offset = 8 + headerLength;
  for (let track = 0; track < tracks; track++) {
    while (offset + 8 <= data.length && text(data, offset, 4) !== 'MTrk') offset++;
    if (offset + 8 > data.length) throw new Error(`${name}: missing MIDI track ${track}`);
    const length = view.getUint32(offset + 4);
    const end = Math.min(data.length, offset + 8 + length);
    let cursor = offset + 8, tick = 0, running = 0;
    while (cursor < end) {
      const delta = variableLength(data, cursor, end); cursor = delta.offset; tick += delta.value;
      if (cursor >= end) break;
      let status = data[cursor];
      if (status & 0x80) cursor++; else status = running;
      if (status < 0x80) throw new Error(`${name}: invalid MIDI running status`);
      if (status < 0xf0) running = status;
      const type = status & 0xf0, channel = status & 0x0f;
      if (status === 0xff) {
        const meta = data[cursor++];
        const size = variableLength(data, cursor, end); cursor = size.offset;
        if (cursor + size.value > end) throw new Error(`${name}: truncated MIDI meta event`);
        if (meta === 0x51 && size.value >= 3) {
          const tempo = (data[cursor] << 16) | (data[cursor + 1] << 8) | data[cursor + 2];
          if (tempo > 0) events.push({ tick, type: 'tempo', tempo });
        }
        cursor += size.value;
      } else if (status === 0xf0 || status === 0xf7) {
        const size = variableLength(data, cursor, end); cursor = size.offset + size.value;
      } else if (type === 0xc0 || type === 0xd0) {
        const program = data[cursor];
        if (type === 0xc0) events.push({ tick, type: 'program', channel, program: program & 0x7f });
        cursor += 1;
      } else {
        const a = data[cursor], b = data[cursor + 1];
        if (a === undefined || b === undefined) throw new Error(`${name}: truncated MIDI channel event`);
        if (type === 0x90 && (b & 0x7f) > 0) events.push({ tick, type: 'on', channel, note: a & 0x7f, velocity: b & 0x7f });
        else if (type === 0x80 || type === 0x90) events.push({ tick, type: 'off', channel, note: a & 0x7f });
        cursor += 2;
      }
      if (events.length > MAX_EVENTS) throw new Error(`${name}: MIDI event budget exceeded`);
    }
    offset = end;
  }
  const ticksToSeconds = tempoConverter(events.filter(event => event.type === 'tempo'), division);
  const active = new Map(), notes = [], programs = new Map();
  let endTick = 0;
  for (const event of events) {
    endTick = Math.max(endTick, event.tick);
    if (event.type === 'program') { programs.set(event.channel, event.program); continue; }
    if (event.type === 'tempo') continue;
    const key = `${event.channel}:${event.note}`;
    if (event.type === 'on') { active.set(key, { start: event.tick, velocity: event.velocity, program: programs.get(event.channel) || 0 }); continue; }
    const start = active.get(key);
    if (!start) continue;
    active.delete(key);
    const program = start.program;
    notes.push({ time: secondsAt(ticksToSeconds, start.start),
      duration: secondsAt(ticksToSeconds, event.tick) - secondsAt(ticksToSeconds, start.start),
      channel: event.channel, program, family: midiProgramFamily(program), drum: event.channel === 9,
      note: event.note, velocity: start.velocity / 127 });
  }
  return score(notes, secondsAt(ticksToSeconds, endTick), 'midi', name);
}

/** Doom MUS: 140 ticks per second, channel 15 is percussion, controller 0 is program. */
export function parseMus(data, name = 'music') {
  if (data.length < 16 || text(data, 0, 4) !== 'MUS\x1a') throw new Error(`${name}: missing MUS header`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const scoreLength = view.getUint16(4, true), scoreStart = view.getUint16(6, true);
  const end = Math.min(data.length, scoreStart + scoreLength);
  if (scoreStart < 16 || end > data.length) throw new Error(`${name}: malformed MUS score bounds`);
  const active = new Map(), notes = [], programs = new Map(), controllers = new Map();
  let offset = scoreStart, ticks = 0, events = 0, ended = false;
  const seconds = tick => tick / 140;
  while (offset < end && !ended) {
    if (++events > MAX_EVENTS) throw new Error(`${name}: MUS event budget exceeded`);
    const descriptor = data[offset++];
    const channel = descriptor & 0x0f;
    const type = descriptor & 0x70;
    if (type === 0x10) {
      const note = data[offset], volume = data[offset + 1]; offset += 2;
      if (volume > 0) active.set(`${channel}:${note}`, { start: ticks, velocity: volume, program: programs.get(channel) || 0 });
      else release(channel, note, ticks);
    } else if (type === 0x00) {
      release(channel, data[offset++], ticks);
    } else if (type === 0x20) {
      offset += 1;
    } else if (type === 0x30) {
      controllers.set(channel, data[offset++]);
    } else if (type === 0x40) {
      const value = data[offset++];
      if (controllers.get(channel) === 0) programs.set(channel, value & 0x7f);
    } else if (type === 0x60) {
      break; // score end: no trailing delay is stored
    } else {
      throw new Error(`${name}: unsupported MUS event type ${type >> 4}`);
    }
    const delay = variableLength(data, offset, end);
    offset = delay.offset; ticks += delay.value;
    if (ticks > MAX_SECONDS * 140) throw new Error(`${name}: MUS score exceeds the duration limit`);
  }
  for (const [key, start] of active) {
    const [channel, note] = key.split(':').map(Number);
    release(channel, note, Math.max(ticks, start.start + 1));
  }
  return score(notes, seconds(ticks), 'mus', name);

  function release(channel, note, endTick) {
    const key = `${channel}:${note}`, start = active.get(key);
    if (!start) return;
    active.delete(key);
    const program = start.program;
    notes.push({ time: seconds(start.start), duration: Math.max(0.02, seconds(endTick) - seconds(start.start)),
      channel, program, family: midiProgramFamily(program), drum: channel === 15, note, velocity: start.velocity / 127 });
  }
}

export function parseMusic(bytes, name = 'music') {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (text(data, 0, 4) === 'MThd') return parseMidi(data, name);
  if (text(data, 0, 4) === 'MUS\x1a') return parseMus(data, name);
  throw new Error(`${name}: unsupported music format (expected MIDI or Doom MUS)`);
}

// Doom II and Ultimate Doom keep their soundtrack order in the executable. This
// table only chooses the default track for a level; MAPINFO music overrides it.
// Names match the WAD lump names, which always carry the D_ prefix.
const doom2Music = ['RUNNIN', 'STALKS', 'COUNTD', 'BETWEE', 'DOOM', 'THE_DA', 'SHAWN', 'DDTBLU', 'IN_CIT', 'DEAD',
  'STLKS2', 'THEDA2', 'DOOM2', 'DDTBL2', 'RUNNI2', 'DEAD2', 'STLKS3', 'ROMERO', 'SHAWN2', 'MESSAG',
  'COUNT2', 'DDTBL3', 'AMPIE', 'THEDA3', 'ADRIAN', 'MESSG2', 'ROMER2', 'TENSE', 'SHAWN3', 'OPENIN',
  'EVIL', 'ULTIMA', 'READ_M', 'DM2TTL', 'DM2INT'];

/** Default music lump name for a level, or null when the game is not classic Doom. */
export function defaultLevelMusic(levelId) {
  const map = /^MAP(\d\d)$/i.exec(levelId || '');
  if (map) {
    const track = doom2Music[Number(map[1]) - 1];
    return track ? `D_${track}` : null;
  }
  // Ultimate Doom names its music after the map it belongs to, so MAPINFO or the
  // track itself is the only reliable source; the lump is optional.
  const episode = /^E(\d)M(\d)$/i.exec(levelId || '');
  if (episode) return `D_E${Number(episode[1])}M${Number(episode[2])}`;
  return null;
}

/** Candidate lump names for a level, most specific first. */
export function musicCandidates(levelId, explicit) {
  const names = [];
  if (explicit) names.push(String(explicit).toUpperCase());
  const primary = defaultLevelMusic(levelId);
  if (primary) names.push(primary);
  // Doom episodes reuse the second map's track when the first has none.
  const episode = /^E(\d)M1$/i.exec(levelId || '');
  if (episode) names.push(`D_E${Number(episode[1])}M2`);
  return [...new Set(names)];
}

/** Resolve the music asset for one level: explicit MAPINFO track, then classic default. */
export function resolveLevelMusic(levelId, explicit) {
  return (explicit ? String(explicit).toUpperCase() : null) || defaultLevelMusic(levelId);
}

/** First candidate lump that the game actually ships, or null. */
export function resolveMusicName(levelId, explicit, hasTrack) {
  return musicCandidates(levelId, explicit).find(name => hasTrack(name)) || null;
}
