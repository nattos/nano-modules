#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include "json/json_patch.h"

using json = nlohmann::json;
using namespace json_patch;

// --- resolve_pointer ---

TEST_CASE("resolve_pointer root", "[json_patch]") {
  json doc = {{"a", 1}};
  auto* r = resolve_pointer(doc, "");
  REQUIRE(r != nullptr);
  REQUIRE(*r == doc);
}

TEST_CASE("resolve_pointer simple key", "[json_patch]") {
  json doc = {{"foo", 42}};
  auto* r = resolve_pointer(doc, "/foo");
  REQUIRE(r != nullptr);
  REQUIRE(*r == 42);
}

TEST_CASE("resolve_pointer nested", "[json_patch]") {
  json doc = {{"a", {{"b", {{"c", "deep"}}}}}};
  auto* r = resolve_pointer(doc, "/a/b/c");
  REQUIRE(r != nullptr);
  REQUIRE(*r == "deep");
}

TEST_CASE("resolve_pointer array index", "[json_patch]") {
  json doc = {{"arr", {10, 20, 30}}};
  auto* r = resolve_pointer(doc, "/arr/1");
  REQUIRE(r != nullptr);
  REQUIRE(*r == 20);
}

TEST_CASE("resolve_pointer missing key returns nullptr", "[json_patch]") {
  json doc = {{"a", 1}};
  REQUIRE(resolve_pointer(doc, "/b") == nullptr);
}

TEST_CASE("resolve_pointer escaped tokens", "[json_patch]") {
  json doc = {{"a/b", 1}, {"c~d", 2}};
  REQUIRE(*resolve_pointer(doc, "/a~1b") == 1);
  REQUIRE(*resolve_pointer(doc, "/c~0d") == 2);
}

// --- apply: add ---

TEST_CASE("apply add to object", "[json_patch]") {
  json doc = {{"a", 1}};
  REQUIRE(apply_op(doc, {"add", "/b", 2, {}}));
  REQUIRE(doc["b"] == 2);
}

TEST_CASE("apply add to nested path", "[json_patch]") {
  json doc = {{"a", json::object()}};
  REQUIRE(apply_op(doc, {"add", "/a/x", "hello", {}}));
  REQUIRE(doc["a"]["x"] == "hello");
}

TEST_CASE("apply add to array end", "[json_patch]") {
  json doc = {{"arr", {1, 2}}};
  REQUIRE(apply_op(doc, {"add", "/arr/-", 3, {}}));
  REQUIRE(doc["arr"] == json({1, 2, 3}));
}

TEST_CASE("apply add to array middle", "[json_patch]") {
  json doc = {{"arr", {1, 3}}};
  REQUIRE(apply_op(doc, {"add", "/arr/1", 2, {}}));
  REQUIRE(doc["arr"] == json({1, 2, 3}));
}

TEST_CASE("apply add replaces root", "[json_patch]") {
  json doc = 42;
  REQUIRE(apply_op(doc, {"add", "", "replaced", {}}));
  REQUIRE(doc == "replaced");
}

// --- apply: remove ---

TEST_CASE("apply remove from object", "[json_patch]") {
  json doc = {{"a", 1}, {"b", 2}};
  REQUIRE(apply_op(doc, {"remove", "/a", {}, {}}));
  REQUIRE(!doc.contains("a"));
  REQUIRE(doc["b"] == 2);
}

TEST_CASE("apply remove from array", "[json_patch]") {
  json doc = {{"arr", {1, 2, 3}}};
  REQUIRE(apply_op(doc, {"remove", "/arr/1", {}, {}}));
  REQUIRE(doc["arr"] == json({1, 3}));
}

TEST_CASE("apply remove missing key fails", "[json_patch]") {
  json doc = {{"a", 1}};
  REQUIRE_FALSE(apply_op(doc, {"remove", "/b", {}, {}}));
}

// --- apply: replace ---

TEST_CASE("apply replace existing", "[json_patch]") {
  json doc = {{"a", 1}};
  REQUIRE(apply_op(doc, {"replace", "/a", 99, {}}));
  REQUIRE(doc["a"] == 99);
}

TEST_CASE("apply replace missing fails", "[json_patch]") {
  json doc = {{"a", 1}};
  REQUIRE_FALSE(apply_op(doc, {"replace", "/b", 99, {}}));
}

// --- apply: test ---

TEST_CASE("apply test succeeds on match", "[json_patch]") {
  json doc = {{"a", 1}};
  REQUIRE(apply_op(doc, {"test", "/a", 1, {}}));
}

TEST_CASE("apply test fails on mismatch", "[json_patch]") {
  json doc = {{"a", 1}};
  REQUIRE_FALSE(apply_op(doc, {"test", "/a", 2, {}}));
}

// --- apply: move ---

TEST_CASE("apply move between keys", "[json_patch]") {
  json doc = {{"a", 1}, {"b", 2}};
  REQUIRE(apply_op(doc, {"move", "/c", {}, "/a"}));
  REQUIRE(!doc.contains("a"));
  REQUIRE(doc["c"] == 1);
}

