/* $BELL site logic, v3.
   The client clock (schedule.js, shared with the bot) decides what time it is, which bell is
   next, which theme is on and which marks are filled. data/state.json decides every result:
   who is leading, who won, what dropped. The page never ranks a buyer or sizes a drop itself.

   QA params:
     ?t=2026-09-10T15:59:50-04:00   start the clock at that instant and run from there
     &hold=1                        freeze the clock at ?t instead of running
     ?demo=ring                     force the ringing state (re-rings every 12 seconds)
     ?demo=1                        read the invented demo file instead of the bot's file
     ?theme=closed | open           force the theme
*/

import {
  VERIFIED_YEARS,
  dayKey,
  nyParts,
  closureName,
  isMarketDay,
  ringsForDay,
  nextRing,
  previousRing,
  currentHourWindow,
} from './schedule.js';
import { sprites } from './sprites.js';

const RING_MS = 12_000;
const RAIN_MS = 3_000;
const POLL_OPEN_MS = 15_000;
const POLL_CLOSED_MS = 60_000;
const STALE_OPEN_MS = 180_000;
const STALE_CLOSED_MS = 900_000;
const BELL_NAMES = ['FIRST BELL', 'SECOND BELL', 'THIRD BELL', 'FOURTH BELL', 'FIFTH BELL', 'SIXTH BELL', 'SEVENTH BELL', 'EIGHT BELLS'];
const BELL_COPY = [
  ['The Opening Bell', 'New York opens. The desk opens. Race one starts. On a Monday this bell shows the weekend gap.'],
  ['The Short Bell', 'Thirty minutes of racing. Shortest race of the day, fastest name on the tape.'],
  ['The Coffee Bell', 'Second race settled. The desk finds its rhythm.'],
  ['The Noon Bell', 'Halfway through the eight. Lunch is thin. A small buy can take the hour.'],
  ['The Afternoon Watch', 'Back half begins. On an early-close day this is the closing bell and the drop lands here.'],
  ['The Fed Bell', 'The Fed talks at 2. The desk does not care. Ring.'],
  ['The Power Hour Bell', "Last race. Wall Street's loudest hour. Bring size."],
  ['The Closing Bell', "Gavel down. The day's fees become NVDAc and drop on every holder above the dust line. Then silence."],
];
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WEEKDAYS_LONG = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const STONKS_HOME = 'https://www.thestonks.exchange/';

// ------------------------------------------------------------------ params and clock
const params = new URLSearchParams(location.search);
const T_PARAM = params.get('t');
const T0 = T_PARAM ? Date.parse(T_PARAM) : NaN;
const HOLD = params.has('hold');
const DEMO_RING = params.get('demo') === 'ring';
const THEME_PARAM = ['open', 'closed'].includes(params.get('theme')) ? params.get('theme') : null;
const BOOT = Date.now();
// ?demo (any value, including demo=ring) reads the invented demo file, so QA never depends on the bot's file.
// Otherwise the live state comes straight from the desk box (Caddy on the VPS, CORS open, no-store), so the
// page never waits on a GitHub Pages build. The copy next to the page (data/state.json) is the fallback:
// the pre-launch file, or the last pushed copy when the desk cannot be reached.
const DESK_STATE_URL = 'https://desk.bellonbase.fun/state.json';
const STATE_URL = params.has('demo') ? 'data/state.demo.json' : 'data/state.json';
const USE_DESK = !params.has('demo') && !params.has('local');
let deskFails = 0;
let pollCount = 0;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function now() {
  if (Number.isNaN(T0)) return new Date();
  if (HOLD) return new Date(T0);
  return new Date(T0 + (Date.now() - BOOT));
}

let themeOverride = THEME_PARAM;
try {
  if (!themeOverride) {
    const saved = sessionStorage.getItem('bell-preview');
    if (saved === 'open' || saved === 'closed') themeOverride = saved;
  }
} catch { /* storage may be blocked; the clock still rules */ }

// ------------------------------------------------------------------ dom
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const el = {
  ticker: $('ticker'), tickerLive: $('ticker-live'), tickerTrack: $('ticker-track'),
  nav: $('nav'), navMenu: $('nav-menu'), navLinks: $('nav-links'), navCa: $('nav-ca'), navCaShort: $('nav-ca-short'), navBuy: $('nav-buy'),
  soundToggle: $('sound-toggle'),
  navband: $('navband'), coinsChip: $('coins-chip'), coinsN: $('coins-n'), toast: $('toast'), hint: $('hint'), spritesCanvas: $('sprites'),
  hero: $('top'), heroSticky: $('hero-sticky'), heroMarket: $('hero-market'), heroBuy: $('hero-buy'), readTape: $('read-tape'), heroDesk: $('hero-desk'),
  clockNext: $('clock-next'), clockTime: $('clock-time'), clockMeta: $('clock-meta'),
  bells: $('bells'), bellsNote: $('bells-note'),
  console: $('console'), winTitle: $('win-title'), winLoad: $('win-load'), winLoadBar: $('win-load-bar'),
  floorCanvas: $('floor-canvas'), floorStillImg: $('floor-still-img'), ringer: $('ringer'),
  rain: $('rain'),
  plateLabel: $('plate-label'), plateLive: $('plate-live'), plateRank: $('plate-rank'), plateWho: $('plate-who'), plateSize: $('plate-size'),
  platePrize: $('plate-prize'), plateEnds: $('plate-ends'), plateCta: $('plate-cta'),
  statLast: $('stat-last'), statDesk: $('stat-desk'), statHolders: $('stat-holders'),
  bellgrid: $('bellgrid'), eightNote: $('eight-note'),
  dropSum: $('drop-sum'), dropRecord: $('drop-record'), ledgerBody: $('ledger-body'),
  gapLabel: $('gap-label'), gapValue: $('gap-value'), gapUnit: $('gap-unit'), gapMeta: $('gap-meta'), gapClock: $('gap-clock'),
  ringersSum: $('ringers-sum'), wall: $('wall'),
  coinAge: $('coin-age'), coinCa: $('coin-ca'), coinMc: $('coin-mc'), coinChg: $('coin-chg'), coinBy: $('coin-by'),
  linkSite: $('link-site'), linkX: $('link-x'), linkDex: $('link-dex'), linkGecko: $('link-gecko'), linkGmgn: $('link-gmgn'),
  linkStonks: $('link-stonks'), linkScanToken: $('link-scan-token'), linkScanPool: $('link-scan-pool'),
  copyToken: $('copy-token'), copyToken2: $('copy-token-2'), copyPool: $('copy-pool'),
  factToken: $('fact-token'), factPool: $('fact-pool'), factSupply: $('fact-supply'), factPrice: $('fact-price'),
  footerState: $('footer-state'), footerYears: $('footer-years'), previewToggle: $('preview-toggle'),
  footerX: $('footer-x'), footerTg: $('footer-tg'), footerJoin: $('footer-join'), fStonks: $('f-stonks'), fDex: $('f-dex'), fScan: $('f-scan'),
  sfxBell: $('sfx-bell'), sfxTick: $('sfx-tick'),
};

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}
function setHTML(node, html) {
  if (node && node.__html !== html) { node.innerHTML = html; node.__html = html; }
}
// A plate cell with nothing in it is hidden, so the row never prints a placeholder dot.
function setCell(node, text) {
  setText(node, text);
  node.hidden = !text;
}
function setCellHTML(node, html) {
  setHTML(node, html);
  node.hidden = !html;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

// ------------------------------------------------------------------ formatting
function num(v, dp = 2) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function nvda(v) { return num(v, 2); }
function nvdaOr(v, fallback = '·') { const s = nvda(v); return s === null ? fallback : `${s} NVDAc`; }
function bellAmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}
function usd(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return null;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
function int(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : null;
}
function pct(v) {
  const n = Number(v);
  if (v === null || v === undefined || !Number.isFinite(n)) return null;
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}
function short(a) {
  if (!a || typeof a !== 'string') return '·';
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
function who(o) {
  if (!o) return '·';
  return o.name || short(o.address);
}
function wallShort(wall) {
  return String(wall || '').replace(/\s?[AP]M$/i, '') || '·';
}
function keyToUtc(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function wd(key) { return key ? WEEKDAYS[keyToUtc(key).getUTCDay()] : '·'; }
function dayLabel(key) {
  if (!key) return '·';
  const d = keyToUtc(key);
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function daysBetween(a, b) {
  return Math.round((keyToUtc(b) - keyToUtc(a)) / 86_400_000);
}
function pad(n) { return String(n).padStart(2, '0'); }
function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
function hhmmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function nyClock(d) {
  const p = nyParts(d);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${pad(p.minute)}:${pad(p.second)} ${p.hour < 12 ? 'AM' : 'PM'} ET`;
}
function ringLabel(ring, todayKey) {
  if (!ring) return '·';
  const t = wallShort(ring.wall);
  return ring.day === todayKey ? t : `${wd(ring.day)} ${t}`;
}
function ringName(ring) {
  if (!ring) return '·';
  if (ring.kind === 'close') return 'EIGHT BELLS';
  return BELL_NAMES[ring.index] || `BELL ${ring.index + 1}`;
}
function ringCopy(ring) {
  if (ring.kind === 'close') return BELL_COPY[7];
  return BELL_COPY[ring.index] || BELL_COPY[0];
}
// Wall time of the closing bell on a given day: 4:00 on a regular day, 1:00 on an early-close day.
function closeWallOf(day, fallback = '·') {
  const rings = day ? ringsForDay(day) : [];
  return rings.length ? wallShort(rings[rings.length - 1].wall) : fallback;
}
function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}S AGO`;
  if (s < 3600) return `${Math.floor(s / 60)}M AGO`;
  if (s < 86_400) return `${Math.floor(s / 3600)}H AGO`;
  return `${Math.floor(s / 86_400)}D AGO`;
}
function agoShort(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

// ------------------------------------------------------------------ pixel glyphs
const ARROW_UP = ['...#....', '..###...', '.#####..', '...#....', '...#....', '...#....', '...#....', '........'];
const ARROW_DN = ['...#....', '...#....', '...#....', '...#....', '.#####..', '..###...', '...#....', '........'];
function pixelPath(rows, test) {
  const parts = [];
  for (let y = 0; y < rows.length; y += 1) {
    let x = 0;
    const row = rows[y];
    while (x < row.length) {
      if (test(row[x], x, y)) {
        let w = 1;
        while (x + w < row.length && test(row[x + w], x + w, y)) w += 1;
        parts.push(`M${x} ${y}h${w}v1h-${w}z`);
        x += w;
      } else x += 1;
    }
  }
  return parts.join('');
}
function arrowSvg(up) {
  const rows = up ? ARROW_UP : ARROW_DN;
  return `<svg class="px" width="8" height="8" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="${pixelPath(rows, (c) => c === '#')}"/></svg>`;
}

// Candle strips: deterministic pseudo random candles, red and green, drawn once per strip.
function candlesSvg(seed, count) {
  let s = seed * 7919 + 13;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const w = 8;
  const parts = [];
  let price = 22;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const move = (rnd() - 0.48) * 10;
    const close = clamp(open + move, 6, 38);
    const hi = Math.max(open, close) + rnd() * 5;
    const lo = Math.min(open, close) - rnd() * 5;
    const up = close >= open;
    const x = i * w;
    const top = Math.round(Math.min(open, close));
    const h = Math.max(1, Math.round(Math.abs(close - open)));
    const color = up ? '#66C800' : '#FC401F';
    parts.push(`<rect x="${x + 3}" y="${Math.round(44 - hi)}" width="1" height="${Math.max(1, Math.round(hi - lo))}" fill="${color}"/>`);
    parts.push(`<rect x="${x + 1}" y="${44 - top - h}" width="5" height="${h}" fill="${color}"/>`);
    price = close;
  }
  return `<svg width="${count * w}" height="44" viewBox="0 0 ${count * w} 44" shape-rendering="crispEdges" aria-hidden="true">${parts.join('')}</svg>`;
}
// enough candles to run edge to edge on the widest monitor the visitor could open the page on
const CANDLE_COUNT = Math.max(320, Math.ceil(Math.max(window.innerWidth, (window.screen && window.screen.width) || 0) / 8) + 8);
for (const strip of document.querySelectorAll('[data-candles]')) {
  strip.innerHTML = candlesSvg(Number(strip.dataset.candles) || 1, CANDLE_COUNT);
}

// ------------------------------------------------------------------ state
let STATE = null;
let stateSignature = '';
let pollTimer = null;
let lastRingKey = null;

function isDemo() {
  return Boolean(STATE?.bot?.mode === 'demo');
}
function stateAge(n) {
  const g = STATE?.generated_at ? Date.parse(STATE.generated_at) : NaN;
  if (Number.isNaN(g)) return Infinity;
  return n.getTime() - g;
}
function isStale(n, open) {
  // A bot that is not live (dry run, one-shot status) is not expected to refresh; the footer says DRY RUN.
  if (!STATE || isDemo() || STATE.bot?.live === false) return false;
  return stateAge(n) > (open ? STALE_OPEN_MS : STALE_CLOSED_MS);
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`state ${res.status}`);
  const json = await res.json();
  return json && typeof json === 'object' ? json : null;
}
// The desk first, the local copy second. After three misses in a row the desk is only tried every sixth
// poll, so a box that is not up yet (or a pre-launch page) does not throw a failed request every 20 seconds.
async function fetchState() {
  pollCount += 1;
  try {
    let json = null;
    if (USE_DESK && (deskFails < 3 || pollCount % 6 === 0)) {
      try { json = await fetchJson(DESK_STATE_URL); deskFails = 0; }
      catch (err) { deskFails += 1; console.warn('desk state unreachable', err.message); }
    }
    if (!json) json = await fetchJson(STATE_URL);
    STATE = json;
    const sig = JSON.stringify([STATE?.generated_at, STATE?.tape?.length, STATE?.race?.index, STATE?.drop?.ledger?.length]);
    if (sig !== stateSignature) {
      stateSignature = sig;
      renderStatic();
    }
  } catch (err) {
    console.warn('state.json not available yet', err.message);
  }
}

function schedulePoll(ms) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await fetchState();
    schedulePoll(currentOpen ? POLL_OPEN_MS : POLL_CLOSED_MS);
  }, ms);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { fetchState(); schedulePoll(currentOpen ? POLL_OPEN_MS : POLL_CLOSED_MS); }
});

