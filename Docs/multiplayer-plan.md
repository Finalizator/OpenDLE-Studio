# Multiplayer plan

Status: proposal. No networking code exists in OpenDLE today; this document
describes how to add multiplayer authoring without breaking the single-player
design. Everything marked **proposal** is unverified design, not shipped
behaviour.

## What exists today

| Area | Fact | Source |
| --- | --- | --- |
| Simulation | `stepRuntime(project, state, dt, keys, pressed)` clamps `dt` to 0..0.05 s and advances one player | `shared/runtime.js` |
| Tick base | Physics runs on `FIXED_STEP = 1 / 60` with an accumulator | `shared/physics.js` |
| Randomness | Seeded LCG in `state.randomSeed` drives hitscan spread, damage dice and `random()` expressions | `shared/runtime.js` (`fireHitscan`), `shared/combat.js` (`randomDamage`), `shared/expressions.js` |
| Scripts | Event sheets run in three phases: `beforePhysics`, `afterPhysics`, `interface` (`runRules`) | `shared/runtime.js` |
| Player | Exactly one `state.player`; no per-player entity ownership | `shared/runtime.js` (`createRuntime`) |
| Serialization | Tagged `encode`/`decode` handles Map/Set; `captureGameSave`/`restoreGameSave` checksum a snapshot and skip `physics`, `rendererStatus` | `shared/save-game.js` |
| Physics snapshot | `physics.saveState()`, `physics.restoreState()`, `validatePhysicsState` | `shared/physics.js` |
| Server | Express 5, binds `127.0.0.1` only, rejects non-localhost `Host`, bearer token on `/api` and `/mcp`, CSP `connect-src 'self'` | `server/index.js` |
| Networking libs | None. No `ws`, no WebRTC, no socket route | `package.json`, `server/` |

The save-game encoder is the closest existing thing to a network snapshot and
should be reused rather than duplicated.

## 1. Deterministic tick and input commands

**Proposal.** The server owns a tick counter at exactly 60 Hz and calls
`stepRuntime(project, state, 1 / 60, keys, pressed)` once per tick. Clients
never advance authoritative state; they send commands and render accepted
snapshots.

Input command, one per client per tick, JSON, bounded:

```json
{ "tick": 41200, "seq": 9912, "moveX": 0.5, "moveY": 1, "turn": -0.02,
  "look": 0.0, "buttons": ["Jump"], "fire": false, "use": false }
```

Rules:

- `tick` must be within a small window of the server tick; older commands are
  dropped, future ones buffered up to N ticks.
- `moveX`/`moveY` are -1..1 floats; `buttons` is a subset of an allowlist built
  from `INPUT_KEYS` in `shared/engine-script.js`; unknown fields reject the
  command.
- Command conversion to the existing `keys` Set keeps `stepRuntime` unchanged:
  `moveY > 0` maps to `KeyW`, `fire` to `Mouse0` (the Set already carries mouse
  buttons today), and so on.
- Randomness is seeded per room and per round from a server-generated seed, so a
  recorded command stream plus seed replays identically.

Determinism scope: the **server** is the only authority, so cross-platform
floating-point differences in Rapier never have to be bit-identical between
machines. Clients predict locally and reconcile; replay tests run on one machine.

## 2. Authority, ownership, interpolation

- **Proposal:** add `state.players` as a Map keyed by player id, each with
  `{id, entityId, player: {...}, playerStats, inventory, commands}`. The existing
  `state.player` becomes a getter for the local player so current scripts keep
  working; `shared/runtime.js` is edited in one place.
- Server-authoritative fields: player transform, health, ammo, entity health and
  positions, sector motion, level/round state.
- Client-authoritative: nothing. Menus and HUD remain local.
- Entity ownership: new optional `ownerId` on entities (**proposal**), assigned
  when the server spawns them. `resolveEntityId` and the existing
  `target: true` commands keep working; new conditions can filter by owner.
- Client rendering: local player predicted from local commands; remote players
  and entities interpolated 100-150 ms behind the newest snapshot. Snapshot
  contains id, position, angle, sprite state, health class, not full runtime.
- Reconnect: a late joiner receives a full snapshot built from the same
  `encode()` tagged format used by `shared/save-game.js`.

## 3. Creating a server without code

All authoring stays inside the existing visual systems.

| Artifact | How the user makes it | Reuses |
| --- | --- | --- |
| Multiplayer template | Button "Install multiplayer template" runs an installer modelled on `installEngineScripts` (`shared/engine-script.js`) | Event sheets, groups |
| Host / join | New actions `hostRoom`, `joinRoom`, `leaveRoom` with bounded text/number fields | `ENGINE_ACTIONS` in `shared/engine-script.js` |
| Spawn rules | New action `spawnPlayerAt` plus existing `spawnEntity` (`templateId`, `x`, `y`, `z`, `angle`, `name`) | `spawnEntity` |
| Score / round rules | Ordinary rules over `project.variables` and timers (`startTimer`, `setVariable`, `setHUDText`) | `variables`, `timers` |
| Lobby screens | Native editable HUD screens: add screen names to `project.gameMenus.screens`, mark elements `interactive: true`, wire `hudClicked` rules | `shared/game-menu.js`, `shared/hud.js`, HUD editor |
| Player list / scoreboard | HUD text elements with a new binding such as `net:players` and `net:score` (**proposal**) | `hud.js` binding table |

