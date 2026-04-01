// Generates test WASM module bytecode as C++ arrays.
// Build and run: cmake --build build --target gen_wasm && ./build/gen_wasm
// Then paste the output into test_wasm_host.cpp

#include <cstdint>
#include <cstdio>
#include <vector>
#include <string>

using bytes = std::vector<uint8_t>;

// LEB128 encoding for unsigned integers
bytes uleb128(uint32_t val) {
  bytes out;
  do {
    uint8_t b = val & 0x7f;
    val >>= 7;
    if (val) b |= 0x80;
    out.push_back(b);
  } while (val);
  return out;
}

// LEB128 encoding for signed integers (i64)
bytes sleb128(int64_t val) {
  bytes out;
  bool more = true;
  while (more) {
    uint8_t b = val & 0x7f;
    val >>= 7;
    if ((val == 0 && !(b & 0x40)) || (val == -1 && (b & 0x40))) {
      more = false;
    } else {
      b |= 0x80;
    }
    out.push_back(b);
  }
  return out;
}

void append(bytes& dst, const bytes& src) {
  dst.insert(dst.end(), src.begin(), src.end());
}

void append_str(bytes& dst, const std::string& s) {
  append(dst, uleb128(s.size()));
  dst.insert(dst.end(), s.begin(), s.end());
}

bytes make_section(uint8_t id, const bytes& content) {
  bytes out;
  out.push_back(id);
  append(out, uleb128(content.size()));
  append(out, content);
  return out;
}

void print_array(const char* name, const bytes& data) {
  printf("static const uint8_t %s[] = {\n    ", name);
  for (size_t i = 0; i < data.size(); i++) {
    printf("0x%02x,", data[i]);
    if ((i + 1) % 16 == 0 && i + 1 < data.size()) printf("\n    ");
    else if (i + 1 < data.size()) printf(" ");
  }
  printf("\n};\n\n");
}

// WASM type constants
const uint8_t TYPE_I32 = 0x7f;
const uint8_t TYPE_I64 = 0x7e;
const uint8_t TYPE_F64 = 0x7c;
const uint8_t TYPE_FUNC = 0x60;

bytes make_functype(const bytes& params, const bytes& results) {
  bytes out;
  out.push_back(TYPE_FUNC);
  append(out, uleb128(params.size()));
  append(out, params);
  append(out, uleb128(results.size()));
  append(out, results);
  return out;
}

bytes make_import_func(const std::string& module, const std::string& name, uint32_t type_idx) {
  bytes out;
  append_str(out, module);
  append_str(out, name);
  out.push_back(0x00); // import kind: function
  append(out, uleb128(type_idx));
  return out;
}

bytes make_export_func(const std::string& name, uint32_t func_idx) {
  bytes out;
  append_str(out, name);
  out.push_back(0x00); // export kind: function
  append(out, uleb128(func_idx));
  return out;
}

bytes make_export_memory(const std::string& name, uint32_t mem_idx) {
  bytes out;
  append_str(out, name);
  out.push_back(0x02); // export kind: memory
  append(out, uleb128(mem_idx));
  return out;
}

bytes wasm_header() {
  return {0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00};
}

// Generate TICK_MODULE: exports "tick" function (no imports)
bytes gen_tick_module() {
  bytes wasm = wasm_header();

  // Type section: 1 type, () -> ()
  bytes types;
  append(types, uleb128(1));
  append(types, make_functype({}, {}));
  append(wasm, make_section(1, types));

  // Function section: 1 func, type 0
  bytes funcs;
  append(funcs, uleb128(1));
  append(funcs, uleb128(0));
  append(wasm, make_section(3, funcs));

  // Export section: "tick" -> func 0
  bytes exports;
  append(exports, uleb128(1));
  append(exports, make_export_func("tick", 0));
  append(wasm, make_section(7, exports));

  // Code section: 1 body, empty
  bytes body;
  body.push_back(0x00); // 0 locals
  body.push_back(0x0b); // end
  bytes code;
  append(code, uleb128(1)); // 1 body
  append(code, uleb128(body.size()));
  append(code, body);
  append(wasm, make_section(10, code));

  return wasm;
}

