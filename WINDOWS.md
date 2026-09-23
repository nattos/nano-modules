# Running the web testbed on Windows

The **web app is the whole editor** — the linear effects list, the arrangement
timeline, the sidecar canvas — and it runs the same `executor.wasm` and the same
effect bundles as the native barrel, on WebGPU instead of Metal. That part is
portable.

The Resolume barrel used to be the part that was not. It is now: the engine has
a D3D11 backend and `NanoBarrel.dll` is a plain DLL exporting `plugMain`, proven
on real hardware (an Intel UHD 630, 2026-09-19). It is **cross-compiled from
macOS**, though — this page is about what a Windows machine itself can do, and
configuring the native tree there is still not one of those things.

Everything below runs in **Git Bash**, not PowerShell or `cmd`. Every build
script in this repo is bash.

---

## What works, what doesn't

| | Windows |
|---|---|
| Web editor + WebGPU rendering (`?playground`) | ✅ |
| WASM effect bundles + `executor.wasm` (built from source) | ✅ |
| Vitest unit tests | ✅ |
| Jest + Puppeteer E2E (incl. the GPU suites) | ✅ |
| Arrangement, sidecar canvas, wires, MIDI via Web MIDI | ✅ |
| Native barrel / FFGL plugin / Resolume integration | ✅ `NanoBarrel.dll` on D3D11 — **cross-built from macOS**, not built here |
| `cmake -B native/build` **on Windows** | ❌ the project declares `OBJCXX`; cross-compile with `native/cmake/toolchain-win-zig.cmake` from a Mac instead |
| Catch2 native tests | ✅ cross-built and run under CrossOver; see `native/tools/nano_diag/` for the real-hardware runner |
| `wamrc` AOT sidecars | ❌ `NANO_WASM_AOT=OFF` — a sidecar is per-ABI as well as per-arch, so the Windows barrel loads the portable `.wasm` |
| Electron shell + packaged app (`npm run package:{remote,arrangement}:win`) | ✅ builds; see DESKTOP.md |
| GPU-shared Live previews (`NBPS`) | ❌ not yet — D3D11 `createSharedSurface` (named NT handles) and the addon's Windows side are unwritten; previews use the socket lanes |

> The Windows **installer** cross-builds from macOS (there are no native node
> modules). Run under CrossOver it gets a long way: the resource root resolves,
> the install record lands in `%APPDATA%\NanoBarrel\`, the `nano://` scheme
> serves the app and the renderer runs. **WebGPU does not work there** — the GPU
> process crashes during init (`DCompositionCreateDevice3 ... Not implemented`),
> which is a CrossOver limitation and not something a flag works around. So
> CrossOver validates packaging and paths but not rendering; that needs real
> hardware. Details in [DESKTOP.md](DESKTOP.md).

> **Not verified on real hardware.** The portability work below was done and
> tested on macOS: the build scripts were made host-agnostic and every macOS
> path re-verified (all bundles rebuild, 1441 unit tests and the GPU E2E suite
> pass). Nobody has yet run it end to end on a Windows box — expect the first
> run to surface something, and see *Known unknowns* at the bottom.

---

## 1. Git — get the line endings right first

Git for Windows defaults to `core.autocrlf=true`. A `build.sh` checked out with
CRLF dies in bash with `$'\r': command not found` before running a single
command. The repo now ships a `.gitattributes` pinning `*.sh` and `*.py` to LF,
which handles this — but if you cloned before that landed, renormalize
(commit or stash your work first, this rewrites the working tree):

```bash
git config core.autocrlf input
git add --renormalize .
git checkout -- .
```

Symlinks are not a problem: the two symlinks in `web/public/` (`wasm`,
`test-videos`) are untracked local setup, and the dev server no longer needs
them.

## 2. The WASM toolchain — wasi-sdk

Download a **wasi-sdk** release for Windows:
<https://github.com/WebAssembly/wasi-sdk/releases> (e.g.
`wasi-sdk-25.0-x86_64-windows.tar.gz`). Unpack it anywhere, then point the build
at it — this one variable replaces the whole Homebrew layout the scripts default
to:

```bash
export WASI_SDK_PATH=/c/tools/wasi-sdk-25.0-x86_64-windows
```

Put that in `~/.bashrc` so it survives new shells. It gives the build both
`bin/clang++.exe` and `share/wasi-sysroot` (which carries wasi-libc *and*
libc++ for `wasm32-wasip1`).

Check it:

```bash
"$WASI_SDK_PATH/bin/clang++" --print-targets | grep -i wasm
```

## 3. `dxc` — HLSL → SPIR-V

Either works; both put `dxc.exe` on PATH:

- **LunarG Vulkan SDK** — <https://vulkan.lunarg.com/sdk/home> (simplest; also
  what the macOS setup uses).
- **DirectXShaderCompiler release zip** —
  <https://github.com/microsoft/DirectXShaderCompiler/releases>. Use the
  `bin/x64/` copy and keep `dxcompiler.dll` + `dxil.dll` beside `dxc.exe`, or it
  fails at load.

