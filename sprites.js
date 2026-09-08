/* $BELL living layer, v3.
   One fixed canvas over the page. Traders, bells and coins run along the floor lines: every edge
   that carries data-floor (band tops, candle strips, the bottom of the hero and the drop art, the
   top of the phone sheet) and, only when none of those is on screen, the viewport bottom. Scrolling
   spawns runners (down runs right, up runs left), every ring sends a parade of hopping bells
   across, an idle trader jogs by every twenty seconds, and coins bounce along the floor waiting
   to be caught. The layer never takes pointer events unless the cursor is over a coin, so the
   page under it stays clickable. Off under prefers-reduced-motion. */

const CAP = 24;
const FPS = 12;
const IDLE_MS = 20_000;
const SCROLL_FLUSH_MS = 180;
const SCROLL_UNIT = 420;
const EIGHT = 8;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const RUN_SETS = ['trader-a', 'trader-b', 'trader-c', 'bell-run'];
const HOP_SEQ = [2, 1, 0, 0, 2, 2];

const S = {
  canvas: null, ctx: null, dpr: 1, w: 0, h: 0, size: 80,
  set: '1x', manifest: null, images: {}, loaded: 0, total: 0,
  sprites: [], particles: [], floors: [],
  raf: 0, last: 0, running: false,
  acc: 0, dir: 1, flushTimer: 0, lastY: 0,
  hover: null, pointer: { x: -1, y: -1 },
  coins: 0, spawned: 0,
  hooks: { onCoin: null, onEight: null, onSpawn: null },
  counter: null, toast: null, toastTimer: 0,
  idleTimer: 0, pendingParade: false, popAt: 0,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ------------------------------------------------------------------ assets
function assetSet() {
  return (window.devicePixelRatio || 1) >= 1.5 ? 'full' : '1x';
}
function frameUrl(name) {
  return S.set === '1x' ? `assets/v2/sprites/${name.replace(/\.png$/, '@1x.png')}` : `assets/v2/sprites/${name}`;
}
async function loadAssets() {
  let man = null;
  try {
    const res = await fetch('assets/v2/sprites/manifest.json', { cache: 'force-cache' });
    if (res.ok) man = await res.json();
  } catch { man = null; }
  if (!man) return;
  S.manifest = man;
  S.set = assetSet();
  const jobs = [];
  for (const key of Object.keys(man)) {
    const frames = man[key].frames || [];
    S.images[key] = new Array(frames.length).fill(null);
    frames.forEach((f, i) => jobs.push([key, i, f]));
  }
  S.total = jobs.length;
  // coins and traders first: the first scroll burst and the first catch should have art ready
  const order = ['coin', 'trader-a', 'bell-hop', 'trader-b', 'bell-run', 'trader-c', 'chip'];
  jobs.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  let cursor = 0;
  const worker = () => {
    if (cursor >= jobs.length) return;
    const [key, i, f] = jobs[cursor];
    cursor += 1;
    const img = new Image();
    img.decoding = 'async';
    try { img.fetchPriority = 'low'; } catch { /* fine */ }
    img.onload = () => { S.images[key][i] = img; S.loaded += 1; afterLoad(); worker(); };
    img.onerror = () => { S.loaded += 1; afterLoad(); worker(); };
    img.src = frameUrl(f);
  };
  for (let k = 0; k < 3; k += 1) worker();
}
// a ring that landed before the art did gets its parade as soon as the hopping bell is in
function afterLoad() {
  if (S.pendingParade && ready('bell-hop') && ready('coin')) {
    S.pendingParade = false;
    parade();
  }
}
function ready(key) {
  const arr = S.images[key];
  return Boolean(arr && arr.length && arr.every(Boolean));
}

// ------------------------------------------------------------------ canvas
function size() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  S.dpr = dpr;
  S.w = w;
  S.h = h;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (S.canvas.width !== pw || S.canvas.height !== ph) {
    S.canvas.width = pw;
    S.canvas.height = ph;
  }
  S.canvas.style.width = `${w}px`;
  S.canvas.style.height = `${h}px`;
  S.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  S.ctx.imageSmoothingEnabled = true;
  S.ctx.imageSmoothingQuality = 'high';
  // a runner is about a twentieth of the screen width, never smaller than a thumb, never a giant;
  // an ultrawide gets a bigger cap so the layer does not read as specks
  S.size = Math.round(clamp(w * 0.058, 60, w > 2200 ? 150 : 104));
}

