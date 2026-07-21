// midi_host.mm — CoreMIDI implementation of the native MIDI host.
//
// Threading: CoreMIDI wants a run loop for hot-plug (setup-changed)
// notifications, so the client + input port live on a dedicated thread
// running CFRunLoopRun(); MIDI read callbacks arrive on CoreMIDI's own I/O
// thread. All shared state (library, connections, value tables) is guarded
// by one mutex; consumers (the render loop) read a version counter and pull
// the merged table only when it changed.

#include "midi/midi_host.h"

#include <CoreFoundation/CoreFoundation.h>
#include <CoreMIDI/CoreMIDI.h>

#include <map>
#include <mutex>
#include <set>
#include <thread>
#include <unordered_map>
#include <vector>

#include "midi/mft_driver.h"

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

}  // namespace

struct MidiHost::Impl {
  std::mutex mu;
  uint64_t version = 1;

  MIDIClientRef client = 0;
  MIDIPortRef inPort = 0;
  std::thread runLoopThread;
  CFRunLoopRef runLoop = nullptr;
  bool started = false;

  nlohmann::json library = nlohmann::json::array();
  nlohmann::json simOverrides = nlohmann::json::object();

  struct Connection {
    std::string instanceId;
    MIDIEndpointRef source = 0;
    std::unique_ptr<DeviceDriver> driver;
    // Split multi-message packets: partial CC assembly across packet bounds.
    std::vector<uint8_t> pending;
  };
  // Keyed by source endpoint unique id; values pointer-stable (render thread
  // never touches these — only the read proc and refreshMatching do).
  std::map<int32_t, std::unique_ptr<Connection>> connections;

  /// instanceId → endpoint → hardware value. Survives disconnects.
  std::unordered_map<std::string, std::unordered_map<std::string, float>> hardware;

  void bump() { ++version; }

  // --- Matching (same rules as web/src/midi/matching.ts) ---

  const nlohmann::json* matchInstance(const std::string& name, const std::string& manufacturer,
                                      int32_t uniqueId, const std::set<std::string>& taken) {
    const nlohmann::json* tuple = nullptr;
    for (const auto& inst : library) {
      if (!inst.is_object() || inst.value("deleted", false)) continue;
      const std::string id = inst.value("id", std::string());
      if (id.empty() || taken.count(id)) continue;
      for (const auto& ident : inst.value("identities", nlohmann::json::array())) {
        if (!ident.is_object()) continue;
        if (uniqueId != 0 && ident.value("coreMidiId", 0) == uniqueId) return &inst;
        if (!tuple && ident.value("name", std::string()) == name &&
            ident.value("manufacturer", std::string()) == manufacturer) {
          tuple = &inst;
        }
      }
    }
    return tuple;
  }

  /// Re-derive source ↔ instance pairings. Called on the run-loop thread
  /// (setup changed) and from setLibrary (caller holds no lock).
  void refreshMatching() {
    std::lock_guard<std::mutex> lk(mu);
    std::set<std::string> taken;
    std::map<int32_t, std::unique_ptr<Connection>> next;

    const ItemCount n = MIDIGetNumberOfSources();
    for (ItemCount i = 0; i < n; ++i) {
      MIDIEndpointRef src = MIDIGetSource(i);
      if (!src) continue;
      const std::string name = cfStringProp(src, kMIDIPropertyDisplayName);
      const std::string manufacturer = cfStringProp(src, kMIDIPropertyManufacturer);
      const int32_t uid = intProp(src, kMIDIPropertyUniqueID);
      const nlohmann::json* inst = matchInstance(name, manufacturer, uid, taken);
      if (!inst) continue;
      const std::string instanceId = inst->value("id", std::string());
      taken.insert(instanceId);

      auto existing = connections.find(uid);
      if (existing != connections.end() && existing->second->instanceId == instanceId) {
        // Keep the live pairing; refresh the driver config (cheap).
        existing->second->driver->setConfig(inst->value("config", nlohmann::json::object()));
        next[uid] = std::move(existing->second);
        connections.erase(existing);
        continue;
      }
      auto driver = createDriverForTemplate(
          inst->value("templateId", std::string()),
          inst->value("config", nlohmann::json::object()));
      if (!driver) continue;
      auto conn = std::make_unique<Connection>();
      conn->instanceId = instanceId;
      conn->source = src;
      conn->driver = std::move(driver);
      if (inPort) {
        MIDIPortConnectSource(inPort, src, conn.get());
      }
      next[uid] = std::move(conn);
    }

    // Anything left lost its port / instance this pass.
    for (auto& [uid, conn] : connections) {
      if (inPort && conn->source) MIDIPortDisconnectSource(inPort, conn->source);
    }
    connections = std::move(next);
    bump();
  }

  /// MIDI read callback (CoreMIDI I/O thread). Splits packets into messages
  /// and feeds the connection's driver.
  void onPackets(const MIDIPacketList* list, Connection* conn) {
    std::lock_guard<std::mutex> lk(mu);
    // The connection may have been torn down between dispatch and lock.
    bool live = false;
    for (const auto& [uid, c] : connections) {
      if (c.get() == conn) { live = true; break; }
    }
    if (!live) return;

    auto& table = hardware[conn->instanceId];
    const auto getValue = [&](const std::string& ep) {
      auto it = table.find(ep);
      return it != table.end() ? it->second : 0.0f;
    };
    bool changed = false;
    const auto emit = [&](const std::string& ep, float v) {
      table[ep] = v;
      changed = true;
    };

    const MIDIPacket* packet = &list->packet[0];
    for (UInt32 p = 0; p < list->numPackets; ++p) {
      // Walk status-aligned channel messages; skip anything that isn't a
      // 3-byte channel voice message (sysex, realtime).
      const uint8_t* data = packet->data;
      const int len = packet->length;
      int i = 0;
      while (i < len) {
        const uint8_t status = data[i];
        if (status < 0x80 || status >= 0xf0) { ++i; continue; }
        if (i + 2 >= len) break;
        conn->driver->onMessage(data + i, 3, getValue, emit);
        i += 3;
      }
      packet = MIDIPacketNext(packet);
    }
    if (changed) bump();
  }

