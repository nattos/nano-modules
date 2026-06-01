#include "sketch/sketch_executor.h"

#include "sketch/sketch_augment.h"
#include "gpu/gpu_backend.h"
#include "runtime/effect_runtime.h"

#include <utility>

namespace sketch_executor {

using nlohmann::json;

namespace {

/**
 * Visit each texture-leaf path in a rail's dataType. Texture rails
 * yield a single empty-string leaf; struct rails walk their schema's
 * nested texture fields and yield slash-joined sub-paths. Float and
 * other dataTypes yield nothing — texture flow only.
 */
template <class F>
void forEachRailLeafTexture(const json& dataType, F&& f) {
  if (dataType.is_string()) {
    if (dataType.get<std::string>() == "texture") f(std::string());
    return;
  }
  if (dataType.is_object() &&
      dataType.value("kind", std::string()) == "struct") {
    const auto& schema = dataType.value("schema", json());
    std::vector<std::string> leaves;
    sketch_augment::collectTextureLeaves(schema, "", leaves);
    for (auto& l : leaves) f(l);
  }
}

}  // namespace

SketchExecutor::SketchExecutor(effect_runtime::EffectRuntime* rt,
                               ModuleRegistry* registry,
                               gpu::GPUBackend* gpu)
  : rt_(rt), registry_(registry), gpu_(gpu) {
  (void)rt_;  // currently routed through registry / instances; retained
              // for future runtime-level hooks (drainConsoleLog etc.).
}

SketchExecutor::~SketchExecutor() {
  for (int32_t h : intermediates_) {
    if (h > 0 && gpu_) gpu_->release(h);
  }
}

int32_t SketchExecutor::execute(
    const json& rawSketch,
    int32_t inputHandle, int32_t outputHandle,
    int W, int H, double dt) {
  if (!rawSketch.is_object() || !registry_ || !gpu_) return inputHandle;

  // Augment with implicit struct-rail connections.
  auto schemas = registry_->schemas();
  json sketch =
      sketch_augment::augmentSketchWithImplicitConnections(rawSketch, schemas);

  auto columns = sketch.value("columns", json::array());
  if (!columns.is_array() || columns.empty()) return inputHandle;
  auto instances = sketch.value("instances", json::object());
  auto sketchRails = sketch.value("rails", json::array());

  intermediate_cursor_ = 0;
  int32_t finalHandle = inputHandle;
  bool anyDispatched = false;

  for (size_t colIdx = 0; colIdx < columns.size(); ++colIdx) {
    const auto& col = columns[colIdx];
    auto chain = col.value("chain", json::array());
    if (!chain.is_array() || chain.empty()) continue;

    // Build per-column rail-by-id index (column-local + sketch-wide).
    std::unordered_map<std::string, json> railsById;
    auto indexRails = [&](const json& rails) {
      if (!rails.is_array()) return;
      for (const auto& r : rails) {
        if (!r.is_object()) continue;
        std::string id = r.value("id", std::string());
        if (!id.empty()) railsById[id] = r;
      }
    };
    indexRails(col.value("rails", json::array()));
    indexRails(sketchRails);

    // Per-column rail value tables. Texture handles keyed by leafPath
    // (empty string for single-texture rails); float scalars keyed by
    // railId.
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>> railTextures;
    std::unordered_map<std::string, float> railFloats;

    int32_t colInput = inputHandle;

    // Filter the chain to entries we have a registered effect for.
    // Unknown module_types are skipped silently (passthrough).
    std::vector<size_t> resolvable;
    for (size_t i = 0; i < chain.size(); ++i) {
      const auto& entry = chain[i];
      std::string mt = entry.value("module_type", std::string());
      if (registry_->find(mt) != nullptr) resolvable.push_back(i);
    }
    if (resolvable.empty()) continue;

    const bool isLastCol = (colIdx == columns.size() - 1);
    for (size_t k = 0; k < resolvable.size(); ++k) {
      size_t i = resolvable[k];
      const auto& entry = chain[i];
      const std::string mt      = entry.value("module_type", std::string());
      const std::string instKey = entry.value("instance_key", std::string());

      const RegisteredModule* reg = registry_->find(mt);
      if (!reg) continue;
      auto* inst = reg->inst;

      const bool isLastInColumn = (k == resolvable.size() - 1);
      const bool isFinalStage   = isLastCol && isLastInColumn;

      int32_t outHandle = isFinalStage ? outputHandle : nextIntermediate(W, H);

      // -- Zero stale per-field state from the previous frame --
      // Without this, a tap that was routed last frame but not this
      // frame (eg implicit-augmentation superseded by an explicit
      // empty user rail) leaves a dangling texture handle pointing
      // at a still-live texture, so the effect silently sees stale
      // data. The connection markers reset for the same reason —
      // effects like soft_glow key their motion pass off
      // `isOutputConnected("render_outputs")`.
      for (const auto& path : reg->inputTexturePaths) {
        inst->setTextureField(path, 0);
        inst->setFieldConnected(path, false, false);
      }
      for (const auto& path : reg->outputTexturePaths) {
        inst->setFieldConnected(path, false, false);
      }

      // -- Apply persisted instance state from the sketch --
      if (instances.is_object() && instances.contains(instKey)) {
        const auto& instJson = instances[instKey];
        const auto& state = instJson.value("state", json::object());
        applyState(inst, state);
      }

      // -- Wire primary channels --
      inst->setTextureField("tex_in",  colInput);
      inst->setTextureField("tex_out", outHandle);
      inst->setFieldConnected("tex_in",  true,  false);
      inst->setFieldConnected("tex_out", false, true);

      // -- Tap routing before render --
      applyReadTaps(inst, entry, railsById, railTextures, railFloats);
      markWriteTapOutputsConnected(inst, entry);

      inst->doTick(dt);
      inst->doRender(W, H);

      // -- Capture write-tap outputs after render --
      captureWriteTaps(inst, entry, instKey, instances,
                       railsById, railTextures, railFloats);

      anyDispatched = true;
      finalHandle = outHandle;
      colInput = outHandle;
    }
  }
  return anyDispatched ? finalHandle : inputHandle;
}

int32_t SketchExecutor::nextIntermediate(int W, int H) {
  if (W != intermediates_w_ || H != intermediates_h_) {
    for (int32_t h : intermediates_) { if (h > 0 && gpu_) gpu_->release(h); }
    intermediates_.clear();
    intermediates_w_ = W; intermediates_h_ = H;
  }
  if (intermediate_cursor_ >= (int)intermediates_.size()) {
    // RGBA8 (format code 1) matches what every effect's compute
    // dispatch is writing today.
    int32_t h = gpu_->createTexture((uint32_t)W, (uint32_t)H, 1);
    intermediates_.push_back(h);
  }
  return intermediates_[intermediate_cursor_++];
}

void SketchExecutor::applyState(
    effect_runtime::EffectInstance* inst,
    const json& state) {
  if (!state.is_object()) return;
  for (auto it = state.begin(); it != state.end(); ++it) {
    const auto& v = it.value();
    const std::string& name = it.key();
    if (v.is_number()) {
      inst->setParamFloat(name, (float)v.get<double>());
    } else if (v.is_boolean()) {
      inst->setParamFloat(name, v.get<bool>() ? 1.0f : 0.0f);
    } else if (v.is_array()) {
      std::vector<float> comps;
      for (const auto& x : v) {
        if (x.is_number()) comps.push_back((float)x.get<double>());
      }
      if (!comps.empty()) inst->setParamArray(name, comps);
    } else if (v.is_string()) {
      inst->setParamJson(name, "\"" + v.get<std::string>() + "\"");
    }
  }
}

void SketchExecutor::applyReadTaps(
    effect_runtime::EffectInstance* inst,
    const json& entry,
    const std::unordered_map<std::string, json>& railsById,
    const std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railTextures,
    const std::unordered_map<std::string, float>& railFloats) {
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
  for (const auto& tap : entry["taps"]) {
    if (tap.value("direction", std::string()) != "read") continue;
    const std::string railId    = tap.value("railId", std::string());
    const std::string fieldPath = tap.value("fieldPath", std::string());
    auto railIt = railsById.find(railId);
    if (railIt == railsById.end()) continue;
    const auto& dataType = railIt->second.value("dataType", json());

    if (dataType.is_string() && dataType.get<std::string>() == "float") {
      auto fit = railFloats.find(railId);
      if (fit != railFloats.end()) {
        inst->setParamFloat(fieldPath, fit->second);
        inst->setFieldConnected(fieldPath, true, false);
      }
      continue;
    }

    auto texIt = railTextures.find(railId);
    if (texIt == railTextures.end()) continue;
    forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
      auto lit = texIt->second.find(leaf);
      if (lit == texIt->second.end() || lit->second <= 0) return;
      const std::string target = leaf.empty() ? fieldPath
                                              : (fieldPath + "/" + leaf);
      inst->setTextureField(target, lit->second);
    });
    inst->setFieldConnected(fieldPath, true, false);
  }
}

