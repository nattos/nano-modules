// mft_driver.h — Midi Fighter Twister (DJ TechTools), native driver.
//
// LOCK-STEP twin of web/src/midi/drivers/mft.ts — keep the parse/render
// semantics byte-identical (shared goldens: native/tests/fixtures/
// mft_goldens.json ↔ test_mft_driver.cpp ↔ mft.test.ts):
//   - encoder rotation CCs on channels.encoder (absolute value/127, or
//     offset-64 relative deltas integrated against the hardware value)
//   - encoder buttons on channels.button (press = value >= 64)
//   - shifted rotation on channels.shift (follows the encoder slot's mode)
//   - bank-change notifications on channels.system (CC 0..3, value >= 64)
//   - renderOutput: ring echo on the encoder channel + cap color on the
//     button channel, unchanged bytes skipped
// ALL protocol constants live in the config JSON (the template's
// defaultConfig / a fork's edits) — corrections are data, not code.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <unordered_map>
#include <vector>

#include "midi/midi_driver.h"

namespace nano_midi {

inline constexpr const char* kMftTemplateId = "com.nano.midi.mft";
inline constexpr int kMftBanks = 4;
inline constexpr int kMftEncodersPerBank = 16;
inline constexpr int kMftSlots = kMftBanks * kMftEncodersPerBank;

/// Factory default config — mirrors defaultMftConfig() in mft.ts.
inline nlohmann::json defaultMftConfig() {
  nlohmann::json cfg;
  cfg["channels"] = {{"encoder", 0}, {"button", 1}, {"shift", 4}, {"system", 3}};
  auto& encoders = cfg["encoders"] = nlohmann::json::array();
  auto& buttons = cfg["buttons"] = nlohmann::json::array();
  auto& shift = cfg["shift"] = nlohmann::json::array();
  auto& colors = cfg["colors"] = nlohmann::json::array();
  for (int i = 0; i < kMftSlots; ++i) {
    encoders.push_back({{"cc", i}, {"mode", "absolute"}});
    buttons.push_back({{"cc", i}});
    shift.push_back({{"cc", i}});
    colors.push_back(nlohmann::json::object());
  }
  return cfg;
}

class MftDriver final : public DeviceDriver {
 public:
  explicit MftDriver(nlohmann::json config) { setConfig(std::move(config)); }

  void setConfig(nlohmann::json config) override {
    config_ = std::move(config);
    lookupsBuilt_ = false;
    lastSent_.clear();
  }

  int activeBank() const override { return bank_; }

  void onMessage(const uint8_t* data, size_t len,
                 const GetValue& getValue, const Emit& emit) override {
    if (len < 3 || (data[0] & 0xf0) != 0xb0) return;
    const int ch = data[0] & 0x0f;
    const int cc = data[1];
    const int value = data[2];
    if (ch == channel("system")) {
      if (cc < kMftBanks && value >= 64 && cc != bank_) bank_ = cc;
      return;
    }
    if (ch == channel("encoder") && handleTurn(kEncoder, cc, value, "turn", getValue, emit)) return;
    if (ch == channel("button") && handleButton(cc, value, emit)) return;
    if (ch == channel("shift")) handleTurn(kShift, cc, value, "shift", getValue, emit);
  }

  void renderOutput(const std::function<float(const std::string&)>& values,
                    const Send& send) override {
    for (int slot = 0; slot < kMftSlots; ++slot) {
      const float turn = values(endpoint(slot, "turn"));
      if (!std::isnan(turn)) {
        sendOnce("ring:" + std::to_string(slot), channel("encoder"),
                 slotCc(kEncoder, slot), (int)std::lround(turn * 127.0f), send);
      }
      const auto& color = config_["colors"].is_array() && slot < (int)config_["colors"].size()
          ? config_["colors"][slot] : nlohmann::json();
      if (color.is_object() && color.contains("cap") && color["cap"].is_number()) {
        sendOnce("cap:" + std::to_string(slot), channel("button"),
                 slotCc(kButton, slot), color["cap"].get<int>(), send);
      }
    }
  }

