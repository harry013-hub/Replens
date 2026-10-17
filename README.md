# RepLens

A mobile-first website that uses your phone's (or computer's) camera to count **push-ups**, **squats**, **bicep curls** and **shoulder presses** automatically. Pose tracking runs entirely in the browser with Google's MediaPipe Pose Landmarker. Video is never recorded or uploaded.

It's plain HTML, CSS and JavaScript, so there is no build step. Any static web host can serve the folder as it is.

---

## MealBase tab (food log, food search, meal plans)

RepLens now has a second tab, **MealBase**. Use the **RepLens | MealBase** switch at the top of the home screen (or open `/meals/`). MealBase lets you log breakfast, lunch, dinner and snacks, search the USDA food database, plan a Monday–Sunday week of meals, mark planned meals as eaten, and export your history.

- **Logging is optional.** Workouts never depend on it. If you've logged food today, the RepLens home screen shows the total ("Food logged today"), and MealBase's Today page has an **Open RepLens** button.
- **Your food log stays on this device**, in this browser's `localStorage` (key `mealbase.v1`), like RepLens history. Nothing is uploaded. Use **MealBase → Settings → Your data** to export CSV/JSON or delete it.
- **Calories are estimates.** MealBase is a logging and planning tool, not medical nutrition advice. Starter recipes use labelled sample ingredient data until they're re-linked to USDA records (see `mealbase/README.md`).

### Food search

Food search works on any host, including **GitHub Pages**, with nothing to set up:

