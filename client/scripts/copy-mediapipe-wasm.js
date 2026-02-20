// Copies MediaPipe WASM files from node_modules into public/mediapipe/
// so they can be served locally without CDN or CORS issues.
// Runs automatically after `npm install` via the postinstall hook.

import { cpSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src  = resolve(__dirname, "../node_modules/@mediapipe/tasks-vision/wasm");
const dest = resolve(__dirname, "../public/mediapipe");

if (!existsSync(src)) {
    console.error("❌ @mediapipe/tasks-vision not found — run npm install first");
    process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log("✓ MediaPipe WASM files copied to public/mediapipe/");
