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
- **Remove `on_param_change` legacy path**: All modules should migrate to `on_state_patched`. The legacy `onParamChange` call in the sketch executor can then be removed.
- **Delete `io.h`**: All modules have migrated to unified schema; the old `declare_io`/`declare_param` host functions and header can be removed.
- **Clean up old host function registrations**: `declare_param`, `declare_io`, etc. are still registered in `wasm-host.ts` but no longer used by any module.
