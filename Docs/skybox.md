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
  as a dome window (-20 to 60 degrees, clamped edges), which is the picture the level drew, now with
  the tab's controls on it.
* **Start blank** — an empty sky: a full-sphere window with no picture, drawn as a gradient or as a
  flat colour until you choose a panorama.
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

The window is fixed in the **level**, not in the picture. Everything outside it is *not drawn*, so
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

## The preview

The preview is the whole sky as a plate — azimuth across, elevation up — painted with the same maths
the shader uses (`skyTexel` in `shared/skybox.js`), so the two cannot disagree. Each cell is filled
with the texel the game samples there:

* **grey** — outside the window, i.e. not drawn;
* the picture's own colours — a stretched picture shows as stretched texels, not as streaks;
* the gradient — a procedural sky is painted from the same curve the shader uses
  (`proceduralSkyColour`).

The line under it reports the window, how much of the view is inside it, what is painting it, and how
many cells were painted.

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
clip exactly the values that make it an HDR.

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
| `public/skybox-panel.js` | The tab |
| `public/render.js` | `buildLayeredSky`, the shader the record becomes |
| `test/skybox*.test.js` | The maths, the rules, the tab |

The legacy Doom/panorama shader is still there and still used by a level that has no skybox record, so
an imported map keeps the sky it was drawn with until someone opens this tab.
