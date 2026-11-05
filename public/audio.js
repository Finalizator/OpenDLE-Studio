import { parseMusic } from '../shared/music.js';
import { soundCandidates, soundTable, VANILLA_SOUNDS } from '../shared/sndinfo.js';
import { createMusicScheduler, musicBytes } from './music-player.js';

function bytesFromDataUri(src) {
  const comma = src.indexOf(',');
  if (comma < 0) throw new Error('Embedded sound data is malformed');
  const binary = atob(src.slice(comma + 1));
  return Uint8Array.from(binary, char => char.charCodeAt(0)).buffer;
}

function setAudioPosition(param, value, context) {
  if (param?.setValueAtTime) param.setValueAtTime(value, context.currentTime);
  else if (param) param.value = value;
}

/** Positional looping sources for sound components on ordinary project entities. */
export function createEntityAudioRuntime(project, context, destination, onError = () => {}) {
  const soundAssets = new Map((project.assets || []).filter(asset => asset.kind === 'sound').map(asset => [asset.id, asset]));
  const decoded = new Map(), voices = new Map(), reported = new Set();
  let disposed = false;
  let latestState = null;

  const reportOnce = (key, error) => {
    if (reported.has(key) || disposed) return;
    reported.add(key);
    onError(new Error(`World sound: ${error.message}`));
  };
  const load = asset => {
    if (!decoded.has(asset.id)) {
      decoded.set(asset.id, Promise.resolve().then(() => context.decodeAudioData(bytesFromDataUri(asset.src)))
        .catch(error => { decoded.delete(asset.id); throw error; }));
    }
    return decoded.get(asset.id);
  };
  const stop = (entry, preservePosition = false) => {
    if (!entry?.source) return;
    const source = entry.source;
    if (preservePosition && entry.buffer && Number.isFinite(entry.startedAt)) {
      const elapsed = Math.max(0, context.currentTime - entry.startedAt);
      entry.offset = source.loop && entry.buffer.duration > 0
        ? (entry.offset + elapsed) % entry.buffer.duration
        : Math.min(entry.buffer.duration || 0, entry.offset + elapsed);
    }
    entry.source = null;
    source.onended = null;
    try { source.stop(); } catch { /* a source can end between frames */ }
    try { source.disconnect(); } catch { /* already disconnected */ }
    try { entry.panner?.disconnect(); } catch { /* already disconnected */ }
    try { entry.gain?.disconnect(); } catch { /* already disconnected */ }
    entry.panner = entry.gain = null;
  };
  const positionNode = (node, x, y, z) => {
    if (!node) return;
    if (node.positionX) {
      setAudioPosition(node.positionX, x, context);
      setAudioPosition(node.positionY, y, context);
      setAudioPosition(node.positionZ, z, context);
    } else node.setPosition?.(x, y, z);
  };
  const update = state => {
    if (disposed) return;
    latestState = state;
    const active = state.gameScreen === 'playing' || state.ambientWorld;
    const player = state.player || {};
    const listener = context.listener;
    positionNode(listener, player.x || 0, player.z || 0, player.y || 0);
    const seen = new Set();
    for (const entity of state.entities || []) {
      const sound = entity.sound;
      if (!sound?.autoplay) continue;
      seen.add(entity.id);
      let entry = voices.get(entity.id);
      if (!entry || entry.assetId !== sound.assetId) {
        stop(entry);
        entry = { assetId: sound.assetId, source: null, panner: null, gain: null, finished: false, offset: 0 };
        voices.set(entity.id, entry);
      }
      const asset = soundAssets.get(sound.assetId);
      if (!asset) {
        reportOnce(`${entity.id}:asset`, new Error(sound.assetId ? `sound asset ${sound.assetId} is missing` : `no sound asset is assigned to ${entity.name || entity.id}`));
        continue;
      }
      const radius = Math.max(1, Number(sound.radius) || 1024);
      const dx = (entity.x || 0) - (player.x || 0);
      const dy = (entity.y || 0) - (player.y || 0);
      const dz = (entity.z ?? entity.elevation ?? 0) - (player.z || 0);
      const distance = Math.hypot(dx, dy, dz);
      if (!active || distance >= radius) {
        stop(entry, true);
        continue;
      }
      const attenuation = Math.max(0, 1 - distance / radius);
      if (entry.source) {
        if (entry.gain) setAudioPosition(entry.gain.gain, (Number.isFinite(Number(sound.volume)) ? Number(sound.volume) : 1) * attenuation, context);
        positionNode(entry.panner, entity.x || 0, entity.z ?? entity.elevation ?? 0, entity.y || 0);
        continue;
      }
      if (entry.finished) continue;
      load(asset).then(buffer => {
        if (disposed || entry.source || voices.get(entity.id) !== entry) return;
        const current = (latestState?.entities || []).find(item => item.id === entity.id);
        if (!current?.sound?.autoplay || !(latestState.gameScreen === 'playing' || latestState.ambientWorld)) return;
        const currentPlayer = latestState.player || {};
        const currentRadius = Math.max(1, Number(current.sound.radius) || 1024);
        if (Math.hypot((current.x || 0) - (currentPlayer.x || 0), (current.y || 0) - (currentPlayer.y || 0),
          (current.z ?? current.elevation ?? 0) - (currentPlayer.z || 0)) >= currentRadius) return;
        const source = context.createBufferSource();
        const gain = context.createGain();
        const panner = context.createPanner?.() || null;
        source.buffer = buffer;
        source.loop = current.sound.loop !== false;
        entry.buffer = buffer;
        gain.gain.value = (Number.isFinite(Number(current.sound.volume)) ? Number(current.sound.volume) : 1) *
          Math.max(0, 1 - Math.hypot((current.x || 0) - (currentPlayer.x || 0), (current.y || 0) - (currentPlayer.y || 0),
            (current.z ?? current.elevation ?? 0) - (currentPlayer.z || 0)) / currentRadius);
        if (panner) {
          panner.panningModel = 'HRTF';
          panner.distanceModel = 'linear';
          panner.refDistance = 1;
          panner.maxDistance = currentRadius;
          panner.rolloffFactor = 0;
          positionNode(panner, current.x || 0, current.z ?? current.elevation ?? 0, current.y || 0);
          source.connect(panner);
          panner.connect(gain);
        } else source.connect(gain);
        gain.connect(destination);
        entry.source = source; entry.panner = panner; entry.gain = gain;
        source.onended = () => {
          if (entry.source !== source) return;
          entry.source = null;
          entry.offset = source.loop ? 0 : (buffer.duration || 0);
          entry.finished = !source.loop;
          try { source.disconnect(); panner?.disconnect(); gain.disconnect(); } catch { /* already disconnected */ }
        };
        try {
          entry.startedAt = context.currentTime;
          source.start(0, entry.offset);
        } catch (error) { stop(entry); entry.finished = true; reportOnce(`${entity.id}:start`, error); }
      }).catch(error => reportOnce(`${entity.id}:decode`, new Error(`${asset.name}: ${error.message}`)));
    }
    for (const [id, entry] of voices) {
      if (seen.has(id)) continue;
      stop(entry);
      voices.delete(id);
    }
  };
  return {
    update,
    dispose() {
      disposed = true;
      for (const entry of voices.values()) stop(entry);
      voices.clear(); decoded.clear();
    },
    get activeSources() { return [...voices.values()].filter(entry => entry.source).length; },
  };
}

