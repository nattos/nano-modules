// comp_test_runner.mm — config-driven Metal runner for the COMPOSITION executor.
//
// The comp-mode sibling of native_test_runner.mm: reads a `CompScenario` JSON on
// stdin, drives a real `comp::CompExecutor` over a Metal backend with the
// shipping WASM effect bundles, and writes a `CompRunResult` JSON on stdout.
//
// The web twin (web/src/comp-test-runner.ts) implements the SAME contract over
// `ArrEngine` (paused + seek-stepped), so one jest body can run both backends
// through `forEachBackend` — the way per-effect GPU tests already do.
//
// Scenario (JSON in):
//   {
//     "doc": { ...Composition... },       // or "docFile": "<path>"
//     "width": 64, "height": 64,
//     "precise": false,                   // transport mode (default: fluid)
//     "ops": [
//       { "seek": 4.0 },
//       { "play": { "frames": 30, "dtSec": 0.016666 } },
//       { "launch": { "trackId": "st", "sceneId": "s1", "mode": "loose" } },
//       { "setParam": { "ownerId": "c1", "deviceId": "d1",
//                       "field": "brightness", "value": 0.5 } },
//       { "trackLevel": { "trackId": "t1", "level": 0.5 } },
//       { "bypass": { "id": "t1", "on": true } },   // doc edit + reload
//       { "capture": "after-seek" }
//     ]
//   }
//
// Result (JSON out):
//   { success, width, height,
//     captures: { name: { pixelsBase64, width, height, samples,
//                         hasContent, holding, positionBeat, layerCount,
//                         chainKeys, railValues } },
//     error? }
//
// `play` is FIXED-STEP by construction — every frame advances by exactly
// `dtSec`, never by wall clock — which is what makes a web/native pixel or rail
// comparison meaningful at all.

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "runtime/text_host.h"
#include "sketch/comp/comp_executor.h"
#include "sketch/module_registry.h"
#include "sketch/sketch_executor.h"
#include "sketch/wasm_bundles.h"

#ifndef NANO_WASM_DIR
#error "NANO_WASM_DIR must be defined"
#endif

namespace effect_runtime {
// Setters defined in host_impls.cpp.
void setHostTime(double t);
void setHostDeltaTime(double dt);
void setHostBarPhase(double p);
void setHostBpm(double bpm);
void setHostViewport(int w, int h);
}

using json = nlohmann::json;

namespace {

std::string readAllStdin() {
  std::ostringstream oss;
  oss << std::cin.rdbuf();
  return oss.str();
}

// Base64 for the pixel payload — byte-identical framing to native_test_runner
// so the shared TS `Frame` decoder works unchanged.
std::string base64Encode(const std::vector<uint8_t>& bytes) {
  static const char kAlphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((bytes.size() + 2) / 3) * 4);
  size_t i = 0;
  for (; i + 3 <= bytes.size(); i += 3) {
    uint32_t v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push_back(kAlphabet[(v >> 18) & 0x3F]);
    out.push_back(kAlphabet[(v >> 12) & 0x3F]);
    out.push_back(kAlphabet[(v >> 6) & 0x3F]);
    out.push_back(kAlphabet[v & 0x3F]);
  }
  if (i < bytes.size()) {
    uint32_t v = bytes[i] << 16;
    if (i + 1 < bytes.size()) v |= bytes[i + 1] << 8;
    out.push_back(kAlphabet[(v >> 18) & 0x3F]);
    out.push_back(kAlphabet[(v >> 12) & 0x3F]);
    if (i + 1 < bytes.size()) {
      out.push_back(kAlphabet[(v >> 6) & 0x3F]);
      out.push_back('=');
    } else {
      out.push_back('=');
      out.push_back('=');
    }
  }
  return out;
}

void fail(const std::string& msg) {
  std::cout << json{{"success", false}, {"error", msg}}.dump() << std::endl;
}

/**
 * Recursively set `bypassed` on the clip or track whose id matches — the
 * "structural edit" op. There is no cheap-op path for bypass (the web store
 * mutates the document and the bridge re-mirrors it), so both runners do the
 * same thing: edit the doc JSON, reload it.
 */
bool setBypassedById(json& node, const std::string& id, bool on) {
  if (node.is_array()) {
    for (auto& child : node) {
      if (setBypassedById(child, id, on)) return true;
    }
    return false;
  }
  if (!node.is_object()) return false;
  if (node.contains("id") && node["id"].is_string() && node["id"] == id) {
    node["bypassed"] = on;
    return true;
  }
  for (auto& [key, child] : node.items()) {
    (void)key;
    if ((child.is_object() || child.is_array()) && setBypassedById(child, id, on)) return true;
  }
  return false;
}

/** Every distinct instance key in the chain-keys readback — the native
 *  analogue of the web bridge's `layerCount()`. */
