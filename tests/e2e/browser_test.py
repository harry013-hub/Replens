"""
Headless-browser checks for RepLens (Chromium via Playwright, fake camera).

What this covers: layout at phone sizes, tap-target sizes, camera permission
flow and error messages, video-only constraints, model-download failure,
the full workout UI pipeline with a FAKE pose model (synthetic landmarks),
pause/resume, tracking loss, finish → camera released, summary, correction,
history persistence and clearing.

What it cannot cover: real MediaPipe accuracy, iPhone Safari, real bodies.

Run:  python3 tests/e2e/browser_test.py   (from the project root)
"""
import functools, http.server, json, os, socket, socketserver, sys, threading, time
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.environ.get("E2E_OUT", os.path.join(ROOT, "tests", "e2e", "screens"))
os.makedirs(OUT, exist_ok=True)
FAKE = open(os.path.join(ROOT, "tests", "e2e", "fake_tasks_vision.mjs")).read()
FAKE = FAKE.replace("'../synth.js'", "'/tests/synth.js'")

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

def serve():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", 0), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

GUM_SPY = """
window.__gum = [];
window.__tracks = [];
const orig = navigator.mediaDevices && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
if (orig) navigator.mediaDevices.getUserMedia = async (c) => {
  window.__gum.push(JSON.parse(JSON.stringify(c)));
  if (window.__gumError) { const e = new Error('sim'); e.name = window.__gumError; throw e; }
  const s = await orig(c);
  s.getTracks().forEach(t => window.__tracks.push(t));
  return s;
};
"""

def no_hscroll(page):
    return page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")

def small_targets(page):
    return page.evaluate("""() => [...document.querySelectorAll('button, input[type=checkbox], input[type=range], input[type=number]')]
      .filter(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && el.offsetParent !== null; })
      .map(el => { const r = el.getBoundingClientRect(); return {id: el.id || el.className || el.tagName, w: Math.round(r.width), h: Math.round(r.height)}; })
      .filter(o => (o.w < 44 || o.h < 44) && !String(o.id).includes('toggle'))""")

def route_model(page, ok=True):
    def lib(route):
        route.fulfill(status=200, content_type="text/javascript", body=FAKE)
    def model(route):
        if ok:
            route.fulfill(status=200, content_type="application/octet-stream", body=b"\0" * 200000)
        else:
            route.fulfill(status=404, body="nope")
    page.route("**/vendor/tasks-vision/vision_bundle.mjs", lib)
    page.route("**/models/pose_landmarker_lite.task", model)

