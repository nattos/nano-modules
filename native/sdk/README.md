# The Nano effect SDK

What someone needs to build an effect bundle **outside this repo**, assembled
from the same files the repo's own bundles build with:

```bash
native/sdk/stage_sdk.sh            # -> build/sdk/
native/sdk/stage_sdk.sh --zip      # ...and build/sdk.zip, to hand out
```

(Run a bundle build first — `native/wasm_modules/build_all.sh` — the SDK ships
three helper shader headers that build generates.)

| In the SDK | From |
|---|---|
| `include/` | `native/wasm_modules/include/` + generated `blur_shaders.h`, `fast_blur_shaders.h`, `overlay_shaders.h` |
| `shaders/common/` | `native/wasm_modules/shaders_common/` |
| `scripts/` | `native/wasm_modules/wasm_build_env.sh` (relocatable — the SAME file the repo's bundles source) + `_emit_spv_header.py`, `_fragment_strip.py` |
| `template/` | `native/sdk/template/` — a one-effect bundle and the forking guide (its `README.md`) |
| `EFFECTS_STYLE_GUIDE.md`, `VERSION` | repo root; ABI from `module_api.h` |

Nothing is forked: the repo's bundles and the SDK share one build env, which
finds `include/`, the shader includes and its helper scripts relative to itself
in either layout, and effects under `NANO_EFFECTS_ROOT`. `core/build.sh` takes
its include path from that env (`$NANO_INCLUDE_DIR`), so a change that breaks
the SDK layout breaks a real bundle build too.

## What keeps it honest

- `stage_sdk.sh` **fails** when any SDK header or template source includes a
  project header the SDK doesn't carry (a `<sketch/...>` from `native/src`,
  say) — the one way an SDK that builds here fails everywhere else.
- ctest `sdk_template_builds` (`test_sdk_template.sh`) stages the SDK to a temp
  dir, copies the template to another, builds it with `NANO_SDK` as the only
  link back, then loads the bundle from a mapped module folder and renders it
  (`test_module_dirs "[.sdk_template]"`: red tint over grey keeps R, kills G/B).

## Not in it yet

The `native/src/sketch/` utilities some in-repo effects use (envelopes, delay
lines, tap modulation) — they would need to be made self-contained first. The
dedicated Effect Dev app, which would bundle the toolchain itself, is separate
work.