// ------------------------------------------------------------------ floor lines
// A floor is where feet land. A band edge counts while it is on screen and clear of the viewport
// bottom line; a 'sheet' edge (the console) counts only while the console is a full width bottom
// sheet. The viewport bottom is the fallback when no edge is on screen, so runners never cross the
// middle of a card when there is a real floor to run on.
function floorY(f) {
  if (f.kind === 'viewport') return S.h;
  const r = f.el.getBoundingClientRect();
  return f.edge === 'bottom' ? r.bottom : r.top;
}
function isSheet(el) {
  const r = el.getBoundingClientRect();
  return r.width >= S.w - 2;
}
function visibleFloors() {
  const out = [];
  for (const f of S.floors) {
    if (f.edge === 'sheet' && !isSheet(f.el)) continue;
    const y = floorY(f);
    if (y > S.size + 40 && y < S.h - 24) out.push(f);
  }
  if (!out.length) out.push({ kind: 'viewport' });
  return out;
}

// ------------------------------------------------------------------ spawning
function spawnRunner(dir, floor) {
  if (S.sprites.length >= CAP) return null;
  const key = Math.random() < 0.72 ? pick(['trader-a', 'trader-b', 'trader-c']) : 'bell-run';
  if (!ready(key)) return null;
  const size = key === 'bell-run' ? Math.round(S.size * 0.9) : S.size;
  // the pace follows the sprite on a laptop and the screen on a wide monitor, so a run clears in seconds
  const speed = Math.max((key === 'bell-run' ? 2.3 : 2.7) * S.size, S.w / 6) * rnd(0.75, 1.35);
  const sp = {
    kind: 'runner', key, size, dir,
    // a short stagger: the first runner of a burst is on screen within a second
    x: dir > 0 ? -size * rnd(0.3, 3) : S.w + size * rnd(0.3, 3),
    vx: speed * dir, vy: 0, lift: 0,
    floor: floor || { kind: 'viewport' },
    t0: performance.now() + rnd(0, 300),
  };
  S.sprites.push(sp);
  S.spawned += 1;
  if (S.hooks.onSpawn) S.hooks.onSpawn(sp);
  return sp;
}
function spawnHop(dir, delay, floor) {
  if (S.sprites.length >= CAP || !ready('bell-hop')) return null;
  const size = Math.round(S.size * 1.05);
  const sp = {
    kind: 'hop', key: 'bell-hop', size, dir,
    x: dir > 0 ? -size - delay * 0.001 * 1.6 * S.size : S.w + size + delay * 0.001 * 1.6 * S.size,
    vx: 1.6 * S.size * dir, vy: 0, lift: 0,
    floor: floor || { kind: 'viewport' },
    // each bell in the parade hops on its own beat
    t0: performance.now() - delay,
  };
  S.sprites.push(sp);
  S.spawned += 1;
  return sp;
}
function spawnCoin(x, y, floor) {
  if (!ready('coin')) return null;
  if (S.sprites.filter((s) => s.kind === 'coin').length >= 6) return null;
  const size = Math.round(S.size * 0.6);
  const dir = Math.random() < 0.5 ? 1 : -1;
  const f = floor || { kind: 'viewport' };
  const fy = floorY(f);
  const sp = {
    kind: 'coin', key: 'coin', size, dir,
    x: typeof x === 'number' ? x : (dir > 0 ? -size : S.w + size),
    y: typeof y === 'number' ? y : fy - size * 2.2,
    vx: 0.95 * S.size * dir, vy: 0, spin: rnd(0, 6),
    floor: f, t0: performance.now(), born: performance.now(),
  };
  S.sprites.push(sp);
  S.spawned += 1;
  return sp;
}
function spawnRunners(n, dir) {
  // the floor edges on screen share the traffic; the viewport bottom only when none is on screen
  const floors = visibleFloors();
  for (let i = 0; i < n; i += 1) spawnRunner(dir, pick(floors));
  if (Math.random() < 0.35) spawnCoin(undefined, undefined, floors[0]);
}
function parade() {
  if (REDUCED || !S.running) return;
  if (!ready('bell-hop')) { S.pendingParade = true; return; }
  const dir = Math.random() < 0.5 ? 1 : -1;
  const n = S.w > 2200 ? 12 : S.w > 1400 ? 10 : S.w > 760 ? 8 : 5;
  const floor = visibleFloors()[0];
  for (let i = 0; i < n; i += 1) spawnHop(dir, i * 380, floor);
  spawnCoin(undefined, undefined, floor);
  if (S.w > 1100) spawnCoin(undefined, undefined, floor);
}

