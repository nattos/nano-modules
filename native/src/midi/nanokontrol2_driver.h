// nanokontrol2_driver.h — Korg nanoKONTROL2, native driver.
//
// LOCK-STEP twin of web/src/midi/drivers/nanokontrol2.ts — keep the parse
// semantics byte-identical (shared goldens: native/tests/fixtures/
// nk2_goldens.json ↔ test_nk2_driver.cpp ↔ nanokontrol2.test.ts):
//   - one MIDI channel for the whole surface (`config.channel`)
//   - faders/knobs are continuous ('turn', value/127); every button is
//     'press' (>= 64 reads 1, below reads 0 — right for both Momentary and
//     Toggle firmware modes, and the driver latches nothing of its own)
//   - EVERY slot matching a CC fires, not just the first: with no banks a
//     duplicate CC can only be a deliberate gang or a config mistake worth
//     seeing, so moving both controls is the honest reading
//   - renderOutput only speaks in `ledMode: "external"`; in internal mode the
//     hardware owns its lamps and ignores us
//
// Slot numbering is the WIRE CONTRACT (logical ids 'b0/e<slot>'), so the
// bases below must match the TS ones exactly — changing one silently
// re-points every saved wire at a different physical control.
//
// ALL protocol constants live in the config JSON (the template's
// defaultConfig / a fork's edits) — corrections are data, not code.

#pragma once

#include <cmath>
#include <cstdio>
#include <string>
#include <unordered_map>
#include <vector>

#include "midi/midi_driver.h"

namespace nano_midi {

inline constexpr const char* kNk2TemplateId = "com.nano.midi.nanokontrol2";
inline constexpr int kNk2Strips = 8;
inline constexpr int kNk2Transport = 11;

inline constexpr int kNk2SlotFader = 0;
inline constexpr int kNk2SlotKnob = 8;
inline constexpr int kNk2SlotSolo = 16;
inline constexpr int kNk2SlotMute = 24;
inline constexpr int kNk2SlotRec = 32;
inline constexpr int kNk2SlotTransport = 40;
inline constexpr int kNk2Slots = kNk2SlotTransport + kNk2Transport;

/// Factory default config — mirrors defaultNanoKontrol2Config() in
/// nanokontrol2.ts (the stock "CC mode" scene from the Korg manual).
inline nlohmann::json defaultNanoKontrol2Config() {
  const auto strip = [](int base) {
    auto arr = nlohmann::json::array();
    for (int i = 0; i < kNk2Strips; ++i) arr.push_back({{"cc", base + i}});
    return arr;
  };
  // Indexed by the TS NK2_TRANSPORT order: trackPrev, trackNext, cycle,
  // markerSet, markerPrev, markerNext, rew, ff, stop, play, rec.
  static constexpr int kTransportCc[kNk2Transport] = {
    58, 59, 46, 60, 61, 62, 43, 44, 42, 41, 45,
  };
  nlohmann::json cfg;
  cfg["channel"] = 0;
  cfg["faders"] = strip(0);
  cfg["knobs"] = strip(16);
  cfg["solo"] = strip(32);
  cfg["mute"] = strip(48);
  cfg["rec"] = strip(64);
  auto& transport = cfg["transport"] = nlohmann::json::array();
  for (int cc : kTransportCc) transport.push_back({{"cc", cc}});
  cfg["ledMode"] = "internal";
  return cfg;
}

/// Which config array a slot lives in, and its index there. Empty group when
/// the slot is out of range.
struct Nk2Slot {
  std::string group;
  int index = 0;
  bool valid() const { return !group.empty(); }
};

inline Nk2Slot nk2GroupOf(int slot) {
  if (slot < 0 || slot >= kNk2Slots) return {};
  if (slot >= kNk2SlotTransport) return {"transport", slot - kNk2SlotTransport};
  if (slot >= kNk2SlotRec) return {"rec", slot - kNk2SlotRec};
  if (slot >= kNk2SlotMute) return {"mute", slot - kNk2SlotMute};
  if (slot >= kNk2SlotSolo) return {"solo", slot - kNk2SlotSolo};
  if (slot >= kNk2SlotKnob) return {"knobs", slot - kNk2SlotKnob};
  return {"faders", slot - kNk2SlotFader};
}

/// Faders and knobs are continuous ('turn'); everything else is a button.
inline bool nk2IsContinuous(const std::string& group) {
  return group == "faders" || group == "knobs";
}

/// 'b0/e17/turn' — the logical endpoint field for a slot. Zero-padded to two
/// digits, exactly as the web's bankedControlId does (the wire contract).
inline std::string nk2Endpoint(int slot) {
  const Nk2Slot at = nk2GroupOf(slot);
  const char* gesture = at.valid() && nk2IsContinuous(at.group) ? "turn" : "press";
  char buf[32];
  std::snprintf(buf, sizeof(buf), "b0/e%02d/%s", slot, gesture);
  return buf;
}

class Nk2Driver final : public DeviceDriver {
 public:
  explicit Nk2Driver(nlohmann::json config) { setConfig(std::move(config)); }

