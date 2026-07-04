// sidechannel_bus.cpp — see sidechannel_bus.h for the design contract.

#include "sketch/sidechannel_bus.h"

#include <map>
#include <string>

#include <nlohmann/json.hpp>

#include "sketch/exec_gpu.h"

#ifndef __wasm__
#include <mutex>
#endif

namespace sidechannel_bus {
namespace {

struct Entry {
  int32_t tex = -1;
  int w = 0, h = 0;
  int32_t format = -1;
  uint64_t writeSeq = 0;
  std::string writerTag;
};

// Process globals — the whole point (shared across every executor in the
// dylib / the wasm memory).
std::map<std::string, Entry>& channels() {
  static std::map<std::string, Entry> m;
  return m;
}
std::map<std::string, uint64_t>& readerPrevSeq() {
  static std::map<std::string, uint64_t> m;
  return m;
}
uint64_t g_renderSeq = 0;
uint64_t g_version = 0;

#ifndef __wasm__
// Leaf lock (see header): held across gpu_* calls by design — the GPU layer
// never re-enters the bus and never takes bridge locks. Native renders are
// already serialized under BarrelRuntime's render_mu; this keeps tests and
// any future host honest too. The wasm build is single-threaded.
std::mutex& mu() {
  static std::mutex m;
  return m;
}
#define BUS_LOCK() std::lock_guard<std::mutex> lock(mu())
#else
#define BUS_LOCK()
#endif

}  // namespace

uint64_t beginRender() {
  BUS_LOCK();
  return ++g_renderSeq;
}

void publish(const char* channel, int32_t srcTex, int w, int h,
             const char* writerTag) {
  if (!channel || !*channel || srcTex <= 0 || w <= 0 || h <= 0) return;
  BUS_LOCK();
  Entry& e = channels()[channel];
  const int32_t fmt = gpu_get_texture_format(srcTex);
  if (e.tex < 0 || e.w != w || e.h != h || e.format != fmt) {
    if (e.tex >= 0) gpu_release(e.tex);
    e.tex = gpu_create_texture(w, h, fmt);
    e.w = w; e.h = h; e.format = fmt;
    ++g_version;                       // size/format is metadata
    if (e.tex < 0) { channels().erase(channel); return; }
  }
  gpu_copy_texture(srcTex, e.tex);
  e.writeSeq = g_renderSeq;
  const char* tag = writerTag ? writerTag : "";
  if (e.writerTag != tag) {
    e.writerTag = tag;
    ++g_version;                       // writer identity is metadata
  }
}

Read acquire(const char* channel, const char* readerId, uint64_t currentSeq) {
  Read r;
  if (!channel || !*channel || !readerId) return r;
  BUS_LOCK();
  // First sight leaves prevSeq at 0, so an already-written channel is fresh
  // on a brand-new reader's first render (writeSeq >= 1 > 0... i.e. >= 0).
  uint64_t& prev = readerPrevSeq()[readerId];
  const uint64_t prevSeq = prev;
  prev = currentSeq;
  auto it = channels().find(channel);
  if (it == channels().end() || it->second.tex < 0) return r;
  r.tex = it->second.tex;
  r.w = it->second.w;
  r.h = it->second.h;
  r.fresh = it->second.writeSeq >= prevSeq && it->second.writeSeq > 0;
  return r;
}

Read peek(const char* channel) {
  Read r;
  if (!channel || !*channel) return r;
  BUS_LOCK();
  auto it = channels().find(channel);
  if (it == channels().end() || it->second.tex < 0) return r;
  r.tex = it->second.tex;
  r.w = it->second.w;
  r.h = it->second.h;
  r.fresh = it->second.writeSeq > 0;  // "ever written" — no reader semantics
  return r;
}

uint64_t version() {
  BUS_LOCK();
  return g_version;
}

int32_t infoJson(char* out, int32_t cap) {
  nlohmann::json j = nlohmann::json::object();
  {
    BUS_LOCK();
    for (const auto& kv : channels()) {
      if (kv.second.tex < 0) continue;
      j[kv.first] = {
        {"writer", kv.second.writerTag},
        {"w", kv.second.w},
        {"h", kv.second.h},
      };
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
  BUS_LOCK();
  for (auto& kv : channels()) {
    if (kv.second.tex >= 0) gpu_release(kv.second.tex);
  }
  channels().clear();
  readerPrevSeq().clear();
  g_renderSeq = 0;
  g_version = 0;
}

}  // namespace sidechannel_bus
