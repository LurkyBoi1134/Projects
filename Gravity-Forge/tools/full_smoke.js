#!/usr/bin/env node
/*
 * Gravity Forge — full-game smoke test.
 * Boots the ENTIRE game (UI, HUD, renderer, audio, input) in a stubbed-DOM
 * Node environment, clicks through the menus and plays a real level via the
 * Game loop. Catches runtime errors that engine-only tests miss.
 * Run: node tools/full_smoke.js
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const noop = () => {};
const ctx2d = new Proxy({}, {
  get: (t, k) => {
    if (k === 'canvas') return { width: 0, height: 0 };
    if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: noop });
    return typeof t[k] === 'function' ? t[k] : noop;
  },
  set: () => true,
});

class FakeEl {
  constructor(id) {
    this.id = id;
    this.children = [];
    this.style = {};
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach(x => this.classList._s.add(x)),
      remove: (...c) => c.forEach(x => this.classList._s.delete(x)),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, v) => { if (v === undefined) v = !this.classList._s.has(c); v ? this.classList._s.add(c) : this.classList._s.delete(c); },
    };
    this.dataset = {};
    this.listeners = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.checked = false;
    this.width = 960; this.height = 540;
    this.clientWidth = 960; this.clientHeight = 540;
    this.parentNode = { removeChild: noop };
  }
  getContext() { return ctx2d; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev) { const e = ev || { preventDefault: noop, pointerId: 1, clientX: 0, clientY: 0 }; if (!e.target) e.target = this; (this.listeners[t] || []).forEach(fn => fn(e)); }
  appendChild(c) { this.children.push(c); return c; }
  remove() { this.parentNode.removeChild(this); }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  offsetWidth = 0;
  querySelectorAll() { return []; }
}

const els = {};
const mkEl = (id) => (els[id] = els[id] || new FakeEl(id));

const sandbox = {
  console, Math, Date, JSON, setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() },
  requestAnimationFrame: (fn) => { sandbox._raf = fn; return 1; },
  cancelAnimationFrame: noop,
  confirm: () => true,
  window: null,
  navigator: { maxTouchPoints: 0 },
  localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
  document: {
    readyState: 'loading',
    getElementById: (id) => mkEl(id),
    createElement: (tag) => new FakeEl('dyn-' + Math.random()),
    addEventListener: noop,
    querySelectorAll: () => [],
    body: new FakeEl('body'),
    documentElement: new FakeEl('html'),
  },
};
sandbox.window = sandbox;
sandbox.addEventListener = noop;
sandbox.removeEventListener = noop;
vm.createContext(sandbox);

let code = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
code += '\n;globalThis.__X__ = { Game, SaveManager, CFG };';
vm.runInContext(code, sandbox);

// boot the game
const sm = sandbox.__X__.SaveManager;
const d = sm.load();
console.log('save load:', d ? Object.keys(d).join(',') : 'UNDEFINED');
const game = new sandbox.__X__.Game();
console.log('game save:', game.save ? (game.save.data ? 'ok' : 'no data') : 'no save');
game.boot();
console.log('booted ✓  state =', game.state);

// pump some menu frames (with realistic timestamps)
const pump = (n) => { const now = performance.now(); for (let i = 0; i < n; i++) { game.lastFrame = now - 16.7 + i * 16.7; game._frame(now + i * 16.7); } };
pump(60);
console.log('menu frames ok ✓  engine =', !!game.engine);

// open level select and click level 2
els['btn-levels'].dispatch('click');
game._renderLevelSelect();
console.log('level select ok ✓  cards =', els['level-grid'].children.length);

// go back, then continue
els['btn-continue'].dispatch('click');
pump(120);
console.log('level loaded ✓  state =', game.state, 'level =', game.levelIdx, 'engine =', !!game.engine);

// simulate inputs: walk right and jump
let t = 0;
for (let i = 0; i < 60 * 5; i++) {
  sandbox.input = { left: false, right: true, jump: i % 30 === 0, jumpHeld: true, joy: null };
  const now = performance.now();
  game.lastFrame = now - 16.7;
  game._frame(now);
  if (game.engine && game.engine.completed) break;
}
console.log('played 5s ✓  completed =', game.engine.completed);

// pause, resume, restart, quit
els['hud-pause'].dispatch('click');
console.log('paused ✓  state =', game.state);
els['btn-resume'].dispatch('click');
console.log('resumed ✓  state =', game.state);
els['hud-pause'].dispatch('click');
els['btn-restart'].dispatch('click');
console.log('restarted ✓  state =', game.state);
els['hud-pause'].dispatch('click');
els['btn-quit'].dispatch('click');
console.log('quit to menu ✓  state =', game.state);

// settings screen
els['btn-settings'].dispatch('click');
els['set-music'].dispatch('input', { target: els['set-music'] });
els['set-shake'].dispatch('change', { target: els['set-shake'] });
console.log('settings ok ✓');

// --- completion flow ---
game._hideAll();
game.state = 'play';
game.loadLevel(0);
const goal = game.engine.goal;
const CFGX = sandbox.__X__.CFG;
game.engine.player.x = goal.x * CFGX.TILE + CFGX.TILE / 2 - 11;
game.engine.player.y = goal.y * CFGX.TILE + CFGX.TILE / 2 - 14;
pump(30);
setTimeout(() => {
  console.log('complete screen ✓  state =', game.state);
  console.log('stars saved:', game.save.data.stars[0] || 0);
  console.log('best saved:', game.save.data.best[0] || 0);
  // next level
  els['btn-next'].dispatch('click');
  console.log('next level ✓  level =', game.levelIdx);
  // back to menu, check stats
  game.goMenu();
  console.log('menu stats ✓  stars =', game.save.totalStars());
  console.log('\nALL SMOKE TESTS PASSED ✓');
  process.exit(0);
}, 800);
// keep the event loop alive
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 6000);
