/**
 * SNDINFO: the table that turns a logical sound name into a lump.
 *
 * DECORATE and ZScript states never name a file. They say `grunt/sight` or
 * `weapons/pistol`, and SNDINFO maps that onto `DSPOSIT1` or `DSPISTOL` — sometimes
 * through a `$random` group of several lumps. Without this table an imported
 * monster asks the audio player for a file that does not exist, which is why a
 * playtest used to fail on every sight and attack sound.
 *
 * Names are compared case-insensitively because ACS and DECORATE disagree about
 * case and WAD lumps are case-folded on read.
 */

const COMMAND = /^\$/;
// Logical names may start with `*` (`*pain`, `*death`), which marks engine-wide
// player sounds rather than actor sounds.
const IDENTIFIER = /^\*?[a-z0-9_][a-z0-9_/*#-]*$/i;

/**
 * Splits SNDINFO text into assignments. `$random` groups are kept as member lists
 * so the runtime can pick one per occurrence; every other `$` command (rolloff,
 * limits, ambient, player sounds) does not affect name resolution.
 */
export function parseSndInfo(text) {
  const aliases = {}, random = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const group = /^\$random\s+(\S+)\s*\{([^}]*)\}/i.exec(line);
    if (group) {
      const members = group[2].trim().split(/\s+/).map(name => name.toLowerCase()).filter(Boolean);
      if (members.length) random[group[1].toLowerCase()] = members;
      continue;
    }
    // `$playersound <class> <gender> <name> <lump>` defines the same logical name
    // for several genders; the first definition is the one a single-player game uses.
    const player = /^\$playersound\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i.exec(line);
    if (player) {
      const [, , , name, lump] = player;
      if (IDENTIFIER.test(name) && !(name.toLowerCase() in aliases)) aliases[name.toLowerCase()] = lump.toUpperCase();
      continue;
    }
    // `$playersounddup` aliases one player sound to another, so the chain has to be
    // followed (`*pain50` -> `*pain100` -> the lump).
    const duplicate = /^\$playersounddup\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i.exec(line);
    if (duplicate) {
      const [, , , name, target] = duplicate;
      if (IDENTIFIER.test(name) && IDENTIFIER.test(target) && !(name.toLowerCase() in aliases)) {
        aliases[name.toLowerCase()] = target;
      }
      continue;
    }
    const alias = /^\$alias\s+(\S+)\s+(\S+)/i.exec(line);
    if (alias) {
      const [, name, target] = alias;
      if (IDENTIFIER.test(name) && IDENTIFIER.test(target)) aliases[name.toLowerCase()] = target;
      continue;
    }
    if (COMMAND.test(line)) continue;
    const [name, target] = line.split(/\s+/);
    if (!name || !target || !IDENTIFIER.test(name) || /\.(wav|ogg|flac|mp3)$/i.test(target)) continue;
    if (target === '{' || target === '}') continue;
    aliases[name.toLowerCase()] = target.toUpperCase();
  }
  return { aliases, random };
}

/**
 * One table merged from the built-in vanilla defaults and the game's own files.
 * A later definition replaces an earlier one outright: a mod that redefines
 * `grunt/sight` as a single lump must not keep the vanilla random group.
 */
export function soundTable(...sources) {
  const table = { aliases: {}, random: {} };
  for (const source of sources) {
    if (!source) continue;
    for (const [name, lump] of Object.entries(source.aliases || source)) {
      if (!IDENTIFIER.test(name) || typeof lump !== 'string') continue;
      delete table.random[name];
      table.aliases[name] = lump;
    }
    for (const [name, members] of Object.entries(source.random || {})) {
      if (!Array.isArray(members) || !members.length) continue;
      delete table.aliases[name];
      table.random[name] = members;
    }
  }
  return table;
}

export function hasSoundTable(table) {
  return Boolean(table && (Object.keys(table.aliases || {}).length || Object.keys(table.random || {}).length));
}

/**
 * Resolves a sound name to a lump name. `pick` chooses a member of a `$random`
 * group; it returns the name unchanged when nothing matches, so the caller can
 * report the name the game actually asked for.
 */