// ------------------------------------------------------------------ sound
const sfx = { on: true, unlocked: false, lastTickSec: -1 };
try { sfx.on = localStorage.getItem('bell-sound') !== 'off'; } catch { /* fine */ }
root.dataset.sound = sfx.on ? 'on' : 'off';
el.soundToggle.setAttribute('aria-pressed', sfx.on ? 'true' : 'false');
function unlockAudio() { sfx.unlocked = true; }
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });
function play(audio) {
  if (!sfx.on || !sfx.unlocked || !audio) return;
  try {
    audio.currentTime = 0;
    const p = audio.play();
    if (p && p.catch) p.catch(() => { /* the browser said no, the bell still rings on screen */ });
  } catch { /* fine */ }
}
el.soundToggle.addEventListener('click', () => {
  sfx.on = !sfx.on;
  sfx.unlocked = true;
  root.dataset.sound = sfx.on ? 'on' : 'off';
  el.soundToggle.setAttribute('aria-pressed', sfx.on ? 'true' : 'false');
  try { localStorage.setItem('bell-sound', sfx.on ? 'on' : 'off'); } catch { /* fine */ }
  if (sfx.on) play(el.sfxTick);
});

// ------------------------------------------------------------------ the floor (full bleed frames scrubbed by scroll)
// The stage canvas covers the whole viewport under the ticker. Scroll progress through the hero
// runway picks the frame: the clip is a camera push from the wide floor to the bell, so scrolling
// walks the visitor in. The still paints first, the frames replace it as they arrive.
const floor = {
  set: null, manifest: null, frames: [], inflight: new Set(), loaded: 0, frame: 0, drawn: -1, drawnKind: '', dirty: true,
  ctx: el.floorCanvas.getContext('2d'), raf: 0, playStart: 0, playFrom: 0, playing: false, progress: 0, still: null,
};
const STILLS = {
  open: { srcset: 'assets/v2/hero-floor-1024.webp 1024w, assets/v2/hero-floor-1600.webp 1600w, assets/v2/hero-floor-2304.webp 2304w', jpg: 'assets/v2/hero-floor-1600.jpg', alt: 'The $BELL trading floor at the closing bell' },
  closed: { srcset: 'assets/v2/night-floor-1024.webp 1024w, assets/v2/night-floor-1600.webp 1600w', jpg: 'assets/v2/night-floor-1600.jpg', alt: 'The trading floor at night, the bell quiet, the pool still trading' },
};
function setStill(open) {
  const s = open ? STILLS.open : STILLS.closed;
  const img = el.floorStillImg;
  if (img.getAttribute('src') !== s.jpg) {
    img.setAttribute('srcset', s.srcset);
    img.setAttribute('src', s.jpg);
    img.alt = s.alt;
  }
  floor.still = img;
  if (img.complete && img.naturalWidth) requestFloorDraw();
  else img.addEventListener('load', requestFloorDraw, { once: true });
}
// The set follows the width the cover fit actually needs in device pixels: a 16:9 frame covering a
// 1440x900 window is 1600px wide, so a laptop gets the 1920 set, a small 1x window the 960 set, a
// tiny landscape window the 640 set, a retina laptop (a 14in MacBook needs about 3250 device px) the 2560 set,
// and only a window that needs more than 3300 device px (the 3440 ultrawide, a 4K monitor) the native 4K set.
// Frames are WebP at quality 80, so the 2560 set is about 24 MB for the whole runway and the 4K set about 38 MB. A phone in portrait gets the tall set, a 9:16 crop of the same
// clip, so the strip above the sheet shows the bell sharp instead of a stretched landscape frame.
function frameSetFor(open) {
  const base = open ? 'hero' : 'night';
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  if (w < 760 && h > w) return `${base}-tall`;
  const need = Math.max(w, (h * 16) / 9) * dpr;
  return `${base}${need <= 700 ? '-sm' : need <= 1100 ? '' : need <= 2000 ? '-xl' : need <= 3300 ? '-2k' : '-4k'}`;
}
function sizeCanvas() {
  const c = el.floorCanvas;
  const box = el.heroSticky.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(box.width * dpr));
  const h = Math.max(1, Math.round(box.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; floor.dirty = true; }
}
function setLoadBar() {
  const total = floor.manifest?.count || 0;
  const done = total ? floor.loaded >= total : true;
  el.console.classList.toggle('is-loading', !done);
  document.body.classList.toggle('loading', !done);
  if (!done) el.winLoadBar.style.width = `${Math.round((floor.loaded / total) * 100)}%`;
}
async function loadFloor(open) {
  const set = frameSetFor(open);
  if (floor.set === set) return;
  floor.set = set;
  floor.manifest = null;
  floor.frames = [];
  floor.inflight = new Set();
  floor.loaded = 0;
  floor.drawn = -1;
  floor.dirty = true;
  setStill(open);
  let man = null;
  try {
    const res = await fetch(`assets/frames/${set}/manifest.json`, { cache: 'force-cache' });
    if (res.ok) man = await res.json();
  } catch { man = null; }
  if (floor.set !== set) return; // superseded by a theme flip or a resize
  if (!man || !Number(man.count)) {
    // no frames on disk for this set: the still stays up
    setLoadBar();
    return;
  }
  floor.manifest = { count: Number(man.count), width: Number(man.width) || 1280, height: Number(man.height) || 720, pattern: man.pattern || 'f_%04d.jpg', fps: Number(man.fps) || 12 };
  floor.frames = new Array(floor.manifest.count).fill(null);
  setLoadBar();
  armPreload(set, floor.manifest);
}
// The frames wait for the first scroll or one second, whichever comes first, so the still stays the
// first paint and the page does not pull a few megabytes before anyone has read the headline.
let preloadArmed = null;
function armPreload(set, man) {
  const start = () => {
    if (preloadArmed !== start) return;
    preloadArmed = null;
    clearTimeout(timer);
    window.removeEventListener('scroll', start);
    preloadFrames(set, man);
  };
  preloadArmed = start;
  const timer = setTimeout(start, 1000);
  window.addEventListener('scroll', start, { passive: true });
}
function frameUrl(set, man, i) {
  const name = man.pattern.replace(/%0(\d)d/, (_, d) => String(i + 1).padStart(Number(d), '0'));
  return `assets/frames/${set}/${name}`;
}
// Scroll order, four at a time. The frame under the scroll position jumps the queue, so a fast
// scroll down the runway never waits on the frames it has already passed.
function preloadFrames(set, man) {
  let cursor = 0;
  const pickNext = () => {
    const want = floor.frame;
    if (want >= 0 && want < man.count && !floor.frames[want] && !floor.inflight.has(want)) return want;
    while (cursor < man.count && (floor.frames[cursor] || floor.inflight.has(cursor))) cursor += 1;
    return cursor < man.count ? cursor : -1;
  };
  const worker = () => {
    if (floor.set !== set) return;
    const i = pickNext();
    if (i < 0) return;
    floor.inflight.add(i);
    const img = new Image();
    img.decoding = 'async';
    const done = (ok) => {
      floor.inflight.delete(i);
      if (floor.set !== set) return;
      if (ok) floor.frames[i] = img;
      floor.loaded += 1;
      floor.dirty = true;
      setLoadBar();
      requestFloorDraw();
      worker();
    };
    img.onload = () => { if (img.decode) img.decode().then(() => done(true), () => done(true)); else done(true); };
    img.onerror = () => done(false);
    img.src = frameUrl(set, man, i);
  };
  for (let k = 0; k < 4; k += 1) worker();
}
function nearestLoaded(i) {
  const f = floor.frames;
  if (!f.length) return -1;
  for (let d = 0; d < f.length; d += 1) {
    if (f[i - d]) return i - d;
    if (f[i + d]) return i + d;
    if (i - d < 0 && i + d >= f.length) break;
  }
  return -1;
}
// Cover fit with a focal point. On a desktop the bell (the centre of the clip) is aimed at the
// middle of the open span between the console and the Ringer, so it never hides behind the window;
// the frame scales up just enough to shift. On a phone the sheet hides the bottom of the stage, so
// the frame fits the strip above the sheet, anchored a little below the top so the bell sits centred.
function drawCover(img) {
  const c = el.floorCanvas;
  const ctx = floor.ctx;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return false;
  const cw = c.width;
  const ch = c.height;
  const box = el.heroSticky.getBoundingClientRect();
  const k = box.width ? cw / box.width : 1;
  const ui = el.console.getBoundingClientRect();
  let x;
  let y;
  let dw;
  let dh;
  if (window.innerWidth < 760) {
    const strip = Math.max(Math.round(ch * 0.4), ch - Math.round(ui.height * k));
    const s = Math.max(cw / iw, strip / ih);
    dw = Math.round(iw * s);
    dh = Math.round(ih * s);
    x = Math.round((cw - dw) / 2);
    y = clamp(Math.round((strip - dh) * 0.12), strip - dh, 0);
  } else {
    const rg = el.ringer.getBoundingClientRect();
    const span = (ui.right + (rg.width ? rg.left : box.width)) / 2;
    const focal = box.width ? clamp(span / box.width, 0.5, 0.66) : 0.5;
    const s = Math.max(cw / iw, ch / ih, (2 * focal * cw) / iw);
    dw = Math.round(iw * s);
    dh = Math.round(ih * s);
    x = clamp(Math.round(focal * cw - dw / 2), cw - dw, 0);
    y = Math.round((ch - dh) * 0.45);
  }
  ctx.clearRect(0, 0, cw, ch);
  ctx.drawImage(img, x, y, dw, dh);
  if (root.dataset.floor !== 'canvas') root.dataset.floor = 'canvas';
  return true;
}
function drawFloor() {
  floor.raf = 0;
  sizeCanvas();
  const idx = floor.manifest ? nearestLoaded(floor.frame) : -1;
  if (idx >= 0) {
    if (idx === floor.drawn && floor.drawnKind === 'frame' && !floor.dirty) return;
    if (drawCover(floor.frames[idx])) { floor.drawn = idx; floor.drawnKind = 'frame'; floor.dirty = false; }
    return;
  }
  const still = floor.still;
  if (still && still.complete && still.naturalWidth) {
    if (floor.drawnKind === 'still' && !floor.dirty) return;
    if (drawCover(still)) { floor.drawn = -1; floor.drawnKind = 'still'; floor.dirty = false; }
  }
}
function requestFloorDraw() {
  if (!floor.raf) floor.raf = requestAnimationFrame(drawFloor);
}
function heroTravel() {
  return Math.max(1, el.hero.offsetHeight - el.heroSticky.offsetHeight);
}
function heroProgress() {
  const r = el.hero.getBoundingClientRect();
  const top = el.ticker ? el.ticker.offsetHeight : 36;
  return clamp((top - r.top) / heroTravel(), 0, 1);
}
function frameFromProgress(p) {
  const n = floor.manifest.count;
  return Math.min(n - 1, Math.floor(p * n));
}
function onScrollFloor() {
  floor.progress = heroProgress();
  if (!floor.manifest || floor.playing) return;
  floor.frame = frameFromProgress(floor.progress);
  requestFloorDraw();
}
// While the bell rings the clip plays on its own at 12 fps, out and back from wherever the scroll
// left it, so the camera never jumps.
function playLoop(t) {
  if (!floor.playing) return;
  if (floor.manifest) {
    const n = floor.manifest.count;
    const span = 2 * n - 2;
    const raw = (floor.playFrom + Math.floor(((t - floor.playStart) / 1000) * floor.manifest.fps)) % span;
    floor.frame = raw < n ? raw : span - raw;
    requestFloorDraw();
  }
  requestAnimationFrame(playLoop);
}
function setFloorPlaying(on) {
  if (floor.playing === on) return;
  floor.playing = on;
  if (on) { floor.playStart = performance.now(); floor.playFrom = floor.frame; requestAnimationFrame(playLoop); } else onScrollFloor();
}

