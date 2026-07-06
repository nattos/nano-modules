#include "wasm/audio_bus.h"

#include <mutex>
#include <vector>

namespace audio_bus {
namespace {

struct Entry {
  uint64_t token;
  Listener fn;
  void* userdata;
};

// Function-local statics (thread-safe init) so the bus is a process singleton
// without a global ctor ordering dependency.
std::mutex& mu() {
  static std::mutex m;
  return m;
}
std::vector<Entry>& entries() {
  static std::vector<Entry> e;
  return e;
}
uint64_t& counter() {
  static uint64_t c = 0;
  return c;
}

}  // namespace

uint64_t add(Listener fn, void* userdata) {
  if (!fn) return 0;
  std::lock_guard<std::mutex> lk(mu());
  uint64_t token = ++counter();
  entries().push_back({token, fn, userdata});
  return token;
}

void remove(uint64_t token) {
  if (!token) return;
  std::lock_guard<std::mutex> lk(mu());
  auto& e = entries();
  for (auto it = e.begin(); it != e.end(); ++it) {
    if (it->token == token) {
      e.erase(it);
      return;
    }
  }
}

void fire(const char* instance_key, int channel) {
  // Snapshot under the lock, invoke outside it: a listener may add()/remove()
  // from its callback (no re-entrant deadlock), and a slow listener never
  // blocks another thread's registration.
  std::vector<Entry> snapshot;
  {
    std::lock_guard<std::mutex> lk(mu());
    if (entries().empty()) return;
    snapshot = entries();
  }
  const char* key = instance_key ? instance_key : "";
  for (const auto& e : snapshot) e.fn(e.userdata, key, channel);
}

}  // namespace audio_bus
