#pragma once

#include <cstdint>

#include <nlohmann/json.hpp>

namespace json_doc {

enum FieldType : int32_t {
  JDOC_F64 = 0,
  JDOC_I32 = 1,
  JDOC_STRING = 2,
  JDOC_BOOL = 3,
  JDOC_ARRAY_F64 = 4,
  JDOC_ARRAY_I32 = 5,
};

// Layout descriptor for a single field.
// path_offset/path_len reference a packed paths buffer.
struct Field {
  int32_t path_offset;
  int32_t path_len;
  int32_t type;         // FieldType
  int32_t buf_offset;   // where to write in output buffer
  int32_t capacity;     // max bytes (string) or max elements (array)
};

// Per-field result after reading.
struct FieldResult {
  uint8_t found;
  uint8_t overflowed;
  int32_t actual_size;  // actual byte count or element count
};

/// Read fields from a JSON document into a fixed-size output buffer.
/// Returns the number of fields that overflowed.
int read(const nlohmann::json& doc,
         const Field* layout, int field_count,
         const char* paths,
         uint8_t* output, int output_size,
         FieldResult* results);

} // namespace json_doc
