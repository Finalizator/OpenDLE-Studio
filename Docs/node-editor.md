# Node editor, terminals and doors

This guide covers reusable scene objects, their visual scripts, and a projected
keypad that opens a specific level door. For command parameters and execution
rules, see the [visual scripting reference](visual-scripting.md).

## Open or create a scene

1. Choose **+ Scene Object** in the Project bar to create an empty scene.
   Existing scenes also appear under **Menu > Layouts > Scene Object**.
2. Select the scene's tab. The **Scene** tree is on the left, the **2D/3D**
   viewport in the middle, and the inspector on the right.
3. Use **+** above the tree to open the searchable node catalog. Select a parent
   first to add a child under it.
4. Select a node to edit its transform, artwork, components and script.
5. Use **Place in layout** to place a copy of the scene into the current map.

A scene is a reusable group, not a live-linked prefab: editing its source does
not update copies already placed in the layout. Each placed copy has its own
local variables and remapped object references.
Nested visual-script branches are copied as complete trees: each sub-event points
to its copied parent, never to a rule on the original instance. Duplicating or
nesting a scene that would exceed the event limit is refused before adding nodes,
rather than placing an unscripted or partly scripted copy.

### Placed scenes are one layout object

Click any visible part of a placed scene in **2D** or **3D** to select the entire
instance. The Project tree and object list show one scene entry, not independently
movable child parts. Moving, rotating, scaling, duplicating, copying, exporting or
deleting the instance applies to the whole assembly. Numeric transform fields in
the layout inspector also move the whole instance; Form does not edit its children.

Edit individual parts in the source scene's tab (**Open source scene**). Source
edits do not automatically update already placed copies: place the revised scene
again to replace one. For a directly imported node without a source scene, use
**Capture as editable scene** to create a reusable definition of the assembly.
Only the explicit context-menu action **Ungroup into editable layout objects**
breaks the layout instance into separately editable objects.

Older node imports with saved parent links, and older placements whose instance
IDs still match a saved scene, are grouped automatically when opened. Save the
project to retain the recovered grouping. Unrelated loose objects are not guessed
into scenes.

### Node types

| Preset | Purpose |
| --- | --- |
| Node3D / marker | Organize nodes or mark a position; not visible during play. |
| Sprite3D plane / billboard sprite | An oriented picture surface or a camera-facing sprite. |
| Box, sphere, cylinder, cone, capsule, plane | Editable primitive geometry with color, opacity and optional texture. |
| AudioStreamPlayer3D | Positional sound with volume, radius, autoplay and looping. |
| VideoProjector3D | An image/video display plane, not a projector light or depth-projected decal. |
| InteractiveScreen3D / Code lock | A mouse-operated interface drawn directly on a 3D surface. |
| PointLight3D | Light with color, intensity and radius. |
| Area3D / physics bodies | Interaction volumes and fixed/dynamic bodies. |
| Enemy, pickup, ramp, panel | Gameplay objects and other editable geometry. |

These are OpenDLE presets, not Godot classes or a full Godot node/API implementation.
An enemy can receive artwork through the inspector's **Sprite** or **Model** picker.
Adding a mesh alone does not give it a rigid body; configure **Physics** separately.

### Viewport controls

Click or focus the viewport before using shortcuts.

| Tool | Shortcut | Behavior |
| --- | --- | --- |
| Select | Q | Select without starting a transform. |
| Move | W | Translate a node and its descendants. |
| Rotate | E | Rotate the selected branch. |
| Scale | R | Resize geometry and carry child positions. |
| Shape | T | Resize a supported face, keeping its opposite face pinned. |

- In **3D**, use axis handles, rotation rings and face arrows. **2D** transforms
  operate on the floor plane; use Elevation or the vertical 3D handle for height.
