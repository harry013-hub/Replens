// Model + library configuration. Versions are PINNED on purpose.
//
// @mediapipe/tasks-vision 1.1.1 was the "latest" tag on npm/jsDelivr when this
// was written (Oct 2026). The JS file and its WASM folder MUST come from the
// same version, so both URLs below share one version string.
//
// Sources are tried in order:
//   1. ./vendor/tasks-vision/  — optional self-hosted copy (npm run vendor)
//   2. jsDelivr, pinned 1.1.1
//   3. jsDelivr, pinned 0.10.34 — older, widely deployed release kept as a
//      safety net in case of an incompatibility in the newer build.

export const MEDIAPIPE_VERSION = '1.1.1';
const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision';

export const LIB_SOURCES = [
  { label: 'self-hosted', module: new URL('../vendor/tasks-vision/vision_bundle.mjs', import.meta.url).href, wasm: new URL('../vendor/tasks-vision/wasm', import.meta.url).href, optional: true },
  { label: `jsDelivr ${MEDIAPIPE_VERSION}`, module: `${CDN}@${MEDIAPIPE_VERSION}/vision_bundle.mjs`, wasm: `${CDN}@${MEDIAPIPE_VERSION}/wasm` },
  { label: 'jsDelivr 0.10.34 (fallback)', module: `${CDN}@0.10.34/vision_bundle.mjs`, wasm: `${CDN}@0.10.34/wasm` },
];

// Pose Landmarker "lite" float16, model version 1 — the smallest/fastest
// pose model (~5.5 MB). Tried in order: self-hosted copy, then Google's host.
export const MODEL_SOURCES = [
  { label: 'self-hosted', url: new URL('../models/pose_landmarker_lite.task', import.meta.url).href, optional: true },
  { label: 'Google', url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task' },
];

// Camera request: modest resolution keeps inference fast on phones.
export const CAMERA = { width: 640, height: 480, frameRate: 30 };
