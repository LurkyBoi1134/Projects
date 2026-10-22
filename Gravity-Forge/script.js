/* ============================================================================
   GRAVITY FORGE — script.js
   A polished puzzle-platformer where you rotate gravity as a tiny robot.
   Vanilla JS (ES6+), HTML5 Canvas, Web Audio API. No engines, no libraries.

   Architecture:
     Utils         — math / helpers
     AudioManager  — Web Audio API: procedural SFX + generative music
     SaveManager   — localStorage persistence (progress, best times, settings)
     InputManager  — keyboard + virtual joystick / touch buttons
     LEVELS        — handcrafted level data (ASCII maps)
     Sprites       — pre-rendered offscreen-canvas sprites (fast drawing)
     Particles     — pooled particle system
     Entity*       — player, platforms, crushers, lasers, switches…
     Engine        — pure game-logic world (physics, collisions, rules)
     Camera        — smooth follow camera + screen shake
     Renderer      — draws the world to canvas
     UI            — DOM screens, HUD, level select, menus
     Game          — state machine tying everything together
     Boot          — guarded startup (also safe to load in Node for tests)
   ========================================================================== */
'use strict';

/* ============================================================================
   0. CONFIG — tune the feel of the game here
   ========================================================================== */
const CFG = {
  TILE: 32,                    // pixel size of one tile
  STEP: 1 / 60,                // fixed physics timestep (60 Hz)
  MAX_FRAME: 0.1,              // clamp frame delta to avoid spiral of death

  // Player physics (px, px/s, px/s^2)
  MOVE_SPEED: 225,
  ACCEL: 2100,
  AIR_ACCEL: 1500,
  FRICTION: 2400,
  GRAVITY: 2450,
  JUMP_VEL: 700,              // ≈ 3.1 tiles jump height, ~0.57 s airtime
  MAX_FALL: 780,
  JUMP_CUT: 0.45,              // release jump early → lower jump
  COYOTE_TIME: 0.10,           // grace period after leaving a ledge
  JUMP_BUFFER: 0.12,           // press jump slightly before landing

  ROTATE_SPIN: 0.16,           // seconds the world visually spins on flip
  GRAV_COOLDOWN: 0.12,         // min time between gravity flips
  KEY_LOCK: 0.5,               // door-open lockout after consuming a key

  PARTICLE_CAP: 320,
};

/* ============================================================================
   1. UTILS
   ========================================================================== */
const Utils = {
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  damp(a, b, lambda, dt) { return Utils.lerp(a, b, 1 - Math.exp(-lambda * dt)); },
  easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); },
  easeOutBack(t) { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  rand(a, b) { return a + Math.random() * (b - a); },
  randInt(a, b) { return Math.floor(Utils.rand(a, b + 1)); },
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; },
  /** format milliseconds → 00:00.00 */
  fmtTime(ms) {
    if (!isFinite(ms)) return '—';
    const t = Math.max(0, Math.floor(ms));
    const m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), cs = Math.floor((t % 1000) / 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  },
  /** rotate a vector by θ radians */
  rot(vx, vy, th) {
    const c = Math.cos(th), s = Math.sin(th);
    return { x: vx * c - vy * s, y: vx * s + vy * c };
  },
  /** AABB overlap */
  overlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  },
  /** point-in-rect */
  inRect(px, py, x, y, w, h) { return px >= x && px <= x + w && py >= y && py <= y + h; },
  /** segment vs AABB collision, returns t (0..1) of closest hit or -1 */
  segHitsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
    const dx = x2 - x1, dy = y2 - y1;
    let tmin = 0, tmax = 1;
    const axes = [
      [-dx, x1 - rx,     x1 - (rx + rw)],
      [-dy, y1 - ry,     y1 - (ry + rh)],
      [ dx, rx - x1,     rx + rw - x1],
      [ dy, ry - y1,     ry + rh - y1],
    ];
    for (const [p, q0, q1] of axes) {
      if (Math.abs(p) < 1e-9) {
        if (q0 > 0 || q1 < 0) return -1; // parallel & outside
      } else {
        const t0 = q0 / p, t1 = q1 / p;
        const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
        tmin = Math.max(tmin, lo); tmax = Math.min(tmax, hi);
        if (tmin > tmax) return -1;
      }
    }
    return tmin;
  },
};

/* ============================================================================
   2. AUDIO — 100% procedural Web Audio (no asset files needed)
   ========================================================================== */
class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.musicGain = null;
    this.enabled = false;
    this.musicOn = false;
    this.musicTimer = null;
    this.nextNoteTime = 0;
    this.step = 0;
    this.mode = 'menu'; // 'menu' | 'game'
    this.muted = false;
    this.volMusic = 0.5;
    this.volSfx = 0.8;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return; // headless / unsupported — stay silent
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = this.volSfx;
    this.sfxBus.connect(this.master);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = this.muted ? 0 : this.volMusic * 0.55;
    this.musicBus.connect(this.master);

    // shared delay for warmth
    this.delay = this.ctx.createDelay(0.6);
    this.delay.delayTime.value = 0.28;
    const fb = this.ctx.createGain(); fb.gain.value = 0.22;
    this.delay.connect(fb); fb.connect(this.delay);
    const wet = this.ctx.createGain(); wet.gain.value = 0.18;
    this.delay.connect(wet); wet.connect(this.sfxBus);

    this.enabled = true;
    this.startMusic(this.mode);
  }

  setMusicVol(v) { this.volMusic = v; if (this.musicBus) this.musicBus.gain.value = this.muted ? 0 : v * 0.55; }
  setSfxVol(v) { this.volSfx = v; if (this.sfxBus) this.sfxBus.gain.value = v; }
  setMuted(m) { this.muted = m; if (this.musicBus) this.musicBus.gain.value = m ? 0 : this.volMusic * 0.55; }

  /* ---------------- low-level helpers ---------------- */
  _env(when, dur, peak) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    return g;
  }
  _tone(type, f0, f1, dur, vol, when = 0, dest = null) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this._env(t, dur, vol);
    o.connect(g); g.connect(dest || this.sfxBus);
    o.start(t); o.stop(t + dur + 0.03);
  }
  _noise(dur, vol, when = 0, fLow = 400, fHigh = 6000, dest = null) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + when;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.setValueAtTime(fHigh, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, fLow), t + dur);
    f.Q.value = 0.9;
    const g = this._env(t, dur, vol);
    src.connect(f); f.connect(g); g.connect(dest || this.sfxBus);
    src.start(t); src.stop(t + dur + 0.03);
  }

  /* ---------------- SFX ---------------- */
  sfxJump() { this._tone('square', 300, 720, 0.16, 0.16); this._tone('sine', 180, 420, 0.14, 0.12); }
  sfxJumpPad() { this._tone('sine', 240, 480, 0.22, 0.2); }
  sfxLand() { this._noise(0.07, 0.1, 0, 200, 900); }
  sfxGravity(dir) {
    // whoosh: filtered noise + pitch sweep; dir = +1 (cw) / -1 (ccw)
    this._noise(0.22, 0.28, 0, 300, dir > 0 ? 5200 : 3600);
    this._tone('sawtooth', dir > 0 ? 140 : 200, dir > 0 ? 520 : 320, 0.2, 0.05);
  }
  sfxCheckpoint() { this._tone('sine', 660, 660, 0.12, 0.2); this._tone('sine', 990, 990, 0.2, 0.2, 0.09); this._tone('triangle', 1320, 1320, 0.28, 0.12, 0.18); }
  sfxKey() {
    [880, 1108.7, 1318.5, 1760].forEach((f, i) => this._tone('triangle', f, f, 0.14, 0.16, i * 0.05));
    this._noise(0.1, 0.05, 0, 6000, 9000);
  }
  sfxDoor() { this._tone('triangle', 200, 80, 0.3, 0.22); this._noise(0.25, 0.12, 0, 150, 500); }
  sfxSwitch(on) { this._tone('square', on ? 520 : 300, on ? 780 : 220, 0.12, 0.14); this._noise(0.06, 0.08, 0, 800, 3000); }
  sfxCrush() { this._tone('square', 90, 40, 0.3, 0.3); this._noise(0.25, 0.3, 0, 120, 700); }
  sfxBlockDrop() { this._noise(0.2, 0.2, 0, 150, 800); this._tone('sine', 120, 50, 0.25, 0.2); }
  sfxDeath() {
    this._noise(0.4, 0.35, 0, 150, 4200);
    this._tone('sawtooth', 400, 60, 0.42, 0.2);
    this._tone('square', 200, 40, 0.35, 0.14, 0.02);
  }
  sfxRespawn() { this._tone('sine', 300, 640, 0.25, 0.12); }
  sfxVictory() {
    const seq = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    seq.forEach((f, i) => this._tone('triangle', f, f, 0.34, 0.2, i * 0.11));
    seq.forEach((f, i) => this._tone('sine', f * 2, f * 2, 0.3, 0.08, i * 0.11 + 0.02));
    this._noise(0.9, 0.05, 0, 8000, 10000);
  }
  sfxStar() { this._tone('triangle', 1046.5, 1046.5, 0.18, 0.18); this._tone('triangle', 1568, 1568, 0.3, 0.18, 0.08); }
  sfxUi() { this._tone('sine', 700, 900, 0.06, 0.07); }
  sfxStart() { [392, 523.25, 659.25].forEach((f, i) => this._tone('triangle', f, f, 0.16, 0.15, i * 0.07)); }

  /* ---------------- generative music ---------------- */
  startMusic(mode) {
    this.mode = mode;
    if (!this.ctx || !this.enabled) return;
    this.musicOn = true;
    this.step = 0;
    this.nextNoteTime = this.ctx.currentTime + 0.06;
    if (!this.musicTimer) {
      this.musicTimer = setInterval(() => this._schedule(), 90);
    }
  }
  stopMusic() {
    this.musicOn = false;
    if (this.musicTimer) { clearInterval(this.musicTimer); this.musicTimer = null; }
  }
  switchMode(mode) { if (mode !== this.mode) { this.mode = mode; this.step = 0; } }

  _schedule() {
    if (!this.ctx || !this.musicOn) return;
    const lookahead = 0.22;
    while (this.nextNoteTime < this.ctx.currentTime + lookahead) {
      this._playStep(this.step, this.nextNoteTime);
      this.step++;
      this.nextNoteTime += 60 / this._bpm() / 4; // 16th notes
    }
  }
  _bpm() { return this.mode === 'game' ? 128 : 88; }

  _playStep(step, t) {
    const s = step % 32;
    const bpm = this._bpm();
    const eighth = 60 / bpm / 2;
    const bar = Math.floor(s / 8) % 4;
    const beat = s % 8;

    // chord progressions
    const gameChords = [
      [110, 130.81, 164.81, 196],     // Cm
      [87.31, 103.83, 130.81, 155.56], // Ab
      [98, 116.54, 146.83, 174.61],   // Bb
      [87.31, 103.83, 130.81, 155.56], // Ab
    ];
    const menuChords = [
      [110, 130.81, 164.81, 220],     // Am
      [87.31, 103.83, 130.81, 174.61], // F
      [98, 116.54, 146.83, 196],      // G
      [87.31, 103.83, 130.81, 174.61], // F
    ];
    const chords = this.mode === 'game' ? gameChords : menuChords;
    const chord = chords[bar];
    const isGame = this.mode === 'game';
    const volBase = isGame ? 0.09 : 0.075;
    const when = t - this.ctx.currentTime;

    // bass on beats 0 and 4 (octave bounce)
    if (beat === 0 || beat === 4) {
      this._tone('triangle', chord[0], chord[0], eighth * 0.92, volBase * 1.15, when, this.musicBus);
      if (isGame) this._tone('square', chord[0] / 2, chord[0] / 2, eighth * 0.9, volBase * 0.35, when, this.musicBus);
    }
    // arp: 16ths with a pattern
    const arpNotes = [chord[1], chord[2], chord[3], chord[2], chord[1], chord[3], chord[2] * 2, chord[1] * 2];
    const n = arpNotes[s % 8];
    if (isGame) {
      if (s % 2 === 0) this._tone('square', n, n, eighth * 0.5, volBase * 0.6, when, this.musicBus);
      if (s % 4 === 2) this._tone('sine', n * 2, n * 2, eighth * 0.5, volBase * 0.3, when, this.musicBus);
    } else {
      if (s % 2 === 0) this._tone('sine', n, n, eighth * 0.7, volBase * 0.75, when, this.musicBus);
    }
    // sparkle every other bar
    if (s === 6) this._tone('sine', chord[3] * 2, chord[3] * 2, 0.3, volBase * 0.35, when, this.musicBus);
    // soft hat
    if (isGame && beat % 2 === 1) this._noise(0.03, volBase * 0.4, when, 7000, 9000, this.musicBus);
  }

  /** short sting played when a level starts */
  levelStart() { [440, 554.37, 659.25].forEach((f, i) => this._tone('sine', f, f, 0.14, 0.1, i * 0.06)); }
}

/* ============================================================================
   3. SAVE — localStorage
   ========================================================================== */
