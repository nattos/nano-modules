# Known Issues & Future Work

## Known Issues

### Real module instance shared across multiple sketches
A real module instance (`realModules`) that appears in more than one sketch chain will only be ticked/rendered once per frame — by whichever sketch processes it first. Subsequent sketches referencing the same instance will see stale output (the previous frame's render, or the wrong params if both sketches set different param values).

**Impact**: Incorrect rendering when the same plugin is used in multiple compositions simultaneously.

**Resolume behavior**: Resolume handles this by cloning the instance per-composition. We'll need to do the same — either by creating separate WASM instances per sketch, or by re-rendering the module with each sketch's params.

### Empty columns left behind after drag-drop
When a module is dragged out of a column, the empty column (just `texture_input` → `texture_output`) is not automatically removed. This is cosmetic — the executor correctly skips empty columns for output — but it clutters the UI.

### E2E: four known-failing suites (as of 2026-07)
Surfaced while getting the full Puppeteer e2e suite green (run against this workspace's dev server: `GPU_TEST_BASE_URL=http://localhost:5174 npx jest <name>`). The bulk of the earlier failures were a stale harness readiness-check and tests that hadn't caught up to the LFO going signed — both fixed. These four are genuine, independent, and still open:

- **`engine-wires.test.ts` — "delayed/backward texture wire = self-feedback accumulator"**: the accumulator plateaus at `102` where the test asserts it's still climbing (`> 102`). The other feedback assertions pass; this is a marginal saturation near the `≤ 110` src ceiling. Likely a real solver/timing edge (not the harness bug). Needs a look at whether the effect should keep climbing or the assertion's bound is too tight.

- **`video-stall-benchmark.test.ts` — "plays a multi-codec, multi-play-mode arrangement and records stalls"**: runs fine now (uses the committed `/media/` + `/test-videos/bench/` fixtures) but fails `expect(errors).toEqual([])` — ~594 `pageerror`/console-error entries collected during the multi-codec playback (collector at test lines ~68-76). Triage what those errors are (real decode/provider errors vs. benign warnings) before deciding whether to fix the provider or scope the assertion.

- **`arr-engine-testbed-smoke.test.ts` — "renders a real clip sketch (gpu_test → blue) into the monitor"**: times out waiting for `window.__arrEngine.frames > 4` (25s) — the arrangement engine testbed (`arr-engine-testbed.html`) never advances past a few frames. Arrangement-specific; distinct from the engine-test-runner path.

- **`arrangement-workspace.test.ts` — "refreshes the panel reactively on mount, and renames + deletes files"**: 5s timeout on a panel-reactivity assertion. Likely a MobX/Lit reactivity or file-store-refresh issue on mount.

Fixed in the same pass (for context): the engine/gpu test-runner readiness check (was fooled by effect help-text containing "Running"), the `mod.shaper.remap`/`mod-shaper-chain` auto-connect tests and `wire-magnitude` (updated for the now-signed `mod.source.lfo` output), `capabilities` (`lfo.hasSeek`), and repointing the DXV/h264 media tests at the committed small fixtures.

## Future Work

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
