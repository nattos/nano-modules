// native_test_runner.mm — config-driven Metal test runner.
//
// Reads a JSON config on stdin, runs the requested effect through the
// no-WASM effect_runtime + Metal GPUBackend, writes a JSON result on
// stdout (matching the shape produced by web/public/gpu-test-runner.html).
//
// Used by the dual-backend test runner — the JS side spawns this binary
// and feeds it the same config it'd hand to the puppeteer runner. The
// result is wrapped in the existing `Frame` class so test assertions
// work unchanged.
//
// Config (JSON in):
//   {
//     "module": "soft_glow.wasm",   // or an effect ID
//     "bundle": "lights",            // ignored for now (single bundled effect set)
//     "width": 128, "height": 128,
//     "params": [["intensity", 1.0], ["hue_shift", -0.13]],
//     "ticks": 0,
//     "inputColor": [0, 0, 0, 1],
//     "samplePoints": [[64, 64]]
//   }
//
// Result (JSON out):
//   { success, width, height, pixelCount, pixelsBase64, samples,
//     consoleLog, gpuErrors, metadata, params }

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"

// Effect registration is generated from effects_native/barrel_manifest.txt
// (gen_barrel_effects.py): namespace forward-decls + MSL + the
// registerAllBarrelEffects(rt, registry) entry point. Using it here means the
// runner can render ANY effect the barrel exposes, by id — same set, same
// registration path as the plugin.
#include "barrel_effects.gen.h"

namespace effect_runtime {
// Setters defined in host_impls.cpp.
void setHostTime(double t);
void setHostDeltaTime(double dt);
void setHostBarPhase(double p);
void setHostBpm(double bpm);
void setHostViewport(int w, int h);
}

namespace {

// "module" filenames map to registered effect ids. Mirrors the
// EFFECT_ID_BY_FILENAME table in web/public/gpu-test-runner.html so
// the JS side can pass the same config to both backends.
std::string resolveEffectId(const std::string& moduleName) {
  if (moduleName == "soft_glow.wasm" || moduleName == "soft_glow")
    return "gen.soft_glow";
  if (moduleName == "motion_blur.wasm" || moduleName == "motion_blur")
    return "video.motion_blur";
  return moduleName;
}

// Read stdin to end-of-stream.
std::string readAllStdin() {
  std::ostringstream oss;
  oss << std::cin.rdbuf();
  return oss.str();
}

// Base64 encode bytes for JSON return.
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

}  // namespace