// --- apply: copy ---

TEST_CASE("apply copy", "[json_patch]") {
  json doc = {{"a", {1, 2, 3}}};
  REQUIRE(apply_op(doc, {"copy", "/b", {}, "/a"}));
  REQUIRE(doc["b"] == json({1, 2, 3}));
  REQUIRE(doc["a"] == json({1, 2, 3})); // original unchanged
}

// --- apply_patch (multiple ops) ---

TEST_CASE("apply_patch multiple ops", "[json_patch]") {
  json doc = {{"a", 1}};
  std::vector<PatchOp> ops = {
    {"add", "/b", 2, {}},
    {"replace", "/a", 10, {}},
    {"add", "/c", "hello", {}},
  };
  REQUIRE(apply_patch(doc, ops));
  REQUIRE(doc["a"] == 10);
  REQUIRE(doc["b"] == 2);
  REQUIRE(doc["c"] == "hello");
}

TEST_CASE("apply_patch stops on failure", "[json_patch]") {
  json doc = {{"a", 1}};
  std::vector<PatchOp> ops = {
    {"add", "/b", 2, {}},
    {"remove", "/nonexistent", {}, {}}, // fails
    {"add", "/c", 3, {}},              // not reached
  };
  REQUIRE_FALSE(apply_patch(doc, ops));
  REQUIRE(doc.contains("b")); // first op applied
}

// --- parse / serialize ---

TEST_CASE("parse_patch from JSON array", "[json_patch]") {
  auto j = json::parse(R"([
    {"op": "add", "path": "/foo", "value": 42},
    {"op": "remove", "path": "/bar"},
    {"op": "move", "path": "/dst", "from": "/src"}
  ])");
  auto ops = parse_patch(j);
  REQUIRE(ops.size() == 3);
  REQUIRE(ops[0].op == "add");
  REQUIRE(ops[0].path == "/foo");
  REQUIRE(ops[0].value == 42);
  REQUIRE(ops[1].op == "remove");
  REQUIRE(ops[2].op == "move");
  REQUIRE(ops[2].from == "/src");
}

TEST_CASE("serialize_patch round-trips", "[json_patch]") {
  std::vector<PatchOp> ops = {
    {"replace", "/x", 5, {}},
    {"add", "/y", "hello", {}},
  };
  auto j = serialize_patch(ops);
  auto parsed = parse_patch(j);
  REQUIRE(parsed.size() == 2);
  REQUIRE(parsed[0].op == "replace");
  REQUIRE(parsed[0].value == 5);
  REQUIRE(parsed[1].op == "add");
  REQUIRE(parsed[1].value == "hello");
}

// --- diff ---

TEST_CASE("diff identical documents produces empty patch", "[json_patch]") {
  json doc = {{"a", 1}, {"b", "hello"}};
  auto ops = diff(doc, doc);
  REQUIRE(ops.empty());
}

TEST_CASE("diff added key", "[json_patch]") {
  json before = {{"a", 1}};
  json after = {{"a", 1}, {"b", 2}};
  auto ops = diff(before, after);
  REQUIRE(ops.size() == 1);
  REQUIRE(ops[0].op == "add");
  REQUIRE(ops[0].path == "/b");
  REQUIRE(ops[0].value == 2);
}

TEST_CASE("diff removed key", "[json_patch]") {
  json before = {{"a", 1}, {"b", 2}};
  json after = {{"a", 1}};
  auto ops = diff(before, after);
  REQUIRE(ops.size() == 1);
  REQUIRE(ops[0].op == "remove");
  REQUIRE(ops[0].path == "/b");
}

TEST_CASE("diff changed value", "[json_patch]") {
  json before = {{"a", 1}};
  json after = {{"a", 99}};
  auto ops = diff(before, after);
  REQUIRE(ops.size() == 1);
  REQUIRE(ops[0].op == "replace");
  REQUIRE(ops[0].path == "/a");
  REQUIRE(ops[0].value == 99);
}

TEST_CASE("diff nested changes", "[json_patch]") {
  json before = {{"a", {{"x", 1}, {"y", 2}}}};
  json after = {{"a", {{"x", 1}, {"y", 99}}}};
  auto ops = diff(before, after);
  REQUIRE(ops.size() == 1);
  REQUIRE(ops[0].path == "/a/y");
  REQUIRE(ops[0].value == 99);
}

TEST_CASE("diff produces patch that transforms before into after", "[json_patch]") {
  json before = {{"x", 1}, {"y", {{"nested", true}}}, {"z", {1, 2, 3}}};
  json after = {{"x", 42}, {"y", {{"nested", false}, {"added", "new"}}}, {"w", "hello"}};
  auto ops = diff(before, after);
  json result = before;
  REQUIRE(apply_patch(result, ops));
  REQUIRE(result == after);
}

TEST_CASE("diff type change", "[json_patch]") {
  json before = {{"a", 42}};
  json after = {{"a", "string now"}};
  auto ops = diff(before, after);
  REQUIRE(ops.size() == 1);
  REQUIRE(ops[0].op == "replace");
}
