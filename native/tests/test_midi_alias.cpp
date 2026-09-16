// test_midi_alias.cpp — control-alias grouping + last-touched resolution.
//
// Lock-step twin of web/src/midi/alias-groups.test.ts: the same cases, the
// same expected group ordering and the same sequence tie-break, because both
// hosts must resolve an alias identically or a sketch would read one value in
// the editor and another in the barrel.

#include <catch2/catch_test_macros.hpp>

#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "midi/midi_alias.h"

using nlohmann::json;
using nano_midi::AliasEdge;
using nano_midi::AliasEndpoint;
using nano_midi::AliasSample;

namespace {

AliasEndpoint ep(std::string device, std::string field) {
  return AliasEndpoint{std::move(device), std::move(field)};
}

AliasEdge edge(AliasEndpoint a, AliasEndpoint b) {
  return AliasEdge{std::move(a), std::move(b)};
}

/// 'd1/b0/e00/turn' per member — the readable form the assertions compare.
std::vector<std::string> keys(const std::vector<AliasEndpoint>& group) {
  std::vector<std::string> out;
  for (const auto& e : group) out.push_back(e.deviceId + "/" + e.field);
  return out;
}

}  // namespace

TEST_CASE("collectAliasEdges reads device→device wires out of a sketch", "[midi_alias]") {
  const json sketch = json::parse(R"({
    "chain": [{ "type": "module", "module_type": "video.bc", "instance_key": "bc" }],
    "wires": [
      { "id": "w1", "src": { "instanceKey": "midi:dev-1", "field": "b0/e05/turn" },
        "dest": { "instanceKey": "bc", "field": "brightness" } },
      { "id": "a1", "src": { "instanceKey": "midi:dev-1", "field": "b0/e05/turn" },
        "dest": { "instanceKey": "midi:dev-2", "field": "b0/e05/turn" } },
      { "id": "a2", "src": { "instanceKey": "midi:dev-2", "field": "b0/e05/turn" },
        "dest": { "instanceKey": "midi:dev-1", "field": "b0/e05/turn" } },
      { "id": "a3", "src": { "instanceKey": "midi:dev-1", "field": "b1/e00/press" },
        "dest": { "instanceKey": "midi:dev-1", "field": "b1/e00/press" } },
      { "id": "w2", "src": { "instanceKey": "lfo", "field": "output" },
        "dest": { "instanceKey": "bc", "field": "contrast" } }
    ]
  })");
  const auto edges = nano_midi::collectAliasEdges(sketch);
  // The modulation wires are ignored, the mirrored duplicate is deduped, and
  // the self-alias is dropped.
  REQUIRE(edges.size() == 1);
  CHECK(edges[0].a == ep("dev-1", "b0/e05/turn"));
  CHECK(edges[0].b == ep("dev-2", "b0/e05/turn"));

  CHECK(nano_midi::collectAliasEdges(json::object()).empty());
  CHECK(nano_midi::collectAliasEdges(json::parse(R"({"wires": []})")).empty());
}

TEST_CASE("aliasGroups builds undirected components", "[midi_alias]") {
  SECTION("a pair") {
    const auto groups = nano_midi::aliasGroups(
        {edge(ep("d1", "b0/e00/turn"), ep("d2", "b0/e00/turn"))});
    REQUIRE(groups.size() == 1);
    CHECK(keys(groups[0]) == std::vector<std::string>{"d1/b0/e00/turn", "d2/b0/e00/turn"});
  }

  SECTION("a chain merges into one group") {
    const auto groups = nano_midi::aliasGroups({
        edge(ep("d1", "x"), ep("d2", "x")),
        edge(ep("d2", "x"), ep("d3", "x")),
    });
    REQUIRE(groups.size() == 1);
    CHECK(keys(groups[0]) == std::vector<std::string>{"d1/x", "d2/x", "d3/x"});
  }

  SECTION("unrelated pairs stay apart") {
    const auto groups = nano_midi::aliasGroups({
        edge(ep("d1", "x"), ep("d2", "x")),
        edge(ep("d1", "y"), ep("d2", "y")),
    });
    REQUIRE(groups.size() == 2);
    CHECK(keys(groups[0]) == std::vector<std::string>{"d1/x", "d2/x"});
    CHECK(keys(groups[1]) == std::vector<std::string>{"d1/y", "d2/y"});
  }

  SECTION("self-edges produce no group") {
    CHECK(nano_midi::aliasGroups({edge(ep("d1", "x"), ep("d1", "x"))}).empty());
  }

  SECTION("edge order does not change the result") {
    std::vector<AliasEdge> edges{
        edge(ep("d3", "x"), ep("d1", "x")),
        edge(ep("d2", "x"), ep("d3", "x")),
        edge(ep("d9", "y"), ep("d8", "y")),
    };
    const auto a = nano_midi::aliasGroups(edges);
    std::reverse(edges.begin(), edges.end());
    const auto b = nano_midi::aliasGroups(edges);
    REQUIRE(a.size() == b.size());
    for (size_t i = 0; i < a.size(); ++i) CHECK(keys(a[i]) == keys(b[i]));
  }
}

TEST_CASE("aliasWinner takes the most recently written member", "[midi_alias]") {
  const std::vector<AliasEndpoint> group{
      ep("desk", "b0/e00/turn"), ep("spare", "b0/e00/turn")};
  const auto table = [](std::optional<AliasSample> desk, std::optional<AliasSample> spare) {
    return [desk, spare](const AliasEndpoint& e) {
      return e.deviceId == "desk" ? desk : spare;
    };
  };

  SECTION("the later write wins") {
    const auto w = nano_midi::aliasWinner(
        group, table(AliasSample{0.2f, 7}, AliasSample{0.9f, 3}));
    REQUIRE(w);
    CHECK(w->value == 0.2f);
  }

  SECTION("the spare takes over once the desk stops writing") {
    const auto w = nano_midi::aliasWinner(
        group, table(AliasSample{0.2f, 7}, AliasSample{0.9f, 8}));
    REQUIRE(w);
    CHECK(w->value == 0.9f);
  }

  SECTION("one member with a value is enough") {
    const auto w = nano_midi::aliasWinner(
        group, table(std::nullopt, AliasSample{0.5f, 1}));
    REQUIRE(w);
    CHECK(w->value == 0.5f);
  }

  SECTION("an untouched group resolves to nothing — the wires stay dormant") {
    CHECK_FALSE(nano_midi::aliasWinner(group, table(std::nullopt, std::nullopt)));
  }

  SECTION("a sequence tie breaks on endpoint key, so both hosts agree") {
    const auto w = nano_midi::aliasWinner(
        group, table(AliasSample{0.2f, 4}, AliasSample{0.9f, 4}));
    REQUIRE(w);
    CHECK(w->value == 0.2f);   // "desk\0…" < "spare\0…"
  }
}

TEST_CASE("aliasEndpointKey cannot collide across the join", "[midi_alias]") {
  CHECK(nano_midi::aliasEndpointKey("a", "b/c") != nano_midi::aliasEndpointKey("a/b", "c"));
}
