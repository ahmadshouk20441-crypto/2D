# Ruins Together

A two-player co-operative puzzle-platformer that runs in any modern browser —
desktop, tablet or phone — with **no backend, no build step and no asset files**.
Two people in different places share a six-character room code and play together
over a direct peer-to-peer connection.

```
index.html    markup, room/join UI, HUD, touch overlay
style.css     responsive layout, menu, mobile controls
main.js       engine: game loop, physics, puzzle logic, netcode, renderer
tests/        headless verification harness (Node, no dependencies)
```

## Running it

Any static file server works; a secure context (`https://` or `localhost`) is
needed for the clipboard and WebRTC:

```bash
python3 -m http.server 8080      # then open http://localhost:8080
# or: npx serve .
```

To play, open the page in two browsers (or two devices): one clicks
**Create a room** and shares the code or the invite link, the other clicks
**Join a room**. A link of the form `…/index.html?room=ABC123` drops the second
player straight onto the join screen with the code filled in.

**Local co-op** on a single keyboard is also available from the menu, which is
the quickest way to try the puzzles.

## Controls

| | Move | Jump | Interact | Restart |
|---|---|---|---|---|
| Online (either scheme) | `A`/`D` or `←`/`→` | `Space` / `W` / `↑` | `E` | `R` |
| Local co-op — P1 | `A`/`D` | `W` | `E` | `R` |
| Local co-op — P2 | `←`/`→` | `↑` | `/` | `R` |
| Touch | on-screen D-pad | jump button | action button | HUD button |

Touch controls appear automatically on touch devices.

## The characters

Both are drawn programmatically with the Canvas 2D API — there are no images to
go missing.

- **P1 · Rami** — athletic build, dark hair and beard, green adventure tunic.
- **P2 · Layla** — agile, red hooded headscarf, tan-and-brown adventure outfit.

## Puzzle elements

| Element | Behaviour |
|---|---|
| **Pressure plate** | Open only while a player's weight holds it down. |
| **Wall lever** | Latching toggle; drives gates, energy barriers and platforms. |
| **Gate** | Retracts into its housing; solid while it is coming down. |
| **Energy barrier** | Blocks passage until its source is switched on. |
| **Moving platform** | `toggle` (travels to one end and waits) or `shuttle` (paces while powered). Carries riders. |
| **Spikes** | Instant respawn at the stage's spawn point. |
| **Exit portal** | Requires **both** players standing inside for ~half a second. |

## Architecture

**Physics.** A fixed 120 Hz step, integrated separately per axis with swept AABB
resolution against the tile grid and a short list of dynamic rectangles. Jumps
use coyote time (100 ms), input buffering (120 ms) and a variable-height cut, so
a tap clears one tile and a held jump clears two.

**Networking.** PeerJS DataChannels, host-authoritative for the *world*:

- Each peer simulates **its own character** and streams position/velocity at
  20 Hz, so local input latency is always zero. The remote character is eased
  toward incoming snapshots and hard-snapped on large jumps (respawn, stage
  change).
- The **host** owns levers, plates, platform phase and stage progression, and
  broadcasts them at 20 Hz. A guest applies lever pulls optimistically and sends
  an intent; the next snapshot is the authority.
- Co-op has no adversarial incentive, which is what makes trusting each peer
  with its own avatar the right trade here.

**Rendering.** A single 960×540 logical canvas letterboxed to the viewport and
backed at device pixel ratio. The camera tracks the midpoint of both players and
zooms to keep them both framed, clamped to the level bounds; off-screen partners
get an edge arrow.

**Audio.** Every sound is synthesised at runtime through WebAudio — no files.

## Adding a level

Append an entry to `LEVELS` in `main.js`. The map is an array of equal-length
strings (`#` solid, `=` one-way platform, `^` spikes, `.` empty); entity
coordinates are in tiles. A blocker is open while **any** id in `openWhen` is
active; a mover runs while any id in `activeWhen` is active (an empty list means
always). Then run the validator below — it checks map geometry, spawn headroom,
dangling source ids, unreachable props and mover clearances.

## Tests

The harness runs the real `main.js` under Node against a small DOM/Canvas stub,
so it exercises the shipping code rather than a copy.

```bash
node tests/run-all.js
```

- `validate-levels.js` — map geometry, spawns, entity wiring, exit placement.
- `playthrough.js` — a bot that may only walk, jump and press `E` completes all
  four stages, exercising the renderer as it goes.
- `netcode.js` — two fully independent game instances in separate VM contexts,
  wired through a latency-simulating fake DataChannel, verifying that plates,
  levers, stage advances and platform phase stay in sync and that drift stays
  bounded.
- `smoke.js` — hazards and respawn, rendering every stage in every phase, the
  descending-platform crush case, and partner disconnection.

## Browser support

Any browser with WebRTC data channels and Canvas 2D: current Chrome, Edge,
Firefox and Safari, desktop and mobile. Some corporate and carrier-grade-NAT
networks block direct peer connections; the game reports this clearly and local
co-op still works.