- **GitHub Pages / any static host:** MealBase searches **[Open Food Facts](https://world.openfoodfacts.org)** directly from your browser. It's a free, community-made database of about 3 million products worldwide (no key needed). Store names are matched to their house brands, so "costco pizza" also finds Kirkland Signature products. It covers packaged and grocery foods; restaurant and food-court items (like Costco food-court pizza) generally aren't in it. Plain foods like fruit or raw meat are covered by the bundled generic foods list, and **Add manually** always works.
- **Netlify (optional):** if the site is deployed on Netlify from GitHub with `USDA_API_KEY` set in its environment variables, MealBase uses **USDA FoodData Central** through `netlify/functions/usda.mjs` instead. USDA's API can't be called straight from a web page, which is why it needs that function.
- **On your computer:** `USDA_API_KEY=your-key npm start` uses USDA through the same function; without a key it uses Open Food Facts.

Food data: Open Food Facts contributors (Open Database License) · U.S. Department of Agriculture, FoodData Central (public domain).

### Changing MealBase

MealBase's source, tests and documentation are in [`mealbase/`](mealbase/README.md). The tab you see is a prebuilt copy in `meals/`, so RepLens still needs no build step to deploy. After editing MealBase:

```bash
cd mealbase
npm install
npm test
npm run build:replens     # rebuilds ../meals and ../netlify/functions/usda.mjs
```

Commit the rebuilt `meals/` and `netlify/functions/usda.mjs` with your change. MealBase can also run as its own Node server with accounts; see `mealbase/docs/INTEGRATION.md`.

## 1. Run it on your computer (2 minutes)

You need [Node.js](https://nodejs.org) 18 or newer. (Python works too, see below.)

```bash
cd replens
npm start
```

Open **http://localhost:8080** in Chrome, Edge, Safari or Firefox. Choose an exercise, tap **Enable Camera**, and allow camera access.

No Node? Run `python3 -m http.server 8080` in the folder instead.

> `localhost` counts as a secure address **only on the computer itself**, which is why the camera works there.

## 2. Use it on your iPhone (needs HTTPS)

Phones only let websites use the camera over **HTTPS**. Two common mistakes:

- **`http://192.168.x.x:8080` won't work.** A plain `http://` address on your Wi-Fi is not secure, so Safari blocks the camera. The app shows a warning if you try.
- **`localhost` on the phone means the phone itself**, not your computer, so it can't reach your laptop's server.

The easiest fix is to publish the folder to a free static host that gives you an `https://` link.

### Option A: Netlify Drop (no account setup, no command line)
1. Go to <https://app.netlify.com/drop>.
2. Drag the whole `replens` folder onto the page.
3. You get a link like `https://something-random.netlify.app`. That's your HTTPS site. (Create a free account to keep it permanently.)

### Option B: GitHub Pages
1. Create a new GitHub repository and upload all the files in this folder (keep the folder structure).
2. In the repo, open **Settings → Pages**, set **Source: Deploy from a branch**, then choose **Branch: main** and the **/ (root)** folder. Save.
3. After about a minute your site is at `https://<your-username>.github.io/<repo-name>/`.

Cloudflare Pages and Vercel also work. Set them to "static site" with no build command and output directory `.`.

### Open it on the iPhone
1. Open **Safari** and type or paste the HTTPS link.
2. Choose an exercise, tap **Set up camera**, then **Enable Camera**, and tap **Allow** on the permission prompt.
3. Optional: Share → **Add to Home Screen** gives it an app-like icon.

**If the camera is blocked:** an embedded preview (inside a chat app, social app, code editor preview or iframe) often can't use the camera. Copy the link and open it **directly in Safari** (or Chrome on Android). If you tapped "Don't Allow" earlier, tap **aA** in Safari's address bar → **Website Settings** → **Camera** → **Allow**, then reload.

## 3. How to use it

1. **Choose** Push-ups or Squats. A rep target is optional.
2. **Set up camera → Enable Camera.**
3. **Place the phone securely to your side**, about 2–3 m away, so the outline shows the needed joints. The chip in the corner shows ✓ **Good**, ! **Adjust position** or ✕ **Not detected**. A text message also tells you what to fix.
4. **Start Workout.** You get a 5-second countdown. Then hold the start position (arms straight, or standing tall) for about half a second before counting begins.
5. **Pause / Resume / Finish** any time. Resume gives you a 3-second countdown and needs the start position again.
6. The **summary** shows reps, active time (pauses excluded), and date and time. Use **−1 / +1** to correct a missed or extra rep. **Start Another Set** reopens the camera.

Push-ups use **standard floor push-ups**, viewed from the side. Knee and incline push-ups are **not** supported modes.

## 4. How counting works

Pose detection (`js/pose.js`) and rep counting (`js/counter.js`, `js/exercises.js`) are separate. The counter never touches the camera or MediaPipe. It only sees measured angles, so it can be unit-tested with synthetic data.

**Per frame:**
1. MediaPipe returns 33 body landmarks, normalised to 0–1.
2. Landmarks are converted to **pixel coordinates** using the video's width and height before angles are computed. Normalised values would distort angles on 4:3 or 16:9 frames.
3. Every joint the exercise needs must have visibility ≥ 0.5 and be inside the frame. If not, you get a guidance message such as "Keep your elbows visible."
4. The app picks the clearer side of the body. Squats average both legs when both are clear and agree. **During a rep the side is locked**, so a rep never mixes left and right measurements.
5. Supporting posture checks rule out look-alike movements:
   - **Push-ups:** body roughly horizontal, hands below shoulders, and legs extended. Standing arm bends are never counted.
   - **Squats:** upright posture, and the hips must actually move down. Lifting a knee or bending in place isn't counted.
6. The angle is smoothed with a **time-based** filter, so 10 fps and 30 fps phones behave the same.

**State machine:**

```
WAITING_FOR_START ──(at top, stable 600 ms)──▶ READY_AT_TOP
READY_AT_TOP ──(angle < "leave top")──▶ MOVING_DOWN
MOVING_DOWN ──(angle ≤ "bottom" + hips/shoulders really lowered)──▶ BOTTOM_REACHED
MOVING_DOWN ──(back to top without reaching bottom)──▶ READY_AT_TOP   (not counted)
BOTTOM_REACHED ──(angle ≥ "leave bottom")──▶ RETURNING_TO_TOP
RETURNING_TO_TOP ──(angle ≥ "top", stable 120 ms)──▶ +1 rep → READY_AT_TOP
```

- **Hysteresis.** Entry and exit thresholds differ, so jitter near a line can't flip the state back and forth.
- **Tracking lost** for more than 300 ms, or a frame gap over 700 ms, throws away the incomplete rep. Completed reps are kept, and counting restarts only after a stable start position.
- **No counting** during setup, the countdown, pause, a camera switch or poor tracking. Starting in the lowered position never gives a free rep.
- **Minimum time between reps** is 450 ms for push-ups and 600 ms for squats.

### Adjustable thresholds (degrees)

These are **detection heuristics, not exercise standards or form judgements.** Change them in **Settings → Detection thresholds**. Invalid or overlapping values are rejected.

| | Start position | Leave start | Leave end | End position |
|---|---|---|---|---|
| Push-ups (elbow: shoulder–elbow–wrist), side view | 155 | 145 | 110 | 100 |
| Squats (knee: hip–knee–ankle), side view | 160 | 150 | 120 | 110 |
| Bicep curls (elbow), side view | 150 | 140 | 82 | 70 |
| Shoulder press (elbow), front view, **angle rises** | 100 | 110 | 140 | 150 |

Supporting checks for the new exercises: a curl only counts if the hand actually rises toward the shoulder with the upper arm hanging by the side (so push-ups and presses never count as curls). A press only counts if the hands start above the elbows and actually rise well above the shoulders (so arms hanging or curls never count as presses). Curls track the arm nearest the camera, or both arms when they move together; alternating arms is not a separate mode yet.

**Squat calibration** (Setup → Calibrate) records your own comfortable standing and lowered positions. It rejects the result if tracking was poor, if you weren't holding still, or if the two positions are too similar (under 35° apart). It always keeps the thresholds in order and well separated. There is no "correct" depth; RepLens is an approximate rep counter, not a clinical form assessment.

Timing values are in `js/counter.js` (`DEFAULT_TIMING`) and per-exercise overrides are in `js/exercises.js`.

## 5. Model and library versions

Set in `js/config.js`:

| What | Version / source |
|---|---|
| `@mediapipe/tasks-vision` | **1.1.1**, pinned. This was the `latest` tag on jsDelivr when this was written. The JS bundle and `wasm/` folder load from the same version. |
| Fallback library | 0.10.34 on jsDelivr, used only if 1.1.1 fails to load or start |
| Model | `pose_landmarker_lite` float16, model version 1 (about 5.5 MB), from Google's model storage |
| Mode | `runningMode: "VIDEO"`, `numPoses: 1`, GPU delegate with automatic CPU fallback |

The first visit downloads about 15 MB (library + WASM + model), which the browser then caches. These downloads contain **no camera data**.

**Optional self-hosting** removes the dependency on jsDelivr and Google at runtime:
```bash
npm install
npm run vendor
```
This fills `vendor/tasks-vision/` and `models/`, and the app uses those local copies automatically. Deploy the folder including them.

If tracking never appears on a particular phone, try **Settings → Compatibility mode** to force CPU processing.

## 6. Privacy

- The camera starts only when you tap **Enable Camera**. Only video is requested; the microphone never is.
- Frames are processed in the page's memory and then discarded. Nothing is recorded or uploaded, and there are no analytics or third-party scripts that see frames.
- Only **session summaries** (exercise, reps, duration, date) and preferences are saved, in `localStorage` on your device. Video, photos and landmarks are never stored. **Clear history** deletes the summaries.
- **MealBase** keeps your food log in `localStorage` on your device too. Food searches send only the search text (or a product id) to Open Food Facts, or to USDA FoodData Central through the site's own function when it's set up.
- **Finish**, **Stop camera**, leaving the page, or going back to Home stops every camera track and stops inference. Switching apps or locking the phone pauses the workout, and you must tap Resume.

## 7. Files

```
index.html               single page: home, setup, workout, summary, sheets
css/styles.css           all styles (safe areas, portrait/landscape, reduced motion)
js/app.js                UI flow and lifecycle (pause, resume, visibility, wake lock)
js/camera.js             getUserMedia, switching, cleanup, error classification
js/pose.js               MediaPipe loading, adaptive one-at-a-time inference loop
js/overlay.js            skeleton drawing aligned with object-fit + mirroring
js/exercises.js          per-exercise measurement, side locking, guidance, tracker
js/counter.js            generic rep state machine (pure logic)
js/calibration.js        squat calibration → validated thresholds (pure logic)
js/geometry.js           pixel conversion, angles, time-based smoothing
js/audio.js              synthesized rep sounds, optional spoken numbers
js/storage.js            local summaries and preferences, with in-memory fallback
js/config.js             pinned library, WASM and model URLs
tests/*.test.js          unit tests (node --test)
tests/e2e/               headless browser checks with a fake camera and fake model
scripts/serve.mjs        local static server (npm start)
scripts/vendor.mjs       optional self-hosting of library and model
_headers                 Netlify/Cloudflare headers (camera allowed, microphone denied)
js/meals-link.js         "Food logged today" card on the home screen (reads MealBase's local data)
meals/                   MealBase tab — prebuilt from mealbase/ (do not edit by hand)
netlify/functions/usda.mjs  USDA food-search proxy that keeps the API key server-side (generated)
mealbase/                MealBase source, tests and docs
tests/e2e/mealbase_tab_test.py  browser check of the MealBase tab inside RepLens
```

## 8. Testing: what was verified and what wasn't

### Automated, and passing
- **`npm test` runs 58 unit tests.** They cover the state machine and exercise trackers with synthetic angle and landmark sequences:
  - one rep and many reps
  - partial reps
  - holding the top or bottom
  - jitter around both thresholds
  - starting at the bottom
  - low-confidence joints
  - tracking loss mid-rep, and a brief dropout within the grace period
  - pause and resume
  - camera switch and frame gaps
  - switching exercises
  - 6, 8, 10, 15, 24, 30 and 60 fps
  - side locking
  - standing arm bends rejected as push-ups
  - knee bends without the hips dropping rejected as squats
  - pixel-space angle correctness on 4:3 frames
  - calibration accept and reject cases
  - storage persistence, corruption and unavailability
- **`npm run test:browser` runs 62 headless Chromium checks** (fake camera, phone-sized viewports):
  - no horizontal scroll in portrait, landscape, at 320 px and on desktop
  - all tap targets at least 44 px
  - the camera is not requested on load, and the request is video-only
  - permission denied, no camera and camera in use each give a clear message
  - a warning on a plain-HTTP network address
  - model download failure shows a retry
  - the full workout flow driven by a **fake pose model** that emits synthetic landmarks:
    - countdown, with no counting during it
    - reps counted
    - holding a position adds nothing
    - tracking loss mid-rep isn't counted
    - pause stops inference, and the timer excludes paused time
    - resume
    - leaving the app pauses
    - finish releases the camera
    - correction, history after a reload, and clear history with confirmation
  - the settings validation and developer panel
  - the warning when storage is unavailable

### Not verified (please test on real devices)
- **The real MediaPipe library and model were never executed while building this.** The build environment couldn't download them. The integration follows the official Pose Landmarker web guide and the 1.1.1 type definitions, and it has fallbacks: an older library version, CPU instead of GPU, and clear error messages. Still, the first real run is on your device.
- **Tracking accuracy on real bodies and real camera footage is untested.** The thresholds are reasonable starting points, not tuned values.
- **No physical iPhone or Android device was used.** Safari-specific behaviour, such as permission prompts, track muting during calls, wake lock and audio unlock, is implemented by the book but unconfirmed.

### Physical-device checklist

**iPhone (Safari, iOS 16.4 or newer recommended)**
- [ ] HTTPS link opens; home screen fits with no sideways scrolling, in portrait and landscape
- [ ] Notch and home-indicator spacing look right
- [ ] Enable Camera shows the iOS prompt; Allow gives a live preview (front camera mirrored, back camera not)
- [ ] "Don't Allow" gives the denied message; fixing it in aA → Website Settings works after a reload
- [ ] Loading indicator appears; the model loads on Wi-Fi and on cellular
- [ ] The skeleton lines up with your body in portrait and landscape, front and back camera
- [ ] Push-ups, side view, about 2 m away: 10 slow and 10 fast reps counted correctly; open the developer panel to note the elbow angles
- [ ] Squats, side view: 10 reps counted; standing still and small knee bends add nothing; calibration works
- [ ] Walking into view, or starting in the bottom position, gives no free rep
- [ ] Rep sound plays after tapping Start; mute and volume work; the screen stays awake (wake lock)
- [ ] Locking the phone or switching apps mid-workout pauses it; on return, Resume is needed and no rep spans the gap
- [ ] Pause → switch camera → resume works; Finish turns off the camera indicator
- [ ] Summary correction and history survive a reload; Private Browsing shows the "history won't be saved" note
- [ ] Inference timing in the developer panel is under about 60 ms; if tracking never appears, try Compatibility mode

**Android (Chrome)**
- [ ] The same checks as above; also check the camera switch on phones with several rear cameras, and permission reset via the lock icon → Permissions

## 9. Known limitations
- One person at a time, with manual exercise selection.
- 2D angles from a single camera work best in a **side view**. A front view makes elbow and knee angles unreliable.
- Bad lighting, baggy clothing, or a cut-off body lowers confidence, and tracking then pauses rather than guessing.
- Inference runs on the main thread, throttled to the device's speed. On slow devices, very fast reps can be missed. A Web Worker would be a future improvement.
- Spoken rep numbers are experimental and off by default; speech support varies by browser.
