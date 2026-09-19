#pragma once

// MidiPortBackend — the one platform-specific seam in the native MIDI host.
//
// Everything that makes MidiHost interesting — the device library, the
// source↔instance matching rules, the lock-step drivers, the hardware/sim/alias
// merge and its version gate — is plain C++ and lives in midi_host.cpp. All
// that differs per OS is: enumerate the input ports, tell me when that set
// changes, and hand me bytes. That is this interface, and it is deliberately
// tiny so a second platform is one short file.
//
// Implementations: midi_host_coremidi.mm (Apple), midi_host_null.cpp
// (everywhere else — enumerates nothing, so the host still serves the web's
// simulated values and control aliases, which need no hardware at all).

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace nano_midi {

/// One connectable MIDI input, in the terms the matching rules use.
struct MidiSourceInfo {
  /// Stable per-port identity. CoreMIDI's kMIDIPropertyUniqueID; whatever
  /// plays that role elsewhere. Also the key the host routes messages by, so
  /// it must be the same value `deliver` reports. Never 0 for a real port.
  int32_t uniqueId = 0;
  std::string name;
  std::string manufacturer;
};

class MidiPortBackend {
 public:
  /// Raw bytes from one port. May be a whole packet list's worth of
  /// concatenated messages — the host does the status-aligned split, so a
  /// backend never has to parse. Called on whatever thread the OS uses.
  using DeliverFn = std::function<void(int32_t uniqueId, const uint8_t* bytes, int len)>;
  /// The connected-device set changed; the host will re-enumerate and re-match.
  using SetupChangedFn = std::function<void()>;

  virtual ~MidiPortBackend() = default;

  /// Begin listening. Called once, from MidiHost::start(). The callbacks
  /// outlive the call and may fire on any thread, including before `start`
  /// returns. Returns false if the platform has no MIDI to offer.
  virtual bool start(SetupChangedFn onSetupChanged, DeliverFn deliver) = 0;

  /// Every input port currently present.
  virtual std::vector<MidiSourceInfo> enumerateSources() = 0;

  /// Route/stop routing this port's messages to `deliver`. Ports the host
  /// never connects must stay silent.
  virtual void connect(int32_t uniqueId) = 0;
  virtual void disconnect(int32_t uniqueId) = 0;
};

/// The backend for this platform. Never null — a platform with no MIDI
/// support returns one that enumerates nothing.
std::unique_ptr<MidiPortBackend> createMidiPortBackend();

}  // namespace nano_midi
