# Building the desktop app

A double-clickable Nano Modules with **no installed dependencies** — no node,
no rust, no dxc, no wasi-sdk on the user's machine. macOS and Windows.

| | macOS | Windows |
|---|---|---|
| Effect IDE, Playground, Arrangement | ✅ | ✅ |
| Live mode, offline/read-only | ✅ | ✅ |
| NanoBarrel FFGL plugin + Resolume | ✅ | ❌ |

Windows is **app-only**. The barrel is Metal + Objective-C++ — one
`GPUBackend`, and `native/CMakeLists.txt` declares `OBJCXX`, so the native tree
will not even configure off macOS. See `WINDOWS.md`.

---

## Build it

```bash
# 1. Effect bundles + the shader translator. (Also fetches fonts, once.)
SERVED_ONLY=1 bash web/scripts/fetch_fonts.sh
bash native/wasm_modules/build_all.sh

# 2. The native plugin (macOS only).
cmake --build native/build

# 3. The web app, staged into the shared resource root.
cd web
npm run build:stage

# 4. The installer.
npm run package:mac      # dmg + zip, arm64
npm run package:win      # nsis + portable, x64 — cross-builds from a Mac
```

Artifacts land in `web/release/`.

`npm run build` alone is **not** a runnable app: `dist/` deliberately contains
no wasm, because the native plugin reads the same bundles and a second copy
would be 33 MB of duplication. `npm run stage` assembles the real artifact.

---

## The shared resource root

One directory serves the Electron renderer *and* the native FFGL plugin:

```
<root>/nano-resources.json     marker; both halves look for it
<root>/app/                    the built web app
<root>/wasm/*.wasm             effect bundles          (both)
<root>/wasm/*-<arch>.aot       AOT sidecars            (native only)
<root>/fonts/default.ttf       primary text face       (native only)
<root>/ffgl/NanoBarrel.bundle        the plugin        (macOS only)
<root>/ffgl/libbridge_server.dylib   its SIBLING
```

In a dev tree `<root>` is the repo's `build/` — where `build_all.sh` already
writes. Packaged, it is `Contents/Resources/nano` (Windows: `resources\nano`).

`libbridge_server.dylib` must stay the bundle's **direct sibling**: `dlopen`
shares one image only for the same path, so two copies means two WebSocket
servers fighting over port 8081.

### How the plugin finds it

`native/src/platform/resource_root.h`, first hit wins, each candidate checked
for a real `wasm/core.wasm`:

1. `NANO_RESOURCE_ROOT` — explicit; tests, CI, tools.
2. `NANO_BARREL_WASM_DIR` — back-compat; names the **wasm dir**, not the root.
3. **Walk up from the plugin's own loaded image**, looking for the marker at
   each ancestor and at `<ancestor>/build`. Finds the dev tree and an in-app
   plugin alike, with nothing configured.
