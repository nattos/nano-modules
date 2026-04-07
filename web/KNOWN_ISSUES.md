# Known Issues & Future Work

## Known Issues

### Real module instance shared across multiple sketches
A real module instance (`realModules`) that appears in more than one sketch chain will only be ticked/rendered once per frame — by whichever sketch processes it first. Subsequent sketches referencing the same instance will see stale output (the previous frame's render, or the wrong params if both sketches set different param values).

**Impact**: Incorrect rendering when the same plugin is used in multiple compositions simultaneously.

**Resolume behavior**: Resolume handles this by cloning the instance per-composition. We'll need to do the same — either by creating separate WASM instances per sketch, or by re-rendering the module with each sketch's params.

### Empty columns left behind after drag-drop
When a module is dragged out of a column, the empty column (just `texture_input` → `texture_output`) is not automatically removed. This is cosmetic — the executor correctly skips empty columns for output — but it clutters the UI.

## Future Work

- **Instance cloning for multi-sketch** (see above)
- **Remove `on_param_change` export from `wasm_build_env.sh`**: All modules have empty stubs now. The export can be removed once we're confident nothing else calls it.
- **Remove `state.set` / `state.declare_param` / `io.*` C imports from `host.h`**: These are dead imports kept only so old WASM binaries don't fail to link. Can be removed once all modules are rebuilt.
- **`state_read` → route through bridge core**: The JS reimplementation in `wasm-host.ts` could delegate to bridge core's `json_doc::read()` instead of doing field extraction in JS.
- **Rail UI: vertical rail lines in the gutter**: Currently only tap dots are shown. Vertical lines representing rails should be drawn in the column gutter.
- **Rail UI: tap line positioning refinement**: Tap indicator positioning in the gutter depends on `FieldLayoutManager` bounding boxes which may be stale on first render.

## Recently Completed

- **Val store moved to bridge core**: Val handles now live in bridge core's WASM memory (`nlohmann::json`), eliminating JS↔WASM boundary crossings for val operations and the JSON serialization round-trip in `state_set_val`.
- **`on_param_change` → `on_state_patched` migration**: All 8 modules now use `on_state_patched` with field name matching via `state::pathIs()` and `state::patchFloat()` helpers. `onParamChange` removed from JS `WasmModule` interface and all callers.
- **Legacy host function cleanup**: `state.set` (JSON), `state.declare_param`, `io.declare_*` stubbed to no-ops in JS. Legacy C++ wrappers (`state::set`, `state::declareParam`, `state::setMetadata`) removed from `host.h`.
- **`io.h` deleted**: Was already gone; no module imported it.
- **`setParam` protocol fixed**: Changed from `paramIndex: number` to `paramKey: string` across engine types, proxy, worker, and controller.
- **Column-move bug fixed**: Empty trailing columns no longer override module output. Sketch executor only updates `lastOutput` for columns containing modules.
- **Render deduplication**: Real modules in sketch chains are rendered once (by the executor), not twice. Anchor modules rendered separately only when not in a chain.