// ------------------------------------------------------------------ scroll energy
function flush() {
  S.flushTimer = 0;
  const acc = S.acc;
  S.acc = 0;
  if (acc < SCROLL_UNIT) return;
  const n = clamp(Math.floor(acc / SCROLL_UNIT), 1, 6);
  spawnRunners(n, S.dir);
}
function feed(delta) {
  if (!delta) return;
  S.dir = delta > 0 ? 1 : -1;
  S.acc += Math.abs(delta);
  if (!S.flushTimer) S.flushTimer = setTimeout(flush, SCROLL_FLUSH_MS);
}
function onScroll() {
  const y = window.scrollY;
  const dy = y - S.lastY;
  S.lastY = y;
  feed(dy);
}
function onWheel(e) {
  // a wheel burst at the top or bottom of the page moves nothing, the runners still come
  feed(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? S.h : 1) * 0.4);
}

// ------------------------------------------------------------------ coins caught
function loadCount() {
  try { S.coins = Math.max(0, Number(localStorage.getItem('bell-coins')) || 0); } catch { S.coins = 0; }
}
function saveCount() {
  try { localStorage.setItem('bell-coins', String(S.coins)); } catch { /* fine */ }
}
function renderCount() {
  if (S.counter) S.counter.textContent = String(S.coins);
}
function toast() {
  if (!S.toast) return;
  S.toast.hidden = false;
  S.toast.classList.remove('is-on');
  // restart the stamp slam
  void S.toast.offsetWidth;
  S.toast.classList.add('is-on');
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(() => { S.toast.classList.remove('is-on'); S.toast.hidden = true; }, 3200);
}
function pop(coin) {
  const i = S.sprites.indexOf(coin);
  if (i >= 0) S.sprites.splice(i, 1);
  const cx = coin.x;
  const cy = coin.y;
  const s = Math.max(5, Math.round(coin.size * 0.16));
  for (let k = 0; k < 4; k += 1) {
    const a = (-Math.PI / 2) + (k - 1.5) * 0.55;
    const v = coin.size * rnd(3.2, 4.4);
    S.particles.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, s, t0: performance.now(), life: 620 });
  }
  S.coins += 1;
  saveCount();
  renderCount();
  if (S.hooks.onCoin) S.hooks.onCoin(S.coins);
  if (S.coins > 0 && S.coins % EIGHT === 0) {
    toast();
    if (S.hooks.onEight) S.hooks.onEight(S.coins);
  }
  S.hover = null;
  S.canvas.classList.remove('is-coin');
}
function coinAt(x, y) {
  for (let i = S.sprites.length - 1; i >= 0; i -= 1) {
    const c = S.sprites[i];
    if (c.kind !== 'coin') continue;
    const r = c.size / 2 + 8;
    if (Math.abs(x - c.x) <= r && Math.abs(y - c.y) <= r) return c;
  }
  return null;
}
function onMove(e) {
  S.pointer.x = e.clientX;
  S.pointer.y = e.clientY;
  updateHover();
}
function updateHover() {
  if (S.pointer.x < 0) return;
  const c = coinAt(S.pointer.x, S.pointer.y);
  if (c !== S.hover) {
    S.hover = c;
    S.canvas.classList.toggle('is-coin', Boolean(c));
  }
}
function onDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  const c = coinAt(e.clientX, e.clientY);
  if (!c) return;
  e.preventDefault();
  e.stopPropagation();
  S.popAt = performance.now();
  pop(c);
}
// a tap that caught a coin must not also press whatever sat under the coin
function onClick(e) {
  if (performance.now() - S.popAt < 500) { e.preventDefault(); e.stopPropagation(); }
}

