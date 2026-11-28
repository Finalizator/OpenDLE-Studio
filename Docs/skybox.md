# Skybox

The **Skybox** tab designs the sky a level draws, and the engine draws exactly what the tab shows:
one record — `project.environment.skybox` — is read by the 3D view, by the running game and by the
tab's own preview.

Before this tab, a level's sky was a Doom picture stretched over a 60-degree dome. Above the dome the
picture had no more rows, so the last row was repeated: that is the vertical streaking above the
horizon. A skybox now says **which angular window, in degrees, the picture covers**, and what to do
outside it.

## Opening it

The tab is in the editor's tab strip (`Skybox`). It edits the layout that is open; every layout
carries its own sky.

* **Start from this level's sky** — an imported Doom level already has a sky picture. This adopts it
  exactly as the level drew it: `projection: doom` keeps GZDoom's own dome mapping (`skyDomeV` — the
  dome is pushed 1250 units down and squashed by `texh / 230`, so the picture's rows are compressed
  towards the zenith and its bottom rows fall below the horizon), and the picture is tiled round the
  level the way `SetupMatrices` tiles it (1024 pixels per turn, so a 256-wide `SKY1` wraps four
  times). Two renders of the same picture — the legacy path and the adopted record — come out
  pixel-for-pixel identical, so adopting changes nothing on screen.
* **Start blank** — an empty sky: a full-sphere window with no picture, drawn as a gradient or as a
  flat colour until you choose a panorama.
* **Import sky picture** — in the empty state and above the layer list. It opens a file picker with
  every sky format the editor reads (`SKY_IMAGE_ACCEPT`) and puts the picture on the layer being
  edited; a sky with nothing in it becomes a plain panorama (sphere, equirect, the whole turn
  round) while a sky that already has a record keeps its shape and window.
* **Presets** — sky designs are saved with the project (`project.skyPresets`) and a rule can switch
  to one by name.

## The parts of a sky

| Group | What it decides |
| --- | --- |
| Shape and projection | `sphere`, `dome` (stops at 60 degrees like Doom), `cylinder`, `box` (cubemap), `solid`, `procedural`; projection `equirect`, `doom`, `cube`, `cylinder`, `flat` |
| Presets | Save the sky as it is now, apply one, delete one |
| Where the sky is drawn | The coverage window: azimuth from/to and elevation from/to in degrees, the edge mode, the feather, the colour drawn outside |
| Placement and colour | Rotation, pitch, zoom, exposure, tint |
| Animation | Speed and playing/stopped, plus per-layer clips |
| Layers | Up to six pictures stacked with their own blend, opacity, tiling, offset, rotation, drift, window and animation |

### The window

The window is fixed in the **level**, not in the picture. (A `doom`-projected picture takes its
vertical position from the dome instead; the window then only says how far round the level it is
drawn.) Everything outside it is *not drawn*, so
the level's own background shows through — that is the area that used to be streaked.

* **Edge** says what happens at the boundary: `fade` (nothing outside), `clamp` (repeat the edge row),
  `stretch` (fit the picture to the window), `wrap`, `mirror`, `none`.
* **Feather** softens the boundary over some degrees, so a backdrop can blend into the level.
* **Outside colour** is what the tab's preview paints outside the window. The game leaves it
  transparent so the level's background colour shows.

### Rotation is a pan, not a turn of the window

Turning the sky slides the **picture inside its window** and wraps it round. The window stays where it
was placed: a backdrop covering the west keeps covering the west when you turn the picture inside it,
and a full panorama behaves as it always did because its window is the whole turn.

## The two views

The tab shows the sky two ways, from one record.

**3D view** (the one that opens) is a real renderer: the same fragment program the game runs, built
by `public/sky-material.js`, over a grid on the level's floor and the four cardinal marks. Drag to
look around (the sky and the ground follow the pointer together — one azimuth drives both), wheel to
zoom, double-click to reset. This answers "what will the player see", and the line under it reports
the same window numbers as the coverage map.

**Coverage map** is the whole sky as a plate — azimuth across, elevation up — painted with the same
maths the shader uses (`skyTexel` in `shared/skybox.js`). Each cell is filled with the texel the game
samples there:

* **grey** — outside the window, i.e. not drawn;
* the picture's own colours — a stretched picture shows as stretched texels, not as streaks;
* the gradient — a procedural sky is painted from the same curve the shader uses
  (`proceduralSkyColour`).

