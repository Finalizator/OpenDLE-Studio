/**
 * MODELDEF, as a mod writes it.
 *
 * ```text
 * Model RotStar
 * {
 *     Model 0 "RotStar.obj"
 *     USEACTORPITCH
 *     USEACTORROLL
 *     ROTATING
 *     RollOffset 90
 *     Rotation-Vector 0 0 1
 *     Rotation-Speed 0.5
 *     FrameIndex PLAY A 0 0
 * }
 * ```
 *
 * The block names an actor class, declares the model files it may show (`Model <index> "<file>"`)
 * and then maps sprite frames onto them with `FrameIndex <sprite> <letter> <frame> <model>`.
 * `ROTATING` spins the mesh inside its own frame around `Rotation-Vector` at
 * `Rotation-Speed` degrees per tic, which is how a mod makes a decoration turn without a
 * single line of script — so it is imported as data onto the actor, not faked per object.
 */

const DEFAULT_ROTATION_VECTOR = [0, 0, 1];

function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** The tokens of one quoted or bare argument. */
function argumentsOf(rest) {
  const values = [];
  for (const match of rest.matchAll(/"([^"]*)"|([^\s{}]+)/g)) values.push(match[1] ?? match[2]);
  return values;
}

/**
 * Parses every `Model <Class> { ... }` block in the given MODELDEF sources.
 * Returns one record per actor class, in declaration order.
 */
export function parseModelDefs(sources = []) {
  const definitions = [];
  for (const source of sources) {
    const text = stripComments(typeof source === 'string' ? source : source.text ?? '');
    // `Model <Name> {` opens a block; `Model <index> "<file>"` inside one is a mesh.
    const opener = /(^|\s)model\s+([A-Za-z_][\w.]*)\s*(?=\{)/gi;
    let match;
    while ((match = opener.exec(text))) {
      const name = match[2];
      const open = text.indexOf('{', match.index + match[0].length);
      if (open < 0) continue;
      let depth = 0, close = -1;
      for (let at = open; at < text.length; at++) {
        if (text[at] === '{') depth++;
        else if (text[at] === '}' && --depth === 0) { close = at; break; }
      }
      const body = text.slice(open + 1, close < 0 ? text.length : close);
      definitions.push(parseModelBlock(name, body));
      if (close > 0) opener.lastIndex = close;
    }
  }
  return definitions;
}

function parseModelBlock(name, body) {
  const record = {
    name, models: [], frames: [], rotating: false,
    rotationVector: [...DEFAULT_ROTATION_VECTOR], rotationSpeed: 1, rollOffset: 0, pitchOffset: 0,
    angleOffset: 0, scale: [1, 1, 1], offset: [0, 0, 0], useActorPitch: false, useActorRoll: false,
  };
  for (const rawLine of body.split(/[\r\n;]/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [keyword, ...rest] = line.split(/\s+/);
    const args = argumentsOf(line.slice(keyword.length));
    const numbers = args.map(Number);
    switch (keyword.toLowerCase()) {
      case 'model':
        if (args.length >= 2) record.models.push({ index: Number(args[0]) || 0, file: args[1] });
        break;
      case 'frameindex':
        // FrameIndex <sprite> <letter> <frame> <model>
        if (args.length >= 4) {
          record.frames.push({ sprite: String(args[0]).toUpperCase(), letter: String(args[1]).toUpperCase(),
            frame: Number(args[2]) || 0, model: Number(args[3]) || 0 });
        }
        break;
      case 'rotating': record.rotating = true; break;
      case 'useactorpitch': record.useActorPitch = true; break;
      case 'useactorroll': record.useActorRoll = true; break;
      case 'rotation-vector':
        if (numbers.length >= 3 && numbers.slice(0, 3).every(Number.isFinite)) record.rotationVector = numbers.slice(0, 3);
        break;
      case 'rotation-speed': if (Number.isFinite(numbers[0])) record.rotationSpeed = numbers[0]; break;
      case 'rolloffset': if (Number.isFinite(numbers[0])) record.rollOffset = numbers[0]; break;
      case 'pitchoffset': if (Number.isFinite(numbers[0])) record.pitchOffset = numbers[0]; break;
      case 'angleoffset': if (Number.isFinite(numbers[0])) record.angleOffset = numbers[0]; break;
      case 'scale':
        if (numbers.length >= 3 && numbers.every(Number.isFinite)) record.scale = numbers.slice(0, 3);
        else if (Number.isFinite(numbers[0])) record.scale = [numbers[0], numbers[0], numbers[0]];
        break;
      case 'offset':
        if (numbers.length >= 3 && numbers.every(Number.isFinite)) record.offset = numbers.slice(0, 3);
        break;
      default: break;
    }
  }
  return record;
}

/** The model a sprite frame shows, or null when the definition has no mesh for it. */
export function modelForFrame(definition, sprite, letter) {
  if (!definition) return null;
  const wanted = `${String(sprite).toUpperCase()}${String(letter).toUpperCase()}`;
  for (const frame of definition.frames) {
    if (`${frame.sprite}${frame.letter}` !== wanted) continue;
    const model = definition.models.find(entry => entry.index === frame.model);
    if (model) return model;
  }
  return null;
}
