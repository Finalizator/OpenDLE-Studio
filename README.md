# OpenDLE: Studio

**Build worlds. Script visually. Make them playable in your browser.**

OpenDLE: Studio is an experimental, source-available game engine and visual
editor combining Doom-style worlds, a Construct-inspired workspace and
GDevelop-style condition/action scripting.

## Create without starting from code

- **Visual world editing:** build and edit sectors, rooms, materials, lighting
  and objects in 2D and 3D.
- **Editable gameplay:** attach visual events to objects, use local variables
  and expressions, and customize imported gameplay.
- **Bring your worlds along:** import WAD and PK3 resources, classic Doom and
  UDMF maps, textures, sprites, weapons, sounds and supported game menus.
- **Design the interface:** edit HUDs and menus with responsive layouts,
  animations and gameplay bindings.
- **Browser-native rendering:** WebGPU preferred, WebGL2 fallback, Rapier
  physics and portable GLSL effects.
- **AI-ready tools:** MCP integration and optional DeepSeek-assisted edits,
  with drafts reviewed before applying.

## Try it locally

Requires **Node.js 22+** and **npm**.

```sh
git clone https://github.com/Finalizator/OpenDLE-Studio.git
cd OpenDLE-Studio
npm ci
npm start
```

Open **http://127.0.0.1:3000/** and review the first-launch license agreement.
On Linux/macOS, `./launch.sh` also handles dependency setup and browser launch.
Use **Play level** to test the current map or **Play game** to open its menus.
DeepSeek is optional; configure it using [.env.example](./.env.example).

## Where we're heading

Our goal is full, one-way GZDoom game import into native, editable OpenDLE
projects—with room to build beyond the original engine.

**This is an early engine, not complete GZDoom compatibility.** Imported weapons,
enemies, pickups, doors and lifts have working visual-script implementations,
but exact behavior and advanced features remain incomplete. Arbitrary
ACS/ZScript/DECORATE and full custom HUD/menu translation are not yet supported.
No commercial game data is included; supply content you have permission to use.

## Source available. Contributions welcome.

You can inspect the source, make private modifications and propose contributions.
Independent redistributed engine forks are restricted. Contributions require
explicit permission for use and relicensing before they are merged.

Under the [custom commercial license](./LICENSE), games below **US$10,000 in
lifetime qualifying receipts** owe no royalty or revenue reports. Reaching that
threshold triggers **US$200**, then **2% of receipts above it**, reported monthly.
Qualifying receipts deduct store/payment fees, sales taxes and refunds.
Zero-receipts games owe no royalties or license fees. Your game's source does
not have to be published. The full license controls; this is **not an
open-source license**.

For setup details, architecture, compatibility notes and contributor workflows,
see the [Development Guide](./DEVELOPMENT.md).