A camera view cannot show a 360 by 180 degree window at once, which is the one question the plate
answers; the plate cannot show what the level will look like, which is the one the 3D view answers.

## Layers

Each layer is one picture with its own blend (`replace`, `alpha`, `add`, `multiply`, `screen`,
`overlay`), opacity, tiling (`repeatU`/`repeatV`), offset, rotation, drift in degrees per second,
optionally its own window, and an optional animation clip whose frames are pictures with their own
durations.

A six-face cubemap is a layer with `faces` instead of `assetId`. A `.dds` cubemap decodes straight to
a cube; six separate face pictures are gathered into one cube when the sky is built.

## Animation

`animation.playing` and `animation.speed` drive one clock (`state.skyClock`), which also drives the
per-layer drift, so a paused sky is completely still. Each layer's clip is sampled from that clock;
`setSkyFrame` moves the clock to the frame's start.

## Formats

A sky may be any of these, imported in the Assets tab with **Import as: Sky**:

| Format | Read how |
| --- | --- |
| PNG, JPEG | decoded by the browser |
| TGA | `TGALoader` |
| DDS | `shared/dds.js` — BC1/BC2/BC3 and raw RGBA, including cubemaps |
| HDR, RGBE | `RGBELoader` — values above white are what make a sun bright |
| EXR | `EXRLoader` |
| TIFF | `TIFFLoader` |

A sky is stored byte-for-byte in the format it arrived in: re-encoding an HDR through a canvas would
clip exactly the values that make it an HDR. A float panorama is big — an 8K OpenEXR nebula is 47 MB
— so skies have a budget of their own: 64 MiB per picture and 320 MiB per project, with the 8192-pixel
dimension ceiling that every sky keeps.

Two things are repaired when a float picture is decoded, because decoders and the tools that write
them disagree about what an empty sample is:

* non-finite samples (NaN, ±Inf) become zero. One NaN is undefined behaviour on the GPU and can paint
  a whole surface a colour that has nothing to do with the picture;
* negative samples become zero, since a sky has no meaning below black.

Half-float pictures keep their samples as raw 16-bit words, so the check decodes them rather than
comparing the words as numbers. The import reports what was found — `EXR 7680x3840` — so a picture
that still looks wrong says what it is instead of only looking wrong.

## Rules

Five conditions and seventeen actions, all under **Sky:** in the event sheet.

Conditions: `skyboxPreset`, `skyboxShape`, `skyboxAnimating`, `skyboxFrame`, `skyboxSpeed`.

Actions: `setSkyPreset`, `setSkyShape`, `setSkyTexture`, `setSkyLayerTexture`, `setSkyLayerVisible`,
`setSkyCoverage`, `setSkyRotation`, `setSkyTint`, `setSkyExposure`, `startSkyAnimation`,
`stopSkyAnimation`, `toggleSkyAnimation`, `setSkySpeed`, `setSkyFrame`, `setSkyLayerOffset`,
`setSkyLayerSpin`, `setSkyLayerOpacity`.

```text
On start
  Sky: apply a saved preset      preset = night
  Sky: start the sky animation
  Sky: set the animation speed   value = 4
```

A sky the rules changed travels in the save file: the record and its clock are part of the game state,
and `skyError` (why the last sky action did nothing) is a session diagnostic that is not saved.

## Files

| File | What lives there |
| --- | --- |
| `shared/skybox.js` | The record, the window and texel maths, presets, runtime helpers, the procedural gradient |
| `shared/sky-preview.js` | The plate and camera previews, as numbers |
| `shared/dds.js` | The DDS decoder |
| `public/sky-textures.js` | Format detection and decoding for the renderer |
| `public/skybox-panel.js` | The tab: the form, the two views, the readout |
| `public/skybox-viewport.js` | The tab's 3D view: a renderer, the horizon grid, look and zoom |
| `public/sky-material.js` | The fragment program the record becomes — used by the engine **and** the tab |
| `public/render.js` | The engine's use of it: the mesh, the rebuild signature, `ChangeSky` |
| `test/skybox*.test.js` | The maths, the rules, the tab |

The legacy Doom/panorama shader is still there and still used by a level that has no skybox record, so
an imported map keeps the sky it was drawn with until someone opens this tab. Once adopted, the record
reproduces that picture — the same rows on the same 60-degree dome, the same horizontal tiling — so
"Start from this level's sky" changes nothing on screen until a control is touched.
