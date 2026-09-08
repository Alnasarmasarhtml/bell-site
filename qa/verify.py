"""Verify pass for the $BELL site.

    cd site && uv run python3 -m http.server 8792 --bind 127.0.0.1 &
    uv run --with playwright --with pillow python3 qa/verify.py

At 1440, 760 and 390: scrollWidth equals the viewport, no console errors, every element whose
right edge leaves the viewport is listed (tagged with the scroll box it lives in, if any), Doto and
IBM Plex Mono are loaded, the countdown moves between two screenshots two seconds apart, the tape
moves, the LEADING NOW plate carries a name and a number, the BEAT IT link points at a buy URL.
Scenes: the closing bell at 15:59:50 (countdown under ten seconds, then ringing), ?theme=closed,
?demo=ring, the live page. Screenshots land in site/qa/verify-*.png. A design audit reads computed
styles (radius, shadows, gradients, fonts, blue, off-ramp colors) and a pixel pass counts blue and
colorful pixels in every screenshot against the bell's box.
"""

import json
import os
import re
import sys
import time

from PIL import Image
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BELL_URL", "http://127.0.0.1:8792/")
OUT = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.environ.get("BELL_RESULTS", os.path.join(OUT, "verify-run.json"))
WIDTHS = [(1440, 900), (760, 1000), (390, 844)]
OPEN_T = "?t=2026-09-08T11:36:41-04:00"
CLOSING_T = "?t=2026-09-10T15:59:50-04:00"

RAMP = {
    "rgb(10, 11, 13)", "rgb(50, 53, 61)", "rgb(91, 97, 110)", "rgb(113, 120, 134)",
    "rgb(177, 183, 195)", "rgb(222, 225, 231)", "rgb(238, 240, 243)", "rgb(255, 255, 255)",
    "rgb(18, 20, 25)", "rgba(0, 0, 0, 0)", "transparent",
}
BANNED = re.compile(r"\b(dividend|yield|revenue share|investment|shareholder|profit)s?\b", re.I)
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿\U0001F1E6-\U0001F1FF]")

EDGE_JS = r"""
() => {
  const vw = window.innerWidth;
  const out = [];
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) {
      const box = el.closest('.tape__scroll, .scroller');
      out.push({ sel: sel(el), left: Math.round(r.left), right: Math.round(r.right), inScrollBox: box && box !== el ? sel(box) : null });
    }
  }
  return { scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, innerWidth: vw, offenders: out };
}
"""

FONT_JS = r"""
async () => {
  await document.fonts.ready;
  const faces = [...document.fonts].map((f) => [f.family, f.weight, f.style, f.status]);
  return {
    dotoCheck: document.fonts.check('900 40px Doto'),
    plexCheck: document.fonts.check('500 14px "IBM Plex Mono"'),
    dotoLoaded: faces.some((f) => /doto/i.test(f[0]) && f[3] === 'loaded'),
    plexLoaded: faces.some((f) => /plex mono/i.test(f[0]) && f[3] === 'loaded'),
    faces,
  };
}
"""

STATE_JS = r"""
() => {
  const t = (id) => (document.getElementById(id) || {}).textContent || '';
  const root = document.documentElement;
  const cta = document.getElementById('plate-cta');
  const day = document.querySelector('.bell__img--day');
  const night = document.querySelector('.bell__img--night');
  const track = document.getElementById('tape-track');
  const ts = getComputedStyle(track);
  return {
    market: root.dataset.market, bell: root.dataset.bell, ringkind: root.dataset.ringkind, silence: root.dataset.silence, next: root.dataset.next,
    state: t('bell-state').trim(), clock: t('clock-time').trim(), meta: t('clock-meta').trim(), nextLine: t('clock-next').trim(),
    marks: [...document.querySelectorAll('#bells .mark')].map((m) => m.dataset.state).join(','),
    note: t('bells-note').trim(),
    plateLabel: t('plate-label').trim(), plateRank: t('plate-rank').trim(), plateWho: t('plate-who').trim(), plateSize: t('plate-size').trim(),
    platePrize: t('plate-prize').trim(), plateEnds: t('plate-ends').trim(), plateCta: cta ? cta.textContent.trim() : '', plateHref: cta ? cta.href : '',
    receipt: [...document.querySelectorAll('.stat')].map((s) => s.textContent.replace(/\s+/g, ' ').trim()),
    tapeLabel: t('tape-label').trim(), tapeItems: document.querySelectorAll('#tape-track .tape__item').length,
    tapeAnim: { name: ts.animationName, duration: ts.animationDuration, timing: ts.animationTimingFunction, play: ts.animationPlayState, transform: ts.transform, width: track.scrollWidth },
    ledgerRows: document.querySelectorAll('#ledger-body tr').length, tiles: document.querySelectorAll('#wall .tile').length,
    footer: t('footer-state').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color,
    bellShown: day && getComputedStyle(day).display !== 'none' ? 'day' : (night && getComputedStyle(night).display !== 'none' ? 'night' : 'none'),
    bellAnim: day ? getComputedStyle(day).animationName : '',
    bellRect: (() => { const b = document.getElementById('bell'); const r = b.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    clockRect: (() => { const r = document.getElementById('clock-time').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; })(),
    links: { stonks: document.getElementById('link-stonks').href, dex: document.getElementById('link-dex').href, x: document.getElementById('link-x').href, navX: document.getElementById('nav-x').href, readTape: document.getElementById('read-tape').getAttribute('href') },
  };
}
"""

