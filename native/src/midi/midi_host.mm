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
  /// Write sequence per hardware endpoint, and per sim override — the alias
  /// tie-break (last touched wins). Same counter for both layers.
  std::unordered_map<std::string, std::unordered_map<std::string, uint64_t>> hardwareSeq;
  std::unordered_map<std::string, std::unordered_map<std::string, uint64_t>> simSeq;
  uint64_t writeSeq = 0;

  /// Control-alias groups (undirected components over the pushed edges) plus
  /// the serialized edge set they came from, for change detection.
  std::vector<std::vector<AliasEndpoint>> aliasGroupList;
  std::string aliasKey;

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
    auto& seqTable = hardwareSeq[conn->instanceId];
    const auto emit = [&](const std::string& ep, float v) {
      table[ep] = v;
      seqTable[ep] = ++writeSeq;
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
    // One merged entry per endpoint, carrying the write sequence the alias
    // fold needs. Layered hardware → sim → knownAs fan-out → aliases.
    struct Val { float v = 0.0f; uint64_t seq = 0; };
    std::map<std::string, std::map<std::string, Val>> merged;   // "midi:<id>" → ep → Val

    for (const auto& [instanceId, table] : hardware) {
      if (table.empty()) continue;
      auto& entry = merged["midi:" + instanceId];
      const auto si = hardwareSeq.find(instanceId);
      for (const auto& [ep, v] : table) {
        uint64_t seq = 0;
        if (si != hardwareSeq.end()) {
          auto it = si->second.find(ep);
          if (it != si->second.end()) seq = it->second;
        }
        entry[ep] = Val{v, seq};
      }
    }
    // hardware ⊕ sim: the web's on-screen simulation overrides whatever the
    // hardware last reported, per endpoint.
    if (simOverrides.is_object()) {
      for (const auto& [instanceId, table] : simOverrides.items()) {
        if (!table.is_object()) continue;
        auto& entry = merged["midi:" + instanceId];
        const auto si = simSeq.find(instanceId);
        for (const auto& [ep, v] : table.items()) {
          if (!v.is_number()) continue;
          uint64_t seq = 0;
          if (si != simSeq.end()) {
            auto it = si->second.find(ep);
            if (it != si->second.end()) seq = it->second;
          }
          entry[ep] = Val{v.get<float>(), seq};
        }
      }
    }
    // `knownAs` alias fan-out: a wire may reference an alias uuid of a device
    // (a ghost adopted from another profile/composition — see the web's
    // DeviceInstance.knownAs). Duplicate the canonical entry under each alias
    // so those rails read the same values. Canonical entries never lose.
    // Runs BEFORE the control fold so a control alias may name either uuid.
    if (library.is_array()) {
      for (const auto& inst : library) {
        if (!inst.is_object()) continue;
        auto ka = inst.find("knownAs");
        if (ka == inst.end() || !ka->is_array() || ka->empty()) continue;
        auto src = merged.find("midi:" + inst.value("id", std::string()));
        if (src == merged.end()) continue;
        for (const auto& alias : *ka) {
          if (!alias.is_string()) continue;
          const std::string key = "midi:" + alias.get<std::string>();
          if (merged.find(key) == merged.end()) merged[key] = src->second;
        }
      }
    }
    // Control aliases: every endpoint in a group reads the group's most
    // recently written member. An endpoint the device itself never reported
    // is CREATED here — that is what lets a spare controller answer for the
    // desk the moment it is wired, without having been touched.
    for (const auto& group : aliasGroupList) {
      const auto winner = aliasWinner(group, [&](const AliasEndpoint& ep)
                                                 -> std::optional<AliasSample> {
        auto di = merged.find("midi:" + ep.deviceId);
        if (di == merged.end()) return std::nullopt;
        auto fi = di->second.find(ep.field);
        if (fi == di->second.end()) return std::nullopt;
        return AliasSample{fi->second.v, fi->second.seq};
      });
      if (!winner) continue;   // nobody touched this group — stays dormant
      for (const auto& ep : group) {
        merged["midi:" + ep.deviceId][ep.field] = Val{winner->value, winner->seq};
      }
    }

    nlohmann::json out = nlohmann::json::object();
    for (const auto& [key, entry] : merged) {
      if (entry.empty()) continue;
      auto& dst = out[key];
      for (const auto& [ep, val] : entry) dst[ep] = val.v;
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
  // Stamp a write sequence on every override that actually MOVED, so an
  // on-screen drag competes with the hardware in an alias group the same way
  // a real turn does. Untouched overrides keep their sequence; cleared ones
  // are pruned so a re-drag counts as a fresh write.
  for (auto& [instanceId, seqs] : impl_->simSeq) {
    auto next_inst = next.find(instanceId);
    for (auto it = seqs.begin(); it != seqs.end();) {
      const bool gone = next_inst == next.end() || !next_inst->is_object() ||
                        next_inst->find(it->first) == next_inst->end();
      it = gone ? seqs.erase(it) : std::next(it);
    }
  }
  for (const auto& [instanceId, entries] : next.items()) {
    if (!entries.is_object()) continue;
    const auto prev = impl_->simOverrides.find(instanceId);
    auto& seqs = impl_->simSeq[instanceId];
    for (const auto& [ep, v] : entries.items()) {
      if (!v.is_number()) continue;
      const bool moved = prev == impl_->simOverrides.end() || !prev->is_object() ||
                         prev->find(ep) == prev->end() || (*prev)[ep] != v;
      if (moved) seqs[ep] = ++impl_->writeSeq;
    }
  }
  impl_->simOverrides = std::move(next);
  impl_->bump();
}

void MidiHost::setAliases(const std::vector<AliasEdge>& edges) {
  std::lock_guard<std::mutex> lk(impl_->mu);
  std::string key;
  for (const auto& e : edges) {
    key += aliasEndpointKey(e.a);
    key += '\2';
    key += aliasEndpointKey(e.b);
    key += '\3';
  }
  if (key == impl_->aliasKey) return;
  impl_->aliasKey = std::move(key);
  impl_->aliasGroupList = aliasGroups(edges);
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