const SaveManager = {
  KEY: 'gravityforge.v1',
  data: null,

  defaults() {
    return {
      v: 1,
      unlocked: 0,              // highest unlocked level index
      stars: {},                // levelIdx -> 1..3
      best: {},                 // levelIdx -> ms
      deaths: {},               // levelIdx -> cumulative deaths
      totalDeaths: 0,
      settings: { music: 0.7, sfx: 0.85, shake: true, particles: true, muted: false },
    };
  },

  load() {
    try {
      const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(this.KEY);
      this.data = raw ? Object.assign(this.defaults(), JSON.parse(raw)) : this.defaults();
    } catch (e) {
      this.data = this.defaults(); // private mode etc.
    }
    return this;
  },

  save() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(this.KEY, JSON.stringify(this.data));
    } catch (e) { /* storage full / blocked — ignore */ }
  },

  unlockLevel(i) { if (i >= this.data.unlocked) { this.data.unlocked = i; this.save(); } },
  isUnlocked(i) { return i <= this.data.unlocked; },
  recordResult(levelIdx, ms, stars, deaths) {
    const d = this.data;
    d.stars[levelIdx] = Math.max(d.stars[levelIdx] || 0, stars);
    if (!(levelIdx in d.best) || ms < d.best[levelIdx]) d.best[levelIdx] = ms;
    d.deaths[levelIdx] = (d.deaths[levelIdx] || 0) + deaths;
    d.totalDeaths += deaths;
    if (levelIdx + 1 > d.unlocked) d.unlocked = Math.min(levelIdx + 1, LEVELS.length - 1);
    this.save();
  },
  totalStars() {
    const d = this.data;
    let n = 0;
    for (let i = 0; i < LEVELS.length; i++) n += d.stars[i] || 0;
    return n;
  },
  completedCount() {
    let n = 0;
    for (let i = 0; i < LEVELS.length; i++) if (this.data.stars[i]) n++;
    return n;
  },
  reset() { this.data = this.defaults(); this.save(); },
};

/* ============================================================================
   4. INPUT — keyboard + touch
   ========================================================================== */
class InputManager {
  constructor() {
    this.keys = new Set();
    this.left = false; this.right = false;
    this.up = false; this.down = false;
    this.jumpPressed = false;       // edge
    this.rotCCW = false; this.rotCW = false; // edges
    this.jumpHeld = false;
    this.lastPause = 0;
    this.touch = { active: false, joyDX: 0, joyDY: 0, jump: false, gravDX: 0, gravDY: 0, gravTouched: false };
    this._bind();
  }

  _bind() {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', (e) => this._keyDown(e));
    document.addEventListener('keyup', (e) => this._keyUp(e));
    window.addEventListener('blur', () => { this.keys.clear(); this.left = this.right = false; this.jumpHeld = false; });
  }

  _keyDown(e) {
    const c = e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(c)) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(c);
    switch (c) {
      case 'ArrowLeft': case 'a': case 'A': this.left = true; break;
      case 'ArrowRight': case 'd': case 'D': this.right = true; break;
      case 'ArrowUp': case 'w': case 'W': case ' ': this.jumpPressed = true; this.jumpHeld = true; break;
      case 'z': case 'Z': case 'q': case 'Q': case '[': this.rotCCW = true; break;
      case 'x': case 'X': case 'e': case 'E': case ']': this.rotCW = true; break;
      default: break;
    }
  }
  _keyUp(e) {
    const c = e.key;
    this.keys.delete(c);
    switch (c) {
      case 'ArrowLeft': case 'a': case 'A': this.left = false; break;
      case 'ArrowRight': case 'd': case 'D': this.right = false; break;
      case 'ArrowUp': case 'w': case 'W': case ' ': this.jumpHeld = false; break;
      default: break;
    }
  }

  /** consume edge-triggered state once per frame */
  consume() {
    const out = {
      left: this.left, right: this.right,
      jump: this.jumpPressed, jumpHeld: this.jumpHeld,
      rotCCW: this.rotCCW, rotCW: this.rotCW,
      joy: null,
    };
    // merge virtual joystick
    if (this.touch.active) {
      const dead = 0.22;
      const mag = Math.hypot(this.touch.joyDX, this.touch.joyDY);
      if (mag > dead) out.joy = { x: this.touch.joyDX / (mag || 1) * Math.min(1, mag), y: this.touch.joyDY / (mag || 1) * Math.min(1, mag) };
    }
    this.jumpPressed = false;
    this.rotCCW = false; this.rotCW = false;
    return out;
  }
}
/* ============================================================================
   5. LEVEL DATA — handcrafted ASCII maps
   Every row in a map is the same width; row 0 = ceiling, last row = floor.
   The player walks on the row just above the floor (row H-2) — interaction
   tiles (G, X, K, S, ground spikes, doors) are placed there.

   Tiles:
     #  wall            =  platform block     -  one-way ledge (from -g side)
     P  player spawn    G  goal portal        X  checkpoint
     K  key             D  door (key/switch)  S  switch (sticky ON)
     t  toggle platform (solid while switch ON)
     >  laser →         <  laser ←           ^  laser ↑        v  laser ↓
     *  spikes          M  moving platform ↔  V  moving platform ↕
     F  falling block   C  crusher (extends ↓)  .  empty
   star1 / star2 = par seconds for 3★ / 2★.
   ========================================================================== */
