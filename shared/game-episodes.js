// MAPINFO episode declarations populate GZDoom's dynamic EpisodeMenu rows.
import { LIMITS } from './limits.js';
export function parseGameEpisodes(definitions, levelIds, { inferClassic = true } = {}) {
  const available = new Set(levelIds), episodes = [], sources = [], warnings = [];
  const active = new Set();
  let budget = 0, declared = false;
  const unquote = token => token?.startsWith('"') ? JSON.parse(token) : token;
  function scan(definition, depth = 0) {
    const { name, source, resolve } = definition;
    if (depth > 16 || active.has(name)) throw new Error(`MAPINFO episode include cycle/depth: ${name}`);
    if (typeof source !== 'string' || source.length > LIMITS.textBytes) {
      throw new Error(`MAPINFO ${name} exceeds ${LIMITS.textBytes / 1024 / 1024} MiB`);
    }
    budget += source.length;
    if (budget > 2 * 1024 * 1024 || sources.length >= 64) throw new Error('MAPINFO episode source budget exceeded');
    sources.push({ name, source }); active.add(name);
    const tokens = source.match(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[a-zA-Z0-9_./$-]+|[{}=#]/g)
      ?.filter(token => !token.startsWith('//') && !token.startsWith('/*')) || [];
    for (let i = 0; i < tokens.length; i++) {
      const key = tokens[i].toLowerCase();
      if (key === 'include') {
        const path = unquote(tokens[++i]), included = resolve?.(path, name);
        if (!included) throw new Error(`${name}: missing MAPINFO include ${path}`);
        scan({ ...included, resolve }, depth + 1);
      } else if (key === 'clearepisodes') {
        episodes.length = 0; declared = true;
      } else if (key === 'episode') {
        declared = true;
        const levelId = unquote(tokens[++i])?.toUpperCase();
        const episode = { levelId, name: levelId, noSkillMenu: false };
        if (tokens[++i] !== '{') throw new Error(`${name}: expected episode block for ${levelId}`);
        let closed = false, remove = false;
        while (++i < tokens.length) {
          const field = tokens[i].toLowerCase();
          if (field === '}') { closed = true; break; }
          if (field === 'noskillmenu') episode.noSkillMenu = true;
          else if (field === 'remove') remove = true;
          else if (['name', 'picname', 'key'].includes(field)) {
            if (tokens[i + 1] === '=') i++;
            const value = unquote(tokens[++i]);
            if (!value || ['{', '}'].includes(value)) throw new Error(`${name}: missing episode ${field}`);
            episode[field === 'picname' ? 'patch' : field] = value;
          } else if (field !== '=') warnings.push(`${name}/${levelId}: unsupported episode field ${field}`);
        }
        if (!closed) throw new Error(`${name}: unterminated episode ${levelId}`);
        const index = episodes.findIndex(item => item.levelId === levelId);
        if (index !== -1) episodes.splice(index, 1);
        if (!remove) {
          if (!available.has(levelId)) warnings.push(`${name}: episode ${levelId} is unavailable and was not added to the menu`);
          else episodes.push(episode);
        }
      } else if (tokens[i] === '{') {
        let nesting = 1;
        while (++i < tokens.length && nesting) {
          if (tokens[i] === '{') nesting++;
          else if (tokens[i] === '}') nesting--;
        }
        i--;
      }
    }
    active.delete(name);
  }
  for (const [index, source] of definitions.entries())
    scan(typeof source === 'string' ? { name: `MAPINFO_${index}`, source } : source);
  if (!declared && inferClassic) for (let episode = 1; episode <= 4; episode++) {
    const levelId = `E${episode}M1`;
    if (available.has(levelId)) episodes.push({ levelId, name: [
      'Knee-Deep in the Dead', 'The Shores of Hell', 'Inferno', 'Thy Flesh Consumed',
    ][episode - 1], patch: `M_EPI${episode}`, noSkillMenu: false });
  }
  if (episodes.length > 32) throw new Error('Game exceeds 32 episode menu entries');
  return { episodes, sources, warnings, levelIds: [...available] };
}
