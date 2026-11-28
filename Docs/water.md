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
dials:

| Uniform | Default | What it does |
| --- | --- | --- |
| `waveScale` | 3.2 | How much water the face's texture frame covers; bigger means more, smaller waves |
| `waveHeight` | 0.7 | How steep the swells are |
| `waveSpeed` | 1 | How fast they travel |
| `warp` | 1 | How much the swells wander, which is what stops three sines reading as a woven lattice |
| `foam` | 0 | White water on the crests — raise it for a sea, leave it alone for a pool |
| `sun` | 1 | How bright the sky the surface reflects is |

The shader paints water and nothing else: swells with exact slopes, fine chop, the sky it reflects,
the sun it catches, and foam where it breaks. There is no land, shoreline or backdrop in it, because
the level is what is behind the surface — the brush is drawn where the mapper put it, over whatever
is under it. It is written the way a Shadertoy effect is, so a shader from the web pastes into the
same shape.

## Files

`shared/water.js` holds the record, the volumes, the `waterlevel` thresholds, the swim model and the
presets. `shared/brushes.js` owns the `kind` and the fact that a water brush is not solid.
`shared/physics.js` swims, floats and drags. `shared/shaders.js` ships the water shader. The play
view (`public/render.js`) and the editor's 3D view (`public/scene-editor.js`) build the surface
through the same `brushSurface`, so a pool cannot be blue here and grey there. Tests:
`test/water.test.js`; end to end: `npm run automation:water`.
