#pragma once
// wasm_paths.h — redirect the baked bundle paths for a cross-compiled run.
//
// Test targets bake absolute source-tree paths for the .wasm bundles, which is
// right for a binary that runs where it was built. A Windows binary running
// under CrossOver cannot see any of them, so NANO_WASM_DIR names the directory
// the bundles were copied into and the basename is kept.
//
// Tests opt in by including this header and using the kXxxWasm bindings below
// instead of the raw macros. Unset, nanoWasmPath is the identity, so a native
// run is untouched.
//
// A test that keeps using the baked macro doesn't fail loudly under CrossOver —
// loadBundleFile just returns 0 and the case either fails on a REQUIRE or, if
// it guards with SKIP, quietly reports success having done nothing. That is
// what hid four of test_sketch_output_format's five cases.

#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>

inline const char* nanoWasmPath(const char* baked) {
  const char* dir = std::getenv("NANO_WASM_DIR");
  if (!dir || !*dir || !baked) return baked;
  // The returned pointer has to outlive the call — callers pass it straight
  // into loadBundleFile — so the rewritten paths are kept, and a deque so that
  // growing the store never moves the strings already handed out.
  static std::deque<std::string> store;
  const char* slash = std::strrchr(baked, '/');
  std::string joined = std::string(dir);
  if (!joined.empty() && joined.back() != '/' && joined.back() != '\\')
    joined += '\\';
  joined += (slash ? slash + 1 : baked);
  store.push_back(std::move(joined));
  return store.back().c_str();
}

// The bundle paths are baked as absolute source-tree paths, which a Windows
// build running under CrossOver cannot see. Bind each one ONCE, here, so every
// test spells it the same way. Each is guarded: a target only defines the
// macros for the bundles it links against.
#ifdef CORE_WASM_PATH
inline const char* const kCoreWasm = nanoWasmPath(CORE_WASM_PATH);
#endif
#ifdef TESTONLY_WASM_PATH
inline const char* const kTestonlyWasm = nanoWasmPath(TESTONLY_WASM_PATH);
#endif
#ifdef NANO_WASM_PATH
inline const char* const kNanoWasm = nanoWasmPath(NANO_WASM_PATH);
#endif
#ifdef LIGHTS_WASM_PATH
inline const char* const kLightsWasm = nanoWasmPath(LIGHTS_WASM_PATH);
#endif
#ifdef LEGACY_WASM_PATH
inline const char* const kLegacyWasm = nanoWasmPath(LEGACY_WASM_PATH);
#endif
#ifdef TEXT_WASM_PATH
inline const char* const kTextWasm = nanoWasmPath(TEXT_WASM_PATH);
#endif
#ifdef EXECUTOR_WASM_PATH
inline const char* const kExecutorWasm = nanoWasmPath(EXECUTOR_WASM_PATH);
#endif
#ifdef NANOLOOPER_WASM_PATH
inline const char* const kNanolooperWasm = nanoWasmPath(NANOLOOPER_WASM_PATH);
#endif
