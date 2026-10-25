# Photocraft integration plan

Status: proposal. Photocraft is a separate project and is not part of this
repository. This plan describes how OpenDLE would treat it as the default image
editor for textures, sprites, flats and HUD artwork. Nothing here is implemented
in the current tree.

## What OpenDLE supports today

| Fact | Source |
| --- | --- |
| Image assets must be embedded PNG data URIs matching `^data:image/png;base64,` | `shared/project.js`, asset validation |
| Asset kinds: `texture`, `flat`, `sky`, `sprite`, `weapon`, `model`, `font`, `sound` | `shared/project.js` |
| Image `width`/`height` must be integers, 1..2048 | `shared/project.js` |
| Per-image limit: `asset.src.length <= 6 MiB`; cumulative `<= 48 MiB` | `shared/project.js` |
| At most 3,000 assets | `shared/project.js` |
| Sprite origin: optional `offsetX`/`offsetY` numbers; directional sprites carry exactly eight `{assetId, flip}` views | `shared/project.js`, `public/render.js` |
| Import UI accepts PNG/JPEG/WebP, rejects above 2048 px, re-encodes to PNG via canvas, seeds sprite offsets to bottom-centre | `public/app.js`, `image-file` handler |
| HUD import creates a `sprite` asset plus an image element | `public/hud-editor.js`, `importImage()` |
| Every project mutation goes through `edit(fn, message)` -> `commit`, which validates, pushes one undo snapshot and re-renders | `public/app.js` |
| Save is `PUT /api/project` with optimistic `revision`; the store writes a `.tmp` file with mode `0600` and renames it over `data/project.json` | `server/index.js`, `server/store.js` |
| Editor CSP: `default-src 'self'`, `connect-src 'self' data: blob:`, `frame-ancestors 'none'` | `server/index.js` |
| Editor HTTP rejects non-localhost `Host` and cross-site origins | `server/index.js` |

Budget note: the 6 MiB / 48 MiB limits apply to the base64 data URI string, not
raw bytes, so a raw PNG is realistically capped near 4.5 MiB. The 48 MiB counter
(`assetBytes`) is shared by images, fonts and models, not images alone.

Asset references that a returned PNG can affect:

| Owner | Field |
| --- | --- |
| Sector | `floorAsset`, `ceilingAsset` |
| Wall | `assetId`, and `right`/`left` `upper`, `middle`, `lower` |
| Object | `spriteAsset` |
| Environment | `skyAsset`, `weaponAsset`, `weaponAssets[id]`, `skybox.px..nz` |
| HUD | element `assetId`, `fillAssetId`, bitmap/web font atlas `assetId` |
| Sprite clips | `frames[]` |
| Material animation | `materialAnimations[].assetId` |
| Game levels | `game.levels[].assetIds` |

There is currently **no** "edit existing image" action: every image import
creates a new asset id. Photocraft integration therefore needs a replace path;
that is new work, not an existing feature.

## Integration contract

Open asset, edit, return PNG.

| Rule | Detail |
| --- | --- |
| Identity | Returned asset carries the same `id` and `name`. |
| Format | `data:image/png;base64,...` only. No other mime type, no URL, no empty payload. |
| Dimensions | Integers 1..2048. Default expectation is unchanged `width`/`height`; a resize is allowed only with the fixups below. |
| Size | Data URI under 6 MiB and within the remaining 48 MiB budget. |
| Metadata | `kind`, `offsetX`, `offsetY`, `rotations`, `animations` are owned by OpenDLE and preserved unless the caller explicitly rescales them. |
| Apply | One `edit(next => ...)` call, so the change is validated and undoable as a single step. |
| Concurrency | Capture `editVersion` before opening the editor; refuse to apply if it changed (same pattern the importer uses). |

Resize fixups (proposal, required if dimensions change):

- `offsetX`/`offsetY` scale by `newWidth / oldWidth` and `newHeight / oldHeight`.
- HUD `slice` (nine-patch) borders must still leave a centre region, or the
  apply must be rejected with an explicit message.
- HUD `sprite` grids (`columns`, `rows`) only say how many cells the image is cut
  into, so a resize silently changes each cell's pixel size; the caller must
  re-check or refuse.
- Sprite clip frames and material animations keep working because they reference
  ids, not pixels.

Undo caveat: `commit` keeps 10 snapshots for asset-bearing projects, 3 for game
projects and 40 otherwise. Repeated artwork edits inside a full-game project use
up the small game history quickly; the UI should say so once.

## API surface between the apps

Proposal, `postMessage` only, both sides check `event.origin` and ignore
unexpected shapes. Version 1.

OpenDLE to Photocraft:

| Message | Payload |
| --- | --- |
| `opendle:hello` | `{ v: 1, app: 'opendle', origin }` |
| `opendle:open-asset` | `{ v: 1, requestId, asset: { id, name, kind, width, height, offsetX, offsetY, png }, hints: { pixelated: true } }` |
| `opendle:cancel-request` | `{ v: 1, requestId }` |
| `opendle:goodbye` | `{ v: 1 }` |

