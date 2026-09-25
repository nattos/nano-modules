#pragma once
// effect_migrations.h — upgrade a saved effect instance whose stored state an
// effect has since redefined (a MINOR version bump: units or range changed).
//
// Every sketch instance records the version of the effect that wrote it
// (`instance.version.effect`, [major, minor, patch]); an instance with no
// version predates versioning and counts as older than every migration. Each
// migration names the effect and the version it upgrades TO, rewrites the
// state, and stamps that version, so running it twice is a no-op.
//
// LOCK-STEP twin of web/src/state/effect-migrations.ts, pinned by the shared
// cases in web/test/fixtures/effect-migration-cases.json (read by both
// test_effect_migrations.cpp and effect-migrations.test.ts).
//
// Where it runs: the web migrates every sketch it ingests (normalizeSketchChains)
// and every arrangement it opens; natively, the barrel migrates each sketch it
// refetches, which is what upgrades a Resolume composition saved before the
// change even when no editor ever connects.

#include <array>
#include <string>

#include <nlohmann/json.hpp>

namespace effect_migrations {

using Version = std::array<int, 3>;

struct Migration {
  const char* moduleType;
  Version to;                              // stamped once applied
  void (*apply)(nlohmann::json& state);    // rewrites the state object in place
};

// mod.source.lfo 1.2.0: `rate` was a 0..1 knob mapped to 0..10 Hz; it is now
// Hz itself (0.01..120, log-scaled). 0 stays 0 (a stopped LFO).
inline void lfoRateToHz(nlohmann::json& state) {
  auto it = state.find("rate");
  if (it != state.end() && it->is_number()) *it = it->get<double>() * 10.0;
}

inline const std::array<Migration, 1>& all() {
  static const std::array<Migration, 1> kAll = {{
      {"mod.source.lfo", {1, 2, 0}, &lfoRateToHz},
  }};
  return kAll;
}

inline Version recordedVersion(const nlohmann::json& inst) {
  Version v{0, 0, 0};
  auto vit = inst.find("version");
  if (vit == inst.end() || !vit->is_object()) return v;
  auto eit = vit->find("effect");
  if (eit == vit->end() || !eit->is_array()) return v;
  for (size_t i = 0; i < 3 && i < eit->size(); ++i)
    if ((*eit)[i].is_number()) v[i] = (*eit)[i].get<int>();
  return v;
}

/// Migrate one state object for `moduleType`, recorded at `from`. Returns the
/// version the state is now at (== `from` when nothing applied).
inline Version migrateState(const std::string& moduleType, nlohmann::json& state,
                            Version from) {
  for (const auto& m : all()) {
    if (moduleType != m.moduleType || !(from < m.to)) continue;
    if (state.is_object()) m.apply(state);
    from = m.to;
  }
  return from;
}

/// Migrate one sketch instance ({module_type, state, version}). True if changed.
inline bool migrateInstance(nlohmann::json& inst) {
  if (!inst.is_object()) return false;
  const std::string type = inst.value("module_type", std::string());
  const Version from = recordedVersion(inst);
  auto sit = inst.find("state");
  nlohmann::json empty = nlohmann::json::object();
  nlohmann::json& state = sit != inst.end() ? *sit : empty;
  const Version to = migrateState(type, state, from);
  if (to == from) return false;
  if (!inst.contains("version") || !inst["version"].is_object())
    inst["version"] = {{"module", {0, 0, 0}}};
  inst["version"]["effect"] = {to[0], to[1], to[2]};
  return true;
}

/// Migrate every instance of a sketch. True if anything changed.
inline bool migrateSketch(nlohmann::json& sketch) {
  auto it = sketch.find("instances");
  if (it == sketch.end() || !it->is_object()) return false;
  bool any = false;
  for (auto& [key, inst] : it->items()) any = migrateInstance(inst) || any;
  return any;
}

}  // namespace effect_migrations
