#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include <cstring>
#include <vector>

#include "json/json_doc.h"
#include "json/json_doc_client.h"

using json_doc::JDOC_F64;
using json_doc::JDOC_I32;
using json_doc::JDOC_STRING;
using json_doc::JDOC_BOOL;
using json_doc::JDOC_ARRAY_F64;
using json_doc::JDOC_ARRAY_I32;

using json = nlohmann::json;
using namespace json_doc;

// Helper to build a layout with paths packed into a single buffer
struct TestLayout {
  std::vector<Field> fields;
  std::string paths;

  void add(const std::string& path, FieldType type, int offset, int capacity = 0) {
    Field f;
    f.path_offset = static_cast<int32_t>(paths.size());
    f.path_len = static_cast<int32_t>(path.size());
    f.type = type;
    f.buf_offset = offset;
    f.capacity = capacity;
    fields.push_back(f);
    paths += path;
  }
};

TEST_CASE("json_doc read f64 scalar", "[json_doc]") {
  json doc = {{"value", 3.14}};
  TestLayout layout;
  layout.add("/value", JDOC_F64, 0);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  int overflow = read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(overflow == 0);
  REQUIRE(results[0].found == 1);
  REQUIRE(jdoc_get_f64(buf, 0) == 3.14);
}

TEST_CASE("json_doc read i32 scalar", "[json_doc]") {
  json doc = {{"count", 42}};
  TestLayout layout;
  layout.add("/count", JDOC_I32, 0);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(results[0].found == 1);
  REQUIRE(jdoc_get_i32(buf, 0) == 42);
}

TEST_CASE("json_doc read bool", "[json_doc]") {
  json doc = {{"flag", true}};
  TestLayout layout;
  layout.add("/flag", JDOC_BOOL, 0);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(results[0].found == 1);
  REQUIRE(jdoc_get_bool(buf, 0) == 1);
}

TEST_CASE("json_doc read string within capacity", "[json_doc]") {
  json doc = {{"name", "hello"}};
  TestLayout layout;
  layout.add("/name", JDOC_STRING, 0, 32);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  int overflow = read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(overflow == 0);
  REQUIRE(results[0].found == 1);
  REQUIRE(results[0].overflowed == 0);
  REQUIRE(jdoc_get_string_len(buf, 0) == 5);
  REQUIRE(std::string(jdoc_get_string_ptr(buf, 0), 5) == "hello");
}

TEST_CASE("json_doc read string truncated", "[json_doc]") {
  json doc = {{"name", "this is a very long string"}};
  TestLayout layout;
  layout.add("/name", JDOC_STRING, 0, 8);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  int overflow = read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(overflow == 1);
  REQUIRE(results[0].found == 1);
  REQUIRE(results[0].overflowed == 1);
  REQUIRE(results[0].actual_size > 8);
  REQUIRE(jdoc_get_string_len(buf, 0) == 8); // truncated to capacity
  REQUIRE(std::string(jdoc_get_string_ptr(buf, 0), 8) == "this is ");
}

TEST_CASE("json_doc read f64 array", "[json_doc]") {
  json doc = {{"scores", {1.0, 2.5, 3.7}}};
  TestLayout layout;
  layout.add("/scores", JDOC_ARRAY_F64, 0, 10);

  uint8_t buf[128] = {};
  FieldResult results[1] = {};
  int overflow = read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(overflow == 0);
  REQUIRE(results[0].found == 1);
  REQUIRE(jdoc_get_array_count(buf, 0) == 3);
  REQUIRE(jdoc_get_array_f64(buf, 0, 0) == 1.0);
  REQUIRE(jdoc_get_array_f64(buf, 0, 1) == 2.5);
  REQUIRE(jdoc_get_array_f64(buf, 0, 2) == 3.7);
}

TEST_CASE("json_doc read f64 array truncated", "[json_doc]") {
  json doc = {{"data", {1.0, 2.0, 3.0, 4.0, 5.0}}};
  TestLayout layout;
  layout.add("/data", JDOC_ARRAY_F64, 0, 3);

  uint8_t buf[128] = {};
  FieldResult results[1] = {};
  int overflow = read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(overflow == 1);
  REQUIRE(results[0].overflowed == 1);
  REQUIRE(results[0].actual_size == 5);
  REQUIRE(jdoc_get_array_count(buf, 0) == 3);
  REQUIRE(jdoc_get_array_f64(buf, 0, 0) == 1.0);
  REQUIRE(jdoc_get_array_f64(buf, 0, 2) == 3.0);
}

TEST_CASE("json_doc read i32 array", "[json_doc]") {
  json doc = {{"ids", {10, 20, 30}}};
  TestLayout layout;
  layout.add("/ids", JDOC_ARRAY_I32, 0, 10);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(results[0].found == 1);
  REQUIRE(jdoc_get_array_count(buf, 0) == 3);
  REQUIRE(jdoc_get_array_i32(buf, 0, 0) == 10);
  REQUIRE(jdoc_get_array_i32(buf, 0, 1) == 20);
  REQUIRE(jdoc_get_array_i32(buf, 0, 2) == 30);
}

TEST_CASE("json_doc missing path", "[json_doc]") {
  json doc = {{"a", 1}};
  TestLayout layout;
  layout.add("/nonexistent", JDOC_F64, 0);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(results[0].found == 0);
}

TEST_CASE("json_doc nested path", "[json_doc]") {
  json doc = {{"config", {{"audio", {{"volume", 0.75}}}}}};
  TestLayout layout;
  layout.add("/config/audio/volume", JDOC_F64, 0);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(results[0].found == 1);
  REQUIRE(jdoc_get_f64(buf, 0) == 0.75);
}

TEST_CASE("json_doc multiple fields at different offsets", "[json_doc]") {
  json doc = {{"x", 1.0}, {"y", 2.0}, {"name", "test"}};
  TestLayout layout;
  layout.add("/x", JDOC_F64, 0);
  layout.add("/y", JDOC_F64, 8);
  layout.add("/name", JDOC_STRING, 16, 32);

  uint8_t buf[64] = {};
  FieldResult results[3] = {};
  read(doc, layout.fields.data(), 3, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(results[0].found == 1);
  REQUIRE(results[1].found == 1);
  REQUIRE(results[2].found == 1);
  REQUIRE(jdoc_get_f64(buf, 0) == 1.0);
  REQUIRE(jdoc_get_f64(buf, 8) == 2.0);
  REQUIRE(jdoc_get_string_len(buf, 16) == 4);
  REQUIRE(std::string(jdoc_get_string_ptr(buf, 16), 4) == "test");
}

TEST_CASE("json_doc empty document", "[json_doc]") {
  json doc = json::object();
  TestLayout layout;
  layout.add("/anything", JDOC_F64, 0);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(results[0].found == 0);
}

TEST_CASE("json_doc root path reads entire doc as string", "[json_doc]") {
  // Reading the root "" as a string doesn't make sense, but reading a nested value does
  json doc = 42.0;
  TestLayout layout;
  layout.add("", JDOC_F64, 0);

  uint8_t buf[64] = {};
  FieldResult results[1] = {};
  read(doc, layout.fields.data(), 1, layout.paths.data(), buf, sizeof(buf), results);

  REQUIRE(results[0].found == 1);
  REQUIRE(jdoc_get_f64(buf, 0) == 42.0);
}
