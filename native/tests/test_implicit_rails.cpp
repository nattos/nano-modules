// test_implicit_rails.cpp — WHICH field types get an implicit rail.
//
// The augmenter's rule is positional: a structured input with no explicit read
// tap takes the nearest compatible producer ABOVE it. That is safe exactly as
// far as "compatible" is meaningful. A composite's shape is specific — a
// particles buffer matches a particles consumer and nothing else. A bare
// float3 matches every other float3 in the tree (a tint, a gradient stop, a
// position, a scale), so the same rule over vecs connects fields that merely
// share an arity.
//
// Vecs were listed as structured from the start and stayed inert only because
// nothing published one; mod.source.color became the first vec producer and
// the rule woke up, synthesising a rail plus both taps that carried NOTHING (a
// struct rail transports its scalar/texture/buffer leaves, and collectScalarLeaves
// has no float3 case). This pins the narrowing, in both directions: composites
// still auto-connect, vecs no longer do.
//
// Pure logic — no GPU, no bundles. Colour's real transport (an explicit wire,
// as a vec rail) is test_vec_rail.cpp's job.

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <unordered_map>

#include <nlohmann/json.hpp>

#include "sketch/sketch_augment.h"

using nlohmann::json;

namespace {

// One producer above one consumer, no wires, no taps. `type: "module"` is
// load-bearing — the augmenter skips entries without it, which is how a test
// sketch can silently generate no rails at all.
json twoModuleSketch(const char* producerType, const char* consumerType) {
  return json{{"columns", json::array({json{
    {"chain", json::array({
      json{{"type", "module"}, {"module_type", producerType}, {"instance_key", "p"}},
      json{{"type", "module"}, {"module_type", consumerType}, {"instance_key", "c"}},
    })},
  }})}};
}

// io bits: 1 = input, 2 = output, 4 = primary.
json fieldDef(const char* type, int io) {
  json def{{"type", type}, {"io", io}};
  if (std::string(type) == "object") def["fields"] = json{{"n", {{"type", "float"}, {"io", 0}}}};
  return def;
}

std::unordered_map<std::string, json> schemas(const json& out, const json& in) {
  return {
    {"producer", json{{"value", out}}},
    {"consumer", json{{"value", in}}},
  };
}

// Read taps the augmenter added to the consumer (chain index 1).
size_t readTapCount(const json& augmented) {
  const auto& entry = augmented["columns"][0]["chain"][1];
  if (!entry.contains("taps") || !entry["taps"].is_array()) return 0;
  size_t n = 0;
  for (const auto& t : entry["taps"]) {
    if (t.value("direction", std::string()) == "read") ++n;
  }
  return n;
}

size_t railCount(const json& augmented) {
  const auto& col = augmented["columns"][0];
  if (!col.contains("rails") || !col["rails"].is_array()) return 0;
  return col["rails"].size();
}

}  // namespace

TEST_CASE("composites still take an implicit rail", "[implicit_rails]") {
  // The behaviour the positional rule exists for — narrowing it to vecs must
  // not have cost this. Without this section the whole change could be
  // "implicit rails no longer happen" and the suite would still pass.
  const auto s = twoModuleSketch("producer", "consumer");
  const auto out = sketch_augment::augmentSketchWithImplicitConnections(
      s, schemas(fieldDef("object", 2 | 4), fieldDef("object", 1)));
  CHECK(railCount(out) == 1);
  CHECK(readTapCount(out) == 1);
}

TEST_CASE("vectors do NOT take an implicit rail", "[implicit_rails]") {
  for (const char* vec : {"float2", "float3", "float4"}) {
    INFO("type = " << vec);
    const auto s = twoModuleSketch("producer", "consumer");
    const auto out = sketch_augment::augmentSketchWithImplicitConnections(
        s, schemas(fieldDef(vec, 2 | 4), fieldDef(vec, 1)));
    CHECK(railCount(out) == 0);
    CHECK(readTapCount(out) == 0);
  }

  SECTION("and the predicate itself says so") {
    CHECK(sketch_augment::isStructuredSchemaTypeDef(fieldDef("object", 1)));
    CHECK(sketch_augment::isStructuredSchemaTypeDef(fieldDef("array", 1)));
    CHECK_FALSE(sketch_augment::isStructuredSchemaTypeDef(fieldDef("float3", 1)));
    CHECK_FALSE(sketch_augment::isStructuredSchemaTypeDef(fieldDef("float", 1)));
  }

  SECTION("a vec-only sketch doesn't even need augmenting") {
    // The cheap pre-check that decides whether to run the augmenter at all —
    // it shares the predicate, so it has to move in lock-step or a vec sketch
    // pays for a pass that can no longer do anything.
    const auto s = twoModuleSketch("producer", "consumer");
    CHECK_FALSE(sketch_augment::sketchNeedsAugmentation(
        s, schemas(fieldDef("float3", 2 | 4), fieldDef("float3", 1))));
    CHECK(sketch_augment::sketchNeedsAugmentation(
        s, schemas(fieldDef("object", 2 | 4), fieldDef("object", 1))));
  }
}
