# Water bodies

A **Water body** is a brush that is a volume of water rather than something solid. Draw a box where
the water is — the brush is the pool, its top face is the water line — and the game swims, floats and
sinks in it. Nothing new is authored: the planes, the corner and face tools, clipping, hollowing and
CSG work on it exactly as they do on any other brush, because it *is* one.

You make it water in one of three ways:

* **Draw water body** in the empty-space right-click menu, then drag the pool. The brush is created
  and turned into water in one step.
* Right-click a brush → **Brush type → Water body**.
* Select a brush and use **Brush type** at the top of the inspector.

Turning it back to **Solid** keeps the water's settings, so a mapper trying both gets the pool back
when they turn it wet again.

## What a water body is not

Not an obstacle. A water brush is left out of

* the collision mesh — you swim *into* it, not onto it;
* the trace volumes that bullets, sight and monster steps use — a monster can see into a pool and be
  shot across one;
* the surface test that places objects — an object dropped on a pool does not stand on the water.

That is the same treatment a `passable` brush gets, and it is what makes a pool a volume rather than a
lid.

## The settings

| Setting | What it does |
| --- | --- |
| **Colour** | The tint the surface is drawn with; the water shader starts from it |
| **Opacity** | How much of the level shows through the surface |
| **Buoyancy** | 1 holds a swimmer at the depth they stopped at, above 1 they rise, below 1 they sink. An object floats where the water it displaces matches its weight, so 1.2 leaves a crate riding with a fifth of itself dry |
| **Swim speed** | Units per second a stroke climbs at |
| **Sink speed** | The fastest the water lets a swimmer drop |
| **Water drag** | How quickly vertical speed reaches what the swimmer asked for — low is syrupy |
| **Speed in water** | Share of the walking speed that survives, at the deepest |
| **Current X/Y/Z** | A current the volume carries, in units per second along the map's axes; objects and swimmers are pushed along it |

**Presets** — Swimming pool, Lake, Sea, Sludge, Lava — write those numbers into the brush. A preset is
a starting point, not a link: a level keeps the numbers it was authored with even if a later build
tunes the preset.

## Swimming

Doom's `waterlevel` decides what the body does, and it is the number the engine reports:

| Level | Feet | What happens |
| --- | --- | --- |
| 0 | dry | walking, as always |
| 1 | water over the ankles | slower; the body keeps its own weight, so a jump still jumps |
| 2 | water past the middle | buoyant: the swim model takes over and the surface settles at the chest |
| 3 | head under | the swimmer goes where they look |

Under the surface the view points the way: forward with the nose down dives, forward with the nose up
rises. The jump key is a stroke upwards at any depth, which is how you leave a pool. Doing nothing
leaves the buoyancy to decide — neutral holds the depth, thin water lets you down, a life jacket
brings you up.

Objects float by the same record: the water pushes up with the weight of what the object displaces,
scaled by the share of it that is under the surface, and drags on it in proportion to its speed. A
crate dropped in a lake bobs to the water line and stays there; one dropped in sludge sinks.

## The surface is geometry, not a picture

The top of a water body is a **grid of vertices that rides the swells**. So the waterline against a
shore moves, the silhouette of the surface moves, and what is behind the water *shifts as the swells
pass* — the shader refracts the level through the wave normal, which is what makes a pool bottom look
like a pool bottom instead of a picture of one.

Four swells make the surface, at four wavelengths: **96 and 52 map units** carry the mesh, **27 and
14** only tilt the shading, because a ripple 14 units long cannot be carried by a 16-unit grid — it
would alias into a pattern that is neither a wave nor a ripple. That split is why the surface still
looks alive at the distance a player stands at: the short waves are most of what catches the light.

They travel by **deep-water dispersion**, `ω = √(g·k)`, so a long swell moves faster than a ripple,
as real water does — 122 units/s for the 96-unit swell, 47 for the 14-unit one. Every swell crosses
a wavelength in under a second. Doing it any other way (one rate for all of them, or a fixed
slow drift) is what makes water look like a moving picture.

The swells are written twice on purpose: the mesh is built in JavaScript
(`shared/water-surface.js`) and the normals are shaded in GLSL (`shared/shaders.js`). The numbers
are pinned to agree by `test/water.test.js` — change one and the test names the other. Only a **top**
face moves: the sides and the underside of the same volume stay flat, and they are a separate batch
for exactly that reason.

The editor animates its water on the window's own clock — it does not step the level — and the game
animates it on the game clock, through the same `animateWaterSurface`.

## Water and shaders

Every brush can run a **shader**, water or not: **Shader** in the inspector or in the brush's
right-click menu, one per brush, and a face can run one of its own instead. A shader is a GLSL effect
in the Shadertoy shape — `mainImage`, `iTime`, `iResolution` and the surface's own `uv` — the same
language the [shader engine](shader-engine.md) uses for panels, walls and the level-wide effect. On a
brush it *is* the look of the surface: the effect writes the colour it wants, so a texture under it is
only the frame for the effect.

A water body is given the engine's **Water (Shadertoy)** shader the moment it becomes water, so it is
never a flat blue slab. The effect ships with the engine and is stored in the project, so it can be
edited, replaced or removed like any other shader in the **Environment** tab. Its uniforms are the
dials — and `waveHeight` and `waveSpeed` also move the **mesh**, because the geometry reads them
from the compiled shader rather than from a second set of numbers:

| Uniform | Default | What it does |
| --- | --- | --- |
| `waveHeight` | 5 | Peak height of the biggest swell, in map units — the mesh rides this |
| `waveSpeed` | 1 | How fast the swells travel |
| `ripple` | 0.6 | Fine chop, shading only: the sparkle between the swells |
| `refraction` | 0.5 | How far the swells bend what is behind the surface |
| `foam` | 0 | White water on the crests — raise it for a sea, leave it alone for a pool |
| `sun` | 1 | How bright the sky the surface reflects is |

The shader paints water and nothing else: swells with exact slopes, fine chop, the colour the water
takes out of what it looks through, the sky it reflects, the sun it catches, and foam where it
breaks. There is no land, shoreline or backdrop in it, because the level is what is behind the
surface — the brush is drawn where the mapper put it, over whatever is under it. It is written the
way a Shadertoy effect is, so a shader from the web pastes into the same shape.

### Bringing a shader in from the web

Shadertoy effects are their authors' work, so **the engine ships none of them**. What it does have is
a way to take yours: **Environment → Import a shadertoy.py download (.json)** reads the file that
`shadertoy.py download <url> <file.json>` writes, joins its passes and stores the source in *your*
project. A plain `.txt` of the source is accepted too. Once imported it is an ordinary shader: assign
it to the world, to an object, or to any brush — including a water body.

Nothing about that changes the licence of what you imported: check the shader page before you ship a
level that uses one.

## Files

`shared/water.js` holds the record, the volumes, the `waterlevel` thresholds, the swim model and the
presets. `shared/brushes.js` owns the `kind` and the fact that a water brush is not solid.
`shared/physics.js` swims, floats and drags. `shared/water-surface.js` builds and animates the
surface. `shared/shaders.js` ships the water shader. The play view (`public/render.js`) and the
editor's 3D view (`public/scene-editor.js`) build the surface through the same `brushSurface`, so a
pool cannot be blue here and grey there. Tests: `test/water.test.js`; end to end:
`npm run automation:water`.
