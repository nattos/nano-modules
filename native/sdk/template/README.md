# A Nano effect bundle — start here

This folder is a complete, buildable **effect bundle**: one `.wasm` file
holding one effect (`example.color.tint`). Copy it, rename things, and add your
own effects. The Nano apps (NanoModules, NanoModules Remote Control) and the
NanoBarrel Resolume plugin all load it from a **module folder**, and the apps
hot-reload it every time you rebuild.

## 1. Install the tools (once)

| Tool | What for | Where |
|---|---|---|
| **wasi-sdk** | compiles C++ to WebAssembly | [github.com/WebAssembly/wasi-sdk/releases](https://github.com/WebAssembly/wasi-sdk/releases) — unpack, then `export WASI_SDK_PATH=/path/to/wasi-sdk` |
| **dxc** | compiles HLSL shaders to SPIR-V | the Vulkan SDK, or [DirectXShaderCompiler releases](https://github.com/microsoft/DirectXShaderCompiler/releases) — must be on `PATH` |
| **python 3** | bakes compiled shaders into a header | usually already there |
| **bash** | runs `build.sh` | macOS/Linux: built in. Windows: Git Bash |

On macOS with Homebrew, `brew install llvm wasi-libc wasi-runtimes` works in
place of wasi-sdk (no `WASI_SDK_PATH` needed). `NANO_CLANG` points at a
specific wasm-capable `clang++` if you have several.

## 2. Fork and build

```bash
cp -R <nano-sdk>/template ~/my-effects
cd ~/my-effects
NANO_SDK=<nano-sdk> ./build.sh
# -> out/my_effects.wasm
```

`NANO_SDK` is the only link back to the SDK. Put it in your shell profile and
`./build.sh` is all you type.

**Name your bundle.** Set `MODULE_NAME` in `build.sh`. The file is
`<MODULE_NAME>.wasm` and its id `com.nano.<MODULE_NAME>`; a bundle with the same
name as another *replaces* it, so avoid `core`, `nano`, `lights`, `text`,
`richtext` and `legacy` unless replacing one is what you mean.

**Name your effects.** An effect's id (`example.color.tint`) is what saved
sketches store, forever. Use a prefix that is yours.

## 3. Load it

In either app: **Settings → Modules → Add folder…** and pick `out/`. Your
effects appear immediately. From then on, every `./build.sh` hot-reloads them
in the running app.

Or `./build.sh --install` copies the `.wasm` into the shared Modules folder
(`~/Library/Application Support/Nano Modules/Modules`, or
`%APPDATA%\Nano Modules\Modules`) — no live reload, but nothing to configure.

Resolume reads module folders when it loads the plugin: restart it after
adding a folder or installing a new bundle.

## 4. Add an effect

1. Copy `tint/` to `my_thing/`; rename the namespace, the id and the schema.
2. In `bundle.cpp`: `NANO_DECLARE_INSTANCE_EFFECT(my_thing)` and a
   `nano::registerEffect({...})` entry.
3. In `build.sh`: `compile_shaders_compute_spv my_thing`, and `my_thing/main.cpp`
   in the `wasm_build` list.

What else `build.sh` can call — several compute shaders in one effect,
vertex + fragment pairs, fusable per-pixel kernels — is documented at the top of
each function in `<nano-sdk>/scripts/wasm_build_env.sh`.
`<nano-sdk>/EFFECTS_STYLE_GUIDE.md` covers the schema conventions the editor
depends on (parameter ranges, modulation channels, primary ports, help text).

## Rules that bite

- **Shader registers are binding numbers.** `register(t0)`, `u1`, `b2` in HLSL
  must match the order of `gpu::Bindings()` *and* the slots `render()` binds.
  A mismatch is not an error — the effect renders black.
- **No `isnan()` / `isinf()` in shaders.** They compile, then silently break
  the pipeline on some backends. Use `x != x`, or `nano_sanitize.hlsl` from
  `shaders/common`. The build refuses to proceed if it finds them.
- **A `float3` in a constant buffer must be 16-byte aligned**, or the web
  backend rejects the shader and the effect does nothing.
- **Nothing per-instance goes in the schema.** A schema is published once per
  effect *type*; anything that varies per card is a parameter value.

## Compatibility

`bundle.cpp` stamps the ABI version from `<module_api.h>` into the bundle
(`NANO_EXPORT_ABI_VERSION()`). `<nano-sdk>/VERSION` says which ABI this SDK
speaks. Rebuild against a newer SDK when the apps move to a new ABI.