// ------------------------------------------------------------------ coin rain
const rain = { ctx: el.rain.getContext('2d'), coins: [], until: 0, raf: 0 };
function sizeRain() {
  const box = el.heroSticky.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  if (el.rain.width !== w || el.rain.height !== h) { el.rain.width = w; el.rain.height = h; }
}
function spawnCoin() {
  // the rain scales with the stage, so a 3440 monitor gets coins and not specks
  const k = Math.max(1, el.rain.width / 1440);
  const size = Math.round([8, 12, 16][Math.floor(Math.random() * 3)] * k);
  rain.coins.push({ x: Math.random() * el.rain.width, y: -20 - Math.random() * 40, vy: 3 + Math.random() * 4 + size / 6, vx: (Math.random() - 0.5) * 1.5, size, spin: Math.random() * 20 });
}
function drawCoin(ctx, c, t) {
  const phase = Math.floor((t / 120 + c.spin) % 4);
  const s = c.size;
  const x = Math.round(c.x);
  const y = Math.round(c.y);
  const w = phase === 1 || phase === 3 ? Math.max(2, Math.round(s / 2)) : s;
  const ox = Math.round((s - w) / 2);
  ctx.fillStyle = '#C89A00';
  ctx.fillRect(x + ox, y, w, s);
  ctx.fillStyle = '#FFD12F';
  ctx.fillRect(x + ox + 1, y + 1, Math.max(1, w - 2), s - 2);
  if (w > 4) { ctx.fillStyle = '#FFF2A8'; ctx.fillRect(x + ox + 2, y + 2, Math.max(1, Math.round(w / 3)), Math.max(1, Math.round(s / 4))); }
}
function rainFrame(t) {
  rain.raf = 0;
  const ctx = rain.ctx;
  ctx.clearRect(0, 0, el.rain.width, el.rain.height);
  // one coin per 360px of width per frame, so a phone gets the same density as a desktop, not four times it
  if (t < rain.until) for (let i = 0, n = Math.max(1, Math.round(el.rain.width / 360)); i < n; i += 1) spawnCoin();
  const keep = [];
  for (const c of rain.coins) {
    c.y += c.vy;
    c.x += c.vx;
    if (c.y < el.rain.height + 20) { drawCoin(ctx, c, t); keep.push(c); }
  }
  rain.coins = keep;
  if (rain.coins.length || t < rain.until) rain.raf = requestAnimationFrame(rainFrame);
}
function startRain() {
  if (REDUCED) return;
  sizeRain();
  rain.until = performance.now() + RAIN_MS;
  if (!rain.raf) rain.raf = requestAnimationFrame(rainFrame);
}

// ------------------------------------------------------------------ parallax (small, whole pixels)
const parallaxEls = [...document.querySelectorAll('[data-parallax]')];
function onParallax() {
  if (REDUCED) return;
  const mid = window.innerHeight / 2;
  for (const p of parallaxEls) {
    const host = p.closest('section, footer') || p.parentElement;
    const r = host.getBoundingClientRect();
    if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
    const c = r.top + r.height / 2 - mid;
    const k = Number(p.dataset.parallax) || 0;
    p.style.transform = `translate(0, ${Math.round(-c * k)}px)`;
  }
}

// ------------------------------------------------------------------ clock
let currentOpen = false;
let marksSignature = '';
let gridSignature = '';
let clockFormat = '';

function silenceKind(n, todayKey, rings, next) {
  const holiday = closureName(todayKey);
  if (holiday) return { kind: 'holiday', reason: holiday };
  const wdIdx = keyToUtc(todayKey).getUTCDay();
  if (wdIdx === 0 || wdIdx === 6) return { kind: 'weekend', reason: null };
  if (rings.length && n < rings[0].at) return { kind: 'pre', reason: null };
  if (next && daysBetween(todayKey, next.day) > 1) {
    let d = todayKey;
    for (let i = 0; i < 14; i += 1) {
      d = dayKey(keyToUtc(d).getTime() + 86_400_000 + 43_200_000);
      if (d >= next.day) break;
      const name = closureName(d);
      if (name) return { kind: 'holiday', reason: name };
    }
    return { kind: 'weekend', reason: null };
  }
  return { kind: 'overnight', reason: null };
}

