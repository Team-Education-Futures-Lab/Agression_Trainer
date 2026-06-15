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

// VITE_BASE_PATH sets the URL prefix for all asset references in the built output.
// Vite bakes this into every <script src>, <link href>, and import() at build time,
// and exposes it as import.meta.env.BASE_URL in source code.
//
// Set this in Dokploy's Build Args tab (not Environment Variables — it is a
// build-time value, not a runtime one) to match the subpath Traefik routes to
// this container. Must begin and end with a slash when set to a subpath.
//
// Examples:
//   /          — served at the root (local dev default)
//   /client/   — served at localhost/client/ behind Traefik strip-prefix
const base = process.env["VITE_BASE_PATH"] ?? "/";

// Log the URLs being baked into the build so the build log makes it immediately
// visible whether the correct values were passed as build args.
console.log(`[build] HTTP base: ${process.env["VITE_APP_HTTP_URL"] ?? "http://localhost:3001 (default)"}`);
console.log(`[build] WS base:   ${process.env["VITE_APP_WS_URL"]   ?? "ws://localhost:3001 (default)"}`);

export default defineConfig({
  plugins: [react()],
  base,

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
        // AudioWorklet — compiled to a plain JS file, referenced at runtime via
        // `${import.meta.env.BASE_URL}worklets/pcm-processor.js` in capture.ts.
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