DESIGN_JS = r"""
() => {
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const firstFamily = (ff) => (ff || '').split(',')[0].replace(/["']/g, '').trim();
  const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const uniq = (arr, cap = 25) => { const seen = new Set(); const out = []; for (const a of arr) { const k = JSON.stringify(a); if (!seen.has(k)) { seen.add(k); out.push(a); } } return { count: arr.length, sample: out.slice(0, cap) }; };
  const radius = [], shadows = [], gradients = [], filters = [], opacity = [], offFont = [], smallDoto = [], blue = [], offRamp = [], eased = [], centered = [], imgs = [];
  const shadowValues = new Set();
  const colorValues = {};
  const RAMP = new Set(['rgb(10, 11, 13)', 'rgb(50, 53, 61)', 'rgb(91, 97, 110)', 'rgb(113, 120, 134)', 'rgb(177, 183, 195)', 'rgb(222, 225, 231)', 'rgb(238, 240, 243)', 'rgb(255, 255, 255)', 'rgb(18, 20, 25)', 'rgba(0, 0, 0, 0)', 'transparent']);
  const noteColor = (v, el, prop) => { if (!v || RAMP.has(v)) return; (colorValues[v] = colorValues[v] || []).push(sel(el) + ':' + prop); };
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && cs.display === 'none') continue;
    for (const p of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']) if (cs[p] !== '0px') { radius.push([sel(el), cs[p]]); break; }
    if (cs.boxShadow !== 'none') { shadowValues.add(cs.boxShadow); shadows.push([sel(el), cs.boxShadow]); }
    if (cs.backgroundImage.includes('gradient')) gradients.push([sel(el), cs.backgroundImage.slice(0, 80)]);
    if (cs.filter !== 'none' || cs.backdropFilter !== 'none') filters.push([sel(el), cs.filter, cs.backdropFilter]);
    if (Number(cs.opacity) < 1 && cs.animationName === 'none') opacity.push([sel(el), cs.opacity]);
    if (hasText(el)) {
      const fam = firstFamily(cs.fontFamily);
      if (!/^(Doto|IBM Plex Mono)$/.test(fam)) offFont.push([sel(el), fam]);
      if (fam === 'Doto' && parseFloat(cs.fontSize) < 28) smallDoto.push([sel(el), cs.fontSize]);
      if (cs.textAlign === 'center') centered.push([sel(el), el.textContent.trim().slice(0, 30)]);
    }
    for (const p of ['color', 'backgroundColor', 'borderTopColor', 'borderBottomColor', 'outlineColor', 'fill']) {
      const v = cs[p];
      if (v === 'rgb(0, 0, 255)') blue.push([sel(el), p]);
      if (p !== 'fill' && p !== 'outlineColor') noteColor(v, el, p);
    }
    if (cs.transitionDuration !== '0s' && !/steps/.test(cs.transitionTimingFunction)) eased.push([sel(el), cs.transitionTimingFunction]);
    if (cs.animationName !== 'none' && !/steps/.test(cs.animationTimingFunction)) eased.push([sel(el), 'anim ' + cs.animationTimingFunction]);
    if (el.tagName === 'IMG') imgs.push([sel(el), cs.borderRadius, cs.boxShadow, cs.filter, el.naturalWidth + 'x' + el.naturalHeight, Math.round(r.width) + 'x' + Math.round(r.height)]);
  }
  for (const v of Object.keys(colorValues)) offRamp.push([v, colorValues[v].length, colorValues[v].slice(0, 4)]);
  const buttons = [...document.querySelectorAll('.btn, button')].map((b) => { const r = b.getBoundingClientRect(); return { sel: sel(b), text: b.textContent.trim().slice(0, 20), top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
  const hero = document.querySelector('.hero');
  const copy = document.querySelector('.hero__copy');
  const container = document.querySelector('.floor .container');
  const hr = hero.getBoundingClientRect(); const cr = copy.getBoundingClientRect(); const kr = container.getBoundingClientRect();
  const text = document.body.innerText;
  return {
    radius: uniq(radius), shadows: uniq(shadows, 12), shadowValues: [...shadowValues], gradients: uniq(gradients), filters: uniq(filters), opacity: uniq(opacity),
    offFont: uniq(offFont), smallDoto: uniq(smallDoto), blue: uniq(blue), offRamp, eased: uniq(eased), centered: uniq(centered), imgs,
    h1: document.querySelectorAll('h1').length,
    buttonsAboveFold: buttons.filter((b) => b.top < window.innerHeight && b.bottom > 0),
    hero: { cols: getComputedStyle(hero).gridTemplateColumns, copyAlign: getComputedStyle(copy).textAlign, copyLeft: Math.round(cr.left - kr.left), copyWidth: Math.round(cr.width), containerWidth: Math.round(kr.width), heroBottom: Math.round(hr.bottom) },
    emDash: (text.match(/\u2014/g) || []).length, enDash: (text.match(/\u2013/g) || []).length,
    textSample: text.slice(0, 200),
    innerText: text,
  };
}
"""


