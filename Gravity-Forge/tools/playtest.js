#!/usr/bin/env node
/*
 * Gravity Forge — scripted playtest.
 * Runs a hand-written solution script per level through the real engine
 * to verify the level is physically beatable.
 * Run: node tools/playtest.js [--seconds N]
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAX_SECONDS = Number(process.argv.find((a, i) => a === '--seconds') ? process.argv[process.argv.indexOf('--seconds') + 1] : 120);

const noop = () => {};
const ctx2d = new Proxy({}, { get: (t, k) => (typeof t[k] === 'function' ? t[k] : noop), set: () => true });
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => ctx2d, clientWidth: 960, clientHeight: 540 });

const sandbox = {
  console, Math, Date, JSON, setTimeout, clearTimeout, requestAnimationFrame: noop,
  performance: { now: () => Date.now() },
  window: null,
  document: {
    getElementById: () => null, addEventListener: noop,
    createElement: () => fakeCanvas(), readyState: 'complete', body: { appendChild: noop },
  },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem() {} },
  navigator: { maxTouchPoints: 0 },
};
sandbox.window = sandbox;
vm.createContext(sandbox);

let code = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
code += '\n;globalThis.__X__ = { Engine, LEVELS, Utils, CFG, Crusher, FallingBlock, MovingPlatform };';
vm.runInContext(code, sandbox);
const { Engine, LEVELS, Utils, CFG, Crusher } = sandbox.__X__;

// gravity index → vector
const GV = [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }];

class Runner {
  constructor(engine) {
    this.e = engine;
    this.stall = 0;
    this.lastX = engine.player.x;
    this.lastY = engine.player.y;
  }

  /** rotate gravity via the real API (velocity rotates with the world) */
  setGravity(idx) {
    const e = this.e;
    const cur = e.gravity;
    const curIdx = GV.findIndex(g => g.x === cur.x && g.y === cur.y);
    let diff = idx - curIdx;
    if (diff === 3) diff = -1;
    if (diff === -3) diff = 1;
    for (let i = 0; i < Math.abs(diff); i++) {
      e.gravCooldown = 0;
      e.rotateGravity(diff < 0);
    }
  }

  /** run a phase; returns when the phase duration elapses or level completes */
  phase(ph, maxDur) {
    const e = this.e;
    const T = CFG.TILE;
    const t0 = e.time;
    const until = t0 + (ph.dur !== undefined ? ph.dur : maxDur);
    this.setGravity(ph.g);
    let jumpTimer = 0;
    let lastJump = 0;

    while (e.time < until && !e.completed) {
      const p = e.player;
      const inp = { left: false, right: false, jump: false, jumpHeld: true, rotCW: false, rotCCW: false, joy: null };

      // walk direction, floor-relative AND goal-relative:
      // walk:+1 = advance toward the goal along the current floor
      // (the key pressed is chosen by the gravity, so the ceiling
      //  mirror is handled automatically)
      const w = ph.walk || 0;
      if (w !== 0) {
        const gx = e.goal.cx, gy = e.goal.cy;
        const right = Utils.rot(e.gravity.x, e.gravity.y, -Math.PI / 2);
        const along = (gx - p.x) * right.x + (gy - p.y) * right.y;
        const toward = w > 0 ? along >= 0 : along < 0;
        if (toward) inp.right = true; else inp.left = true;
      }

      // ----- on a moving platform: ride toward the goal -----
      if (p.onPlatform) {
        const gx = e.goal.cx, gy = e.goal.cy;
        const right = Utils.rot(e.gravity.x, e.gravity.y, -Math.PI / 2);
        const along = (gx - p.x) * right.x + (gy - p.y) * right.y;
        inp.left = false; inp.right = false;
        if (along > 4) inp.right = true;
        else if (along < -4) inp.left = true;
        // grab a high goal by hopping
        if (Math.abs(gx - (p.x + p.w / 2)) < 2 * T && gy < p.y - 20) inp.jump = true;
        // avoid the edge of the world
        const overVoid = !e.solidAt(p.x + (inp.right ? p.w + 2 : -2), p.y + p.h + 8, p.w, 4);
        if (overVoid && !inp.jump) { inp.right = false; inp.left = true; }
      } else if (e.gravity.y > 0.5) {
        // ----- vertical gravity: auto-jump over obstacles -----
        const probeX = p.x + (inp.right ? p.w + 6 : -6);
        const probeW = p.w + 16;
        const hitAhead = e.solidAt(probeX, p.y + 4, probeW, p.h - 8);
        const gapAhead = !e.solidAt(probeX, p.y + p.h + 6, probeW, 4);
        const spikeAhead = (() => {
          // jump only when the spike patch is ~1 tile ahead of the body's front
          // (jumping too early lands inside the patch)
          const feetY = p.y + p.h - 2;
          const front = p.x + (inp.right ? p.w : 0);
          const ty = Math.floor(feetY / T);
          for (let tyy = ty - 1; tyy <= ty; tyy++) {
            for (let x = 0; x < e.W; x++) {
              if (e.tileAt(x, tyy) === '*') {
                const gap = x * T - front;
                const lo = ph.spikeGap ? ph.spikeGap[0] : 4;
                const hi = ph.spikeGap ? ph.spikeGap[1] : 14;
                if (gap >= lo && gap <= hi) return true;
                if (gap > hi) return false; // not close enough yet
              }
            }
          }
          return false;
        })();
        const laserAhead = (() => {
          const lx0 = probeX, ly0 = p.y + 2, lw = probeW, lh = p.h - 4;
          for (const l of e.lasers) {
            for (const cell of l.beam) {
              if (Utils.overlap(lx0, ly0, lw, lh, cell.x * T + 4, cell.y * T + 4, T - 8, T - 8)) return true;
            }
          }
          return false;
        })();
        const crusherAhead = (() => {
          // wait if a crusher head in this column is not resting at the top
          for (const c of e.deadlyBodies) {
            if (!(c instanceof Crusher)) continue;
            const px0 = probeX, px1 = probeX + probeW;
            if (c.x < px1 && c.x + c.w > px0 && c.state !== 'idle') return true;
          }
          return false;
        })();
        // boarding: wait near the mover, hop when it is ~1 tile ahead
        // (never walk into spikes while waiting)
        let board = false;
        if (ph.board) {
          let near = false;
          for (const m of e.movers) {
            const dx = Math.abs((m.x + m.w / 2) - (p.x + p.w / 2));
            const dy = (m.y) - (p.y + p.h); // mover top vs feet
            if (dy > -2.7 * T && dy < 2.4 * T) {
              if (dx < 2.6 * T) near = true;
              // hop when the mover is 0.6–1.9 tiles ahead (it drifts under us mid-hop)
              const ahead = (m.x + m.w / 2) - (p.x + p.w / 2);
              if (dx >= 0.6 * T && dx <= 1.9 * T) {
                board = true;
                jumpTimer += 1 / 60;
                if (jumpTimer >= 0.5) { inp.jump = true; jumpTimer = 0; }
              }
            }
          }
          if (!near && !board) {
            // walk toward the mover, but stop at the spike edge
            let spikeEdge = false;
            const feetY = p.y + p.h - 2;
            const front = p.x + p.w;
            for (let tyy = Math.floor(feetY / T); tyy >= 0; tyy--) {
              for (let x = 0; x < e.W; x++) {
                if (e.tileAt(x, tyy) === '*') {
                  const gap = x * T - front;
                  if (gap > -8 && gap <= 40) spikeEdge = true;
                }
              }
            }
            if (!spikeEdge) {
              for (const m of e.movers) {
                const dx = (m.x + m.w / 2) - (p.x + p.w / 2);
                if (Math.abs(dx) < 3.5 * T) {
                  if (dx > 0) inp.right = true; else inp.left = true;
                }
              }
            }
          }
        }
        // stalled while wanting to walk → jump (unless a crusher is ahead)
        const moved = Math.abs(p.x - this.lastX) + Math.abs(p.y - this.lastY);
        if (moved < 2 && (inp.right || inp.left)) this.stall += 1 / 60;
        else this.stall = 0;
        const grounded = p.onGround && p.y + p.h < (e.H - 1) * T + T; // truly standing (not hanging)
        if (this.stall > 0.45 && !crusherAhead && grounded && hitAhead) { inp.jump = true; this.stall = 0; }
        if (ph.jump) { inp.jump = true; ph.jump = false; }
        if (ph.jumpEvery && grounded) {
          jumpTimer += 1 / 60;
          if (jumpTimer >= ph.jumpEvery) { inp.jump = true; jumpTimer = 0; }
        }
        if (!ph.board && (hitAhead || gapAhead || spikeAhead || laserAhead)) inp.jump = true;
        if (ph.board && grounded && (hitAhead || laserAhead)) inp.jump = true;
        if (crusherAhead) { inp.right = false; inp.left = false; }
      } else {
        // horizontal gravity: plain walk (no auto-jump)
        if (ph.jump) { inp.jump = true; ph.jump = false; }
      }

      e.update(1 / 60, inp);
      this.lastX = p.x; this.lastY = p.y;
    }
  }
}

