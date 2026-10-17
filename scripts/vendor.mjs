// OPTIONAL: self-host the pose library + model so the app doesn't depend on
// jsDelivr / Google Storage at runtime.
//   npm install        (installs the pinned @mediapipe/tasks-vision)
//   npm run vendor     (copies it into ./vendor and downloads the model into ./models)
// The app automatically prefers these local copies when they exist.
import { cp, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const src = resolve(root, 'node_modules/@mediapipe/tasks-vision');
const dst = resolve(root, 'vendor/tasks-vision');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

try {
  await stat(src);
} catch {
  console.error('Run "npm install" first (installs @mediapipe/tasks-vision).');
  process.exit(1);
}
await mkdir(dst, { recursive: true });
await cp(resolve(src, 'vision_bundle.mjs'), resolve(dst, 'vision_bundle.mjs'));
await cp(resolve(src, 'wasm'), resolve(dst, 'wasm'), { recursive: true });
console.log('Copied library + WASM to vendor/tasks-vision');

await mkdir(resolve(root, 'models'), { recursive: true });
const res = await fetch(MODEL_URL);
if (!res.ok) { console.error(`Model download failed: HTTP ${res.status}`); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
await writeFile(resolve(root, 'models/pose_landmarker_lite.task'), buf);
console.log(`Downloaded model (${(buf.length / 1e6).toFixed(1)} MB) to models/`);
