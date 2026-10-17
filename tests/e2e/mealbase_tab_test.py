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
        page.screenshot(path=os.path.join(OUT, "mb-04-replens-with-food.png"), full_page=True)
        check("no horizontal scroll on RepLens home", page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"))
        check("no JS errors", not errors, "; ".join(errors))

        # Plain static host with no USDA function (e.g. GitHub Pages)
        plain = browser.new_page(viewport={"width": 390, "height": 844})
        plain.goto(f"http://127.0.0.1:{plain_port}/meals/#/search")
        expect(plain.get_by_text(re.compile("shared demo key"))).to_be_visible()
        check("without the proxy, search uses USDA directly with the demo key", plain.get_by_text("Food database search isn't connected").count() == 0)
        check("manual entry is still offered", plain.get_by_role("button", name="Add manually").is_visible())
        plain.goto(f"http://127.0.0.1:{plain_port}/meals/#/settings")
        expect(plain.get_by_role("heading", name="USDA food search key")).to_be_visible()
        check("settings let you add your own key on this device", True)
        browser.close()
finally:
    for pr in procs:
        pr.terminate()

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
