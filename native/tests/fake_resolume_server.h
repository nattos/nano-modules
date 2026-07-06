// fake_resolume_server.h — a minimal stand-in for Resolume's WebSocket API, so
// the shared server (and its InstanceLocator) can be exercised headlessly with
// no live Resolume.
//
// Mirrors the live-captured protocol (see scratchpad/SPIKE_FINDINGS.md):
//   - On client connect it pushes the full composition state (a top-level JSON
//     object with `layers`, no `type` field) — exactly how Resolume behaves.
//   - It answers `{"action":"subscribe","parameter":"/parameter/by-id/<id>"}`
//     with a `parameter_subscribed` frame carrying that param's value.
//   - It records `set` / `trigger` actions (substrate for Phase 2 fork tests).
//
// Point the dylib at it with NANO_RESOLUME_URL=ws://127.0.0.1:<port>/api/v1.

#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace ix {
class WebSocket;
class WebSocketServer;
}  // namespace ix

namespace bridge {

class FakeResolumeServer {
public:
  FakeResolumeServer();
  ~FakeResolumeServer();

  /// Set the composition JSON served on connect (a full CompositionState —
  /// top-level object with `layers`, no `type`). Rebuilds the by-id param index.
  void set_composition(const nlohmann::json& composition);

  bool start(int port);
  void stop();
  int port() const { return port_; }

  struct SetRecord {
    int64_t id = 0;
    std::string path;
    nlohmann::json value;
  };
  std::vector<SetRecord> recorded_sets() const;
  std::vector<std::string> recorded_triggers() const;

  /// Build a canned composition mirroring the live capture: one NanoBarrel per
  /// layer (on `clips[0]`), each with an inline `nanobarrel://config?<base64>`
  /// blob carrying the corresponding UUID.
  static nlohmann::json make_default_composition(const std::vector<std::string>& uuids);

  // --- NanoLooper Ch scene markers (headless twins of the live setup) ---

  /// One marker-tagged clip's parameters. Mirrors what we observed live:
  /// `channel` rides a normalized `Channel` ParamRange; `uuid`+`channel`+`name`
  /// ride the inline `config` blob. `empty_config` reproduces the pre-fix bug
  /// where Resolume broadcast `config: ""` (a value the plugin set internally is
  /// not re-broadcast) — so the server/web could not key the clip's thumbnail.
  struct MarkerSpec {
    std::string uuid;
    int channel = 1;               // 1-based, as the user picks it
    std::string name;              // cosmetic label (may be empty)
    std::string connected = "Disconnected";  // ParamState value
    bool empty_config = false;     // model the broken (empty-blob) broadcast
  };

  /// Build a single NanoLooper Ch effect node with the real broadcast shape
  /// (inline `config` ParamString — the FF_TYPE_TEXT fix — plus Channel/Name/
  /// Opacity). `next_id` allocates unique param ids.
  static nlohmann::json make_marker_effect(const MarkerSpec& spec, int64_t& next_id);

  /// A clip `thumbnail` object mirroring Resolume's shape. Solid-color/generator
  /// clips report `is_default:true` with the `/thumbnail/dummy` path (as seen
  /// live) — the reason Resolume's own thumbnails aren't a usable source.
  static nlohmann::json make_thumbnail(int64_t& next_id, bool is_default = true);

  /// A composition placing one marker-tagged clip per spec (one clip per layer),
  /// each with a thumbnail + connected state — the headless twin of the live
  /// marker setup, for exercising channel resolution + `/global/channels`.
  static nlohmann::json make_marker_composition(const std::vector<MarkerSpec>& markers);

  /// Two layers, each with a content clip + an EMPTY clip (the eviction target):
  ///   layer 1: "Red" (Normal, marker Channel 1) at clips[0], empty at clips[1]
  ///   layer 2: "Blue" (Piano, marker Channel 2) at clips[0], empty at clips[1]
  /// The headless twin of the live piano-spike rig, for exercising the
  /// ClipLauncher reconciler against the modelled trigger latches (below).
  static nlohmann::json make_trigger_test_composition();

  /// Seed a clip's latched trigger state (test hook), so recovery from a
  /// PRE-EXISTING stuck clip — e.g. a user click in Resolume — is deterministic
  /// without relying on timing. `connect_path` is the clip's connect action.
  /// stuck_on also forces the clip Connected; the reconciler must re-arm.
  void seed_stuck(const std::string& connect_path, bool stuck_on, bool stuck_off);

  /// Current modelled connected state of a clip ("Empty"/"Disconnected"/
  /// "Connected"), by its connect action path. "" if the path is unknown.
  std::string clip_connected(const std::string& connect_path) const;

private:
  void handle_message(ix::WebSocket& ws, const std::string& msg);

  struct ParamInfo {
    nlohmann::json value;
    std::string valuetype;
    std::string path;
  };

  // Per-clip runtime state used to MODEL Resolume's trigger latches (see
  // piano_spike_FINDINGS.md), keyed by the clip's connect action path:
  //  - a Normal clip ignores connect:false (turns off only by eviction) and,
  //    after an eviction, drops a plain connect (stuck_off) until re-armed;
  //  - a Piano clip stuck_on ignores disconnects until re-armed.
  struct ClipRuntime {
    int layer = -1;
    int64_t connected_id = 0;
    std::string style;          // "Piano" → piano; anything else → normal
    bool has_content = false;   // false for an empty clip (eviction target)
    std::string connected = "Disconnected";
    bool stuck_on = false;      // piano: disconnect ignored
    bool stuck_off = false;     // normal: connect dropped (post-eviction latch)
    bool is_piano() const { return style == "Piano"; }
  };

  // Rebuild clip_rt_ from composition_ (called under mu_ from set_composition).
  void build_clip_runtime();
  // Apply a modelled connected-state change to composition_/params index and
  // queue a parameter_update to broadcast (collected, sent outside the lock).
  void set_connected(ClipRuntime& c, const std::string& value,
                     std::vector<std::pair<int64_t, std::string>>& out_changes);
  // Broadcast a parameter_update frame to every connected client.
  void broadcast_param_update(int64_t id, const std::string& value);

  std::unique_ptr<ix::WebSocketServer> server_;
  int port_ = 0;
  bool running_ = false;

  mutable std::mutex mu_;
  nlohmann::json composition_;
  std::string composition_str_;
  std::map<int64_t, ParamInfo> params_by_id_;
  std::map<std::string, ClipRuntime> clip_rt_;  // keyed by connect action path
  std::vector<SetRecord> sets_;
  std::vector<std::string> triggers_;
};

}  // namespace bridge