New conditions (**proposal**): `isHost`, `isClient`, `playerCount`, `playerJoined`,
`playerLeft`, `roomStateCompare`, `netScoreCompare`.
New actions (**proposal**): `hostRoom`, `joinRoom`, `leaveRoom`, `setRoomRule`
(for example `fragLimit`, `roundTime`), `endRound`, `resetRound`,
`setPlayerScore`, `spawnPlayerAt`, `setPlayerName`.

Every command needs: a definition in `ENGINE_ACTIONS`/`ENGINE_CONDITIONS`, field
bounds, an executor branch in `runRules`, and validation in `shared/project.js`
so editor, MCP tools and imported JSON share one rule set.

## 4. Transport

Phase order (**all proposals**):

1. **WebSocket**, same origin, `GET /multiplayer` upgrade handled in a new
   `server/net-server.js`, mounted from `server/index.js`. Adds one dependency
   (`ws`) or a hand-written RFC 6455 framing layer; WebSocket is chosen because
   the browser already talks HTTP to the local service and the CSP already allows
   `connect-src 'self'`.
2. **WebRTC data channels, optional.** Use the WebSocket as signaling only
   (offer/answer/candidates), unreliable-unordered channels for snapshots,
   reliable-ordered for commands. Adds complexity (ICE, TURN, NAT) and no benefit
   on localhost, so it ships after P2.
3. **LAN play** requires changing the current hard restriction in
   `server/index.js` (Host regex `localhost|127.0.0.1`, bind address). Proposal:
   an explicit opt-in flag plus a per-room token, never on by default.

## 5. Files

| File | Change | Kind |
| --- | --- | --- |
| `shared/net-protocol.js` | Message schemas, opcodes, version, encode/decode of commands and snapshots, validation helpers | New |
| `server/net-server.js` | Room lifecycle, tick loop, command queue, snapshot fan-out, rate limits | New |
| `shared/runtime.js` | Multi-player state, per-player step, command application, snapshot build/apply | Edit |
| `shared/engine-script.js` | New conditions/actions and their field bounds | Edit |
| `shared/project.js` | Validation for the new commands and `ownerId` | Edit |
| `shared/hud.js` | Net bindings for lobby/scoreboard text | Edit |
| `public/net-client.js` | Connect, send commands, receive snapshots, reconcile | New |
| `public/app.js` | Host/join dialog, status display, template install button | Edit |
| `test/net-*.test.js` | Protocol, replay and two-client tests | New |

## 6. Security

- **No arbitrary code path.** Clients send only the fixed command vocabulary;
  nothing is `eval`-ed. Existing shader source is already a parsed subset, and
  MCP/DeepSeek edits stay server-side.
- Validate every field: type, range, allowlists, string lengths, array lengths,
  message size (proposal: 256 bytes per command, 64 KiB per snapshot).
- Rate limit per connection: 1 command per tick per player, drop excess, close
  abusive sessions. Bound rooms per server (proposal: 4) and players per room
  (proposal: 8).
- Room tokens: server-generated 128-bit token required on join; reconnecting
  clients present the token, not a user name.
- Keep the existing token and Origin checks for HTTP; the WebSocket upgrade must
  verify Origin and the bearer token the same way `/api` does.
- Never trust client-reported position, health, score or hit messages.

## 7. Testing

| Test | Purpose |
| --- | --- |
| Deterministic replay | Feed the same seed + command stream twice, assert `captureGameSave` checksum equality |
| Snapshot round-trip | `encode`/`decode` + `validatePhysicsState` on a mid-game state |
| Two-client simulation | In-process server, two fake sockets, assert both see the same authoritative position |
| Protocol fuzz | Malformed/oversized/unknown-field messages are rejected, not thrown |
| Latency/jitter | Fake clock, assert interpolation buffer bounds and no rubber-banding past a threshold |
| Editor validation | New commands appear in editor, MCP tool output and import validation identically |

Run targeted files only (`node --test test/net-*.test.js`); do not add network
dependencies to unrelated suites.

## 8. Phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| P0 | Authoritative movement + spawn: tick loop, command stream, snapshots, `state.players`, `spawnPlayerAt`, two players see each other move | Two clients join a room, move, and agree on position within tolerance for 60 s |
| P1 | Rounds and scores: `endRound`, `resetRound`, `setPlayerScore`, net HUD bindings, lobby screens as editable HUD/menu screens | A deathmatch round ends by frag limit and restarts without reloading |
| P2 | Matchmaking and lobbies: room discovery on the local service, ready-up, map/episode vote via HUD buttons, optional WebRTC channels | Host picks a level in the lobby; all clients load it |

## 9. Non-goals

- Internet matchmaking, accounts, ranking, hosting outside the local service.
- Rollback netcode, client-side authority, peer-to-peer without a host.
- Voice/text chat, anti-cheat beyond authority and validation.
- Guaranteed cross-platform simulation parity; only server authority is promised.
- Compatibility with GZDoom netcode or Doom multiplayer semantics.
- Multiplayer in the editor viewport itself; Play is the only networked mode.
