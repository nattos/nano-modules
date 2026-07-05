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

private:
  void handle_message(ix::WebSocket& ws, const std::string& msg);

  struct ParamInfo {
    nlohmann::json value;
    std::string valuetype;
    std::string path;
  };

  std::unique_ptr<ix::WebSocketServer> server_;
  int port_ = 0;
  bool running_ = false;

  mutable std::mutex mu_;
  nlohmann::json composition_;
  std::string composition_str_;
  std::map<int64_t, ParamInfo> params_by_id_;
  std::vector<SetRecord> sets_;
  std::vector<std::string> triggers_;
};

}  // namespace bridge
