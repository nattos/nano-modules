// test_bridge_core.cpp — the client-writable GLOBAL path allowlist.
//
// `set` is the one message that lets a web client write outside its own plugin
// state, so which prefixes it accepts is a real boundary. The web mirrors its
// MIDI device library and its library roots down this way; everything else must
// stay read-only.

#include <catch2/catch_test_macros.hpp>

#include <nlohmann/json.hpp>

#include "bridge/bridge_core.h"

using nlohmann::json;

namespace {

/// What the doc holds at `path` after a client `set`. Null ⇒ the write was
/// rejected (nothing was ever stored there).
json afterSet(bridge::BridgeCore& core, const std::string& path, const json& value) {
  core.handle_message(1, json{{"action", "set"}, {"path", path}, {"value", value}}.dump());
  return core.state_document().get_at(path);
}

}  // namespace

TEST_CASE("the MIDI mirror paths are client-writable", "[bridge_core]") {
  bridge::BridgeCore core;
  const json devices = json::array({{{"id", "d1"}}});
  REQUIRE(afterSet(core, "/global/midi_devices", devices) == devices);
  const json sim = json::object({{"a", 1}});
  REQUIRE(afterSet(core, "/global/midi_sim", sim) == sim);
}

TEST_CASE("library paths are client-writable", "[bridge_core]") {
  // Without this the native side can never resolve a document's media refs:
  // the browser is the only party that knows the user's library roots.
  bridge::BridgeCore core;
  const json rows = json::array({
      {{"id", "L1"}, {"label", "Footage"}, {"absolutePath", "/Volumes/media"}},
  });
  REQUIRE(afterSet(core, "/global/library_paths", rows) == rows);
}

TEST_CASE("other global paths stay read-only", "[bridge_core]") {
  bridge::BridgeCore core;
  // A rejected write leaves the path exactly as it was — which for
  // /global/plugins is the seeded empty array, not null.
  auto rejects = [&](const std::string& path, const json& value) {
    const json before = core.state_document().get_at(path);
    return afterSet(core, path, value) == before;
  };
  // A client must not be able to forge the instance list, the channel table,
  // or anything else the NATIVE side publishes.
  REQUIRE(rejects("/global/plugins", json::array({"forged"})));
  REQUIRE(rejects("/global/channels", json::object({{"1", "x"}})));
  // Plugin state goes through "patch", never "set".
  REQUIRE(rejects("/plugins/abc/state", json::object({{"k", 1}})));
  // A path that merely CONTAINS an allowed name isn't allowed — the check is a
  // prefix match, not a substring one.
  REQUIRE(rejects("/global/x_library_paths", json::array({1})));
}

TEST_CASE("a set with no value is ignored", "[bridge_core]") {
  bridge::BridgeCore core;
  core.handle_message(1, json{{"action", "set"}, {"path", "/global/midi_sim"}}.dump());
  REQUIRE(core.state_document().get_at("/global/midi_sim").is_null());
}
