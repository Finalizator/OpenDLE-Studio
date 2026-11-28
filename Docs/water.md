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

## Adjusting the look

The window has a **Close** button: it is deliberately not modal, so it has no title bar and Escape
would not dismiss it on its own.

**Water look…** — right-click the water body (in either the 2D or the 3D view), or use the button in
the inspector's **Brush type** block — opens a small window
with a slider per dial: `waveHeight`, `waveSpeed`, `ripple`, `chop`, `density`, `refraction`,
`fresnel`, `foam`, `sun`. It is
**not modal** — the viewport stays live behind it, so a slider can be dragged while watching the
water answer. A drag writes straight into the compiled shader's uniforms, which is why the surface
follows the pointer without recompiling; letting go stores the number in the project as one undo
step. `waveHeight` and `waveSpeed` move the mesh as well, so the surface itself rises and falls as
you drag them.

## Top surface only

A water body draws **one face**, not six. Its sides and underside are inside the floor around it,
and each face is a full water shader with a screen sample behind it, so **Draw the top surface only**
(the water's inspector block) is on by default. Turn it off for water meant to be seen from the side
— an aquarium, a flooded room, a waterfall — and every face is drawn again.

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

Seven swells make the surface, in two tiers the way the reference water shader below builds its
waves: **110, 78, 58 and 44 map units** set the scale of the sea and lift the whole surface, and
**34, 28 and 25** chop the crests. Every one of them moves geometry, and no single one carries more
than a fifth of the height.

What matters as much as the number is the **spread of their directions**: 3°, 29°, 63°, 84°, 119°,
141° and 168°. Seven *names* over three *directions* is two crossing trains, and two crossing trains
interfere into ridges that all run the same way — the surface then looks combed and, as one report
put it, "moves only in one direction". Uneven gaps around the compass make short, broken crests.

They travel by **deep-water dispersion**, `ω = √(g·k)`, so a long swell moves faster than a ripple,
as real water does — 128 units/s for the 110-unit swell, 60 for the 25-unit one. Every swell crosses
a wavelength in under a second. Doing it any other way (one rate for all of them, or a fixed slow
drift) is what makes water look like a moving picture.

The wave field is written **once**, in JavaScript (`shared/water-surface.js`): the mesh is moved, and
the shader is *told* the surface normal rather than a second copy of the wavelengths to shade. One
field, one source of truth, and the shading cannot drift from the shape.

That normal is the **slope of the field**, not an average of the moved triangles. A wave three cells
long drawn on a grid is a row of flat plates, and a normal averaged from the plates lights each one
as a facet — the surface reads as tiles rather than as water. The field knows its own derivative
exactly, so the normal is computed from it per vertex, which costs nothing extra beyond the sine the
height already needed and leaves the grid free to be as coarse as it likes. The grid also shares the
vertices two triangles of a fan have in common, so nothing creases along a fan edge. Only a **top**
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

A water body is given the engine's **StupidWater** shader the moment it becomes water, so it is never
a flat blue slab. The effect ships with the engine and is stored in the project, so it can be
edited, replaced or removed like any other shader in the **Environment** tab. Its uniforms are the
dials — and `waveHeight` and `waveSpeed` also move the **mesh**, because the geometry reads them
from the compiled shader rather than from a second set of numbers:

| Uniform | Default | What it does |
| --- | --- | --- |
| `waveHeight` | 5 | Peak height of the biggest swell, in map units — the mesh rides this |
| `waveSpeed` | 1 | How fast the swells travel |
| `ripple` | 0.6 | How hard the fine chop tilts the surface: the sparkle between the swells |
| `chop` | 1 | Sharpness of that chop — the reference shader's *choppiness*. 1 is a rubber sheet, 2 a sharp-crested sea |
| `density` | 0.6 | How much of the water's own colour sits over what is behind it; lower is clearer. At 1 the bottom is hidden, at 0.3 it is a window |
| `refraction` | 0.22 | How far the surface bends what is behind it — small on purpose, a strong bend stretches every straight edge in the level into a long bright line |
| `fresnel` | 3 | Exponent of the reflection curve: low reflects a wide band of the sky, high only the rim |
| `foam` | 0 | White water on the crests — raise it for a sea, leave it alone for a pool |
| `sun` | 1 | How bright the sky and sun the surface reflects are |

The shading is modelled on the Godot ocean shader in `Ancestors/GodotWater` by **TSS ENTERTAIN**,
who publishes it for any use provided the author is credited: a stack of scrolling ripple layers
blended at falling weights, choppiness on their tilt, exponential absorption of the water column, a
power-curve fresnel and crest foam. It is written from scratch against this engine's inputs rather
than translated, because the two have different ones — Godot samples a depth texture and a reflection
probe, we are handed the real camera, the real surface normal and the screen behind the surface. Two
of Godot's terms have no equivalent here and are approximated: the depth of the water behind a pixel
is derived from the view angle (a column seen at an angle is longer by 1/cos), and the sky it
reflects is a gradient rather than the level's skybox.

The shader paints water and nothing else: swells with exact slopes, fine chop, the colour the water
takes out of what it looks through, the sky it reflects, the sun it catches, and foam where it
breaks. There is no land, shoreline or backdrop in it, because the level is what is behind the
surface — the brush is drawn where the mapper put it, over whatever is under it. It is written the
way a Shadertoy effect is, so a shader from the web pastes into the same shape.

### The three water looks

A water body runs one of three looks that ship with the engine. **Look** in the inspector's water
block switches between them; each is an ordinary shader in the project, so the one you pick can be
opened in the **Environment** tab, dialled, replaced with your own, or removed.

| Look | What it is for | Dials |
| --- | --- | --- |
| **StupidWater** | The default: a wind sea with visible swell, glitter and foam | `waveHeight`, `waveSpeed`, `ripple`, `chop`, `density`, `refraction`, `fresnel`, `foam`, `sun` |
| **StillWaterPool** | A calm indoor pool: still, glassy, the bottom legible | `waveHeight`, `waveSpeed`, `ripple`, `refraction`, `absorption`, `depth`, `sun` |
| **OceanClearwater** | A clear shallow sea: light crossing water, turquoise shadows, sharp glints | `waveHeight`, `waveSpeed`, `ripple`, `chop`, `refraction`, `depth`, `sun` |

The first is the engine's own. **StillWaterPool** follows Evan Wallace's webgl-water (BSD-3-Clause),
via Martin Renou's three.js port in `Ancestors/StillWaterPool`: reflections never drop below a
quarter and the Fresnel curve is a cube, so the water turns silver much sooner than a sea does.
**OceanClearwater** follows the Clearwater demo by **Lumaris** (MIT) in `Ancestors/OceanClearwater`:
its index of refraction, its Beer-Lambert absorption that eats red first, and the light it scatters
back out of the column. Both are written against this engine's inputs rather than translated — those
demos ray-march a room or a pebble floor, and a surface effect here is handed the level behind it and
the real surface normal instead. Their optics are kept; their geometry is not.

`depth` is *how much water the view crosses*, not a map measurement: absorption coefficients are per
metre and a map unit is an inch, so one unit there is roughly a metre of clear sea.

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
