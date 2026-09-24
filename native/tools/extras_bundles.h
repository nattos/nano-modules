// extras_bundles.h — the bundle stems an `--extras` build put in build/wasm.
//
// The nano, lights and legacy bundles live in nano-modules-extras. When
// build_all.sh --extras built them, build_extras.sh recorded their stems in
// <wasm dir>/extras.json; the test runners load exactly those, so nothing in
// this repo names the extras' bundles and a tree built without them simply has
// fewer effects.
#pragma once

#include <fstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

inline std::vector<std::string> extrasBundleStems(const std::string& wasmDir) {
  std::ifstream f(wasmDir + "/extras.json");
  if (!f) return {};
  const auto doc = nlohmann::json::parse(f, nullptr, /*allow_exceptions=*/false);
  std::vector<std::string> stems;
  if (doc.is_object() && doc.contains("stems") && doc["stems"].is_array())
    for (const auto& s : doc["stems"])
      if (s.is_string()) stems.push_back(s.get<std::string>());
  return stems;
}
