"""Edge check and screenshots for the $BELL v2 site.

    uv run --with playwright python3 site/qa/check-v2.py

Serves the site folder on a free port, then at 1440, 760 and 390 loads the open and closed
states, plus the ringing state and the closing bell countdown at 1440. For every scene it
asserts scrollWidth == innerWidth, that no element box leaves the viewport sideways (children
of scrollers and clipped sections excepted), and zero console errors. Screenshots land in
site/qa/v2/. Exit code 0 only when every scene is green.
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
OUT = os.path.join(QA, "v2")
WIDTHS = [(1440, 900), (760, 1000), (390, 844)]
# a 1366x768 laptop with browser chrome lands here; the hero must not slide under the ticker
SHORT = (1366, 620)
STONKS_HOME = "https://www.thestonks.exchange/"

# name, query, widths, settle seconds, full page
SCENES = [
    ("open", "?t=2026-09-08T11:36:41-04:00&demo=1", WIDTHS + [SHORT], 1.5, True),
    ("closed", "?t=2026-09-05T14:00:00-04:00&demo=1", WIDTHS + [SHORT], 1.5, True),
    ("ringing", "?t=2026-09-08T11:36:41-04:00&demo=ring", [WIDTHS[0], WIDTHS[2]], 1.5, False),
    ("closing", "?t=2026-09-10T15:59:50-04:00&demo=1", [WIDTHS[0]], 2.0, False),
    # the public file as deployed before launch: no token, no race, no ledger, no wall
    ("prelaunch", "?t=2026-09-08T11:36:41-04:00", [WIDTHS[0], WIDTHS[2]], 1.5, True),
]

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
    ledgerText: t('ledger-body').trim().slice(0, 80),
    dropSum: t('drop-sum').trim(),
    tiles: document.querySelectorAll('#wall .tile').length,
    wallText: t('wall').trim().slice(0, 60),
    winTitle: t('win-title').trim(),
    footer: t('footer-state').trim(),
    desk: t('hero-desk').trim(),
    navCa: t('nav-ca-short').trim(),
    heroBuy: (document.getElementById('hero-buy') || {}).href || '',
    navBuy: (document.getElementById('nav-buy') || {}).href || '',
    plateCta: (document.getElementById('plate-cta') || {}).getAttribute('href') || '',
    socialShown: [...document.querySelectorAll('#link-x, #footer-x, #footer-tg, #footer-join')].filter((a) => !a.hidden).length,
    pillsTop: Math.round(document.querySelector('.hero__pills').getBoundingClientRect().top),
    tickerBottom: Math.round(document.getElementById('ticker').getBoundingClientRect().bottom),
    ledgerScroll: (() => { const s = document.querySelector('.ledger .scroller'); return s ? s.scrollWidth - s.clientWidth : 0; })(),
    droppedVisible: (() => {
      const s = document.querySelector('.ledger .scroller');
      const th = document.querySelectorAll('.tbl thead th')[1];
      if (!s || !th) return false;
      return th.getBoundingClientRect().right <= s.getBoundingClientRect().right + 0.5;
    })(),
    truncatedNames: [...document.querySelectorAll('#wall .tile__who')].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
  };
}
"""