function buildClock(format) {
  if (clockFormat === format) return;
  clockFormat = format;
  const parts = format === 'long'
    ? '<span class="d" data-i="0"></span><span class="colon">:</span><span class="d" data-i="1"></span><span class="colon">:</span><span class="d" data-i="2"></span>'
    : '<span class="d" data-i="0"></span><span class="colon">:</span><span class="d" data-i="1"></span>';
  el.clockTime.innerHTML = parts;
  el.clockTime.classList.toggle('count--long', format === 'long');
}
function setClock(text) {
  const groups = text.split(':');
  buildClock(groups.length === 3 ? 'long' : 'short');
  el.clockTime.querySelectorAll('.d').forEach((span, i) => setText(span, groups[i] ?? '00'));
}

function computeMarks(n, todayKey, rings, next, ringingRing, sk) {
  let list = rings;
  let note = '';
  let dayForMarks = todayKey;
  if (!list.length && next) {
    list = ringsForDay(next.day);
    dayForMarks = next.day;
    note = sk?.kind === 'holiday'
      ? `NO BELL TODAY · ${String(sk.reason).toUpperCase()} · NEXT BELLS ${wd(next.day)}`
      : `NO BELL ON ${WEEKDAYS_LONG[keyToUtc(todayKey).getUTCDay()]} · NEXT BELLS ${wd(next.day)}`;
  } else if (list.length && n >= list[list.length - 1].at && !ringingRing) {
    note = `${list.length === 5 ? 'FIVE BELLS' : 'EIGHT BELLS'} · WATCH OVER · NEXT BELLS ${next ? wd(next.day) : '·'}`;
  } else if (list.length === 5) {
    note = 'EARLY CLOSE · FIVE BELLS · THE 1:00 BELL IS THE CLOSING BELL';
  }
  const jsonDay = STATE?.market?.day;
  const winners = new Map();
  const extras = new Map();
  if (Array.isArray(STATE?.bells) && (isDemo() || jsonDay === dayForMarks)) {
    for (const b of STATE.bells) {
      if (!b) continue;
      if (b.winner) winners.set(b.index, b.winner);
      if (b.gap_revealed_nvdac !== undefined || b.drop) extras.set(b.index, b);
    }
  }
  const states = list.map((r) => {
    if (ringingRing && ringingRing.day === r.day && ringingRing.index === r.index) return 'ringing';
    if (dayForMarks === todayKey && r.at <= n) return 'rung';
    if (next && next.day === r.day && next.index === r.index) return 'next';
    return 'pending';
  });
  return { list, states, note, dayForMarks, winners, extras };
}

function renderMarks(m) {
  const sig = `${m.dayForMarks}|${m.states.join(',')}|${[...m.winners.keys()].join(',')}`;
  if (sig !== marksSignature) {
    marksSignature = sig;
    el.bells.innerHTML = m.list.map((r, i) => {
      const w = m.winners.get(r.index);
      const title = `${ringName(r)} · ${r.wall}${w ? ` · WINNER ${esc(who(w))}` : ''}`;
      return `<div class="mark" data-state="${m.states[i]}" title="${title}"><div class="mark__ico"></div><div class="mark__time">${esc(wallShort(r.wall))}</div></div>`;
    }).join('');
  }
  if (m.note) { setText(el.bellsNote, m.note); el.bellsNote.hidden = false; } else el.bellsNote.hidden = true;
}

function renderBellGrid(m) {
  const sig = `${m.dayForMarks}|${m.states.join(',')}|${[...m.winners.keys()].join(',')}|${[...m.extras.keys()].join(',')}`;
  if (sig === gridSignature) return;
  gridSignature = sig;
  const five = m.list.length === 5;
  el.bellgrid.innerHTML = m.list.map((r, i) => {
    const [sub, line] = ringCopy(r);
    const st = m.states[i];
    const w = m.winners.get(r.index);
    const x = m.extras.get(r.index);
    let win = '';
    if (w) win = `<div class="bcard__win">WINNER ${esc(who(w))}${nvda(w.prize_nvdac) !== null ? ` · +${esc(nvda(w.prize_nvdac))} NVDAc` : ''}</div>`;
    else if (r.kind === 'open' && x && nvda(x.gap_revealed_nvdac) !== null) win = `<div class="bcard__win">GAP REVEALED +${esc(nvda(x.gap_revealed_nvdac))} NVDAc</div>`;
    else if (r.kind === 'close' && x?.drop && nvda(x.drop.dropped_nvdac) !== null) win = `<div class="bcard__win">DROPPED ${esc(nvda(x.drop.dropped_nvdac))} NVDAc ON ${esc(int(x.drop.holders_paid) ?? '·')} HOLDERS</div>`;
    const stateWord = st === 'rung' ? 'RUNG' : st === 'next' ? 'NEXT' : st === 'ringing' ? 'RINGING' : 'PENDING';
    return `<div class="bcard card" data-state="${st}">
      <div class="bcard__ico"></div>
      <div class="bcard__time">${esc(wallShort(r.wall))}</div>
      <div class="bcard__name">${esc(ringName(r))}</div>
      <div class="bcard__sub">${esc(sub)}</div>
      <p class="bcard__line">${esc(line)}</p>
      ${win}
      <div class="bcard__foot"><span class="pill pill--state">${stateWord}</span></div>
    </div>`;
  }).join('');
  setText(el.eightNote, five
    ? 'Early close today. Five bells, four races, one drop, and the 1:00 bell is Eight Bells. The desk swaps the pile and drops it at 1:00pm ET.'
    : "The NYSE rings twice a day. A ship rings eight times a watch. We took the ship's count and put it on the exchange clock. 9:30 to 4:00, eight rings, seven races, one drop.");
}

function tick() {
  const n = now();
  const todayKey = dayKey(n);
  const rings = ringsForDay(todayKey);
  const win = currentHourWindow(n);
  const next = nextRing(n);
  const prev = previousRing(n);
  const open = win !== null;
  currentOpen = open;

  let ringingRing = null;
  if (DEMO_RING) {
    ringingRing = prev || next;
  } else if (prev && n.getTime() - prev.at.getTime() < RING_MS) {
    ringingRing = prev;
  }
  const ringing = Boolean(ringingRing);
  const ringKey = ringingRing ? `${ringingRing.day}:${ringingRing.index}${DEMO_RING ? ':' + Math.floor(n.getTime() / RING_MS) : ''}` : null;
  if (ringKey && ringKey !== lastRingKey) {
    lastRingKey = ringKey;
    root.dataset.bell = '';
    requestAnimationFrame(() => { root.dataset.bell = 'ringing'; });
    play(el.sfxBell);
    startRain();
    setFloorPlaying(true);
    sprites.parade();
    if (!DEMO_RING) for (const ms of [5000, 15000, 30000, 60000]) setTimeout(fetchState, ms);
  } else if (!ringing && root.dataset.bell !== '') {
    root.dataset.bell = '';
    setFloorPlaying(false);
  }

  const market = themeOverride || (open ? 'open' : 'closed');
  if (root.dataset.market !== market) { root.dataset.market = market; tickerSignature = ''; }
  root.dataset.ringkind = ringingRing ? ringingRing.kind : '';
  const sk = open ? null : silenceKind(n, todayKey, rings, next);
  root.dataset.silence = sk ? sk.kind : '';
  const nextLbl = next ? ringLabel(next, todayKey) : '·';
  root.dataset.next = nextLbl;
  loadFloor(market === 'open');

  // state word
  const stateWord = ringing ? (ringingRing.kind === 'close' ? 'CLOSING BELL' : 'RINGING') : (open ? 'MARKET OPEN' : 'SILENCE');
  setText(el.heroMarket, stateWord);
  setText(el.tickerLive, ringing ? 'RINGING' : (open ? 'BELL LIVE' : 'SILENCE'));

  // countdown
  const msToNext = next ? next.at.getTime() - n.getTime() : 0;
  if (ringing && !DEMO_RING) setClock(open ? '00:00' : '00:00:00');
  else setClock(open ? mmss(msToNext) : hhmmss(msToNext));
  if (open && !ringing && msToNext > 0 && msToNext <= 10_500) {
    const sec = Math.floor(msToNext / 1000);
    if (sec !== sfx.lastTickSec) { sfx.lastTickSec = sec; play(el.sfxTick); }
  }

  // next line and meta
  const clock = nyClock(n);
  const potEst = nvda(STATE?.drop?.today?.pot_est_nvdac ?? STATE?.desk?.pot_est_nvdac);
  let meta;
  let nextLine;
  if (ringing && ringingRing.kind === 'close') {
    meta = `NEW YORK <b>${clock}</b> · CLOSING BELL · DROPPING <b>${potEst ? `${potEst} NVDAc` : '·'}</b>${potEst ? ' EST' : ''}`;
    nextLine = `<b>EIGHT BELLS</b> · <b>${esc(wallShort(ringingRing.wall))}</b> · GAVEL DOWN`;
  } else if (ringing) {
    meta = `NEW YORK <b>${clock}</b> · BELL <b>${esc(wallShort(ringingRing.wall))}</b> · RINGING`;
    nextLine = `<b>${ringName(ringingRing)}</b> · <b>${esc(wallShort(ringingRing.wall))}</b> · RINGING NOW`;
  } else if (open) {
    meta = `NEW YORK <b>${clock}</b> · MARKET OPEN${rings.length === 5 ? ' · EARLY CLOSE 1:00' : ''}`;
    nextLine = `NEXT BELL <b>${esc(nextLbl)}</b> · <b>${ringName(next)}</b>`;
  } else {
    const tail = sk?.kind === 'holiday' ? ` · ${esc(sk.reason.toUpperCase())}` : sk?.kind === 'weekend' ? ' · WEEKEND' : sk?.kind === 'pre' ? ' · PRE MARKET' : '';
    meta = `NEW YORK <b>${clock}</b> · SILENCE${tail}`;
    nextLine = `OPENING BELL <b>${esc(nextLbl)}</b> · <b>${ringName(next)}</b>`;
  }
  setHTML(el.clockMeta, meta);
  setHTML(el.clockNext, nextLine);

  // the gold line under the headline: the number the desk holds for the next drop
  const deskObj = STATE?.desk || {};
  const gapObj = STATE?.drop?.gap || {};
  let deskLine = '';
  if (ringing && ringingRing.kind === 'close') {
    const amountUsd = usd(STATE?.drop?.today?.pot_est_usd ?? deskObj.pot_est_usd);
    if (potEst) deskLine = `DROPPING ${potEst} NVDAc${amountUsd ? ` (${amountUsd})` : ''} ON EVERY HOLDER · GAVEL DOWN`;
  } else if (open || sk?.kind === 'pre') {
    const amountUsd = usd(STATE?.drop?.today?.pot_est_usd ?? deskObj.pot_est_usd);
    const closeWall = rings.length ? wallShort(rings[rings.length - 1].wall) : closeWallOf(next?.day);
    if (potEst) deskLine = `DESK HOLDS ${potEst} NVDAc${amountUsd ? ` (${amountUsd})` : ''} FOR THE ${closeWall} DROP`;
  } else {
    const gapAmt = nvda(gapObj.nvdac_est ?? deskObj.pot_est_nvdac);
    const gapUsd = usd(gapObj.usd_est ?? deskObj.pot_est_usd);
    if (gapAmt) deskLine = `GAP ${gapAmt} NVDAc${gapUsd ? ` (${gapUsd})` : ''} AND GROWING FOR THE ${next ? `${wd(next.day)} ${closeWallOf(next.day)}` : 'NEXT'} DROP`;
  }
  setText(el.heroDesk, deskLine);
  el.heroDesk.hidden = !deskLine;

  const marks = computeMarks(n, todayKey, rings, next, ringingRing, sk);
  renderMarks(marks);
  renderBellGrid(marks);
  renderTickerLive(n, todayKey, win, next, open, msToNext);
  renderPlate(n, todayKey, rings, win, next, prev, open, ringingRing, sk);
  renderSilence(n, todayKey, rings, next, prev, open, sk);
  renderFooterState(n, open);
  renderLedgerLive(n);
  if (tickerOpen !== open) { tickerOpen = open; renderTicker(); }
}

