# Shaders are folders

Every shader the engine ships is a folder under `shaders/`. The editor reads that folder and lists
what it finds, so adding a shader is adding a directory — no list to update, no build step.

```
shaders/
  water/                  one shader, one folder
    shader.json           what it is called, what kind it is, its dials
    main.glsl             the code
  plastic-curtain/
    shader.json
    main.glsl
  on_screen/              full-screen shaders — drawn over the frame, never on a surface
    vignette/
      shader.json
      main.glsl
```

## `shader.json`

```json
{
  "name": "StupidWater",
  "kind": "surface",
  "description": "What it does, in a sentence.",
  "author": "OpenDLE",
  "license": "project",
  "entry": "main.glsl",
  "builtin": "water",
  "revision": 6,
  "uniforms": { "waveHeight": 5, "waveSpeed": 1 }
}
```

| Key | Required | What it does |
| --- | --- | --- |
| `name` | yes | What the editor shows. 1–60 characters. |
| `kind` | no, but checked | `surface` or `screen`. The folder decides; a manifest that disagrees is refused rather than guessed at. |
| `description` | no | One sentence, shown as a tooltip in the library lists. |
| `author`, `license` | no | Carried onto the project copy, so credit travels with the shader. |
| `entry` | no | Source file inside the folder. Defaults to `main.glsl`. |
| `builtin` | no | Marks an effect a part of the engine owns (`water`, `curtain`): its code and dials are refreshed from the folder, keeping the mapper's dial values. |
| `revision` | no | Which build of a built-in this is. Bump it and every project picks the new code up on open. |
| `uniforms` | no | The dials, as scalar defaults. These become the project copy's uniforms and the sliders in **Water look…** / **Adjust the look…**. |

The folder name is the shader's identity — it is what a project records as the origin of its copy —
so renaming a folder is a different shader, while changing `name` is only a new label.

## Where they show up

- **Surface shaders** are listed on a brush: **Brush shader** in the inspector, alongside the
  project's own effects. Choosing one copies it into the project and points the brush at the copy.
- **Full-screen shaders** (`shaders/on_screen/`) are listed in the **Shaders** tab. They are drawn
  over the finished frame — vignettes, grades, overlays — and are never offered for a brush, because
  a surface shader shades itself and a screen shader reads the whole picture.
- A folder that fails to load is reported in the status line with its path and the reason, instead of
  quietly disappearing from the list.

## Copies, not links

Applying a library shader copies it into the project. A level keeps the look it was built with even
after the folder changes, and a mapper can edit the copy — its name, its source, its dials — without
editing the engine's library. `builtin` effects are the exception: their source is refreshed from the
folder when `revision` moves, because a shading fix has to reach levels made before it, while the
mapper's dial values are kept.

## Starters

A folder can be a **template** rather than a look: `"starter": true` in its manifest. The library
keeps it, the editor never offers it on a brush or over the frame, and it is what **Add GLSL effect**
and **Add Shadertoy effect** begin a new effect with. The engine ships two:

| Folder | What a new effect starts as |
| --- | --- |
| `shaders/_starter-effect/` | A `vec4 effect(color, uv, time)` tint with one `strength` uniform |
| `shaders/_starter-shadertoy/` | A `mainImage` in the Shadertoy shape, reading `iChannel0` |

Marking a folder as a starter is how "this is a template, not a shader to apply" is expressed in
data, so a `_starter-…` folder needs no special case in the scanner — only the list filters, which
skip it.

## Adding one

1. Make the folder: `shaders/<name>/` for a surface shader, `shaders/on_screen/<name>/` for a
   full-screen one.
2. Write `main.glsl` with a `mainImage(out vec4 fragColor, in vec2 fragCoord)` entry point. The
   inputs are in [water.md](./water.md#water-and-shaders) and the shader engine's own docs: `iTime`,
   `iResolution`, `iChannel0` (what is behind the surface), `uv`, and — on a surface — where the
   pixel is, which way the surface faces and where the camera stands.
3. Write `shader.json` with at least a `name`.
4. Reload the studio. The shader is in the list.

A malformed folder never breaks start-up: it is listed as a problem, the rest of the library loads,
and the editor carries on.
