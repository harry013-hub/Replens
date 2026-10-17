"""
Optional browser test of the core flow (requires Python + Playwright:
  pip install playwright && python -m playwright install chromium).

Run against a MealBase server that uses the fake USDA server:
  node tests/fixtures/fake-usda-server.mjs 4555 &
  USDA_API_KEY=test USDA_API_BASE_URL=http://127.0.0.1:4555/fdc/v1 PORT=3333 DATABASE_PATH=/tmp/e2e.sqlite npm start &
  python tests/e2e/core_flow.py http://127.0.0.1:3333 ./e2e-shots
"""
import os
import re
import sys
from playwright.sync_api import sync_playwright, expect

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3333"
OUT = sys.argv[2] if len(sys.argv) > 2 else "e2e-shots"
os.makedirs(OUT, exist_ok=True)


def shot(page, name):
    page.screenshot(path=os.path.join(OUT, f"{name}.png"), full_page=True)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, timezone_id="Europe/London", locale="en-GB")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    # Today
    page.goto(BASE + "/")
    expect(page.get_by_role("heading", name="Today", exact=True)).to_be_visible()
    expect(page.get_by_text("Workout connection not configured")).to_be_visible()
    shot(page, "01-today-empty")

    # Search food → choose portion → log
    page.get_by_role("region", name="Breakfast").get_by_role("button", name="Add food").click()
    expect(page).to_have_url(re.compile(r"/search\?meal=breakfast"))
    page.get_by_role("searchbox").fill("banana")
    page.get_by_role("button", name="Search", exact=True).click()
    expect(page.get_by_role("button", name=re.compile("Bananas, raw"))).to_be_visible()
    expect(page.get_by_text("Sample data (development only)")).to_be_visible()
    shot(page, "02-search-results")
    page.get_by_role("button", name=re.compile("^Bananas, raw")).first.click()
    expect(page.get_by_role("heading", name="Bananas, raw")).to_be_visible()
    page.get_by_label("Amount").fill("150")
    expect(page.get_by_text("Estimated for 150 g")).to_be_visible()
    shot(page, "03-food-detail")
    page.get_by_role("button", name="Add to Breakfast").click()
    expect(page.get_by_role("status").filter(has_text="Added Bananas, raw")).to_be_visible()

    # Daily total updates
    page.get_by_role("link", name="Today", exact=True).click()
    expect(page.locator(".mb-tally-number")).to_contain_text("134")
    expect(page.get_by_text("Bananas, raw", exact=True)).to_be_visible()
    shot(page, "04-today-logged")

    # Generate next week
    page.get_by_role("link", name="Meal Plan", exact=True).click()
    expect(page.get_by_role("heading", name="Plan a week")).to_be_visible()
    shot(page, "05-plan-setup")
    page.get_by_role("button", name=re.compile("^Create plan for")).click()
    expect(page.get_by_role("button", name="Log as eaten")).to_have_count(21)
    shot(page, "06-plan")

    # Swap a meal
    first_lunch = page.locator("article.mb-plan-meal", has=page.locator(".mb-plan-meal-type", has_text="Lunch")).first
    before_name = first_lunch.locator("h3").inner_text()
    first_lunch.get_by_role("button", name="Swap").click()
    expect(page.get_by_role("status").filter(has_text="Swapped lunch")).to_be_visible()
    first_lunch = page.locator("article.mb-plan-meal", has=page.locator(".mb-plan-meal-type", has_text="Lunch")).first
    after_name = first_lunch.locator("h3").inner_text()
    assert after_name != before_name, (before_name, after_name)

    # Log it as eaten (twice-click protection: second attempt is flagged)
    first_lunch.get_by_role("button", name="Log as eaten").click()
    dialog = page.get_by_role("dialog", name="Log as eaten")
    expect(dialog.get_by_text(after_name)).to_be_visible()
    dialog.get_by_label("Servings you ate").fill("1")
    shot(page, "07-log-dialog")
    dialog.get_by_role("button", name="Add to food log").click()
    expect(page.get_by_role("status").filter(has_text=f"Logged {after_name}")).to_be_visible()
    expect(first_lunch.get_by_text("Logged")).to_be_visible()
    first_lunch.get_by_role("button", name="Log as eaten").click()
    page.get_by_role("dialog", name="Log as eaten").get_by_role("button", name="Add to food log").click()
    expect(page.get_by_text("Already in your food log")).to_be_visible()
    page.get_by_role("dialog", name="Log as eaten").get_by_role("button", name="Cancel").click()

    # Save the plan
    page.get_by_role("button", name="Save plan").click()
    expect(page.get_by_role("status").filter(has_text="Plan saved")).to_be_visible()

    # Grocery list
    page.get_by_role("button", name="Grocery list").click()
    expect(page.get_by_role("dialog", name="Grocery list").locator("table")).to_be_visible()
    shot(page, "08-grocery")
    page.get_by_role("dialog", name="Grocery list").get_by_role("button", name="Close").first.click()

    # Reopen saved history
    page.get_by_role("link", name="History").click()
    # The planned lunch was logged for today (the dialog defaults future plan dates to today)
    expect(page.locator(".mb-list-item")).to_have_count(1)
    expect(page.locator(".mb-list-item").first).to_contain_text("2 entries")
    shot(page, "09-history")
    page.reload()
    page.get_by_role("link", name="Meal Plan", exact=True).click()
    expect(page.get_by_text("Saved plan")).to_be_visible()
    expect(page.locator(".mb-badge", has_text="Logged")).to_have_count(1)

    # Settings renders
    page.get_by_role("link", name="Settings").click()
    expect(page.get_by_role("heading", name="Daily calorie target")).to_be_visible()
    shot(page, "10-settings")

    # Desktop layout snapshot
    page.set_viewport_size({"width": 1280, "height": 900})
    page.get_by_role("link", name="Meal Plan", exact=True).click()
    expect(page.get_by_text("Saved plan")).to_be_visible()
    shot(page, "11-plan-desktop")

    assert not errors, errors
    print("E2E core flow passed")
    browser.close()