def pixel_pass(path, bell_rect):
    """Count near-pure-blue pixels and colorful pixels; report blue outside the bell box."""
    im = Image.open(path).convert("RGB")
    w, h = im.size
    px = im.load()
    blue = 0
    blue_out = 0
    colorful = 0
    bx0 = bell_rect["x"] - 4
    by0 = bell_rect["y"] - 4
    bx1 = bell_rect["x"] + bell_rect["w"] + 4
    by1 = bell_rect["y"] + bell_rect["h"] + 4
    out_bbox = [w, h, 0, 0]
    step = 2
    for y in range(0, h, step):
        for x in range(0, w, step):
            r, g, b = px[x, y]
            if max(r, g, b) - min(r, g, b) > 40:
                colorful += 1
            if b > 150 and r < 90 and g < 90:
                blue += 1
                if not (bx0 <= x <= bx1 and by0 <= y <= by1):
                    blue_out += 1
                    out_bbox = [min(out_bbox[0], x), min(out_bbox[1], y), max(out_bbox[2], x), max(out_bbox[3], y)]
    total = (w // step) * (h // step)
    return {
        "size": [w, h], "colorfulPct": round(100 * colorful / total, 2), "bluePct": round(100 * blue / total, 2),
        "blueOutsideBell": blue_out * step * step, "blueOutsideBbox": out_bbox if blue_out else None,
    }


def new_page(browser, w, h, reduced=False):
    ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1, reduced_motion="reduce" if reduced else "no-preference")
    page = ctx.new_page()
    log = {"errors": [], "warnings": [], "failed": []}
    page.on("console", lambda m: log["errors"].append(m.text) if m.type == "error" else (log["warnings"].append(m.text) if m.type == "warning" else None))
    page.on("pageerror", lambda e: log["errors"].append(str(e)))
    page.on("requestfailed", lambda r: log["failed"].append(f"{r.url} {r.failure}"))
    page.on("response", lambda r: log["failed"].append(f"{r.url} {r.status}") if r.status >= 400 else None)
    return ctx, page, log


def goto(page, query):
    page.goto(BASE + query, wait_until="networkidle")
    page.evaluate(FONT_JS)


def mmss_to_s(s):
    parts = [int(p) for p in s.split(":")]
    out = 0
    for p in parts:
        out = out * 60 + p
    return out


