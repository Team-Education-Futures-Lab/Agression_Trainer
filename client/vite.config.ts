import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],

  build: {
    rollupOptions: {
      input: {
        // Main app entry points
        main:  resolve(__dirname, "index.html"),
        demo:  resolve(__dirname, "demo.html"),
        admin: resolve(__dirname, "admin.html"),
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