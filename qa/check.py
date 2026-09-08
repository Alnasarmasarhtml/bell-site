"""Edge check and screenshots for the $BELL site.

    cd site && uv run python3 -m http.server 8791 --bind 127.0.0.1 &
    uv run --with playwright python3 qa/check.py

Checks at 1440, 760 and 390: scrollWidth equals the viewport width, no element's box leaves the
viewport sideways (children of the tape track and of overflow-x scrollers excepted, they scroll
inside their own box), and no console errors. Saves screenshots into site/qa/.
"""

import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BELL_URL", "http://127.0.0.1:8791/")
OUT = os.path.dirname(os.path.abspath(__file__))
WIDTHS = [(1440, 900), (760, 1000), (390, 844)]

SCENES = [
    ("open", "?t=2026-09-08T11:36:41-04:00"),
    ("closed", "?t=2026-09-05T14:00:00-04:00"),
    ("ringing", "?t=2026-09-08T11:36:41-04:00&demo=ring"),
    ("closing", "?t=2026-09-08T15:59:58-04:00"),
    ("holiday", "?t=2026-09-07T12:00:00-04:00"),
    ("earlyclose", "?t=2026-11-27T12:30:00-05:00"),
    ("preopen", "?t=2026-09-08T08:12:04-04:00"),
    ("themeclosed", "?t=2026-09-08T11:36:41-04:00&theme=closed&hold=1"),
]

EDGE_JS = """
() => {
  const vw = window.innerWidth;
  const bad = [];
  const skip = (el) => el.closest('.tape__scroll, .scroller') !== null && !el.matches('.tape__scroll, .scroller');
  for (const el of document.querySelectorAll('body *')) {
    if (skip(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) {
      bad.push({ tag: el.tagName.toLowerCase(), cls: el.className && el.className.baseVal === undefined ? el.className : '', id: el.id, left: Math.round(r.left), right: Math.round(r.right) });
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
    state: t('bell-state').trim(),
    clock: t('clock-time').trim(),
    meta: t('clock-meta').trim(),
    next: t('clock-next').trim(),
    marks: [...document.querySelectorAll('#bells .mark')].map((m) => m.dataset.state).join(','),
    note: t('bells-note').trim(),
    plate: [t('plate-label'), t('plate-rank'), t('plate-who'), t('plate-size'), t('plate-prize'), t('plate-ends'), t('plate-cta')].map((s) => s.trim()).join(' | '),
    receipt: [...document.querySelectorAll('.stat')].map((s) => s.textContent.replace(/\\s+/g, ' ').trim()).join(' || '),
    tapeLabel: t('tape-label').trim(),
    tapeItems: document.querySelectorAll('#tape-track .tape__item').length,
    ledgerRows: document.querySelectorAll('#ledger-body tr').length,
    tiles: document.querySelectorAll('#wall .tile').length,
    footer: t('footer-state').trim(),
    bellSrc: (() => { const i = document.querySelector('.bell__img--day'); return i && getComputedStyle(i).display !== 'none' ? 'day' : 'night'; })(),
  };
}
"""


def run():
    results = []
    ok = True
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, query in SCENES:
            for (w, h) in WIDTHS:
                if name not in ("open", "closed") and w != 1440:
                    continue
                ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
                page = ctx.new_page()
                errors = []
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(BASE + query, wait_until="networkidle")
                page.evaluate("document.fonts.ready")
                time.sleep(1.2 if name != "closing" else 3.0)
                if name == "ringing":
                    time.sleep(0.3)
                edge = page.evaluate(EDGE_JS)
                text = page.evaluate(TEXT_JS)
                shot = os.path.join(OUT, f"{name}-{w}.png")
                page.screenshot(path=shot, full_page=(name in ("open", "closed")))
                good = edge["scrollWidth"] == edge["innerWidth"] and edge["badCount"] == 0 and not errors
                ok = ok and good
                results.append({"scene": name, "width": w, "ok": good, "scrollWidth": edge["scrollWidth"], "innerWidth": edge["innerWidth"], "bad": edge["bad"], "errors": errors[:5], "text": text})
                ctx.close()
        browser.close()
    for r in results:
        print(json.dumps(r, ensure_ascii=False))
    print("ALL OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