The Windows SDK's own `dxc.exe` also works, but it is often an older build and
is easy to shadow accidentally — prefer one of the above.

```bash
dxc --version        # must print, from Git Bash
```

## 4. Python 3, Node, Rust

```bash
python --version     # 3.x — python.org installer ships `python`, not `python3`
node --version       # 20+
```

The build probes `python3` then `python`, so either name is fine. Override with
`PYTHON=/path/to/python` if you have several.

Then the shader transpiler the dev server spawns:

```bash
rustup update stable
cargo install naga-cli
naga --version
```

## 5. Build

```bash
# Bundles. SKIP_AOT=1 because wamrc/AOT sidecars are a native-only optimization.
SKIP_AOT=1 bash native/wasm_modules/build_all.sh
```

This clones `nlohmann/json` into `native/build/_deps/` on first run (the native
CMake normally fetches it, and CMake can't configure here), plus FreeType /
msdfgen / libunibreak into `native/third_party/` for the text engine. Output
lands in `build/wasm/`.

`richtext.wasm` additionally wants `build/wasm/text_blitz.wasm`, built from
Rust:

```bash
rustup target add wasm32-wasip1
bash native/text_blitz/build_wasm.sh
```

Without it the rich-text effect degrades; everything else is unaffected.

Then the bundled fonts (once per checkout). `SERVED_ONLY=1` skips the ~123 MB
of CJK faces, which only the native (macOS) text-parity harness reads:

```bash
SERVED_ONLY=1 bash web/scripts/fetch_fonts.sh
```

## 6. Run

```bash
cd web
npm install
npm run dev
```

Open **<http://localhost:5173/?playground>**. The `?playground` is not optional
on a fresh profile: the app picks its surface at boot from a persisted
`appMode`, which defaults to the effect IDE.

If you launch `npm run dev` from PowerShell rather than Git Bash, the dev
server's auto-rebuild plugin can't find `bash`. It probes the standard Git for
Windows install paths, but set `NANO_BASH` if yours is elsewhere:

```
set NANO_BASH=C:\Program Files\Git\bin\bash.exe
```

## 7. Tests

```bash
cd web
npm test                                      # Vitest
npm run test:e2e                              # Jest + Puppeteer, needs the dev server
GPU_TEST_BASE_URL=http://localhost:5173 npx jest gpu-pipeline
```

Headless Chrome needs WebGPU forced on. The Jest config passes
`--enable-unsafe-webgpu` everywhere and adds `--enable-features=Vulkan` only off
Windows — on Windows the default D3D12 backend already provides an adapter, and
forcing Vulkan can leave `navigator.gpu` with none.

Note that several E2E suites fail on a clean tree for unrelated reasons
(harness/engine-worker issues) — baseline before reading a failure as a Windows
problem.

---

## What made this portable

For the record, the Windows-specific things that were actually in the way:

- `wasm_build_env.sh` hardcoded `/opt/homebrew/opt/wasi-{libc,runtimes}` and a
  brew `clang++`. Now `WASI_SDK_PATH` / `WASI_SYSROOT` / `WASI_LIBC` /
  `WASI_CXX` / `NANO_CLANG` all override, with the Homebrew paths as defaults.
  Also accepts either libc++ sysroot layout (triple-scoped or not) and retries
  a `.exe` suffix when probing for executables.
- `python3` is not a name the python.org installer creates. The build now
  probes `python3` then `python`.
- The bundles needed `nlohmann/json` pre-fetched by a CMake configure that
  cannot run off macOS. They fetch it themselves now.
- `web/public/wasm` was a symlink to `build/wasm` that the dev server relied on
  to serve the bundles. The `wasm-hmr` plugin now serves and watches
  `build/wasm` directly, so nothing has to be linked.
- The two unit tests that read bundles off disk went to `build/wasm` for the
  same reason.
- `sed -i ''` (BSD-only) in the legacy non-SPV shader helpers → a temp-file
  rewrite.
- `build_all.sh` shouted a wall of `!!!` about stale AOT sidecars when `wamrc`
  was missing — which is simply the normal state of a web-only checkout, where
  no sidecars exist at all. It now only warns when there really are stale ones.

## Known unknowns

Things that should work but nobody has confirmed on Windows:

- **WebGPU feature parity.** The effects lean on storage textures with pinned
  formats (`rgba16float`, `r32float`), read-write storage textures, atomics and
  indirect dispatch. All are core WebGPU, but Dawn's D3D12 backend is a
  different implementation from the Metal one every effect was developed
  against. Shader-level surprises would show up as a black effect plus a
  validation error in the console (`DEBUG_E2E=1` surfaces them in E2E runs).
- **Vulkan vs D3D12.** If an effect misbehaves, `--use-angle=...` /
  `chrome://flags` → *Choose ANGLE graphics backend* is the first thing to try.
- **The text engine.** CJK fallback resolves OS fonts through the Local Font
  Access API, so the faces differ from macOS by design — parity with the native
  host is not expected there.
- **Video.** DXV decode is pure WASM + a BC1 texture path, so it should be
  fine, but `web/public/test-videos` is a personal symlink on the macOS box;
  point it at your own directory.
