#include "json/json_doc.h"
#include "json/json_patch.h"

#include <cstring>
#include <algorithm>

namespace json_doc {

int read(const nlohmann::json& doc,
         const Field* layout, int field_count,
         const char* paths,
         uint8_t* output, int output_size,
         FieldResult* results) {
  int overflow_count = 0;

  for (int i = 0; i < field_count; i++) {
    const Field& f = layout[i];
    FieldResult& r = results[i];
    r.found = 0;
    r.overflowed = 0;
    r.actual_size = 0;

    // Extract the path string
    std::string path(paths + f.path_offset, f.path_len);

    // Resolve the JSON Pointer
    const nlohmann::json* val = json_patch::resolve_pointer(doc, path);
    if (!val) continue;
    r.found = 1;

    switch (static_cast<FieldType>(f.type)) {
      case JDOC_F64: {
        if (val->is_number() && f.buf_offset + 8 <= output_size) {
          double v = val->get<double>();
          memcpy(output + f.buf_offset, &v, 8);
          r.actual_size = 8;
        }
        break;
      }
      case JDOC_I32: {
        if (val->is_number() && f.buf_offset + 4 <= output_size) {
          int32_t v = val->get<int32_t>();
          memcpy(output + f.buf_offset, &v, 4);
          r.actual_size = 4;
        }
        break;
      }
      case JDOC_BOOL: {
        if (val->is_boolean() && f.buf_offset + 4 <= output_size) {
          int32_t v = val->get<bool>() ? 1 : 0;
          memcpy(output + f.buf_offset, &v, 4);
          r.actual_size = 4;
        }
        break;
      }
      case JDOC_STRING: {
        if (!val->is_string()) break;
        std::string s = val->get<std::string>();
        r.actual_size = static_cast<int32_t>(s.size());
        int32_t write_len = std::min(r.actual_size, f.capacity);
        if (r.actual_size > f.capacity) {
          r.overflowed = 1;
          overflow_count++;
        }
        // Write: [i32 length][char data...]
        if (f.buf_offset + 4 + write_len <= output_size) {
          memcpy(output + f.buf_offset, &write_len, 4);
          memcpy(output + f.buf_offset + 4, s.data(), write_len);
        }
        break;
      }
      case JDOC_ARRAY_F64: {
        if (!val->is_array()) break;
        int32_t actual_count = static_cast<int32_t>(val->size());
        r.actual_size = actual_count;
        int32_t write_count = std::min(actual_count, f.capacity);
        if (actual_count > f.capacity) {
          r.overflowed = 1;
          overflow_count++;
        }
        // Write: [i32 count][f64 data...]
        if (f.buf_offset + 4 + write_count * 8 <= output_size) {
          memcpy(output + f.buf_offset, &write_count, 4);
          for (int32_t j = 0; j < write_count; j++) {
            double v = (*val)[j].is_number() ? (*val)[j].get<double>() : 0.0;
            memcpy(output + f.buf_offset + 4 + j * 8, &v, 8);
          }
        }
        break;
      }
      case JDOC_ARRAY_I32: {
        if (!val->is_array()) break;
        int32_t actual_count = static_cast<int32_t>(val->size());
        r.actual_size = actual_count;
        int32_t write_count = std::min(actual_count, f.capacity);
        if (actual_count > f.capacity) {
          r.overflowed = 1;
          overflow_count++;
        }
        // Write: [i32 count][i32 data...]
        if (f.buf_offset + 4 + write_count * 4 <= output_size) {
          memcpy(output + f.buf_offset, &write_count, 4);
          for (int32_t j = 0; j < write_count; j++) {
            int32_t v = (*val)[j].is_number() ? (*val)[j].get<int32_t>() : 0;
            memcpy(output + f.buf_offset + 4 + j * 4, &v, 4);
          }
        }
        break;
      }
    }
  }

  return overflow_count;
}

} // namespace json_doc
