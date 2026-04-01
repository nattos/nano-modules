#include "bridge/param_cache.h"

namespace bridge {

void ParamCache::set(int64_t param_id, double value) {
  std::unique_lock lock(mutex_);
  values_[param_id] = value;
}

double ParamCache::get(int64_t param_id) const {
  std::shared_lock lock(mutex_);
  auto it = values_.find(param_id);
  return it != values_.end() ? it->second : 0.0;
}

bool ParamCache::has(int64_t param_id) const {
  std::shared_lock lock(mutex_);
  return values_.count(param_id) > 0;
}

void ParamCache::queue_write(int64_t param_id, double value) {
  std::lock_guard lock(outbox_mutex_);
  outbox_.emplace_back(param_id, value);
}

std::vector<std::pair<int64_t, double>> ParamCache::drain_outbox() {
  std::lock_guard lock(outbox_mutex_);
  std::vector<std::pair<int64_t, double>> result;
  result.swap(outbox_);
  return result;
}

} // namespace bridge