int main(int argc, char** argv) {
  (void)argc; (void)argv;

  std::string in = readAllStdin();
  nlohmann::json cfg;
  try {
    cfg = nlohmann::json::parse(in);
  } catch (const std::exception& e) {
    nlohmann::json err{{"success", false},
                        {"error", std::string("config parse: ") + e.what()}};
    std::cout << err.dump() << std::endl;
    return 1;
  }

  int W = cfg.value("width", 64);
  int H = cfg.value("height", 64);

  @autoreleasepool {
    auto gpu = gpu::createMetalBackend();
    if (!gpu) {
      nlohmann::json err{{"success", false},
                          {"error", "failed to create Metal backend"}};
      std::cout << err.dump() << std::endl;
      return 1;
    }

    // Allocate two RGBA8 textures — input (filled with inputColor if
    // requested) and output (the effect's tex_out).
    int inputTex  = gpu->createTexture((uint32_t)W, (uint32_t)H, /*RGBA8*/ 1);
    int outputTex = gpu->createTexture((uint32_t)W, (uint32_t)H, /*RGBA8*/ 1);
    if (inputTex < 0 || outputTex < 0) {
      nlohmann::json err{{"success", false},
                          {"error", "failed to create textures"}};
      std::cout << err.dump() << std::endl;
      return 1;
    }
    gpu->setSurface(outputTex, (uint32_t)W, (uint32_t)H);

    // Fill input texture with inputColor if requested.
    if (cfg.contains("inputColor") && cfg["inputColor"].is_array() &&
        cfg["inputColor"].size() >= 3) {
      auto c = cfg["inputColor"];
      float r = c[0].get<float>();
      float g = c[1].get<float>();
      float b = c[2].get<float>();
      float a = c.size() >= 4 ? c[3].get<float>() : 1.0f;
      std::vector<uint8_t> fill(W * H * 4);
      for (int i = 0; i < W * H; ++i) {
        fill[i * 4 + 0] = (uint8_t)std::round(r * 255.0f);
        fill[i * 4 + 1] = (uint8_t)std::round(g * 255.0f);
        fill[i * 4 + 2] = (uint8_t)std::round(b * 255.0f);
        fill[i * 4 + 3] = (uint8_t)std::round(a * 255.0f);
      }
      gpu->writeTexture(inputTex, (uint32_t)W, (uint32_t)H,
                        fill.data(), (uint32_t)fill.size());
    } else if (cfg.value("inputStep", false)) {
      // Left half black, right half white — a vertical step edge. Useful
      // for confirming spatial filters (blur softens the boundary column;
      // a passthrough leaves it a hard 0→255 step).
      std::vector<uint8_t> fill(W * H * 4, 0);
      for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) {
          uint8_t v = (x >= W / 2) ? 255 : 0;
          size_t o = ((size_t)y * W + x) * 4;
          fill[o] = fill[o + 1] = fill[o + 2] = v; fill[o + 3] = 255;
        }
      gpu->writeTexture(inputTex, (uint32_t)W, (uint32_t)H,
                        fill.data(), (uint32_t)fill.size());
    }

    effect_runtime::EffectRuntime rt(gpu.get());
    sketch_executor::ModuleRegistry registry(&rt);
    // Registers every effect in barrel_manifest.txt (same set + path as the
    // NanoBarrel plugin), so the runner can render any of them by id.
    nano_barrel_gen::registerAllBarrelEffects(rt, registry);

    std::string moduleName = cfg.value("module", std::string("soft_glow.wasm"));
    std::string effectId = resolveEffectId(moduleName);
    // Create the per-key render instance (runs create() + init(self)); the
    // type was registered + module_init'd above.
    auto* inst = rt.instanceFor(effectId, "test");
    if (!inst) {
      nlohmann::json err{{"success", false},
                          {"error", "unknown effect id: " + effectId}};
      std::cout << err.dump() << std::endl;
      return 1;
    }

    // Wire input + output texture fields so the effect's
    // gpu::Device::textureForField("tex_in") / "tex_out" resolve.
    inst->setTextureField("tex_in", inputTex);
    inst->setTextureField("tex_out", outputTex);

    // Apply param patches.
    if (cfg.contains("params") && cfg["params"].is_array()) {
      for (const auto& entry : cfg["params"]) {
        if (!entry.is_array() || entry.size() < 2) continue;
        // Entry is [pathOrIndex, value]. Native runtime only supports
        // string paths (no legacy index lookup).
        if (!entry[0].is_string()) {
          std::cerr << "[native_test_runner] warning: integer param "
                    << "indices not supported, use names\n";
          continue;
        }
        std::string path = entry[0].get<std::string>();
        const auto& value = entry[1];
        if (value.is_number()) {
          inst->setParamFloat(path, value.get<float>());
        } else if (value.is_array()) {
          std::vector<float> comps;
          for (const auto& v : value) comps.push_back(v.get<float>());
          inst->setParamArray(path, comps);
        } else {
          inst->setParamJson(path, value.dump());
        }
      }
    }

    // Tick + render lifecycle.
    int tickCount = cfg.value("ticks", 0);
    effect_runtime::setHostViewport(W, H);
    effect_runtime::setHostBpm(120.0);
    // One render per tick — a real frame is tick + render. Effects whose
    // simulation runs GPU-side inside render() (e.g. flash_particles'
    // particle update compute) need render() called every frame, not once.
    for (int i = 0; i < tickCount; ++i) {
      double t = (i + 1) * 0.016;
      effect_runtime::setHostTime(t);
      effect_runtime::setHostDeltaTime(0.016);
      effect_runtime::setHostBarPhase(std::fmod(t * 120.0 / 60.0 / 4.0, 1.0));
      inst->doTick(0.016);
      inst->doRender(W, H);
    }
    if (tickCount == 0) inst->doRender(W, H);

    // Submit + read back. Many effects call gpu::Device::submit() at
    // the end of render(), but if a future effect doesn't, ensure we
    // flush before readback.
    gpu->submit();

    auto pixels = gpu->readbackTexture(outputTex, (uint32_t)W, (uint32_t)H);

    // Sample requested points; default to center + 4 corners.
    std::vector<std::array<int, 2>> points;
    if (cfg.contains("samplePoints") && cfg["samplePoints"].is_array() &&
        !cfg["samplePoints"].empty()) {
      for (const auto& p : cfg["samplePoints"])
        points.push_back({p[0].get<int>(), p[1].get<int>()});
    } else {
      points = {{W/2, H/2}, {0, 0}, {W-1, 0}, {0, H-1}, {W-1, H-1}};
    }

    nlohmann::json samples = nlohmann::json::array();
    for (auto& pt : points) {
      int x = std::clamp(pt[0], 0, W - 1);
      int y = std::clamp(pt[1], 0, H - 1);
      size_t o = (size_t)(y * W + x) * 4;
      samples.push_back({
        {"x", x}, {"y", y},
        {"r", pixels[o]}, {"g", pixels[o+1]},
        {"b", pixels[o+2]}, {"a", pixels[o+3]},
      });
    }

    nlohmann::json result{
      {"success", true},
      {"width", W}, {"height", H},
      {"pixelCount", pixels.size() / 4},
      {"pixelsBase64", base64Encode(pixels)},
      {"samples", samples},
      {"consoleLog", rt.drainConsoleLog()},
      {"gpuErrors", nlohmann::json::array()},
      {"pluginState", nlohmann::json::object()},
      // Metadata + schema are published by module_init() onto the type
      // prototype, not the per-key render instance — read it from there.
      {"metadata", [&] {
        auto* proto = rt.find(effectId);
        return nlohmann::json{
          {"id",      proto ? proto->metadataId()      : std::string()},
          {"version", proto ? proto->metadataVersion() : std::string()},
        };
      }()},
      {"params", nlohmann::json::array()},
    };
    std::cout << result.dump() << std::endl;
    return 0;
  }
}
