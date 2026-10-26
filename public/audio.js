import { parseMusic } from '../shared/music.js';
import { createMusicScheduler, musicBytes } from './music-player.js';

export function createAudioPlayer(project, onError, AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext, existingContext) {
  if (!AudioContextClass && !existingContext) throw new Error('Web Audio is unavailable in this browser');
  const context = existingContext || new AudioContextClass();
  const assets = new Map(project.assets.filter(asset => asset.kind === 'sound').map(asset => [asset.name, asset]));
  const buffers = new Map(), voices = new Set();
  const master = context.createGain(); master.connect(context.destination);
  const musicGain = context.createGain(); musicGain.connect(context.destination);
  let music = null, musicName = null, musicScore = null, musicStarted = false;
  let musicRequested = null, musicTrack = null, musicError = null, musicVolume = 1;
  let disposed = false;
  let reportedOverflow = false;
  const report = error => { if (!disposed) onError(`Audio: ${error.message}`); };
  const resume = () => {
    if (disposed) return;
    return context.resume().catch(report);
  };
  // Called from the Play click before asynchronous renderer loading.
  resume();
  const musicScheduler = createMusicScheduler(context, { destination: musicGain, onError: report });
  function load(name) {
    if (!assets.has(name)) return Promise.reject(new Error(`Unknown embedded sound: ${name}`));
    if (!buffers.has(name)) {
      const binary = atob(assets.get(name).src.split(',')[1]);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      buffers.set(name, context.decodeAudioData(bytes.buffer));
    }
    return buffers.get(name);
  }
  return {
    resume,
    /** Diagnostics for the editor status line: is a soundtrack embedded and playing? */
    musicInfo() {
      return { requested: musicRequested, track: musicTrack, playing: Boolean(musicScore) && musicScheduler.playing,
        hasMusicAssets: project.assets.some(asset => asset.kind === 'music'), error: musicError, volume: musicVolume };
    },
    update(state) {
      master.gain.value = state.settings?.muted ? 0 : state.settings?.volume ?? 1;
      musicVolume = state.settings?.musicVolume ?? .5;
      musicGain.gain.value = state.settings?.muted ? 0 : musicVolume;
      // ACS `SetMusic` asks the level to change track; the request wins over the
      // level's default for the rest of the session.
      if (state.musicRequest?.name && state.musicRequest.name !== musicTrack && state.musicRequest.name !== musicName) {
        const name = state.musicRequest.name;
        state.musicRequest = null;
        musicStarted = false;
        musicRequested = name;
      }
      const requested = musicRequested || project.environment?.musicAsset || project.environment?.music;
      musicRequested ??= requested || null;
      const track = project.assets.find(asset => asset.kind === 'music' &&
        (asset.id === requested || asset.name === requested)) ||
        project.assets.find(asset => asset.kind === 'sound' && asset.music);
      if (track && track.kind === 'music' && !musicStarted) {
        musicStarted = true;
        try {
          musicScore = parseMusic(musicBytes(track), track.name);
          musicTrack = track.name;
          if (!musicScheduler.start(musicScore)) { musicScore = null; musicError = 'the score has no playable notes'; }
        } catch (error) { musicError = error.message; report(new Error(`Music ${track.name}: ${error.message}`)); }
        return;
      }
      if (track && track.kind === 'sound' && musicName !== track.name) {
        musicName = track.name;
        load(track.name).then(buffer => {
          if (disposed) return;
          music = context.createBufferSource(); music.buffer = buffer; music.loop = true;
          music.connect(musicGain); music.start();
        }).catch(report);
      }
      if (state.soundOverflow) {
        if (!reportedOverflow) { report(new Error('Sound event limit reached; excess effects were skipped to keep gameplay running')); reportedOverflow = true; }
        state.soundOverflow = 0;
      }
      for (const event of state.sounds.splice(0)) {
        const attenuation = event.x === undefined ? 1 : Math.max(0, 1 - Math.hypot(event.x - state.player.x, event.y - state.player.y) / 1200);
        if (!attenuation) continue;
        load(event.name).then(buffer => {
          if (disposed) return;
          if (voices.size >= 32) {
            const oldest = voices.values().next().value;
            oldest.stop(); voices.delete(oldest);
          }
          const source = context.createBufferSource(), gain = context.createGain();
          source.buffer = buffer; gain.gain.value = event.volume * attenuation;
          source.connect(gain); gain.connect(master);
          source.onended = () => { voices.delete(source); source.disconnect(); gain.disconnect(); };
          voices.add(source); source.start();
        }).catch(report);
      }
    },
    dispose() {
      disposed = true;
      musicScheduler.dispose();
      music?.stop(); music?.disconnect(); master.disconnect(); musicGain.disconnect();
      for (const source of voices) source.stop();
      voices.clear(); buffers.clear();
      // A shared (primed) context outlives one preview, so only close our own.
      if (!existingContext) context.close().catch(error => onError(`Audio cleanup: ${error.message}`));
    },
  };
}
