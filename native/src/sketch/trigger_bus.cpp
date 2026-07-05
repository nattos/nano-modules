// trigger_bus.cpp — see trigger_bus.h for the design contract.

#include "sketch/trigger_bus.h"

#include <map>

#include <nlohmann/json.hpp>

#ifndef __wasm__
#include <mutex>
#endif

namespace trigger_bus {
namespace {

// Bounded event history. The server pump drains every ~5ms and the executor
// emits a handful per frame, so this is generous; a slow consumer simply
// misses events older than the ring (acceptable for launch events).
constexpr size_t kLogCap = 256;

struct ChannelInfo {
  uint64_t seq = 0;
  bool on = false;
  float velocity = 0.0f;
  std::string writerTag;
};

// Process globals — the whole point (shared across every executor in the
// dylib / the wasm memory).
std::vector<Event>& log() {
  static std::vector<Event> v;
  return v;
}
std::map<std::string, uint64_t>& consumerSeq() {
  static std::map<std::string, uint64_t> m;
  return m;
}
// rail -> channel -> latest activity (for infoJson / the UI).
std::map<std::string, std::map<int, ChannelInfo>>& meta() {
  static std::map<std::string, std::map<int, ChannelInfo>> m;
  return m;
}
uint64_t g_seq = 0;
uint64_t g_version = 0;

#ifndef __wasm__
// Leaf lock (see header): never nested inside BridgeServer/tick_mutex_ or the
// render lock. The wasm build is single-threaded.
std::mutex& mu() {
  static std::mutex m;
  return m;
}
#define TRIG_LOCK() std::lock_guard<std::mutex> lock(mu())
#else
#define TRIG_LOCK()
#endif

}  // namespace

void emit(const char* rail, int channel, bool on, float velocity,
          const char* writerTag) {
  const std::string r = (rail && *rail) ? rail : kGlobalRail;
  const std::string tag = writerTag ? writerTag : "";
  TRIG_LOCK();
  Event e;
  e.seq = ++g_seq;
  e.rail = r;
  e.channel = channel;
  e.on = on;
  e.velocity = velocity;
  e.writerTag = tag;
  log().push_back(e);
  if (log().size() > kLogCap) log().erase(log().begin());

  auto& channels = meta()[r];
  auto cit = channels.find(channel);
  if (cit == channels.end()) {
    ++g_version;  // a rail/channel first seen is metadata
    cit = channels.emplace(channel, ChannelInfo{}).first;
  } else if (cit->second.writerTag != tag) {
    ++g_version;  // a new writer on the channel is metadata
  }
  cit->second.seq = e.seq;
  cit->second.on = on;
  cit->second.velocity = velocity;
  cit->second.writerTag = tag;
}

std::vector<Event> drain(const char* consumerId) {
  std::vector<Event> out;
  if (!consumerId) return out;
  TRIG_LOCK();
  uint64_t& prev = consumerSeq()[consumerId];
  for (const auto& e : log()) {
    if (e.seq > prev) out.push_back(e);
  }
  prev = g_seq;
  return out;
}

uint64_t version() {
  TRIG_LOCK();
  return g_version;
}

int32_t infoJson(char* out, int32_t cap) {
  nlohmann::json j = nlohmann::json::object();
  {
    TRIG_LOCK();
    for (const auto& [rail, channels] : meta()) {
      nlohmann::json rj = nlohmann::json::object();
      for (const auto& [ch, info] : channels) {
        rj[std::to_string(ch)] = {
          {"on", info.on},
          {"velocity", info.velocity},
          {"writer", info.writerTag},
          {"seq", info.seq},
        };
      }
      j[rail] = std::move(rj);
    }
  }
  static std::string buf;  // alive until the host copies it out (same call site)
  buf = j.dump();
  const int32_t n = (int32_t)buf.size();
  if (out && cap > 0) {
    const int32_t c = n < cap ? n : cap;
    __builtin_memcpy(out, buf.data(), (size_t)c);
  }
  return n;
}

void resetForTest() {
  TRIG_LOCK();
  log().clear();
  consumerSeq().clear();
  meta().clear();
  g_seq = 0;
  g_version = 0;
}

}  // namespace trigger_bus
