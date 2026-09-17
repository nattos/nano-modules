# Nano Modules

A WASM-based visual effects module system with GPU compute rendering, sideband rail routing, and a web-based sketch editor. Modules compile to WebAssembly and run in both native (WAMR + Metal) and browser (WebGPU) environments.

## Architecture Overview

```
                    WASM Module (.wasm)
                    C++17, WASI libc++
     Imports: host, state, val, gpu, canvas, resolume
     Exports: init, tick, render, on_state_patched

        Native Host (C++/ObjC++)          Web App (TypeScript)
        WAMR runtime, Metal GPU           WebAssembly API, WebGPU
        FFGL plugin, Resolume WS          Web Worker engine
        Bridge server (dylib)             Lit + MobX sketch editor
```

### Key Concepts

- **Modules** are self-contained WASM plugins (effects, generators, mixers, controls)
- **Sketches** define processing chains of virtual module instances with texture and data routing
- **Rails** are named data channels for routing values and textures between modules within and across columns
- **Schema** declares a module's full state tree, I/O ports, and parameter metadata in one call
- **Val** is a handle-based JSON value container — zero-allocation on the WASM side
- **Bridge Core** is the shared protocol engine (state document, observers, JSON patches), compiled to WASM for the browser

## Prerequisites

Nothing under `build/` is committed, so **every checkout compiles the WASM
bundles before the web app will load**. That needs three things on any platform:

| Tool | Used for |
|------|----------|
| **A wasm-capable `clang++` + a WASI sysroot** | C++17 → `wasm32-wasip1` (effect bundles, `executor.wasm`, `bridge_core.wasm`) |
| **`dxc`** (DirectXShaderCompiler) | HLSL → SPIR-V, baked into `<effect>_shaders.h` |
| **Python 3** | bakes those SPIR-V blobs into the C++ headers |

Plus, for running the web app:

| Tool | Used for |
|------|----------|
| **Node.js 20+** | the Vite dev server and the test suites |
| **`naga` CLI** | the dev server's `/__naga/wgsl` endpoint — SPIR-V → WGSL at load time |
| **`bash`** | every build script (Git Bash is fine on Windows) |

`glslc`/`shaderc` and `spirv-tools` are **not** needed — the shader pipeline
moved to DXC-only SPIR-V output, and `naga` is only invoked by the dev server.

### macOS (Homebrew)

```bash
brew install llvm lld          # wasm-capable clang++ and wasm-ld
brew install wasi-libc         # the WASI sysroot (C)
brew install wasi-runtimes     # libc++ / libc++abi for wasm32-wasip1
brew install python3 cmake
```

