// test_resource_root.cpp — pins the PRECEDENCE in platform/resource_root.h.
//
// The ordering is the whole safety property of the shared-resource-root scheme.
// tools/barrel_host_portability.sh (a registered ctest) and tools/soak_test.py
// run the DEV-BUILT NanoBarrel.bundle with no env override and simply inherit
// whatever the plugin resolves. If an installed Electron app's record ever
// outranked the image-relative walk, those runs would silently load a RELEASED
// app's effects and report a pass against code that was never built here.
//
// So the cases below are not "does the resolver work" — they are "does a
// plausible-looking installed app lose".

#include <catch2/catch_test_macros.hpp>

#include <cstdio>
#include <cstdlib>
#include <unistd.h>
#include <fstream>
#include <string>

#include "platform/resource_root.h"

namespace {

/// Build a directory that satisfies looksLikeResourceRoot(): marker + a
/// non-empty wasm/core.wasm. The contents don't matter — only existence does.
void makeRoot(const std::string& dir) {
  nano_paths::ensureDir(dir);
  nano_paths::ensureDir(nano_paths::joinPath(dir, "wasm"));
  std::ofstream(nano_paths::joinPath(dir, nano_paths::kResourceMarker))
      << "{\"kind\":\"nano-resources\",\"version\":1}";
  std::ofstream(nano_paths::joinPath(nano_paths::joinPath(dir, "wasm"), "core.wasm"))
      << "\0asm";
}

std::string tempDir() {
  char tmpl[] = "/tmp/nano_resroot_XXXXXX";
  const char* d = ::mkdtemp(tmpl);
  REQUIRE(d != nullptr);
  return std::string(d);
}

/// RAII for an env var, so one case's override can't leak into the next.
struct ScopedEnv {
  std::string name;
  bool had;
  std::string old;
  ScopedEnv(const char* n, const char* v) : name(n) {
    const char* cur = getenv(n);
    had = cur != nullptr;
    if (had) old = cur;
    if (v) setenv(n, v, 1); else unsetenv(n);
  }
  ~ScopedEnv() {
    if (had) setenv(name.c_str(), old.c_str(), 1); else unsetenv(name.c_str());
  }
};

/// An address in THIS image, which is the test binary — it sits in the same
/// build tree as the plugin, so the image-relative walk finds the same root.
void selfAnchor() {}
const void* kSelf = reinterpret_cast<const void*>(&selfAnchor);

}  // namespace

TEST_CASE("a marker alone is not a resource root", "[resource_root]") {
  const std::string dir = tempDir();
  std::ofstream(nano_paths::joinPath(dir, nano_paths::kResourceMarker)) << "{}";
  // No wasm/core.wasm: accepting this would turn "no such directory" into the
  // far more confusing "ERROR: no WASM effects loaded".
  REQUIRE_FALSE(nano_paths::looksLikeResourceRoot(dir));

  makeRoot(dir);
  REQUIRE(nano_paths::looksLikeResourceRoot(dir));
}

TEST_CASE("NANO_RESOURCE_ROOT beats everything", "[resource_root]") {
  const std::string dir = tempDir();
  makeRoot(dir);
  ScopedEnv e("NANO_RESOURCE_ROOT", dir.c_str());
  REQUIRE(nano_paths::resourceRoot(kSelf) == dir);
}

TEST_CASE("NANO_BARREL_WASM_DIR still names the wasm dir", "[resource_root]") {
  const std::string dir = tempDir();
  makeRoot(dir);
  const std::string wasm = nano_paths::joinPath(dir, "wasm");
  ScopedEnv a("NANO_RESOURCE_ROOT", nullptr);
  ScopedEnv b("NANO_BARREL_WASM_DIR", wasm.c_str());
  // Back-compat: several scripts point this straight at build/wasm. It must
  // keep meaning the directory itself, with the root being its parent.
  REQUIRE(nano_paths::wasmDir(kSelf) == wasm);
  REQUIRE(nano_paths::resourceRoot(kSelf) == dir);
}

TEST_CASE("the dev tree outranks an installed app", "[resource_root]") {
  // Point the install record at a perfectly valid root that is NOT ours. The
  // image-relative walk must still win, or a dev-tree test run would load a
  // released app's effects.
  const std::string installed = tempDir();
  makeRoot(installed);

  const std::string support = nano_paths::supportDir();
  if (support.empty()) return;  // no HOME — nothing to assert
  const std::string record = nano_paths::joinPath(support, "electron_app.json");

  // Preserve a real record if the developer has the app installed.
  std::string saved;
  bool had = false;
  {
    std::ifstream f(record);
    if (f.good()) {
      had = true;
      saved.assign((std::istreambuf_iterator<char>(f)),
                   std::istreambuf_iterator<char>());
    }
  }
  std::ofstream(record) << "{\"resourceRoot\":\"" << installed << "\"}";

  ScopedEnv a("NANO_RESOURCE_ROOT", nullptr);
  ScopedEnv b("NANO_BARREL_WASM_DIR", nullptr);

  const std::string got = nano_paths::resourceRoot(kSelf);

  if (had) std::ofstream(record) << saved;
  else ::remove(record.c_str());

  // The test binary lives in native/build, so the walk reaches <repo>/build.
  // If that root isn't built yet there is nothing to compare against, but the
  // one thing that must never happen is silently taking the installed one.
  if (!got.empty()) REQUIRE(got != installed);
}

TEST_CASE("the install record parses out of a realistic file", "[resource_root]") {
  const std::string support = nano_paths::supportDir();
  if (support.empty()) return;
  const std::string record = nano_paths::joinPath(support, "electron_app.json");

  std::string saved;
  bool had = false;
  {
    std::ifstream f(record);
    if (f.good()) {
      had = true;
      saved.assign((std::istreambuf_iterator<char>(f)),
                   std::istreambuf_iterator<char>());
    }
  }
  std::ofstream(record) << R"({
  "appPath": "/Applications/Nano.app",
  "resourceRoot": "/Applications/Nano.app/Contents/Resources/nano",
  "version": "0.1.0",
  "updatedAt": 1758240000000
})";
  const std::string got = nano_paths::installRecordRoot();
  if (had) std::ofstream(record) << saved;
  else ::remove(record.c_str());

  REQUIRE(got == "/Applications/Nano.app/Contents/Resources/nano");
}

TEST_CASE("path helpers tolerate both separators", "[resource_root]") {
  REQUIRE(nano_paths::joinPath("/a/b", "c") == "/a/b/c");
  REQUIRE(nano_paths::joinPath("/a/b/", "c") == "/a/b/c");
  REQUIRE(nano_paths::joinPath("/a/b", "/c") == "/a/b/c");
  REQUIRE(nano_paths::joinPath("", "c") == "c");
  REQUIRE(nano_paths::parentDir("/a/b/c") == "/a/b");
  REQUIRE(nano_paths::parentDir("c").empty());
}