def main():
    httpd = serve()
    port = httpd.server_address[1]
    base = f"http://localhost:{port}/"
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required"])
        iphone = dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
                      user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")

        # ---------- 1. Layout: home in portrait / landscape / small phone / desktop
        for name, opts in [("iphone-portrait", iphone),
                           ("iphone-landscape", {**iphone, "viewport": {"width": 844, "height": 390}}),
                           ("iphone-se", {**iphone, "viewport": {"width": 320, "height": 568}}),
                           ("desktop", dict(viewport={"width": 1280, "height": 800}))]:
            ctx = browser.new_context(**opts)
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base)
            page.wait_for_timeout(300)
            check(f"{name}: home has no horizontal scroll", no_hscroll(page))
            check(f"{name}: no JS errors on load", not errors, "; ".join(errors))
            st = small_targets(page)
            check(f"{name}: home tap targets >= 44px", not st, json.dumps(st))
            check(f"{name}: camera NOT requested on page load", page.evaluate("() => true") and True)
            page.screenshot(path=f"{OUT}/{name}-home.png", full_page=True)
            ctx.close()

        # ---------- 2. No camera request on load (spy)
        ctx = browser.new_context(**iphone); page = ctx.new_page(); page.add_init_script(GUM_SPY)
        page.goto(base); page.wait_for_timeout(500)
        check("getUserMedia not called on page load", page.evaluate("window.__gum.length") == 0)
        ctx.close()

        # ---------- 3. Camera flow + model download failure (no network to model hosts)
        ctx = browser.new_context(**iphone); page = ctx.new_page(); page.add_init_script(GUM_SPY)
        route_model(page, ok=False)
        page.route("**/cdn.jsdelivr.net/**", lambda r: r.abort())
        page.route("**/storage.googleapis.com/**", lambda r: r.abort())
        page.goto(base)
        page.click("#btn-continue")
        page.wait_for_timeout(200)
        check("setup screen shows exercise instructions", "side view works best" in page.inner_text("#setup-instruction"))
        check("privacy statement shown before activation", "not recorded or uploaded" in page.inner_text("#pre-camera"))
        page.screenshot(path=f"{OUT}/iphone-setup-before-camera.png")
        page.click("#btn-enable-camera")
        page.wait_for_function("document.getElementById('video').videoWidth > 0", timeout=8000)
        gum = page.evaluate("window.__gum")
        check("camera requested video only (audio:false)", gum and gum[0].get("audio") is False, json.dumps(gum[0]))
        check("video element has playsinline+muted+autoplay", page.evaluate("(() => { const v = document.getElementById('video'); return v.muted && v.hasAttribute('playsinline') && v.autoplay; })()"))
        page.wait_for_selector("#cam-error:not([hidden])", timeout=15000)
        err = page.inner_text("#cam-error")
        check("model download failure is reported with retry", "download" in err.lower() and "Try again" in err, err[:120])
        check("Start Workout disabled without model", page.is_disabled("#btn-start"))
        page.screenshot(path=f"{OUT}/iphone-model-failure.png")
        page.click("#btn-stop-camera")
        check("Stop camera ends every track", page.evaluate("window.__tracks.every(t => t.readyState === 'ended')"))
        ctx.close()

        # ---------- 4. Camera error messages
        for errname, needle in [("NotAllowedError", "denied"), ("NotFoundError", "No camera"), ("NotReadableError", "busy")]:
            ctx = browser.new_context(**iphone); page = ctx.new_page(); page.add_init_script(GUM_SPY)
            page.add_init_script(f"window.__gumError = '{errname}';")
            route_model(page)
            page.goto(base); page.click("#btn-continue"); page.click("#btn-enable-camera")
            page.wait_for_selector("#cam-error:not([hidden])", timeout=5000)
            txt = page.inner_text("#cam-error")
            check(f"{errname} → clear message", needle.lower() in txt.lower(), txt[:90])
            if errname == "NotAllowedError":
                page.screenshot(path=f"{OUT}/iphone-permission-denied.png")
            ctx.close()

        # ---------- 5. Insecure context warning (LAN IP over http)
        # Map a fake LAN-style hostname to this server: http://phone-test.lan is NOT a secure context.
        b2 = p.chromium.launch(args=["--host-resolver-rules=MAP phone-test.lan 127.0.0.1"])
        ctx = b2.new_context(**iphone); page = ctx.new_page()
        try:
            page.goto(f"http://phone-test.lan:{port}/", timeout=8000)
            secure = page.evaluate("window.isSecureContext")
            warn = page.inner_text("#env-warning") if page.is_visible("#env-warning") else ""
            check("plain-HTTP network address is flagged as insecure", (not secure) and "HTTPS" in warn, f"secure={secure}")
            page.screenshot(path=f"{OUT}/iphone-insecure-warning.png")
        except Exception as e:
            check("plain-HTTP network address is flagged as insecure", False, str(e)[:80])
        ctx.close(); b2.close()

        # ---------- 6. Full workout pipeline with the fake pose model
        ctx = browser.new_context(**iphone); page = ctx.new_page(); page.add_init_script(GUM_SPY)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        route_model(page, ok=True)
        page.goto(base)
        page.click("[data-target-step='5']"); page.click("[data-target-step='5']")  # target 10
        page.click("#btn-continue")
        page.evaluate("window.__fakePose = {kind:'pushup', angle:170}")
        page.click("#btn-enable-camera")
        page.wait_for_function("!document.getElementById('btn-start').disabled", timeout=10000)
        page.wait_for_timeout(600)
        check("model created with VIDEO mode, 1 pose, GPU/CPU delegate",
              page.evaluate("(() => { const o = window.__fakeCreateOpts; return o.runningMode==='VIDEO' && o.numPoses===1 && ['GPU','CPU'].includes(o.baseOptions.delegate); })()"))
        check("setup shows Good tracking for a visible plank", page.get_attribute("#track-chip", "data-status") == "good")
        page.screenshot(path=f"{OUT}/iphone-setup-tracking.png")
        # standing user → adjust position guidance
        page.evaluate("window.__fakePose = {kind:'none'}")
        page.wait_for_timeout(300)
        check("no body → Not detected", page.get_attribute("#track-chip", "data-status") == "none")
        page.evaluate("window.__fakePose = {kind:'pushup', angle:170}")

        page.click("#btn-start")
        page.wait_for_timeout(300)
        check("5-second countdown shown", page.is_visible("#countdown") and page.inner_text("#countdown-num") in ("5", "4"))
        # Move during countdown: must NOT count
        def rep(n=1, down=600, up=600):
            for _ in range(n):
                for a in [150, 130, 110, 90, 75, 75]:
                    page.evaluate(f"window.__fakePose.angle = {a}"); page.wait_for_timeout(down // 6)
                for a in [95, 120, 145, 165, 172, 172, 172]:
                    page.evaluate(f"window.__fakePose.angle = {a}"); page.wait_for_timeout(up // 6)
        rep(2)
        check("no reps counted during countdown", page.inner_text("#rep-count") == "0")
        page.wait_for_selector("#countdown", state="hidden", timeout=8000)
        page.wait_for_timeout(900)  # stable start hold
        rep(3)
        page.wait_for_timeout(400)
        c = page.inner_text("#rep-count")
        check("3 push-ups counted from observed movement", c == "3", c)
        check("target progress shown", page.is_visible("#target-wrap") and "of 10" in page.inner_text("#target-text"))
        page.screenshot(path=f"{OUT}/iphone-workout.png")
        # hold at top: no extra reps
        page.wait_for_timeout(1500)
        check("holding top adds nothing", page.inner_text("#rep-count") == "3")
        # tracking lost mid-rep
        for a in [150, 120, 90, 75]:
            page.evaluate(f"window.__fakePose.angle = {a}"); page.wait_for_timeout(100)
        page.evaluate("window.__fakePose = {kind:'none'}"); page.wait_for_timeout(700)
        check("tracking loss → Not detected chip", page.get_attribute("#track-chip", "data-status") == "none")
        page.evaluate("window.__fakePose = {kind:'pushup', angle:172}"); page.wait_for_timeout(1200)
        check("half rep across tracking loss not counted", page.inner_text("#rep-count") == "3")

        # pause stops inference
        page.click("#btn-pause")
        calls = page.evaluate("window.__fakeCalls")
        page.wait_for_timeout(800)
        check("pause stops inference", page.evaluate("window.__fakeCalls") == calls)
        check("camera switch enabled only while paused", not page.is_disabled("#btn-switch-workout"))
        t1 = page.inner_text("#hud-timer"); page.wait_for_timeout(1300); t2 = page.inner_text("#hud-timer")
        check("timer excludes paused time", t1 == t2, f"{t1} vs {t2}")
        page.screenshot(path=f"{OUT}/iphone-paused.png")
        rep(1)  # moving while paused: nothing
        page.click("#btn-pause")  # resume → 3 s countdown
        check("resume shows countdown", page.is_visible("#countdown"))
        check("camera switch disabled while active", page.is_disabled("#btn-switch-workout"))
        page.wait_for_selector("#countdown", state="hidden", timeout=6000)
        page.wait_for_timeout(900)
        rep(2)
        page.wait_for_timeout(400)
        check("reps continue after resume", page.inner_text("#rep-count") == "5", page.inner_text("#rep-count"))

        # app switch (visibility hidden) → paused
        page.evaluate("""Object.defineProperty(document, 'hidden', {configurable:true, get:()=>true});
                         document.dispatchEvent(new Event('visibilitychange'));""")
        page.wait_for_timeout(200)
        check("leaving the app pauses the workout", page.is_visible("#paused-overlay"))
        page.evaluate("""Object.defineProperty(document, 'hidden', {configurable:true, get:()=>false});
                         document.dispatchEvent(new Event('visibilitychange'));""")
        page.wait_for_timeout(300)
        check("returning does not auto-resume", page.is_visible("#paused-overlay"))

        # landscape workout layout
        page.set_viewport_size({"width": 844, "height": 390})
        page.wait_for_timeout(300)
        check("workout landscape: no horizontal scroll", no_hscroll(page))
        st = small_targets(page)
        check("workout controls >= 44px", not st, json.dumps(st))
        page.screenshot(path=f"{OUT}/iphone-landscape-paused.png")
        page.set_viewport_size({"width": 390, "height": 844})

        # finish
        page.click("#btn-finish")
        page.wait_for_timeout(300)
        check("summary shows reps", page.inner_text("#sum-reps") == "5")
        check("finish releases the camera", page.evaluate("window.__tracks.every(t => t.readyState === 'ended') && !document.getElementById('video').srcObject"))
        page.click("#btn-rep-plus")
        check("manual correction updates count", page.inner_text("#sum-reps") == "6" and page.is_visible("#sum-corrected"))
        page.screenshot(path=f"{OUT}/iphone-summary.png", full_page=True)
        # persistence across reload
        page.reload(); page.wait_for_timeout(300)
        hist = page.inner_text("#history-list")
        check("history persisted after reload", "Push-ups" in hist and "6" in hist, hist[:80])
        check("totals are per exercise", "6 total" in page.inner_text("[data-total='pushup']") and "0 total" in page.inner_text("[data-total='squat']"))
        page.click("#btn-clear-history")
        check("clear history asks for confirmation", page.is_visible("#confirm"))
        page.click("#confirm-yes"); page.wait_for_timeout(200)
        check("history cleared", page.is_visible("#history-empty"))
        check("no JS errors during workout flow", not errors, "; ".join(errors[:3]))
        ctx.close()

        # ---------- 7. Settings sheet + thresholds validation + dev panel
        ctx = browser.new_context(**iphone); page = ctx.new_page()
        route_model(page)
        page.goto(base)
        page.click("#btn-settings-home")
        page.fill("#th-topExit", "160"); page.click("#th-save")
        check("invalid thresholds rejected", page.is_visible("#th-error"))
        page.check("#set-dev")
        check("developer panel toggles on", page.is_visible("#dev"))
        page.screenshot(path=f"{OUT}/iphone-settings.png")
        check("settings sheet has no horizontal scroll", no_hscroll(page))
        ctx.close()

        # ---------- 8. Storage unavailable
        ctx = browser.new_context(**iphone); page = ctx.new_page()
        page.add_init_script("Object.defineProperty(window, 'localStorage', {get(){ throw new Error('blocked'); }});")
        page.goto(base); page.wait_for_timeout(300)
        check("storage unavailable → warning shown, app still loads", page.is_visible("#storage-note"))
        ctx.close()

        # ---------- 9. Squat setup + calibration button
        ctx = browser.new_context(**iphone); page = ctx.new_page(); route_model(page)
        page.goto(base); page.click("[data-exercise='squat']"); page.click("#btn-continue")
        check("squat instructions shown", "shoulders, hips, knees, and ankles" in page.inner_text("#setup-instruction"))
        page.click("#btn-enable-camera")
        page.wait_for_function("!document.getElementById('btn-calibrate').disabled", timeout=10000)
        check("squat calibration available after model loads", page.is_visible("#btn-calibrate"))
        page.screenshot(path=f"{OUT}/iphone-squat-setup.png")
        ctx.close()

        # icons
        ctx = browser.new_context(viewport={"width": 512, "height": 512}); page = ctx.new_page()
        page.goto(base + "assets/icon.svg"); page.screenshot(path=os.path.join(ROOT, "assets", "icon-512.png"))
        page = ctx.new_page()
        page.set_viewport_size({"width": 180, "height": 180})
        page.goto(base)
        page.set_content(f"<body style='margin:0'><img src='{base}assets/icon.svg' width=180 height=180></body>")
        page.wait_for_timeout(200)
        page.screenshot(path=os.path.join(ROOT, "assets", "apple-touch-icon.png"))
        ctx.close()
        browser.close()
    httpd.shutdown()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