  nlohmann::json buildExternalScalars() {
    // hardware ⊕ sim: the web's on-screen simulation overrides whatever the
    // hardware last reported, per endpoint.
    nlohmann::json out = nlohmann::json::object();
    for (const auto& [instanceId, table] : hardware) {
      if (table.empty()) continue;
      auto& entry = out["midi:" + instanceId];
      for (const auto& [ep, v] : table) entry[ep] = v;
    }
    if (simOverrides.is_object()) {
      for (const auto& [instanceId, table] : simOverrides.items()) {
        if (!table.is_object()) continue;
        auto& entry = out["midi:" + instanceId];
        for (const auto& [ep, v] : table.items()) {
          if (v.is_number()) entry[ep] = v.get<float>();
        }
      }
    }
    // `knownAs` alias fan-out: a wire may reference an alias uuid of a device
    // (a ghost adopted from another profile/composition — see the web's
    // DeviceInstance.knownAs). Duplicate the canonical entry under each alias
    // so those rails read the same values. Canonical entries never lose.
    if (library.is_array()) {
      for (const auto& inst : library) {
        if (!inst.is_object()) continue;
        auto ka = inst.find("knownAs");
        if (ka == inst.end() || !ka->is_array() || ka->empty()) continue;
        auto src = out.find("midi:" + inst.value("id", std::string()));
        if (src == out.end()) continue;
        for (const auto& alias : *ka) {
          if (!alias.is_string()) continue;
          const std::string key = "midi:" + alias.get<std::string>();
          if (out.find(key) == out.end()) out[key] = *src;
        }
      }
    }
    return out;
  }
};

MidiHost& MidiHost::instance() {
  // Intentionally leaked — never destructed. This singleton owns a CoreMIDI
  // client thread running CFRunLoopRun(). If it were a Meyers singleton, its
  // destructor would run from __cxa_finalize_ranges at exit(), *after*
  // CoreFoundation has finalized: CFRunLoopStop() would then dereference a
  // dead CFRunLoopRef and trap in __CFCheckCFInfoPACSignature (a shutdown
  // crash observed in Arena). Leaking skips the destructor entirely; the OS
  // reclaims the thread, client, and run loop at process exit anyway.
  static MidiHost* host = new MidiHost();
  return *host;
}

MidiHost::MidiHost() : impl_(std::make_unique<Impl>()) {}

// Never invoked in practice — see instance(). Defined so the type stays
// complete for unique_ptr<Impl>. Deliberately does NOT touch CoreFoundation,
// since the only path that could reach it is atexit teardown where the run
// loop is already gone.
MidiHost::~MidiHost() = default;

void MidiHost::start() {
  {
    std::lock_guard<std::mutex> lk(impl_->mu);
    if (impl_->started) return;
    impl_->started = true;
  }
  Impl* impl = impl_.get();
  impl->runLoopThread = std::thread([impl] {
    impl->runLoop = CFRunLoopGetCurrent();
    MIDIClientCreateWithBlock(CFSTR("NanoBarrel MIDI"), &impl->client,
        ^(const MIDINotification* note) {
          if (note->messageID == kMIDIMsgSetupChanged) impl->refreshMatching();
        });
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    MIDIInputPortCreateWithBlock(impl->client, CFSTR("NanoBarrel In"), &impl->inPort,
        ^(const MIDIPacketList* list, void* refCon) {
          impl->onPackets(list, static_cast<Impl::Connection*>(refCon));
        });
#pragma clang diagnostic pop
    impl->refreshMatching();
    CFRunLoopRun();
  });
}

void MidiHost::setLibrary(const nlohmann::json& instances) {
  {
    std::lock_guard<std::mutex> lk(impl_->mu);
    impl_->library = instances.is_array() ? instances : nlohmann::json::array();
  }
  if (impl_->started) impl_->refreshMatching();
  else {
    std::lock_guard<std::mutex> lk(impl_->mu);
    impl_->bump();
  }
}

void MidiHost::setSimOverrides(const nlohmann::json& table) {
  std::lock_guard<std::mutex> lk(impl_->mu);
  nlohmann::json next = table.is_object() ? table : nlohmann::json::object();
  if (next == impl_->simOverrides) return;
  impl_->simOverrides = std::move(next);
  impl_->bump();
}

uint64_t MidiHost::version() const {
  std::lock_guard<std::mutex> lk(impl_->mu);
  return impl_->version;
}

nlohmann::json MidiHost::externalScalars() const {
  std::lock_guard<std::mutex> lk(impl_->mu);
  return impl_->buildExternalScalars();
}

nlohmann::json MidiHost::connectedInstances() const {
  std::lock_guard<std::mutex> lk(impl_->mu);
  nlohmann::json out = nlohmann::json::array();
  for (const auto& [uid, conn] : impl_->connections) out.push_back(conn->instanceId);
  return out;
}

}  // namespace nano_midi
