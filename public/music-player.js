// Web Audio synthesizer for the note scores produced by shared/music.js.
// No sampled instruments: each General MIDI family becomes a small oscillator
// patch, and percussion is filtered noise. Bounded voices keep it cheap.

const VOICE_BUDGET = 64;
const LOOKAHEAD_SECONDS = 1.5;
// A frozen tab, a shader compile or a long GC leaves notes in the past. Playing
// them all "now" is the burst that sounds like one loud chord; past this much
// lateness the backlog is dropped and the timeline re-anchors to the audio clock.
const STALL_SECONDS = .25;
// Anything only a little late is still played, but never this far behind.
const LATE_GRACE_SECONDS = .05;

const families = {
  piano: { type: 'triangle', attack: .004, decay: .35, sustain: .25, release: .25, gain: .22, detune: 0, harmonic: 2, harmonicGain: .12 },
  chromatic: { type: 'triangle', attack: .006, decay: .3, sustain: .3, release: .3, gain: .2, detune: 4, harmonic: 3, harmonicGain: .06 },
  organ: { type: 'sine', attack: .01, decay: .1, sustain: .85, release: .12, gain: .18, detune: 0, harmonic: 2, harmonicGain: .18 },
  guitar: { type: 'sawtooth', attack: .005, decay: .25, sustain: .18, release: .18, gain: .14, detune: 6, harmonic: 2, harmonicGain: .1 },
  bass: { type: 'square', attack: .006, decay: .22, sustain: .3, release: .2, gain: .2, detune: 0, harmonic: 1.5, harmonicGain: .12 },
  strings: { type: 'sawtooth', attack: .12, decay: .2, sustain: .7, release: .5, gain: .11, detune: 8, harmonic: 2, harmonicGain: .05 },
  ensemble: { type: 'sawtooth', attack: .1, decay: .2, sustain: .65, release: .45, gain: .1, detune: 10, harmonic: 2, harmonicGain: .04 },
  brass: { type: 'sawtooth', attack: .03, decay: .18, sustain: .55, release: .22, gain: .13, detune: 3, harmonic: 2, harmonicGain: .12 },
  reed: { type: 'square', attack: .04, decay: .2, sustain: .5, release: .25, gain: .12, detune: 2, harmonic: 3, harmonicGain: .05 },
  pipe: { type: 'sine', attack: .05, decay: .15, sustain: .6, release: .3, gain: .14, detune: 0, harmonic: 2, harmonicGain: .1 },
  synthlead: { type: 'square', attack: .01, decay: .2, sustain: .5, release: .2, gain: .12, detune: 0, harmonic: 2, harmonicGain: .07 },
  synthpad: { type: 'sawtooth', attack: .2, decay: .3, sustain: .6, release: .6, gain: .09, detune: 12, harmonic: 2, harmonicGain: .03 },
  synthfx: { type: 'triangle', attack: .02, decay: .4, sustain: .2, release: .4, gain: .1, detune: 20, harmonic: 4, harmonicGain: .03 },
  ethnic: { type: 'triangle', attack: .01, decay: .25, sustain: .3, release: .3, gain: .15, detune: 5, harmonic: 2, harmonicGain: .08 },
  percussive: { type: 'triangle', attack: .002, decay: .12, sustain: .05, release: .1, gain: .18, detune: 0, harmonic: 4, harmonicGain: .05 },
  effect: { type: 'sawtooth', attack: .02, decay: .5, sustain: .1, release: .5, gain: .08, detune: 30, harmonic: 5, harmonicGain: .02 },
};

export function instrumentPatch(family) {
  return families[family] || families.piano;
}

export function noteFrequency(note) {
  return 440 * Math.pow(2, (note - 69) / 12);
}

