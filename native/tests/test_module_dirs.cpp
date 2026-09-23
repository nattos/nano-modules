// test_module_dirs.cpp — effect bundles from the built-in, default and mapped
// module directories (bridge/module_dirs.h).
//
// The resolution cases are pure filesystem: temp directories holding empty
// `<stem>.wasm` files. The last case loads a REAL bundle out of a mapped
// directory and runs a sketch against it, then drops the directory and checks
// the same sketch degrades to a passthrough instead of failing.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

#ifndef _WIN32
#include <unistd.h>
#endif

#include "bridge/module_dirs.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

#include "wasm_paths.h"

using nano_modules::BundleSource;
using nano_modules::Origin;
using nano_modules::resolveBundles;

namespace {

/// A fresh directory under the system temp dir, removed (shallowly) on scope exit.
struct TempDir {
  std::string path;
  std::vector<std::string> files;
  explicit TempDir(const char* tag) {
    const char* base = getenv("TMPDIR");
#ifdef _WIN32
    if (!base) base = getenv("TEMP");
#endif
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    path = nano_paths::joinPath(base ? base : "/tmp",
                                std::string("nano-moddirs-") + tag + "-" + std::to_string(stamp));
    nano_paths::ensureDir(path);
  }
  std::string touch(const std::string& name, const std::string& bytes = "") {
    const std::string p = nano_paths::joinPath(path, name);
    std::ofstream(p, std::ios::binary) << bytes;
    files.push_back(p);
    return p;
  }
  std::string copyFrom(const std::string& src, const std::string& name) {
    std::ifstream in(src, std::ios::binary);
    std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    return touch(name, bytes);
  }
  void clear() {
    for (const auto& f : files) std::remove(f.c_str());
    files.clear();
  }
  ~TempDir() {
    clear();
#ifdef _WIN32
    _rmdir(path.c_str());
#else
    ::rmdir(path.c_str());
#endif
  }
};

const BundleSource* byStem(const std::vector<BundleSource>& v, const std::string& stem) {
  for (const auto& b : v) if (b.stem == stem) return &b;
  return nullptr;
}

std::vector<std::string> stems(const std::vector<BundleSource>& v) {
  std::vector<std::string> out;
  for (const auto& b : v) out.push_back(b.stem);
  return out;
}

}  // namespace

TEST_CASE("the built-in directory contributes only the known shipping bundles", "[module_dirs]") {
  TempDir builtin("builtin");
  builtin.touch("core.wasm");
  builtin.touch("text.wasm");
  // A dev tree's build/wasm also holds service modules and test fixtures;
  // none of them is an effect bundle.
  builtin.touch("executor.wasm");
  builtin.touch("naga_spv.wasm");
  builtin.touch("testonly.wasm");
  builtin.touch("core-aarch64.aot");

  const auto got = resolveBundles(builtin.path, "", {});
  CHECK(stems(got) == std::vector<std::string>{"core", "text"});
  CHECK(got[0].origin == Origin::Builtin);
}

TEST_CASE("the default directory fills in bundles the app does not carry, and only those",
          "[module_dirs]") {
  TempDir builtin("builtin");
  builtin.touch("core.wasm");
  builtin.touch("nano.wasm");  // a dev tree: a FRESH nano
  TempDir defaults("default");
  defaults.touch("nano.wasm");    // a seeded copy from an installed release
  defaults.touch("lights.wasm");
  defaults.touch("readme.txt");

  const auto got = resolveBundles(builtin.path, defaults.path, {});
  CHECK(stems(got) == std::vector<std::string>{"core", "nano", "lights"});
  // The seeded nano must never shadow the dev tree's build of it.
  REQUIRE(byStem(got, "nano"));
  CHECK(byStem(got, "nano")->origin == Origin::Builtin);
  CHECK(byStem(got, "lights")->origin == Origin::Default);
}

TEST_CASE("a mapped directory replaces a bundle by stem, and the later mapping wins",
          "[module_dirs]") {
  TempDir builtin("builtin");
  builtin.touch("core.wasm");
  TempDir defaults("default");
  defaults.touch("lights.wasm");
  TempDir devA("devA");
  devA.touch("core.wasm");     // a developer's working copy of core
  devA.touch("mine.wasm");
  TempDir devB("devB");
  devB.touch("mine.wasm");

  const auto got = resolveBundles(builtin.path, defaults.path, {devA.path, devB.path});
  // One entry per stem; built-ins keep their slot in the load order.
  CHECK(stems(got) == std::vector<std::string>{"core", "lights", "mine"});
  CHECK(byStem(got, "core")->dir == devA.path);
  CHECK(byStem(got, "core")->origin == Origin::Mapped);
  CHECK(byStem(got, "mine")->dir == devB.path);
}

