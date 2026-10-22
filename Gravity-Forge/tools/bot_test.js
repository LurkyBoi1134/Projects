#!/usr/bin/env node
/*
 * Gravity Forge headless test harness.
 * Loads script.js in a stubbed-DOM Node context, then:
 *   1. validates every level parses and has the right entities
 *   2. runs a heuristic bot through each level for N simulated seconds
 *   3. reports completions / deaths / furthest progress
 * Run: node tools/bot_test.js [--script path] [--seconds N]
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = process.argv.find((a, i) => a === '--script') ? process.argv[process.argv.indexOf('--script') + 1] : path.join(ROOT, 'script.js');
const MAX_SECONDS = Number(process.argv.find((a, i) => a === '--seconds') ? process.argv[process.argv.indexOf('--seconds') + 1] : 90);

// ---- DOM / browser stubs ----
const noop = () => {};
const ctx2d = new Proxy({}, { get: (t, k) => {
  if (k === 'canvas') return { width: 0, height: 0 };
  return typeof t[k] === 'function' ? t[k] : noop;
}, set: () => true });
const fakeCanvas = () => ({ width: 0, height: 0, getContext: () => ctx2d, clientWidth: 960, clientHeight: 540 });

const sandbox = {
  console, Math, Date, JSON, setTimeout, clearTimeout, requestAnimationFrame: noop,
  performance: { now: () => Date.now() },
  window: null,
  document: {
    getElementById: () => null,
    addEventListener: noop,
    createElement: () => fakeCanvas(),
    readyState: 'complete',
    body: { appendChild: noop },
  },
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] || null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  },
  navigator: { maxTouchPoints: 0 },
};
sandbox.window = sandbox;
vm.createContext(sandbox);

let code = fs.readFileSync(SCRIPT, 'utf8');
code += '\n;globalThis.__X__ = { Engine, LEVELS, Utils, CFG, FallingBlock, Crusher, MovingPlatform };';
vm.runInContext(code, sandbox);
const { Engine, LEVELS, Utils, CFG } = sandbox.__X__;

// =====================================================================
// Heuristic bot: seeks the goal, jumps obstacles, flips gravity when stuck
// =====================================================================
class Bot {
  constructor(engine, seed) {
    this.engine = engine;
    this.rng = seed || (() => Math.random());
    this.stuckTimer = 0;
    this.bestX = -1e9;
    this.bestY = -1e9;
    this.rotTimer = 0;
    this.rotDir = 1;
    this.deaths = 0;
    this.mode = 'seek';
    this.modeTimer = 0;
    this.prevX = engine.player.x;
  }

  step(dt) {
    const e = this.engine;
    const p = e.player;
    const gx = e.goal.cx;
    const gy = e.goal.cy;

    if (e.dying) return { left: false, right: false, jump: false, jumpHeld: true, rotCW: false, rotCCW: false, joy: null };

    // progress tracking
    const dist = Math.abs(gx - p.x) + Math.abs(gy - p.y);
    if (this.bestDist === undefined || dist < this.bestDist - 1) {
      this.bestDist = dist;
      this.stuckTimer = 0;
    } else {
      this.stuckTimer += dt;
    }
    if (p.dead) { this.deaths++; }

    const inp = { left: false, right: false, jump: false, jumpHeld: true, rotCW: false, rotCCW: false, joy: null };

    // stuck → rotate gravity toward the goal (shortest path), or jump
    if (this.stuckTimer > 2.0 && this.rotTimer <= 0) {
      this.rotDir = (this.rotDir + 1) % 4;
      if (this.rotDir === 0) {
        // aim gravity in the goal direction
        const dx = gx - p.x, dy = gy - p.y;
        const want = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 0 : 2);
        const targets = [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 }];
        const curIdx = targets.findIndex(g => g.x === e.gravity.x && g.y === e.gravity.y);
        let diff = want - curIdx;
        if (diff === 3) diff = -1;
        if (diff === -3) diff = 1;
        if (diff > 0) inp.rotCW = true;
        else if (diff < 0) inp.rotCCW = true;
        else inp.jump = true;
      } else if (this.rotDir === 1) {
        inp.jump = true;
      } else {
        inp.rotCW = true;
      }
      this.rotTimer = 0.9;
      this.stuckTimer = 0;
      return inp;
    }
    this.rotTimer -= dt;
    if (this.rotTimer > 0) return inp;

    // goal seeking: walk along the current floor toward the goal
    const right = Utils.rot(e.gravity.x, e.gravity.y, -Math.PI / 2);
    const along = (gx - p.x) * right.x + (gy - p.y) * right.y;
    if (along > 2) inp.right = true;
    else if (along < -2) inp.left = true;
    else inp.right = true;

    // probe ahead: wall, gap, spikes, or laser beam
    const T = CFG.TILE;
    const probeX = p.x + (inp.right ? p.w + 6 : -6);
    const probeY = p.y;
    const hitAhead = e.solidAt(probeX, probeY + 4, p.w, p.h - 8);
    const gapAhead = !e.solidAt(probeX, probeY + p.h + 6, p.w, 4);
    const spikeAhead = (() => {
      const tx = Math.floor(probeX / T), ty = Math.floor((probeY + p.h + 2) / T);
      const tx2 = Math.floor((probeX + p.w) / T);
      for (let x = tx; x <= tx2; x++) if (e.tileAt(x, ty) === '*') return true;
      return false;
    })();
    const laserAhead = (() => {
      for (const l of e.lasers) {
        for (const cell of l.beam) {
          if (Utils.overlap(probeX, probeY + 4, p.w, p.h - 8, cell.x * T + 4, cell.y * T + 4, T - 8, T - 8)) return true;
        }
      }
      return false;
    })();
    if (hitAhead || gapAhead || spikeAhead || laserAhead) inp.jump = true;

    // random hops to clear steps
    if (this.rng() < 0.02) inp.jump = true;

    return inp;
  }
}

// =====================================================================
// Run the tests
// =====================================================================
const results = [];
let totalErr = 0;

for (let i = 0; i < LEVELS.length; i++) {
  const lvl = LEVELS[i];
  let errs = [];
  try {
    const fx = { onDeath(){}, onCheckpoint(){}, onKey(){}, onDoor(){}, onSwitch(){}, onBlockLand(){}, onCrusherWarn(){}, onCrusherHit(){}, onComplete(){}, onGravity(){}, onJump(){}, onLand(){}, onRespawn(){} };
    const e = new Engine(i, fx);
    // sanity: entity counts
    if (!e.goal) errs.push('no goal');
    if (!e.spawnPoint) errs.push('no spawn');
    const T = CFG.TILE;
    // simulate
    const bot = new Bot(e);
    let completed = false;
    let simTime = 0;
    let dt = 1 / 60;
    let maxFrames = MAX_SECONDS * 60;
    for (let f = 0; f < maxFrames; f++) {
      const inp = bot.step(dt);
      e.update(dt, inp);
      simTime += dt;
      if (e.completed) { completed = true; break; }
      if (f % 600 === 0) {
        // watch for physics blowups
        const p = e.player;
        if (!isFinite(p.x) || !isFinite(p.y) || Math.abs(p.x) > 1e5 || Math.abs(p.y) > 1e5) {
          errs.push('physics blowup');
          break;
        }
      }
    }
    results.push({ idx: i, name: lvl.name, completed, simTime, deaths: e.deaths, botDeaths: bot.deaths, errs });
    if (!completed) {
      console.log(`[${'FAIL'.padEnd(4)}] L${String(i + 1).padStart(2)} ${lvl.name.padEnd(16)} time ${simTime.toFixed(0)}s deaths ${e.deaths}  (bot stuck)`);
    } else {
      console.log(`[${'OK'.padEnd(4)}] L${String(i + 1).padStart(2)} ${lvl.name.padEnd(16)} completed in ${simTime.toFixed(1)}s, deaths ${e.deaths}`);
    }
  } catch (ex) {
    errs.push('EXCEPTION: ' + ex.message);
    totalErr++;
    console.log(`[ERR ] L${String(i + 1).padStart(2)} ${lvl.name.padEnd(16)} ${ex.message}`);
  }
  if (errs.length) {
    totalErr += errs.length;
    for (const er of errs) console.log('      ' + er);
  }
}

const ok = results.filter(r => r.completed).length;
console.log(`\n=== ${ok}/${results.length} levels completed by heuristic bot ===`);
process.exit(totalErr ? 1 : 0);