export function musicBytes(asset) {
  if (typeof asset?.src !== 'string' || !asset.src.startsWith('data:')) throw new Error('Music asset has no embedded data');
  const base64 = asset.src.slice(asset.src.indexOf(',') + 1);
  const binary = atob(base64), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * Schedules parsed notes on an AudioContext. `start()` may be called again after
 * `stop()`; volume follows the game's music setting.
 */
export function createMusicScheduler(context, { destination, onError = () => {}, lookahead = LOOKAHEAD_SECONDS } = {}) {
  let timer = null, voices = 0, disposed = false, current = null, startedAt = 0, loop = 0, index = 0;
  // Diagnostics: how often a stall forced the timeline to re-anchor, and how many
  // notes were dropped rather than burst.
  let stalls = 0, skipped = 0;
  // Created on first percussion hit so a context without buffer support (or a
  // silent track) never pays for it.
  let noise = null;
  function noiseBuffer() {
    if (noise) return noise;
    const length = Math.floor(context.sampleRate * .35), buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) channel[i] = Math.random() * 2 - 1;
    noise = buffer;
    return buffer;
  }
  function playNote(note, when) {
    if (disposed || !current) return;
    const duration = Math.max(.03, note.duration);
    const patch = instrumentPatch(note.family);
    const gain = context.createGain();
    const level = Math.max(.01, Math.min(1, note.velocity)) * patch.gain;
    gain.gain.setValueAtTime(.0001, when);
    gain.gain.exponentialRampToValueAtTime(level, when + patch.attack);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0005, level * patch.sustain), when + patch.attack + patch.decay);
    gain.gain.setValueAtTime(Math.max(.0005, level * patch.sustain), when + Math.max(duration, patch.attack + patch.decay));
    gain.gain.exponentialRampToValueAtTime(.0001, when + Math.max(duration, patch.attack + patch.decay) + patch.release);
    gain.connect(destination);
    if (note.drum) {
      const source = context.createBufferSource(), filter = context.createBiquadFilter();
      source.buffer = noiseBuffer();
      filter.type = 'bandpass';
      filter.frequency.value = note.note < 40 ? 120 : note.note < 50 ? 400 : note.note < 60 ? 2200 : 6500;
      filter.Q.value = .9;
      source.connect(filter); filter.connect(gain);
      source.start(when); source.stop(when + Math.min(.35, duration + .05));
      return;
    }
    const oscillator = context.createOscillator();
    oscillator.type = patch.type;
    oscillator.frequency.value = noteFrequency(note.note);
    oscillator.detune.value = patch.detune;
    oscillator.connect(gain);
    let harmonic = null;
    if (patch.harmonicGain > 0) {
      const harmonicGain = context.createGain();
      harmonicGain.gain.value = patch.harmonicGain;
      harmonic = {
        oscillator: context.createOscillator(), gain: harmonicGain,
      };
      harmonic.oscillator.type = 'sine';
      harmonic.oscillator.frequency.value = noteFrequency(note.note) * patch.harmonic;
      harmonic.oscillator.connect(harmonicGain); harmonicGain.connect(gain);
      harmonic.oscillator.start(when); harmonic.oscillator.stop(when + duration + patch.release + .05);
    }
    oscillator.start(when); oscillator.stop(when + duration + patch.release + .05);
    voices++;
    oscillator.onended = () => { voices = Math.max(0, voices - 1); harmonic = null; };
  }
  /** When the next un-played note should sound, or null when the score is done. */
  function pendingTime() {
    const note = current?.score.notes[index];
    if (!note) return null;
    return startedAt + loop * current.score.seconds + note.time;
  }
  function scheduleWindow() {
    if (disposed || !current) return;
    const score = current.score, now = context.currentTime, horizon = now + lookahead;
    // A stalled tab or a long pause would otherwise try to catch up on thousands
    // of past notes at once.
    if (startedAt + loop * score.seconds + score.seconds < now) { startedAt = now + .05; loop = 0; index = 0; }
    // Re-anchor after a stall: the missed notes are dropped instead of fired
    // together, so the music resumes in step instead of stuttering a chord.
    const pending = pendingTime();
    if (pending !== null && now - pending > STALL_SECONDS) { startedAt += now - pending; stalls++; }
    for (let guard = 0; guard < 1000; guard++) {
      const loopStart = startedAt + loop * score.seconds;
      if (loopStart > horizon) break;
      while (index < score.notes.length) {
        const note = score.notes[index], when = loopStart + note.time;
        if (when > horizon) break;
        if (when < now - LATE_GRACE_SECONDS) { index++; skipped++; continue; }
        if (voices < VOICE_BUDGET) {
          try { playNote(note, Math.max(now, when)); }
          catch (error) { onError(error); }
        }
        index++;
      }
      if (index < score.notes.length) break; // waiting for the next lookahead window
      loop++; index = 0;
    }
  }
  return {
    get playing() { return Boolean(current); },
    get loop() { return loop; },
    get stalls() { return stalls; },
    get skipped() { return skipped; },
    start(scoreData) {
      if (disposed) return false;
      this.stop();
      if (!scoreData?.notes?.length || !(scoreData.seconds > 0)) return false;
      current = { score: scoreData };
      startedAt = context.currentTime + .05;
      loop = 0; index = 0; stalls = 0; skipped = 0;
      scheduleWindow();
      timer = setInterval(scheduleWindow, Math.max(50, lookahead * 500));
      return true;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null; current = null; index = 0; loop = 0;
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null; current = null;
    },
  };
}
