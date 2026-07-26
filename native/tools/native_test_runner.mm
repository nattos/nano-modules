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
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"
#include "runtime/text_host.h"
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

namespace {

// Tests reference effects by their real `module_type` id (the string the
// effect declares in state::init) — the same on both backends. No legacy
// `x.wasm` alias map; the id passes straight through.
std::string resolveEffectId(const std::string& moduleName) {
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

/**
 * The effect's own log messages, in the shape the web runner reports.
 *
 * EffectRuntime stores each entry as "<level>: <message>" (one string, so the
 * barrel can print it straight out), while the web host keeps ConsoleEntry
 * structured and gpu-test-runner.html surfaces `entry.message`. Tests assert
 * the raw message — `expect(frame.consoleLog).toContain('mrt_test:
 * initialized')` — so strip the level prefix here rather than change what the
 * barrel prints.
 */
nlohmann::json consoleLogJson(effect_runtime::EffectRuntime& rt) {
  nlohmann::json out = nlohmann::json::array();
  for (const auto& entry : rt.drainConsoleLog()) {
    static const char* kPrefixes[] = {"log: ", "warn: ", "error: "};
    std::string msg = entry;
    for (const char* p : kPrefixes) {
      const size_t n = std::strlen(p);
      if (msg.compare(0, n, p) == 0) { msg = msg.substr(n); break; }
    }
    out.push_back(msg);
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
    // Text effects (source.text.plain / source.text.rich) reach the host TextEngine via the
    // text.* service; install the bundled fonts before any render so glyphs
    // resolve (null primary → system UI font + CJK fallbacks). Host-side, exactly
    // as the barrel does — the text.wasm bridge routes the effects' imports here.
    effect_runtime::textInstallDefaultFonts(nullptr);

    // Load effects from their WASM bundles — the same artifacts the barrel + web
    // load, never statically linked. text/richtext resolve text.* through the
    // bridge registered by bundles.init(). `bundles` is declared here (outer
    // scope) so its WasmHost outlives the executor below.
    sketch_executor::WasmEffectBundles bundles;
    int loaded = bundles.init()
        ? bundles.loadBundleFile(NANO_WASM_DIR "/core.wasm",     registry, gpu.get(), nullptr)
        + bundles.loadBundleFile(NANO_WASM_DIR "/lights.wasm",   registry, gpu.get(), nullptr)
        + bundles.loadBundleFile(NANO_WASM_DIR "/nano.wasm",     registry, gpu.get(), nullptr)
        + bundles.loadBundleFile(NANO_WASM_DIR "/text.wasm",     registry, gpu.get(), nullptr)
        + bundles.loadBundleFile(NANO_WASM_DIR "/richtext.wasm", registry, gpu.get(), nullptr)
        + bundles.loadBundleFile(NANO_WASM_DIR "/legacy.wasm",   registry, gpu.get(), nullptr)
        // testonly holds the debug.* fixtures the fusion suites and a few chain
        // tests build on (fuse_add/fuse_mul/fuse_solid, spinningtris). It is the
        // helpers' DEFAULT bundle, so leaving it out meant any suite that didn't
        // name a bundle failed natively with "unknown effect id" — the one thing
        // that looks like a missing effect rather than a missing bundle.
        + bundles.loadBundleFile(NANO_WASM_DIR "/testonly.wasm", registry, gpu.get(), nullptr)
        : 0;
    if (loaded < 1) {
      std::fprintf(stderr, "failed to load effect bundles from %s\n", NANO_WASM_DIR);
      return 1;
    }

    // ----- Multi-effect CHAIN mode (exercises SketchExecutor + GPU fusion) ----
    // cfg.chain = [ {module, params:[[path,val],...]}, ... ]. Runs the whole
    // chain through the executor (the production fused/standalone path), reports
    // pixels + `fusedRuns` (how many fused-kernel dispatches actually issued) so
    // fusion tests can assert byte-identity AND that fusion really happened.
    if (cfg.contains("chain") && cfg["chain"].is_array()) {
      nlohmann::json chainArr = nlohmann::json::array();
      nlohmann::json instances = nlohmann::json::object();
      int ci = 0;
      for (const auto& entry : cfg["chain"]) {
        std::string mod = entry.value("module", entry.value("module_type", std::string()));
        std::string key = "c" + std::to_string(ci++);
        chainArr.push_back({{"module_type", resolveEffectId(mod)}, {"instance_key", key}});
        nlohmann::json st = nlohmann::json::object();
        if (entry.contains("params") && entry["params"].is_array()) {
          for (const auto& p : entry["params"]) {
            if (p.is_array() && p.size() >= 2 && p[0].is_string())
              st[p[0].get<std::string>()] = p[1];
          }
        }
        instances[key] = {{"state", st}};
      }
      nlohmann::json sketch = {
        {"columns", nlohmann::json::array({ {{"chain", chainArr}} })},
        {"instances", instances},
      };

      sketch_executor::SketchExecutor exec(&rt, &registry, gpu.get());
      const std::string fmode = cfg.value("fusionMode", std::string("auto"));
      if (fmode == "force-off") exec.setFusionEnabled(false);  // force-on/auto fuse

      effect_runtime::setHostViewport(W, H);
      effect_runtime::setHostBpm(120.0);
      int tickCount = std::max(1, cfg.value("ticks", 1));
      int32_t finalHandle = inputTex;
      for (int i = 0; i < tickCount; ++i) {
        double t = (i + 1) * 0.016;
        effect_runtime::setHostTime(t);
        effect_runtime::setHostDeltaTime(0.016);
        finalHandle = exec.execute(sketch, inputTex, outputTex, W, H, 0.016, /*dirty=*/true);
      }
      gpu->submit();
      auto pixels = gpu->readbackTexture(finalHandle >= 0 ? finalHandle : outputTex,
                                         (uint32_t)W, (uint32_t)H);

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
        int x = std::clamp(pt[0], 0, W - 1), y = std::clamp(pt[1], 0, H - 1);
        size_t o = (size_t)(y * W + x) * 4;
        samples.push_back({{"x", x}, {"y", y}, {"r", pixels[o]}, {"g", pixels[o+1]},
                           {"b", pixels[o+2]}, {"a", pixels[o+3]}});
      }
      nlohmann::json result{
        {"success", true}, {"width", W}, {"height", H},
        {"pixelCount", pixels.size() / 4}, {"pixelsBase64", base64Encode(pixels)},
        {"samples", samples}, {"fusedRuns", exec.fusedRunCount()},
        {"consoleLog", consoleLogJson(rt)}, {"gpuErrors", nlohmann::json::array()},
        {"pluginState", nlohmann::json::object()}, {"params", nlohmann::json::array()},
      };
      std::cout << result.dump() << std::endl;
      return 0;
    }

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
      // Fusion class the effect declared in init() (state::FusionKind:
      // 0=Freeform, 1=PerPixelMapper, 2=StrictOutput). Lets a test confirm
      // an effect still declares itself fusion-eligible before asserting it
      // actually fused in a chain. Mirrors the web runner's `fusionKind`.
      {"fusionKind", inst->fusionInfo().kind},
      {"consoleLog", consoleLogJson(rt)},
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
      // The legacy param-row view of the schema. LOCK-STEP with the web host's
      // derivation (wasm-host.ts, "Derive params and ioDecls from schema"):
      // same skip rules, same ordering, same numeric type codes — otherwise a
      // suite's `frame.params.map(p => p.name)` assertion passes on one backend
      // and fails on the other for no real reason.
      {"params", [&] {
        nlohmann::json params = nlohmann::json::array();
        auto* proto = rt.find(effectId);
        if (!proto) return params;
        // ORDERED parse, deliberately. Plain `nlohmann::json` is backed by
        // std::map, so iterating its fields yields them ALPHABETICALLY — while
        // the web host walks `Object.entries(schema)` in DECLARATION order.
        // That silently renumbered every param whose schema isn't declared
        // alphabetically (auto_level: web 0,1,2 = equalize/median_target/
        // median_pull, native = equalize/median_pull/median_target), so
        // `params[i].index` and `params[i].name` disagreed across backends.
        // Only assertions that sort or use `toContain` survived it.
        auto schema = nlohmann::ordered_json::parse(proto->schemaJson(), nullptr, false);
        if (schema.is_discarded() || !schema.is_object()) return params;
        // The schema payload wraps its fields (moduleVersion/capabilities sit
        // beside them); accept either shape.
        const nlohmann::ordered_json& fields =
            schema.contains("fields") && schema["fields"].is_object() ? schema["fields"] : schema;
        int paramIdx = 0;
        for (auto it = fields.begin(); it != fields.end(); ++it) {
          if (!it.value().is_object()) continue;
          const auto& field = it.value();
          const std::string type = field.value("type", std::string());
          // help = UI-only doc slot; texture = an io decl, not a param;
          // aggregates never had a legacy param row.
          if (type == "help" || type == "texture" || type == "object" || type == "array" ||
              type == "float2" || type == "float3" || type == "float4") {
            continue;
          }
          int typeCode = 10;  // Standard
          if (type == "bool") typeCode = 0;
          else if (type == "event") typeCode = 1;
          else if (type == "int") typeCode = 13;
          else if (type == "string") typeCode = 100;
          double defaultValue = 0;
          if (field.contains("default")) {
            const auto& d = field["default"];
            if (d.is_number()) defaultValue = d.get<double>();
            else if (d.is_boolean()) defaultValue = d.get<bool>() ? 1 : 0;
          }
          params.push_back({
              {"index", paramIdx++},
              {"name", it.key()},
              {"type", typeCode},
              {"defaultValue", defaultValue},
              // Always emitted: downstream widgets disable range mapping when
              // these are absent, and [0,1] is the safe default for unranged
              // fields (bools, events, strings).
              {"min", field.contains("min") && field["min"].is_number() ? field["min"].get<double>() : 0.0},
              {"max", field.contains("max") && field["max"].is_number() ? field["max"].get<double>() : 1.0},
          });
        }
        return params;
      }()},
    };
    std::cout << result.dump() << std::endl;
    return 0;
  }
}
