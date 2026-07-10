// midi_host.h — the native (CoreMIDI) MIDI host, the headless twin of the
// web's MidiManager (web/src/midi/midi-manager.ts).
//
// Owns CoreMIDI access, hot-plug re-matching of sources to device-library
// instances (same identity rules: exact platform id, else (name,
// manufacturer) tuple, library order, one instance per port per pass), one
// lock-step driver per matched instance, and the per-instance hardware value
// tables. Produces the executor's external-scalar table
// (`{"midi:<uuid>": {"b0/e05/turn": v}}`), merged `hardware ⊕ web sim
// overrides`, version-gated so render loops re-apply only on change.
//
// The library arrives as JSON (the web mirrors it to /global/midi_devices;
// BarrelRuntime also persists it to a sidecar for headless restarts). Web sim
// overrides ride /global/midi_sim while an editor is connected.
//
// v1 is parse-only (no LED output back to the hardware from native).

#pragma once

#include <cstdint>
#include <memory>
#include <string>

#include <nlohmann/json.hpp>

namespace nano_midi {

class MidiHost {
 public:
  static MidiHost& instance();

  /// Start CoreMIDI (idempotent; spawns the client thread lazily). Safe to
  /// call from the render thread.
  void start();

  /// Replace the device library (array of DeviceInstance JSON: {id,
  /// templateId, deleted?, identities:[{name,manufacturer,coreMidiId?}],
  /// config}). Re-matches connected sources.
  void setLibrary(const nlohmann::json& instances);

  /// Replace the web's simulation overrides: {"<instanceId>": {endpoint: v}}.
  void setSimOverrides(const nlohmann::json& table);

  /// Monotonic version of the merged value table — bumps on any hardware
  /// value, sim override, library rematch, or bank change.
  uint64_t version() const;

  /// The merged external-scalar table (setExternalScalars shape).
  nlohmann::json externalScalars() const;

  /// Connected instance ids (diagnostics / tests).
  nlohmann::json connectedInstances() const;

 private:
  MidiHost();
  ~MidiHost();
  MidiHost(const MidiHost&) = delete;
  MidiHost& operator=(const MidiHost&) = delete;

  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace nano_midi