// ------------------------------------------------------------------ the ticker bar
let tickerSignature = '';
let tickerOpen = null;
let priceMemory = null;
try { priceMemory = JSON.parse(localStorage.getItem('bell-price-memory') || 'null'); } catch { priceMemory = null; }

function change(cur, key, explicit) {
  if (explicit !== undefined && explicit !== null && Number.isFinite(Number(explicit))) return Number(explicit);
  const c = Number(cur);
  const p = priceMemory && Number(priceMemory[key]);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}
function chgHtml(v) {
  const s = pct(v);
  if (s === null) return '<span class="flat">·</span>';
  if (v > 0) return `<span class="up">${arrowSvg(true)} ${esc(s)}</span>`;
  if (v < 0) return `<span class="dn">${arrowSvg(false)} ${esc(s.replace('-', ''))}</span>`;
  return `<span class="flat">0.0%</span>`;
}
function tkItem(ico, html) {
  return `<span class="tk"><i class="tk__ico">${esc(ico)}</i>${html}</span>`;
}
function renderTicker() {
  const n = now();
  const todayKey = dayKey(n);
  const open = currentHourWindow(n) !== null;
  const next = nextRing(n);
  const rings = ringsForDay(todayKey);
  const price = STATE?.price || {};
  const items = [];
  const nvdaChg = change(price.nvdac_usd, 'nvdac_usd', price.nvdac_change_pct);
  const bellChg = change(price.bell_usd, 'bell_usd', price.bell_change_pct);
  if (num(price.nvdac_usd, 2)) items.push(tkItem('N', `NVDAc <b>$${esc(num(price.nvdac_usd, 2))}</b> ${chgHtml(nvdaChg)}`));
  if (price.bell_nvdac) items.push(tkItem('B', `$BELL <b>${esc(price.bell_nvdac)} NVDAc</b>${price.bell_usd ? ` <span class="k">$${esc(price.bell_usd)}</span>` : ''} ${chgHtml(bellChg)}`));
  if (usd(price.mcap_usd)) items.push(tkItem('B', `MC <b>${esc(usd(price.mcap_usd))}</b>`));
  if (open) {
    items.push(tkItem('B', `NEXT BELL <b>${esc(next ? wallShort(next.wall) : '·')}</b> <span class="hot" data-live="next">·</span>`));
    items.push(tkItem('B', `RACE ENDS IN <span class="hot" data-live="ends">·</span>`));
    const race = STATE?.race;
    const leader = race?.leader || (Array.isArray(race?.buyers) ? race.buyers[0] : null);
    if (leader) items.push(tkItem('1', `LEADING NOW <b>${esc(who(leader))}</b> <span class="up">${arrowSvg(true)} ${esc(nvdaOr(leader.bought_nvdac))}</span>`));
    else items.push(tkItem('1', `LEADING NOW <b>NOBODY YET</b> <span class="k">FIRST BUY LEADS</span>`));
    const pot = nvda(STATE?.drop?.today?.pot_est_nvdac ?? STATE?.desk?.pot_est_nvdac);
    if (pot) items.push(tkItem('D', `DESK HOLDS <b>${esc(pot)} NVDAc</b> FOR THE CLOSE`));
    if (rings.length === 5) items.push(tkItem('!', `<span class="hot">EARLY CLOSE TODAY</span> FIVE BELLS. EIGHT BELLS RINGS AT 1:00.`));
  } else {
    const sk = silenceKind(n, todayKey, rings, next);
    if (sk.kind === 'holiday') items.push(tkItem('!', `NO BELL TODAY. <b>${esc(String(sk.reason).toUpperCase())}</b>.`));
    else items.push(tkItem('Z', `THE BELL IS QUIET`));
    items.push(tkItem('B', `NEXT BELL <b>${esc(next ? `${wallShort(next.wall)} ${wd(next.day)} ${MONTHS[keyToUtc(next.day).getUTCMonth()]} ${keyToUtc(next.day).getUTCDate()}` : '·')}</b> <span class="hot" data-live="next">·</span>`));
    const gap = STATE?.drop?.gap;
    const gapVal = gap && nvda(gap.nvdac_est) !== null ? nvda(gap.nvdac_est) : nvda(STATE?.desk?.pot_est_nvdac);
    if (gapVal) items.push(tkItem('D', `GAP <b>${esc(gapVal)} NVDAc</b> <span class="up">${arrowSvg(true)} AND GROWING</span>`));
    items.push(tkItem('P', `POOL STILL TRADING. EVERY FEE STACKS THE NEXT DROP.`));
  }
  const last = STATE?.drop?.last || (Array.isArray(STATE?.drop?.ledger) ? STATE.drop.ledger[0] : null);
  if (last && nvda(last.dropped_nvdac) !== null) items.push(tkItem('D', `LAST DROP <b>${esc(nvda(last.dropped_nvdac))} NVDAc</b> ON <b>${esc(int(last.holders_paid) ?? '·')}</b> HOLDERS`));
  const feed = Array.isArray(STATE?.tape) ? STATE.tape.filter((t) => t && (t.type === 'buy' || t.type === 'sell')).slice(0, 8) : [];
  for (const t of feed) {
    const up = t.type === 'buy';
    items.push(tkItem(up ? 'B' : 'S', `${up ? 'BUY' : 'SELL'} <b>${esc(who(t))}</b> <span class="${up ? 'up' : 'dn'}">${arrowSvg(up)} ${esc(nvdaOr(t.nvdac))}</span>`));
  }
  if (!items.length) items.push(tkItem('B', 'EIGHT BELLS A DAY ON THE NEW YORK CLOCK'));
  const html = items.join('');
  const sig = `${open}|${root.dataset.market}|${html}|${window.innerWidth}`;
  if (sig === tickerSignature) return;
  tickerSignature = sig;
  el.tickerTrack.innerHTML = html;
  const single = el.tickerTrack.scrollWidth || 1;
  const need = Math.max(2, Math.ceil((2 * window.innerWidth) / single));
  const copies = need % 2 === 0 ? need : need + 1;
  el.tickerTrack.innerHTML = html.repeat(copies);
  // 72px per second, 12 steps per second, whatever the width of the track
  const half = (el.tickerTrack.scrollWidth || single * copies) / 2;
  const seconds = Math.max(16, half / 72);
  el.tickerTrack.style.animationDuration = `${seconds.toFixed(1)}s`;
  el.tickerTrack.style.animationTimingFunction = `steps(${Math.round(seconds * 12)})`;
  const cur = { nvdac_usd: Number(price.nvdac_usd), bell_usd: Number(price.bell_usd) };
  try { if (Number.isFinite(cur.nvdac_usd)) localStorage.setItem('bell-price-memory', JSON.stringify(cur)); } catch { /* fine */ }
}
function renderTickerLive(n, todayKey, win, next, open, msToNext) {
  const nextText = open ? mmss(msToNext) : hhmmss(msToNext);
  const endsText = win ? mmss(win.end.getTime() - n.getTime()) : '·';
  for (const s of el.tickerTrack.querySelectorAll('[data-live="next"]')) setText(s, nextText);
  for (const s of el.tickerTrack.querySelectorAll('[data-live="ends"]')) setText(s, endsText);
}

// ------------------------------------------------------------------ the plate
function prizeText(race) {
  const est = race?.prize_nvdac_est;
  const firm = race?.prize_nvdac;
  if (firm !== undefined && firm !== null && nvda(firm) !== null) return `+${nvda(firm)} NVDAc`;
  if (est !== undefined && est !== null && nvda(est) !== null) return `+${nvda(est)} NVDAc EST`;
  return '';
}
function prizeHtml(race) {
  const text = prizeText(race);
  return text ? `<span class="label">PRIZE</span>${esc(text)}` : '';
}
function raceIsCurrent(race, win) {
  if (!race || !win) return false;
  if (isDemo()) return true;
  const end = race.end ? Date.parse(race.end) : NaN;
  if (!Number.isNaN(end) && end === win.end.getTime()) return true;
  return race.index === win.index && (STATE?.market?.day === win.day);
}

