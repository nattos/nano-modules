// test_wire_types.cpp — resolving `any` (polymorphic) ports to a concrete class.
//
// Replays the SHARED fixture (web/test/fixtures/wire-type-cases.json) that
// web/src/state/schema-channels.test.ts also replays, so the one rule duplicated
// across the C++/TS boundary — wire_types::resolveWireDef and its
// resolveWireKind twin — cannot drift. The executor decides what rail a wire
// becomes; the editor decides what to draw and what to allow. Disagreement means
// the editor shows a connection the engine dropped, or refuses one it would have
// made, and neither surfaces as a test failure anywhere else.
//
// Pure logic — no GPU, no bundles, no executor.

#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

#include "sketch/wire_types.h"

using nlohmann::json;

namespace {

// The fixture's `expected` is the WEB-side vocabulary (a WireKind), which groups
// object/array as "struct" and uses null for unresolvable. Map the C++ type tag
// into it so both sides assert against the same literal.
std::string kindOf(const std::string& type) {
  if (type == "float" || type == "texture") return type;
  if (type == "object" || type == "array") return "struct";
  return "";   // "" == the fixture's null
}

}  // namespace

TEST_CASE("wire type resolution matches the shared fixture", "[wire_types]") {
  std::ifstream f(WIRE_TYPE_FIXTURE);
  REQUIRE(f.good());
  json fx;
  f >> fx;
  REQUIRE(fx.contains("cases"));
  const json& schemas = fx.at("schemas");

  for (const auto& c : fx.at("cases")) {
    const std::string name = c.value("name", std::string());
    INFO("case: " << name);

    // instance key -> module type -> schema fields, straight off the fixture.
    const json& chain = c.at("chain");
    wire_types::SchemaFn schemaFor = [&](const std::string& key) -> const json* {
      auto it = chain.find(key);
      if (it == chain.end()) return nullptr;
      auto sit = schemas.find(it->get<std::string>());
      return sit == schemas.end() ? nullptr : &(*sit);
    };

    const json& q = c.at("query");
    const std::string got = kindOf(wire_types::resolveWireType(
        schemaFor, c.at("wires"),
        q.at("instanceKey").get<std::string>(),
        q.at("field").get<std::string>()));

    const json& exp = c.at("expected");
    const std::string want = exp.is_null() ? std::string() : exp.get<std::string>();
    INFO("expected '" << want << "' got '" << got << "'");
    CHECK(got == want);
  }
}