  void setConfig(nlohmann::json config) override {
    config_ = std::move(config);
    lookupBuilt_ = false;
    lastSent_.clear();
  }

  /// Unbanked surface: always bank 0.
  int activeBank() const override { return 0; }

  void onMessage(const uint8_t* data, size_t len,
                 const GetValue& /*getValue*/, const Emit& emit) override {
    if (len < 3 || (data[0] & 0xf0) != 0xb0) return;
    if ((data[0] & 0x0f) != channel()) return;
    const std::vector<int>* slots = resolveSlots(data[1]);
    if (!slots) return;
    for (int slot : *slots) {
      const Nk2Slot at = nk2GroupOf(slot);
      if (!at.valid()) continue;
      const float value = nk2IsContinuous(at.group)
          ? static_cast<float>(data[2]) / 127.0f
          : (data[2] >= 64 ? 1.0f : 0.0f);
      emit(nk2Endpoint(slot), value);
    }
  }

  void renderOutput(const std::function<float(const std::string&)>& values,
                    const Send& send) override {
    if (config_.value("ledMode", std::string("internal")) != "external") return;
    for (int slot = kNk2SlotSolo; slot < kNk2Slots; ++slot) {
      const float v = values(nk2Endpoint(slot));
      if (std::isnan(v)) continue;
      const int out = v >= 0.5f ? 127 : 0;
      auto it = lastSent_.find(slot);
      if (it != lastSent_.end() && it->second == out) continue;
      lastSent_[slot] = out;
      send(static_cast<uint8_t>(0xb0 | (channel() & 0x0f)),
           static_cast<uint8_t>(ccOf(slot) & 0x7f), static_cast<uint8_t>(out));
    }
  }

 private:
  int channel() const { return config_.value("channel", 0); }

  int ccOf(int slot) const {
    const Nk2Slot at = nk2GroupOf(slot);
    if (!at.valid()) return -1;
    auto git = config_.find(at.group);
    if (git == config_.end() || !git->is_array() || at.index >= (int)git->size()) return -1;
    const auto& entry = (*git)[at.index];
    return entry.is_object() ? entry.value("cc", -1) : -1;
  }

  const std::vector<int>* resolveSlots(int cc) {
    if (!lookupBuilt_) {
      lookup_.clear();
      for (int slot = 0; slot < kNk2Slots; ++slot) {
        const int c = ccOf(slot);
        if (c >= 0) lookup_[c].push_back(slot);
      }
      lookupBuilt_ = true;
    }
    auto it = lookup_.find(cc);
    return it == lookup_.end() ? nullptr : &it->second;
  }

  nlohmann::json config_;
  std::unordered_map<int, std::vector<int>> lookup_;
  bool lookupBuilt_ = false;
  std::unordered_map<int, int> lastSent_;
};

}  // namespace nano_midi
