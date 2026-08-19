#pragma once

/**
 * Sidecar-canvas partition + execution-order resolution.
 *
 * A sketch has ONE `chain`, stable-partitioned: the linear effect list first,
 * then the sidecar-canvas nodes (those carrying a `canvas` placement) at the
 * tail. The canvas is a freeform node surface, so its order comes from the wires
 * between cards rather than from array position — the UI topo-sorts the whole
 * graph and stores the result as `Sketch.execOrder` (a list of instance keys).
 * The executor never sorts; it repairs that list and replays it.
 *
 * `resolveExecOrder` is the LOCK-STEP twin of `repairExecOrder` in
 * web/src/sketch-types.ts. Both are pinned by the shared fixture
 * web/test/fixtures/exec-order-cases.json (read by exec-order.test.ts and
 * tests/test_exec_order.cpp). Keep the rule byte-identical.
 */

#include <cstddef>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

namespace sketch_canvas {

/**
 * Whether a chain entry lives on the sidecar canvas rather than in the linear
 * effect list. The PRESENCE of a usable `canvas` placement is the marker; a
 * malformed one demotes the entry to linear (matching the web normalizer, which
 * strips it on ingest).
 */
inline bool isCanvasEntry(const nlohmann::json& entry) {
  if (!entry.is_object()) return false;
  auto it = entry.find("canvas");
  if (it == entry.end() || !it->is_object()) return false;
  const auto x = it->find("x");
  const auto y = it->find("y");
  return x != it->end() && x->is_number() && y != it->end() && y->is_number();
}

/**
 * Resolve the execution order into chain indices.
 *
 * `execOrder` is a list of instance keys. Keep the ones that still exist, in the
 * order given, dropping duplicates; then append every chain entry the list
 * didn't mention, in chain order. Total and deterministic, so a stale, partial
 * or foreign order degrades gracefully instead of mis-ordering. An absent or
 * unusable list yields plain chain order — the ordinary case, and the one every
 * canvas-free sketch takes.
 */
inline std::vector<size_t> resolveExecOrder(const nlohmann::json& chain,
                                            const nlohmann::json& execOrder) {
  std::vector<size_t> out;
  const size_t n = chain.is_array() ? chain.size() : 0;
  out.reserve(n);
  if (n == 0) return out;

  std::vector<bool> taken(n, false);
  if (execOrder.is_array() && !execOrder.empty()) {
    // Key → FIRST chain index carrying it (a document with duplicate keys
    // resolves to the earlier entry; the later one is appended below).
    std::unordered_map<std::string, size_t> idxByKey;
    idxByKey.reserve(n * 2);
    for (size_t i = 0; i < n; ++i) {
      if (!chain[i].is_object()) continue;
      const std::string k = chain[i].value("instance_key", std::string());
      if (!k.empty()) idxByKey.emplace(k, i);
    }
    for (const auto& e : execOrder) {
      if (!e.is_string()) continue;
      auto it = idxByKey.find(e.get<std::string>());
      if (it == idxByKey.end() || taken[it->second]) continue;
      taken[it->second] = true;
      out.push_back(it->second);
    }
  }
  for (size_t i = 0; i < n; ++i) if (!taken[i]) out.push_back(i);
  return out;
}

/** True when `order` is just plain chain order (the fast, ordinary case). */
inline bool isIdentityOrder(const std::vector<size_t>& order) {
  for (size_t i = 0; i < order.size(); ++i) if (order[i] != i) return false;
  return true;
}

}  // namespace sketch_canvas
