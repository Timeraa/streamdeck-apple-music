import { defineConfig } from "vite-plus";

const sdPlugin = "com.timeraa.apple-music-volume.sdPlugin";

// Vite+ embeds tsdown as its `pack` ("Build library") command, so the plugin
// bundle is configured here under `pack` — no separate `tsdown` dependency or
// `tsdown.config.ts` needed.
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // Bundle the Node plugin entry into a single self-contained ESM file for the
  // Stream Deck runtime (which has no node_modules), so every dependency is
  // bundled. `clean: false` is important — the output dir also holds the Swift
  // `music-volume` binary, which must not be wiped.
  pack: {
    entry: ["src/plugin.ts"],
    outDir: `${sdPlugin}/bin`,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: true,
    clean: false,
    dts: false,
    shims: true,
    // Stream Deck's manifest references bin/plugin.js, so emit .js (not .mjs).
    outExtensions: () => ({ js: ".js" }),
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: false,
    },
  },
});