// ------------------------------------------------------------------ the loop
function step(t) {
  S.raf = 0;
  if (!S.running) return;
  const dt = Math.min(0.05, (t - (S.last || t)) / 1000);
  S.last = t;
  const ctx = S.ctx;
  ctx.clearRect(0, 0, S.w, S.h);
  const keep = [];
  for (const sp of S.sprites) {
    const fy = floorY(sp.floor);
    if (sp.kind === 'coin') {
      // a coin nobody caught leaves after twenty seconds, so the floor empties between rings
      if (t - sp.born > 20_000) {
        if (S.hover === sp) { S.hover = null; S.canvas.classList.remove('is-coin'); }
        continue;
      }
      const r = sp.size / 2;
      sp.vy += 7.5 * S.size * dt;
      sp.y += sp.vy * dt;
      sp.x += sp.vx * dt;
      if (sp.y + r >= fy) {
        sp.y = fy - r;
        // every landing throws the coin back up with a fresh kick, so it keeps bouncing along the floor
        sp.vy = -S.size * rnd(1.5, 2.6);
      }
      const gone = (sp.dir > 0 && sp.x - r > S.w + 4) || (sp.dir < 0 && sp.x + r < -4) || sp.y > S.h + sp.size * 3;
      if (gone) continue;
      keep.push(sp);
      drawCoin(ctx, sp, t);
      continue;
    }
    sp.x += sp.vx * dt;
    const gone = (sp.dir > 0 && sp.x - sp.size > S.w + 8) || (sp.dir < 0 && sp.x + sp.size < -8) || fy < -sp.size || fy > S.h + sp.size * 2;
    if (gone) continue;
    keep.push(sp);
    drawSprite(ctx, sp, fy, t);
  }
  S.sprites = keep;
  const parts = [];
  for (const p of S.particles) {
    const age = t - p.t0;
    if (age > p.life) continue;
    p.vy += 9 * S.size * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    ctx.fillStyle = age > p.life * 0.7 ? '#C89A00' : '#FFD12F';
    ctx.fillRect(Math.round(p.x - p.s / 2), Math.round(p.y - p.s / 2), p.s, p.s);
    parts.push(p);
  }
  S.particles = parts;
  if (S.hover) updateHover();
  S.raf = requestAnimationFrame(step);
}
function drawSprite(ctx, sp, fy, t) {
  const frames = S.images[sp.key];
  if (!frames) return;
  let idx;
  if (sp.kind === 'hop') {
    idx = HOP_SEQ[Math.floor(((t - sp.t0) / 1000) * FPS) % HOP_SEQ.length];
  } else {
    idx = Math.floor(((t - sp.t0) / 1000) * FPS) % frames.length;
  }
  const img = frames[idx] || frames[0];
  if (!img) return;
  const size = sp.size;
  const y = Math.round(fy - size);
  const x = Math.round(sp.x);
  if (sp.dir < 0) {
    ctx.save();
    ctx.translate(x, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(img, Math.round(-size / 2), y, size, size);
    ctx.restore();
  } else {
    ctx.drawImage(img, Math.round(x - size / 2), y, size, size);
  }
}
function drawCoin(ctx, sp, t) {
  const frames = S.images.coin;
  if (!frames) return;
  const idx = Math.floor(((t - sp.t0) / 1000) * FPS + sp.spin) % frames.length;
  const img = frames[idx] || frames[0];
  if (!img) return;
  const size = sp.size;
  const hot = S.hover === sp;
  const draw = hot ? Math.round(size * 1.12) : size;
  ctx.drawImage(img, Math.round(sp.x - draw / 2), Math.round(sp.y - draw / 2), draw, draw);
}

function start() {
  if (S.running) return;
  S.running = true;
  S.last = 0;
  if (!S.raf) S.raf = requestAnimationFrame(step);
}
function stop() {
  S.running = false;
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = 0;
}
function idle() {
  if (!S.running || document.hidden) return;
  if (S.sprites.some((s) => s.kind === 'runner')) return;
  spawnRunner(Math.random() < 0.5 ? 1 : -1, visibleFloors()[0]);
}

// ------------------------------------------------------------------ api
export const sprites = {
  reduced: REDUCED,
  init({ canvas, floors, counter, toastEl, onCoin, onEight, onSpawn }) {
    if (!canvas) return;
    S.canvas = canvas;
    S.counter = counter || null;
    S.toast = toastEl || null;
    S.hooks.onCoin = onCoin || null;
    S.hooks.onEight = onEight || null;
    S.hooks.onSpawn = onSpawn || null;
    loadCount();
    renderCount();
    if (REDUCED) { canvas.hidden = true; return; }
    S.ctx = canvas.getContext('2d');
    S.floors = (floors || []).map((el) => ({ kind: 'band', el, edge: ['bottom', 'sheet'].includes(el.dataset.floor) ? el.dataset.floor : 'top' }));
    size();
    S.lastY = window.scrollY;
    loadAssets();
    window.addEventListener('resize', size);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('pointerdown', onDown, { capture: true });
    document.addEventListener('click', onClick, { capture: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
    S.idleTimer = setInterval(idle, IDLE_MS);
    // one coin early, so the catch game is discovered without waiting for a ring
    setTimeout(() => { if (S.running) spawnCoin(); }, 7000);
    start();
  },
  parade,
  spawnCoin(x, y) { return spawnCoin(x, y); },
  spawnRunners(n, dir) { spawnRunners(n, dir || 1); },
  count() { return S.sprites.length; },
  runners() { return S.sprites.filter((s) => s.kind === 'runner' || s.kind === 'hop').length; },
  coinsOnScreen() { return S.sprites.filter((s) => s.kind === 'coin').length; },
  coins() { return S.coins; },
  spawned() { return S.spawned; },
  loaded() { return S.total ? S.loaded / S.total : 0; },
  set() { return S.set; },
  size() { return S.size; },
};