const LEVELS = [
  // ------------------------------------------------------------------
  { name: 'First Steps', hint: 'Arrow keys to move · jump over the wall', star1: 30, star2: 45,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#.....######...........#',
      '#......................#',
      '#..............#.......#',
      '#......................#',
      '#..P...........G.......#',
      '#############..#########',
    ] },

  // ------------------------------------------------------------------
  { name: 'Upside Down', hint: 'Z/X rotates gravity — the ceiling is a floor now!', star1: 40, star2: 60,
    map: [
      '########################',
      '#......................#',
      '#.............G........#',
      '#........########......#',
      '#........#.............#',
      '#........#.............#',
      '#........#.............#',
      '#........#.............#',
      '#........#.............#',
      '#P.......#......***....#',
      '########################',
    ] },

  // ------------------------------------------------------------------
  { name: 'Sideways', hint: 'Gravity right → you can walk up the right wall', star1: 40, star2: 60,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#.....................G#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#P.......**....**......#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Four Ways', hint: 'Four directions of gravity — find the way into the core', star1: 60, star2: 90,
    map: [
      '##########################',
      '#........................#',
      '#..........##..##........#',
      '#..........#....#.......*#',
      '#..........#....#.......*#',
      '#..........#....#.......*#',
      '#..........#....#.......*#',
      '#..........#...G#.......*#',
      '#..........######........#',
      '#........................#',
      '#........................#',
      '#P.......................#',
      '##########################',
    ] },

  // ------------------------------------------------------------------
  { name: 'Lock & Key', hint: 'Grab the key to open the door', star1: 45, star2: 70,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#..K...........#.......#',
      '#...............#......#',
      '#..=............D......#',
      '#..=............D......#',
      '#..P................G..#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Switch It Up', hint: 'Press the switch to open the door', star1: 50, star2: 75,
    map: [
      '########################',
      '#**********..****......#',
      '#..........####........#',
      '#..........####........#',
      '#..........######......#',
      '#..........######......#',
      '#..........######......#',
      '#..........#....#......#',
      '#..........D....#......#',
      '#..........D....D......#',
      '#..P..S....D........G..#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'On the Move', hint: 'Hop on the moving platforms — don’t touch the spikes', star1: 60, star2: 90,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#...................G..#',
      '#........M.......M.....#',
      '#..P....****....****...#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Watch Your Step', hint: 'Those blocks fall when you touch them — keep moving!', star1: 55, star2: 85,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#....F..F..F..F..F.....#',
      '#..P................G..#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Laser Grid', hint: 'Laser beams melt robots. Jump over, crawl under.', star1: 50, star2: 80,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#.......^..............#',
      '#.......=..............#',
      '#.............>.#......#',
      '#..P...........#....G..#',
      '########################',
    ] },

  // ------------------------------------------------------------------
  { name: 'Crush Hour', hint: 'Crushers cycle — wait for them to retract', star1: 60, star2: 95,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#.....C.........C......#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#..P....**.......G.....#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Checkpoint', hint: 'Checkpoints keep your progress when you die', star1: 90, star2: 130,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#..............=.......#',
      '#..............v.......#',
      '#......................#',
      '#..P...**X.....**G.....#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Ride the Walls', hint: 'The ceiling is spiked! Use the lift, then the right wall.', star1: 70, star2: 110,
    map: [
      '########################',
      '#**...*****************#',
      '#......................#',
      '#......................#',
      '#.....................G#',
      '#.....................*#',
      '#.....................*#',
      '#......................#',
      '#....V................*#',
      '#..P....*******........#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Switchback', hint: 'The switch materializes the block that stops the laser', star1: 70, star2: 110,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#...................#..#',
      '#...................#..#',
      '#...................#..#',
      '#..P......S..>..t..D.G.#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Bridgework', hint: 'The switch builds bridges over the spike pits', star1: 75, star2: 115,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......ttttt....ttttt..#',
      '#..P.S.*****....*****G.#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Keymaster', hint: 'Two keys, two doors. Don’t forget the checkpoint.', star1: 100, star2: 150,
    map: [
      '##########################',
      '#........................#',
      '#........................#',
      '#........................#',
      '#........................#',
      '#...........#..K.........#',
      '#...........#...=...#..^.#',
      '#...........#...=...#..=.#',
      '#..P..K....D.....D..X...G#',
      '#......**................#',
      '##########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Clockwork', hint: 'Timing is everything — crushers, drops and lifts', star1: 90, star2: 135,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#........C........FF...#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#...................M..#',
      '#..P...................#',
      '#......**........*****G#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'The Climb', hint: 'Up, across, sideways, down — one flip at a time', star1: 75, star2: 115,
    map: [
      '########################',
      '#...........***********#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#..........-...........#',
      '#..........#...........#',
      '#..........#...........#',
      '#..........#...........#',
      '#..........#...........#',
      '#..........#...........#',
      '#..P.......#..........G#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'The Gauntlet', hint: 'Spikes, crusher, falling block, laser — and a checkpoint', star1: 100, star2: 150,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#........C......F..^...#',
      '#...................=..#',
      '#......................#',
      '#..P..**...X..**....G..#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Gravity Maze', hint: 'Spikes above AND below — read the room before you flip', star1: 90, star2: 140,
    map: [
      '########################',
      '#*******......*********#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#..........####........#',
      '#..........####........#',
      '#..........####........#',
      '#......................#',
      '#.......***********....#',
      '#..P..................G#',
      '########################',
    ] },

  // ------------------------------------------------------------------
  { name: 'The Forge', hint: 'Everything you’ve learned. The Forge awaits.', star1: 130, star2: 190,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#.............C....F...#',
      '#......................#',
      '#....#.............^...#',
      '#....#.............=...#',
      '#....D.................#',
      '#P.S.D..**....X....**.G#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'Cold Forge', hint: 'Bonus level — no mercy', star1: 110, star2: 160,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#.........M......M.....#',
      '#..P...*****...*******G#',
      '########################'
    ] },

  // ------------------------------------------------------------------
  { name: 'The Core', hint: 'The final test. Good luck, little robot.', star1: 140, star2: 210,
    map: [
      '########################',
      '#......................#',
      '#......................#',
      '#......................#',
      '#.............C........#',
      '#......................#',
      '#......................#',
      '#......................#',
      '#........M......M......#',
      '#..P...*****X..*****..G#',
      '########################'
    ] },
];
/* ============================================================================
   6. SPRITES — pre-rendered offscreen canvases (fast, no per-frame cost)
   ========================================================================== */
const Sprites = {
  cache: {},

  make(w, h, draw) {
    const key = draw.toString().slice(0, 60) + w + 'x' + h;
    if (this.cache[key]) return this.cache[key];
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    draw(g, w, h);
    this.cache[key] = c;
    return c;
  },

  /** soft radial glow sprite (drawn additively for bloom) */
  glow(color, r) {
    return this.make(r * 2, r * 2, (g) => {
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, r * 2, r * 2);
    });
  },

  tile(type) {
    const T = CFG.TILE;
    const key = 'tile:' + type;
    if (this.cache[key]) return this.cache[key];
    const c = document.createElement('canvas');
    c.width = T; c.height = T;
    const g = c.getContext('2d');
    switch (type) {
      case '#': { // dark steel wall with bevel
        g.fillStyle = '#232a3d';
        g.fillRect(0, 0, T, T);
        g.fillStyle = '#2e3852';
        g.fillRect(1, 1, T - 2, T - 2);
        g.fillStyle = '#3b4a6b';
        g.fillRect(1, 1, T - 2, 4);
        g.fillStyle = '#1a2032';
        g.fillRect(1, T - 6, T - 2, 5);
        g.fillStyle = 'rgba(0,0,0,.25)';
        g.fillRect(0, T - 2, T, 2);
        g.fillStyle = 'rgba(255,255,255,.03)';
        for (let i = 6; i < T; i += 8) { g.fillRect(4, i, T - 8, 2); }
        break;
      }
      case '=': { // platform block, cyan-tinted
        g.fillStyle = '#2b3a5e';
        g.fillRect(0, 0, T, T);
        g.fillStyle = '#3d5385';
        g.fillRect(1, 1, T - 2, T - 2);
        g.fillStyle = '#5f7ec0';
        g.fillRect(1, 1, T - 2, 5);
        g.fillStyle = 'rgba(77,240,255,.14)';
        g.fillRect(1, T - 7, T - 2, 6);
        g.fillStyle = 'rgba(0,0,0,.3)';
        g.fillRect(0, T - 2, T, 2);
        break;
      }
      case '-': { // one-way ledge: thin glowing bar
        g.fillStyle = 'rgba(77,240,255,.16)';
        g.fillRect(0, 6, T, T - 6);
        g.fillStyle = '#5fd8e8';
        g.fillRect(0, 6, T, 4);
        g.fillStyle = 'rgba(140,250,255,.8)';
        g.fillRect(0, 7, T, 1);
        g.fillStyle = '#2a4a55';
        g.fillRect(0, 12, T, T - 12);
        break;
      }
      case 't': case 'tOn': case 'tOff': { // toggle platform
        const on = type !== 'tOff';
        g.fillStyle = on ? '#3d4d2e' : '#232a3d';
        g.fillRect(0, 0, T, T);
        g.fillStyle = on ? '#5c7a3c' : '#303a52';
        g.fillRect(1, 1, T - 2, T - 2);
        g.fillStyle = on ? '#8fbf5e' : '#4a5878';
        g.fillRect(1, 1, T - 2, 5);
        if (on) {
          g.fillStyle = 'rgba(140,255,120,.25)';
          g.fillRect(3, 10, T - 6, 3);
          g.fillRect(3, 18, T - 6, 3);
        }
        g.fillStyle = 'rgba(0,0,0,.3)';
        g.fillRect(0, T - 2, T, 2);
        break;
      }
      case 'D': case 'Dopen': { // door
        const open = type === 'Dopen';
        g.fillStyle = '#3a2b1e';
        g.fillRect(0, 0, T, T);
        g.fillStyle = open ? '#4a3d2e' : '#6b4a2a';
        g.fillRect(2, 2, T - 4, T - 4);
        g.fillStyle = open ? '#3a2b1e' : '#9a6a35';
        g.fillRect(2, 2, T - 4, 6);
        if (open) {
          g.fillStyle = 'rgba(120,255,180,.5)';
          g.fillRect(4, 6, T - 8, 3);
          g.fillStyle = '#2a2016';
          g.fillRect(0, 0, T, T);
          g.fillStyle = 'rgba(120,255,180,.25)';
          g.fillRect(3, 3, T - 6, T - 6);
        } else {
          g.fillStyle = '#ff9f43';
          g.fillRect(6, 10, T - 12, 4);
          g.fillRect(12, 6, 6, 12);
          g.fillStyle = 'rgba(255,159,67,.5)';
          g.fillRect(0, 0, T, 2);
        }
        break;
      }
      case 'S': case 'Son': { // switch
        const on = type === 'Son';
        g.fillStyle = '#1c2233';
        g.fillRect(0, T - 8, T, 8);
        g.fillStyle = '#2e3a55';
        g.fillRect(4, T - 14, T - 8, 8);
        g.fillStyle = on ? '#2f4a26' : '#3d4560';
        g.fillRect(6, T - 18, T - 12, 8);
        g.fillStyle = on ? '#8fbf5e' : '#5a6480';
        g.fillRect(6, T - 18, T - 12, 4);
        // button
        g.fillStyle = on ? '#a8e86e' : '#67718c';
        g.beginPath(); g.arc(T / 2, T - 16, 7, 0, Math.PI * 2); g.fill();
        g.fillStyle = on ? '#eaffe0' : '#aab2c8';
        g.beginPath(); g.arc(T / 2 - 2, T - 18, 3, 0, Math.PI * 2); g.fill();
        if (on) {
          g.fillStyle = 'rgba(140,255,120,.35)';
          g.fillRect(T / 2 - 12, T - 40, 24, 18);
        }
        break;
      }
      case '*': { // spikes
        g.fillStyle = '#262c40';
        g.fillRect(0, T - 8, T, 8);
        g.fillStyle = '#b7c4dd';
        for (let i = 0; i < 4; i++) {
          const x = i * 8;
          g.beginPath();
          g.moveTo(x, T);
          g.lineTo(x + 4, T - 14);
          g.lineTo(x + 8, T);
          g.fill();
        }
        g.fillStyle = 'rgba(255,77,109,.85)';
        g.beginPath();
        g.moveTo(0, T - 1); g.lineTo(4, T - 14); g.lineTo(8, T - 1);
        g.fill();
        g.beginPath();
        g.moveTo(8, T - 1); g.lineTo(12, T - 14); g.lineTo(16, T - 1);
        g.fill();
        g.beginPath();
        g.moveTo(16, T - 1); g.lineTo(20, T - 14); g.lineTo(24, T - 1);
        g.fill();
        g.beginPath();
        g.moveTo(24, T - 1); g.lineTo(28, T - 14); g.lineTo(32, T - 1);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,.4)';
        g.fillRect(3, T - 12, 2, 5);
        break;
      }
      case 'M': case 'V': { // moving platform: hover pad
        const v = type === 'V';
        g.fillStyle = '#12263a';
        g.fillRect(0, 4, T, T - 4);
        g.fillStyle = '#1d4a66';
        g.fillRect(1, 2, T - 2, T - 6);
        g.fillStyle = '#39b9e0';
        g.fillRect(1, 2, T - 2, 5);
        g.fillStyle = 'rgba(77,240,255,.3)';
        g.fillRect(4, 12, T - 8, 3);
        g.fillStyle = '#2a5a74';
        g.fillRect(4, 18, T - 8, 6);
        g.fillStyle = 'rgba(77,240,255,.6)';
        g.fillRect(v ? 13 : 4, 18, 6, 6);
        g.fillRect(v ? 13 : 22, 18, 6, 6);
        break;
      }
      case 'F': { // falling block: heavy crate
        g.fillStyle = '#241a12';
        g.fillRect(0, 0, T, T);
        g.fillStyle = '#6b4a2e';
        g.fillRect(2, 2, T - 4, T - 4);
        g.fillStyle = '#8a623f';
        g.fillRect(2, 2, T - 4, 5);
        g.fillStyle = '#4a3220';
        g.fillRect(2, T - 7, T - 4, 5);
        g.fillStyle = '#3a2818';
        g.fillRect(5, 5, 3, T - 10);
        g.fillRect(T - 8, 5, 3, T - 10);
        g.fillRect(5, 5, T - 10, 3);
        g.fillRect(5, T - 8, T - 10, 3);
        break;
      }
      case 'C': { // crusher head: hazard stripes
        g.fillStyle = '#2a2a35';
        g.fillRect(0, 0, T, T);
        g.fillStyle = '#454550';
        g.fillRect(1, 1, T - 2, T - 2);
        g.fillStyle = '#ff9f43';
        for (let i = -T; i < T; i += 8) {
          g.save(); g.beginPath(); g.rect(0, 0, T, T); g.clip();
          g.fillRect(i, 0, 4, T);
          g.restore();
        }
        g.fillStyle = 'rgba(0,0,0,.35)';
        g.fillRect(0, T - 3, T, 3);
        g.fillStyle = 'rgba(255,255,255,.5)';
        g.fillRect(1, 1, T - 2, 2);
        break;
      }
      case 'laserH': case 'laserV': { // laser emitter head
        const v = type === 'laserV';
        g.fillStyle = '#2a1220';
        g.fillRect(0, 0, T, T);
        g.fillStyle = '#4d1e35';
        g.fillRect(2, 2, T - 4, T - 4);
        g.fillStyle = '#ff4d6d';
        g.fillRect(v ? 10 : 2, v ? 2 : 10, v ? 12 : T - 4, v ? T - 4 : 12);
        g.fillStyle = '#ffd7e0';
        g.fillRect(v ? 14 : 6, v ? 6 : 14, 4, 4);
        g.fillStyle = 'rgba(255,77,109,.4)';
        g.fillRect(0, 0, T, 2);
        break;
      }
      case 'K': { // key: glowing
        const r = 12;
        g.fillStyle = '#ffd166';
        g.beginPath(); g.arc(T / 2, T / 2 - 2, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff3c9';
        g.beginPath(); g.arc(T / 2, T / 2 - 2, 7, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffd166';
        g.fillRect(T / 2 - 2.5, T / 2 + 4, 5, 10);
        g.fillRect(T / 2 - 2.5, T / 2 + 12, 3, 4);
        g.fillRect(T / 2 + 1, T / 2 + 10, 3, 4);
        break;
      }
      case 'X': case 'Xon': { // checkpoint flag
        const on = type === 'Xon';
        g.fillStyle = '#1c2233';
        g.fillRect(0, T - 6, T, 6);
        g.fillStyle = '#5a6480';
        g.fillRect(4, 6, 5, T - 12);
        g.fillStyle = on ? '#4df0ff' : '#31405e';
        g.beginPath();
        g.moveTo(9, 8); g.lineTo(T - 6, 14); g.lineTo(9, 20);
        g.closePath(); g.fill();
        g.fillStyle = on ? '#bffaff' : '#55678c';
        g.fillRect(6, 6, 3, 4);
        break;
      }
      case 'G': { // goal portal: ring
        g.fillStyle = 'rgba(109,255,158,.2)';
        g.beginPath(); g.arc(T / 2, T / 2, 13, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#6dff9e';
        g.lineWidth = 4;
        g.beginPath(); g.arc(T / 2, T / 2, 9, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = '#d8ffe8';
        g.lineWidth = 1.5;
        g.beginPath(); g.arc(T / 2, T / 2, 9, 0, Math.PI * 2); g.stroke();
        g.fillStyle = 'rgba(109,255,158,.5)';
        g.beginPath(); g.arc(T / 2, T / 2, 4, 0, Math.PI * 2); g.fill();
        break;
      }
    }
    this.cache[key] = c;
    return c;
  },
};

/* ============================================================================
   7. PARTICLES — pooled, cheap, additive-blended
   ========================================================================== */
class ParticleSystem {
  constructor(cap) {
    this.cap = cap || CFG.PARTICLE_CAP;
    this.pool = [];
    this.active = [];
    this.enabled = true;
  }

  spawn(o) {
    if (!this.enabled) return;
    if (this.pool.length) {
      const p = this.pool.pop();
      Object.assign(p, o);
      p.life = o.life; p.maxLife = o.life;
      this.active.push(p);
    } else if (this.active.length < this.cap) {
      const p = Object.assign({}, o);
      p.life = o.life; p.maxLife = o.life;
      this.active.push(p);
    }
  }

  update(dt) {
    const g = { x: 0, y: 500 }; // particles fall with the world's "feel" gravity
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.pool.push(p);
        this.active.splice(i, 1);
        continue;
      }
      p.vx += g.x * p.grav * dt;
      p.vy += g.y * p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
  }

  /** burst helpers */
  burst(x, y, color, n, speed, opts) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = Utils.rand(speed * 0.3, speed);
      this.spawn(Object.assign({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        size: Utils.rand(2, 5), color, life: Utils.rand(0.3, 0.7),
        grav: opts && opts.grav !== undefined ? opts.grav : 0.9,
        rot: Math.random() * 6.28, vr: Utils.rand(-8, 8), shape: opts && opts.shape || 'rect',
      }, opts));
    }
  }

  sparks(x, y, color, n, dirX, dirY, spread) {
    for (let i = 0; i < n; i++) {
      const s = Utils.rand(40, 320);
      const a = Math.atan2(dirY, dirX) + Utils.rand(-spread, spread);
      this.spawn({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        size: Utils.rand(1.5, 3), color, life: Utils.rand(0.2, 0.5),
        grav: 0.15, rot: 0, vr: 0, shape: 'rect',
      });
    }
  }

  ring(x, y, color, r0, r1) {
    this.spawn({ x, y, vx: 0, vy: 0, size: r0, target: r1, color, life: 0.5, grav: 0, shape: 'ring' });
  }

  draw(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.active) {
      const t = p.life / p.maxLife;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.fillStyle = p.color;
      if (p.shape === 'ring') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2 + t * 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Utils.lerp(p.size, p.target, 1 - t), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        const s = p.size * (0.4 + 0.6 * t);
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  clear() { this.active.length = 0; }
}

/* ============================================================================
   8. ENTITIES
   ========================================================================== */

/** AABB helper for solid bodies */
class Body {
  constructor(x, y, w, h) {
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.vx = 0; this.vy = 0;
  }
  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }
  get right() { return this.x + this.w; }
  get bottom() { return this.y + this.h; }
}