TEST_CASE("module_paths.json: enabled directories in order, and junk is 'none mapped'",
          "[module_dirs]") {
  TempDir d("cfg");
  const std::string good = d.touch("good.json", R"({"paths":[
      {"path":"/a","enabled":true},{"path":"/b","enabled":false},{"path":"/c"}]})");
  CHECK(nano_modules::readMappedDirs(good) == std::vector<std::string>{"/a", "/c"});
  CHECK(nano_modules::readMappedDirs(d.touch("bad.json", "{not json")).empty());
  CHECK(nano_modules::readMappedDirs(nano_paths::joinPath(d.path, "missing.json")).empty());
}

#ifdef NANO_WASM_PATH
TEST_CASE("a bundle in a mapped directory loads and renders; without it the effect passes through",
          "[module_dirs][gpu]") {
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");

  const std::string sketch = R"JSON({
    "chain": [ { "type": "module", "module_type": "motion.peak_decay", "instance_key": "k0" } ],
    "instances": { "k0": { "module_type": "motion.peak_decay", "state": {} } },
    "wires": []
  })JSON";

  TempDir mapped("mapped");
  mapped.copyFrom(kNanoWasm, "nano.wasm");
  const auto sources = resolveBundles("", "", {mapped.path});
  REQUIRE(sources.size() == 1);
  CHECK(sources[0].stem == "nano");

  {
    sketch_executor::WasmEffectBundles bundles;
    REQUIRE(bundles.init());
    effect_runtime::EffectRuntime rt(backend.get());
    sketch_executor::ModuleRegistry registry(&rt);
    CHECK(bundles.loadBundleFile(sources[0].path, registry, backend.get(), nullptr) > 1);
    CHECK(registry.find("motion.peak_decay") != nullptr);
  }

  // The directory is unmapped: the same sketch must still execute, the missing
  // effect passing its input straight through.
  mapped.clear();
  CHECK(resolveBundles("", "", {mapped.path}).empty());

  effect_runtime::EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  CHECK(registry.find("motion.peak_decay") == nullptr);

  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 90);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  sketch_executor::SketchExecutor ex(&rt, &registry, backend.get());
  auto j = nlohmann::json::parse(sketch);
  int32_t h = ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  const auto out = backend->readbackTexture(h > 0 ? h : inTex, W, H);
  REQUIRE(out.size() == W * H * 4);
  CHECK((int)out[0] == 90);
  CHECK((int)out[1] == 90);
  CHECK((int)out[2] == 90);
}
#endif

// Driven by native/sdk/test_sdk_template.sh, which builds the SDK template
// OUTSIDE the repo and points NANO_TEMPLATE_WASM at the result. Hidden ([.]):
// without that build there is nothing to load.
TEST_CASE("the SDK template, built outside the repo, loads from a mapped folder and tints",
          "[.sdk_template]") {
  const char* built = getenv("NANO_TEMPLATE_WASM");
  if (!built || !*built) FAIL("NANO_TEMPLATE_WASM is not set");
  auto backend = gpu::createBackend();
  if (!backend) SKIP("No GPU device available");

  const std::string dir = nano_paths::parentDir(built);
  const auto sources = resolveBundles("", "", {dir});
  REQUIRE(sources.size() == 1);
  CHECK(sources[0].origin == Origin::Mapped);

  sketch_executor::WasmEffectBundles bundles;
  REQUIRE(bundles.init());
  effect_runtime::EffectRuntime rt(backend.get());
  sketch_executor::ModuleRegistry registry(&rt);
  REQUIRE(bundles.loadBundleFile(sources[0].path, registry, backend.get(), nullptr) == 1);
  REQUIRE(registry.find("example.color.tint") != nullptr);

  // Pure red at full amount over mid grey: red survives, green and blue go.
  const std::string sketch = R"JSON({
    "chain": [ { "type": "module", "module_type": "example.color.tint", "instance_key": "k0" } ],
    "instances": { "k0": { "module_type": "example.color.tint",
                           "state": { "color": [1.0, 0.0, 0.0], "amount": 1.0 } } },
    "wires": []
  })JSON";
  const uint32_t W = 16, H = 16, RGBA8 = 1;
  int inTex = backend->createTexture(W, H, RGBA8);
  int outTex = backend->createTexture(W, H, RGBA8);
  std::vector<uint8_t> inPix(W * H * 4, 128);
  for (size_t i = 3; i < inPix.size(); i += 4) inPix[i] = 255;
  backend->writeTexture(inTex, W, H, inPix.data(), (uint32_t)inPix.size());

  sketch_executor::SketchExecutor ex(&rt, &registry, backend.get());
  auto j = nlohmann::json::parse(sketch);
  int32_t h = ex.execute(j, inTex, outTex, (int)W, (int)H, 1.0 / 60.0, true);
  backend->submit();
  REQUIRE(h > 0);
  const auto out = backend->readbackTexture(h, W, H);
  REQUIRE(out.size() == W * H * 4);
  const size_t mid = ((H / 2) * W + W / 2) * 4;
  INFO("rgb " << (int)out[mid] << "," << (int)out[mid + 1] << "," << (int)out[mid + 2]);
  CHECK(std::abs((int)out[mid] - 128) <= 2);
  CHECK((int)out[mid + 1] <= 2);
  CHECK((int)out[mid + 2] <= 2);
}
