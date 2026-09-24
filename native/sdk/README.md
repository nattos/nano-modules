# The Nano effect SDK

What someone needs to build an effect bundle **outside this repo**, assembled
from the same files the repo's own bundles build with:

```bash
native/sdk/stage_sdk.sh            # -> build/sdk/
native/sdk/stage_sdk.sh --zip      # ...and build/sdk.zip, to hand out
```

(Run a bundle build first — `native/wasm_modules/build_all.sh` — the SDK ships
two helper shader headers that build generates.)

| In the SDK | From |
|---|---|
| `include/` | `native/wasm_modules/include/` + generated `blur_shaders.h`, `fast_blur_shaders.h` |
| `include/sketch/`, `include/json/` | the self-contained `native/src` utilities effects share with the host: `envelope.h`, `knob_rate.h`, `fft_bass_sim.h`, `json_doc_client.h` (`SHARED_SRC_HEADERS` in `stage_sdk.sh`) |
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

Most of `native/src/sketch/` — the utilities are shipped one at a time, as an
out-of-repo bundle needs them, and only once they're self-contained (the
closure check enforces that). The dedicated Effect Dev app, which would bundle
the toolchain itself, is separate work.

## Who builds against it

[nano-modules-extras](https://github.com/nattos/nano-modules-extras) — the
`nano`, `lights` and `legacy` bundles — builds ONLY through a staged SDK
(`native/wasm_modules/build_extras.sh`), so anything they need and the SDK
lacks fails that build rather than quietly reaching into this repo.