- **Snap** uses 32-unit positions/faces. Hold Ctrl to bypass snapping, or hold
  **Alt during a 3D Move drag** for precise, grid-free placement (also in the
  layout's 3D view). Releasing Alt restores the selected grid.
- Rotation rings have light **45-degree detents**: within 3 degrees of a
  multiple of 45, the rotation snaps to it; other angles remain free. Hold Ctrl
  to bypass the detents. Hold Shift during Shape to resize symmetrically.
- **Escape** cancels a transform preview. Releasing a completed drag creates one
  undo step.
- In **Fly**, hold the right mouse button to look/move: WASD moves, Q/E lowers
  or raises the camera, Shift speeds it up, and the wheel changes speed.
  Camera controls take precedence over tool shortcuts while flying.
- In **Orbit**, left-drag circles the scene origin, right-drag dollies, and the
  wheel zooms.
- Drag a node onto the middle of a tree row to reparent it; use a row's top/bottom
  edge to reorder it. Node coordinates remain absolute within the scene.

Tilt is supported by oriented geometry, models and spatial groups. Doom
billboards, panels and interaction areas remain yaw-only. Scaling is not affine
shear: differently oriented children do not become skewed meshes.

## Import and save reusable nodes

The supplied [access-terminal.node](../public/examples/access-terminal.node) is
stored at `public/examples/access-terminal.node`, relative to the repository root.
With Studio running, you can also download it from
<http://127.0.0.1:3000/examples/access-terminal.node>.

To use it:

1. Open a scene and choose **Import .node**, then select the file.
   Alternatively, drag the file into a scene viewport or directly into a layout.
2. In the scene editor, select **Access terminal** to edit the whole branch, or
   **Terminal chassis** to edit that part. In the layout, either part selects the
   complete terminal instance.
3. Move/rotate the terminal into position and use **Place in layout** if you
   imported into a reusable scene rather than directly into the map.
4. Press the main **Save** button to persist your project.

To export your own node, select its branch and choose **Save .node**. Selecting
the scene root exports the whole scene wrapped in one group. In the export dialog,
choose whether to **Include its visual script**.

**Save .node downloads a file through your browser.** Its destination follows your
browser's download settings; it does not overwrite the supplied example or save
the current project. **Save** persists the project; **Export project** creates a
portable project archive.

Node files embed referenced artwork, models, sound/video, shaders and portable
scripts. Internal object references are remapped on import. References to external
objects or level resources, including door sectors, cannot travel; affected rules
are omitted and reported. Review export warnings. Bind a portable terminal to
doors in the receiving layout instead.

## Projected terminal setup

The example includes a keypad and chassis:

| Setting | Example value |
| --- | --- |
| Access code (digits) | `1234` |
| Digits local variable | `digits` (Text, initially empty) |
| Submit signal | `submitted` |
| Legacy global output (optional) | Empty; no global variable is written |
| Interaction range | 160 map units |

In the terminal inspector:

- **Screen mode** chooses a code lock or computer/tablet presentation.
- **Terminal width/height** changes its physical size; **Screen resolution**
  changes the texture resolution, not the physical size.
- **Access code (digits)** determines the screen's own access-granted display.
- **Digits local variable** names a declared Text local variable.
- **Submit signal** names the signal emitted when Enter/Run is pressed.
- **Screen controls** adds buttons shown after the correct code; each has a
  label and a number, text or boolean value.

Each digit or Clear updates this terminal instance's `digits` variable. Text
preserves leading zeros: `0123` is not the number `123`. Enter emits `submitted`
with the entered text for **both correct and incorrect** attempts. After unlocking,
custom buttons emit their configured values through the same signal.

After a correct code, the keypad is replaced by the unlocked display/buttons.
Closing a door does not automatically relock its terminal. The unlocked display
resets when the surface is recreated; there is no separate terminal-relock action.

The internal access code is not an automatic door permission check. Your visual
rule decides whether the door opens. If you change the screen's PIN, update the
rule's comparison too.

### Operate it during play

1. Press **Play level** and approach the terminal within its interaction range.
2. Aim at its visible screen. The crosshair becomes a pointer **on that surface**;
   no terminal popup or HUD overlay is created. Mouse capture and look remain active.
3. Aim at a digit and click, then aim at **Enter** (or **Run**) and click.
4. Look away or walk out of range to return to the ordinary crosshair.

Movement, jumping, use keys and mouse look remain active. Weapon fire is blocked
while targeting a reachable screen, including held fire and alternate fire.
**Player > Interacting with screen** (`interactingWithScreen`) is true for that
duration, allowing additional visual-script behavior. It is a continuous condition,
not a one-shot signal. Walls block interaction; pausing, leaving play or removing
the node clears it. The gameplay crosshair also works in imported games without a
crosshair in their HUD, and hides over a reachable screen so it cannot cover its controls.
The keypad is mouse-operated, not keyboard digit entry. If the screen looks
mirrored, you are viewing its back: rotate the terminal to face the player.

## Configure a level door

Imported doors and elevators are recognized automatically from native line specials
and sector-motion events. **Do not author them again.** Select the moving sector,
or a bordering wall and its **Front** or **Back** sector in Properties. Both views
show the same controls and the source linedef/event.

**Door / sector ID** controls a ceiling door. **Elevator / moving floor / sector ID**
controls a lift or floor barrier. Some barriers, including MAP07's lowering walls,
open by lowering the floor; they are not ceiling doors. The surrounding room is
not the moving sector.

| Inspector control | Choices / behavior |
| --- | --- |
| Initial door state | **Imported geometry** (with its detected state), **Closed** or **Open**. |
| Activation | **Imported triggers / locks**, **Player proximity**, **Manual use (E)** or **Events only**. |
| Activation distance (map units) | Proximity/manual reach; defaults to 64. |
| Open / closed ceiling height | Absolute endpoints; open must exceed closed. |
| Door speed (units / second) | Movement speed; defaults to 70. |

- **Player proximity** opens while the player is within range of the sector
  outline and closes when they leave. This can override a one-off event action.
- **Manual use (E)** toggles the nearest configured manual door in range.
- **Events only** does not open through proximity or manual use. Use this for
  a code lock.
- **Imported triggers / locks** preserves the original activation, keys,
  repeatability, waits and return cycles. Merely selecting a door changes nothing.

An explicit initial state applies at runtime; it need not match the static
geometry in the editor. **Restore imported behavior** removes your overrides
without deleting the original mechanism. For a genuinely new, ordinary sector,
use **Movement > Create ceiling door** or **Create elevator**.

By default, the closed height is the sector floor. Imported motion destinations
provide the open height; otherwise it is the lowest adjacent ceiling minus 4.
With no adjacent sectors, a new door uses the larger of the authored ceiling and
floor plus 56 units. Speed follows the imported action, or defaults to 70 map units/second.
The opening still needs enough headroom and connected, passable geometry.

The same `openHeight`, `closedHeight` and `speed` overrides are available through
the MCP `sector_update` tool.
Custom activation modes take ownership of the moving plane, blocking imported
linedef/ACS activation from bypassing that mode. With no override, or with
**Imported** activation, native behavior remains active.

### Elevators and moving floors

Elevators expose **Initial elevator state** (Imported geometry, Lowered, Raised),
**Lower floor height**, **Upper floor height**, activation, distance and speed.
**Move ceiling with floor** preserves cabin headroom; native `Elevator_*` specials
enable this automatically, while platforms and lowering barriers move only the floor.
Proximity mode raises the platform while nearby and lowers it when the player leaves;
manual mode toggles it. Event-only mode waits for elevator actions.

Use **Elevator > Raise / Lower / Toggle** and **Is raised / Is lowered / Is moving**
in events, including terminal signal listeners. Existing imported movers are
already available in their target pickers. MCP `sector_update` accepts the same
`elevator` settings; `elevator: null` restores native behavior.

Recognition cannot infer an arbitrary opaque ACS program's intent. Such custom
mechanisms still need explicit sector movement configuration or their original scripts.

## Connect the terminal to one specific door

Keep the terminal-to-sector connection in the **layout's** event sheet, not inside
the portable node.

1. Configure the target door as **Events only**, initially **Closed**.
2. Add an event whose first condition is **Signals > On signal**.
   Select the placed terminal instance and its `submitted` signal.
3. Add **Object > compare local variable** as an AND condition:
   choose that same terminal, variable `digits`, operator `=`, value type **string**,
   value `1234`.
4. Add **Door > open** and choose the target sector.
5. Leave **Once** off if the rule should handle more than one matching emission.
6. Save, then test a wrong PIN and the correct PIN.

Expected result: a wrong submission leaves the door closed; `1234` opens only
the selected door. Another terminal instance does not trigger this connection.

Additional AND conditions can require a key, a global variable or another door's
state. **Door > close** and **Door > toggle** target a configured sector too.
**Door > is open**, **is closed** and **is moving** report runtime state;
open/closed mean movement has finished at that endpoint.

For multiple submissions queued before one tick, use **Signals > compare emitted
value** to check each submission's captured text. The local `digits` variable is
the terminal's latest value; it is not a historical snapshot of every submission.

## Create your own signals and local scripts

Select a reusable node. In **Script**, edit **Signals (comma-separated)** and
**Local variables**. Local variables have fixed Text/Number/Boolean types during
play. Referenced variables and signals must remain valid.

Choose **Events** to edit that scene node's own visual script. This is separate
from the map's event sheet. Inside an owned rule, **This object** refers to that
instance; placed copies get their own context.

- **Signals > emit signal** sends a declared name and one primitive value.
- **Signals > On signal** receives it from the selected object.
- **Signals > compare emitted value** filters its payload without changing it.

Names start with a letter/underscore, followed by letters, digits or underscores,
up to 80 characters. An object can explicitly declare up to 32 unique signals;
a terminal's Submit signal is also available.

On signal must be the first, non-inverted condition of a top-level AND event.
Use additional AND conditions and ordinary sub-events for filtering. Delivery is
one-shot, FIFO within each sheet phase, not Godot-style synchronous callbacks.
Signals sent after a phase has finished wait until that phase's next tick.
Gameplay listeners pause with gameplay; interface listeners can run in menus.
Queues and dispatch are bounded to 256 emissions; a signal loop raises an error.

## Saving and troubleshooting

| Symptom | Check |
| --- | --- |
| Terminal does not respond | Play mode, interaction range, visible surface, walls in front, and the terminal root rather than its chassis. |
| Access granted, but door stays closed | A layout connection exists, its source is the placed terminal, the PIN comparison is Text, and the action targets a configured door sector. |
| Door opens without a correct PIN | Use **Events only**, add the AND comparison, and inspect other events that deliberately open or move the sector. |
| Rule fires only once | Turn off the event's **Once** option if repeated activation is intended. |
| Duplicate terminal affects the wrong door | Rebind the layout connection's signal source and local-variable target to the intended copy. |
| Saved node loses a door rule | Sector bindings are level-specific; keep them in the destination layout and review export warnings. |
| Video surface fails to play | Use local MP4/WebM files up to 64 MiB; container support does not guarantee codec support or autoplay permission in every browser. Check the reported media error. |
| Error during play | Read **Logs** and `logs/playtest/` before guessing; MCP exposes the same records with `playtest_log_list` / `playtest_log_read`. |

Project saving preserves authored initial values. In-game save slots preserve
runtime local digits and door motion/state, but not terminal focus, its unlocked
display or pending signal emissions. Reopening a saved game does not replay a
queued terminal submission. Older terminals without local/signal settings keep
their legacy global-variable output behavior.