export function resolveSoundName(name, table, pick = Math.random) {
  if (typeof name !== 'string' || !name) return '';
  let current = name.trim();
  const seen = new Set();
  for (let depth = 0; depth < 8; depth++) {
    const key = current.toLowerCase();
    if (seen.has(key)) return current;
    seen.add(key);
    const members = table?.random?.[key];
    if (members?.length) {
      current = members[Math.min(members.length - 1, Math.floor(pick() * members.length))];
      continue;
    }
    const alias = table?.aliases?.[key];
    if (!alias || alias.toLowerCase() === key) return current;
    current = alias;
  }
  return current;
}

/**
 * Every concrete name a logical name can resolve to, expanding `$random` groups
 * and alias chains. The audio player uses this so a group whose first member is
 * missing from the WAD still plays one that exists.
 */
export function soundCandidates(name, table, limit = 12) {
  if (typeof name !== 'string' || !name) return [];
  const results = [];
  const seen = new Set();
  const walk = (current, depth) => {
    if (results.length >= limit || depth > 6) return;
    const key = current.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const members = table?.random?.[key];
    if (members?.length) { for (const member of members) walk(member, depth + 1); return; }
    const alias = table?.aliases?.[key];
    if (alias && alias.toLowerCase() !== key) { walk(alias, depth + 1); return; }
    results.push(current);
  };
  walk(name.trim(), 0);
  return results;
}

/** Every logical name the table defines, for diagnostics. */
export function soundAliasNames(table) {
  return [...new Set([...Object.keys(table?.aliases || {}), ...Object.keys(table?.random || {})])].sort();
}