4. The legacy in-bundle `Contents/Resources`, so an old deployment still runs.
5. The app's install record, written on every launch:
   `~/Library/Application Support/NanoBarrel/electron_app.json`
   (`%APPDATA%\NanoBarrel\` on Windows).

**Step 5 is last deliberately.** `barrel_host_portability` (a ctest) and
`soak_test.py` run the dev-built bundle with no env override and inherit
whatever the plugin resolves — so if an installed app outranked the walk, a
dev-tree test run would load a *released* app's effects and pass against code
that was never built here. Pinned by `native/tests/test_resource_root.cpp`.

The record only matters once the plugin has been **copied out** of the app into
a host's own plug-ins folder, where there is no app above it to find.

---

## Using it with Resolume

1. Launch Nano Modules once, so it records where it lives.
2. **File → Reveal FFGL Plugin in Finder**, or go to
   `Nano Modules.app/Contents/Resources/nano/ffgl/`.
3. Either point Resolume's FFGL search path at that folder, or copy
   **both** `NanoBarrel.bundle` *and* `libbridge_server.dylib` into your plugin
   directory — they must stay side by side.
4. Restart Resolume, add a NanoBarrel effect to a clip.
5. Back in the app, switch to Live mode. It connects on `ws://localhost:8081`.

Resolume's own webserver (port 8080) is a **separate** thing and is optional —
see "Running outside Resolume" in `native/src/plugin/nano_barrel/README.md` for
what its absence costs. None of it is in the render path.

---

## How the app is served

Packaged, the renderer loads from a custom `nano://app/` scheme, not `file://`
and not a localhost server.

- `file://` is out: Vite emits root-absolute URLs, and Chromium blocks module
  workers there — the app constructs three.
- A localhost server is out: an ephemeral port changes the origin every launch,
  and **IndexedDB is keyed by origin**, so settings, projects and the live
  cache would silently vanish on each start. A fixed port only defers that to
  whoever else wants the port.

A custom scheme has one stable origin by construction and opens no socket. It
is registered `secure` + `standard` + `supportFetchAPI`, which is what WebGPU,
IndexedDB, module workers and `wasm-host.ts`'s synchronous XHR each require.

**A packaged app starts with an empty IndexedDB** — a different origin from
`http://localhost:5173`. Sketches authored against the dev server do not carry
over, and `appMode` is unset, so a first launch lands in the effect IDE.

---

## Shaders

Effects ship SPIR-V; WebGPU wants WGSL. In dev that translation was a Vite
plugin spawning the `naga` CLI, which a packaged build has no access to.

`native/naga_spv/` is the naga crate built to `wasm32-wasip1` (~590 KB) and
called in process. It has to stay **synchronous**: `fetchShaderWgsl` runs inside
an effect's `init()`, across the wasm boundary, from C++ that expects a handle
back immediately.

`build_all.sh` builds it. If it is missing, dev still works (the app falls back
to the dev server) but `npm run build` **fails outright**, rather than shipping
something that starts and then renders nothing.

`web/src/naga-wgsl.test.ts` asserts the wasm and the CLI agree byte for byte.

---

## Development

`npm run electron` against a running `npm run dev` still works and is still the
supported development path — HMR, the C++ rebuild plugin and the naga bridge
all stay live. An unpackaged launch prefers a reachable dev server
automatically.

```bash
NANO_FORCE_PACKAGED=1 npm run electron   # exercise the shipping path
NANO_URL=http://localhost:5174/ ...      # point at a specific server
```

---

## Windows, and what CrossOver actually showed

The Windows installer cross-builds from macOS and its contents are correct, but
nobody has run it on real Windows hardware. It *was* run under CrossOver
(a `win11_64` bottle — a `win32` one cannot load an x64 Electron at all), and
the result splits cleanly in two.

**Everything except the GPU works.** From the CrossOver run:

```
[electron] mode=packaged root=C:\nano\resources\nano
           record=C:\users\crossover\AppData\Roaming\NanoBarrel\electron_app.json
[CONSOLE] "[electron] renderer running with node integration (electron 43.2.0)"
          source: C:\nano\resources\app.asar\electron\preload.cjs
[CONSOLE] source: nano://app/index.html
[CONSOLE] source: nano://app/assets/column-group-*.js
```

So on Windows: the resource root resolves, the install record lands in
`%APPDATA%\NanoBarrel\` (the same directory `nano_paths::supportDir()`
computes, with neither side told about the other), the custom scheme is
registered and serving, and the renderer boots and runs the app's own JavaScript.

**WebGPU does not.** The GPU process crashes on startup, repeatedly:

```
ERROR: DCompositionCreateDevice3 failed: Not implemented. (0x80004001)
ERROR: GPU process exited unexpectedly: exit_code=-1073741819   (0xC0000005)
CONSOLE: "Failed to create WebGPU Context Provider"
CONSOLE: "[engine] No GPU adapter available"
```

CrossOver does not implement DirectComposition, and the crash is an access
violation during GPU-process init — *before* anything WebGPU-specific runs.
`--use-webgpu-adapter=swiftshader` and `--disable-direct-composition` make no
difference for that reason.

**This is a CrossOver limitation, not a packaging bug**, and it means CrossOver
can validate packaging, paths, the scheme, IndexedDB and file dialogs but
**cannot validate rendering**. Real Windows hardware or a VM with GPU
passthrough is needed for that. When you try it there, a renderer with no
adapter looks like a hang rather than an error — the shell logs a missing
`navigator.gpu`, so check the console first.

The test bottle is at
`~/Library/Application Support/CrossOver/Bottles/NanoModulesTest` (725 MB).
Remove it with:

```bash
/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/cxbottle \
  --bottle NanoModulesTest --delete --force
```

---

## Not done yet

- **macOS is arm64 only.** `NanoBarrel.bundle` and `libbridge_server.dylib` are
  single-architecture, so an x64 DMG would ship an arm64 plugin Resolume cannot
  load — a broken package that looks fine until someone tries it. Add
  x64/universal to `electron-builder.yml` once the native side builds fat.
- **Signing is ad-hoc.** Good enough for you and for testers; everyone else
  gets a Gatekeeper prompt. Developer ID + notarization needs hardened runtime,
  which currently conflicts with the `nodeIntegration` the renderer uses for
  real filesystem paths.
- **No app icon** — electron-builder uses the default Electron one.
- **Art-Net input is gone in a packaged build.** Its bridge is a serve-only
  Vite plugin (`udp-bridge.ts`); the client guards on `import.meta.hot`, so it
  degrades silently. The shipping path was always the native `artnet_host.cpp`.
- **`FF_TYPE_FILE` persistence is a host capability.** Whether a host
  round-trips the sketch through its project file varies; in one that doesn't,
  the sketch lives only in the bridge document for that session.
