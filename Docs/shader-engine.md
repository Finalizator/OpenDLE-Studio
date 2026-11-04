# Shader engine

The Shader Engine is a stack of full-screen effect passes ported from
[3D Game Shaders For Beginners](https://github.com/lettier/3d-game-shaders-for-beginners)
(Lettier). Open the **Shaders** tab, start from a preset or add techniques one at a
time, and tune each one with its own sliders. The stack is project data, so a look
travels with the game, undoes like any other edit, and can be driven by events while
the game runs.

## How it works

The level is drawn into a render target that keeps its depth. The stack then runs over
that picture in order — each pass reads what the one before it produced — and the result
is drawn to the screen. When the stack is empty the level goes straight to the screen and
nothing changes, which is the default for a new project.

A forward renderer has no position or normal buffer, so the screen-space passes rebuild
both from the depth buffer: the same information the book's position and normal textures
carry, reconstructed per fragment. The chain works in display space (a target holds linear
light) and converts back on the way out, which is why posterisation and gamma behave the
way the book describes.

Depth-dependent passes need a camera with a depth range; they use the same near/far and
field of view as the level camera, so a pass stays correct when the resolution or the
field of view changes.

## The techniques

| Technique | Chapter | What it does |
| --- | --- | --- |
| Blinn-Phong shading | blinn phong | Re-lights the frame from the depth buffer with diffuse plus a half-vector highlight |
| Normal mapping | normal mapping | Adds procedural surface detail to that lighting |
| Gamma correction | gamma correction | Raises the frame to 1/gamma (2.2 by default) |
| Box blur | blur | Mean of a square window; separation spreads it without more samples |
| Bloom | bloom | Bright fragments are isolated, blurred and added back |
| Outlining | outlining | Draws an edge where the depth jumps, thicker with distance |
| Dilation | dilation | Grows the brightest colour in the window, feeding glow and outline |
| Cel shading | cel shading | Flat bands of shading plus an inked silhouette; the bands come from a blurred copy, so artwork inside a band keeps its detail |
| Posterization | posterization | Rounds every channel to a number of levels |
| Pixelization | pixelization | One sample per block, for chunky pixels |
| Sharpen | sharpen | Unsharp mask against a blurred copy |
| Chromatic aberration | chromatic aberration | Splits the channels radially, strongest at the edges |
| Lookup table | lookup table | Grades every colour through a real 16×16×16 table (neutral, warm, cool, sepia, drained) |
| Fog | fog | Blends to a fog colour with distance |
| Depth of field | depth of field | A circle of confusion from the focus distance decides the blur |
| Motion blur | motion blur | Keeps part of the previous frame as a trail |
| Screen-space ambient occlusion | ssao | Darkens where nearby geometry crowds the fragment |
| Screen-space reflection | screen space reflection | Marches the reflected ray through the depth buffer |
| Screen-space refraction | screen space refraction | Bends the frame behind a surface, with dispersion |
| Fresnel factor | fresnel factor | Brightens surfaces seen edge-on |
| Rim lighting | rim lighting | A back light that only catches silhouettes |
| Flow mapping | flow mapping | Scrolls two noise layers and warps the frame with them |
| Foam | foam | Paints foam where water meets geometry |
| Film grain | film grain | Per-fragment noise, animated |

The book's chapters on **deferred rendering**, **render-to-texture** and **reference
frames** describe how to build the pipeline rather than a pass of their own. That
pipeline is what this engine already does: the level renders into a texture, and the
screen-space passes reconstruct view-space positions from its depth.

Cel shading, rim lighting and foam measure a *relative* depth jump — how much the depth
changes compared with its own distance — so their thresholds mean the same thing in a
cramped corridor and on a long sightline. An absolute jump in world units fires on every
grazing floor, which inks the whole frame.

## Presets

Presets are ordinary stacks and remain editable afterwards:

- **Toon** — cel shading with an inked silhouette and a little bloom
- **Cinematic** — warm lookup table, distance fog, bloom, a little grain
- **Retro shooter** — pixelisation, posterisation, dilation
- **Underwater** — refraction, flow, blue-green fog, foam
- **Dream** — heavy bloom, chromatic aberration, depth of field
- **Noir** — sepia table, sharpen, grain
- **Silent Hill** — drained colour, fog that closes in a few hundred units away, shallow
  focus, a little glow and chromatic aberration, heavy grain

## Events

Visual scripts can drive the stack while the game runs:

| Command | Effect |
| --- | --- |
| *Shaders: enable / disable the effect stack* (`setPostFxStack`) | Turns the whole chain on or off |
| *Shaders: enable / disable one effect pass* (`setPostFxPass`) | Switches a single technique on or off |
| *Shaders: set an effect parameter* (`setPostFxParam`) | Writes one parameter, with an expression such as `=sin(time) * 0.4 + 0.6` |
| *Shaders: effect pass is enabled* (`postFxPassEnabled`) | True while a technique is running |
| *Shaders: compare an effect parameter* (`postFxParamCompare`) | Compares a parameter's current value |

A parameter change is a uniform update, not a shader rebuild, so a slider or a scripted value
never recompiles the chain. The one exception is the lookup-table grade: it is baked into a
texture, so switching grades rebuilds the pass.

Runtime values start from the project's saved stack and reset when the level restarts;
the project's own parameters are never overwritten by a running game. The commands are
validated when the project is saved and when it is exported, so a misspelled technique or
parameter is an error rather than a rule that silently does nothing.

## Order

Passes run top to bottom in one shader, so the ones that read *colour* from neighbouring
fragments — blur, bloom, sharpen, cel, dilation, depth of field, SSR, refraction, flow,
pixelization, chromatic aberration — sample the frame **as it entered the chain**, not what
the pass above them produced. A colour or tone pass placed above one of those is therefore
partly or wholly undone: put the sampling first and the grading last. Silent Hill is built
that way on purpose — focus, aberration and glow, then the drained grade, fog and grain.

The panel says so when a stack breaks that rule, and moving the offending card up clears it.
Passes that only read *depth* around a fragment (outline, SSAO, foam, rim) are unaffected:
they work on the colour they are handed.

## Cost

Every enabled pass costs samples, and the depth-dependent passes sample the depth buffer
several times per fragment. A stack of two or three passes is cheap; a stack of ten heavy
ones (SSAO, SSR, depth of field, bloom together) at a high render resolution is not. Start
with the preset you want and remove what you do not need.
