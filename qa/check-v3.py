"""Edge check and screenshots for the $BELL v3 site.

    uv run --with playwright python3 site/qa/check-v3.py

Serves the site folder on a free port (256 backlog), then at 3440x1315, 1512x913, 1440x900,
1024x768, 760x1000, 390x844 and 1512x913 at dpr 2 loads the open state (scroll 0, halfway down the hero runway,
full page) and the closed state (scroll 0), plus the ringing state at 1512 and 390. Every scene
asserts scrollWidth == innerWidth, that no element box leaves the viewport sideways, zero console
errors, zero failed requests, the chosen frame set, that a wheel burst spawns runners, that the
html cursor is the 1990 arrow, and that a coin click bumps the counter. The halfway shot must draw
a frame that differs from frame 0. Screenshots land in site/qa/v3/. Exit code 0 only when green.
"""

import http.server
import json
import os
import socket
import sys
import threading
import time
from functools import partial

from playwright.sync_api import sync_playwright

QA = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(QA)
OUT = os.path.join(QA, "v3")
# width, height, device pixel ratio
WIDTHS = [(3440, 1315, 1), (1512, 913, 1), (1440, 900, 1), (1024, 768, 1), (760, 1000, 1), (390, 844, 1), (1512, 913, 2)]
OPEN_Q = "?t=2026-09-08T11:36:41-04:00&demo=1"
CLOSED_Q = "?t=2026-09-05T14:00:00-04:00&demo=1"
RING_Q = "?t=2026-09-08T11:36:41-04:00&demo=ring"

# name, query, widths, wants
SCENES = [
    ("open", OPEN_Q, WIDTHS, {"market": "open", "set": "hero", "mid": True, "full": True}),
    ("closed", CLOSED_Q, WIDTHS, {"market": "closed", "set": "night", "mid": False, "full": False}),
    ("ringing", RING_Q, [WIDTHS[1], WIDTHS[5]], {"market": "open", "set": "hero", "mid": False, "full": False, "ringing": True}),
]


def frame_set(w, h, dpr=1):
    """Mirror of frameSetFor in app.js: the tall set on a portrait phone, else by the cover fit width."""
    if w < 760 and h > w:
        return "-tall"
    need = max(w, h * 16 / 9) * dpr
    return "-sm" if need <= 700 else "" if need <= 1100 else "-xl" if need <= 2000 else "-2k" if need <= 3300 else "-4k"


EDGE_JS = """
() => {
  const vw = window.innerWidth;
  const bad = [];
  const inScroller = (el) => el.closest('.scroller, .ticker__scroll, .clip') !== null && !el.matches('.scroller, .ticker__scroll, .clip');
  for (const el of document.querySelectorAll('body *')) {
    if (inScroller(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) {
      bad.push({ tag: el.tagName.toLowerCase(), cls: typeof el.className === 'string' ? el.className : '', id: el.id, left: Math.round(r.left), right: Math.round(r.right) });
    }
  }
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth: vw, bodyScrollWidth: document.body.scrollWidth, bad: bad.slice(0, 12), badCount: bad.length };
}
"""

