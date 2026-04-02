#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include "bridge/state_document.h"

using json = nlohmann::json;
using bridge::StateDocument;
using bridge::PluginMetadata;
using bridge::ConsoleEntry;

TEST_CASE("empty document has correct structure", "[state_document]") {
  StateDocument doc;
  auto d = doc.document();
  REQUIRE(d.contains("global"));
  REQUIRE(d["global"].contains("plugins"));
  REQUIRE(d["global"]["plugins"].is_array());
  REQUIRE(d["global"]["plugins"].empty());
  REQUIRE(d.contains("plugins"));
  REQUIRE(d["plugins"].is_object());
}

TEST_CASE("register_plugin adds to global listing with id@N key", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 2, 3});

  REQUIRE(key == "com.test.foo@0");
  auto d = doc.document();
  REQUIRE(d["global"]["plugins"].size() == 1);
  REQUIRE(d["global"]["plugins"][0]["key"] == "com.test.foo@0");
  REQUIRE(d["global"]["plugins"][0]["metadata"]["id"] == "com.test.foo");
  REQUIRE(d["global"]["plugins"][0]["metadata"]["version"]["major"] == 1);
  REQUIRE(d["global"]["plugins"][0]["metadata"]["version"]["minor"] == 2);
  REQUIRE(d["global"]["plugins"][0]["metadata"]["version"]["patch"] == 3);
}

TEST_CASE("register_plugin creates plugin instance", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  auto d = doc.document();

  REQUIRE(d["plugins"].contains(key));
  REQUIRE(d["plugins"][key].contains("console"));
  REQUIRE(d["plugins"][key]["console"].is_array());
  REQUIRE(d["plugins"][key].contains("state"));
  REQUIRE(d["plugins"][key]["state"].is_object());
}

TEST_CASE("register_plugin emits patches", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  auto patches = doc.drain_patches();

  REQUIRE(patches.size() == 2);
  REQUIRE(patches[0].op == "add");
  REQUIRE(patches[0].path == "/global/plugins/-");
  REQUIRE(patches[1].op == "add");
  REQUIRE(patches[1].path == "/plugins/" + key);
}

TEST_CASE("multiple instances of same type get incrementing suffix", "[state_document]") {
  StateDocument doc;
  auto k0 = doc.register_plugin({"com.test.foo", 1, 0, 0});
  auto k1 = doc.register_plugin({"com.test.foo", 1, 0, 0});
  auto k2 = doc.register_plugin({"com.test.foo", 1, 0, 0});

  REQUIRE(k0 == "com.test.foo@0");
  REQUIRE(k1 == "com.test.foo@1");
  REQUIRE(k2 == "com.test.foo@2");

  auto d = doc.document();
  REQUIRE(d["global"]["plugins"].size() == 3);
  REQUIRE(d["plugins"].contains(k0));
  REQUIRE(d["plugins"].contains(k1));
  REQUIRE(d["plugins"].contains(k2));
}

TEST_CASE("different plugin types have independent counters", "[state_document]") {
  StateDocument doc;
  auto ka = doc.register_plugin({"com.a", 1, 0, 0});
  auto kb = doc.register_plugin({"com.b", 1, 0, 0});
  auto ka2 = doc.register_plugin({"com.a", 1, 0, 0});

  REQUIRE(ka == "com.a@0");
  REQUIRE(kb == "com.b@0");
  REQUIRE(ka2 == "com.a@1");
}

TEST_CASE("unregister_plugin removes from listing and instances", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.drain_patches();

  doc.unregister_plugin(key);
  auto d = doc.document();

  REQUIRE(d["global"]["plugins"].empty());
  REQUIRE_FALSE(d["plugins"].contains(key));

  auto patches = doc.drain_patches();
  REQUIRE(patches.size() == 2);
}

TEST_CASE("log adds console entries", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.drain_patches();

  doc.log(key, {1.5, "log", "hello world"});
  doc.log(key, {2.0, "warn", json({{"code", 42}})});

  auto d = doc.document();
  auto& console = d["plugins"][key]["console"];
  REQUIRE(console.size() == 2);
  REQUIRE(console[0]["ts"] == 1.5);
  REQUIRE(console[0]["level"] == "log");
  REQUIRE(console[0]["data"] == "hello world");
  REQUIRE(console[1]["level"] == "warn");
  REQUIRE(console[1]["data"]["code"] == 42);
}