// Generate PARAM_MODULE: imports get/set param, exports "double_param" and "tick"
bytes gen_param_module() {
  bytes wasm = wasm_header();

  // Type section: 3 types
  bytes types;
  append(types, uleb128(3));
  append(types, make_functype({TYPE_I64}, {TYPE_F64}));        // type 0: (i64) -> (f64)
  append(types, make_functype({TYPE_I64, TYPE_F64}, {}));      // type 1: (i64, f64) -> ()
  append(types, make_functype({}, {}));                        // type 2: () -> ()
  append(wasm, make_section(1, types));

  // Import section: 2 imports
  bytes imports;
  append(imports, uleb128(2));
  append(imports, make_import_func("env", "resolume_get_param", 0));
  append(imports, make_import_func("env", "resolume_set_param", 1));
  append(wasm, make_section(2, imports));

  // Function section: 2 local funcs (double_param=type2, tick=type2)
  bytes funcs;
  append(funcs, uleb128(2));
  append(funcs, uleb128(2)); // double_param: type 2
  append(funcs, uleb128(2)); // tick: type 2
  append(wasm, make_section(3, funcs));

  // Export section: "double_param" -> func 2, "tick" -> func 3
  bytes exports;
  append(exports, uleb128(2));
  append(exports, make_export_func("double_param", 2));
  append(exports, make_export_func("tick", 3));
  append(wasm, make_section(7, exports));

  // Code section: 2 bodies
  bytes code;
  append(code, uleb128(2));

  // Body 0: double_param
  // call $set(42, $get(42) * 2.0)
  {
    bytes body;
    body.push_back(0x00); // 0 locals
    body.push_back(0x42); append(body, sleb128(42));  // i64.const 42
    body.push_back(0x42); append(body, sleb128(42));  // i64.const 42
    body.push_back(0x10); append(body, uleb128(0));   // call $get (func 0)
    // f64.const 2.0
    body.push_back(0x44);
    double val = 2.0;
    uint8_t* p = reinterpret_cast<uint8_t*>(&val);
    body.insert(body.end(), p, p + 8);
    body.push_back(0xa2); // f64.mul
    body.push_back(0x10); append(body, uleb128(1)); // call $set (func 1)
    body.push_back(0x0b); // end

    append(code, uleb128(body.size()));
    append(code, body);
  }

  // Body 1: tick (empty)
  {
    bytes body;
    body.push_back(0x00); // 0 locals
    body.push_back(0x0b); // end
    append(code, uleb128(body.size()));
    append(code, body);
  }

  append(wasm, make_section(10, code));
  return wasm;
}

// Generate LOG_MODULE: imports "log", exports "say_hello"
bytes gen_log_module() {
  bytes wasm = wasm_header();

  // Type section
  bytes types;
  append(types, uleb128(2));
  append(types, make_functype({TYPE_I32, TYPE_I32}, {}));  // type 0: (i32, i32) -> ()
  append(types, make_functype({}, {}));                    // type 1: () -> ()
  append(wasm, make_section(1, types));

  // Import section
  bytes imports;
  append(imports, uleb128(1));
  append(imports, make_import_func("env", "log", 0));
  append(wasm, make_section(2, imports));

  // Function section: 1 local func
  bytes funcs;
  append(funcs, uleb128(1));
  append(funcs, uleb128(1)); // type 1
  append(wasm, make_section(3, funcs));

  // Memory section: 1 memory, min 1 page
  bytes memory;
  append(memory, uleb128(1));
  memory.push_back(0x00); // no max
  append(memory, uleb128(1)); // min 1
  append(wasm, make_section(5, memory));

  // Export section
  bytes exports;
  append(exports, uleb128(2));
  append(exports, make_export_memory("memory", 0));
  append(exports, make_export_func("say_hello", 1));
  append(wasm, make_section(7, exports));

  // Code section (must come before data section — section IDs must be in order)
  bytes code;
  append(code, uleb128(1));
  {
    bytes body;
    body.push_back(0x00); // 0 locals
    body.push_back(0x41); append(body, uleb128(0)); // i32.const 0 (ptr)
    body.push_back(0x41); append(body, uleb128(5)); // i32.const 5 (len)
    body.push_back(0x10); append(body, uleb128(0)); // call $log (func 0)
    body.push_back(0x0b); // end
    append(code, uleb128(body.size()));
    append(code, body);
  }
  append(wasm, make_section(10, code));

  // Data section: "hello" at offset 0
  bytes data;
  append(data, uleb128(1)); // 1 segment
  data.push_back(0x00);     // active, memory 0
  data.push_back(0x41); append(data, uleb128(0)); // i32.const 0
  data.push_back(0x0b); // end expr
  std::string hello = "hello";
  append(data, uleb128(hello.size()));
  data.insert(data.end(), hello.begin(), hello.end());
  append(wasm, make_section(11, data));

  return wasm;
}

int main() {
  printf("// Auto-generated WASM test modules\n\n");

  auto tick = gen_tick_module();
  print_array("TICK_MODULE", tick);

  auto param = gen_param_module();
  print_array("PARAM_MODULE", param);

  auto log = gen_log_module();
  print_array("LOG_MODULE", log);

  return 0;
}
