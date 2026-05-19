import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const devToolsEnabled = process.env["VITE_DEV_TOOLS"] === "true";

if (devToolsEnabled) {
  console.warn(
      "⚠  VITE_DEV_TOOLS=true — devtools page will be included in build output. " +
      "DO NOT deploy this build to a production or shared server."
  );
}

export default defineConfig({
  plugins: [react()],

  build: {
    rollupOptions: {
      input: {
        // Main app entry points
        main:  resolve(__dirname, "index.html"),
        demo:  resolve(__dirname, "demo.html"),
        admin: resolve(__dirname, "admin.html"),
        // Dev tools page — ONLY included when VITE_DEV_TOOLS=true at build time.
        // This is a build-time exclusion: when VITE_DEV_TOOLS is absent or false,
        // devtools.html is never compiled and cannot be served.
        // NEVER set VITE_DEV_TOOLS=true in production builds.
        ...(devToolsEnabled ? {
          devtools: resolve(__dirname, "devtools.html"),
        } : {}),
        // AudioWorklet — compiled to a plain JS file, referenced at
        // runtime via new URL("/worklets/pcm-processor.js", import.meta.url)
        "worklets/pcm-processor": resolve(
            __dirname,
            "src/worklets/pcm-processor.ts",
        ),
      },
      output: {
        // Keep the worklet output name predictable so capture.ts can
        // reference it with a stable URL.
        entryFileNames: (chunk) => {
          if (chunk.name === "worklets/pcm-processor") {
            return "worklets/pcm-processor.js";
          }
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});