int layerCountFrom(const std::string& chainKeysJson) {
  auto j = json::parse(chainKeysJson, nullptr, false);
  if (j.is_discarded() || !j.is_array()) return 0;
  int n = 0;
  for (const auto& k : j) {
    // One `_blend` key is emitted per composited layer (clip_<id>_blend).
    if (k.is_string() && k.get<std::string>().find("_blend") != std::string::npos) n++;
  }
  return n;
}

}  // namespace

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;

  json cfg;
  try {
    cfg = json::parse(readAllStdin());
  } catch (const std::exception& e) {
    fail(std::string("scenario parse: ") + e.what());
    return 1;
  }

  const int W = cfg.value("width", 64);
  const int H = cfg.value("height", 64);

  json doc;
  if (cfg.contains("docFile") && cfg["docFile"].is_string()) {
    const std::string path = cfg["docFile"].get<std::string>();
    std::ifstream f(path);
    if (!f.good()) {
      fail("docFile not readable: " + path);
      return 1;
    }
    try {
      f >> doc;
    } catch (const std::exception& e) {
      fail(std::string("docFile parse: ") + e.what());
      return 1;
    }
  } else if (cfg.contains("doc")) {
    doc = cfg["doc"];
  } else {
    fail("scenario needs `doc` or `docFile`");
    return 1;
  }

  @autoreleasepool {
    auto backend = gpu::createMetalBackend();
    if (!backend || backend->getBackend() != 0) {
      fail("failed to create Metal backend");
      return 1;
    }

    // DECLARATION ORDER IS LOAD-BEARING — these tear down in reverse, and the
    // registry's WASM-backed module entries must die before the WasmHost that
    // owns their instances (destroying `bundles` first faults in WAMR at exit,
    // after a perfectly good result has already been printed). Mirrors the
    // member order of test_comp_render.cpp's Harness.
    sketch_executor::WasmEffectBundles bundles;
    effect_runtime::EffectRuntime rt(backend.get());
    sketch_executor::ModuleRegistry registry(&rt);
    // Text effects reach the host TextEngine via the text.* service — install
    // the bundled fonts before any render, exactly as native_test_runner does.
    effect_runtime::textInstallDefaultFonts(nullptr);

    // Effects always load from their WASM bundles (never statically linked), so
    // the comp path walks the same artifacts the barrel and web load.
    const int loaded =
        bundles.init()
            ? bundles.loadBundleFile(NANO_WASM_DIR "/core.wasm", registry, backend.get(), nullptr) +
              bundles.loadBundleFile(NANO_WASM_DIR "/lights.wasm", registry, backend.get(), nullptr) +
              bundles.loadBundleFile(NANO_WASM_DIR "/nano.wasm", registry, backend.get(), nullptr) +
              bundles.loadBundleFile(NANO_WASM_DIR "/text.wasm", registry, backend.get(), nullptr) +
              bundles.loadBundleFile(NANO_WASM_DIR "/richtext.wasm", registry, backend.get(), nullptr) +
              bundles.loadBundleFile(NANO_WASM_DIR "/legacy.wasm", registry, backend.get(), nullptr)
            : 0;
    if (loaded < 1) {
      fail(std::string("failed to load effect bundles from ") + NANO_WASM_DIR);
      return 1;
    }

    comp::CompExecutor cx(&rt, &registry, backend.get());
    // Seed the catalog from the loaded registry — the native analogue of the
    // web worker's comp_register_schema per discovered plugin. Every referenced
    // module type must be known before the first update() or it degrades to a
    // stand-in.
    for (const auto& [moduleType, fields] : registry.schemas()) {
      cx.registerSchema(moduleType, fields);
      const auto* reg = registry.find(moduleType);
      json caps = json::array();
      if (reg) {
        for (const auto& t : reg->capabilities) caps.push_back(t);
      }
      cx.registerCapabilities(moduleType, caps);
    }

    cx.loadDocument(doc);
    cx.pause();
    // Fluid by default: with no decode pump on this side there is nothing to
    // feed the Precise gate, and a held transport would freeze the beat.
    cx.setTransportMode(cfg.value("precise", false));
    if (cfg.contains("ignoreSolo")) cx.setIgnoreSolo(cfg["ignoreSolo"].get<bool>());

    effect_runtime::setHostViewport(W, H);
    effect_runtime::setHostBpm(cx.bpm());

    const int32_t inTex = backend->createTexture((uint32_t)W, (uint32_t)H, /*RGBA8*/ 1);
    const int32_t outTex = backend->createTexture((uint32_t)W, (uint32_t)H, /*RGBA8*/ 1);
    if (inTex < 0 || outTex < 0) {
      fail("failed to create textures");
      return 1;
    }
    backend->setSurface(outTex, (uint32_t)W, (uint32_t)H);

    double hostTime = 0.0;
    uint32_t lastFlags = 0;
    std::string lastChainKeys = "[]";

    // One comp frame: update → transportResolve → render. The order is the
    // host contract (see comp_executor.h) — transportResolve must sit between
    // the two so plugin timing lands same-frame.
    auto stepFrame = [&](double dt) -> int32_t {
      hostTime += dt;
      effect_runtime::setHostTime(hostTime);
      effect_runtime::setHostDeltaTime(dt);
      lastFlags = cx.update(dt);
      cx.transportResolve(dt);
      const int32_t handle = cx.render(inTex, outTex, W, H, dt);
      if (lastFlags & comp::kCompStructureChanged) lastChainKeys = cx.chainKeysJson();
      return handle;
    };

    json captures = json::object();
    json err;

    try {
      for (const auto& op : cfg.value("ops", json::array())) {
        if (!op.is_object()) continue;

        if (op.contains("seek")) {
          cx.seekBeat(op["seek"].get<double>());
          stepFrame(0.0);

        } else if (op.contains("play")) {
          const auto& p = op["play"];
          const int frames = p.value("frames", 1);
          const double dt = p.value("dtSec", 1.0 / 60.0);
          cx.play();
          for (int i = 0; i < frames; i++) stepFrame(dt);
          cx.pause();

        } else if (op.contains("launch")) {
          const auto& l = op["launch"];
          const int cls = l.value("mode", std::string("instant")) == "loose"
                              ? comp::CompExecutor::kLaunchLoose
                              : comp::CompExecutor::kLaunchInstant;
          cx.launchScene(l.value("trackId", std::string()), l.value("sceneId", std::string()), cls);
          stepFrame(0.0);

        } else if (op.contains("stopScene")) {
          cx.stopScene(op["stopScene"].value("trackId", std::string()));
          stepFrame(0.0);

        } else if (op.contains("setParam")) {
          const auto& s = op["setParam"];
          cx.setDeviceParam(s.value("ownerId", std::string()), s.value("deviceId", std::string()),
                            s.value("field", std::string()), s.value("value", json()));
          stepFrame(0.0);

        } else if (op.contains("trackLevel")) {
          const auto& s = op["trackLevel"];
          cx.setTrackLevel(s.value("trackId", std::string()), s.value("level", 1.0));
          stepFrame(0.0);

        } else if (op.contains("bypass")) {
          const auto& b = op["bypass"];
          if (!setBypassedById(doc, b.value("id", std::string()), b.value("on", true))) {
            throw std::runtime_error("bypass: no clip/track with id " + b.value("id", std::string()));
          }
          // A structural edit is a document reload on both sides — the transport
          // position survives it (loadDocument doesn't reset the playhead).
          const double beat = cx.positionBeat();
          cx.loadDocument(doc);
          cx.seekBeat(beat);
          stepFrame(0.0);

        } else if (op.contains("capture")) {
          const std::string name = op["capture"].get<std::string>();
          const int32_t handle = stepFrame(0.0);
          backend->submit();
          const auto pixels =
              backend->readbackTexture(handle >= 0 ? handle : outTex, (uint32_t)W, (uint32_t)H);

          json samples = json::array();
          const std::vector<std::array<int, 2>> points = {
              {W / 2, H / 2}, {0, 0}, {W - 1, 0}, {0, H - 1}, {W - 1, H - 1}};
          for (const auto& pt : points) {
            const size_t o = ((size_t)pt[1] * W + pt[0]) * 4;
            if (o + 3 < pixels.size()) {
              samples.push_back({{"x", pt[0]},
                                 {"y", pt[1]},
                                 {"r", pixels[o]},
                                 {"g", pixels[o + 1]},
                                 {"b", pixels[o + 2]},
                                 {"a", pixels[o + 3]}});
            }
          }

          captures[name] = {
              {"pixelsBase64", base64Encode(pixels)},
              {"width", W},
              {"height", H},
              {"samples", samples},
              {"hasContent", (lastFlags & comp::kCompHasContent) != 0},
              {"holding", (lastFlags & comp::kCompHoldingPrecise) != 0},
              {"positionBeat", cx.positionBeat()},
              {"positionSec", cx.positionSec()},
              {"layerCount", layerCountFrom(lastChainKeys)},
              {"chainKeys", json::parse(lastChainKeys, nullptr, false)},
              // {trackId: {sceneId, launchBeat}} — the launched-scene set.
              {"sceneStates", json::parse(cx.sceneStatesJson(), nullptr, false)},
              // trackId → incoming {sceneId, ...} while a handover is deferred.
              {"pendingScenes", json::parse(cx.pendingScenesJson(), nullptr, false)},
          };
        }
      }
    } catch (const std::exception& e) {
      err = std::string("op failed: ") + e.what();
    }

    json out{{"success", err.is_null()},
             {"width", W},
             {"height", H},
             {"captures", captures}};
    if (!err.is_null()) out["error"] = err;
    std::cout << out.dump() << std::endl;
    return err.is_null() ? 0 : 1;
  }
}
