#pragma once
/*
 * val.h — Handle-based JSON value container for WASM modules.
 *
 * The host owns all data. WASM modules hold opaque integer handles
 * and call host functions to construct, read, and traverse values.
 * Zero allocation on the WASM side.
 *
 * Usage:
 *   auto obj = val::object();
 *   val::set(obj, "phase", val::number(0.5));
 *   val::set(obj, "grid", val::array());
 *   // ... build up the value tree
 *   state::setVal(obj);  // publish to state system
 *   val::release(obj);   // free the host-side data
 */

#include <cstring>

// --- Raw C imports ---
extern "C" {
  // Construction
  __attribute__((import_module("val"), import_name("null")))
  int val_null(void);
  __attribute__((import_module("val"), import_name("bool")))
  int val_bool(int v);
  __attribute__((import_module("val"), import_name("number")))
  int val_number(double v);
  __attribute__((import_module("val"), import_name("string")))
  int val_string(const char* s, int len);
  __attribute__((import_module("val"), import_name("array")))
  int val_array(void);
  __attribute__((import_module("val"), import_name("object")))
  int val_object(void);

  // Reading
  __attribute__((import_module("val"), import_name("type_of")))
  int val_type_of(int h);
  __attribute__((import_module("val"), import_name("as_number")))
  double val_as_number(int h);
  __attribute__((import_module("val"), import_name("as_bool")))
  int val_as_bool(int h);
  __attribute__((import_module("val"), import_name("as_string")))
  int val_as_string(int h, char* buf, int buf_len);

  // Object access
  __attribute__((import_module("val"), import_name("get")))
  int val_get(int obj, const char* key, int key_len);
  __attribute__((import_module("val"), import_name("set")))
  void val_set(int obj, const char* key, int key_len, int value);
  __attribute__((import_module("val"), import_name("keys_count")))
  int val_keys_count(int obj);
  __attribute__((import_module("val"), import_name("key_at")))
  int val_key_at(int obj, int index, char* buf, int buf_len);

  // Array access
  __attribute__((import_module("val"), import_name("get_index")))
  int val_get_index(int arr, int index);
  __attribute__((import_module("val"), import_name("push")))
  void val_push(int arr, int value);
  __attribute__((import_module("val"), import_name("length")))
  int val_length(int arr);

  // Lifecycle
  __attribute__((import_module("val"), import_name("release")))
  void val_release(int h);

  // Serialization
  __attribute__((import_module("val"), import_name("to_json")))
  int val_to_json(int h, char* buf, int buf_len);
}

// --- C++ wrappers ---

namespace val {

using Handle = int;

// Value types
enum Type : int {
  Null   = 0,
  Bool   = 1,
  Number = 2,
  String = 3,
  Array  = 4,
  Object = 5,
};

// Construction
inline Handle null()                   { return val_null(); }
inline Handle boolean(bool v)          { return val_bool(v ? 1 : 0); }
inline Handle number(double v)         { return val_number(v); }
inline Handle string(const char* s)    { return val_string(s, std::strlen(s)); }
inline Handle string(const char* s, int len) { return val_string(s, len); }
inline Handle array()                  { return val_array(); }
inline Handle object()                 { return val_object(); }

// Reading
inline Type   typeOf(Handle h)         { return static_cast<Type>(val_type_of(h)); }
inline double asNumber(Handle h)       { return val_as_number(h); }
inline bool   asBool(Handle h)         { return val_as_bool(h) != 0; }
inline int    asString(Handle h, char* buf, int len) { return val_as_string(h, buf, len); }

// Object access
inline Handle get(Handle obj, const char* key) {
  return val_get(obj, key, std::strlen(key));
}
inline void set(Handle obj, const char* key, Handle value) {
  val_set(obj, key, std::strlen(key), value);
}
inline int keysCount(Handle obj) { return val_keys_count(obj); }
inline int keyAt(Handle obj, int index, char* buf, int len) {
  return val_key_at(obj, index, buf, len);
}

// Array access
inline Handle getIndex(Handle arr, int index) { return val_get_index(arr, index); }
inline void   push(Handle arr, Handle value)  { val_push(arr, value); }
inline int    length(Handle arr)              { return val_length(arr); }

// Lifecycle
inline void release(Handle h) { val_release(h); }

// Serialization
inline int toJson(Handle h, char* buf, int len) { return val_to_json(h, buf, len); }

// --- RAII wrapper (optional convenience) ---

class Value {
public:
  Handle h;

  Value() : h(val_null()) {}
  explicit Value(Handle handle) : h(handle) {}
  ~Value() { if (h > 0) val_release(h); }

  // Move only
  Value(Value&& o) : h(o.h) { o.h = 0; }
  Value& operator=(Value&& o) { if (h > 0) val_release(h); h = o.h; o.h = 0; return *this; }
  Value(const Value&) = delete;
  Value& operator=(const Value&) = delete;

  // Construction helpers
  static Value Null()                   { return Value(val_null()); }
  static Value Bool(bool v)             { return Value(val_bool(v ? 1 : 0)); }
  static Value Number(double v)         { return Value(val_number(v)); }
  static Value String(const char* s)    { return Value(val_string(s, std::strlen(s))); }
  static Value Array()                  { return Value(val_array()); }
  static Value Object()                 { return Value(val_object()); }

  // Detach handle (caller takes ownership)
  Handle detach() { Handle r = h; h = 0; return r; }

  explicit operator bool() const { return h > 0; }
};

} // namespace val
