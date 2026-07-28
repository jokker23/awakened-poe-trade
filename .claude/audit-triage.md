# npm audit triage — 2026-07-28

Context: built Windows portable 3.29.102 from upstream-merged master. `npm audit --audit-level=high`
in `main/` reports 16 high advisories. Per the supply-chain bypass clause, these were manually
triaged and the user approved accepting them (chose "revert override, accept advisories").

## Accepted advisories

### brace-expansion <=5.0.7 (GHSA-mh99-v99m-4gvg) — all 16 highs cascade from this
- OOM DoS via unbounded expansion. Only patched version is 5.0.8, published 2026-07-23
  (inside the 14-day quarantine window).
- Every affected copy is in electron-builder's **build-time** toolchain (nested minimatch/glob
  under @electron/asar, glob, dir-compare, filelist, @electron/universal). None ships in the
  packaged app — the app bundle is esbuild output (main.js/vision.js) + renderer dist only.
- Inputs to these globs are our own electron-builder config; no untrusted input.
- An override to 5.0.8 was tried and reverted: besides the quarantine window, app-builder-lib
  hard-pins @electron/asar@3.4.1 whose minimatch 3 crashes ("expand is not a function") on
  brace patterns when brace-expansion 5.x is forced. The fixed asar is a 4.x major that
  app-builder-lib 26.9 does not accept.
- Revisit after ~2026-08-06 (5.0.8 clears the 14-day window), or when upstream bumps
  electron-builder past 26.9 (newer app-builder-lib pulls fixed deps; note the repo's
  build/app-builder-lib+26.8.1.patch must be regenerated for versions >26.9 — 26.15.3
  conflicted with it).

### ws 8.20.0 (GHSA-58qx-3vcg-4xpx uninitialized memory disclosure, GHSA-96hv-2xvq-fx4p DoS)
- Runtime dep, bundled into main.js. Fix wave (8.21.x, plus 5.2.7/6.2.6/7.5.13 backports)
  published 2026-07-17 — also inside the 14-day window as of this build.
- Exposure: local WebSocket server bound to 127.0.0.1 with a random port by default
  (LAN-exposed only if the user passes --listen=0.0.0.0). Same version upstream ships in
  official releases.
- Action: bump ws to >=8.21.1 after 2026-07-31 and rebuild.

## Build notes
- Global npmrc has ignore-scripts=true, so electron's binary never downloads on install and
  `npm rebuild electron` is also blocked. Fix: `node node_modules/electron/install.js`
  (electron is the repo's documented allowScripts exception in main/package.json).
- Keep upstream's package-lock.json pristine: plain `npm install` floats app-builder-lib
  (26.9.0 → 26.15.3) which breaks the repo patch. Use `npm ci --ignore-scripts` then
  `npx patch-package --patch-dir build`.
- Windows portable build sequence (WSL, no wine needed):
  `renderer: npm run make-index-files && npm run build` →
  `main: npm run build && npm run package -- --win portable` → `main/dist/*.exe`.