function renderPlate(n, todayKey, rings, win, next, prev, open, ringingRing, sk) {
  const label = el.plateLabel;
  let cta = 'BEAT IT';
  if (open) {
    const race = STATE?.race;
    const current = raceIsCurrent(race, win);
    const leader = current ? (race.leader || (Array.isArray(race.buyers) ? race.buyers[0] : null)) : null;
    const ends = mmss(win.end.getTime() - n.getTime());
    if (ringingRing && ringingRing.kind !== 'open') {
      setText(label, `BELL ${wallShort(ringingRing.wall)} · SETTLING`);
      el.plateLive.hidden = false;
    } else {
      setText(label, `LEADING NOW · ${wallShort(win.startsAt.wall)} TO ${wallShort(win.endsAt.wall)}`);
      el.plateLive.hidden = !leader;
    }
    if (leader) {
      setCell(el.plateRank, String(leader.rank || 1));
      setText(el.plateWho, who(leader));
      setCell(el.plateSize, leader.bought_nvdac ? `NVDAc PAID ${nvda(leader.bought_nvdac)}${leader.buys ? ` · ${int(leader.buys)} BUY${Number(leader.buys) === 1 ? '' : 'S'}` : ''}` : '');
    } else if (current) {
      setCell(el.plateRank, '');
      setText(el.plateWho, 'NO BUYS YET · FIRST BUY LEADS');
      setCell(el.plateSize, '');
      cta = 'TAKE IT';
    } else {
      setCell(el.plateRank, '');
      setText(el.plateWho, STATE ? 'WAITING FOR THE DESK' : 'WAITING FOR THE BOT');
      setCell(el.plateSize, '');
      cta = 'BUY $BELL';
    }
    setCellHTML(el.platePrize, prizeHtml(current ? race : null));
    setHTML(el.plateEnds, `<span class="label">ENDS IN</span>${ends}`);
    el.plateEnds.hidden = false;
  } else {
    const lr = STATE?.last_race;
    const w = lr?.winner || null;
    setText(label, `LAST BELL${lr ? ` · ${wd(lr.day)} ${wallShort(lr.wall)}` : ''}`);
    el.plateLive.hidden = true;
    if (w) {
      setCell(el.plateRank, '1');
      setText(el.plateWho, who(w));
      setCell(el.plateSize, w.bought_nvdac ? `NVDAc PAID ${nvda(w.bought_nvdac)}` : '');
      setCellHTML(el.platePrize, prizeHtml({ prize_nvdac: w.prize_nvdac }));
    } else {
      setCell(el.plateRank, '');
      setText(el.plateWho, sk?.kind === 'pre' ? 'DESK OPENS AT THE FIRST BELL' : 'NO BELL RUNG YET');
      setCell(el.plateSize, '');
      setCellHTML(el.platePrize, '');
    }
    const nextRace = next ? `${ringLabel(next, todayKey)}` : '';
    setCellHTML(el.plateEnds, nextRace ? `<span class="label">NEXT RACE</span>${esc(nextRace)}` : '');
    cta = 'BUY $BELL';
  }
  if (!STATE?.token?.address) {
    // Nothing to buy yet: the board home has no BELL on it, so the button waits on the pair section.
    cta = 'NOT LAUNCHED YET';
    el.plateCta.href = '#pair';
    el.plateCta.removeAttribute('target');
    el.plateCta.setAttribute('aria-disabled', 'true');
  } else {
    el.plateCta.removeAttribute('aria-disabled');
    if (!el.plateCta.getAttribute('target')) el.plateCta.setAttribute('target', '_blank');
  }
  setText(el.plateCta, cta);
  renderReceipt(n, todayKey, rings, next, prev, open, sk);
}

function setStat(node, label, value, sub, waiting) {
  setText(node.querySelector('.stat__label'), label);
  setText(node.querySelector('.stat__value'), value);
  setText(node.querySelector('.stat__sub'), sub);
  node.classList.toggle('stat--waiting', Boolean(waiting));
}

function renderReceipt(n, todayKey, rings, next, prev, open, sk) {
  const drop = STATE?.drop || {};
  const last = drop.last || (Array.isArray(drop.ledger) ? drop.ledger[0] : null) || null;
  const closeRing = rings.length ? rings[rings.length - 1] : null;
  const closeWall = closeRing ? wallShort(closeRing.wall) : closeWallOf(next?.day);

  // 1. last drop
  if (last && nvda(last.dropped_nvdac) !== null) {
    setStat(el.statLast, 'LAST DROP (NVDAc)', nvda(last.dropped_nvdac),
      `${wd(last.day)} ${last.wall ? wallShort(last.wall) : closeWallOf(last.day)} · ${int(last.holders_paid) ?? '·'} PAID${last.record ? ' · RECORD' : ''}`, false);
  } else {
    let firstCloseDay = todayKey;
    if (!rings.length || n >= rings[rings.length - 1].at) firstCloseDay = next ? next.day : todayKey;
    setStat(el.statLast, 'LAST DROP (NVDAc)', '·', `FIRST EIGHT BELLS ${wd(firstCloseDay)} ${closeWallOf(firstCloseDay, closeWall)}`, true);
  }

  // 2. today's desk, or the gap in silence
  const today = drop.today || {};
  const desk = STATE?.desk || {};
  const pot = today.pot_est_nvdac ?? desk.pot_est_nvdac ?? null;
  const gap = drop.gap || {};
  if (open || sk?.kind === 'pre') {
    const potUsd = usd(today.pot_est_usd ?? desk.pot_est_usd);
    setStat(el.statDesk, "TODAY'S DESK (NVDAc)", nvda(pot) ?? '·',
      `${potUsd ? `${potUsd} EST · ` : ''}SO FAR · DROPS AT ${closeWall} ET`, nvda(pot) === null);
  } else {
    const gapVal = gap.nvdac_est ?? pot;
    const since = prev ? `${wd(prev.day)} ${wallShort(prev.wall)}` : '·';
    setStat(el.statDesk, 'THE GAP (NVDAc)', nvda(gapVal) ?? '·',
      `BUILDING SINCE ${since} · OPENS ${next ? ringLabel(next, todayKey) : '·'}`, nvda(gapVal) === null);
  }

  // 3. holders
  const holders = today.holders_eligible ?? desk.holders_eligible ?? STATE?.price?.holders ?? null;
  const perM = today.per_million_bell_nvdac_est ?? desk.per_million_bell_nvdac_est ?? null;
  setStat(el.statHolders, 'HOLDERS', int(holders) ?? '·',
    perM !== null && nvda(perM) !== null ? `ELIGIBLE · ${num(perM, 4)} NVDAc PER 1M BELL EST` : 'ELIGIBLE FOR THE DROP', int(holders) === null);
}

// ------------------------------------------------------------------ the silence card
function renderSilence(n, todayKey, rings, next, prev, open, sk) {
  const gap = STATE?.drop?.gap || {};
  const desk = STATE?.desk || {};
  const closeRing = rings.length ? rings[rings.length - 1] : null;
  if (open) {
    const revealed = gap.state === 'revealed' && nvda(gap.nvdac_est) !== null;
    setText(el.gapLabel, revealed ? 'THE LAST GAP' : 'THE GAP');
    setText(el.gapValue, revealed ? nvda(gap.nvdac_est) : (nvda(desk.pot_est_nvdac) ?? '·'));
    setText(el.gapUnit, revealed ? `NVDAc · REVEALED AT THE FIRST BELL${gap.reason ? ` · ${String(gap.reason).toUpperCase()}` : ''}` : 'NVDAc ON THE DESK SO FAR');
    setText(el.gapMeta, closeRing ? `THE BELL GOES QUIET AT ${wallShort(closeRing.wall)} ET · THE POOL KEEPS TRADING` : 'THE POOL KEEPS TRADING');
    setHTML(el.gapClock, closeRing ? `EIGHT BELLS IN <b>${hhmmss(closeRing.at.getTime() - n.getTime())}</b>` : '·');
  } else {
    const gapVal = gap.nvdac_est ?? desk.pot_est_nvdac ?? null;
    setText(el.gapLabel, 'THE GAP');
    setText(el.gapValue, nvda(gapVal) ?? '·');
    setText(el.gapUnit, nvda(gapVal) !== null ? 'NVDAc AND GROWING' : 'BUILDING · THE DESK READS IT AT THE FIRST BELL');
    const since = prev ? `${wd(prev.day)} ${wallShort(prev.wall)}` : '·';
    const reason = sk?.kind === 'holiday' ? ` · ${String(sk.reason).toUpperCase()}` : sk?.kind === 'weekend' ? ' · WEEKEND' : '';
    setText(el.gapMeta, `BUILDING SINCE ${since}${reason} · OPENS ${next ? ringLabel(next, todayKey) : '·'}`);
    setHTML(el.gapClock, next ? `NEXT BELL IN <b>${hhmmss(next.at.getTime() - n.getTime())}</b>` : '·');
  }
}

// ------------------------------------------------------------------ ledger
function ledgerRow(d) {
  const feesBell = bellAmt(d.fees_bell);
  const record = d.record ? ' <span class="pill pill--gold pill--state">RECORD</span>' : '';
  const tx = d.tx ? `<a href="https://basescan.org/tx/${encodeURIComponent(d.tx)}" target="_blank" rel="noopener">${esc(short(d.tx))}</a>` : (d.dry_run ? 'DRY RUN' : '·');
  const skipped = int(d.holders_skipped);
  // the BELL side of the fees and what it swapped to sit under the NVDAc fees, one line
  const swapped = nvda(d.swapped_nvdac);
  const feesSub = feesBell && swapped !== null ? `${feesBell} BELL SWAPPED TO ${swapped}` : feesBell ? `${feesBell} BELL` : swapped !== null ? `${swapped} SWAPPED` : '';
  return `<tr>
    <td class="day">${esc(dayLabel(d.day))}<span class="sub">${esc(d.wall ? wallShort(d.wall) : closeWallOf(d.day))} ET</span></td>
    <td class="num big">${esc(nvda(d.dropped_nvdac) ?? '·')}${record}</td>
    <td class="num">${esc(usd(d.dropped_usd) ?? '·')}</td>
    <td class="num">${esc(int(d.holders_paid) ?? '·')}${skipped && skipped !== '0' ? `<span class="sub">${esc(skipped)} SKIPPED</span>` : ''}</td>
    <td class="num">${esc(nvda(d.fees_nvdac) ?? '·')}${feesSub ? `<span class="sub">${esc(feesSub)}</span>` : ''}</td>
    <td class="num opt">${esc(d.per_million_bell_nvdac !== undefined && d.per_million_bell_nvdac !== null ? num(d.per_million_bell_nvdac, 4) : '·')}</td>
    <td class="opt">${tx}</td>
  </tr>`;
}
const LEDGER_COLS = 7;
function silenceRow(fromKey, toKey, reason, extra) {
  const label = fromKey === toKey ? dayLabel(fromKey) : `${dayLabel(fromKey)} TO ${dayLabel(toKey)}`;
  return `<tr class="silence"><td colspan="${LEDGER_COLS}">${esc(label)} · SILENCE${reason ? ` · ${esc(reason.toUpperCase())}` : ''}${extra ? ` · ${extra}` : ''}</td></tr>`;
}
function gapBetween(olderKey, newerKey) {
  // the closed days strictly between two drop days, if any
  const days = daysBetween(olderKey, newerKey);
  if (days <= 1) return null;
  let first = null;
  let last = null;
  let reason = null;
  for (let i = 1; i < days; i += 1) {
    const k = dayKey(keyToUtc(olderKey).getTime() + i * 86_400_000 + 43_200_000);
    if (isMarketDay(k)) continue;
    if (!first) first = k;
    last = k;
    const name = closureName(k);
    if (name) reason = name;
  }
  if (!first) return null;
  return { first, last, reason };
}

