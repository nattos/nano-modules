# nano-repatch Module System

This document describes the WASM module system, the host APIs, the shader pipeline, and how to build and test everything.

## Prerequisites

### macOS Dependencies (Homebrew)

```bash
brew install llvm        # WASM-capable clang++ (--target=wasm32-wasip1)
brew install lld          # wasm-ld linker
brew install shaderc      # glslc (HLSL/GLSL → SPIR-V compiler)
brew install spirv-tools  # spirv-val, spirv-dis (validation/disassembly)
```

### Rust (for naga shader transpiler)

```bash
rustup update stable
cargo install naga-cli    # SPIR-V → WGSL/MSL transpiler
```

### WASI SDK (for C++ standard library in WASM)

The build system expects a WASI sysroot with libc++ at the path detected by `wasm_build_env.sh` (typically under Homebrew's LLVM installation or a standalone WASI SDK). The sysroot provides `<cmath>`, `<cstring>`, and other C++17 headers for `wasm32-wasip1`.

### Metal Toolchain (for native GPU backend)

```bash
xcodebuild -downloadComponent MetalToolchain
```

### Node.js (for web test harness)

```bash
cd web-harness && npm install
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    WASM Module (.wasm)                    │
│  C++17 with WASI libc++, --target=wasm32-wasip1          │
│  Imports: canvas, host, resolume, state, gpu, wasi       │
│  Exports: init, tick, render, on_param_change,           │
│           on_state_changed                                │
└─────────────┬───────────────────────────┬───────────────┘
              │                           │
    ┌─────────▼─────────┐     ┌──────────▼──────────┐
    │   Native Host     │     │   Web Test Harness   │
    │   (C++/ObjC++)    │     │   (TypeScript)       │
    │                   │     │                       │
    │ • WAMR runtime    │     │ • WebAssembly API     │
    │ • WASI support    │     │ • WebGPU backend      │
    │ • Metal GPU       │     │ • WASI shim           │
    │ • FFGL plugin     │     │ • Lit + MobX editors  │
    │ • Resolume WS     │     │ • Fake Resolume       │
    │ • WS server       │     │ • Puppeteer E2E       │
    └───────────────────┘     └───────────────────────┘
```

## Host API Modules

WASM modules import functions from these host modules:

### `canvas` — 2D Drawing (immediate mode)
| Function | Description |
|----------|-------------|
| `fill_rect(x,y,w,h,r,g,b,a)` | Filled rectangle |
| `draw_image(tex,x,y,w,h)` | Textured quad |
| `draw_text(ptr,len,x,y,size,r,g,b,a)` | Bitmap text |

### `host` — Timing and Parameters
| Function | Description |
|----------|-------------|
| `get_time() → f64` | Elapsed seconds |
| `get_delta_time() → f64` | Frame delta |
| `get_bar_phase() → f64` | FFGL bar phase [0,1) |
| `get_bpm() → f64` | Host BPM |
| `get_param(index) → f64` | FFGL parameter value |
| `get_viewport_w/h() → i32` | Viewport dimensions |
| `trigger_audio(channel)` | Fire synth voice |
| `log(ptr, len)` | Debug log |

### `resolume` — Composition Queries
| Function | Description |
|----------|-------------|
| `get_param(id:i64) → f64` | Read cached parameter |
| `set_param(id:i64, value:f64)` | Write parameter |
| `subscribe_query(ptr, len)` | Subscribe with path pattern (supports `*`) |
| `get_param_path(id:i64, buf, len) → i32` | Get param path string |
| `get_clip_count/id/channel/name/connected` | Composition queries |
| `trigger_clip(id:i64, on)` | Trigger clip on/off |

### `state` — Plugin State & Logging
| Function | Description |
|----------|-------------|
| `set_metadata(id_ptr, id_len, version)` | Register plugin |
| `declare_param(index, name, name_len, type, default)` | Declare FFGL parameter |
| `get_key(buf, len) → i32` | Get assigned plugin key |
| `console_log(level, ptr, len)` | Log message |
| `console_log_structured(level, msg_ptr, msg_len, json_ptr, json_len)` | Log with structured data |
| `set(path_ptr, path_len, json_ptr, json_len)` | Publish state |
| `read(layout, count, paths, output, size, results) → i32` | Read state (json-doc) |

### `gpu` — GPU Compute & Rendering (D3D12-style)
| Function | Description |
|----------|-------------|
| `get_backend() → i32` | 0=Metal, 1=WebGPU, -1=none |
| `create_shader_module(src, len) → i32` | Compile shader source |
| `create_buffer(size, usage) → i32` | Create GPU buffer |
| `create_texture(w, h, format) → i32` | Create texture |
| `create_compute_pso(shader, entry, len) → i32` | Compute Pipeline State Object |
| `create_render_pso(vs, vs_entry, vs_len, fs, fs_entry, fs_len, fmt) → i32` | Render PSO |
| `write_buffer(buf, offset, data_ptr, data_len)` | Upload data |
| `begin_compute_pass() → i32` | Begin compute encoding |
| `compute_set_pso/set_buffer/dispatch/end` | Compute commands |
| `begin_render_pass(tex, cr, cg, cb, ca) → i32` | Begin render encoding |
| `render_set_pso/set_vertex_buffer/draw/end` | Render commands |
| `submit()` | Submit command buffer |
| `get_render_target() → i32` | Current output texture |
| `release(handle)` | Free resource |

## Shader Pipeline

Shaders are authored in **HLSL** and compiled through a multi-stage pipeline:

```
HLSL (authored)
  │
  ├── glslc ──→ SPIR-V (canonical intermediate, required)
  │
  ├── naga ───→ WGSL (for WebGPU, embedded in WASM module)
  │
  └── naga ───→ MSL (for native Metal, embedded in WASM module)
```

Modules are "fat" — they embed both WGSL and MSL and select at runtime via `gpu.get_backend()`.

## Shared Build Environment

All WASM modules source `native/wasm_modules/wasm_build_env.sh`, which provides:

- **Compiler**: Homebrew LLVM `clang++` with `--target=wasm32-wasip1`
- **C++ standard**: C++17 (`-std=c++17 -fno-exceptions -fno-rtti`)
- **Sysroot**: WASI libc + libc++ + libc++abi
- **Common exports**: `init`, `tick`, `render`, `on_param_change`, `on_state_changed`
- **Helper function**: `wasm_build()` compiles sources and links into `.wasm`

## C++ Wrapper Headers

Shared headers in `native/wasm_modules/include/` provide type-safe wrappers over the raw C host imports:

### `gpu.h` — D3D12-style GPU API
- Typed handles: `ShaderModule`, `Buffer`, `Texture`, `ComputePSO`, `RenderPSO`
- Command encoders: `ComputePass`, `RenderPass` with method chaining
- `Device` factory with static methods for resource creation and submit
- `Buffer::write<T>(data, count)` for arrays, `Buffer::writeOne<T>(value)` for single values

### `host.h` — Host, Canvas, State, Resolume APIs
- `namespace host` — timing, parameters, viewport, audio triggers
- `namespace canvas` — 2D drawing (fillRect, drawImage, drawText)
- `namespace state` — metadata, parameter declaration, logging, state read/write
- `namespace resolume` — composition queries, parameter control, clip triggers

## WASM Modules

### NanoLooper (`com.nattos.nanolooper`)
4-channel, 16-step looper sequencer with visual overlay.
- **Parameters**: 12 (Trigger 1-4, Delete, Mute, Undo, Redo, Record, Show Overlay, Synth, Synth Gain)
- **Rendering**: Canvas 2D (bitmap font text, colored quads)
- **State**: Publishes grid, phase, recording status. Accepts external grid edits via `on_state_changed`.
- **Size**: ~15KB

### ParamLinker (`com.nattos.paramlinker`)
Links two Resolume parameters together via a "learn" mechanism.
- **Parameters**: Learn (toggle), Active (toggle)
- **Learn mode**: Subscribes to `/*`, tracks parameter changes, ignores automation after 1s settle
- **State**: Publishes seen params list, input/output assignment
- **Editor**: Interactive Lit+MobX web component with click-to-assign
- **Size**: ~10KB

### SpinningTris (`com.nattos.spinningtris`)
GPU compute + render demo. N spinning triangles with random colors.
- **Parameters**: Triangles (1-1000), Speed
- **Shaders**: HLSL compute (vertex generation) + vertex/fragment (rasterization)
- **Pipeline**: Compute dispatch → render pass → submit
- **Size**: ~7KB

### GPU Test (`com.nattos.gpu_test`)
Minimal test module for GPU pipeline validation.
- Fills screen with known color (R=0, G=0.5, B=1.0) via compute + render
- Used by both native (Metal) and web (WebGPU) E2E tests
- **Size**: ~9KB (fat module with WGSL + MSL)

## Build Commands

### Native (C++ / macOS)

```bash
# Configure CMake
cmake -B native/build -S native -DCMAKE_BUILD_TYPE=Debug

# Build all native targets
cmake --build native/build

# Run all native tests (143 tests)
cd native/build && ctest --output-on-failure
```

### WASM Modules

Each module has its own `build.sh`:

```bash
# NanoLooper
native/wasm_modules/nanolooper/build.sh

# ParamLinker
native/wasm_modules/paramlinker/build.sh

# SpinningTris (includes HLSL → SPIR-V → WGSL/MSL shader pipeline)
native/wasm_modules/spinningtris/build.sh

# GPU Test (fat module with WGSL + MSL)
native/wasm_modules/gpu_test/build.sh

# Copy to web harness
cp native/build/*.wasm web-harness/public/
```

### Web Test Harness

```bash
cd web-harness

# Install dependencies
npm install

# Dev server (http://localhost:5174)
npm run dev

# Unit tests (24 tests, vitest)
npm test

# E2E tests (18 tests, puppeteer — requires dev server running)
npm run dev &
npm run test:e2e
```

### Full Pipeline

```bash
# Build everything from scratch
native/wasm_modules/nanolooper/build.sh
native/wasm_modules/paramlinker/build.sh
native/wasm_modules/spinningtris/build.sh
native/wasm_modules/gpu_test/build.sh
cp native/build/*.wasm web-harness/public/
cmake -B native/build -S native -DCMAKE_BUILD_TYPE=Debug
cmake --build native/build
cd native/build && ctest --output-on-failure
cd ../../web-harness && npm test
```

## Test Summary

| Suite | Framework | Tests | What's Tested |
|-------|-----------|-------|---------------|
| ParamCache | Catch2 | 7 | Thread-safe parameter cache |
| Resolume Protocol | Catch2 | 9 | WebSocket message serialization |
| Bridge API | Catch2 | 7 | C API singleton lifecycle |
| Bridge Loader | Catch2 | 5 | dlopen/dlsym function pointer resolution |
| WASM Host | Catch2 | 12 | Module loading, host function calls |
| Canvas Host | Catch2 | 3 | WASM → DrawList via canvas.* |
| Composition Cache | Catch2 | 7 | Resolume state parsing |
| JSON Patch | Catch2 | 30 | RFC 6902 apply/diff/serialize |
| json-doc | Catch2 | 14 | Fixed-buffer state reader |
| Observer Registry | Catch2 | 11 | Path-based subscriptions |
| State Document | Catch2 | 17 | Plugin state tree + patches |
| DrawList | Catch2 | 6 | Command buffer |
| NanoLooper WASM | Catch2 | 5 | Full WASM module lifecycle |
| State Integration | Catch2 | 4 | WebSocket state round-trip |
| Metal GPU | Catch2 | 2 | Metal compute + render + pixel readback |
| WS Server | Catch2 | 5 | WebSocket server (integration) |
| **Native Total** | | **143** | |
| Font/Resolume/Host | Vitest | 24 | Font atlas, fake Resolume, WASM loading |
| Harness E2E | Puppeteer | 12 | Browser WASM, state patching, keyboard |
| GPU Pipeline E2E | Puppeteer | 6 | HLSL→SPIR-V→WGSL→WebGPU→pixel assertions |
| **Web Total** | | **42** | |
| **Grand Total** | | **185** | |

## Native Build Artifacts

| Artifact | Description |
|----------|-------------|
| `libbridge_server.dylib` | Singleton bridge with all subsystems |
| `NanoRepatch.bundle` | Generic FFGL plugin (loads bridge dylib) |
| `NanoLooper.bundle` | Looper FFGL plugin with synth + canvas renderer |
| `looper_harness` | macOS GUI harness for NanoLooper |
| `bridge_harness` | CLI harness for bridge testing |

## Web Harness URL Parameters

```
http://localhost:5174/?module=nanolooper    # Default
http://localhost:5174/?module=paramlinker
http://localhost:5174/?module=spinningtris
```

## Key Design Decisions

- **C++17 with WASI libc++**: Modules compile with `--target=wasm32-wasip1` using WASI sysroot for full C++ STL support (`<cmath>`, `<cstring>`, etc.) with `-fno-exceptions -fno-rtti` to minimize binary size. Modules target eventual direct bytecode generation from nano-repatch's IR.
- **HLSL as shader authoring language**: Better compute support, cleaner syntax, forward-compatible with Slang. Agents produce better HLSL than WGSL.
- **SPIR-V as canonical shader IR**: Required format. WGSL and MSL generated at build time via naga.
- **Fat modules**: Ship both WGSL + MSL, select at runtime via `gpu.get_backend()`.
- **D3D12-style GPU API**: Pipeline State Objects, render targets, explicit submit. Maps cleanly to both Metal and WebGPU.
- **JSON Patch (RFC 6902)**: State changes streamed to editors via standard protocol.
- **json-doc**: Fixed-buffer state reader for WASM — no dynamic allocation needed.
- **`id@N` plugin keys**: `com.nattos.nanolooper@0`, `com.nattos.nanolooper@1` for multi-instance.
- **WASI shim for browser**: Minimal stubs (`wasi-shim.ts`) implement `wasi_snapshot_preview1` syscalls (args, fd, environ, clock) so WASI-compiled modules run in the browser. Native side uses WAMR's built-in WASI support.
- **GPU E2E pixel assertions**: `Frame` class reads back full pixel buffers and provides `expectPixelAt`, `expectUniformColor`, `expectCoverage`, `expectDifferentFrom`, etc. Automatic PNG dumps to `/tmp/gpu-test-dumps/`.