void SketchExecutor::captureWriteTaps(
    effect_runtime::EffectInstance* inst,
    const json& entry,
    const std::string& producerInstanceKey,
    const json& sketchInstances,
    const std::unordered_map<std::string, json>& railsById,
    std::unordered_map<std::string,
      std::unordered_map<std::string, int32_t>>& railTextures,
    std::unordered_map<std::string, float>& railFloats) {
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
  for (const auto& tap : entry["taps"]) {
    if (tap.value("direction", std::string()) != "write") continue;
    const std::string railId    = tap.value("railId", std::string());
    const std::string fieldPath = tap.value("fieldPath", std::string());
    auto railIt = railsById.find(railId);
    if (railIt == railsById.end()) continue;
    const auto& dataType = railIt->second.value("dataType", json());

    if (dataType.is_string() && dataType.get<std::string>() == "float") {
      // Producer's current scalar lives in the sketch's instance
      // state — the editor mirrors it there each frame. The runtime
      // doesn't expose a getParamFloat, so we read the canonical
      // source rather than the in-runtime mirror.
      if (sketchInstances.is_object() &&
          sketchInstances.contains(producerInstanceKey)) {
        const auto& st = sketchInstances[producerInstanceKey]
                            .value("state", json::object());
        if (st.is_object() && st.contains(fieldPath)) {
          const auto& v = st[fieldPath];
          if (v.is_number()) {
            railFloats[railId] = (float)v.get<double>();
            inst->setFieldConnected(fieldPath, false, true);
          } else if (v.is_boolean()) {
            railFloats[railId] = v.get<bool>() ? 1.0f : 0.0f;
            inst->setFieldConnected(fieldPath, false, true);
          }
        }
      }
      continue;
    }

    auto& texMap = railTextures[railId];
    forEachRailLeafTexture(dataType, [&](const std::string& leaf) {
      const std::string source = leaf.empty() ? fieldPath
                                              : (fieldPath + "/" + leaf);
      int32_t h = inst->textureField(source);
      if (h > 0) texMap[leaf] = h;
    });
  }
}

void SketchExecutor::markWriteTapOutputsConnected(
    effect_runtime::EffectInstance* inst,
    const json& entry) {
  if (!entry.contains("taps") || !entry["taps"].is_array()) return;
  for (const auto& tap : entry["taps"]) {
    if (tap.value("direction", std::string()) != "write") continue;
    const std::string fieldPath = tap.value("fieldPath", std::string());
    inst->setFieldConnected(fieldPath, false, true);
  }
}

}  // namespace sketch_executor
