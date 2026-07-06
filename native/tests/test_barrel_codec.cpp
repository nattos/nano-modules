// test_barrel_codec.cpp — the barrel config codec: uuid-plaintext + zlib(sketch)
// on-wire form, backward-compat with the legacy base64-JSON blobs, and the
// no-decompress uuid fast path used by the InstanceLocator de-dup pass.

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include "plugin/nano_barrel/barrel_codec.h"

using nlohmann::json;

namespace {
// A realistically-compressible sketch envelope (repeated keys / module names /
// all-zero version blocks — exactly what the live composition carries).
std::string make_envelope(const std::string& uuid) {
  json sketch = {
      {"anchor", nullptr},
      {"chain", json::array()},
      {"instances", json::object()},
  };
  for (int i = 0; i < 6; ++i) {
    std::string key = "virtual_effect@" + std::to_string(1783150000000LL + i);
    sketch["chain"].push_back({{"instance_key", key},
                               {"module_type", "color.tone.auto_level"},
                               {"type", "module"}});
    sketch["instances"][key] = {
        {"module_type", "color.tone.auto_level"},
        {"state", {{"equalize", 0.87}, {"median_pull", 0.57}, {"__bypass__", false}}},
        {"version", {{"effect", {0, 0, 0}}, {"module", {0, 0, 0}}}},
    };
  }
  return json({{"uuid", uuid}, {"sketch", sketch}}).dump();
}
}  // namespace

TEST_CASE("wrap/unwrap round-trips the envelope", "[barrel_codec]") {
  const std::string uuid = "AC351993-FBF9-465F-90BA-9F7F456DAFDE";
  std::string env = make_envelope(uuid);

  std::string wrapped = barrel_codec::wrap_config(env);
  REQUIRE(wrapped.rfind("nanobarrel://config?", 0) == 0);

  std::string back = barrel_codec::unwrap_config(wrapped);
  json a = json::parse(env), b = json::parse(back);
  CHECK(b["uuid"] == uuid);
  CHECK(b["sketch"] == a["sketch"]);  // sketch survives compress→decompress
}

TEST_CASE("new form carries the uuid as plaintext ahead of the sketch", "[barrel_codec]") {
  const std::string uuid = "3810B9B2-6485-4513-BE6A-C31A118326D0";
  std::string wrapped = barrel_codec::wrap_config(make_envelope(uuid));

  // The uuid reads back without decompressing — the de-dup hot path.
  CHECK(barrel_codec::config_uuid(wrapped) == uuid);
  // It really is in the plaintext prefix (before the '~'), not the payload.
  auto sep = wrapped.find('~');
  REQUIRE(sep != std::string::npos);
  CHECK(wrapped.substr(std::strlen("nanobarrel://config?"),
                       sep - std::strlen("nanobarrel://config?")) == uuid);
}

TEST_CASE("compression shrinks the blob substantially", "[barrel_codec]") {
  std::string env = make_envelope("BFBFEB4B-6F7E-4C38-92F6-B58D203EC238");
  std::string legacy = std::string("nanobarrel://config?") + barrel_codec::base64_encode(env);
  std::string wrapped = barrel_codec::wrap_config(env);
  // The compressible, repetitive sketch should pack to well under half.
  CHECK(wrapped.size() < legacy.size() / 2);
}

TEST_CASE("legacy base64-JSON blobs still decode", "[barrel_codec]") {
  const std::string uuid = "609E8929-8BE5-484E-B5A0-01D4769D494A";
  std::string env = make_envelope(uuid);
  // A pre-compression blob: uncompressed base64 of the envelope, no '~'.
  std::string legacy = std::string("nanobarrel://config?") + barrel_codec::base64_encode(env);

  CHECK(barrel_codec::config_uuid(legacy) == uuid);  // no '~' → legacy path
  json back = json::parse(barrel_codec::unwrap_config(legacy));
  CHECK(back["uuid"] == uuid);
  CHECK(back["sketch"] == json::parse(env)["sketch"]);
}

TEST_CASE("re-mint under a fresh uuid preserves the sketch (fork path)", "[barrel_codec]") {
  std::string env = make_envelope("11111111-1111-1111-1111-111111111111");
  std::string sketch = json::parse(barrel_codec::unwrap_config(barrel_codec::wrap_config(env)))["sketch"].dump();

  // Mirror the InstanceLocator fork: rebuild the envelope with a new uuid.
  const std::string new_uuid = "22222222-2222-2222-2222-222222222222";
  json reminted = {{"sketch", json::parse(sketch)}, {"uuid", new_uuid}};
  std::string wrapped = barrel_codec::wrap_config(reminted.dump());

  CHECK(barrel_codec::config_uuid(wrapped) == new_uuid);
  CHECK(json::parse(barrel_codec::unwrap_config(wrapped))["sketch"] == json::parse(sketch));
}

TEST_CASE("garbage input fails closed", "[barrel_codec]") {
  CHECK(barrel_codec::config_uuid("not a barrel blob").empty());
  CHECK(barrel_codec::unwrap_config("not a barrel blob").empty());
  // A new-form blob whose compressed payload is garbage must not crash: it
  // yields the uuid plus an empty sketch object.
  std::string back = barrel_codec::unwrap_config("nanobarrel://config?SOMEUUID~zzzz");
  json j = json::parse(back);
  CHECK(j["uuid"] == "SOMEUUID");
  CHECK(j["sketch"].is_object());
}