TEXT_JS = """
() => {
  const t = (id) => (document.getElementById(id) || {}).textContent || '';
  const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const clock = document.getElementById('clock-time');
  const b = window.__bell || {};
  return {
    market: document.documentElement.dataset.market,
    bell: document.documentElement.dataset.bell,
    floor: document.documentElement.dataset.floor,
    live: t('ticker-live').trim(),
    tickerItems: document.querySelectorAll('#ticker-track .tk').length,
    state: t('hero-market').trim(),
    clock: t('clock-time').trim(),
    next: t('clock-next').trim(),
    meta: t('clock-meta').trim(),
    marks: [...document.querySelectorAll('#bells .mark')].map((m) => m.dataset.state).join(','),
    cards: document.querySelectorAll('#bellgrid .bcard').length,
    plate: [t('plate-label'), t('plate-rank'), t('plate-who'), t('plate-size'), t('plate-prize'), t('plate-ends'), t('plate-cta')].map((s) => s.trim()).join(' | '),
    gap: [t('gap-label'), t('gap-value'), t('gap-unit'), t('gap-meta'), t('gap-clock')].map((s) => s.trim()).join(' | '),
    ledgerRows: document.querySelectorAll('#ledger-body tr').length,
    dropSum: t('drop-sum').trim(),
    tiles: document.querySelectorAll('#wall .tile').length,
    footer: t('footer-state').trim(),
    desk: t('hero-desk').trim(),
    stage: box('#hero-sticky'),
    nav: box('#navband'),
    console: box('#console'),
    ringer: box('#ringer'),
    ticker: box('#ticker'),
    countOverflow: clock ? Math.max(0, clock.scrollWidth - clock.clientWidth) : 0,
    consoleScroll: (() => { const c = document.querySelector('.console__body'); return c ? Math.max(0, c.scrollHeight - c.clientHeight) : 0; })(),
    bellsW: box('#bells') ? box('#bells').w : 0,
    cursor: getComputedStyle(document.documentElement).cursor,
    bodyLoading: document.body.classList.contains('loading'),
    frameSet: b.frameSet ? b.frameSet() : null,
    frame: b.frame ? b.frame() : null,
    drawn: b.drawn ? b.drawn() : null,
    loaded: b.loaded ? b.loaded() : null,
    progress: b.progress ? b.progress() : null,
    travel: b.travel ? b.travel() : null,
    spriteSet: b.spriteSet ? b.spriteSet() : null,
    spritesLoaded: b.spritesLoaded ? b.spritesLoaded() : null,
    sprites: b.sprites ? b.sprites() : null,
    spawned: b.spawned ? b.spawned() : null,
    coins: b.coins ? b.coins() : null,
    ledgerScroll: (() => { const s = document.querySelector('.ledger .scroller'); return s ? s.scrollWidth - s.clientWidth : 0; })(),
    truncatedNames: [...document.querySelectorAll('#wall .tile__who')].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
  };
}
"""


