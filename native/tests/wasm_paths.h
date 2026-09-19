#pragma once
// wasm_paths.h — redirect the baked bundle paths for a cross-compiled run.
//
// Test targets bake absolute source-tree paths for the .wasm bundles, which is
// right for a binary that runs where it was built. A Windows binary running
// under CrossOver cannot see any of them, so NANO_WASM_DIR names the directory
// the bundles were copied into and the basename is kept.
//
// Tests opt in by redefining their path macros through nanoWasmPath() — see
// the block at the top of test_effect_render.cpp. Unset, this is the identity,
// so a native run is untouched.

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
