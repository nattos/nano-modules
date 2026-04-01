#pragma once

#include "wasm_export.h"

namespace wasm {

/// Register all host functions with WAMR.
/// Registers under four module names: "env", "canvas", "host", "resolume".
/// Must be called before loading any WASM modules.
bool register_host_functions();

} // namespace wasm
