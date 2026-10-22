# ⚡ Gravity Forge

A polished, addictive **gravity-bending puzzle-platformer** for the browser. You play a tiny robot trapped in the Forge — a machine-world of spikes, lasers, crushers and falling blocks. Rotate gravity in four directions, ride moving platforms, crack switches and doors, and escape all 22 handcrafted levels.

**100% vanilla JavaScript, HTML5 Canvas and the Web Audio API.** No engines, no frameworks, no external libraries, no build step. The whole game is a handful of files you can read, tweak and deploy anywhere.

![Tech](https://img.shields.io/badge/JS-ES6%2B-ff9f43) ![Tech](https://img.shields.io/badge/Audio-Web%20Audio%20API-4df0ff) ![Tech](https://img.shields.io/badge/Art-Procedural%20Canvas-6dff9e) ![License](https://img.shields.io/badge/license-MIT-8b93b8)

---

## 🎮 Play it

The game deploys straight to **GitHub Pages** — push the repo and it's live. You can also just open `index.html` in any modern browser (works from `file://`, no server needed).

- **Desktop:** keyboard + mouse
- **Mobile / tablet:** virtual joystick + jump + gravity buttons (touch-optimized, fullscreen button included)

---

## 🕹 Controls

| Action | Keyboard | Touch |
|---|---|---|
| Walk along the floor | `←` `→` or `A` `D` | Drag left half (virtual joystick) |
| Jump | `↑` `W` `Space` | `▲` button |
| Rotate gravity (CCW) | `Z` `Q` `[` | — |
| Rotate gravity (CW) | `X` `E` `]` | Tap `●` (drag it to aim gravity) |
| Pause | `P` / `Esc` | `⏸` button |
| Restart level | `R` | — |
| Mute | `M` | — |
| Fullscreen | `F` | `⛶` button |

> **The core idea:** gravity is a force you aim. You always *fall* toward it, *jump* away from it, and *walk along whatever surface you land on*. When the world flips, the whole level visibly spins around your robot — and your controls spin with it. On the ceiling, `←` and `→` swap!

---

## 🗺 The Forge — 22 levels

Each level introduces one new mechanic, then the later levels mix everything together:

1. **First Steps** — move, jump, reach the portal
2. **Upside Down** — gravity up: the ceiling becomes the floor
3. **Sideways** — gravity left/right: walk up the walls
4. **Four Ways** — a sealed core that only the ceiling can reach
5. **Lock & Key** — keys open doors
6. **Switch It Up** — switches open doors
7. **On the Move** — moving platforms
8. **Watch Your Step** — falling blocks
9. **Laser Grid** — laser beams (jump over, crawl under)
10. **Crush Hour** — timed crushers
11. **Checkpoint** — checkpoints keep your progress
12. **Ride the Walls** — lift platforms + wall walking
13. **Switchback** — switches that stop lasers
14. **Bridgework** — switch-built bridges over spike pits
15. **Keymaster** — two keys, two doors, a checkpoint
16. **Clockwork** — crushers, falling blocks and lifts
17. **The Climb** — a vertical flip-chain
18. **The Gauntlet** — everything, in sequence
19. **Gravity Maze** — read the room before you flip
20. **The Forge** — the final gauntlet
21. **Cold Forge** — bonus: no mercy
22. **The Core** — bonus: the final test

Finish fast for **up to 3 stars** per level. Best times, stars and total deaths are saved automatically in your browser (localStorage).

---

## 🧱 Hazards & objects

| Symbol | Object | Notes |
|---|---|---|
| `#` | Wall | solid |
| `=` | Platform block | solid |
| `-` | One-way ledge | pass from the other side |
| `K` / `D` | Key / Door | keys open doors (and are consumed) |
| `S` | Switch | sticky ON — opens doors, materializes `t` platforms |
| `t` | Toggle platform | solid while the switch is on |
| `>` `<` `^` `v` | Lasers | fire in the arrow's direction; blocked by walls and doors |
| `*` | Spikes | instant robot soup |
| `M` / `V` | Moving platform | patrols horizontally / vertically |
| `F` | Falling block | falls when you get close, then respawns |
| `C` | Crusher | timed; kills on contact while moving |
| `X` | Checkpoint | respawn point |
| `G` | Goal portal | touch it to complete the level |

---

## 📁 Folder structure

```
/
├── index.html          # single page: canvas + UI overlays
├── style.css           # all styling (dark industrial theme)
├── script.js           # the entire game (classes, ~3000 lines, commented)
├── favicon.svg         # the robot face
├── assets/
│   ├── sounds/         # (procedural — see note below)
│   ├── sprites/        # (procedural — see note below)
│   └── fonts/          # (system fonts used — drop custom fonts here)
├── tools/              # optional dev utilities
│   ├── render_levels.py    # renders the ASCII levels to PNG for inspection
│   ├── bot_test.js         # headless AI playthrough of every level
│   └── playtest.js         # scripted solution playthroughs
└── .github/workflows/deploy.yml   # auto-deploy to GitHub Pages
```

> **Why are `assets/sounds` and `assets/sprites` empty?**
> Gravity Forge generates **all audio procedurally** with the Web Audio API (music, jump, gravity whoosh, lasers, victory fanfare…) and **all art procedurally** on offscreen canvases. There are zero binary assets — the game is fully self-contained, loads instantly, and never blocks on downloads. If you want custom audio or sprite sheets, drop them into those folders and swap the relevant code in `script.js`.

---

## 🚀 Run it locally

**Option 1 — double-click.** Just open `index.html` in Chrome, Firefox, Edge or Safari. (Everything is inline; no server required.)

**Option 2 — local server** (recommended for development):

```bash
# Python 3
python3 -m http.server 8000
# then open http://localhost:8000

# or Node
npx serve .
```

---

## 📤 Upload to GitHub & enable GitHub Pages

1. **Create a repository** at https://github.com/new (name it e.g. `gravity-forge`).
2. **Push the project:**

   ```bash
   git init
   git add .
   git commit -m "Gravity Forge — a gravity-bending robot adventure"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/gravity-forge.git
   git push -u origin main
   ```

3. **Enable GitHub Pages** (one-time, ~30 seconds):
   - Go to the repo → **Settings → Pages**
   - Under **Build and deployment** → **Source**, select **GitHub Actions**
   - Done — the included workflow (`.github/workflows/deploy.yml`) now deploys automatically **on every push to `main`**.
   - Your game is live at `https://YOUR_USERNAME.github.io/gravity-forge/` 🎉

> The workflow runs on every push (and can be triggered manually from the **Actions** tab). No build tools, no configuration files, no API keys.

---

## 🛠 Extending the game

Everything lives in `script.js`, organized into clearly separated classes:

```
Utils / AudioManager / SaveManager / InputManager   — foundations
LEVELS                                              — all 22 levels (ASCII maps!)
Sprites / ParticleSystem                            — rendering helpers
Entity classes                                      — player, lasers, crushers, doors…
Engine                                              — physics, collisions, rules
Camera / Renderer                                   — drawing
Game                                                — screens, HUD, touch, menus
```

**Adding a level** is as simple as appending an entry to the `LEVELS` array:

```js
{
  name: 'My Level',
  hint: 'Flip up and ride the lift!',
  star1: 45, star2: 70,               // par seconds for 3★ / 2★
  map: [
    '########################',
    '#......................#',
    '#..P.......G............#',
    '#......................#',
    '########################',
  ],
},
```

Run `python3 tools/render_levels.py --render` to render all levels as PNGs, and `node tools/playtest.js` to have the scripted bot verify a level is physically beatable.

**Tuning the feel** (jump height, gravity, walk speed, particles…) — everything is in the `CFG` object at the top of `script.js`.

---

## 🧪 Testing

- `python3 tools/render_levels.py` — validates every map (rectangular, one spawn, one goal, reachability) and renders PNG previews.
- `node tools/playtest.js` — plays hand-written solution scripts through the real physics engine to verify levels are beatable.
- `node tools/bot_test.js` — a heuristic AI that attempts every level on its own.

---

## 📜 License

MIT — do whatever you like with it. See [LICENSE](LICENSE).

Made with ☕, vanilla JS and an unreasonable amount of love for gravity puns.