/** Moving platform — patrols horizontally (M) or vertically (V), bounces off walls */
class MovingPlatform extends Body {
  constructor(x, y, axis, range) {
    super(x, y, CFG.TILE, CFG.TILE);
    this.axis = axis;            // 'x' | 'y'
    this.speed = axis === 'x' ? 62 : 58;
    this.range = range || 5;     // tiles of travel from spawn
    this.originX = x; this.originY = y;
    this.dir = 1;
    this.carry = { x: 0, y: 0 };
    this.solid = true;
  }
  update(dt, world) {
    const prevX = this.x, prevY = this.y;
    if (this.axis === 'x') {
      this.x += this.speed * this.dir * dt;
      if (Math.abs(this.x - this.originX) >= this.range * CFG.TILE) this.dir *= -1;
      if (world.solidAt(this.x + (this.dir > 0 ? this.w : -2), this.y, this.w, this.h)) {
        this.dir *= -1;
        this.x = prevX;
      }
    } else {
      this.y += this.speed * this.dir * dt;
      if (Math.abs(this.y - this.originY) >= this.range * CFG.TILE) this.dir *= -1;
      if (world.solidAt(this.x, this.y + (this.dir > 0 ? this.h : -2), this.w, this.h)) {
        this.dir *= -1;
        this.y = prevY;
      }
    }
    this.carry.x = this.x - prevX;
    this.carry.y = this.y - prevY;
  }
  draw(ctx, t) {
    ctx.drawImage(Sprites.tile(this.axis === 'x' ? 'M' : 'V'), this.x, this.y);
    // thruster pulse
    const pulse = 0.5 + 0.5 * Math.sin(t * 8 + this.x);
    ctx.globalAlpha = 0.25 + pulse * 0.3;
    ctx.fillStyle = '#4df0ff';
    const bx = this.axis === 'x' ? (this.dir > 0 ? this.x + this.w : this.x - 6) : this.x + 12;
    const by = this.axis === 'x' ? this.y + 10 : (this.dir > 0 ? this.y + this.h : this.y - 6);
    ctx.beginPath();
    ctx.arc(bx, by, 3 + pulse * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** Falling block — drops with gravity when the player gets close; respawns */
class FallingBlock extends Body {
  constructor(x, y) {
    super(x, y, CFG.TILE, CFG.TILE);
    this.ox = x; this.oy = y;
    this.state = 'idle';        // idle | warn | fall | rest
    this.timer = 0;
    this.gravity = 2100;
    this.maxFall = 620;
    this.respawn = 1.4;
    this.solid = true;
  }
  update(dt, world) {
    this.timer -= dt;
    switch (this.state) {
      case 'idle': {
        const d = world.playerDist(this);
        if (d < 2.4 * CFG.TILE) {
          this.state = 'warn';
          this.timer = 0.3;
        }
        break;
      }
      case 'warn':
        if (this.timer <= 0) { this.state = 'fall'; }
        break;
      case 'fall': {
        // falls along world gravity
        const gx = world.gravity.x, gy = world.gravity.y;
        this.vx += gx * this.gravity * dt;
        this.vy += gy * this.gravity * dt;
        const sp = Math.hypot(this.vx, this.vy);
        if (sp > this.maxFall) { this.vx *= this.maxFall / sp; this.vy *= this.maxFall / sp; }
        this.x += this.vx * dt;
        this.y += this.vy * dt;
        // landing check: solid tile contact in gravity direction
        const hit = world.solidAt(this.x + this.vx * 0.02, this.y + this.vy * 0.02, this.w, this.h);
        const off = world.outOfBounds(this);
        if (hit || off) {
          this.state = 'rest';
          this.timer = this.respawn;
          if (world.fx.onBlockLand) world.fx.onBlockLand(this.cx, this.cy);
          this.vx = this.vy = 0;
          // snap back out of the tile (leading edge to the tile face)
          if (hit && !off) {
            if (Math.abs(gy) > 0.5) {
              this.y = this.vy > 0 ? Math.floor((this.y + this.h - 0.01) / 32) * 32 - this.h
                                   : (Math.floor(this.y / 32) + 1) * 32;
            } else {
              this.x = this.vx > 0 ? Math.floor((this.x + this.w - 0.01) / 32) * 32 - this.w
                                   : (Math.floor(this.x / 32) + 1) * 32;
            }
          }
        }
        break;
      }
      case 'rest':
        if (this.timer <= 0) {
          this.x = this.ox; this.y = this.oy;
          this.vx = this.vy = 0;
          this.state = 'idle';
        }
        break;
    }
  }
  draw(ctx, t) {
    if (this.state === 'rest') {
      const blink = Math.sin(this.timer * 14) > -0.2;
      if (!blink) return;
    }
    ctx.drawImage(Sprites.tile('F'), this.x, this.y);
    if (this.state === 'warn') {
      const a = 0.35 + 0.35 * Math.sin(t * 40);
      ctx.fillStyle = `rgba(255,159,67,${a})`;
      ctx.fillRect(this.x, this.y, this.w, this.h);
    }
  }
}

/** Crusher — timed block that slams down to the floor, kills on contact */
class Crusher extends Body {
  constructor(x, y) {
    super(x, y, CFG.TILE, CFG.TILE);
    this.baseY = y;                 // rest position (up)
    this.state = 'idle';            // idle | warn | extend | hold | retract
    this.timer = 0;
    this.extendSpeed = 130;         // px/s
    this.maxExtend = 6 * CFG.TILE;  // up to 6 tiles down
    this.solid = false;
    this.deadly = false;
    this.phase = Math.random() * 1.5; // desync multiple crushers
  }
  update(dt, world) {
    this.timer -= dt;
    switch (this.state) {
      case 'idle':
        if (this.timer <= 0) { this.state = 'warn'; this.timer = 0.55; }
        break;
      case 'warn':
        if (this.timer <= 0) { this.state = 'extend'; if (world.fx.onCrusherWarn) world.fx.onCrusherWarn(this.cx, this.baseY + 20); }
        break;
      case 'extend': {
        const target = this.baseY + this.maxExtend;
        this.y += this.extendSpeed * dt;
        if (this.y >= target) { this.y = target; this.state = 'hold'; this.timer = 0.45; if (world.fx.onCrusherHit) world.fx.onCrusherHit(this.cx, this.y + this.h); }
        break;
      }
      case 'hold':
        if (this.timer <= 0) { this.state = 'retract'; }
        break;
      case 'retract': {
        this.y -= this.extendSpeed * 0.9 * dt;
        if (this.y <= this.baseY) { this.y = this.baseY; this.state = 'idle'; this.timer = 1.6 + this.phase * 0.4; }
        break;
      }
    }
  }
  draw(ctx, t) {
    ctx.drawImage(Sprites.tile('C'), this.x, this.y);
    if (this.state === 'warn') {
      const a = 0.4 + 0.4 * Math.sin(t * 36);
      ctx.fillStyle = `rgba(255,77,109,${a})`;
      ctx.fillRect(this.x, this.y, this.w, this.h);
    }
  }
}

/** Laser emitter — fires a beam until a solid tile / door / map edge */
class Laser {
  constructor(x, y, dir) {
    this.x = x; this.y = y;
    this.dir = dir;                       // {x, y} unit
    this.beam = [];                       // [{x,y} cells]
    this.solid = false;
    this.t = Math.random() * 10;
  }
  update(world) {
    this.beam.length = 0;
    let cx = this.x + this.dir.x, cy = this.y + this.dir.y;
    for (let i = 0; i < 64; i++) {
      const ch = world.tileAt(cx, cy);
      if (ch === null || world.isSolidChar(ch) || ch === 'D' || ch === 'd') break;
      this.beam.push({ x: cx, y: cy });
      cx += this.dir.x; cy += this.dir.y;
    }
    this.t += 0.016;
  }
  draw(ctx, t) {
    const T = CFG.TILE;
    ctx.drawImage(Sprites.tile(this.dir.x ? 'laserH' : 'laserV'), this.x * T, this.y * T);
    if (!this.beam.length) return;
    // animated beam
    const x0 = this.x * T + T / 2, y0 = this.y * T + T / 2;
    const last = this.beam[this.beam.length - 1];
    const x1 = last.x * T + T / 2, y1 = last.y * T + T / 2;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(255,77,109,.95)');
    grad.addColorStop(1, 'rgba(255,77,109,.55)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,220,230,.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    // dashes flowing along the beam
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 2.5;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const dash = (t * 260) % 28;
    ctx.setLineDash([10, 18]);
    ctx.lineDashOffset = -dash;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.restore();
  }
}

/** Switch — sticky ON button that toggles doors + toggle platforms */
class Switch {
  constructor(x, y) {
    this.x = x; this.y = y;      // tile coords
    this.on = false;
    this.cooldown = 0;
    this.solid = false;
    this.t = Math.random() * 6;
  }
  get cx() { return this.x * CFG.TILE + CFG.TILE / 2; }
  get cy() { return this.y * CFG.TILE + CFG.TILE / 2; }
  update(dt, world) {
    this.cooldown -= dt;
    this.t += dt;
    if (this.cooldown <= 0 && world.playerOverlapsTile(this.x, this.y)) {
      this.on = true;
      this.cooldown = 0.5;
      world.onSwitchPressed(this);
    }
  }
  draw(ctx, t) {
    ctx.drawImage(Sprites.tile(this.on ? 'Son' : 'S'), this.x * CFG.TILE, this.y * CFG.TILE);
    if (this.on) {
      ctx.drawImage(Sprites.glow('rgba(140,255,120,.5)', 40), this.cx - 40, this.cy - 40);
    }
  }
}

/** Door — blocks when closed; opens with a key or when the switch is on */
class Door {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.open = false;
    this.anim = 0;      // 0 closed → 1 open
    this.solid = false;
  }
  update(dt, world) {
    // open if switch is on (global state) or unlocked by key
    if (world.switchOn || this.unlocked) {
      this.open = true;
    }
    if (!this.open && world.playerKeys > 0 && world.playerOverlapsTile(this.x, this.y)) {
      world.playerKeys--;
      this.unlocked = true;
      this.open = true;
      if (world.fx.onDoor) world.fx.onDoor(this);
    }
    this.anim = Utils.damp(this.anim, this.open ? 1 : 0, 12, dt);
    // sync tile solidity ('D' = closed solid, 'd' = open passable)
    world.tiles[this.y][this.x] = this.open ? 'd' : 'D';
  }
  draw(ctx, t) {
    const T = CFG.TILE;
    const slide = (1 - this.anim) * T;
    ctx.save();
    ctx.drawImage(Sprites.tile(this.open ? 'Dopen' : 'D'), this.x * T, this.y * T - slide);
    ctx.restore();
  }
}

/** Key — collectible */
class Key {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.taken = false;
    this.t = Math.random() * 6;
  }
  get cx() { return this.x * CFG.TILE + CFG.TILE / 2; }
  get cy() { return this.y * CFG.TILE + CFG.TILE / 2; }
  update(dt, world) {
    this.t += dt;
    if (this.taken) return;
    if (world.playerOverlapsTile(this.x, this.y)) {
      this.taken = true;
      world.playerKeys++;
      if (world.fx.onKey) world.fx.onKey(this);
    }
  }
  draw(ctx, t) {
    if (this.taken) return;
    const bob = Math.sin(this.t * 3) * 4;
    ctx.drawImage(Sprites.glow('rgba(255,209,102,.5)', 36), this.cx - 36, this.cy - 36 + bob);
    ctx.drawImage(Sprites.tile('K'), this.cx - CFG.TILE / 2, this.cy - CFG.TILE / 2 + bob);
  }
}

/** Checkpoint */
class Checkpoint {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.active = false;
    this.t = Math.random() * 6;
  }
  get cx() { return this.x * CFG.TILE + CFG.TILE / 2; }
  get cy() { return this.y * CFG.TILE + CFG.TILE / 2; }
  update(dt, world) {
    this.t += dt;
    if (!this.active && world.playerOverlapsTile(this.x, this.y)) {
      this.active = true;
      if (world.fx.onCheckpoint) world.fx.onCheckpoint(this);
    }
  }
  draw(ctx, t) {
    ctx.drawImage(Sprites.tile(this.active ? 'Xon' : 'X'), this.x * CFG.TILE, this.y * CFG.TILE);
    if (this.active) {
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 5);
      ctx.drawImage(Sprites.glow('rgba(77,240,255,.45)', 44), this.cx - 44, this.cy - 44 + 16 * pulse);
    }
  }
}

/** Goal portal */
class Goal {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.t = Math.random() * 6;
  }
  get cx() { return this.x * CFG.TILE + CFG.TILE / 2; }
  get cy() { return this.y * CFG.TILE + CFG.TILE / 2; }
  update(dt) { this.t += dt; }
  draw(ctx, t) {
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4);
    ctx.drawImage(Sprites.glow('rgba(109,255,158,.55)', 64), this.cx - 64, this.cy - 64);
    ctx.save();
    ctx.translate(this.cx, this.cy);
    ctx.scale(1 + pulse * 0.12, 1 + pulse * 0.12);
    ctx.drawImage(Sprites.tile('G'), -CFG.TILE / 2, -CFG.TILE / 2);
    ctx.restore();
  }
}
/* ============================================================================
   9. ENGINE — the pure game-logic world (no DOM, no canvas)
   ========================================================================== */
class Engine {
  constructor(levelIdx, fx) {
    this.fx = fx || {};                 // callbacks: onDeath, onCheckpoint, onKey,
                                        // onDoor, onSwitch, onGoal, onRespawn, onBlockLand,
                                        // onCrusherWarn, onCrusherHit, onGravity, onComplete
    this.levelIdx = levelIdx;
    this.map = LEVELS[levelIdx].map;
    this.H = this.map.length;
    this.W = this.map[0].length;
    this.gravity = { x: 0, y: 1 };      // unit vector
    this.gravAngle = 0;                 // visual rotation (radians)
    this.spin = 0;                      // 0..1 spin animation progress
    this.spinFrom = 0; this.spinTo = 0;
    this.gravCooldown = 0;

    this.tiles = [];                    // ['#','.','D',...] — mutable overlay
    for (let y = 0; y < this.H; y++) this.tiles.push(this.map[y].split(''));

    this.entities = [];
    this.movers = [];                   // moving platforms (for carrying)
    this.deadlyBodies = [];             // crushers + falling blocks (contact rules)
    this.lasers = [];
    this.switches = [];
    this.doors = [];
    this.keys = [];
    this.checkpoints = [];
    this.goal = null;
    this.spawnPoint = null;
    this.respawnPoint = null;

    this.time = 0;
    this.deaths = 0;
    this.running = true;
    this.completed = false;
    this.dying = false;
    this.deathTimer = 0;
    this.keyLock = 0;

    this.switchOn = false;
    this.playerKeys = 0;

    this._parse();
    this.player = this._makePlayer(this.spawnPoint.x, this.spawnPoint.y);
    this.respawnPoint = { x: this.spawnPoint.x, y: this.spawnPoint.y };
    this.solidCache = null;
  }

