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

// Per-effect registration helpers — each effect registers itself with
// the runtime via a small entry function defined alongside its
// `main.cpp`. For now soft_glow is the only one wired up.
namespace soft_glow {
  // The descriptor exported by soft_glow's main.cpp.
  extern void init();
  extern void tick(double dt);
  extern void render(int vp_w, int vp_h);
  extern void on_state_patched(int n, const char* pb, const int* off,
                                const int* len, const int* ops);
}

#include "soft_glow_msl.h"

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
  return moduleName;
}

// Register all known native-built effects with the runtime. Each
// effect gets one EffectInstance.
void registerAllEffects(effect_runtime::EffectRuntime& rt) {
  effect_runtime::EffectDesc d;
  d.id = "gen.soft_glow";
  d.name = "Soft Glow";
  d.init = &soft_glow::init;
  d.tick = &soft_glow::tick;
  d.render = &soft_glow::render;
  d.on_state_patched = &soft_glow::on_state_patched;
  rt.registerEffect(d);

  // Pre-register MSL strings so state::registerShaderSPV("...") on the
  // effect side resolves the shader name to a Metal-compilable source.
  rt.registerShaderMSL("soft_glow_color", SOFT_GLOW_COLOR_MSL);
  rt.registerShaderMSL("soft_glow_motion", SOFT_GLOW_MOTION_MSL);
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
    }

    effect_runtime::EffectRuntime rt(gpu.get());
    registerAllEffects(rt);

    std::string moduleName = cfg.value("module", std::string("soft_glow.wasm"));
    std::string effectId = resolveEffectId(moduleName);
    auto* inst = rt.find(effectId);
    if (!inst) {
      nlohmann::json err{{"success", false},
                          {"error", "unknown effect id: " + effectId}};
      std::cout << err.dump() << std::endl;
      return 1;
    }

    // Drive init — effect registers its schema, allocates GPU resources.
    inst->doInit();

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
    for (int i = 0; i < tickCount; ++i) {
      double t = (i + 1) * 0.016;
      effect_runtime::setHostTime(t);
      effect_runtime::setHostDeltaTime(0.016);
      effect_runtime::setHostBarPhase(std::fmod(t * 120.0 / 60.0 / 4.0, 1.0));
      inst->doTick(0.016);
    }
    inst->doRender(W, H);

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
      {"metadata", {
        {"id", inst->metadataId()},
        {"version", inst->metadataVersion()},
      }},
      {"params", nlohmann::json::array()},
    };
    std::cout << result.dump() << std::endl;
    return 0;
  }
}
