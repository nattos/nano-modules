// midi_host_null.cpp — the MidiPortBackend for platforms with no native MIDI
// yet (Windows).
//
// It enumerates nothing, so no hardware ever matches a library instance. That
// is NOT the same as disabling MIDI: the web editor's simulated values and the
// control aliases both ride the same merged table, and neither needs a port, so
// a Windows barrel still responds to everything an editor drives — it just
// can't hear a physical controller.
//
// The Windows implementation goes here: WinMM (midiInOpen / midiInStart, with
// the MM_MIM_DATA callback) is the direct analogue, and
// `midiInGetDevCaps().szPname` supplies the name the matching rules key on.
// WinMM has no stable unique id or manufacturer string, so the device index
// would have to stand in for uniqueId — meaning a re-plug can renumber ports
// and re-match them differently, which CoreMIDI's uid avoids.

#include "midi/midi_port_backend.h"

namespace nano_midi {
namespace {

class NullMidiBackend : public MidiPortBackend {
 public:
  bool start(SetupChangedFn, DeliverFn) override { return false; }
  std::vector<MidiSourceInfo> enumerateSources() override { return {}; }
  void connect(int32_t) override {}
  void disconnect(int32_t) override {}
};

}  // namespace

std::unique_ptr<MidiPortBackend> createMidiPortBackend() {
  return std::make_unique<NullMidiBackend>();
}

}  // namespace nano_midi
