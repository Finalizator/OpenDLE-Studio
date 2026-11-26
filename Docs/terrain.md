# Terrain

The **Terrain** tab generates a whole landscape — noise or hand-painted source, chunked meshes,
skirts, optional water — and exports it into the level as ordinary model geometry. It is powered by
[`procedural-terrains`](https://github.com/ZyFou/ProceduralTerrains) (MIT), a Three.js runtime
built from Terrain Studio 2.0.

## What is installed

| Piece | Version | Where |
| --- | --- | --- |
| `procedural-terrains` | 2.1.0 | `node_modules/procedural-terrains` → served at `/vendor/terrain/` |
| `three` (peer, `~0.185.1`) | 0.185.1 | `node_modules/three` → `/vendor/three/` |
| `fflate` (its only dependency) | 0.8.x | `/vendor/fflate/` |

The runtime is a viewer, not the studio: it ships `createTerrain`, `createTerrainViewer`, an
exporter (`GLB`/`OBJ`), document loading and the generation helpers. It does not ship the studio's
editor chrome, vegetation painting or the account/back-end pieces.

### How the modules reach the page

The studio has no bundler. `public/index.html` carries an import map that names **every** entry
point explicitly — `procedural-terrains/viewer`, `/export`, `/generation` and the rest. A prefix
mapping cannot be used: import maps do not add extensions, so `procedural-terrains/viewer` would
resolve to `/vendor/terrain/viewer` and 404. `test/terrain-tab.test.js` checks that each named
entry point is a real file.

The terrain tree also gets its own **specifier scope**, so its `three` is the classic
`three.module.js` build: the runtime constructs a `WebGLRenderer`, and the WebGPU build the rest of
the editor import-maps (`three.webgpu.js`) does not export one at all.

## The layer editor

The recipe's shape is a **noise stack**: an ordered list of layers, each one blended into what the
layers above it produced (`replace` starts again from flat). The panel is the studio's
`NoiseLayersPanel` rebuilt in this editor's own DOM — no React, and no copy of its engine:

- **Preset** applies one of the studio's six recipes (Classic, Rolling Hills, Sharp Mountains, Canyon
  Terraces, Desert Dunes, Moon Craters) as a starting point; every layer stays editable afterwards.
- **Add layer** appends a layer of the chosen type. The type list, each type's description and every
  parameter field (label, range, step, default) come from the runtime's own `NOISE_TYPES` schema, so
  a type the package adds appears without touching this repository.
- Each card has enable, name, type, up/down and remove, plus blend mode and strength. Changing the
  type replaces the layer's parameters with the new type's defaults and keeps its place and name.
- Any edit regenerates the world after a short pause, so the panel is an editor rather than a form.

With a stack present, the **Noise octaves** and **Noise scale** fields stand down (they are the
classic single-layer recipe and the stack ignores them); they come back with **Reset**.

The stack is stored in `project.terrain.stack` and validated with the project, so a world authored
here reopens for the next person exactly as it was.

## Surface packs

The five classic packs — grass, rock, sand, mud, alien — are copied from the studio into
`public/textures/terrain/`, together with a `materials.json` trimmed to those five (about 430 KB;
the studio's full PBR library is 1.1 GB and is deliberately *not* vendored). The runtime reads the
manifest at `/textures/terrain/materials.json`, so adding a pack later means copying its folder and
adding its manifest row.

## Using the tab

1. Open **Terrain** in the tab strip. The viewer starts on the recipe the project stores, or on the
   defaults (`seed 1337`, 8 × 8 chunks of 128, height 560) when it has none.
2. Set the recipe: seed, chunks, chunk size, height scale, noise octaves, noise scale and mesh
   resolution. **Generate** rebuilds the world; **Reset** restores the defaults.
3. **Export to level** meshes it and places the result.

The recipe is saved **with the project** (`project.terrain`), not in the browser: reopening the tab
rebuilds the same world, and another author opening the project sees the same one. The mesh is
never stored twice — the export becomes an ordinary model asset, exactly like a GLB dragged into
the Assets browser.

### What the export produces

`exportTerrain` returns a map of file name to bytes (mesh, heightmap, collision, splat, preset).
The tab takes the mesh — `*.glb` preferred, `*.obj` accepted — and runs it through the project's own
model import (`bundleModel`), so the terrain lands as:

- one **asset** of kind `model`, with the usual metadata and a generated thumbnail;
- one **object** of type `decoration` carrying that model, placed at the player's position.

The object is an ordinary object: move it, scale it, put a collider on it, attach a visual script.

### Ranges the runtime enforces

The runtime validates its own configuration and refuses values by name rather than clamping them.
The tab and `validateProject` use the same ranges, so a project cannot store a recipe its viewer
will not open:

| Setting | Range |
| --- | --- |
| `seed` | −2 147 483 648 … 2 147 483 647 |
| `chunkCount` | 1 … 64 |
| `chunkSize` | 8 … 4096 |
| `heightScale` | 0 … 100 000 |
| `octaves` | 1 … 16 |
| `scale` (noise) | 0.01 … 1000 |
| `seaLevel` | −100 000 … 100 000 |

## Notes and limits

- The viewer needs **WebGL2**. Without it the tab says so instead of showing an empty box; the rest
  of the editor is unaffected.
- The runtime's shaders use their own sun and ambient terms, so the terrain is lit differently from
  the level's sectors. The exported mesh keeps vertex colours and baked lighting options you choose
  in `exportTerrain`.
- Terrain geometry is a mesh, not brushes. A mirrored, gameplay-critical room is still built from
  brushes; a landscape backdrop, a skybox island or a distant range is what this is for.
- An export is capped by the model import path at 16 MiB per asset. Lower **Mesh resolution** if
  the export exceeds it.
- `project.terrain` stores the recipe only. Deleting the object does not delete the recipe, and
  deleting the recipe does not remove an exported asset.

## Regenerating or upgrading

```sh
npm install procedural-terrains@latest three@~0.185.1
```

Then check the import map in `public/index.html` still names every entry point in the package's
`exports` (the test will tell you if a new one appeared), and run `npm test`.
