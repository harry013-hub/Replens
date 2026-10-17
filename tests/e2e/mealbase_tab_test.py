"""
Browser check for the MealBase tab inside RepLens (Chromium via Playwright).

Starts RepLens's own server (scripts/serve.mjs) and a fake USDA API, then:
switch RepLens → MealBase, search a food, log a portion, plan next week, swap a meal,
log it as eaten, reload (data persists), switch back and see today's food total on
the RepLens home screen. Also checks the site without the USDA proxy (manual entry only).

Run:  python3 tests/e2e/mealbase_tab_test.py   (from the project root)
"""
import os, re, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright, expect

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.environ.get("E2E_OUT", os.path.join(ROOT, "tests", "e2e", "screens"))
os.makedirs(OUT, exist_ok=True)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def start(cmd, env):
    return subprocess.Popen(cmd, cwd=ROOT, env={**os.environ, **env}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


usda_port, site_port, plain_port = free_port(), free_port(), free_port()
procs = [
    start(["node", "mealbase/tests/fixtures/fake-usda-server.mjs", str(usda_port)], {}),
    start(["node", "scripts/serve.mjs"], {"PORT": str(site_port), "USDA_API_KEY": "test", "USDA_API_BASE_URL": f"http://127.0.0.1:{usda_port}/fdc/v1"}),
    start(["python3", "-m", "http.server", str(plain_port), "--bind", "127.0.0.1"], {}),
]
time.sleep(1.5)
BASE = f"http://localhost:{site_port}"

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="America/Los_Angeles")
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(BASE + "/")
        check("site opens on the Tracker-Fit main menu", page.get_by_role("link", name="MealBase").first.is_visible())
        page.goto(BASE + "/#replens")
        expect(page.get_by_role("heading", name="RepLens")).to_be_visible()
        check("RepLens home shows the app switch", page.get_by_role("navigation", name="Apps").is_visible())
        check("food card hidden before MealBase is used", page.locator("#meals-today").is_hidden())
        page.screenshot(path=os.path.join(OUT, "mb-01-replens-home.png"), full_page=True)

        page.get_by_role("link", name="MealBase").click()
        expect(page).to_have_url(re.compile(r"/meals/"))
        expect(page.get_by_role("heading", name="Today", exact=True)).to_be_visible()
        check("MealBase opens from the tab", True)
        check("workout card links to RepLens", page.get_by_role("link", name="Open RepLens").is_visible())

        page.get_by_role("region", name="Breakfast").get_by_role("button", name="Add food").click()
        page.get_by_role("searchbox").fill("banana")
        page.get_by_role("button", name="Search", exact=True).click()
        expect(page.get_by_role("button", name=re.compile("^Bananas, raw")).first).to_be_visible()
        check("USDA results via the proxy", page.get_by_text("USDA FoodData Central · SR Legacy").first.is_visible())
        page.get_by_role("button", name=re.compile("^Bananas, raw")).first.click()
        page.get_by_label("Amount").fill("150")
        page.get_by_role("button", name="Add to Breakfast").click()
        expect(page.get_by_role("status").filter(has_text="Added Bananas, raw")).to_be_visible()

        page.get_by_role("link", name="Today", exact=True).click()
        expect(page.locator(".mb-tally-number")).to_contain_text("134")
        check("daily total updates", True)
        page.screenshot(path=os.path.join(OUT, "mb-02-today.png"), full_page=True)

        page.get_by_role("link", name="Meal Plan", exact=True).click()
        page.get_by_role("button", name=re.compile("^Create plan for")).click()
        expect(page.get_by_role("button", name="Log as eaten")).to_have_count(21)
        check("21-meal plan generated in the browser", True)
        lunch = page.locator("article.mb-plan-meal", has=page.locator(".mb-plan-meal-type", has_text="Lunch")).first
        before = lunch.locator("h3").inner_text()
        lunch.get_by_role("button", name="Swap").click()
        expect(page.get_by_role("status").filter(has_text="Swapped lunch")).to_be_visible()
        lunch = page.locator("article.mb-plan-meal", has=page.locator(".mb-plan-meal-type", has_text="Lunch")).first
        check("swap changes the meal", lunch.locator("h3").inner_text() != before)
        lunch.get_by_role("button", name="Log as eaten").click()
        page.get_by_role("dialog", name="Log as eaten").get_by_role("button", name="Add to food log").click()
        expect(lunch.get_by_text("Logged")).to_be_visible()
        page.get_by_role("button", name="Save plan").click()
        expect(page.get_by_role("status").filter(has_text="Plan saved")).to_be_visible()
        page.screenshot(path=os.path.join(OUT, "mb-03-plan.png"), full_page=True)

        page.reload()
        expect(page.get_by_text("Saved plan")).to_be_visible()
        check("plan and log survive a reload", page.locator(".mb-badge", has_text="Logged").count() == 1)
        page.get_by_role("link", name="History", exact=True).click()
        expect(page.locator(".mb-list-item").first).to_contain_text("2 entries")
        check("history shows today's two entries", True)

        page.get_by_role("navigation", name="Apps").get_by_role("link", name="RepLens").click()
        expect(page.get_by_role("heading", name="RepLens")).to_be_visible()
        expect(page.locator("#meals-today")).to_be_visible()
        kcal = page.locator("#meals-today-kcal").inner_text()
        check("RepLens home shows food logged today", re.search(r"\d", kcal) is not None, kcal)
        check("workout flow still reachable", page.get_by_role("button", name="Set up camera").is_enabled())
        # The Skelesquat battle reads the same MealBase total: HP = clamp(100 + kcal/10, 100, 350)
        kcal_n = int(re.sub(r"[^0-9]", "", kcal))
        page.goto(BASE + "/#campaign")
        expected_hp = round(min(350, max(100, 100 + kcal_n / 10)))
        check("Campaign boss HP uses MealBase's logged calories", page.locator("#camp-hp").inner_text() == str(expected_hp), f"{kcal_n} kcal → {page.locator('#camp-hp').inner_text()} HP")
        page.goto(BASE + "/#replens")
        page.screenshot(path=os.path.join(OUT, "mb-04-replens-with-food.png"), full_page=True)
        check("no horizontal scroll on RepLens home", page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
        check("no JS errors", not errors, "; ".join(errors))

        # Plain static host with no USDA function (e.g. GitHub Pages) → Open Food Facts.
        # The real API isn't reachable from CI, so its responses are served from fixtures.
        FIX = os.path.join(ROOT, "mealbase", "tests", "fixtures")
        off_calls = []
        def off_route(route):
            url = route.request.url
            off_calls.append({"url": url, "xua": route.request.headers.get("x-user-agent", "")})
            if "/cgi/search.pl" in url:
                body = open(os.path.join(FIX, "off-search-oat.json")).read()
            elif "/api/v2/product/0000000000017.json" in url:
                body = open(os.path.join(FIX, "off-product-0000000000017.json")).read()
            else:
                return route.fulfill(status=404, body='{"status":0}', headers={"Access-Control-Allow-Origin": "*"})
            route.fulfill(status=200, body=body, headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
        plain_ctx = browser.new_context(viewport={"width": 390, "height": 844})
        def sal_route(route):
            off_calls.append({"url": route.request.url, "xua": route.request.headers.get("x-user-agent", "")})
            url = route.request.url
            if "kirkland" in url:
                body = open(os.path.join(FIX, "sal-search-kirkland-pizza.json")).read()
            elif "pizza" in url:
                body = '{"hits": [], "count": 0}'
            else:  # simulate the search service being down -> legacy search fallback
                return route.fulfill(status=503, body="", headers={"Access-Control-Allow-Origin": "*"})
            route.fulfill(status=200, body=body, headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"})
        plain_ctx.route("https://world.openfoodfacts.org/**", off_route)
        plain_ctx.route("https://search.openfoodfacts.org/**", sal_route)
        plain = plain_ctx.new_page()
        plain_errors = []
        plain.on("pageerror", lambda e: plain_errors.append(str(e)))
        plain.goto(f"http://127.0.0.1:{plain_port}/meals/#/search")
        plain.get_by_role("searchbox").fill("costco pizza")
        plain.get_by_role("button", name="Search", exact=True).click()
        expect(plain.get_by_role("heading", name="Open Food Facts")).to_be_visible()
        check("'costco pizza' finds Kirkland Signature products", plain.get_by_role("button", name=re.compile("^Pepperoni Pizza.*Kirkland Signature")).is_visible())
        plain.screenshot(path=os.path.join(OUT, "mb-06-costco-pizza.png"), full_page=True)
        # Search-a-licious is "down" for this query, which exercises the legacy-search fallback
        plain.get_by_role("searchbox").fill("oat")
        plain.get_by_role("button", name="Search", exact=True).click()
        expect(plain.get_by_role("button", name=re.compile("^Rolled Oats"))).to_be_visible()
        check("GitHub Pages mode searches Open Food Facts", True)
        check("plain requests: no custom headers (no CORS preflight), no key", bool(off_calls) and not off_calls[0]["xua"] and "api_key" not in off_calls[0]["url"])
        plain.get_by_role("button", name=re.compile("^Rolled Oats")).click()
        expect(plain.get_by_role("heading", name="Rolled Oats")).to_be_visible()
        plain.get_by_label("Unit").select_option(label="1 serving (1/2 cup (40 g)) (40 g)")
        plain.get_by_label("Amount").fill("1")
        plain.get_by_role("button", name=re.compile("^Add to ")).click()
        expect(plain.get_by_role("status").filter(has_text="Added Rolled Oats")).to_be_visible()
        plain.goto(f"http://127.0.0.1:{plain_port}/meals/#/")
        expect(plain.locator(".mb-tally-number")).to_contain_text("150")
        check("Open Food Facts portion logged with correct calories", True)
        plain.screenshot(path=os.path.join(OUT, "mb-05-off-today.png"), full_page=True)
        check("manual entry is still offered", True)
        check("no JS errors on the static host", not plain_errors, "; ".join(plain_errors))

        # A browser that can't fetch() Open Food Facts (e.g. CORS/privacy blocking) → JSONP fallback.
        jsonp_ctx = browser.new_context(viewport={"width": 390, "height": 844})
        def blocked_or_jsonp(route):
            req = route.request
            if req.resource_type == "script" and "/cgi/search.pl" in req.url:
                from urllib.parse import urlparse, parse_qs
                cb = parse_qs(urlparse(req.url).query)["jsonp"][0]
                body = open(os.path.join(FIX, "off-search-oat.json")).read()
                return route.fulfill(status=200, body=f"{cb}({body});", headers={"Content-Type": "text/javascript"})
            route.abort()
        jsonp_ctx.route("https://world.openfoodfacts.org/**", blocked_or_jsonp)
        jsonp_ctx.route("https://search.openfoodfacts.org/**", lambda route: route.abort())
        jp = jsonp_ctx.new_page()
        jp.goto(f"http://127.0.0.1:{plain_port}/meals/#/search")
        jp.get_by_role("searchbox").fill("oat")
        jp.get_by_role("button", name="Search", exact=True).click()
        expect(jp.get_by_role("button", name=re.compile("^Rolled Oats"))).to_be_visible(timeout=20000)
        check("search still works when fetch is blocked (JSONP fallback)", True)
        jp.get_by_role("button", name=re.compile("^Oat Drink")).click()
        expect(jp.get_by_role("heading", name="Oat Drink")).to_be_visible(timeout=20000)
        check("product details fall back to search data", jp.get_by_text("Per 100 ml").is_visible())
        browser.close()
finally:
    for pr in procs:
        pr.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