// ---------------------------------------------------------------
// Per-level solution scripts: phases of (g, walk, dur, opts)
//   g: 0 down, 1 right, 2 up, 3 left
//   walk: +1 → along-floor forward, -1 backward, 0 stand
//   opts: jump (once), jumpEvery (s), board (hop onto movers)
// ---------------------------------------------------------------
const SCRIPTS = [
  // L1 First Steps — walk right, auto-jump the pit
  [{ g: 0, walk: 1, dur: 8 }],
  // L2 Upside Down — walk to wall, flip up, ceiling-walk right, flip down through goal
  [{ g: 0, walk: 1, dur: 2 }, { g: 0, walk: 0, dur: 0.4 }, { g: 2, walk: 1, dur: 1.45 }, { g: 0, walk: 0, dur: 2 }],
  // L3 Sideways — walk right, flip to right wall, climb to the goal
  [{ g: 0, walk: 1, dur: 4 }, { g: 1, walk: 1, dur: 3 }],
  // L4 Four Ways — flip up before the core, ceiling walk, drop through the hole
  [{ g: 0, walk: 1, dur: 1.1 }, { g: 0, walk: 0, dur: 0.4 }, { g: 2, walk: 1, dur: 1.2 }, { g: 0, walk: 0, dur: 1.2 }, { g: 0, walk: 1, dur: 1 }],
  // L5 Lock & Key — climb pedestal, grab key, open door
  [{ g: 0, walk: 1, dur: 0.6 }, { g: 0, walk: 1, dur: 2.5, jumpEvery: 0.8 }, { g: 0, walk: 0, dur: 0.5, jump: true }, { g: 0, walk: 1, dur: 5 }],
  // L6 Switch It Up — press switch, walk through both doors
  [{ g: 0, walk: 1, dur: 7 }],
  // L7 On the Move — board M1, ride, board M2, ride to goal
  [{ g: 0, walk: 1, dur: 1.6 }, { g: 0, walk: 0, dur: 14, board: true }, { g: 0, walk: 1, dur: 2.2 }, { g: 0, walk: 0, dur: 14, board: true }],
  // L8 Watch Your Step — hop the falling blocks
  [{ g: 0, walk: 1, dur: 1.2 }, { g: 0, walk: 1, dur: 6, jumpEvery: 0.45 }],
  // L9 Laser Grid — walk, crawl under, jump the beam
  [{ g: 0, walk: 1, dur: 8 }],
  // L10 Crush Hour — walk and time the crushers (may die and retry)
  [{ g: 0, walk: 1, dur: 20 }],
  // L11 Checkpoint — spikes, checkpoint, beam, spikes
  [{ g: 0, walk: 1, dur: 10 }],
  // L12 Ride the Walls — board the lift, ride up, flip right, walk down wall to goal
  [{ g: 0, walk: 1, dur: 1.6 }, { g: 0, walk: 0, dur: 16, board: true }, { g: 1, walk: 1, dur: 4 }],
  // L13 Switchback — press switch, jump shortened beam, door
  [{ g: 0, walk: 1, dur: 7 }],
  // L14 Bridgework — press switch, hop the bridges (take off early!)
  [{ g: 0, walk: 1, dur: 9, spikeGap: [40, 70] }],
  // L15 Keymaster — key1, door1, pedestal key2, door2, laser, goal
  [{ g: 0, walk: 1, dur: 1.2 }, { g: 0, walk: 1, dur: 5, jumpEvery: 0.9 }, { g: 0, walk: 0, dur: 0.6, jump: true }, { g: 0, walk: 1, dur: 9 }],
  // L16 Clockwork — crusher timing, ride M over the pit
  [{ g: 0, walk: 1, dur: 3.5 }, { g: 0, walk: 1, dur: 2.2 }, { g: 0, walk: 0, dur: 16, board: true }],
  // L17 The Climb — flip up, ceiling walk, ledge, flip right, wall down to goal
  [{ g: 0, walk: 1, dur: 1.4 }, { g: 0, walk: 0, dur: 0.4 }, { g: 2, walk: 1, dur: 0.7 }, { g: 0, walk: 0, dur: 2 }, { g: 1, walk: 1, dur: 2.5 }],
  // L18 The Gauntlet — everything (checkpoint mid-way)
  [{ g: 0, walk: 1, dur: 12 }],
  // L19 Gravity Maze — jump+flip into the safe ceiling zone, chunk, right wall, floor
  [{ g: 0, walk: 1, dur: 0.95 }, { g: 0, walk: 1, dur: 0.45, jump: true }, { g: 2, walk: 1, dur: 0.6 }, { g: 0, walk: 0, dur: 1.5 }, { g: 1, walk: 1, dur: 1.6 }, { g: 0, walk: 0, dur: 1.2 }],
  // L20 The Forge — switch, door, spikes, crusher, checkpoint, spikes, laser, goal
  [{ g: 0, walk: 1, dur: 20 }],
  // L21 Cold Forge — board M1, ride, board M2, ride to goal
  [{ g: 0, walk: 1, dur: 1.5 }, { g: 0, walk: 0, dur: 14, board: true }, { g: 0, walk: 1, dur: 2 }, { g: 0, walk: 0, dur: 14, board: true }],
  // L22 The Core — spikes, board M1, crusher corridor, board M2, goal
  [{ g: 0, walk: 1, dur: 2.2 }, { g: 0, walk: 0, dur: 12, board: true }, { g: 0, walk: 1, dur: 3.5 }, { g: 0, walk: 0, dur: 12, board: true }],
];