Photocraft to OpenDLE:

| Message | Payload |
| --- | --- |
| `photocraft:ready` | `{ v: 1, app: 'photocraft', capabilities: ['open-png', 'export-png', 'resize'] }` |
| `photocraft:save` | `{ v: 1, requestId, asset: { id, width, height, png } }` |
| `photocraft:cancel` | `{ v: 1, requestId }` |
| `photocraft:error` | `{ v: 1, requestId, message }` |

`requestId` is echoed, single-use, and expires. `png` is the full data URI so
OpenDLE does not need a second encoding path. Photocraft may keep its own native
format internally; only PNG crosses the boundary.

## Embedding

Three options, in order of effort:

1. **Popup window (works with the current CSP).** `window.open` a Photocraft URL
   the user configures, then `postMessage` to that window handle with the exact
   target origin. No CSP change. Downside: a separate window, no shared chrome.
2. **Iframe (needs a CSP change).** OpenDLE sets no `frame-src`, so
   `default-src 'self'` blocks a cross-origin iframe. Allowing Photocraft on
   another local port means adding something like
   `frame-src 'self' http://127.0.0.1:PORT` to the CSP in `server/index.js`.
   Sandboxed frames with `sandbox="allow-scripts allow-same-origin"` are
   preferred over full trust.
3. **Reverse direction (not recommended).** Photocraft embedding OpenDLE is
   blocked by `frame-ancestors 'none'`, and would invert ownership of the project
   state.

Because `connect-src` is `'self'`, OpenDLE's page cannot `fetch` a Photocraft
endpoint directly, and Photocraft cannot call `/api` cross-origin (Origin check
plus bearer token). `postMessage` is the only transport that works today without
weakening the server's cross-origin rules.

## Offline and desktop mode

- OpenDLE has no desktop binary; "desktop" means the browser opened by
  `./launch.sh`. Photocraft runs beside it, either served locally or opened from
  disk.
- When Photocraft is unreachable, the flow must degrade to file round-trip: open
  the PNG from the asset tile (data URI download), edit, then re-import through
  the existing image importer. This path already exists except for replacing an
  existing asset id.
- If Photocraft is opened from `file://`, `postMessage` origins are `"null"`; the
  bridge must then refuse to run rather than accept origin `*`.

## Failure and permission handling

| Failure | Handling |
| --- | --- |
| Photocraft never sends `ready` | Time out (proposal: 10 s), keep the asset unchanged, show a status message |
| Popup blocked | Status message with the URL to open manually; no silent failure |
| `save` with a different `id` | Reject, keep request open |
| Non-PNG, truncated, or malformed data URI | Reject via the project validator's message; nothing is applied |
| Dimensions above 2048 or non-integer | Reject with the actual values |
| 6 MiB per-image or 48 MiB budget exceeded | Reject; suggest a smaller canvas or re-encoding |
| Project edited while Photocraft was open | Refuse to apply, re-open with the current asset |
| `PUT /api/project` fails (409 revision conflict, disk error, read-only file) | Existing behaviour: error is surfaced, edits stay in memory; the user can export JSON |
| Browser draft backup fails (storage full) | Existing behaviour: reported, project stays dirty in memory |

Never partially apply: validate the returned asset against `validateProject` on a
clone before committing.

## Testing

| Test | Type |
| --- | --- |
| Message schema accept/reject table, including oversize and wrong id | `node --test`, new `test/photocraft-link.test.js` |
| Data URI regex + dimension + budget checks against sampled payloads | Unit, reuse validator |
| PNG dimension read of returned bytes | Unit, `pngjs` is already a dependency (`server/import.js`) |
| Apply-through-`edit` produces one undo step and a valid project | Unit |
| Stale `editVersion` is refused | Unit |
| Popup/iframe handshake | Manual checklist per browser; automation only if a headless harness is added |
| File round-trip fallback | Manual |

## Phases

| Phase | Scope |
| --- | --- |
| P0 | Replace-image action in the assets panel plus "Open in Photocraft" that only performs a file round-trip; no messaging |
| P1 | Window bridge: `opendle:*` / `photocraft:*` messages over a popup, validated, single undo step, same-dimension saves only |
| P2 | Embedded iframe (CSP `frame-src` change), resize support with offset/slice/grid fixups, per-asset status in the panel |
| P3 | Photocraft as the default for tiles, sprite frames, flats and HUD artwork, including batch open; preference stored per project or locally |

## Non-goals

- Writing Photocraft project files, layers or history into OpenDLE projects.
- Editing fonts, sounds, models or GLB textures through Photocraft.
- Non-PNG outputs (JPG/WebP) at the project boundary, or keeping both formats.
- Letting Photocraft mutate `data/project.json` directly; OpenDLE stays the only writer.
- Bundling or vendoring Photocraft, or assuming its internal UI from this repo.
