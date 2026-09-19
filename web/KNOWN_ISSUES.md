# Known Issues & Future Work

## Known Issues

### Real module instance shared across multiple sketches
A real module instance (`realModules`) that appears in more than one sketch chain will only be ticked/rendered once per frame — by whichever sketch processes it first. Subsequent sketches referencing the same instance will see stale output (the previous frame's render, or the wrong params if both sketches set different param values).

**Impact**: Incorrect rendering when the same plugin is used in multiple compositions simultaneously.

**Resolume behavior**: Resolume handles this by cloning the instance per-composition. We'll need to do the same — either by creating separate WASM instances per sketch, or by re-rendering the module with each sketch's params.

### Barrel sketch sync full-syncs on every edit (latent edit loss)
In barrel mode the editor reacts to its **own** echoed edit by refetching the whole sketch and wholesale-replacing local state (`boot-resolume.ts:1015` sets `sketchTouched`, `:1038` does `barrel.get(sketchPath)` → `setBarrelSketch`, `controller.ts:2547`). The replace overwrites the local sketch with a snapshot that may predate an in-flight edit — and it reseeds `lastPushedBarrelJson` (`controller.ts:2552`), so the lost edit is never re-pushed. Silent, no conflict, no warning.

Compounding it, `postRecordHook` stamps `sketch.lastModified` on every committed mutation and `slimSketchForBarrel` (`controller.ts:1631`) doesn't strip it, so a mutation that changes *nothing* still defeats the push dedup and pushes.

**How it bit us**: `control.barrel_macros`' schema is one help field + 16 pure outputs (nothing authorable), and `defaultStateForPlugin`'s legacy `params` fallback re-added the help field the schema loop had skipped — so every mirror-in seeded `intro` and then pruned it. Two no-op mutations per snapshot, each restamping `lastModified` → push → echo → refetch → replace → repeat. Measured **with the editor idle**: ~140 pushes/sec, ~70 whole-sketch replaces/sec. Edits "stuck" only by chance.

**Status**: the *trigger* is fixed (the seeder is idempotent now; regression test in `src/state/output-field-seeding.test.ts`). The *loop* is not — any future non-idempotent mutation, or a genuinely concurrent remote write, re-arms it. Full plan: **[BARREL_SYNC_PLAN.md](BARREL_SYNC_PLAN.md)**.

### Empty columns left behind after drag-drop
When a module is dragged out of a column, the empty column (just `texture_input` → `texture_output`) is not automatically removed. This is cosmetic — the executor correctly skips empty columns for output — but it clutters the UI.

### Persistent GPU storage buffers don't carry state across frames on Metal (2026-07-26)

An effect that keeps its simulation in a **storage buffer** and advances it in place each frame (read `buf[i]` → integrate → write `buf[i]`) does not integrate on the native Metal path. The same effect's persistent **textures** — ping-pong render targets read one frame and written the next — integrate correctly and match WebGPU exactly. Both live in the same `render()`, so this is a buffer-vs-texture split, not "native sim state is broken".

**Where it shows.** Three pinned dual-backend gaps: `double-chamber-interactions` (density buffer reads back all zeros), legacy `double_chamber`'s `boundary_death` case, and `d-wave`'s dampening. Each is skipped or thresholded per-backend at its call site with a pointer here. `source.legacy.double_chamber` and `warp.legacy.d_wave` are the only two effects with `BufferUsage::Storage` sim state in these suites, and both are affected.

The other two pinned gaps, `pixel_descent` and `pixel_ocean`, are **not** this — both allocate only a uniform buffer. Theirs is a step-clock divergence (the row/step progression lands elsewhere on Metal despite both runners stepping host time, dt and barPhase identically) and is separately undiagnosed.

**The cleanest measurement** is `warp.legacy.d_wave`, because one effect contains both mechanisms — a stateful wave field in ping-pong textures, and a pool of dampening-flash particles in a `RWStructuredBuffer` that the vertex shader then splats as instanced quads. Mean red of the debug field overlay, 128×128, `renderEachTick`:

| | ticks=1 | ticks=4 | ticks=14 | ticks=40 |
|---|---|---|---|---|
| wave field alone (`damp=0`), **both backends** | 17.84 | 54.82 | 114.01 | 232.09 |

Identical to 2 dp at every tick count — the texture-based field is fine. Now the same runs with the flash layer on, as a ratio of the above:

| `damp_count` | 100 | 400 | 1500 | 4096 |
|---|---|---|---|---|
| WebGPU | 0.949 | 0.826 | 0.618 | 0.477 |
| Metal | 0.958 | 0.922 | 0.912 | 0.915 |

WebGPU scales monotonically with particle count. Metal **plateaus at ~256 particles** (a finer sweep: 64 → 0.972, 128 → 0.950, 256 → 0.920, then flat and slightly non-monotonic out to 2000) — past that, more particles change nothing. And natively `damp_rate`, the particles' outward drift speed, has **no observable effect at all**: rate 0.0 and rate 1.0 give the same numbers, so the flashes are not moving.

**Ruled out** (don't redo this):
- Metal's additive blend descriptor is correct (`createInstancedRenderPSO`, `blendMode == 1` → `sourceAlpha`/`one`).
- Instance count passes straight through to `drawPrimitives:instanceCount:` — no cap.
- The `// nano_threadgroup:` hint is present for this shader; the 8×8 fallback warning does not fire, so `[numthreads(64,1,1)]` is honoured.
- `writeBuffer`'s version-on-write-after-bind copies old contents into the new backing buffer, and only fires for CPU writes — the particle buffer is GPU-written only.

**D3D11 settles where the fault is (2026-09-20).** Running the same sweep on the
native D3D11 backend under CrossOver — `./build-win/test_effect_render "probe:
d_wave*"`, the hidden instrument now living at the bottom of
`native/tests/test_effect_render.cpp` — gives, at 40 ticks, ratios of the
field-alone baseline:

| `damp_count` | 64 | 128 | 256 | 400 | 1500 | 4096 |
|---|---|---|---|---|---|---|
| D3D11 | 0.983 | 0.913 | 0.896 | 0.750 | **0.434** | **0.216** |
| Metal | 1.034 | 0.940 | 1.000 | 0.914 | 0.950 | 0.963 |

D3D11 falls monotonically, exactly as WebGPU does. Metal is flat — and flat past
64, not just past 256. Two independent backends running the SAME SPIR-V through
the SAME effect behave correctly, so this is not the effect, not the shader, and
not the abstraction: **it is metal_backend.mm.** Anyone picking this up should
start there rather than in `d_wave/`.

That also puts the write-after-bind versioning hack (`metal_backend.mm`'s
`writeBuffer`, which swaps in a fresh backing buffer and memcpys when a CPU
write lands on a buffer that already has dispatched readers) back under
suspicion despite being on the ruled-out list above: it is precisely the thing
D3D11 does NOT have — queued `UpdateSubresource` gives the same ordering
semantics for free, which `test_effect_render`'s "write-after-bind versions the
buffer inside a submit batch" now confirms on both backends — and it is the only
place in either backend where a buffer's backing allocation can change between
frames.

**Leading hypothesis**, unproven: the GPU-written contents of a storage buffer aren't what the next frame's dispatch reads — either the pool is being re-seeded every frame (the shader's `seed != 0` branch returns before integrating, which would explain rate-independence exactly), or the backing allocation the encoded compute pass wrote isn't the one the following frame binds. The ~256 plateau suggests only a small prefix of the pool ever holds valid positions, with the rest stacked at a degenerate spot. Start by dumping the particle buffer after two frames and comparing it against the seed-only contents.

**When fixed**, flip these back: `double-chamber-interactions.test.ts` and legacy `double_chamber`'s multi-frame describe to the default backend list, and `d-wave.test.ts`'s dampening case to a single shared threshold.

### E2E: four known-failing suites (as of 2026-07)
Surfaced while getting the full Puppeteer e2e suite green (run against this workspace's dev server: `GPU_TEST_BASE_URL=http://localhost:5174 npx jest <name>`). The bulk of the earlier failures were a stale harness readiness-check and tests that hadn't caught up to the LFO going signed — both fixed. These four are genuine, independent, and still open:

- **`engine-wires.test.ts` — "delayed/backward texture wire = self-feedback accumulator"**: the accumulator plateaus at `102` where the test asserts it's still climbing (`> 102`). The other feedback assertions pass; this is a marginal saturation near the `≤ 110` src ceiling. Likely a real solver/timing edge (not the harness bug). Needs a look at whether the effect should keep climbing or the assertion's bound is too tight.

- **`video-stall-benchmark.test.ts` — "plays a multi-codec, multi-play-mode arrangement and records stalls"**: runs fine now (uses the committed `/media/` + `/test-videos/bench/` fixtures) but fails `expect(errors).toEqual([])` — ~594 `pageerror`/console-error entries collected during the multi-codec playback (collector at test lines ~68-76). Triage what those errors are (real decode/provider errors vs. benign warnings) before deciding whether to fix the provider or scope the assertion.

- **`arr-engine-testbed-smoke.test.ts` — "renders a real clip sketch (gpu_test → blue) into the monitor"**: times out waiting for `window.__arrEngine.frames > 4` (25s) — the arrangement engine testbed (`arr-engine-testbed.html`) never advances past a few frames. Arrangement-specific; distinct from the engine-test-runner path.

- **`arrangement-workspace.test.ts` — "refreshes the panel reactively on mount, and renames + deletes files"**: 5s timeout on a panel-reactivity assertion. Likely a MobX/Lit reactivity or file-store-refresh issue on mount.

Fixed in the same pass (for context): the engine/gpu test-runner readiness check (was fooled by effect help-text containing "Running"), the `mod.shaper.remap`/`mod-shaper-chain` auto-connect tests and `wire-magnitude` (updated for the now-signed `mod.source.lfo` output), `capabilities` (`lfo.hasSeek`), and repointing the DXV/h264 media tests at the committed small fixtures.

### Resolume rebroadcasts the WHOLE composition on every clip trigger (2026-08-30, external)

Resolume's WebSocket API has no granular change events for clip state: any trigger makes it
push the entire composition document again. That is Resolume's behaviour and we cannot fix it —
but it is the single largest CPU consumer in our code, so it is worth knowing exactly what it
costs and what makes it worse.

**Measured** (`sample` of live Arena, 15 barrels / 107 effects, in `.composition-pull-2026-08-30/`):
the ixwebsocket client thread that receives those broadcasts was the **busiest thread we own** —
2336 ms busy per 10 s, of which **~1.35 s is `nlohmann` DOM-parsing the composition**. That is
~13% of a core, continuously, all show. It is off the render path, so it costs no frames directly;
what it fed — the pump holding `tick_mutex_` while the render thread queued behind it — is fixed
(see Recently Completed).

**What amplifies it, in order:**

1. **A tight autopilot loop is a trigger per frame.** The show flips three static images very
   rapidly on an autopilot sequence to fake a video. Every flip is a clip trigger, so Resolume
   rebroadcasts the whole composition *every frame*. This is the dominant multiplier and it is
   fixable **on the show side** — that loop does not have to be built out of clip triggers.
2. **Large data blocks in parameters ride inline in every broadcast.** Our own barrel `config`
   blob is one of them: it is a param on the effect, so Resolume ships it inside the composition
   document, and we pay to re-parse it at whatever rate the triggers fire. Anything large we put
   in a param is multiplied by the broadcast rate.

**Scale reference for a bench:** the canned composition from `fake_resolume` is ~10 KB; a real
show composition is 0.5-1 MB. `fake_resolume --clips 8` ≈ 520 KB, `--clips 16` ≈ 980 KB.

## Future Work

### Barrel/bridge CPU: queued after the tick_mutex_ pass (queued 2026-08-30)

Ranked by measured share, from the live Arena profile and the post-fix bench (both in
`.composition-pull-2026-08-30/`; harness usage is in the Recently Completed entry below).

- **Don't DOM-parse a composition we have already seen** — *the biggest remaining lever, ~1.35 s
  per 10 s of a core.* `WsClient`'s message handler parses every Resolume broadcast into a full
  `nlohmann` DOM, and we then extract a handful of things from it: barrel `config` blobs, tempo,
  clip connected states, param ids. Cheapest first step is a pre-check on the RAW frame before
  `nlohmann::parse` — hash it, or hash the slice we care about — and drop unchanged repeats; the
  thorough version is a SAX pass that only materializes the paths we read. Directly proportional
  to the rebroadcast storm above, so it is worth doing even after the show-side workaround.
- **Keep large blobs out of Resolume parameters.** The barrel `config` blob is re-broadcast in
  full on every trigger (see Known Issues). Shrinking it, or moving the sketch out of the param
  entirely and keeping only a reference, cuts Resolume's own broadcast size — the one lever we
  have on *their* cost, not just ours.
- **`endSubmitBatch`'s per-instance `[_MTLCommandBuffer waitUntilScheduled]`** — 24% of what is
  left on the render path, and it is synchronisation rather than work: 15 instances means 15
  waits per frame. Likely unnecessary (or needed only on the last submit of a frame).
  **Deliberately kept for now** — deferred on purpose, not overlooked.
- **Coalesce redundant `CompositionState` frames** arriving inside one 5 ms pump tick: each is
  currently applied in full, and every one supersedes the last. Blocked on `instance_locator_`'s
  dwell-based fork detection, which reads the intermediate timestamps — so this needs the dwell
  clock separated from the frame stream first.
- **WAMR's per-call setjmp/`sigprocmask` guard** — 2.4% of the render path, the tail of the
  wasm-call-overhead work. Next step would be batching read-tap patches per instance per frame,
  or `WAMR_DISABLE_HW_BOUND_CHECK` (riskier).
- **Metal encode / PSO churn** — ~33% of the render path and the largest block of *real* work
  left. Not investigated; profile before assuming anything is wrong with it.


### Barrel sketch sync: never patch the world (queued 2026-07)
Make a full sketch sync a **recovery mechanism, not a data path** — it should run only on initial wire-up, instance switch, reconnect, or detected divergence; never on an ordinary edit. Four steps, each independently shippable, each of which alone would have prevented the edit-loss outage above: (1) keep UI-only metadata (`lastModified`) off the wire and out of the push-dedup key; (2) tag broadcast ops with an `origin` client id so a client ignores its own echo instead of refetching; (3) apply remote ops incrementally rather than refetching the whole document; (4) revision numbers on the state doc so a *stale* snapshot can be recognized and discarded — today we can't tell, which is the root reason the replace was unsafe. Plus a dev-mode loop canary (the outage ran at ~140 pushes/sec and nothing warned). Full write-up: **[BARREL_SYNC_PLAN.md](BARREL_SYNC_PLAN.md)**.

### Shared-server / event push (queued 2026-07)
- **Naming barrel instances**: user-editable names; auto-assign unnamed instances from their Resolume context by enumerating effects via the Resolume webserver and locating the barrel instance. (Playground labels + the sidechannel writerTag→label mapping are ready consumers.)
- **Resolume crash recovery**: cache a copy of each barrel sketch in IndexedDB web-side, detect unclean shutdown, offer restore.
- **Playground per-instance render-rate/priority controls** if many simultaneous full-res instances prove heavy.
- **Sidechannel bus pruning**: channel entries (one texture each) are never released when a writer disappears — bounded by channel count in practice; revisit alongside the (now-shipped) sidechannel previews.
- **Multi-select follow-ups**: group drag-reorder (drag moves only the grabbed card today; a plain drag first collapses the group) and group param editing (the arrangement's `isMixed`/"many" widgets are the model). Cmd+A / group copy/cut/paste/delete themselves are done — see Recently Completed.
- **Inline opacity/blend in fused kernels** (queued 2026-07): per-effect `__opacity__`/`__blend__` currently force a stage standalone (the wet/dry blend is a host texture pass needing the materialized dry input). But inside a fused kernel the pre-effect color is a register, and all 16 modes are per-pixel math — so the fused codegen could ALWAYS emit a dry-save + blend wrapper around each fragment call (identity at opacity 1 / mode 0), with opacity+mode riding the per-stage uniform prep (`fusionHasPrepare` refills per frame). Payoff beyond avoiding the split + extra dispatch: opacity/mode stop being STRUCTURAL — today `computeStructSig` embeds the exact opacity value, so every slider-drag frame rebuilds the plan, and crossing 1.0↔0.99 swaps fused PSOs (kernel-switch hitch right where users scrub). Touches: fused kernel generator (MSL+WGSL), per-stage uniform prep, `buildPlan` eligibility, `computeStructSig` (drop opacity/mode), and the standalone path stays for sampling/tap/multi-input stages. Goldens exist: `test_effect_render.cpp` "per-effect opacity endpoints" + the darken-pair fusion-split case (flip its stats assertions when this lands).

- **Instance cloning for multi-sketch** (see above)
- **Remove `on_param_change` export from `wasm_build_env.sh`**: All modules have empty stubs now. The export can be removed once we're confident nothing else calls it.
- **Remove `state.set` / `state.declare_param` / `io.*` C imports from `host.h`**: These are dead imports kept only so old WASM binaries don't fail to link. Can be removed once all modules are rebuilt.
- **`state_read` → route through bridge core**: The JS reimplementation in `wasm-host.ts` could delegate to bridge core's `json_doc::read()` instead of doing field extraction in JS.
- **Rail UI: vertical rail lines in the gutter**: Currently only tap dots are shown. Vertical lines representing rails should be drawn in the column gutter.
- **Rail UI: tap line positioning refinement**: Tap indicator positioning in the gutter depends on `FieldLayoutManager` bounding boxes which may be stale on first render.

## Recently Completed

- **Barrel render thread stalled on `tick_mutex_`** (2026-08-30, commit `bb7b7d8b`): the show
  composition dipped under 60 Hz with neither CPU nor GPU saturated. A live `sample` of Arena
  found the render thread spending **58% of its time inside our plugin blocked on a mutex** —
  784 ms per 10 s in `BridgeServer::has_clients()`, which took `tick_mutex_` merely to answer
  "is anyone watching?" and, with no editor attached, always answered no. The pump holds that
  same lock across its whole 5 ms tick, most of it parsing Resolume's composition rebroadcasts;
  at 15 instances the render path asks for it 30-45 times a frame. Priority inversion.
  Fixed by: `has_clients()` reading an atomic mirrored from the ix connect/disconnect callbacks
  (never read `ws_server_` lock-free — it is reset on shutdown); `key_observed()` short-circuiting
  on that atomic and otherwise taking `ObserverRegistry`'s own new leaf mutex (order is one-way,
  `tick_mutex_` → registry); and `WsClient::poll()` **moving** its inbox instead of deep-copying
  it — a `CompositionState` holds the whole composition json BY VALUE, so every broadcast was
  copied once and destroyed twice, on the pump, inside the lock — with the pump now draining
  before it takes the lock and destroying after it releases.
  **Result:** 980 KB composition rebroadcast at 60 Hz, 15 instances at 1080p, ProcessOpenGL
  **8.2-8.8 ms → 4.8-5.4 ms** per composition frame; `has_clients`/`key_observed`/mutex-wait all
  go to zero in the profile, executor work unchanged, frames byte-identical. With no Resolume
  peer at all, before ≡ after (~5.0 ms) — the entire win is the stall.
  **Bug class:** anything a render thread calls per instance per frame must not touch
  `tick_mutex_`, and nothing should return a large json by value out of a locked queue.
  **How to measure it again** (both shipped with the fix):
  `ffgl_runner <bundle> 1920 1080 300 out.png --bpm 120 --config a.json --config b.json ...` —
  `--config` is now repeatable and mounts one barrel instance per file in ONE process, rendered
  in argument order every frame, each with its own FBO; the sidechannel bus and `tick_mutex_` are
  process-global, so cross-instance contention only exists when the instances coexist. Config
  files are `{uuid, sketch}` envelopes so instances register under their real composition UUIDs.
  `--serve 60 <secs>` paces like a host and prints the ProcessOpenGL average, which is the
  faithful number. An A/B must swap the **sibling** `libbridge_server.dylib` (next to the
  `.bundle` directory, not inside it). And drive it with
  `fake_resolume 8090 --rebroadcast 60 --clips 16 <uuid...>` +
  `NANO_RESOLUME_URL=ws://127.0.0.1:8090/api/v1`: **a bench against the bare canned composition
  measures an idle bridge** — at 20 Hz / 520 KB this fix shows no difference at all.
  Snapshot the live composition read-only with `{action:'get'}` over :8081 (`get`/`observe` never
  dirty an instance); the 2026-08-30 pull and the live sample are in `.composition-pull-2026-08-30/`.

- **Barrel resolution-scale snap-back** (2026-07): the 1/4 / 1/2 / 2x buttons applied but the
  UI popped back to 1x (and 1x could then never be re-selected) — `coerceSketch`'s field
  whitelist dropped `outputFormat` from the echo of our own push, another face of the
  "patch the world" replace ([BARREL_SYNC_PLAN.md](BARREL_SYNC_PLAN.md), defect 3). Fixed by
  whitelisting the key; the whitelist inversion that kills the bug class is still queued.
- **`control.barrel_macros` edit-loss loop** (2026-07): with a macros instance in the sketch, barrel-mode edits stuck only by chance. `defaultStateForPlugin`'s legacy `params` fallback loop applied only the OUTPUT skip, so it silently re-added the help field the schema loop had excluded — and `barrel_macros` is *nothing but* a help field + 16 pure outputs, so its defaults came out `{intro: 0}` instead of `{}`. That made the seeder non-idempotent with `pruneHelpFieldState`, and the resulting seed/prune churn drove a push↔refetch loop. Fixed by applying the help skip in the fallback loop too. Note the barrel was **not** at fault (a raw-WS client editing the same running barrel loses nothing) — the surviving sync weaknesses are tracked under Known Issues + [BARREL_SYNC_PLAN.md](BARREL_SYNC_PLAN.md).
- **Multi-select effect cards** (2026-07): `appState.local.multiSelection` (effect paths, one sketch) beside the primary selection. Cmd/ctrl-click toggles, shift-click range-selects from the primary anchor, Cmd+A selects the whole edited sketch (all via `handleCommonEditShortcut` / `column-group`'s pointerdown, so both sketch surfaces get it). Group copy captures a `kind:'effects'` payload — chain-ordered cards PLUS the wires internal to the group — mirrored to the OS clipboard as JSON, which is what carries groups BETWEEN surfaces (effect IDE ↔ playground ↔ live Resolume tabs). Paste mints fresh instance keys, remaps the wires onto them (fresh wire ids), inserts a contiguous block, selects it; one undo point. Group delete/cut are one undo point. Pure capture/remap helpers in `state/effects-payload.ts` (vitest); gestures e2e'd in `test/multi-select.test.ts`. Multi-select-only surfaces stay opt-in via optional `ColumnController` methods (the arrangement keeps its own system).
- **Sidechannel texture previews** (2026-07): shipped as the Instances-tab sidechannel cards — `{type:'sidechannel', channel}` trace target, `sidechannel_bus::peek` → `executor_sidechannel_texture` (playground) / preview requests routed to the channel's writer instance (barrel).
- **`util.dashboard` knob `{}` "reset" was a test artifact, not a real bug**: the previously-reported "authored knob state resets to `{}` in the resolume shell" did NOT exist. `dashboard-knobs.test.ts` test 1 returned the raw MobX-observable `inst.state` to Puppeteer, whose structured clone walks the Proxy and yields `{}` (a false "wiped"). In-page snapshots (`Object.keys(instances)`) showed the authored knobs intact through the entire drag. Fix: serialize in-page (`JSON.parse(JSON.stringify(inst.state))`) before returning; test re-enabled (no longer `it.skip`). The engine never stomps the state — the local path was always correct (the distinct, real output-mirror bug — `{knob_i: 0}` — was fixed separately).
- **`util.sketch_output` — sketch's 8 scalar OUTPUTS** (inverse of the dashboard): 8 relay output-trace fields wires write INTO; `sketch_output_source` capability. See the effect + memory.
- **`util.dashboard` is a real wasm effect**: replaced the virtual knob bank + the executor's `runDashboard` handler with a real core-bundle effect — `knob_0..7` as relay fields (`io = in|out`), `is_identity` passthrough, `sketch_input_source` capability. Added relay-field write capture to the shared tap path (a field that's both read- and write-tapped publishes its modulated value). Knobs wire directly (input + output) through their `<scalar-knob>`; the dashboard's output-trace row is hidden.
- **Relay-field output-mirror fix**: `executor-host` no longer mirrors a relay field's (io in+out) published output over its authored value — that clobbered dashboard knobs and broke knob→param wires. Mirror is now restricted to PURE outputs (`(io&2) && !(io&1)`).
- **Val store moved to bridge core**: Val handles now live in bridge core's WASM memory (`nlohmann::json`), eliminating JS↔WASM boundary crossings for val operations and the JSON serialization round-trip in `state_set_val`.
- **`on_param_change` → `on_state_patched` migration**: All 8 modules now use `on_state_patched` with field name matching via `state::pathIs()` and `state::patchFloat()` helpers. `onParamChange` removed from JS `WasmModule` interface and all callers.
- **Legacy host function cleanup**: `state.set` (JSON), `state.declare_param`, `io.declare_*` stubbed to no-ops in JS. Legacy C++ wrappers (`state::set`, `state::declareParam`, `state::setMetadata`) removed from `host.h`.
- **`io.h` deleted**: Was already gone; no module imported it.
- **`setParam` protocol fixed**: Changed from `paramIndex: number` to `paramKey: string` across engine types, proxy, worker, and controller.
- **Column-move bug fixed**: Empty trailing columns no longer override module output. Sketch executor only updates `lastOutput` for columns containing modules.
- **Render deduplication**: Real modules in sketch chains are rendered once (by the executor), not twice. Anchor modules rendered separately only when not in a chain.