function renderLedger() {
  const n = now();
  const todayKey = dayKey(n);
  const rows = Array.isArray(STATE?.drop?.ledger) ? STATE.drop.ledger.filter((d) => d && d.day) : [];
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  const out = [];
  const rings = ringsForDay(todayKey);
  const open = currentHourWindow(n) !== null;
  const todaySettled = sorted.some((d) => d.day === todayKey);
  if (!todaySettled && rings.length && n < rings[rings.length - 1].at) {
    const closeWall = wallShort(rings[rings.length - 1].wall);
    out.push(`<tr class="silence" id="ledger-today"><td colspan="${LEDGER_COLS}">${esc(dayLabel(todayKey))} · EIGHT BELLS ${esc(closeWall)} ET · DROPPING IN <span id="ledger-today-in">·</span> · <span id="ledger-today-pot">·</span></td></tr>`);
    if (sorted.length && sorted[0].day < todayKey) {
      const g = gapBetween(sorted[0].day, todayKey);
      const gap = STATE?.drop?.gap;
      const amount = gap && nvda(gap.nvdac_est) !== null ? `GAP +${nvda(gap.nvdac_est)} NVDAc · REVEALED AT THE FIRST BELL` : 'THE POOL KEPT TRADING';
      if (g) out.push(silenceRow(g.first, g.last, g.reason, esc(amount)));
    }
  } else if (!open && sorted.length && sorted[0].day < todayKey) {
    const gap = STATE?.drop?.gap;
    const nextR = nextRing(n);
    const g = gapBetween(sorted[0].day, nextR ? nextR.day : todayKey);
    const amount = gap && nvda(gap.nvdac_est) !== null ? `GAP +${nvda(gap.nvdac_est)} NVDAc` : 'GAP BUILDING';
    if (g) out.push(silenceRow(g.first, g.last, g.reason, `${esc(amount)} · INTO ${esc(nextR ? `${wd(nextR.day)} ${closeWallOf(nextR.day)}` : '·')}`));
  }
  for (let i = 0; i < sorted.length; i += 1) {
    out.push(ledgerRow(sorted[i]));
    const older = sorted[i + 1];
    if (older) {
      const g = gapBetween(older.day, sorted[i].day);
      if (g) out.push(silenceRow(g.first, g.last, g.reason, 'THE POOL KEPT TRADING'));
    }
  }
  if (!sorted.length) {
    const nextR = nextRing(n);
    out.push(`<tr class="empty"><td colspan="${LEDGER_COLS}">NO DROP YET · THE FIRST EIGHT BELLS ${esc(nextR ? `${wd(nextR.day)} ${closeWallOf(nextR.day)}` : '·')} ET WRITES THE FIRST ROW</td></tr>`);
  }
  el.ledgerBody.innerHTML = out.join('');
  const total = sorted.reduce((acc, d) => acc + (Number(d.dropped_nvdac) || 0), 0);
  const rec = STATE?.drop?.record;
  setText(el.dropSum, sorted.length ? `${sorted.length} DROP${sorted.length === 1 ? '' : 'S'} · ${nvda(total)} NVDAc DROPPED` : 'NO DROP YET');
  if (rec && nvda(rec.dropped_nvdac) !== null) {
    setText(el.dropRecord, `RECORD ${nvda(rec.dropped_nvdac)} NVDAc · ${wd(rec.day)} ${MONTHS[keyToUtc(rec.day).getUTCMonth()]} ${keyToUtc(rec.day).getUTCDate()}`);
    el.dropRecord.hidden = false;
  } else el.dropRecord.hidden = true;
}
function renderLedgerLive(n) {
  const inEl = $('ledger-today-in');
  if (!inEl) return;
  const rings = ringsForDay(dayKey(n));
  if (!rings.length) return;
  setText(inEl, hhmmss(rings[rings.length - 1].at.getTime() - n.getTime()));
  const pot = nvda(STATE?.drop?.today?.pot_est_nvdac ?? STATE?.desk?.pot_est_nvdac);
  setText($('ledger-today-pot'), pot ? `${pot} NVDAc EST` : 'POT NOT READ YET');
}

// ------------------------------------------------------------------ the ringer wall
// A Basename prints as its handle on one line with the suffix as a small tag under it, so it never truncates.
function tileWho(o) {
  const name = o?.name;
  if (name && /\.base\.eth$/i.test(name)) {
    return `<span class="tile__handle">${esc(name.replace(/\.base\.eth$/i, ''))}</span><span class="tile__ens">.BASE.ETH</span>`;
  }
  return esc(who(o));
}
function medalFor(rank, closing) {
  const r = String(rank || '').toUpperCase();
  const name = r === 'EIGHT BELLS' ? 'gold' : (r === 'THE GAVEL' || closing) ? 'silver' : 'blue';
  return `<img class="tile__medal" src="assets/v2/medal-${name}-128.png" width="128" height="128" alt="" loading="lazy" decoding="async">`;
}
function renderWall() {
  const wall = Array.isArray(STATE?.ringers?.wall) ? STATE.ringers.wall.filter((w) => w && w.address) : [];
  const today = Array.isArray(STATE?.ringers?.today) ? STATE.ringers.today : [];
  const todayMap = new Map();
  for (const t of today) if (t && t.address) todayMap.set(t.address.toLowerCase(), t);
  const count = STATE?.ringers?.count ?? wall.length;
  // bells_rung in the state file counts bells that had a winner, so the label says WON, not RUNG
  const won = STATE?.ringers?.bells_rung ?? wall.reduce((a, w) => a + (Number(w.bells) || 0), 0);
  setText(el.ringersSum, wall.length
    ? `${int(count)} WALLET${count === 1 ? '' : 'S'} HAVE TAKEN A BELL · ${int(won)} BELL${won === 1 ? '' : 'S'} WON`
    : 'NOBODY HAS TAKEN A BELL YET');
  if (!wall.length) {
    const n = now();
    const nextR = nextRing(n);
    let raceLine = 'FIRST RACE 9:30 TO 10:00 ET · SETTLED AT THE 10:00 BELL';
    if (nextR) {
      const dayRings = ringsForDay(nextR.day);
      const startR = nextR.kind === 'open' ? nextR : dayRings[nextR.index - 1];
      const endR = nextR.kind === 'open' ? dayRings[1] : nextR;
      if (startR && endR) raceLine = `NEXT RACE ${ringLabel(startR, dayKey(n))} TO ${wallShort(endR.wall)} ET · SETTLED AT THE ${wallShort(endR.wall)} BELL`;
    }
    el.wall.innerHTML = `<div class="tile card tile--waiting"><div class="tile__line label">THE WALL IS EMPTY</div><div class="tile__rank label">${esc(raceLine)} · BIGGEST BUYER BY NVDAc PAID TAKES THE FIRST MEDAL</div></div>`;
    return;
  }
  const sorted = [...wall].sort((a, b) => {
    const ta = todayMap.has(a.address.toLowerCase()) ? 1 : 0;
    const tb = todayMap.has(b.address.toLowerCase()) ? 1 : 0;
    if (ta !== tb) return tb - ta;
    return (Number(b.bells) || 0) - (Number(a.bells) || 0);
  });
  el.wall.innerHTML = sorted.slice(0, 48).map((w) => {
    const t = todayMap.get(w.address.toLowerCase());
    const closing = Number(w.closing_bells) > 0;
    const bells = Number(w.bells) || 0;
    const line = `${bells} BELL${bells === 1 ? '' : 'S'}${closing ? ` · ${int(w.closing_bells)} CLOSING` : ''}`;
    const best = w.best && nvda(w.best.bought_nvdac) !== null ? `BEST ${nvda(w.best.bought_nvdac)} NVDAc · ${esc(wallShort(w.best.wall))}` : '·';
    const wonLine = nvda(w.won_nvdac_total) !== null ? `<div class="tile__line label">WON ${nvda(w.won_nvdac_total)} NVDAc</div>` : '';
    const todayPill = t ? `<span class="pill pill--green pill--state tile__today">TOOK ${esc(wallShort(t.wall))} TODAY</span>` : '';
    return `<div class="tile card${t ? ' tile--today' : ''}" title="${esc(w.address)}">
      <div class="tile__head">${medalFor(w.rank, closing)}<div class="tile__who">${tileWho(w)}</div></div>
      <div class="tile__rank label">${esc(w.rank || 'BELL RINGER')}</div>
      <div class="tile__line label">${line}</div>
      <div class="tile__line label">${best}</div>${wonLine}${todayPill}
    </div>`;
  }).join('');
}

