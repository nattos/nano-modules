// midi_host_coremidi.mm — the Apple MidiPortBackend.
//
// Threading: CoreMIDI wants a run loop for hot-plug (setup-changed)
// notifications, so the client + input port live on a dedicated thread running
// CFRunLoopRun(); read callbacks arrive on CoreMIDI's own I/O thread. Both
// callbacks are handed straight to MidiHost, which owns all the shared state
// and its lock — this file keeps none.

#include "midi/midi_port_backend.h"

#include <CoreFoundation/CoreFoundation.h>
#include <CoreMIDI/CoreMIDI.h>

#include <map>
#include <mutex>
#include <thread>

namespace nano_midi {
namespace {

std::string cfStringProp(MIDIObjectRef obj, CFStringRef prop) {
  CFStringRef value = nullptr;
  if (MIDIObjectGetStringProperty(obj, prop, &value) != noErr || !value) return {};
  char buf[256] = {0};
  CFStringGetCString(value, buf, sizeof(buf), kCFStringEncodingUTF8);
  CFRelease(value);
  return buf;
}

int32_t intProp(MIDIObjectRef obj, CFStringRef prop) {
  SInt32 value = 0;
  if (MIDIObjectGetIntegerProperty(obj, prop, &value) != noErr) return 0;
  return value;
}

class CoreMidiBackend : public MidiPortBackend {
 public:
  bool start(SetupChangedFn onSetupChanged, DeliverFn deliver) override {
    if (started_) return true;
    started_ = true;
    onSetupChanged_ = std::move(onSetupChanged);
    deliver_ = std::move(deliver);

    runLoopThread_ = std::thread([this] {
      runLoop_ = CFRunLoopGetCurrent();
      MIDIClientCreateWithBlock(CFSTR("NanoBarrel MIDI"), &client_,
          ^(const MIDINotification* note) {
            if (note->messageID == kMIDIMsgSetupChanged && onSetupChanged_) onSetupChanged_();
          });
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
      // The refCon is the port's unique id, boxed in the pointer — the host
      // routes by that, so no per-connection object has to stay alive for it.
      MIDIInputPortCreateWithBlock(client_, CFSTR("NanoBarrel In"), &inPort_,
          ^(const MIDIPacketList* list, void* refCon) {
            const int32_t uid = (int32_t)(intptr_t)refCon;
            const MIDIPacket* packet = &list->packet[0];
            for (UInt32 p = 0; p < list->numPackets; ++p) {
              if (deliver_ && packet->length > 0)
                deliver_(uid, packet->data, (int)packet->length);
              packet = MIDIPacketNext(packet);
            }
          });
#pragma clang diagnostic pop
      // Ports present before we got here never raise setup-changed, so the
      // first match has to be asked for.
      if (onSetupChanged_) onSetupChanged_();
      CFRunLoopRun();
    });
    return true;
  }

  std::vector<MidiSourceInfo> enumerateSources() override {
    std::vector<MidiSourceInfo> out;
    const ItemCount n = MIDIGetNumberOfSources();
    for (ItemCount i = 0; i < n; ++i) {
      MIDIEndpointRef src = MIDIGetSource(i);
      if (!src) continue;
      MidiSourceInfo info;
      info.uniqueId = intProp(src, kMIDIPropertyUniqueID);
      info.name = cfStringProp(src, kMIDIPropertyDisplayName);
      info.manufacturer = cfStringProp(src, kMIDIPropertyManufacturer);
      if (info.uniqueId == 0) continue;
      std::lock_guard<std::mutex> lk(mu_);
      endpoints_[info.uniqueId] = src;
      out.push_back(std::move(info));
    }
    return out;
  }

  void connect(int32_t uniqueId) override {
    MIDIEndpointRef src = endpointFor(uniqueId);
    if (!inPort_ || !src) return;
    MIDIPortConnectSource(inPort_, src, (void*)(intptr_t)uniqueId);
  }

  void disconnect(int32_t uniqueId) override {
    MIDIEndpointRef src = endpointFor(uniqueId);
    if (!inPort_ || !src) return;
    MIDIPortDisconnectSource(inPort_, src);
  }

 private:
  MIDIEndpointRef endpointFor(int32_t uniqueId) {
    std::lock_guard<std::mutex> lk(mu_);
    auto it = endpoints_.find(uniqueId);
    return it == endpoints_.end() ? 0 : it->second;
  }

  std::mutex mu_;
  std::map<int32_t, MIDIEndpointRef> endpoints_;
  MIDIClientRef client_ = 0;
  MIDIPortRef inPort_ = 0;
  std::thread runLoopThread_;
  CFRunLoopRef runLoop_ = nullptr;
  bool started_ = false;
  SetupChangedFn onSetupChanged_;
  DeliverFn deliver_;
};

}  // namespace

std::unique_ptr<MidiPortBackend> createMidiPortBackend() {
  return std::make_unique<CoreMidiBackend>();
}

}  // namespace nano_midi
