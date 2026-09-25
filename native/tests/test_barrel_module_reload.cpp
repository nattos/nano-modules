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
#include <string>
#include <thread>

#ifdef _WIN32
#include <direct.h>
#include <sys/utime.h>
#else
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
#endif

#include <nlohmann/json.hpp>

#include "barrel_bridge_harness.h"
#include "barrel_probe_tex.h"
#include "wasm_paths.h"

namespace {

using namespace barrel_harness;

constexpr int kW = 16;
constexpr int kH = 16;

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

}  // namespace

TEST_CASE("reload_modules swaps a dev folder's bundle in and out of a running barrel",
          "[barrel_render][module_reload]") {
  // A private world: a built-in dir with only core, no seeded modules, and a
  // module-paths file this test owns — all fixed before the runtime is built.
  const std::string root = tempRoot("nano-reload");
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
  if (!b.start(builtin, "test-module-reload")) {
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