  /* ---------------- map parsing ---------------- */
  _parse() {
    const T = CFG.TILE;
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const ch = this.map[y][x];
        const px = x * T, py = y * T;
        switch (ch) {
          case 'P': this.spawnPoint = { x, y }; this.tiles[y][x] = '.'; break;
          case 'G': this.goal = new Goal(x, y); this.tiles[y][x] = '.'; break;
          case 'X': this.checkpoints.push(new Checkpoint(x, y)); this.tiles[y][x] = '.'; break;
          case 'K': this.keys.push(new Key(x, y)); this.tiles[y][x] = '.'; break;
          case 'D': this.doors.push(new Door(x, y)); this.tiles[y][x] = 'D'; break;
          case 'S': this.switches.push(new Switch(x, y)); this.tiles[y][x] = '.'; break;
          case 't': this.tiles[y][x] = 't'; break;
          case 'M': this.movers.push(new MovingPlatform(px, py, 'x')); this.tiles[y][x] = '.'; break;
          case 'V': this.movers.push(new MovingPlatform(px, py, 'y')); this.tiles[y][x] = '.'; break;
          case 'F': {
            const f = new FallingBlock(px, py);
            this.entities.push(f); this.deadlyBodies.push(f);
            this.tiles[y][x] = '.';
            break;
          }
          case 'C': {
            const c = new Crusher(px, py);
            this.entities.push(c); this.deadlyBodies.push(c);
            this.tiles[y][x] = '.';
            break;
          }
          case '>': this.lasers.push(new Laser(x, y, { x: 1, y: 0 })); this.tiles[y][x] = '.'; break;
          case '<': this.lasers.push(new Laser(x, y, { x: -1, y: 0 })); this.tiles[y][x] = '.'; break;
          case '^': this.lasers.push(new Laser(x, y, { x: 0, y: -1 })); this.tiles[y][x] = '.'; break;
          case 'v': this.lasers.push(new Laser(x, y, { x: 0, y: 1 })); this.tiles[y][x] = '.'; break;
          default: break; // '#', '=', '-', '*', '.' stay as-is
        }
      }
    }
    if (!this.spawnPoint) throw new Error('Level has no spawn point');
    if (!this.goal) throw new Error('Level has no goal');
  }

  _makePlayer(tx, ty) {
    const T = CFG.TILE;
    const w = 22, h = 28;
    return {
      x: tx * T + (T - w) / 2, y: ty * T + (T - h) / 2,
      w, h, vx: 0, vy: 0,
      onGround: false, coyote: 0, jumpBuffer: 0,
      angle: 0, prevAngle: 0,
      walking: false, walkT: 0,
      onPlatform: null,
      dead: false,
    };
  }

  /* ---------------- helpers ---------------- */
  tileAt(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.W || ty >= this.H) return null;
    return this.tiles[ty][tx];
  }
  isSolidChar(ch) { return ch === '#' || ch === '=' || ch === 't' || ch === 'T' || ch === 'D'; }
  solidAt(x, y, w, h) {
    // true if the AABB overlaps any solid tile (walls, blocks, toggle-on)
    const x0 = Math.floor(x / CFG.TILE), x1 = Math.floor((x + w - 0.01) / CFG.TILE);
    const y0 = Math.floor(y / CFG.TILE), y1 = Math.floor((y + h - 0.01) / CFG.TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const ch = this.tileAt(tx, ty);
        if (ch === null) return true; // out of bounds counts as solid
        if (this.isSolidChar(ch)) return true;
      }
    }
    return false;
  }
  outOfBounds(b) {
    return b.right < -CFG.TILE || b.x > this.W * CFG.TILE ||
           b.bottom < -CFG.TILE || b.y > this.H * CFG.TILE + CFG.TILE * 2;
  }
  playerDist(b) {
    const p = this.player;
    const dx = Math.max(b.x - p.right, p.x - b.right, 0);
    const dy = Math.max(b.y - p.bottom, p.y - b.bottom, 0);
    return Math.hypot(dx, dy);
  }
  playerOverlapsTile(tx, ty) {
    const p = this.player;
    const x = tx * CFG.TILE, y = ty * CFG.TILE;
    return Utils.overlap(p.x, p.y, p.w, p.h, x, y, CFG.TILE, CFG.TILE);
  }
  /** AABB vs tile grid — returns contact info */
  collideRect(x, y, w, h, vx, vy) {
    // returns {x, y, hits:{left,right,top,bottom}, oneWay}
    const out = { x, y, hits: { left: false, right: false, top: false, bottom: false }, oneWay: null };
    // --- X axis ---
    let nx = x + vx;
    const x0 = Math.floor(nx / CFG.TILE), x1 = Math.floor((nx + w - 0.01) / CFG.TILE);
    const y0 = Math.floor(y / CFG.TILE), y1 = Math.floor((y + h - 0.01) / CFG.TILE);
    if (vx > 0) {
      // moving right: find the leftmost solid column overlapping the body
      for (let tx = x0; tx <= x1; tx++) {
        let solid = false;
        for (let ty = y0; ty <= y1 && !solid; ty++) {
          const ch = this.tileAt(tx, ty);
          if (ch !== null && this.isSolidChar(ch)) solid = true;
        }
        if (solid) { nx = tx * CFG.TILE - w; out.hits.right = true; break; }
      }
    } else if (vx < 0) {
      // moving left: find the rightmost solid column overlapping the body
      for (let tx = x1; tx >= x0; tx--) {
        let solid = false;
        for (let ty = y0; ty <= y1 && !solid; ty++) {
          const ch = this.tileAt(tx, ty);
          if (ch !== null && this.isSolidChar(ch)) solid = true;
        }
        if (solid) { nx = (tx + 1) * CFG.TILE; out.hits.left = true; break; }
      }
    }
    // --- Y axis ---
    let ny = y + vy;
    const yA0 = Math.floor(ny / CFG.TILE), yA1 = Math.floor((ny + h - 0.01) / CFG.TILE);
    const xA0 = Math.floor(nx / CFG.TILE), xA1 = Math.floor((nx + w - 0.01) / CFG.TILE);
    // collect the solid rows + valid one-way rows in the sweep
    const solidRows = [];
    let oneWayRow = -1;
    for (let ty = yA0; ty <= yA1; ty++) {
      let solid = false, oneWay = false;
      for (let tx = xA0; tx <= xA1; tx++) {
        const ch = this.tileAt(tx, ty);
        if (ch === null || ch === '#') { solid = true; break; }
        if (ch === '=' || ch === 't' || ch === 'T' || ch === 'D') { solid = true; break; }
        if (ch === '-') {
          const n = { x: -this.gravity.x, y: -this.gravity.y };
          const pCenter = { x: nx + w / 2, y: ny + h / 2 };
          const tCenter = { x: tx * CFG.TILE + CFG.TILE / 2, y: ty * CFG.TILE + CFG.TILE / 2 };
          const side = (pCenter.x - tCenter.x) * n.x + (pCenter.y - tCenter.y) * n.y;
          const approach = (vy * n.y + vx * n.x);
          if (side > 2 && approach <= 0.001) oneWay = true;
        }
      }
      if (solid) solidRows.push(ty);
      else if (oneWay) oneWayRow = ty;
    }
    if (vy > 0 && solidRows.length) {
      // falling: land on the highest solid row in the sweep
      const ty = solidRows[0];
      ny = ty * CFG.TILE - h;
      out.hits.bottom = true;
    } else if (vy < 0 && solidRows.length) {
      // rising: bonk on the lowest solid row
      const ty = solidRows[solidRows.length - 1];
      ny = (ty + 1) * CFG.TILE;
      out.hits.top = true;
    } else if (vy > 0 && oneWayRow >= 0) {
      ny = oneWayRow * CFG.TILE - h;
      out.hits.bottom = true;
      out.oneWay = true;
    } else if (vy < 0 && oneWayRow >= 0) {
      ny = (oneWayRow + 1) * CFG.TILE;
      out.hits.top = true;
      out.oneWay = true;
    }
    out.x = nx; out.y = ny;
    return out;
  }

  /* ---------------- gravity ---------------- */
  rotateGravity(cw) {
    if (this.gravCooldown > 0 || this.dying || this.completed) return false;
    const th = (cw ? 1 : -1) * Math.PI / 2;
    const g = Utils.rot(this.gravity.x, this.gravity.y, th);
    // snap to exact cardinal directions (avoids float drift)
    this.gravity.x = Math.abs(g.x) > 0.5 ? Math.sign(g.x) : 0;
    this.gravity.y = Math.abs(g.y) > 0.5 ? Math.sign(g.y) : 0;
    // rotate the player's velocity with the world (momentum is preserved)
    const v = Utils.rot(this.player.vx, this.player.vy, th);
    this.player.vx = v.x; this.player.vy = v.y;
    this.player.onGround = false;
    this.player.coyote = 0;
    // spin animation
    this.spinFrom = this.gravAngle;
    this.spinTo = Math.atan2(-g.x, g.y);
    this.spin = 0;
    this.gravCooldown = CFG.GRAV_COOLDOWN;
    if (this.fx.onGravity) this.fx.onGravity(cw);
    return true;
  }

  /* ---------------- main update ---------------- */
  update(dt, input) {
    if (!this.running) return;
    this.time += dt;
    this.gravCooldown -= dt;
    this.keyLock -= dt;
    if (this.dying) {
      this.deathTimer -= dt;
      this._updateDust(dt);
      if (this.deathTimer <= 0) this._respawn();
      return;
    }
    if (this.completed) return;

    this._updatePlayer(dt, input);
    this._updateEntities(dt);
    this._updateSwitches(dt);
    this._updateLasers();
    this._checkHazards();
    this._checkPickups(dt);
    this._checkGoal();

    // spin animation progress
    if (this.spin < 1) this.spin = Math.min(1, this.spin + dt / CFG.ROTATE_SPIN);
  }

  _updateDust(dt) { /* particles handled by the renderer via fx */ }

  _updatePlayer(dt, input) {
    const p = this.player;
    if (!p || p.dead) return;

    // --- input axes (relative to gravity: walk along the floor) ---
    let move = 0;
    if (input) {
      if (input.left) move -= 1;
      if (input.right) move += 1;
      if (input.joy) move = input.joy.x;
    }
    const right = Utils.rot(this.gravity.x, this.gravity.y, -Math.PI / 2);
    const accel = p.onGround ? CFG.ACCEL : CFG.AIR_ACCEL;
    // accelerate only along the walk axis (never touch the gravity-axis
    // component — otherwise air control would eat jumps)
    const along = p.vx * right.x + p.vy * right.y;
    const newAlong = Utils.damp(along, move * CFG.MOVE_SPEED, accel / CFG.MOVE_SPEED, dt);
    const dAlong = newAlong - along;
    p.vx += right.x * dAlong;
    p.vy += right.y * dAlong;

    // --- friction on ground (only when not pushing the stick) ---
    if (p.onGround && move === 0) {
      const fr = CFG.FRICTION;
      p.vx = Utils.damp(p.vx, 0, fr / CFG.MOVE_SPEED, dt);
      p.vy = Utils.damp(p.vy, 0, fr / CFG.MOVE_SPEED, dt);
    }

    // --- jump ---
    p.coyote -= dt;
    p.jumpBuffer -= dt;
    if (input && input.jump) p.jumpBuffer = CFG.JUMP_BUFFER;
    if (p.jumpBuffer > 0 && p.coyote > 0) {
      p.vx -= this.gravity.x * CFG.JUMP_VEL;
      p.vy -= this.gravity.y * CFG.JUMP_VEL;
      p.jumpBuffer = 0;
      p.coyote = 0;
      p.onGround = false;
      if (this.fx.onJump) this.fx.onJump();
    }
    // variable jump: release early → cut upward velocity
    if (input && !input.jumpHeld && p.jumpBuffer <= 0) {
      const along = p.vx * this.gravity.x + p.vy * this.gravity.y; // velocity along gravity
      if (along < -80) {
        p.vx -= this.gravity.x * along * CFG.JUMP_CUT;
        p.vy -= this.gravity.y * along * CFG.JUMP_CUT;
      }
    }

    // --- gravity ---
    if (this.levelIdx === 5 && p.x > 400 && p.vy > -50 && p.vy < 50) {
      console.log(`  ENGINE: f=${this.time.toFixed(2)} x=${(p.x/32).toFixed(2)} y=${(p.y/32).toFixed(2)} vy=${p.vy.toFixed(0)} onG=${p.onGround} jbuf=${p.jumpBuffer.toFixed(2)}`);
    }
    p.vx += this.gravity.x * CFG.GRAVITY * dt;
    p.vy += this.gravity.y * CFG.GRAVITY * dt;
    const sp = Math.hypot(p.vx, p.vy);
    if (sp > CFG.MAX_FALL) { p.vx *= CFG.MAX_FALL / sp; p.vy *= CFG.MAX_FALL / sp; }
    // --- carried by moving platform ---
    if (p.onPlatform) {
      p.x += p.onPlatform.carry.x;
      p.y += p.onPlatform.carry.y;
    }

    // --- integrate + collide (X then Y) ---
    const wasGround = p.onGround;
    const stepX = this.collideRect(p.x, p.y, p.w, p.h, p.vx * dt, 0);
    p.x = stepX.x;
    const stepY = this.collideRect(p.x, p.y, p.w, p.h, 0, p.vy * dt);
    p.y = stepY.y;

    p.onGround = false;
    const hitY = stepY.hits.bottom || stepY.hits.top;
    const hitX = stepX.hits.left || stepX.hits.right;
    if (hitY) {
      // landed or bonked — check which side is toward gravity
      const towardGrav = (p.vy * this.gravity.y + p.vx * this.gravity.x) > 0;
      if (stepY.hits.bottom) {
        p.onGround = this.gravity.y >= 0.01;
        p.coyote = CFG.COYOTE_TIME;
        if (wasGround === false && p.onGround && !this.dying) { if (this.fx.onLand) this.fx.onLand(); }
      } else if (stepY.hits.top) {
        p.onGround = this.gravity.y <= -0.01;
        p.coyote = CFG.COYOTE_TIME;
      }
      p.vy = 0;
      void towardGrav;
    }
    if (hitX) {
      if (this.gravity.x >= 0.01 && stepX.hits.right) { p.onGround = true; p.coyote = CFG.COYOTE_TIME; }
      else if (this.gravity.x <= -0.01 && stepX.hits.left) { p.onGround = true; p.coyote = CFG.COYOTE_TIME; }
      p.vx = 0;
    }

    // standing on a moving platform?
    p.onPlatform = null;
    for (const m of this.movers) {
      const standOn = Utils.overlap(p.x + 2, p.y + p.h - 2, p.w - 4, 4, m.x, m.y, m.w, m.h) &&
                      p.y + p.h <= m.y + 6;
      if (standOn) { p.onPlatform = m; break; }
    }

    // animation state
    const moveMag = Math.abs(move);
    p.walking = moveMag > 0.01 && p.onGround;
    if (p.walking) p.walkT += dt * (8 + moveMag * 6);
    p.prevAngle = p.angle;
    p.angle = Math.atan2(-this.gravity.x, this.gravity.y);

    // died by falling into the void?
    if (this.outOfBounds(p)) this._kill('void');
  }

  _updateEntities(dt) {
    for (const e of this.entities) e.update(dt, this);
    for (const m of this.movers) m.update(dt, this);
  }

  _updateSwitches(dt) {
    for (const s of this.switches) s.update(dt, this);
  }

  onSwitchPressed(s) {
    this.switchOn = true;
    // doors open (their update reads switchOn); toggle tiles become solid
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        if (this.tiles[y][x] === 't') this.tiles[y][x] = 'T'; // T = solid version
      }
    }
    if (this.fx.onSwitch) this.fx.onSwitch(s);
  }

  _updateLasers() {
    for (const l of this.lasers) l.update(this);
  }

  _checkHazards() {
    const p = this.player;
    const inset = 5;
    const px = p.x + inset, py = p.y + inset, pw = p.w - inset * 2, ph = p.h - inset * 2;

    // spikes (tiles) — hitbox matches the drawn spikes (bottom ~55% of the tile)
    const tx0 = Math.floor(px / CFG.TILE), tx1 = Math.floor((px + pw) / CFG.TILE);
    const ty0 = Math.floor(py / CFG.TILE), ty1 = Math.floor((py + ph) / CFG.TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (this.tileAt(tx, ty) === '*' &&
            Utils.overlap(px, py, pw, ph, tx * CFG.TILE + 4, ty * CFG.TILE + 14, CFG.TILE - 8, CFG.TILE - 18)) {
          return this._kill('spike');
        }
      }
    }

    // laser beams (segment vs AABB)
    for (const l of this.lasers) {
      if (!l.beam.length) continue;
      const x0 = l.x * CFG.TILE + CFG.TILE / 2, y0 = l.y * CFG.TILE + CFG.TILE / 2;
      const last = l.beam[l.beam.length - 1];
      const x1 = last.x * CFG.TILE + CFG.TILE / 2, y1 = last.y * CFG.TILE + CFG.TILE / 2;
      if (Utils.segHitsRect(x0, y0, x1, y1, px, py, pw, ph) >= 0) return this._kill('laser');
    }

    // crushers — deadly when moving into the player
    for (const c of this.deadlyBodies) {
      if (!(c instanceof Crusher)) continue;
      if (!Utils.overlap(px, py, pw, ph, c.x, c.y, c.w, c.h)) continue;
      if (c.state === 'extend' || c.state === 'hold') return this._kill('crush');
      if (c.state === 'retract' && c.y > c.baseY + 4) return this._kill('crush');
    }

    // falling blocks — deadly when landing on the player
    for (const f of this.deadlyBodies) {
      if (!(f instanceof FallingBlock) || f.state !== 'fall') continue;
      if (!Utils.overlap(px, py, pw, ph, f.x, f.y, f.w, f.h)) continue;
      const speed = Math.hypot(f.vx, f.vy);
      if (speed > 90) return this._kill('block');
    }
  }

  _checkPickups(dt) {
    for (const k of this.keys) k.update(dt, this);
    for (const c of this.checkpoints) c.update(dt, this);
    for (const d of this.doors) d.update(dt, this);
  }

  _checkGoal() {
    if (this.goal && Utils.overlap(
      this.player.x, this.player.y, this.player.w, this.player.h,
      this.goal.x * CFG.TILE, this.goal.y * CFG.TILE, CFG.TILE, CFG.TILE)) {
      this.completed = true;
      if (this.fx.onComplete) this.fx.onComplete();
    }
  }

  /* ---------------- death & respawn ---------------- */
  _kill(cause) {
    const p = this.player;
    if (this.dying || this.completed) return;
    this.dying = true;
    this.deathTimer = 0.55;
    this.deaths++;
    p.dead = true;
    if (this.fx.onDeath) this.fx.onDeath(cause, p);
  }

  _respawn() {
    const p = this.player;
    const rp = this.respawnPoint;
    p.x = rp.x * CFG.TILE + (CFG.TILE - p.w) / 2;
    p.y = rp.y * CFG.TILE + (CFG.TILE - p.h) / 2;
    p.vx = 0; p.vy = 0;
    p.dead = false;
    p.onPlatform = null;
    this.dying = false;
    // reset entities to spawn state (doors/keys/switches keep their state)
    for (const e of this.entities) {
      if (e instanceof FallingBlock) { e.x = e.ox; e.y = e.oy; e.vx = e.vy = 0; e.state = 'idle'; e.timer = 0; }
      if (e instanceof Crusher) { e.y = e.baseY; e.state = 'idle'; e.timer = 1.2; }
    }
    for (const m of this.movers) { m.x = m.originX; m.y = m.originY; m.dir = 1; }
    if (this.fx.onRespawn) this.fx.onRespawn(p);
  }

  /** full restart (pause menu / R) */
  restart() {
    this.gravity = { x: 0, y: 1 };
    this.gravAngle = 0; this.spin = 1;
    this.player = this._makePlayer(this.spawnPoint.x, this.spawnPoint.y);
    this.respawnPoint = { x: this.spawnPoint.x, y: this.spawnPoint.y };
    this.switchOn = false;
    this.playerKeys = 0;
    this.time = 0;
    this.deaths = 0;
    this.dying = false; this.completed = false;
    this.tiles = [];
    for (let y = 0; y < this.H; y++) this.tiles.push(this.map[y].split(''));
    this.entities.length = 0;
    this.movers.length = 0;
    this.deadlyBodies.length = 0;
    this.lasers.length = 0;
    this.switches.length = 0;
    this.doors.length = 0;
    this.keys.length = 0;
    this.checkpoints.length = 0;
    this._parse();
  }
}
/* ============================================================================
   10. CAMERA — smooth follow + screen shake
   ========================================================================== */