`dxc` is not in Homebrew — install the [LunarG Vulkan SDK](https://vulkan.lunarg.com/sdk/home),
which puts `dxc` in `/usr/local/bin`. (Any DirectXShaderCompiler build on PATH works.)

### Windows

The **web testbed** builds and runs on Windows through WebGPU; the native
barrel/FFGL plugin is macOS-only. See **[WINDOWS.md](WINDOWS.md)** for the full
walkthrough.

### Rust (shader transpiler, all platforms)

```bash
rustup update stable
cargo install naga-cli    # SPIR-V → WGSL, spawned by the dev server
```

### Node.js

```bash
cd web && npm install
```

## Quick Start

```bash
# 1. Build every WASM bundle (effects, executor, bridge core).
#    On a web-only checkout: SKIP_AOT=1 skips the native-only AOT sidecars.
bash native/wasm_modules/build_all.sh

# 2. Fetch the bundled text-engine fonts (once per checkout).
#    SERVED_ONLY=1 skips the ~123MB of CJK faces only the native parity harness reads.
bash web/scripts/fetch_fonts.sh

# 3. Run the web app.
cd web && npm run dev            # then open http://localhost:5173/?playground

# Tests
cd web && npm test               # Vitest unit tests
cd web && npm run test:e2e       # Jest + Puppeteer (needs the dev server up)
```

Native (macOS only — the barrel, the C++ executor, Catch2 tests):

```bash
cmake -B native/build -S native
cmake --build native/build
ctest --test-dir native/build --output-on-failure
```

### Toolchain overrides

`native/wasm_modules/wasm_build_env.sh` defaults to the Homebrew layout but
takes these from the environment, so no host needs to edit it:

| Variable | Meaning |
|----------|---------|
| `WASI_SDK_PATH` | a [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases) root — supplies both `bin/clang++` and `share/wasi-sysroot` |
| `WASI_SYSROOT` | a combined sysroot, when clang comes from elsewhere |
| `WASI_LIBC` / `WASI_CXX` | the split sysroot pair (the Homebrew shape) |
| `NANO_CLANG` | an explicit wasm-capable `clang++` |
| `PYTHON` | an explicit Python 3 |
| `NANO_BASH` | bash for the dev server's auto-rebuild plugin (Windows) |

## Host API

WASM modules import from these host modules:

### `state` — Schema, State, Patches

| Function | Description |
|----------|-------------|
| `set_schema(id, ver, schema_json)` | Register module with full schema |
| `set(path, json)` | Publish state as JSON string |
| `set_val(path, val_handle)` | Publish state via val handle (no JSON serialization) |
| `read(layout, count, paths, output, size, results)` | Structured state reader (json-doc) |
| `get_key(buf, len)` | Get assigned plugin key |
| `get_patch(index)` | Get Nth patch as val handle (during `on_state_patched`) |
| `console_log(level, msg)` | Log message |

### `val` — Handle-Based Value Container

| Function | Description |
|----------|-------------|
| `null/bool/number/string/array/object()` | Construct values |
| `type_of/as_number/as_bool/as_string(h)` | Read values |
| `get/set(obj, key)` | Object access |
| `get_index/push/length(arr)` | Array access |
| `release(h)` | Free host-side data |
| `to_json(h, buf, len)` | Serialize to JSON string |

### `gpu` — D3D12-Style GPU Compute & Rendering

| Function | Description |
|----------|-------------|
| `get_backend()` | 0=Metal, 1=WebGPU, -1=none |
| `create_shader_module/buffer/texture/compute_pso/render_pso` | Resource creation |
| `begin_compute_pass` → `set_pso/set_buffer/set_texture/dispatch` → `end` | Compute encoding |
| `begin_render_pass` → `set_pso/set_vertex_buffer/draw` → `end` | Render encoding |
| `texture_for_field(path)` | Unified texture access by schema field name |
| `submit()` | Execute GPU commands |

### `host` — Timing & Audio

| Function | Description |
|----------|-------------|
| `get_time/delta_time/bar_phase/bpm()` | Frame timing |
| `get_param(index)` | Legacy parameter read |
| `get_viewport_w/h()` | Viewport dimensions |
| `trigger_audio(channel)` | Fire synth voice |

### `canvas` — 2D Drawing

| Function | Description |
|----------|-------------|
| `fill_rect(x,y,w,h,r,g,b,a)` | Filled rectangle |
| `draw_text(ptr,len,x,y,size,r,g,b,a)` | Bitmap text |

## Module Schema

Modules declare their identity, state fields, I/O, and parameters in a single `state::init()` call:

```cpp
#include <host.h>
#include <gpu.h>
#include <val.h>

void init() {
  state::init("com.nano.brightness_contrast", {1, 0, 0},
    state::Schema()
      .floatField("brightness", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .floatField("contrast", 0.5f, 0.f, 1.f, state::PrimaryInput)
      .textureField("tex_in", state::PrimaryInput)
      .textureField("tex_out", state::PrimaryOutput)
  );
}

void render(int w, int h) {
  auto input = gpu::Device::textureForField("tex_in");
  auto output = gpu::Device::textureForField("tex_out");
  // ... GPU compute pass
}
```

### Schema Field Types

| Type | C++ Method | I/O Flags |
|------|-----------|-----------|
| `float` | `.floatField(name, default, min, max, io)` | PrimaryInput, PrimaryOutput, etc. |
| `int` | `.intField(name, default, min, max, io)` | |
| `bool` | `.boolField(name, default, io)` | |
| `event` | `.eventField(name, io)` | |
| `texture` | `.textureField(name, io)` | |
| `string` | `.textField(name, default, io)` | |

### State Change Notifications

Modules receive state changes via `on_state_patched` with patch details:

```cpp
void on_state_patched(int patch_count,
    const char* paths_buf, const int* offsets,
    const int* lengths, const int* ops) {
  for (int i = 0; i < patch_count; i++) {
    if (ops[i] == state::PatchReplace) {
      auto patch = state::getPatch(i);      // val handle
      double v = val::asNumber(val::get(patch, "value"));
      val::release(patch);
      // ... react to change
    }
  }
}
```

## Sketches & Rails

Sketches define processing chains with sideband data routing:

```typescript
const sketch: Sketch = {
  anchor: 'com.nano.spinningtris@0',
  rails: [                              // Cross-cutting (sketch-scoped)
    { id: 'lfo_out', dataType: 'float' },
  ],
  columns: [{
    name: 'main',
    rails: [                            // Column-local
      { id: 'tex_a', dataType: 'texture' },
    ],
    chain: [
      { type: 'texture_input', id: 'in' },
      { type: 'module', module_type: 'com.nano.env_lfo', instance_key: 'lfo@0',
        params: { rate: 0.5 },
        taps: [{ railId: 'lfo_out', fieldPath: 'output', direction: 'write' }] },
      { type: 'module', module_type: 'com.nano.solid_color', instance_key: 'color@0',
        params: { red: 0.0 },
        taps: [{ railId: 'lfo_out', fieldPath: 'red', direction: 'read' }] },
      { type: 'texture_output', id: 'out' },
    ],
  }],
};
```

### Rail State Observation

Rail values are published to the state document for external observation:

```
/sketch_state/{sketchId}/columns/{colIdx}/{railId}/value   — column-local rails
/sketch_state/{sketchId}/rails/{railId}/value               — cross-cutting rails
```

## WASM Modules

| Module | Type | Description |
|--------|------|-------------|
| `brightness_contrast` | Effect | Brightness/contrast adjustment via compute shader |
| `spinningtris` | Generator | GPU compute + render demo with animated triangles |
| `gpu_test` | Generator | Solid color fill for GPU pipeline testing |
| `solid_color` | Generator | Fills render target with uniform RGB color |
| `env_lfo` | Data | Sine wave LFO, outputs float to state |
| `video_blend` | Mixer | Blends two texture inputs with opacity |
| `nanolooper` | Control | 4-channel 16-step looper sequencer |
| `paramlinker` | Control | Links Resolume parameters via learn mechanism |

## Shader Pipeline

```
HLSL (authored)  →  glslc  →  SPIR-V  →  naga  →  WGSL (WebGPU)
                                       →  naga  →  MSL  (Metal)
```

Modules are "fat" — embed both WGSL and MSL, select at runtime via `gpu::Device::backend()`.

## Web App

The sketch editor (`web/index.html`) runs all WASM/GPU execution in a Web Worker:

- **Create tab**: Browse composition plugins, stage instances, create sketches
- **Organize tab**: List and select sketches
- **Edit tab**: Multi-column chain editor with drag-drop, field editor widgets, live GPU preview
- **State management**: MobX + Immer with undo/redo via patches
- **Field widgets**: `<field-slider>`, `<field-toggle>`, `<field-trigger>` — standard editors bound via `FieldBinding`
- **Inspector system**: Modules can register custom column-width inspector views for effect cards

## Test Summary

| Suite | Framework | Tests | What's Tested |
|-------|-----------|-------|---------------|
| Native C++ | Catch2 | 141 | Bridge, WASM host, JSON patch, state, GPU |
| Val unit tests | Vitest | 32 | Handle-based value container |
| WASM module tests | Vitest | 29 | Module loading, state, rendering |
| GPU pipeline E2E | Puppeteer | 6 | HLSL → SPIR-V → WGSL → WebGPU → pixel |
| Brightness/contrast E2E | Puppeteer | 8 | Effect chain, solid color input, params |
| Engine E2E | Puppeteer | 8 | Multi-plugin, sketch chains, trace switching |
| Rail routing E2E | Puppeteer | 5 | Data rails, texture rails, cross-cutting |
| NanoLooper E2E | Puppeteer | 12 | Browser WASM, state patching, keyboard |
| **Total** | | **241** | |

## Key Design Decisions

- **C++17 with WASI libc++**: Modules compile with `--target=wasm32-wasip1`, `-fno-exceptions -fno-rtti`
- **Unified schema**: Single `state::init()` call declares identity, fields, types, I/O, min/max, defaults, ordering
- **Handle-based val**: Host owns all JSON data; WASM holds integer handles. Zero allocation in modules.
- **on_state_patched**: Replaces `on_param_change` and `on_state_changed`. Receives patch paths + ops inline; modules call `state::getPatch()` to fetch values via val handles.
- **HLSL shaders**: Authored in HLSL, compiled to SPIR-V, transpiled to WGSL + MSL. Fat modules embed both.
- **D3D12-style GPU API**: PSOs, explicit submit, unified texture access via `textureForField`.
- **Sideband rails**: Named data channels within columns (column-local) and across columns (sketch-scoped). Values published to `/sketch_state/` for observation.
- **Web Worker engine**: All WASM/GPU runs off the main thread. State updates via `postMessage`, GPU preview via `ImageBitmap` transfer.
- **Trace points**: Configurable texture capture points for live preview of any sketch output.