def scene_checks(name, w, h, dpr, text, wants):
    fails = []
    if text["market"] != wants["market"]:
        fails.append(f"market is {text['market']!r}, wanted {wants['market']!r}")
    want_set = wants["set"] + frame_set(w, h, dpr)
    if text["frameSet"] != want_set:
        fails.append(f"frame set is {text['frameSet']!r}, wanted {want_set!r}")
    if "cursor/arrow" not in (text["cursor"] or ""):
        fails.append(f"html cursor is {text['cursor']!r}")
    if text["truncatedNames"]:
        fails.append(f"{text['truncatedNames']} wall names truncated")
    if text["countOverflow"] > 0:
        fails.append(f"countdown overflows its console by {text['countOverflow']}px")
    if text["consoleScroll"] > 0:
        fails.append(f"console body clips {text['consoleScroll']}px of content")
    st, nav, con, rg = text["stage"], text["nav"], text["console"], text["ringer"]
    if not st or not nav or not con:
        fails.append("stage, nav or console missing")
    else:
        if abs(st["h"] - (h - text["ticker"]["h"])) > 2:
            fails.append(f"stage is {st['h']}px tall, wanted {h - text['ticker']['h']}")
        if st["w"] != w:
            fails.append(f"stage is {st['w']}px wide at {w}")
        if con["top"] < nav["bottom"] - 1:
            fails.append(f"console top {con['top']} sits under the nav ({nav['bottom']})")
        if con["bottom"] > st["bottom"] + 1:
            fails.append(f"console bottom {con['bottom']} runs past the stage ({st['bottom']})")
        if rg and (rg["right"] > w + 1 or rg["bottom"] > st["bottom"] + 12):
            fails.append(f"ringer box {rg} leaves the stage")
        if w >= 760 and con["w"] > min(960 if w >= 2200 else 760, 0.56 * w) + 2:
            fails.append(f"console is {con['w']}px wide at {w}")
    if name == "open" and not text["desk"].startswith("DESK HOLDS"):
        fails.append(f"desk line reads {text['desk']!r}")
    if wants.get("ringing"):
        if text["bell"] != "ringing":
            fails.append(f"data-bell is {text['bell']!r}")
        if text["live"] != "RINGING":
            fails.append(f"ticker live reads {text['live']!r}")
        if "ringing" not in text["marks"]:
            fails.append(f"marks read {text['marks']!r}")
    return fails


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Quiet(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    # the page fires a few hundred frame requests at once; a small backlog resets some of them
    request_queue_size = 256
    allow_reuse_address = True
    daemon_threads = True


def serve():
    port = free_port()
    handler = partial(Quiet, directory=SITE)
    httpd = Server(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, f"http://127.0.0.1:{port}/"


def wait_frames(page, seconds=25.0):
    """Wait until every frame of the chosen set has arrived (or the budget runs out)."""
    t0 = time.time()
    while time.time() - t0 < seconds:
        n = page.evaluate("window.__bell ? window.__bell.loaded() : 0")
        if n >= 97:
            return n
        time.sleep(0.2)
    return page.evaluate("window.__bell ? window.__bell.loaded() : 0")


def run():
    os.makedirs(OUT, exist_ok=True)
    httpd, base = serve()
    results = []
    ok = True
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for name, query, widths, wants in SCENES:
                for (w, h, dpr) in widths:
                    tag = f"{w}" if dpr == 1 else f"{w}@{dpr}x"
                    for attempt in range(2):
                        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=dpr)
                        page = ctx.new_page()
                        errors = []
                        failed = []
                        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                        page.on("pageerror", lambda e: errors.append(str(e)))
                        page.on("requestfailed", lambda r: failed.append(f"{r.url} {r.failure}"))
                        page.on("response", lambda r: failed.append(f"{r.url} {r.status}") if r.status >= 400 else None)
                        page.goto(base + query, wait_until="networkidle")
                        page.evaluate("document.fonts.ready")
                        time.sleep(1.5)
                        reset = [e for e in errors + failed if "ERR_CONNECTION_RESET" in e or "ERR_EMPTY_RESPONSE" in e]
                        if reset and attempt == 0:
                            print(f"retry {name} {tag}: test server reset a connection", file=sys.stderr)
                            ctx.close()
                            continue
                        break
                    checks = []
                    # 1. the top of the page
                    edge_top = page.evaluate(EDGE_JS)
                    text = page.evaluate(TEXT_JS)
                    hash0 = page.evaluate("window.__bell.hash()")
                    page.screenshot(path=os.path.join(OUT, f"{name}-{tag}.png"), full_page=False)
                    checks += scene_checks(name, w, h, dpr, text, wants)
                    if wants.get("ringing"):
                        time.sleep(0.8)
                        if page.evaluate("window.__bell.spawned()") <= 0:
                            checks.append("no parade spawned on the ring")
                        page.screenshot(path=os.path.join(OUT, f"{name}-parade-{tag}.png"), full_page=False)
                    edge_mid = {"badCount": 0, "bad": [], "scrollWidth": w}
                    mid = None
                    if wants["mid"]:
                        # 2. halfway down the runway: a different frame must be on the canvas
                        page.evaluate("window.scrollTo(0, Math.round(window.__bell.travel() * 0.5))")
                        loaded = wait_frames(page)
                        time.sleep(0.5)
                        page.evaluate("window.dispatchEvent(new Event('scroll'))")
                        time.sleep(0.3)
                        mid = page.evaluate(TEXT_JS)
                        hash1 = page.evaluate("window.__bell.hash()")
                        edge_mid = page.evaluate(EDGE_JS)
                        page.screenshot(path=os.path.join(OUT, f"{name}-mid-{tag}.png"), full_page=False)
                        if loaded < 97:
                            checks.append(f"only {loaded} frames loaded")
                        if hash1 == hash0:
                            checks.append("halfway frame matches frame 0")
                        if mid["frame"] is None or mid["frame"] < 30 or mid["frame"] > 66:
                            checks.append(f"halfway frame index is {mid['frame']}")
                        if mid["drawn"] != "frame":
                            checks.append(f"canvas shows {mid['drawn']!r} at halfway")
                        if mid["bodyLoading"]:
                            checks.append("body still carries the loading cursor after the frames arrived")
                    # 3. a wheel burst spawns runners
                    before = page.evaluate("window.__bell.spawned()")
                    page.mouse.move(w // 2, h // 2)
                    for _ in range(6):
                        page.mouse.wheel(0, 420)
                        time.sleep(0.03)
                    time.sleep(0.7)
                    spawned = page.evaluate("window.__bell.spawned()") - before
                    on_screen = page.evaluate("window.__bell.runners()")
                    if spawned <= 0:
                        checks.append(f"wheel burst spawned nothing (loaded {page.evaluate('window.__bell.spritesLoaded()')})")
                    page.screenshot(path=os.path.join(OUT, f"{name}-runners-{tag}.png"), full_page=False)
                    # 4. a coin click bumps the counter
                    coins0 = page.evaluate("window.__bell.coins()")
                    pos = page.evaluate(f"(() => {{ const c = window.__bell.spawnCoin({w // 2}, {h - 160}); return c ? {{ x: c.x, y: c.y, size: c.size }} : null; }})()")
                    if not pos:
                        checks.append("spawnCoin returned nothing")
                    else:
                        page.mouse.move(pos["x"], pos["y"])
                        time.sleep(0.05)
                        page.mouse.click(pos["x"], pos["y"])
                        time.sleep(0.2)
                        coins1 = page.evaluate("window.__bell.coins()")
                        chip = page.evaluate("document.getElementById('coins-n').textContent")
                        if coins1 != coins0 + 1 or chip != str(coins1):
                            checks.append(f"coin click: counter {coins0} -> {coins1}, chip reads {chip!r}")
                    # 5. walk the page so lazy images load, then the full page
                    edge_walk = {"badCount": 0, "bad": [], "scrollWidth": w}
                    if wants["full"]:
                        total = page.evaluate("document.documentElement.scrollHeight")
                        worst = 0
                        for y in range(0, total, 700):
                            page.evaluate(f"window.scrollTo(0, {y})")
                            time.sleep(0.04)
                            e = page.evaluate(EDGE_JS)
                            if e["badCount"] > edge_walk["badCount"]:
                                edge_walk = e
                            worst = max(worst, e["scrollWidth"])
                        edge_walk["scrollWidth"] = max(edge_walk["scrollWidth"], worst)
                        page.evaluate("window.scrollTo(0, 0)")
                        time.sleep(0.5)
                        page.screenshot(path=os.path.join(OUT, f"{name}-full-{tag}.png"), full_page=True)
                    bad = edge_top["badCount"] + edge_mid["badCount"] + edge_walk["badCount"]
                    sw = max(edge_top["scrollWidth"], edge_mid["scrollWidth"], edge_walk["scrollWidth"])
                    good = sw == w and bad == 0 and not errors and not failed and not checks
                    ok = ok and good
                    results.append({
                        "scene": name, "width": w, "height": h, "dpr": dpr, "ok": good, "scrollWidth": sw, "innerWidth": w,
                        "frameSet": text["frameSet"], "midFrame": mid["frame"] if mid else None, "spawned": spawned, "runnersOnScreen": on_screen,
                        "spriteSet": text["spriteSet"],
                        "bad": (edge_top["bad"] + edge_mid["bad"] + edge_walk["bad"])[:12], "errors": errors[:6], "failed": failed[:6], "checks": checks, "text": text,
                    })
                    ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
    with open(os.path.join(OUT, "last-run.json"), "w") as f:
        json.dump(results, f, indent=1)
    for r in results:
        print(json.dumps({k: r[k] for k in ("scene", "width", "dpr", "ok", "scrollWidth", "frameSet", "midFrame", "spawned", "runnersOnScreen", "bad", "errors", "failed", "checks")}, ensure_ascii=False))
    print("ALL OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