export function createAudioPlayer(project, onError, AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext, existingContext) {
  if (!AudioContextClass && !existingContext) throw new Error('Web Audio is unavailable in this browser');
  const context = existingContext || new AudioContextClass();
  // Sound assets are matched case-insensitively: WAD lumps are upper case,
  // DECORATE and ACS name them in lower case, and a mod may do either.
  const assets = new Map(project.assets.filter(asset => asset.kind === 'sound').map(asset => [asset.name.toUpperCase(), asset]));
  // The game's own SNDINFO wins, but the built-in vanilla table is always merged
  // in: a project imported before SNDINFO support still resolves `grunt/sight`.
  const aliases = soundTable(VANILLA_SOUNDS, project.soundAliases);
  const missing = new Set(), buffers = new Map(), voices = new Set();
  const decodeFailed = new Set();
  const master = context.createGain(); master.connect(context.destination);
  const musicGain = context.createGain(); musicGain.connect(context.destination);
  let disposed = false;
  const report = error => { if (!disposed) onError(`Audio: ${error.message}`); };
  const entityAudio = createEntityAudioRuntime(project, context, master, report);
  let music = null, musicName = null, musicScore = null, musicStarted = false;
  let musicRequested = null, musicTrack = null, musicError = null, musicVolume = 1;
  let reportedOverflow = false;
  const resume = () => {
    if (disposed) return;
    return context.resume().catch(report);
  };
  // Called from the Play click before asynchronous renderer loading.
  resume();
  const musicScheduler = createMusicScheduler(context, { destination: musicGain, onError: report });
  /**
   * Resolves a logical name (`grunt/sight`) or lump name (`dspistol`) to an asset.
   * A `$random` group is a list, so the first member that actually exists wins.
   */
  function assetFor(name) {
    const key = String(name ?? '').toUpperCase();
    for (const candidate of soundCandidates(key, aliases)) {
      const asset = assets.get(candidate.toUpperCase());
      if (asset) return asset;
    }
    return null;
  }
  function load(name) {
    const asset = assetFor(name);
    if (!asset) {
      // One report per missing name: a monster that cannot find its sight sound
      // would otherwise repeat the same message on every encounter.
      if (!missing.has(name)) {
        missing.add(name);
        return Promise.reject(new Error(`Unknown embedded sound: ${name}`));
      }
      return Promise.resolve(null);
    }
    if (!buffers.has(asset.id)) {
      const binary = atob(asset.src.split(',')[1]);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      buffers.set(asset.id, context.decodeAudioData(bytes.buffer).then(undefined, error => {
        // A corrupt or unsupported sound must not flood the log on every play:
        // report once per asset, then stay silent like a missing name does.
        buffers.delete(asset.id);
        if (!decodeFailed.has(asset.id)) {
          decodeFailed.add(asset.id);
          report(new Error(`${asset.name}: ${error.message}`));
        }
        return null;
      }));
    }
    return buffers.get(asset.id);
  }
  return {
    resume,
    /** Diagnostics for the editor status line: is a soundtrack embedded and playing? */
    musicInfo() {
      return { requested: musicRequested, track: musicTrack, playing: Boolean(musicScore) && musicScheduler.playing,
        hasMusicAssets: project.assets.some(asset => asset.kind === 'music'), error: musicError, volume: musicVolume };
    },
    update(state) {
      // The overall sound level is an engine tweak: it scales every effect and the
      // soundtrack on top of their own volumes, and it is remembered per browser.
      const level = Number(state.settings?.masterVolume ?? 1);
      const overall = Number.isFinite(level) ? Math.min(Math.max(level, 0), 1) : 1;
      master.gain.value = state.settings?.muted ? 0 : (state.settings?.volume ?? 1) * overall;
      musicVolume = (state.settings?.musicVolume ?? .5) * overall;
      musicGain.gain.value = state.settings?.muted ? 0 : musicVolume;
      entityAudio.update(state);
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
        project.assets.find(asset => asset.kind === 'sound' && asset.music &&
          (asset.id === requested || asset.name === requested)) ||
        project.assets.find(asset => asset.kind === 'sound' && asset.music);
      if (track && track.kind === 'music' && !musicStarted) {
        musicStarted = true;
        // An embedded WAV/OGG/MP3 track replaced by a MIDI/MUS track must not keep
        // playing underneath the synthesized score.
        music?.stop(); music?.disconnect(); music = null; musicName = null;
        try {
          musicScore = parseMusic(musicBytes(track), track.name);
          musicTrack = track.name;
          if (!musicScheduler.start(musicScore)) { musicScore = null; musicError = 'the score has no playable notes'; }
        } catch (error) { musicError = error.message; report(new Error(`Music ${track.name}: ${error.message}`)); }
        return;
      }
      if (track && track.kind === 'sound' && musicName !== track.name) {
        const name = track.name;
        musicName = name;
        // Replacing a synthesized MIDI/MUS score with a streamed track must stop the
        // synthesizer, not layer the two soundtracks (and clears the stale identity).
        musicScheduler.stop();
        musicScore = null; musicTrack = null;
        load(name).then(buffer => {
          // A slower earlier request must not start over the track chosen since: decoding is
          // asynchronous, so both loads can be in flight at once.
          if (disposed || musicName !== name) return;
          // Replacing the previous embedded track stops it rather than layering it.
          music?.stop(); music?.disconnect();
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
          if (disposed || !buffer) return;
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
      entityAudio.dispose();
      music?.stop(); music?.disconnect(); master.disconnect(); musicGain.disconnect();
      for (const source of voices) source.stop();
      voices.clear(); buffers.clear();
      // A shared (primed) context outlives one preview, so only close our own.
      if (!existingContext) context.close().catch(error => onError(`Audio cleanup: ${error.message}`));
    },
  };
}