// ------------------------------------------------------------------ the pair, nav, footer
function renderFacts() {
  const token = STATE?.token || {};
  const links = STATE?.links || {};
  const price = STATE?.price || {};
  const addr = token.address || null;
  const pool = token.pool || null;
  setText(el.factToken, addr || 'NOT LAUNCHED YET · THE ADDRESS PRINTS HERE AT LAUNCH');
  setText(el.factPool, pool ? `UNISWAP V3 · ${pool}` : '·');
  setText(el.coinCa, addr ? short(addr) : 'SOON');
  for (const b of [el.copyToken, el.copyToken2]) { b.dataset.copy = addr || ''; b.disabled = !addr; }
  el.copyPool.dataset.copy = pool || '';
  el.copyPool.disabled = !pool;
  if (token.total_supply) setText(el.factSupply, `${int(token.total_supply)} · FIXED · NO MINT`);
  const bits = [];
  if (price.bell_nvdac) bits.push(`$BELL ${price.bell_nvdac} NVDAc`);
  if (price.bell_usd) bits.push(`$${price.bell_usd}`);
  if (usd(price.mcap_usd)) bits.push(`MC ${usd(price.mcap_usd)}`);
  if (num(price.nvdac_usd, 2)) bits.push(`NVDAc $${num(price.nvdac_usd, 2)}`);
  setText(el.factPrice, bits.length ? bits.join(' · ') : '·');
  setText(el.coinMc, usd(price.mcap_usd) ?? '·');
  const chg = change(price.bell_usd, 'bell_usd', price.bell_change_pct);
  const chgText = pct(chg);
  setText(el.coinChg, chgText ?? '');
  el.coinChg.className = `coin__chg${chg > 0 ? ' up' : chg < 0 ? ' dn' : ''}`;
  const launched = token.launched_at ? Date.parse(token.launched_at) : NaN;
  setText(el.coinAge, Number.isNaN(launched) ? 'not launched yet' : agoShort(now().getTime() - launched));
  setText(el.coinBy, STATE?.desk?.address ? short(STATE.desk.address) : 'the desk');
  const stonks = links.stonks || (addr ? `https://www.thestonks.exchange/token/${addr}` : STONKS_HOME);
  for (const a of [el.linkStonks, el.plateCta, el.navBuy, el.heroBuy, el.fStonks]) a.href = stonks;
  const dex = links.dexscreener || (pool ? `https://dexscreener.com/base/${pool}` : 'https://dexscreener.com/base');
  el.linkDex.href = dex;
  el.fDex.href = dex;
  el.linkGecko.href = pool ? `https://www.geckoterminal.com/base/pools/${pool}` : 'https://www.geckoterminal.com/base/pools';
  el.linkGmgn.href = addr ? `https://gmgn.ai/base/token/${addr}` : 'https://gmgn.ai/base';
  el.linkScanToken.href = links.basescan_token || (addr ? `https://basescan.org/token/${addr}` : 'https://basescan.org/');
  el.linkScanPool.href = links.basescan_pool || (pool ? `https://basescan.org/address/${pool}` : 'https://basescan.org/');
  el.fScan.href = el.linkScanToken.href;
  el.linkSite.href = links.site || 'https://bellonbase.fun';
  // social buttons show only once the handle exists; a bare host is not a link
  if (links.x) { el.linkX.href = links.x; el.footerX.href = links.x; }
  el.linkX.hidden = !links.x;
  el.footerX.hidden = !links.x;
  if (links.telegram) { el.footerTg.href = links.telegram; el.footerJoin.href = links.telegram; }
  el.footerTg.hidden = !links.telegram;
  el.footerJoin.hidden = !links.telegram;
  setText(el.navCaShort, addr ? short(addr) : 'SOON');
  el.navCa.dataset.copy = addr || '';
  const years = STATE?.meta?.schedule_verified_years;
  setText(el.footerYears, Array.isArray(years) && years.length ? years.join(', ') : VERIFIED_YEARS.join(', '));
}

function renderFooterState(n, open) {
  if (!STATE) { setText(el.footerState, 'STATE · WAITING FOR THE BOT · THE CLOCK RUNS ON ITS OWN'); return; }
  if (STATE.bot?.mode === 'prelaunch') { setText(el.footerState, 'STATE · NOT LAUNCHED YET · THE CLOCK RUNS ON ITS OWN'); return; }
  const g = STATE.generated_at ? Date.parse(STATE.generated_at) : NaN;
  const bits = ['STATE'];
  if (isDemo()) bits.push('DEMO DATA');
  if (!Number.isNaN(g)) bits.push(nyClock(new Date(g)));
  if (STATE.generated_block) bits.push(`BLOCK ${int(STATE.generated_block)}`);
  if (!Number.isNaN(g)) bits.push(isDemo() ? 'NOT LIVE' : ago(n.getTime() - g));
  if (isStale(n, open)) bits.push('STALE');
  if (STATE.bot?.mode === 'dry-run') bits.push('DRY RUN');
  setText(el.footerState, bits.join(' · '));
}

function renderStatic() {
  tickerSignature = '';
  renderTicker();
  renderLedger();
  renderWall();
  renderFacts();
}

// ------------------------------------------------------------------ interactions
async function copyText(text, button) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const prev = button.innerHTML;
    button.innerHTML = 'COPIED';
    setTimeout(() => { button.innerHTML = prev; }, 1000);
  } catch {
    window.prompt('Copy the address', text);
  }
}
for (const b of document.querySelectorAll('.copy')) b.addEventListener('click', () => copyText(b.dataset.copy, b));
el.navCa.addEventListener('click', () => copyText(el.navCa.dataset.copy, el.navCa));
el.readTape.href = '#drop';

function menuOpen() { return el.nav.dataset.menu === 'open'; }
function setMenu(open, focusTarget) {
  el.nav.dataset.menu = open ? 'open' : '';
  el.navMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (focusTarget) focusTarget.focus();
}
el.navMenu.addEventListener('click', () => {
  const open = !menuOpen();
  setMenu(open, open && el.navMenu.matches(':focus-visible') ? el.navLinks.querySelector('a') : null);
});
el.navLinks.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuOpen()) setMenu(false, el.navMenu);
});
document.addEventListener('click', (e) => {
  if (menuOpen() && !el.nav.contains(e.target)) setMenu(false);
});

function previewLabel() {
  const showing = root.dataset.market;
  if (themeOverride) return 'PREVIEW OFF';
  return showing === 'open' ? 'PREVIEW SILENCE' : 'PREVIEW OPEN';
}
el.previewToggle.addEventListener('click', () => {
  if (themeOverride) themeOverride = null;
  else themeOverride = root.dataset.market === 'open' ? 'closed' : 'open';
  try {
    if (themeOverride) sessionStorage.setItem('bell-preview', themeOverride);
    else sessionStorage.removeItem('bell-preview');
  } catch { /* fine */ }
  tick();
  setText(el.previewToggle, previewLabel());
});

// scroll and resize
let scrollRaf = 0;
let lastScrollY = window.scrollY;
// The nav floats over the floor. Once the floor has scrolled past it steps away on the way down
// and comes straight back on the way up.
function onNav(y) {
  const dy = y - lastScrollY;
  lastScrollY = y;
  const past = floor.progress >= 1 && y > 120;
  if (!past || dy < -2) el.navband.classList.remove('is-away');
  else if (dy > 2) el.navband.classList.add('is-away');
  if (y > 8 && !el.hint.classList.contains('is-gone')) el.hint.classList.add('is-gone');
}
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    onScrollFloor();
    onNav(window.scrollY);
    onParallax();
  });
}
window.addEventListener('scroll', onScroll, { passive: true });
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (menuOpen() && window.innerWidth >= 900) setMenu(false);
  sizeCanvas();
  floor.dirty = true;
  requestFloorDraw();
  sizeRain();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // a resize across a frame set boundary swaps the set
    const want = frameSetFor(root.dataset.market === 'open');
    if (floor.set !== want) { floor.set = null; loadFloor(root.dataset.market === 'open'); }
    tickerSignature = '';
    renderTicker();
    onScroll();
  }, 200);
});

// On a phone the console is a bottom sheet. Its height feeds the stage as --sheet, so the Ringer
// perches on its top edge and the floor frame fits the strip above it.
if ('ResizeObserver' in window) {
  new ResizeObserver(() => {
    el.heroSticky.style.setProperty('--sheet', `${Math.round(el.console.getBoundingClientRect().height)}px`);
    floor.dirty = true;
    requestFloorDraw();
  }).observe(el.console);
}

// ------------------------------------------------------------------ the living layer
sprites.init({
  canvas: el.spritesCanvas,
  floors: [...document.querySelectorAll('[data-floor]')],
  counter: el.coinsN,
  toastEl: el.toast,
  onCoin: () => {
    play(el.sfxTick);
    el.coinsChip.classList.add('is-hit');
    setTimeout(() => el.coinsChip.classList.remove('is-hit'), 420);
  },
  onEight: () => {
    play(el.sfxBell);
    startRain();
  },
});
// the chip calls a coin onto the floor
el.coinsChip.addEventListener('click', () => { sprites.spawnCoin(); });
if (sprites.reduced) el.coinsChip.hidden = true;

// QA hooks: the check script reads the frame set and the sprite counts and spawns a coin to click
function canvasHash() {
  const c = el.floorCanvas;
  const t = document.createElement('canvas');
  t.width = 64;
  t.height = 36;
  t.getContext('2d').drawImage(c, 0, 0, 64, 36);
  return t.toDataURL();
}
window.__bell = {
  spawnCoin: (x, y) => sprites.spawnCoin(x, y),
  spawnRunners: (n, dir) => sprites.spawnRunners(n, dir),
  sprites: () => sprites.count(),
  runners: () => sprites.runners(),
  spawned: () => sprites.spawned(),
  coins: () => sprites.coins(),
  spriteSet: () => sprites.set(),
  spritesLoaded: () => sprites.loaded(),
  frameSet: () => floor.set,
  frame: () => floor.drawn,
  drawn: () => floor.drawnKind,
  loaded: () => floor.loaded,
  progress: () => floor.progress,
  travel: () => heroTravel(),
  hash: canvasHash,
};

// ------------------------------------------------------------------ boot
tick();
setText(el.previewToggle, previewLabel());
fetchState().then(() => { renderTicker(); tick(); });
schedulePoll(currentOpen ? POLL_OPEN_MS : POLL_CLOSED_MS);
onScroll();

function loop() {
  tick();
  const drift = now().getMilliseconds();
  setTimeout(loop, 1000 - drift + 5);
}
setTimeout(loop, 1000 - now().getMilliseconds() + 5);

// the ledger rebuilds when the open state flips, so the silence rows come and go with the clock
let lastOpenForLedger = currentOpen;
setInterval(() => {
  if (lastOpenForLedger !== currentOpen) { lastOpenForLedger = currentOpen; renderLedger(); }
}, 1000);
