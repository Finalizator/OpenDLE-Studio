# Editing textures in PixiEditor

OpenDLE keeps every picture in a project — wall textures, flats, sprites, skies, weapon
overlays — as PNG data inside the project document. PixiEditor is a desktop paint program,
so the studio hands the artwork over as a file, starts the editor on it, and reads the
file back once it has been exported again. Nothing about the project format changes and no
extra copy of the game is written into `Projects/`.

## Opening a texture

Any picture asset can be opened from three places:

- **Asset browser:** press the pencil on a picture tile, or right-click a tile and choose
  **Open in PixiEditor**.
- **Inspectors:** every picture field (floor and ceiling materials, wall middle/upper/lower
  textures, ramp and sprite images, sky panorama, six-face skybox, weapon overlays, sprite
  animation frames) has a pencil button next to the asset list, and so do the HUD designer's
  *Image / atlas* and *Fill image* fields. The button edits whichever asset the field
  currently shows.
- **Artwork picker:** the ✎ button on a row of the *Assign sprite or model* picker opens that
  picture without choosing it.

The studio writes `<name>-<assets-digest>.png` into `data/pixieditor/<project>/` and starts
PixiEditor on that file. The digest comes from the asset id, so two flats that share a name
never share a file, and renaming an asset does not move the file an editor already has open.

## Bringing the edit back

PixiEditor opens the PNG as a new document. When you are happy with it, **File → Export**
the result as PNG over the same file (PixiEditor shows that path when it opens the image),
then choose **Reload from PixiEditor** in the asset browser's context menu.

The reload is an ordinary, undoable asset change: the new `src`, `width` and `height`
replace the old ones and the map, HUD and events that use the asset redraw immediately.
Nothing is written to disk until you save the project as usual.

If the project has been saved under a new name since the picture was opened, the studio
still finds the file: it looks in the current project's folder first, then in the other
folders under `data/pixieditor/`.

## Finding PixiEditor

The studio looks for the editor in the usual places:

| Platform | Looked for |
|---|---|
| Windows | `%LOCALAPPDATA%\Programs\PixiEditor`, `%ProgramFiles%\PixiEditor`, the Steam library, and `PixiEditor.exe` on `PATH` |
| macOS | `/Applications/PixiEditor.app` and `~/Applications/PixiEditor.app` |
| Linux | `pixieditor` on `PATH`, `/opt/PixiEditor`, a `PixiEditor*.AppImage` in `~/Applications` or `/opt`, and the Flatpak `net.pixieditor.PixiEditor` |

Set `OPENDLE_PIXIEDITOR` to an executable path to override all of it, which is what a
portable build or an unusual install needs:

```sh
OPENDLE_PIXIEDITOR=/opt/pixel-art/PixiEditor.AppImage npm start
```

When no editor is found the texture is still written out and the status bar says where it
went, so the artwork can be edited by hand and brought back with **Reload**.

## What can and cannot be opened

Only PNG artwork stored inside the project can be handed over; a sound, a music score, a
video, a font or a 3D model is offered no pencil button. Textures imported from a WAD are
already decoded into PNG data, so they are editable exactly like an image dropped into the
asset browser. The scratch folder is cleared by the operating system at your convenience
and never needs to be committed — it lives under the gitignored `data/` directory.
