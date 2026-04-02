#ifndef JSON_DOC_CLIENT_H
#define JSON_DOC_CLIENT_H

/*
 * json-doc client helpers (pure C, header-only).
 * For use in WASM modules to read data from a buffer filled by json_doc_read.
 * No dependencies beyond memcpy.
 */

#include <stdint.h>
#include <string.h>

/* Field types (must match json_doc::FieldType) */
enum {
  JDOC_TYPE_F64       = 0,
  JDOC_TYPE_I32       = 1,
  JDOC_TYPE_STRING    = 2,
  JDOC_TYPE_BOOL      = 3,
  JDOC_TYPE_ARRAY_F64 = 4,
  JDOC_TYPE_ARRAY_I32 = 5,
};

/* Layout descriptor (must match json_doc::Field) */
typedef struct {
  int32_t path_offset;
  int32_t path_len;
  int32_t type;
  int32_t buf_offset;
  int32_t capacity;
} JDocField;

/* Per-field result (must match json_doc::FieldResult) */
typedef struct {
  uint8_t found;
  uint8_t overflowed;
  int32_t actual_size;
} JDocResult;

/* --- Buffer reading helpers --- */

static inline double jdoc_get_f64(const void* buf, int offset) {
  double v;
  memcpy(&v, (const char*)buf + offset, 8);
  return v;
}

static inline int32_t jdoc_get_i32(const void* buf, int offset) {
  int32_t v;
  memcpy(&v, (const char*)buf + offset, 4);
  return v;
}

static inline int32_t jdoc_get_bool(const void* buf, int offset) {
  return jdoc_get_i32(buf, offset);
}

/* Read string length (i32 prefix at offset), data starts at offset+4 */
static inline int32_t jdoc_get_string_len(const void* buf, int offset) {
  return jdoc_get_i32(buf, offset);
}

static inline const char* jdoc_get_string_ptr(const void* buf, int offset) {
  return (const char*)buf + offset + 4;
}

/* Read array count (i32 prefix at offset), elements start at offset+4 */
static inline int32_t jdoc_get_array_count(const void* buf, int offset) {
  return jdoc_get_i32(buf, offset);
}

static inline double jdoc_get_array_f64(const void* buf, int offset, int index) {
  double v;
  memcpy(&v, (const char*)buf + offset + 4 + index * 8, 8);
  return v;
}

static inline int32_t jdoc_get_array_i32(const void* buf, int offset, int index) {
  int32_t v;
  memcpy(&v, (const char*)buf + offset + 4 + index * 4, 4);
  return v;
}

/* Check field results */
static inline int jdoc_found(const JDocResult* results, int field_index) {
  return results[field_index].found;
}

static inline int jdoc_overflowed(const JDocResult* results, int field_index) {
  return results[field_index].overflowed;
}

static inline int32_t jdoc_actual_size(const JDocResult* results, int field_index) {
  return results[field_index].actual_size;
}

#endif /* JSON_DOC_CLIENT_H */