 private:
  enum Kind { kEncoder = 0, kButton = 1, kShift = 2 };

  int channel(const char* which) const {
    const auto& ch = config_.value("channels", nlohmann::json::object());
    return ch.value(which, -1);
  }

  const char* sectionName(Kind kind) const {
    return kind == kEncoder ? "encoders" : kind == kButton ? "buttons" : "shift";
  }

  int slotCc(Kind kind, int slot) const {
    const auto& section = config_.value(sectionName(kind), nlohmann::json::array());
    if (!section.is_array() || slot >= (int)section.size()) return -1;
    return section[slot].value("cc", -1);
  }

  static std::string endpoint(int slot, const char* gesture) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "b%d/e%02d/%s",
                  slot / kMftEncodersPerBank, slot % kMftEncodersPerBank, gesture);
    return buf;
  }

  bool handleTurn(Kind kind, int cc, int value, const char* gesture,
                  const GetValue& getValue, const Emit& emit) {
    const int slot = resolveSlot(kind, cc);
    if (slot < 0) return false;
    const std::string ep = endpoint(slot, gesture);
    // The shifted rotation follows its encoder slot's absolute/relative mode.
    const auto& encoders = config_.value("encoders", nlohmann::json::array());
    const std::string mode = (encoders.is_array() && slot < (int)encoders.size())
        ? encoders[slot].value("mode", "absolute") : "absolute";
    float v;
    if (mode == "relative") {
      const float delta = (float)(value - 64) / 127.0f;
      v = std::min(1.0f, std::max(0.0f, getValue(ep) + delta));
    } else {
      v = (float)value / 127.0f;
    }
    emit(ep, v);
    return true;
  }

  bool handleButton(int cc, int value, const Emit& emit) {
    const int slot = resolveSlot(kButton, cc);
    if (slot < 0) return false;
    emit(endpoint(slot, "press"), value >= 64 ? 1.0f : 0.0f);
    return true;
  }

  /// cc → slot; on duplicates (all-banks-share-CCs forks) the active bank wins.
  int resolveSlot(Kind kind, int cc) {
    if (!lookupsBuilt_) {
      for (auto& m : lookups_) m.clear();
      for (int kind_i = 0; kind_i < 3; ++kind_i) {
        const auto& section = config_.value(sectionName((Kind)kind_i), nlohmann::json::array());
        if (!section.is_array()) continue;
        for (int slot = 0; slot < (int)section.size() && slot < kMftSlots; ++slot) {
          lookups_[kind_i][section[slot].value("cc", -1)].push_back(slot);
        }
      }
      lookupsBuilt_ = true;
    }
    const auto it = lookups_[kind].find(cc);
    if (it == lookups_[kind].end() || it->second.empty()) return -1;
    for (int slot : it->second) {
      if (slot / kMftEncodersPerBank == bank_) return slot;
    }
    return it->second.front();
  }

  void sendOnce(const std::string& key, int channel, int cc, int value, const Send& send) {
    if (channel < 0 || cc < 0) return;
    auto it = lastSent_.find(key);
    if (it != lastSent_.end() && it->second == value) return;
    lastSent_[key] = value;
    send((uint8_t)(0xb0 | (channel & 0x0f)), (uint8_t)(cc & 0x7f), (uint8_t)(value & 0x7f));
  }

  nlohmann::json config_;
  int bank_ = 0;
  bool lookupsBuilt_ = false;
  std::array<std::unordered_map<int, std::vector<int>>, 3> lookups_;
  std::unordered_map<std::string, int> lastSent_;
};

inline std::unique_ptr<DeviceDriver> createDriverForTemplate(
    const std::string& templateId, nlohmann::json config) {
  if (templateId == kMftTemplateId) {
    return std::make_unique<MftDriver>(std::move(config));
  }
  return nullptr;
}

}  // namespace nano_midi
