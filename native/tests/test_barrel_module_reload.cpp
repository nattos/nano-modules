// test_barrel_module_reload.cpp — reloading effect bundles in a running barrel.
//
// The shared runtime lives for the whole host process, so what it loaded at
// acquire used to be final until Resolume restarted. An editor now sends
// `reload_modules` over the bridge and the next render re-resolves the bundle
// set (bridge/module_dirs.h) and swaps whatever changed.
//
// This drives it the way it happens for real: the library loaded through the
// plugin's BridgeLoader, module folders configured through the same settings
// file the app writes, and the request sent by a WebSocket client standing in
// for the editor. The scenario is the one the feature exists for — a deployed
// folder with a dev folder mapped after it, checked and unchecked — plus a
// bundle rebuilt in place, a reload with nothing to do, and folders removed.
//
// "mine" is the testonly bundle in the deployed folder (debug.clear_copy_test
// renders) and the text bundle in the dev folder (it has no such effect, so the
// same sketch passes through). The two are told apart by what renders and by
// the catalog the barrel republishes.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <direct.h>
#include <sys/utime.h>
#else
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
#endif

#include <ixwebsocket/IXWebSocket.h>
#include <nlohmann/json.hpp>

#include "plugin/bridge_loader.h"

#include "barrel_probe_tex.h"
#include "wasm_paths.h"

namespace {

constexpr int kW = 16;
constexpr int kH = 16;

void setEnv(const char* k, const std::string& v) {
#ifdef _WIN32
  _putenv_s(k, v.c_str());
#else
  setenv(k, v.c_str(), 1);
#endif
}

std::string tempRoot() {
  const char* base = getenv("TMPDIR");
#ifdef _WIN32
  if (!base) base = getenv("TEMP");
#endif
  const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
  return std::string(base ? base : "/tmp") + "/nano-reload-" + std::to_string(stamp);
}

void makeDir(const std::string& p) {
#ifdef _WIN32
  _mkdir(p.c_str());
#else
  ::mkdir(p.c_str(), 0755);
#endif
}

void copyFile(const std::string& from, const std::string& to) {
  std::ifstream in(from, std::ios::binary);
  REQUIRE(in.good());
  std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  std::ofstream(to, std::ios::binary) << bytes;
}

/// Move a file's mtime `secondsFromNow` from the present — "rebuilt" without
/// changing a byte, which is what the reload's change check must still see.
void stampFile(const std::string& p, int secondsFromNow) {
  const auto t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now()) +
                 secondsFromNow;
#ifdef _WIN32
  struct _utimbuf ut{t, t};
  _utime(p.c_str(), &ut);
#else
  struct timeval tv[2] = {{t, 0}, {t, 0}};
  ::utimes(p.c_str(), tv);
#endif
}

void writePaths(const std::string& file, const nlohmann::json& rows) {
  std::ofstream(file) << nlohmann::json{{"paths", rows}}.dump();
}

std::string sketchUsing(const char* type) {
  return std::string(R"({"chain":[{"type":"module","module_type":")") + type +
         R"(","instance_key":"k0"}],"instances":{"k0":{"module_type":")" + type +
         R"(","state":{}}},"wires":[]})";
}

struct Barrel {
  plugin::BridgeLoader loader;
  BridgeHandle h = nullptr;
  std::string key;
  void* device = nullptr;
  bool rt_ready = false;

