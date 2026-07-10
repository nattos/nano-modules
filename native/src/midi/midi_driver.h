// midi_driver.h — the native device-driver interface + template registry.
//
// The native twin of the web's DeviceDriver (web/src/midi/midi-types.ts):
// a driver owns one device model's wire protocol, parsing raw MIDI bytes
// into normalized {endpoint, value 0..1} control updates and rendering
// outgoing state (LED echo/colors) back to the hardware. Endpoint ids are
// the shared logical scheme ('b<bank>/e<idx>/<gesture>') — NEVER MIDI
// addresses — so web and native produce identical wire sources.
//
// Semantics are kept LOCK-STEP with the TS drivers via the shared goldens in
// native/tests/fixtures/mft_goldens.json (see test_mft_driver.cpp and
// web/src/midi/drivers/mft.test.ts).

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

namespace nano_midi {

class DeviceDriver {
 public:
  using GetValue = std::function<float(const std::string& endpoint)>;
  using Emit = std::function<void(const std::string& endpoint, float value)>;
  using Send = std::function<void(uint8_t status, uint8_t d1, uint8_t d2)>;

  virtual ~DeviceDriver() = default;

  /// Parse one raw MIDI message. `getValue` reads the current HARDWARE value
  /// of an endpoint (relative-mode integration); `emit` publishes updates.
  virtual void onMessage(const uint8_t* data, size_t len,
                         const GetValue& getValue, const Emit& emit) = 0;

  /// Push full outgoing state (ring echo, colors). `values` resolves the
  /// host's merged value for an endpoint (NaN when unknown → skipped).
  virtual void renderOutput(const std::function<float(const std::string&)>& values,
                            const Send& send) {}

  /// Config was edited (remap/colors) — refresh lookups.
  virtual void setConfig(nlohmann::json config) = 0;

  virtual int activeBank() const { return 0; }
};

// The template → driver factory `createDriverForTemplate(templateId, config)`
// is defined (inline, header-only) in mft_driver.h — include that to
// instantiate drivers; this header only carries the interface.

}  // namespace nano_midi