const fx = { onDeath() {}, onCheckpoint() {}, onKey() {}, onDoor() {}, onSwitch() {}, onBlockLand() {},
             onCrusherWarn() {}, onCrusherHit() {}, onComplete() {}, onGravity() {}, onJump() {}, onLand() {}, onRespawn() {} };

let ok = 0, fail = 0;
for (let i = 0; i < LEVELS.length; i++) {
  const engine = new Engine(i, fx);
  const runner = new Runner(engine);
  let done = false;
  try {
    for (const ph of SCRIPTS[i]) {
      runner.phase(ph);
      if (engine.completed) break;
      if (engine.time > MAX_SECONDS) break;
    }
    done = engine.completed;
  } catch (ex) {
    console.log(`[ERR ] L${String(i + 1).padStart(2)} ${LEVELS[i].name.padEnd(16)} EXCEPTION: ${ex.message}`);
    fail++;
    continue;
  }
  if (done) { ok++; console.log(`[OK  ] L${String(i + 1).padStart(2)} ${LEVELS[i].name.padEnd(16)} completed in ${engine.time.toFixed(1)}s, deaths ${engine.deaths}`); }
  else {
    fail++;
    const p = engine.player;
    console.log(`[FAIL] L${String(i + 1).padStart(2)} ${LEVELS[i].name.padEnd(16)} time ${engine.time.toFixed(1)}s deaths ${engine.deaths} — player at (${(p.x / CFG.TILE).toFixed(1)}, ${(p.y / CFG.TILE).toFixed(1)})`);
  }
}
console.log(`\n=== ${ok}/${LEVELS.length} levels cleared by scripted playtest ===`);
process.exit(fail ? 1 : 0);