def scene_checks(name, w, text):
    """Content assertions per scene. Returns a list of failure strings."""
    fails = []
    if text["pillsTop"] < text["tickerBottom"]:
        fails.append(f"hero pills at {text['pillsTop']}px sit under the ticker ({text['tickerBottom']}px)")
    if text["truncatedNames"]:
        fails.append(f"{text['truncatedNames']} wall names truncated")
    if w >= 1440 and text["ledgerScroll"] > 0:
        fails.append(f"ledger scrolls {text['ledgerScroll']}px at {w}")
    if name in ("open", "closed") and not text["droppedVisible"]:
        fails.append("DROPPED NVDAc column is off screen without scrolling")
    if name == "prelaunch":
        want = {
            "navCa": "SOON",
            "plateCta": "#pair",
            "heroBuy": STONKS_HOME,
            "navBuy": STONKS_HOME,
            "socialShown": 0,
        }
        for k, v in want.items():
            if text[k] != v:
                fails.append(f"{k} is {text[k]!r}, wanted {v!r}")
        if "NOT LAUNCHED YET" not in text["plate"]:
            fails.append(f"plate reads {text['plate']!r}")
        if text["dropSum"] != "NO DROP YET":
            fails.append(f"ledger sum reads {text['dropSum']!r}")
        if "THE WALL IS EMPTY" not in text["wallText"]:
            fails.append(f"wall reads {text['wallText']!r}")
        if text["desk"]:
            fails.append(f"desk line shows {text['desk']!r} before launch")
    elif name in ("open", "closing") and not text["desk"].startswith("DESK HOLDS"):
        fails.append(f"desk line reads {text['desk']!r}")
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


def run():
    os.makedirs(OUT, exist_ok=True)
    httpd, base = serve()
    results = []
    ok = True
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            for name, query, widths, settle, full in SCENES:
                for (w, h) in widths:
                    for attempt in range(2):
                        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
                        page = ctx.new_page()
                        errors = []
                        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                        page.on("pageerror", lambda e: errors.append(str(e)))
                        page.goto(base + query, wait_until="networkidle")
                        page.evaluate("document.fonts.ready")
                        time.sleep(settle)
                        reset = [e for e in errors if "ERR_CONNECTION_RESET" in e or "ERR_EMPTY_RESPONSE" in e]
                        if reset and attempt == 0:
                            print(f"retry {name} {w}: test server reset a connection", file=sys.stderr)
                            ctx.close()
                            continue
                        break
                    # walk the page so lazy images load and the floor scrubs, then come back up
                    total = page.evaluate("document.documentElement.scrollHeight")
                    for y in range(0, total, 600):
                        page.evaluate(f"window.scrollTo(0, {y})")
                        time.sleep(0.05)
                    page.evaluate("window.scrollTo(0, 0)")
                    time.sleep(0.6)
                    edge_top = page.evaluate(EDGE_JS)
                    text = page.evaluate(TEXT_JS)
                    page.screenshot(path=os.path.join(OUT, f"{name}-{w}.png"), full_page=full)
                    if name == "closing":
                        # ride the countdown into the closing bell: 15:59:50 plus twelve seconds
                        time.sleep(11.0)
                        text_ring = page.evaluate(TEXT_JS)
                        page.screenshot(path=os.path.join(OUT, f"{name}-ring-{w}.png"), full_page=False)
                        text["after_ring"] = text_ring
                    # mid-page shot and edge check with the sticky hero scrolled through
                    page.evaluate("window.scrollTo(0, Math.round(window.innerHeight * 0.6))")
                    time.sleep(0.4)
                    edge_mid = page.evaluate(EDGE_JS)
                    if name in ("open", "closed"):
                        page.screenshot(path=os.path.join(OUT, f"{name}-mid-{w}.png"), full_page=False)
                    bad = edge_top["badCount"] + edge_mid["badCount"]
                    sw = max(edge_top["scrollWidth"], edge_mid["scrollWidth"])
                    checks = scene_checks(name, w, text)
                    good = sw == w and bad == 0 and not errors and not checks
                    ok = ok and good
                    results.append({
                        "scene": name, "width": w, "ok": good, "scrollWidth": sw, "innerWidth": w,
                        "bad": (edge_top["bad"] + edge_mid["bad"])[:12], "errors": errors[:6], "checks": checks, "text": text,
                    })
                    ctx.close()
            browser.close()
    finally:
        httpd.shutdown()
    with open(os.path.join(OUT, "last-run.json"), "w") as f:
        json.dump(results, f, indent=1)
    for r in results:
        print(json.dumps({k: r[k] for k in ("scene", "width", "ok", "scrollWidth", "innerWidth", "bad", "errors", "checks")}, ensure_ascii=False))
    print("ALL OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