  bool start(const std::string& wasmDir) {
    setEnv("NANO_WAIT_COMPLETED", "1");  // see test_barrel_render.cpp
    if (!loader.load(kBridgeLib)) return false;
    h = loader.bridge_init();
    if (!h) return false;
    char keybuf[128] = {0};
    const int n = loader.bridge_register_plugin(h, "com.nano.nanobarrel", 0, 1, 0, "",
                                                "test-module-reload", keybuf, sizeof(keybuf));
    key = n > 0 ? std::string(keybuf) : std::string("test-module-reload");
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

  int render(void* in_tex, void* out_tex, bool dirty) {
    const float macros[8] = {0};
    return loader.bridge_executor_render(h, key.c_str(), in_tex, out_tex, kW, kH,
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

/// The editor's side: one WebSocket to the bridge, sending the request.
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

}  // namespace

TEST_CASE("reload_modules swaps a dev folder's bundle in and out of a running barrel",
          "[barrel_render][module_reload]") {
  // A private world: a built-in dir with only core, no seeded modules, and a
  // module-paths file this test owns — all fixed before the runtime is built.
  const std::string root = tempRoot();
  const std::string builtin = root + "/builtin", defaults = root + "/default",
                    deployed = root + "/deployed", dev = root + "/dev",
                    pathsFile = root + "/module-paths.json";
  for (const auto& d : {root, builtin, defaults, deployed, dev}) makeDir(d);
  copyFile(kCoreWasm, builtin + "/core.wasm");
  copyFile(kTestonlyWasm, deployed + "/mine.wasm");
  copyFile(kTextWasm, dev + "/mine.wasm");
  setEnv("NANO_MODULES_DIR", defaults);
  setEnv("NANO_MODULE_PATHS_FILE", pathsFile);
  writePaths(pathsFile, {{{"path", deployed}, {"enabled", true}},
                         {{"path", dev}, {"enabled", false}}});

  Barrel b;
  if (!b.start(builtin)) {
    if (b.device) FAIL("runtime acquired no effects from " << builtin);
    SKIP("no GPU device");
  }
  void* in_tex = barrel_probe::createTexture(b.device, kW, kH);
  void* out_tex = barrel_probe::createTexture(b.device, kW, kH);
  REQUIRE(in_tex);
  REQUIRE(out_tex);
  barrel_probe::fillTexture(b.device, in_tex, kW, kH, 90, 90, 90, 255);

  const char* portEnv = getenv("NANO_BRIDGE_PORT");
  Editor editor;
  REQUIRE(editor.connect(portEnv ? atoi(portEnv) : 8081));

  auto mine = [&]() -> nlohmann::json {
    for (const auto& m : b.get("/global/modules"))
      if (m.value("id", "") == "com.nano.mine") return m;
    return nullptr;
  };
  auto catalogHas = [&](const char* type) {
    const auto schemas = b.get("/plugins/" + b.key + "/state/plugin_schemas");
    return schemas.is_object() && schemas.contains(type);
  };
  // Ask, then render a frame — the request is served between frames. The
  // action crosses the WebSocket onto the bridge pump, so wait for the result
  // to move rather than assume it landed before the first render.
  auto reload = [&]() -> nlohmann::json {
    const auto before = b.get("/global/modules_reload");
    const long long seq = before.is_object() ? before.value("seq", 0LL) : 0LL;
    editor.ws.send(R"({"action":"reload_modules"})");
    for (int i = 0; i < 200; i++) {
      b.render(in_tex, out_tex, false);
      const auto now = b.get("/global/modules_reload");
      if (now.is_object() && now.value("seq", 0LL) > seq) return now;
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    FAIL("reload_modules was never served");
    return nullptr;
  };

  b.setSketch(sketchUsing("debug.clear_copy_test"));

  // At acquire: the deployed copy.
  REQUIRE(mine().is_object());
  CHECK(mine()["path"] == deployed + "/mine.wasm");
  CHECK(b.render(in_tex, out_tex, true) == 1);

  // Check the dev folder: its copy wins, and the running barrel swaps to it.
  writePaths(pathsFile, {{{"path", deployed}, {"enabled", true}},
                         {{"path", dev}, {"enabled", true}}});
  auto r = reload();
  INFO(r.dump());
  REQUIRE(r["reloaded"].size() == 1);
  CHECK(r["reloaded"][0]["id"] == "com.nano.mine");
  CHECK(r["reloaded"][0]["from"] == deployed + "/mine.wasm");
  CHECK(r["reloaded"][0]["path"] == dev + "/mine.wasm");
  CHECK(r["unchanged"] == 1);  // core
  CHECK(mine()["path"] == dev + "/mine.wasm");
  CHECK_FALSE(catalogHas("debug.clear_copy_test"));
  CHECK(catalogHas("source.text.plain"));
  CHECK(b.render(in_tex, out_tex, true) == 0);  // the effect is gone: passthrough

  // Uncheck it: back to the deployed copy, and the effect renders again.
  writePaths(pathsFile, {{{"path", deployed}, {"enabled", true}},
                         {{"path", dev}, {"enabled", false}}});
  r = reload();
  REQUIRE(r["reloaded"].size() == 1);
  CHECK(r["reloaded"][0]["path"] == deployed + "/mine.wasm");
  CHECK(catalogHas("debug.clear_copy_test"));
  CHECK_FALSE(catalogHas("source.text.plain"));
  CHECK(b.render(in_tex, out_tex, true) == 1);

  // Nothing changed on disk: nothing is swapped.
  r = reload();
  CHECK(r["reloaded"].empty());
  CHECK(r["added"].empty());
  CHECK(r["removed"].empty());
  CHECK(r["unchanged"] == 2);
  CHECK(b.render(in_tex, out_tex, false) == 1);

  // The same file rebuilt: reloaded in place. Rendering carries on without a
  // sketch edit (a clean frame) — the executor re-resolves on its own.
  stampFile(deployed + "/mine.wasm", 5);
  r = reload();
  REQUIRE(r["reloaded"].size() == 1);
  CHECK(r["reloaded"][0]["from"] == r["reloaded"][0]["path"]);
  CHECK(b.render(in_tex, out_tex, false) == 1);

  // No folders at all: the bundle is unloaded, the sketch passes through.
  writePaths(pathsFile, nlohmann::json::array());
  r = reload();
  REQUIRE(r["removed"].size() == 1);
  CHECK(r["removed"][0]["id"] == "com.nano.mine");
  CHECK(mine().is_null());
  CHECK_FALSE(catalogHas("debug.clear_copy_test"));
  CHECK(b.render(in_tex, out_tex, true) == 0);

  // And mapping it again brings it back.
  writePaths(pathsFile, {{{"path", deployed}, {"enabled", true}}});
  r = reload();
  REQUIRE(r["added"].size() == 1);
  CHECK(b.render(in_tex, out_tex, true) == 1);

  barrel_probe::releaseTexture(in_tex);
  barrel_probe::releaseTexture(out_tex);
  for (const auto& f : {builtin + "/core.wasm", deployed + "/mine.wasm", dev + "/mine.wasm",
                        pathsFile})
    std::remove(f.c_str());
#ifdef _WIN32
  for (const auto& d : {builtin, defaults, deployed, dev, root}) _rmdir(d.c_str());
#else
  for (const auto& d : {builtin, defaults, deployed, dev, root}) ::rmdir(d.c_str());
#endif
}