def run():
    results = {"widths": {}, "scenes": {}, "checks": []}
    ok = True

    def check(name, passed, detail=""):
        nonlocal ok
        ok = ok and bool(passed)
        results["checks"].append({"check": name, "ok": bool(passed), "detail": detail})

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---------------------------------------------------------------- per width, market open
        for (w, h) in WIDTHS:
            ctx, page, log = new_page(browser, w, h)
            goto(page, OPEN_T)
            time.sleep(1.2)
            edge = page.evaluate(EDGE_JS)
            fonts = page.evaluate(FONT_JS)
            state = page.evaluate(STATE_JS)
            design = page.evaluate(DESIGN_JS)
            inner = design.pop("innerText")
            shot_full = os.path.join(OUT, f"verify-open-{w}.png")
            page.screenshot(path=shot_full, full_page=True)
            pixels = pixel_pass(shot_full, state["bellRect"])

            # countdown, two screenshots two seconds apart
            a = page.evaluate("document.getElementById('clock-time').textContent.trim()")
            page.screenshot(path=os.path.join(OUT, f"verify-countdown-a-{w}.png"))
            t_a = time.time()
            transform_a = page.evaluate("getComputedStyle(document.getElementById('tape-track')).transform")
            time.sleep(2.0)
            b = page.evaluate("document.getElementById('clock-time').textContent.trim()")
            page.screenshot(path=os.path.join(OUT, f"verify-countdown-b-{w}.png"))
            elapsed = time.time() - t_a
            transform_b = page.evaluate("getComputedStyle(document.getElementById('tape-track')).transform")
            delta = mmss_to_s(a) - mmss_to_s(b)

            hard = [o for o in edge["offenders"] if not o["inScrollBox"]]
            soft = [o for o in edge["offenders"] if o["inScrollBox"]]
            check(f"{w} scrollWidth == innerWidth", edge["scrollWidth"] == edge["innerWidth"], f"{edge['scrollWidth']} vs {edge['innerWidth']}")
            check(f"{w} no console errors", not log["errors"], "; ".join(log["errors"][:3]))
            check(f"{w} no failed requests", not log["failed"], "; ".join(log["failed"][:3]))
            check(f"{w} no element past the viewport edge (outside scroll boxes)", not hard, json.dumps(hard[:6]))
            check(f"{w} Doto loaded", fonts["dotoCheck"] and fonts["dotoLoaded"], json.dumps(fonts["faces"][:4]))
            check(f"{w} IBM Plex Mono loaded", fonts["plexCheck"] and fonts["plexLoaded"])
            check(f"{w} countdown moved over 2s", a != b and 1 <= delta <= 3, f"{a} -> {b} in {elapsed:.2f}s")
            check(f"{w} tape scrolls", transform_a != transform_b and state["tapeAnim"]["play"] == "running", f"{transform_a} -> {transform_b} {state['tapeAnim']['duration']} {state['tapeAnim']['timing']}")
            check(f"{w} LEADING NOW shows a name", state["plateLabel"].startswith("LEADING NOW") and re.search(r"[a-z0-9]", state["plateWho"]) and state["plateWho"] not in ("·", ""), f"{state['plateLabel']} | {state['plateWho']}")
            check(f"{w} LEADING NOW shows a number", re.search(r"\d[\d,]*\.\d{2} NVDAc", state["plateSize"]), state["plateSize"])
            check(f"{w} BEAT IT points at a buy URL", state["plateCta"].startswith("BEAT IT") and "thestonks.exchange/token/0x" in state["plateHref"], f"{state['plateCta']} -> {state['plateHref']}")
            check(f"{w} no blue outside the bell (pixels)", pixels["blueOutsideBell"] == 0, json.dumps(pixels))
            check(f"{w} no blue in computed styles", design["blue"]["count"] == 0, json.dumps(design["blue"]["sample"][:5]))
            check(f"{w} zero radius everywhere", design["radius"]["count"] == 0, json.dumps(design["radius"]["sample"][:5]))
            check(f"{w} shadows are hard 2px/3px", all(re.fullmatch(r"rgb\(\d+, \d+, \d+\) [23]px [23]px 0px 0px", s) for s in design["shadowValues"]), json.dumps(design["shadowValues"]))
            check(f"{w} gradients only on the graph paper", all(s[0].startswith("header#floor") for s in design["gradients"]["sample"]), json.dumps(design["gradients"]["sample"][:5]))
            check(f"{w} no filters", design["filters"]["count"] == 0, json.dumps(design["filters"]["sample"][:5]))
            check(f"{w} only Doto and IBM Plex Mono", design["offFont"]["count"] == 0, json.dumps(design["offFont"]["sample"][:5]))
            check(f"{w} no Doto under 28px", design["smallDoto"]["count"] == 0, json.dumps(design["smallDoto"]["sample"][:5]))
            check(f"{w} colors on the grey ramp", not design["offRamp"], json.dumps(design["offRamp"][:6]))
            check(f"{w} motion uses steps()", design["eased"]["count"] == 0, json.dumps(design["eased"]["sample"][:5]))
            check(f"{w} no centered copy", design["centered"]["count"] == 0, json.dumps(design["centered"]["sample"][:5]))
            check(f"{w} no em dash on the page", design["emDash"] == 0 and design["enDash"] == 0, f"em {design['emDash']} en {design['enDash']}")
            check(f"{w} no banned words on the page", not BANNED.search(inner), str(BANNED.findall(inner)[:5]))
            check(f"{w} no emoji on the page", not EMOJI.search(inner))
            check(f"{w} clock in the first viewport", state["clockRect"]["bottom"] <= h and state["clockRect"]["top"] >= 0, json.dumps(state["clockRect"]))

            results["widths"][w] = {
                "edge": {"scrollWidth": edge["scrollWidth"], "innerWidth": edge["innerWidth"], "hard": hard, "softInScrollBox": soft[:12], "softCount": len(soft)},
                "log": log, "fonts": {k: v for k, v in fonts.items() if k != "faces"}, "faces": fonts["faces"],
                "state": state, "design": design, "pixels": pixels,
                "countdown": {"a": a, "b": b, "elapsed": round(elapsed, 2)},
                "tape": {"a": transform_a, "b": transform_b},
            }
            ctx.close()

        # ---------------------------------------------------------------- closing bell scene
        for (w, h) in [(1440, 900), (390, 844)]:
            ctx, page, log = new_page(browser, w, h)
            t_nav = time.time()
            goto(page, CLOSING_T)
            s0 = page.evaluate(STATE_JS)
            page.screenshot(path=os.path.join(OUT, f"verify-closing-{w}.png"))
            secs = mmss_to_s(s0["clock"]) if re.fullmatch(r"[\d:]+", s0["clock"]) else 999
            check(f"{w} closing: countdown under 10s at load", 0 < secs < 10 and s0["market"] == "open" and s0["state"] == "OPEN", f"clock {s0['clock']} state {s0['state']} market {s0['market']} meta {s0['meta']} ({time.time() - t_nav:.1f}s after nav)")
            ring_at = None
            for _ in range(80):
                if page.evaluate("document.documentElement.dataset.bell") == "ringing":
                    ring_at = time.time()
                    break
                time.sleep(0.25)
            time.sleep(0.4)
            s1 = page.evaluate(STATE_JS)
            page.screenshot(path=os.path.join(OUT, f"verify-closing-ring-{w}.png"))
            check(f"{w} closing: rings at 16:00", ring_at is not None and s1["state"] == "CLOSING" and s1["ringkind"] == "close" and "CLOSING BELL" in s1["meta"], f"state {s1['state']} kind {s1['ringkind']} market {s1['market']} meta {s1['meta']} bellShown {s1['bellShown']} anim {s1['bellAnim']} clock {s1['clock']}")
            check(f"{w} closing: blue bell swings on the dark page", s1["bellShown"] == "day" and s1["bellAnim"] == "swing" and s1["market"] == "closed", f"{s1['bellShown']} {s1['bellAnim']} {s1['market']} bg {s1['bodyBg']}")
            time.sleep(12.5)
            s2 = page.evaluate(STATE_JS)
            page.screenshot(path=os.path.join(OUT, f"verify-closing-after-{w}.png"))
            check(f"{w} closing: silence after the ring", s2["state"] == "SILENCE" and s2["market"] == "closed" and s2["bellShown"] == "night" and s2["tapeLabel"].startswith("SILENCE"), f"state {s2['state']} market {s2['market']} bell {s2['bellShown']} tape {s2['tapeLabel']} next {s2['nextLine']} plate {s2['plateLabel']} | {s2['plateWho']}")
            check(f"{w} closing: no console errors", not log["errors"], "; ".join(log["errors"][:3]))
            results["scenes"][f"closing-{w}"] = {"load": s0, "ring": s1, "after": s2, "log": log}
            ctx.close()

        # ---------------------------------------------------------------- theme=closed
        for (w, h) in [(1440, 900), (390, 844)]:
            ctx, page, log = new_page(browser, w, h)
            goto(page, "?theme=closed")
            time.sleep(1.0)
            s = page.evaluate(STATE_JS)
            shot = os.path.join(OUT, f"verify-theme-closed-{w}.png")
            page.screenshot(path=shot, full_page=True)
            pixels = pixel_pass(shot, s["bellRect"])
            design = page.evaluate(DESIGN_JS)
            design.pop("innerText")
            check(f"{w} theme=closed is dark", s["market"] == "closed" and s["bodyBg"] == "rgb(10, 11, 13)" and s["bellShown"] == "night", f"market {s['market']} bg {s['bodyBg']} bell {s['bellShown']} tapeLabel {s['tapeLabel']} state {s['state']}")
            check(f"{w} theme=closed: no blue outside the bell", pixels["blueOutsideBell"] == 0, json.dumps(pixels))
            check(f"{w} theme=closed: colors on the ramp", not design["offRamp"], json.dumps(design["offRamp"][:6]))
            check(f"{w} theme=closed: no console errors", not log["errors"], "; ".join(log["errors"][:3]))
            results["scenes"][f"theme-closed-{w}"] = {"state": s, "pixels": pixels, "offRamp": design["offRamp"], "log": log}
            ctx.close()

        # ---------------------------------------------------------------- demo=ring
        for name, query, (w, h) in [("demo-ring", "?demo=ring", (1440, 900)), ("demo-ring", "?demo=ring", (390, 844)), ("demo-ring-t", OPEN_T + "&demo=ring", (1440, 900))]:
            ctx, page, log = new_page(browser, w, h)
            goto(page, query)
            time.sleep(0.6)
            s = page.evaluate(STATE_JS)
            shot = os.path.join(OUT, f"verify-{name}-{w}.png")
            page.screenshot(path=shot)
            pixels = pixel_pass(shot, s["bellRect"])
            check(f"{w} {query} shows ringing", s["bell"] == "ringing" and s["state"] in ("RINGING", "CLOSING") and s["bellAnim"] == "swing" and "ringing" in s["marks"], f"bell {s['bell']} state {s['state']} meta {s['meta']} marks {s['marks']} anim {s['bellAnim']} plate {s['plateLabel']}")
            check(f"{w} {query}: no console errors", not log["errors"], "; ".join(log["errors"][:3]))
            results["scenes"][f"{name}-{w}"] = {"state": s, "pixels": pixels, "log": log}
            ctx.close()

        # ---------------------------------------------------------------- live page, no params
        ctx, page, log = new_page(browser, 1440, 900)
        goto(page, "")
        time.sleep(1.0)
        s = page.evaluate(STATE_JS)
        page.screenshot(path=os.path.join(OUT, "verify-live-1440.png"))
        # preview toggle flips the theme for the session and back
        page.click("#preview-toggle")
        time.sleep(0.2)
        flipped = page.evaluate("document.documentElement.dataset.market")
        label1 = page.evaluate("document.getElementById('preview-toggle').textContent.trim()")
        page.click("#preview-toggle")
        time.sleep(0.2)
        back = page.evaluate("document.documentElement.dataset.market")
        check("live: preview toggle flips and restores", flipped != s["market"] and back == s["market"], f"{s['market']} -> {flipped} ({label1}) -> {back}")
        check("live: no console errors", not log["errors"], "; ".join(log["errors"][:3]))
        results["scenes"]["live-1440"] = {"state": s, "log": log}
        ctx.close()

        # ---------------------------------------------------------------- reduced motion
        ctx, page, log = new_page(browser, 1440, 900, reduced=True)
        goto(page, OPEN_T)
        time.sleep(0.6)
        rm = page.evaluate("() => { const t = getComputedStyle(document.getElementById('tape-track')); const c = document.querySelector('.clock__time .colon'); return { tape: t.animationName, overflow: getComputedStyle(document.querySelector('.tape__scroll')).overflowX, colon: c ? getComputedStyle(c).animationName : '' }; }")
        check("reduced motion: tape static and scrollable, colon solid", rm["tape"] == "none" and rm["overflow"] == "auto" and rm["colon"] == "none", json.dumps(rm))
        results["scenes"]["reduced-motion"] = rm
        ctx.close()

        browser.close()

    with open(RESULTS, "w") as f:
        json.dump(results, f, indent=1, ensure_ascii=False, default=str)
    for c in results["checks"]:
        print(("PASS " if c["ok"] else "FAIL ") + c["check"] + (("  :: " + c["detail"][:300]) if (not c["ok"] or "countdown" in c["check"] or "tape scrolls" in c["check"] or "BEAT IT" in c["check"] or "LEADING" in c["check"]) else ""))
    print("ALL OK" if ok else "SOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
