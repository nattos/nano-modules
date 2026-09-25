// barrel_bridge_harness.h — a barrel loaded the way the FFGL plugin loads it
// (BridgeLoader → the shared library), plus a WebSocket client standing in for
// the editor. Shared by the tests that exercise the bridge end to end.
#pragma once

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>

#ifdef _WIN32
#include <direct.h>
#else
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>

#include "plugin/bridge_loader.h"
#include "wasm_paths.h"

namespace barrel_harness {

inline void setEnv(const char* k, const std::string& v) {
#ifdef _WIN32
  _putenv_s(k, v.c_str());
#else
  setenv(k, v.c_str(), 1);
#endif
}

inline std::string tempRoot(const char* prefix) {
  const char* base = getenv("TMPDIR");
#ifdef _WIN32
  if (!base) base = getenv("TEMP");
#endif
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  return std::string(base ? base : "/tmp") + "/" + prefix + "-" + std::to_string(stamp);
}

inline void makeDir(const std::string& p) {
#ifdef _WIN32
  _mkdir(p.c_str());
#else
  ::mkdir(p.c_str(), 0755);
#endif
}

inline void copyFile(const std::string& from, const std::string& to) {
  std::ifstream in(from, std::ios::binary);
  REQUIRE(in.good());
  std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  std::ofstream(to, std::ios::binary) << bytes;
}

struct Barrel {
  plugin::BridgeLoader loader;
  BridgeHandle h = nullptr;
  std::string key;
  void* device = nullptr;
  bool rt_ready = false;

  bool start(const std::string& wasmDir, const std::string& name) {
    setEnv("NANO_WAIT_COMPLETED", "1");  // see test_barrel_render.cpp
    if (!loader.load(kBridgeLib)) return false;
    h = loader.bridge_init();
    if (!h) return false;
    char keybuf[128] = {0};
    const int n = loader.bridge_register_plugin(h, "com.nano.nanobarrel", 0, 1, 0, "",
                                                name.c_str(), keybuf, sizeof(keybuf));
    key = n > 0 ? std::string(keybuf) : name;
    rt_ready = loader.bridge_rt_acquire(h, wasmDir.c_str(), "") != 0;
    device = loader.bridge_rt_gpu_device(h);
    if (!device || !rt_ready) return false;
    loader.bridge_executor_create(h, key.c_str());
    return true;
  }

  nlohmann::json get(const std::string& path) {
    char* raw = loader.bridge_get_at(h, path.c_str());
    if (!raw) return nullptr;
    auto j = nlohmann::json::parse(raw, nullptr, false);
    loader.bridge_free_string(raw);
    return j.is_discarded() ? nlohmann::json() : j;
  }

  void setSketch(const std::string& json) {
    loader.bridge_set_at(h, ("/plugins/" + key + "/state/sketch").c_str(), json.c_str());
  }

  int render(void* in_tex, void* out_tex, bool dirty, int w = 16, int ht = 16) {
    const float macros[8] = {0};
    return loader.bridge_executor_render(h, key.c_str(), in_tex, out_tex, w, ht,
                                         1.0 / 60.0, 0.0, dirty ? 1 : 0, macros, 8,
                                         0.0, 120.0);
  }

  ~Barrel() {
    if (!h) return;
    if (rt_ready) {
      loader.bridge_executor_destroy(h, key.c_str());
      loader.bridge_rt_release(h);
    }
    loader.bridge_unregister_plugin(h, key.c_str());
    loader.bridge_release(h);
  }
};

/// The editor's side: one WebSocket to the bridge.
struct Editor {
  ix::WebSocket ws;
  bool connect(int port) {
    ws.setUrl("ws://127.0.0.1:" + std::to_string(port));
    ws.disableAutomaticReconnection();
    ws.setOnMessageCallback([](const ix::WebSocketMessagePtr&) {});  // required by ix
    ws.start();
    for (int i = 0; i < 300 && ws.getReadyState() != ix::ReadyState::Open; i++)
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    return ws.getReadyState() == ix::ReadyState::Open;
  }
  ~Editor() { ws.stop(); }
};

}  // namespace barrel_harness