class Camera {
  constructor() {
    this.x = 0; this.y = 0;
    this.shake = 0;
    this.shakeX = 0; this.shakeY = 0;
    this.enabled = true;
  }
  follow(target, viewW, viewH, worldW, worldH, dt) {
    const tx = target.x + target.w / 2 - viewW / 2;
    const ty = target.y + target.h / 2 - viewH / 2;
    this.x = Utils.damp(this.x, tx, 7, dt);
    this.y = Utils.damp(this.y, ty, 7, dt);
    // clamp to world (center small worlds)
    if (worldW <= viewW) this.x = (worldW - viewW) / 2;
    else this.x = Utils.clamp(this.x, 0, worldW - viewW);
    if (worldH <= viewH) this.y = (worldH - viewH) / 2;
    else this.y = Utils.clamp(this.y, 0, worldH - viewH);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.shakeX = (Math.random() * 2 - 1) * this.shake;
    this.shakeY = (Math.random() * 2 - 1) * this.shake;
  }
  addShake(amount) { if (this.enabled) this.shake = Math.min(14, this.shake + amount); }
}

/* ============================================================================
   11. RENDERER — draws the world (tiles, entities, particles, effects)
   ========================================================================== */
class Renderer {
  constructor(canvas, particles) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = particles;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = 0; this.h = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bgGrad = null;
    this.ambient = []; // floating dust motes
    for (let i = 0; i < 46; i++) {
      this.ambient.push({
        x: Math.random(), y: Math.random(),
        s: Utils.rand(0.5, 2.2), sp: Utils.rand(4, 18),
        ph: Math.random() * 6.28,
      });
    }
    this.t = 0;
  }

  resize() {
    this.w = this.canvas.clientWidth || window.innerWidth;
    this.h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.floor(this.w * this.dpr);
    this.canvas.height = Math.floor(this.h * this.dpr);
    const g = this.ctx;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const grad = g.createLinearGradient(0, 0, 0, this.h);
    grad.addColorStop(0, '#0a0d18');
    grad.addColorStop(0.55, '#0d1122');
    grad.addColorStop(1, '#0a0c16');
    this.bgGrad = grad;
  }

  /** rotate one angle toward another across the shortest arc */
  static lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  draw(world, camera) {
    const ctx = this.ctx;
    const T = CFG.TILE;
    this.t += 1 / 60;
    const t = this.t;

    ctx.fillStyle = this.bgGrad;
    ctx.fillRect(0, 0, this.w, this.h);

    // parallax grid
    ctx.strokeStyle = 'rgba(90,110,180,0.07)';
    ctx.lineWidth = 1;
    const gs = 64;
    const ox = (camera.x * 0.4) % gs, oy = (camera.y * 0.4) % gs;
    ctx.beginPath();
    for (let x = -ox; x < this.w; x += gs) { ctx.moveTo(x, 0); ctx.lineTo(x, this.h); }
    for (let y = -oy; y < this.h; y += gs) { ctx.moveTo(0, y); ctx.lineTo(this.w, y); }
    ctx.stroke();

    // ambient dust
    ctx.fillStyle = 'rgba(140,180,255,0.5)';
    for (const m of this.ambient) {
      const x = (m.x * this.w - camera.x * 0.15 * m.s) % this.w;
      const y = (m.y * this.h - camera.y * 0.15 * m.s) % this.h;
      const a = 0.3 + 0.3 * Math.sin(t * 0.8 + m.ph);
      ctx.globalAlpha = a * 0.5;
      ctx.fillRect(x, y, m.s, m.s);
    }
    ctx.globalAlpha = 1;

    // ---- world transform: camera + spin animation ----
    ctx.save();
    // spin: the world visibly rotates around the player when gravity flips
    let angle = 0;
    if (world.spin < 1) {
      const ease = Utils.easeOutCubic(world.spin);
      angle = Renderer.lerpAngle(world.spinFrom, world.spinTo, ease);
    } else {
      angle = Math.atan2(-world.gravity.x, world.gravity.y);
    }
    const pcx = world.player.x + world.player.w / 2 - camera.x;
    const pcy = world.player.y + world.player.h / 2 - camera.y;
    ctx.translate(pcx, pcy);
    ctx.rotate(angle);
    ctx.translate(-pcx, -pcy);
    ctx.translate(-camera.x + camera.shakeX, -camera.y + camera.shakeY);

    const viewX0 = camera.x - T, viewY0 = camera.y - T;
    const viewX1 = camera.x + this.w + T, viewY1 = camera.y + this.h + T;

    // ---- tiles ----
    const tx0 = Math.max(0, Math.floor(viewX0 / T));
    const ty0 = Math.max(0, Math.floor(viewY0 / T));
    const tx1 = Math.min(world.W - 1, Math.floor(viewX1 / T));
    const ty1 = Math.min(world.H - 1, Math.floor(viewY1 / T));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const ch = world.tiles[ty][tx];
        const spr = ch === '#' ? '#' : ch === '=' ? '=' : ch === '-' ? '-' :
                    ch === 't' ? 'tOff' : ch === 'T' ? 'tOn' : null;
        if (spr) ctx.drawImage(Sprites.tile(spr), tx * T, ty * T);
      }
    }

    // ---- doors (drawn by entity; but the tile char is 'D'/'d') ----
    // ---- entities ----
    for (const d of world.doors) d.draw(ctx, t);
    for (const m of world.movers) m.draw(ctx, t);
    for (const e of world.entities) e.draw(ctx, t);
    for (const s of world.switches) s.draw(ctx, t);
    for (const k of world.keys) k.draw(ctx, t);
    for (const c of world.checkpoints) c.draw(ctx, t);
    if (world.goal) world.goal.draw(ctx, t);
    for (const l of world.lasers) l.draw(ctx, t);

    // ---- player robot ----
    this._drawPlayer(world);

    // ---- particles ----
    this.particles.draw(ctx);

    ctx.restore();

    // vignette pulse on death
    if (world.dying) {
      const a = Math.min(0.8, (0.55 - world.deathTimer) * 3);
      ctx.fillStyle = `rgba(255,40,70,${a * 0.35})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
  }

  _drawPlayer(world) {
    const ctx = this.ctx;
    const p = world.player;
    const T = CFG.TILE;
    const t = this.t;

    const targetAngle = Math.atan2(-world.gravity.x, world.gravity.y);
    const a = Renderer.lerpAngle(p.prevAngle || targetAngle, targetAngle, 0.3);
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a);

    // facing: flip toward movement along the walk axis
    const right = Utils.rot(world.gravity.x, world.gravity.y, -Math.PI / 2);
    const facing = Math.sign(p.vx * right.x + p.vy * right.y) || 1;
    ctx.scale(facing === 0 ? 1 : facing, 1);

    // glow under the robot
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(Sprites.glow('rgba(77,240,255,.4)', 34), -34, -34);
    ctx.globalCompositeOperation = 'source-over';

    // legs / treads
    const step = p.walking ? Math.sin(p.walkT * 2.2) : 0;
    ctx.fillStyle = '#16303c';
    ctx.fillRect(-9, 5, 5, 6 + step * 2.4);
    ctx.fillRect(4, 5, 5, 6 - step * 2.4);
    ctx.fillStyle = '#1d3a48';
    ctx.fillRect(-10, 10, 20, 4);
    ctx.fillStyle = '#4df0ff';
    ctx.fillRect(-10, 13, 20, 1.5);

    // body
    const grad = ctx.createLinearGradient(0, -10, 0, 8);
    grad.addColorStop(0, '#e8fbff');
    grad.addColorStop(0.45, '#9ce9f5');
    grad.addColorStop(1, '#3d8ea6');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(-10, -10, 20, 19, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,60,80,.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // visor
    ctx.fillStyle = '#0a1e2a';
    ctx.beginPath();
    ctx.roundRect(-6, -6, 12, 7, 3);
    ctx.fill();
    ctx.fillStyle = '#7df4ff';
    ctx.beginPath();
    ctx.roundRect(-5, -5, 8 + Math.sin(t * 5) * 1.2, 4, 2);
    ctx.fill();

    // antenna
    ctx.strokeStyle = '#7de8f5';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(2, -10); ctx.lineTo(5, -15); ctx.stroke();
    ctx.fillStyle = '#ff9f43';
    ctx.beginPath(); ctx.arc(5, -16, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffe2b8';
    ctx.beginPath(); ctx.arc(4.2, -16.8, 1, 0, Math.PI * 2); ctx.fill();

    ctx.restore();

    // respawn blink
    if (world.dying) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#ff4d6d';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.restore();
    }
  }
}
/* ============================================================================
   12. GAME — state machine + DOM/UI wiring
   ========================================================================== */
class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.audio = new AudioManager();
    this.save = SaveManager.load();
    this.input = new InputManager();
    this.particles = new ParticleSystem();
    this.camera = new Camera();
    this.renderer = null;
    this.engine = null;

    this.state = 'menu';       // menu | levels | howto | settings | play | pause | complete | victory
    this.levelIdx = 0;
    this.runTime = 0;          // ms of current run
    this.runStarted = false;
    this.runDeaths = 0;
    this._hudDirty = true;
    this._lastHint = 0;
    this._deathFlashEl = null;

    this.accumulator = 0;
    this.lastFrame = 0;
    this._raf = null;
    this._booted = false;

    this.menuT = 0;
    this.menuParticles = new ParticleSystem(120);

    this._bindUI();
    this._bindKeyboardShortcuts();
    this._applySettings();
  }

  /* ================= boot / loop ================= */
  boot() {
    // roundRect fallback for older browsers
    if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
      CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        this.moveTo(x + r, y);
        this.arcTo(x + w, y, x + w, y + h, r);
        this.arcTo(x + w, y + h, x, y + h, r);
        this.arcTo(x, y + h, x, y, r);
        this.arcTo(x, y, x + w, y, r);
        this.closePath();
        return this;
      };
    }
    this.renderer = new Renderer(this.canvas, this.particles);
    // unlock audio on first interaction (autoplay policy)
    const unlock = () => { this.audio.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this._show('menu');
    this._updateMenuStats();
    this.lastFrame = performance.now();
    const loop = (now) => {
      this._frame(now);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    this._booted = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'play') this.pause();
    });
  }

  _frame(now) {
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > CFG.MAX_FRAME) dt = CFG.MAX_FRAME;

    if (this.state === 'menu' || this.state === 'levels' || this.state === 'howto' || this.state === 'settings' || this.state === 'victory') {
      this.menuT += dt;
      this.menuParticles.update(dt);
      // idle attract mode: a friendly AI drifts around level 1 behind the menu
      if (!this.engine || this._menuEngineTimer > 0) {
        if (!this.engine) {
          this.engine = new Engine(0, {});
          this.engine.update(0, null);
          this._menuEngineTimer = 0;
        } else {
          this._menuEngineTimer -= dt;
          if (this._menuEngineTimer <= 0) this.engine = new Engine(0, {});
        }
      }
      if (this.engine && !this.engine.dying && !this.engine.completed) {
        const p = this.engine.player;
        const goalX = this.engine.goal.cx;
        const inp = { left: p.x > goalX + 4, right: p.x < goalX - 4, jump: Math.random() < 0.03, joy: null, jumpHeld: true };
        this.engine.update(dt, inp);
        if (this.engine.completed) this._menuEngineTimer = 2.5;
      }
      const w = this.engine.W * CFG.TILE, h = this.engine.H * CFG.TILE;
      this.camera.follow(this.engine.player, this.renderer.w, this.renderer.h, w, h, dt);
      this.renderer.draw(this.engine, this.camera);
      this.menuParticles.draw(this.renderer.ctx);
      return;
    }

    if (this.state !== 'play' && this.state !== 'pause') {
      if (this.engine) this.renderer.draw(this.engine, this.camera);
      return;
    }

    if (this.state === 'play') {
      const inp = this.input.consume();
      if (inp.rotCW) this.engine.rotateGravity(true);
      if (inp.rotCCW) this.engine.rotateGravity(false);

      // timer starts on first input
      if (!this.runStarted) {
        if (inp.left || inp.right || inp.jump || inp.rotCW || inp.rotCCW || inp.joy) {
          this.runStarted = true;
          this._hudDirty = true;
        }
      }
      if (this.runStarted) this.runTime += dt * 1000;

      // fixed timestep physics
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= CFG.STEP && steps < 8) {
        this.engine.update(CFG.STEP, inp);
        this.accumulator -= CFG.STEP;
        steps++;
      }
      if (steps === 8) this.accumulator = 0;

      this.camera.follow(this.engine.player, this.renderer.w, this.renderer.h,
        this.engine.W * CFG.TILE, this.engine.H * CFG.TILE, dt);
      this.particles.update(dt);
      this.renderer.draw(this.engine, this.camera);
      this._updateHUD();
      this._updateTouchArrows();
    } else {
      // paused: keep rendering the frozen scene
      this.renderer.draw(this.engine, this.camera);
    }
  }

  /* ================= FX hooks (engine → audio/particles) ================= */
  _fx() {
    const self = this;
    return {
      onJump() { self.audio.sfxJump(); },
      onLand() { self.audio.sfxLand(); self.camera.addShake(0.6); },
      onGravity(cw) { self.audio.sfxGravity(cw ? 1 : -1); self.camera.addShake(1.4); },
      onDeath(cause, p) {
        self.audio.sfxDeath();
        self.camera.addShake(9);
        self.particles.burst(p.x + p.w / 2, p.y + p.h / 2, '#ff4d6d', 26, 320);
        self.particles.burst(p.x + p.w / 2, p.y + p.h / 2, '#ffd166', 12, 200);
        self.runDeaths++;
        self._flashDeath();
        self._hudDirty = true;
      },
      onRespawn() { self.audio.sfxRespawn(); self.particles.ring(self.engine.player.x + 11, self.engine.player.y + 14, '#4df0ff', 6, 40); },
      onCheckpoint(cp) {
        self.audio.sfxCheckpoint();
        self.camera.addShake(2.5);
        self.particles.ring(cp.cx, cp.cy, '#4df0ff', 8, 46);
        self.particles.burst(cp.cx, cp.cy, '#4df0ff', 14, 160);
        self.engine.respawnPoint = { x: cp.x, y: cp.y };
        self._hudDirty = true;
      },
      onKey(k) {
        self.audio.sfxKey();
        self.particles.burst(k.cx, k.cy, '#ffd166', 18, 220);
        self.particles.ring(k.cx, k.cy, '#ffd166', 6, 40);
        self._hudDirty = true;
      },
      onDoor(d) {
        self.audio.sfxDoor();
        const dx = d.x * CFG.TILE + CFG.TILE / 2, dy = d.y * CFG.TILE + CFG.TILE / 2;
        self.particles.burst(dx, dy, '#ff9f43', 14, 160);
      },
      onSwitch(s) {
        self.audio.sfxSwitch(true);
        self.particles.burst(s.cx, s.cy - 10, '#a8e86e', 16, 180);
        self.particles.ring(s.cx, s.cy - 10, '#a8e86e', 6, 42);
      },
      onBlockLand(x, y) {
        self.audio.sfxBlockDrop();
        self.camera.addShake(2.5);
        self.particles.burst(x, y, '#8a623f', 12, 200);
      },
      onCrusherWarn(x, y) {
        self.particles.sparks(x, y, '#ff9f43', 3, 0, 1, 0.4);
      },
      onCrusherHit(x, y) {
        self.audio.sfxCrush();
        self.camera.addShake(6);
        self.particles.burst(x, y, '#ff9f43', 18, 300, { grav: 1.6 });
        self.particles.burst(x, y, '#c8ccd8', 10, 220);
      },
      onComplete() {
        self.audio.sfxVictory();
        self.camera.addShake(5);
        const g = self.engine.goal;
        self.particles.burst(g.cx, g.cy, '#6dff9e', 30, 320);
        self.particles.ring(g.cx, g.cy, '#6dff9e', 10, 60);
        self._completeLevel();
      },
    };
  }

  /* ================= level flow ================= */
  loadLevel(idx) {
    this.levelIdx = idx;
    this.engine = new Engine(idx, this._fx());
    this.runTime = 0;
    this.runStarted = false;
    this.runDeaths = 0;
    this.accumulator = 0;
    this.particles.clear();
    this.camera.x = this.engine.player.x - this.renderer.w / 2;
    this.camera.y = this.engine.player.y - this.renderer.h / 2;
    this._setHUD();
    this._showHint(LEVELS[idx].hint);
    this.audio.levelStart();
    this.audio.switchMode('game');
    this.audio.startMusic('game');
    this._hudDirty = true;
  }

  _completeLevel() {
    // a little beat so the portal sparkle is visible
    setTimeout(() => {
      const idx = this.levelIdx;
      const stars = this._starsFor(this.runTime);
      const bestBefore = this.save.data.best[idx];
      const newBest = !(idx in this.save.data.best) || this.runTime < this.save.data.best[idx];
      this.save.recordResult(idx, this.runTime, stars, this.runDeaths);
      this.save.save();
      this._showComplete(idx, this.runTime, stars, bestBefore, newBest, this.runDeaths);
    }, 500);
  }

  _starsFor(ms) {
    const lvl = LEVELS[this.levelIdx];
    const s = ms / 1000;
    if (s <= lvl.star1) return 3;
    if (s <= lvl.star2) return 2;
    return 1;
  }

  restartLevel() {
    if (!this.engine) return;
    this.engine.restart();
    this.runTime = 0;
    this.runStarted = false;
    this.runDeaths = 0;
    this.audio.sfxStart();
    this._hudDirty = true;
  }

  pause() {
    if (this.state !== 'play') return;
    this.state = 'pause';
    this._show('pause');
  }
  resume() {
    if (this.state !== 'pause') return;
    this.state = 'play';
    this._hideAll();
    this.lastFrame = performance.now();
  }

  goMenu() {
    this.state = 'menu';
    this.audio.switchMode('menu');
    this.audio.startMusic('menu');
    this._show('menu');
    this._updateMenuStats();
  }

  /* ================= stars / time helpers ================= */
  _starsEarned(idx) { return this.save.data.stars[idx] || 0; }

  /* ================= screens ================= */
  _show(name) {
    const ids = { menu: 'screen-menu', levels: 'screen-levels', howto: 'screen-howto',
                  settings: 'screen-settings', pause: 'screen-pause',
                  complete: 'screen-complete', victory: 'screen-victory' };
    for (const id of Object.values(ids)) document.getElementById(id).classList.add('hidden');
    document.getElementById(ids[name]).classList.remove('hidden');
    if (name === 'menu') document.getElementById('hud').classList.add('hidden');
    else if (name === 'play' || name === 'pause') document.getElementById('hud').classList.remove('hidden');
    this._syncTouchControls();
  }
  _hideAll() {
    for (const id of ['screen-menu', 'screen-levels', 'screen-howto', 'screen-settings',
                      'screen-pause', 'screen-complete', 'screen-victory']) {
      document.getElementById(id).classList.add('hidden');
    }
  }

  _syncTouchControls() {
    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const show = isTouch && (this.state === 'play' || this.state === 'pause');
    document.getElementById('touch-controls').classList.toggle('hidden', !show);
  }

  _updateMenuStats() {
    const d = this.save.data;
    document.getElementById('menu-stars').textContent = `★ ${this.save.totalStars()} / ${LEVELS.length * 3}`;
    document.getElementById('menu-deaths').textContent = `☠ ${d.totalDeaths}`;
    document.getElementById('menu-progress').textContent = `${this.save.completedCount()} / ${LEVELS.length}`;
    document.getElementById('btn-continue').textContent = d.unlocked >= LEVELS.length
      ? '▶ Play Again' : '▶ Continue';
  }

  _renderLevelSelect() {
    const grid = document.getElementById('level-grid');
    grid.innerHTML = '';
    const unlocked = this.save.data.unlocked;
    for (let i = 0; i < LEVELS.length; i++) {
      const lvl = LEVELS[i];
      const stars = this._starsEarned(i);
      const isUnlocked = i <= unlocked;
      const card = document.createElement('div');
      card.className = 'level-card' + (stars > 0 ? ' completed' : '') + (i === this.levelIdx ? ' current' : '') + (isUnlocked ? '' : ' locked');
      const starStr = [1, 2, 3].map(n => `<span class="${n <= stars ? 'on' : ''}">★</span>`).join('');
      const best = this.save.data.best[i];
      card.innerHTML = `
        <span class="lc-num">LEVEL ${i + 1}</span>
        <span class="lc-time">${isUnlocked && stars ? Utils.fmtTime(best) : ''}</span>
        <div class="lc-name">${lvl.name}</div>
        <div class="lc-stars">${starStr}</div>
        <div class="lc-best">${stars ? `${stars}★ · best ${Utils.fmtTime(best)}` : '&nbsp;'}</div>`;
      if (isUnlocked) {
        card.addEventListener('click', () => {
          this._hideAll();
          this.state = 'play';
          this.loadLevel(i);
          document.getElementById('hud').classList.remove('hidden');
          this._syncTouchControls();
        });
      } else {
        card.innerHTML += `<span class="lc-lock">🔒</span>`;
      }
      grid.appendChild(card);
    }
  }

  _showComplete(idx, time, stars, bestBefore, newBest, deaths) {
    this.state = 'complete';
    const title = document.getElementById('complete-title');
    const sub = document.getElementById('complete-sub');
    const starBox = document.getElementById('complete-stars');
    starBox.innerHTML = '';
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('span');
      s.className = 'star ' + (i < stars ? 'on' : 'off');
      s.textContent = '★';
      s.style.animationDelay = `${0.15 + i * 0.22}s`;
      starBox.appendChild(s);
      if (i < stars) setTimeout(() => this.audio.sfxStar(), 300 + i * 220);
    }
    if (idx >= LEVELS.length - 1) {
      title.textContent = 'The Forge is yours!';
      sub.textContent = 'You beat every level. Bonus levels await in the Level Select.';
    } else {
      title.textContent = 'Level Complete!';
      sub.textContent = newBest ? '★ New best time! ★' : '';
    }
    document.getElementById('complete-time').textContent = Utils.fmtTime(time);
    document.getElementById('complete-best').textContent = newBest ? Utils.fmtTime(time) : Utils.fmtTime(bestBefore);
    document.getElementById('complete-deaths').textContent = deaths;
    const next = document.getElementById('btn-next');
    next.textContent = idx >= LEVELS.length - 1 ? '🏆 Victory!' : 'Next Level ▶';
    this._show('complete');
    this._updateMenuStats();
  }

  _showVictory() {
    const d = this.save.data;
    this.state = 'victory';
    document.getElementById('vic-stars').textContent = `${this.save.totalStars()} / ${LEVELS.length * 3}`;
    let total = 0, n = 0;
    for (let i = 0; i < LEVELS.length; i++) {
      if (d.best[i]) { total += d.best[i]; n++; }
    }
    document.getElementById('vic-time').textContent = n ? Utils.fmtTime(total) : '—';
    document.getElementById('vic-deaths').textContent = d.totalDeaths;
    this._show('victory');
    this.audio.sfxVictory();
  }

  _showHint(text) {
    const el = document.getElementById('hud-hint');
    el.textContent = '💡 ' + text;
    el.classList.remove('hidden');
    this._lastHint = performance.now();
    setTimeout(() => { if (performance.now() - this._lastHint > 4200) el.classList.add('hidden'); }, 5200);
  }

  _flashDeath() {
    let el = this._deathFlashEl;
    if (!el) {
      el = document.createElement('div');
      el.id = 'death-flash';
      document.body.appendChild(el);
      this._deathFlashEl = el;
    }
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  /* ================= HUD ================= */
  _setHUD() {
    document.getElementById('hud-level').textContent = `${this.levelIdx + 1} · ${LEVELS[this.levelIdx].name}`;
  }
  _updateHUD() {
    const t = document.getElementById('hud-timer');
    const txt = Utils.fmtTime(this.runTime);
    if (t.textContent !== txt) t.textContent = txt;
    const d = document.getElementById('hud-deaths-n');
    if (d.textContent !== String(this.runDeaths)) d.textContent = String(this.runDeaths);
    const k = document.getElementById('hud-keys');
    const kn = document.getElementById('hud-keys-n');
    if (this.engine.playerKeys > 0) {
      k.classList.remove('hidden');
      kn.textContent = String(this.engine.playerKeys);
    } else if (!k.classList.contains('hidden')) {
      k.classList.add('hidden');
    }
  }

  _updateTouchArrows() {
    const el = document.getElementById('grav-arrow');
    if (!el) return;
    const g = this.engine ? this.engine.gravity : { x: 0, y: 1 };
    const angle = Math.atan2(g.y, g.x) + Math.PI / 2;
    el.style.transform = `rotate(${angle}rad)`;
  }

  /* ================= input wiring ================= */
  _bindKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      const c = e.key;
      if (this.state === 'play') {
        if (c === 'p' || c === 'P' || c === 'Escape') this.pause();
        if (c === 'r' || c === 'R') { this.restartLevel(); }
        if (c === 'm' || c === 'M') this._toggleMute();
        if (c === 'f' || c === 'F') this._toggleFullscreen();
      } else if (this.state === 'pause') {
        if (c === 'p' || c === 'P' || c === 'Escape' || c === 'Enter') this.resume();
        if (c === 'r' || c === 'R') { this.restartLevel(); this.state = 'play'; this._hideAll(); this._syncTouchControls(); }
      }
    });
  }

  _bindUI() {
    const $ = (id) => document.getElementById(id);

    $('btn-continue').addEventListener('click', () => {
      this.audio.sfxStart();
      this._hideAll();
      this.state = 'play';
      const d = this.save.data;
      let target = d.unlocked;
      // continue = first uncompleted level
      while (target > 0 && d.stars[target]) target--;
      this.loadLevel(Math.min(target, LEVELS.length - 1));
      document.getElementById('hud').classList.remove('hidden');
      this._syncTouchControls();
    });

    $('btn-levels').addEventListener('click', () => { this.audio.sfxUi(); this._show('levels'); this._renderLevelSelect(); });
    $('btn-howto').addEventListener('click', () => { this.audio.sfxUi(); this._show('howto'); });
    $('btn-settings').addEventListener('click', () => { this.audio.sfxUi(); this._show('settings'); this._syncSettingsUI(); });

    document.querySelectorAll('[data-back]').forEach((btn) => {
      btn.addEventListener('click', () => { this.audio.sfxUi(); this._show(btn.dataset.back); this._updateMenuStats(); });
    });

    $('hud-pause').addEventListener('click', () => this.pause());
    $('btn-resume').addEventListener('click', () => { this.audio.sfxUi(); this.resume(); });
    $('btn-restart').addEventListener('click', () => { this.audio.sfxUi(); this.restartLevel(); this.state = 'play'; this._hideAll(); this._syncTouchControls(); });
    $('btn-pause-settings').addEventListener('click', () => { this.audio.sfxUi(); this._show('settings'); });
    $('btn-quit').addEventListener('click', () => { this.audio.sfxUi(); this.goMenu(); });

    $('btn-next').addEventListener('click', () => {
      this.audio.sfxStart();
      if (this.levelIdx >= LEVELS.length - 1) {
        this._showVictory();
        return;
      }
      this._hideAll();
      this.state = 'play';
      this.loadLevel(this.levelIdx + 1);
      document.getElementById('hud').classList.remove('hidden');
      this._syncTouchControls();
    });
    $('btn-replay').addEventListener('click', () => {
      this.audio.sfxUi();
      this._hideAll();
      this.state = 'play';
      this.loadLevel(this.levelIdx);
      document.getElementById('hud').classList.remove('hidden');
      this._syncTouchControls();
    });
    $('btn-complete-levels').addEventListener('click', () => { this.audio.sfxUi(); this._show('levels'); this._renderLevelSelect(); });
    $('btn-vic-levels').addEventListener('click', () => { this.audio.sfxUi(); this._show('levels'); this._renderLevelSelect(); });
    $('btn-vic-menu').addEventListener('click', () => { this.audio.sfxUi(); this.goMenu(); });

    // settings
    $('set-music').addEventListener('input', (e) => {
      this.save.data.settings.music = e.target.value / 100;
      this.audio.setMusicVol(this.save.data.settings.music);
      this.save.save();
      this._syncSettingsUI();
    });
    $('set-sfx').addEventListener('input', (e) => {
      this.save.data.settings.sfx = e.target.value / 100;
      this.audio.setSfxVol(this.save.data.settings.sfx);
      this.save.save();
      this._syncSettingsUI();
    });
    $('set-shake').addEventListener('change', (e) => {
      this.save.data.settings.shake = e.target.checked;
      this.camera.enabled = e.target.checked;
      this.save.save();
    });
    $('set-particles').addEventListener('change', (e) => {
      this.save.data.settings.particles = e.target.checked;
      this.particles.enabled = e.target.checked;
      this.menuParticles.enabled = e.target.checked;
      this.save.save();
    });
    $('set-fullscreen').addEventListener('change', (e) => {
      if (e.target.checked) this._toggleFullscreen(true);
      else this._toggleFullscreen(false);
    });
    $('btn-reset-save').addEventListener('click', () => {
      if (confirm('Reset ALL progress, stars and settings?')) {
        this.save.reset();
        this._applySettings();
        this._updateMenuStats();
        this._syncSettingsUI();
        this.audio.sfxUi();
      }
    });

    $('btn-fullscreen').addEventListener('click', () => this._toggleFullscreen());
    this._bindTouchControls();
  }

  _applySettings() {
    const s = this.save.data.settings;
    this.audio.setMusicVol(s.music);
    this.audio.setSfxVol(s.sfx);
    this.camera.enabled = s.shake;
    this.particles.enabled = s.particles;
    this.menuParticles.enabled = s.particles;
    if (s.muted) this.audio.setMuted(true);
    this._syncSettingsUI();
  }

  _syncSettingsUI() {
    const s = this.save.data.settings;
    document.getElementById('set-music').value = Math.round(s.music * 100);
    document.getElementById('val-music').textContent = Math.round(s.music * 100) + '%';
    document.getElementById('set-sfx').value = Math.round(s.sfx * 100);
    document.getElementById('val-sfx').textContent = Math.round(s.sfx * 100) + '%';
    document.getElementById('set-shake').checked = s.shake;
    document.getElementById('set-particles').checked = s.particles;
  }

  _toggleMute() {
    const s = this.save.data.settings;
    s.muted = !s.muted;
    this.audio.setMuted(s.muted);
    this.save.save();
  }

  _toggleFullscreen(force) {
    const fs = document.fullscreenElement;
    const want = force !== undefined ? force : !fs;
    if (want && !fs) {
      (document.documentElement.requestFullscreen && document.documentElement.requestFullscreen()) || this.canvas.requestFullscreen();
    } else if (!want && fs) {
      document.exitFullscreen && document.exitFullscreen();
    }
    document.getElementById('set-fullscreen').checked = !!document.fullscreenElement;
  }

  /* ================= touch controls ================= */
  _bindTouchControls() {
    const joyZone = document.getElementById('joy-zone');
    const btnJump = document.getElementById('btn-jump');
    const btnGrav = document.getElementById('btn-grav');
    const touch = this.input.touch;

    // floating virtual joystick
    let joyId = null, joyBase = null, joyKnob = null, joyCX = 0, joyCY = 0;
    const makeJoy = () => {
      if (!joyBase) {
        joyBase = document.createElement('div');
        joyBase.id = 'joy-base';
        joyKnob = document.createElement('div');
        joyKnob.id = 'joy-knob';
        joyZone.appendChild(joyBase);
        joyZone.appendChild(joyKnob);
      }
    };
    const moveJoy = (cx, cy) => {
      const dx = cx - joyCX, dy = cy - joyCY;
      const mag = Math.hypot(dx, dy);
      const max = 36;
      const cl = Math.min(mag, max);
      const nx = joyCX + (dx / (mag || 1)) * cl;
      const ny = joyCY + (dy / (mag || 1)) * cl;
      joyBase.style.left = nx + 'px';
      joyBase.style.top = ny + 'px';
      joyKnob.style.left = nx + 'px';
      joyKnob.style.top = ny + 'px';
      touch.joyDX = dx / max;
      touch.joyDY = dy / max;
    };

    joyZone.addEventListener('pointerdown', (e) => {
      if (joyId !== null) return;
      joyId = e.pointerId;
      joyZone.setPointerCapture(e.pointerId);
      touch.active = true;
      makeJoy();
      const rect = joyZone.getBoundingClientRect();
      joyCX = e.clientX - rect.left;
      joyCY = e.clientY - rect.top;
      joyBase.style.left = joyCX + 'px';
      joyBase.style.top = joyCY + 'px';
      joyKnob.style.left = joyCX + 'px';
      joyKnob.style.top = joyCY + 'px';
      moveJoy(e.clientX - rect.left, e.clientY - rect.top);
    });
    joyZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== joyId) return;
      const rect = joyZone.getBoundingClientRect();
      moveJoy(e.clientX - rect.left, e.clientY - rect.top);
    });
    const endJoy = (e) => {
      if (e.pointerId !== joyId) return;
      joyId = null;
      touch.active = false;
      touch.joyDX = 0; touch.joyDY = 0;
      if (joyBase) { joyBase.remove(); joyKnob.remove(); joyBase = null; joyKnob = null; }
    };
    joyZone.addEventListener('pointerup', endJoy);
    joyZone.addEventListener('pointercancel', endJoy);

    // jump button
    btnJump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      touch.jump = true;
      this.input.jumpPressed = true;
      this.input.jumpHeld = true;
      btnJump.classList.add('pressed');
    });
    btnJump.addEventListener('pointerup', () => {
      touch.jump = false;
      this.input.jumpHeld = false;
      btnJump.classList.remove('pressed');
    });
    btnJump.addEventListener('pointerleave', () => {
      touch.jump = false;
      this.input.jumpHeld = false;
      btnJump.classList.remove('pressed');
    });

    // gravity pad: tap = rotate CW; drag = aim gravity
    let gravId = null, gravStartX = 0, gravStartY = 0, gravMoved = false;
    btnGrav.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      gravId = e.pointerId;
      gravStartX = e.clientX; gravStartY = e.clientY;
      gravMoved = false;
      btnGrav.setPointerCapture(e.pointerId);
      touch.gravTouched = true;
    });
    btnGrav.addEventListener('pointermove', (e) => {
      if (e.pointerId !== gravId) return;
      const dx = e.clientX - gravStartX, dy = e.clientY - gravStartY;
      if (Math.hypot(dx, dy) > 24) {
        gravMoved = true;
        const angle = Math.atan2(dy, dx);
        // map drag direction to the 4 gravity directions
        const gx = Math.cos(angle), gy = Math.sin(angle);
        const gravityDir = Math.abs(gx) > Math.abs(gy) ? (gx > 0 ? 1 : 3) : (gy > 0 ? 0 : 2);
        this._setGravityDir(gravityDir);
      }
    });
    const endGrav = (e) => {
      if (e.pointerId !== gravId) return;
      gravId = null;
      touch.gravTouched = false;
      if (!gravMoved && this.engine) this.engine.rotateGravity(true);
    };
    btnGrav.addEventListener('pointerup', endGrav);
    btnGrav.addEventListener('pointercancel', endGrav);
  }

  /** 0=down 1=right 2=up 3=left */
  _setGravityDir(dir) {
    if (!this.engine) return;
    const targets = [
      { x: 0, y: 1 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: -1, y: 0 },
    ];
    const t = targets[dir];
    const cur = this.engine.gravity;
    if (cur.x === t.x && cur.y === t.y) return;
    // rotate through the shortest path (down→right is a CCW rotation)
    const curIdx = targets.findIndex(g => g.x === cur.x && g.y === cur.y);
    let diff = dir - curIdx;
    if (diff === 3) diff = -1;
    if (diff === -3) diff = 1;
    for (let i = 0; i < Math.abs(diff); i++) this.engine.rotateGravity(diff < 0);
  }
}

/* ============================================================================
   13. BOOT — guarded so the file is also loadable in Node for tests
   ========================================================================== */
if (typeof document !== 'undefined' && document.getElementById('game')) {
  const start = () => {
    const game = new Game();
    window.GravityForge = game;
    game.boot();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
