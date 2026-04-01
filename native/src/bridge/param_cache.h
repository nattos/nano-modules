#pragma once

#include <cstdint>
#include <shared_mutex>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bridge {

/// Thread-safe parameter value cache.
/// Reads are concurrent (shared lock), writes are exclusive.
/// Supports an "outbox" for queuing writes from WASM back to Resolume.
class ParamCache {
public:
  /// Set a parameter value (e.g., from incoming Resolume WS update).
  void set(int64_t param_id, double value);

  /// Get a parameter value. Returns 0.0 if not found.
  double get(int64_t param_id) const;

  /// Check if a parameter exists in the cache.
  bool has(int64_t param_id) const;

  /// Queue a write to be sent to Resolume (called from WASM host functions).
  void queue_write(int64_t param_id, double value);

  /// Drain all queued writes. Returns the writes and clears the outbox.
  std::vector<std::pair<int64_t, double>> drain_outbox();

private:
  mutable std::shared_mutex mutex_;
  std::unordered_map<int64_t, double> values_;

  std::mutex outbox_mutex_;
  std::vector<std::pair<int64_t, double>> outbox_;
};

} // namespace bridge