// Vanilla Doom sound aliases.
// DECORATE/ZScript states name sounds logically (`grunt/sight`, `weapons/pistol`) and
// SNDINFO maps those names onto lumps. Generated from the alias table GZDoom itself
// ships (gzdoom.pk3 filter/game-doomchex/sndinfo.txt), so a plain WAD import without
// gzdoom.pk3 still resolves the standard monster and weapon sounds.
export const VANILLA_SOUNDS = {
  aliases: {
    // `$playersound player <gender> *fist dspunch` from gzdoom.pk3's root SNDINFO.
    '*fist': 'DSPUNCH', 'baby/active': 'DSBSPACT', 'baby/attack': 'DSPLASMA', 'baby/death': 'DSBSPDTH', 'baby/pain': 'DSDMPAIN',
    'baby/shotx': 'DSFIRXPL', 'baby/sight': 'DSBSPSIT', 'baby/walk': 'DSBSPWLK', 'baron/active': 'DSDMACT',
    'baron/attack': 'DSFIRSHT', 'baron/death': 'DSBRSDTH', 'baron/melee': 'DSCLAW', 'baron/pain': 'DSDMPAIN',
    'baron/shotx': 'DSFIRXPL', 'baron/sight': 'DSBRSSIT', 'brain/cube': 'DSBOSCUB',
    'brain/cubeboom': 'DSFIRXPL', 'brain/death': 'DSBOSDTH', 'brain/pain': 'DSBOSPN',
    'brain/sight': 'DSBOSSIT', 'brain/spit': 'DSBOSPIT', 'caco/active': 'DSDMACT', 'caco/attack': 'DSFIRSHT',
    'caco/death': 'DSCACDTH', 'caco/pain': 'DSDMPAIN', 'caco/shotx': 'DSFIRXPL', 'caco/sight': 'DSCACSIT',
    'chainguy/active': 'DSPOSACT', 'chainguy/attack': 'DSSHOTGN', 'chainguy/death1': 'DSPODTH1',
    'chainguy/death2': 'DSPODTH2', 'chainguy/death3': 'DSPODTH3', 'chainguy/pain': 'DSPOPAIN',
    'chainguy/sight1': 'DSPOSIT1', 'chainguy/sight2': 'DSPOSIT2', 'chainguy/sight3': 'DSPOSIT3',
    'cyber/active': 'DSDMACT', 'cyber/death': 'DSCYBDTH', 'cyber/hoof': 'DSHOOF', 'cyber/pain': 'DSDMPAIN',
    'cyber/sight': 'DSCYBSIT', 'demon/active': 'DSDMACT', 'demon/death': 'DSSGTDTH',
    'demon/melee': 'DSSGTATK', 'demon/pain': 'DSDMPAIN', 'demon/sight': 'DSSGTSIT',
    'doors/dr1_clos': 'DSDORCLS', 'doors/dr1_open': 'DSDOROPN', 'doors/dr2_clos': 'DSBDCLS',
    'doors/dr2_open': 'DSBDOPN', 'fatso/active': 'DSPOSACT', 'fatso/attack': 'DSFIRSHT',
    'fatso/death': 'DSMANDTH', 'fatso/pain': 'DSMNPAIN', 'fatso/raiseguns': 'DSMANATK',
    'fatso/shotx': 'DSFIRXPL', 'fatso/sight': 'DSMANSIT', 'grunt/active': 'DSPOSACT',
    'grunt/attack': 'DSPISTOL', 'grunt/death1': 'DSPODTH1', 'grunt/death2': 'DSPODTH2',
    'grunt/death3': 'DSPODTH3', 'grunt/pain': 'DSPOPAIN', 'grunt/sight1': 'DSPOSIT1',
    'grunt/sight2': 'DSPOSIT2', 'grunt/sight3': 'DSPOSIT3', 'imp/active': 'DSBGACT', 'imp/attack': 'DSFIRSHT',
    'imp/death1': 'DSBGDTH1', 'imp/death2': 'DSBGDTH2', 'imp/melee': 'DSCLAW', 'imp/pain': 'DSPOPAIN',
    'imp/shotx': 'DSFIRXPL', 'imp/sight1': 'DSBGSIT1', 'imp/sight2': 'DSBGSIT2', 'keen/death': 'DSKEENDT',
    'keen/pain': 'DSKEENPN', 'knight/active': 'DSDMACT', 'knight/death': 'DSKNTDTH',
    'knight/pain': 'DSDMPAIN', 'knight/sight': 'DSKNTSIT', 'menu/activate': 'DSSWTCHN',
    'menu/backup': 'DSSWTCHN', 'menu/change': 'DSSTNMOV', 'menu/choose': 'DSPISTOL', 'menu/clear': 'DSSWTCHX',
    'menu/cursor': 'DSPSTOP', 'menu/dismiss': 'DSSWTCHX', 'menu/invalid': 'DSOOF', 'menu/prompt': 'DSSWTCHN',
    'misc/chat': 'DSRADIO', 'misc/chat2': 'DSTINK', 'misc/gibbed': 'DSSLOP', 'misc/i_pkup': 'DSITEMUP',
    'misc/k_pkup': 'DSITEMUP', 'misc/p_pkup': 'DSGETPOW', 'misc/secret': 'DSSECRET', 'misc/spawn': 'DSITMBK',
    'misc/teleport': 'DSTELEPT', 'misc/unused': 'DSSKLDTH', 'misc/w_pkup': 'DSWPNUP',
    'pain/active': 'DSDMACT', 'pain/death': 'DSPEDTH', 'pain/pain': 'DSPEPAIN', 'pain/sight': 'DSPESIT',
    'plats/pt1_mid': 'DSSTNMOV', 'plats/pt1_stop': 'DSPSTOP', 'plats/pt1_strt': 'DSPSTART',
    'shotguy/active': 'DSPOSACT', 'shotguy/attack': 'DSSHOTGN', 'shotguy/death1': 'DSPODTH1',
    'shotguy/death2': 'DSPODTH2', 'shotguy/death3': 'DSPODTH3', 'shotguy/pain': 'DSPOPAIN',
    'shotguy/sight1': 'DSPOSIT1', 'shotguy/sight2': 'DSPOSIT2', 'shotguy/sight3': 'DSPOSIT3',
    'skeleton/active': 'DSSKEACT', 'skeleton/attack': 'DSSKEATK', 'skeleton/death': 'DSSKEDTH',
    'skeleton/melee': 'DSSKEPCH', 'skeleton/pain': 'DSPOPAIN', 'skeleton/sight': 'DSSKESIT',
    'skeleton/swing': 'DSSKESWG', 'skeleton/tracex': 'DSBAREXP', 'skull/active': 'DSDMACT',
    'skull/death': 'DSFIRXPL', 'skull/melee': 'DSSKLATK', 'skull/pain': 'DSDMPAIN',
    'spectre/active': 'DSDMACT', 'spectre/death': 'DSSGTDTH', 'spectre/melee': 'DSSGTATK',
    'spectre/pain': 'DSDMPAIN', 'spectre/sight': 'DSSGTSIT', 'spider/active': 'DSDMACT',
    'spider/attack': 'DSSHOTGN', 'spider/death': 'DSSPIDTH', 'spider/pain': 'DSDMPAIN',
    'spider/sight': 'DSSPISIT', 'spider/walk': 'DSMETAL', 'switches/exitbutn': 'DSSWTCHX',
    'switches/normbutn': 'DSSWTCHN', 'vile/active': 'DSVILACT', 'vile/death': 'DSVILDTH',
    'vile/firecrkl': 'DSFLAME', 'vile/firestrt': 'DSFLAMST', 'vile/pain': 'DSVIPAIN', 'vile/raise': 'DSSLOP',
    'vile/sight': 'DSVILSIT', 'vile/start': 'DSVILATK', 'vile/stop': 'DSBAREXP', 'weapons/bfgf': 'DSBFG',
    'weapons/bfgx': 'DSRXPLOD', 'weapons/chngun': 'DSPISTOL', 'weapons/grbnce': 'DSBOUNCE',
    'weapons/grenlf': 'DSGLAUNC', 'weapons/grenlx': 'DSGRNEXP', 'weapons/pistol': 'DSPISTOL',
    'weapons/plasmaf': 'DSPLASMA', 'weapons/plasmax': 'DSFIRXPL', 'weapons/railgf': 'RAILGF1',
    'weapons/rocklf': 'DSRLAUNC', 'weapons/rocklx': 'DSBAREXP', 'weapons/sawfull': 'DSSAWFUL',
    'weapons/sawhit': 'DSSAWHIT', 'weapons/sawidle': 'DSSAWIDL', 'weapons/sawup': 'DSSAWUP',
    'weapons/shotgf': 'DSSHOTGN', 'weapons/shotgr': 'DSSGCOCK', 'weapons/sshotc': 'DSDBCLS',
    'weapons/sshotf': 'DSDSHTGN', 'weapons/sshotl': 'DSDBLOAD', 'weapons/sshoto': 'DSDBOPN',
    'wolfss/active': 'DSPOSACT', 'wolfss/attack': 'DSSHOTGN', 'wolfss/death': 'DSSSDTH',
    'wolfss/pain': 'DSPOPAIN', 'wolfss/sight': 'DSSSSIT', 'world/barrelx': 'DSBAREXP',
    'world/drip': 'DSEMPTY', 'world/lavasizzle': 'DSEMPTY', 'world/sludgegloop': 'DSEMPTY',
    'world/watersplash': 'DSEMPTY',
  },
  random: {
    'grunt/sight': ['grunt/sight1', 'grunt/sight2', 'grunt/sight3'],
    'grunt/death': ['grunt/death1', 'grunt/death2', 'grunt/death3'],
    'shotguy/sight': ['shotguy/sight1', 'shotguy/sight2', 'shotguy/sight3'],
    'shotguy/death': ['shotguy/death1', 'shotguy/death2', 'shotguy/death3'],
    'chainguy/sight': ['chainguy/sight1', 'chainguy/sight2', 'chainguy/sight3'],
    'chainguy/death': ['chainguy/death1', 'chainguy/death2', 'chainguy/death3'],
    'imp/sight': ['imp/sight1', 'imp/sight2'],
    'imp/death': ['imp/death1', 'imp/death2'],
    'menu/quit1': ['player/male/death1', 'demon/pain', 'grunt/pain', 'misc/gibbed', 'misc/teleport', 'grunt/sight1', 'grunt/sight3', 'demon/melee'],
    'menu/quit2': ['vile/active', 'misc/p_pkup', 'brain/cube', 'misc/gibbed', 'skeleton/swing', 'knight/death', 'baby/active', 'demon/melee'],
  },
};