TEST_CASE("log caps at MAX_CONSOLE_ENTRIES", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.drain_patches();

  for (int i = 0; i < 120; i++) {
    doc.log(key, {(double)i, "log", i});
  }

  auto d = doc.document();
  auto& console = d["plugins"][key]["console"];
  REQUIRE(console.size() == StateDocument::MAX_CONSOLE_ENTRIES);
  REQUIRE(console[0]["data"] == 20);
}

TEST_CASE("log emits patches", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.drain_patches();

  doc.log(key, {1.0, "log", "test"});
  auto patches = doc.drain_patches();

  REQUIRE(patches.size() == 1);
  REQUIRE(patches[0].op == "add");
  REQUIRE(patches[0].path == "/plugins/" + key + "/console/-");
}

TEST_CASE("set_plugin_state replaces state and emits diff", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.drain_patches();

  doc.set_plugin_state(key, {{"x", 10}, {"y", 20}});

  auto state = doc.get_plugin_state(key);
  REQUIRE(state["x"] == 10);
  REQUIRE(state["y"] == 20);

  auto patches = doc.drain_patches();
  REQUIRE(!patches.empty());
  for (auto& p : patches) {
    REQUIRE(p.path.find("/plugins/" + key + "/state") == 0);
  }
}

TEST_CASE("set_plugin_state diff is minimal", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.set_plugin_state(key, {{"x", 1}, {"y", 2}, {"z", 3}});
  doc.drain_patches();

  doc.set_plugin_state(key, {{"x", 99}, {"y", 2}, {"z", 3}});
  auto patches = doc.drain_patches();

  REQUIRE(patches.size() == 1);
  REQUIRE(patches[0].op == "replace");
  REQUIRE(patches[0].path == "/plugins/" + key + "/state/x");
  REQUIRE(patches[0].value == 99);
}

TEST_CASE("apply_client_patch modifies state", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.set_plugin_state(key, {{"x", 1}});
  doc.drain_patches();

  std::vector<json_patch::PatchOp> client_ops = {
    {"replace", "/x", 42, {}},
    {"add", "/new_field", "hello", {}},
  };

  auto effective = doc.apply_client_patch(key, client_ops);
  REQUIRE(effective.size() == 2);

  auto state = doc.get_plugin_state(key);
  REQUIRE(state["x"] == 42);
  REQUIRE(state["new_field"] == "hello");

  REQUIRE(effective[0].path == "/plugins/" + key + "/state/x");
  REQUIRE(effective[1].path == "/plugins/" + key + "/state/new_field");
}

TEST_CASE("apply_client_patch invalid op is skipped", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.set_plugin_state(key, {{"x", 1}});
  doc.drain_patches();

  std::vector<json_patch::PatchOp> client_ops = {
    {"remove", "/nonexistent", {}, {}},
    {"replace", "/x", 99, {}},
  };

  auto effective = doc.apply_client_patch(key, client_ops);
  REQUIRE(effective.size() == 1);
  REQUIRE(doc.get_plugin_state(key)["x"] == 99);
}

TEST_CASE("drain_patches clears pending", "[state_document]") {
  StateDocument doc;
  doc.register_plugin({"com.test.foo", 1, 0, 0});

  auto p1 = doc.drain_patches();
  REQUIRE(!p1.empty());

  auto p2 = doc.drain_patches();
  REQUIRE(p2.empty());
}

TEST_CASE("get_at retrieves subtree", "[state_document]") {
  StateDocument doc;
  auto key = doc.register_plugin({"com.test.foo", 1, 0, 0});
  doc.set_plugin_state(key, {{"x", 42}});

  auto val = doc.get_at("/plugins/" + key + "/state/x");
  REQUIRE(val == 42);

  auto global = doc.get_at("/global");
  REQUIRE(global.contains("plugins"));
}

TEST_CASE("multiple plugin types coexist", "[state_document]") {
  StateDocument doc;
  auto k1 = doc.register_plugin({"com.a", 1, 0, 0});
  auto k2 = doc.register_plugin({"com.b", 2, 0, 0});

  doc.set_plugin_state(k1, {{"a", 1}});
  doc.set_plugin_state(k2, {{"b", 2}});

  REQUIRE(doc.get_plugin_state(k1)["a"] == 1);
  REQUIRE(doc.get_plugin_state(k2)["b"] == 2);

  auto d = doc.document();
  REQUIRE(d["global"]["plugins"].size() == 2);
}
