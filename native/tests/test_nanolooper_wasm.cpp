#include <catch2/catch_test_macros.hpp>

#include <fstream>
#include <vector>

#include "bridge/param_cache.h"
#include "canvas/draw_list.h"
#include "wasm/wasm_host.h"

using bridge::ParamCache;
using canvas::DrawList;
using canvas::DrawCmd;
using wasm::WasmHost;
using wasm::FrameState;

// Load a .wasm file from disk
static std::vector<uint8_t> load_file(const char* path) {
  std::ifstream f(path, std::ios::binary | std::ios::ate);
  if (!f) return {};
  auto size = f.tellg();
  f.seekg(0);
  std::vector<uint8_t> buf(size);
  f.read(reinterpret_cast<char*>(buf.data()), size);
  return buf;
}

#ifndef NANOLOOPER_WASM_PATH
#error "NANOLOOPER_WASM_PATH must be defined"
#endif

TEST_CASE("nanolooper.wasm loads successfully", "[nanolooper]") {
  auto bytecode = load_file(NANOLOOPER_WASM_PATH);
  REQUIRE(!bytecode.empty());

  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  INFO("last_error: " << host.last_error());
  REQUIRE(id >= 0);

  host.shutdown();
}

TEST_CASE("nanolooper.wasm init runs without error", "[nanolooper]") {
  auto bytecode = load_file(NANOLOOPER_WASM_PATH);
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);

  FrameState fs;
  fs.elapsed_time = 0;
  fs.bpm = 120;
  host.set_frame_state(id, &fs);

  DrawList dl;
  host.set_draw_list(id, &dl);

  REQUIRE(host.call_function(id, "init") == 0);

  host.shutdown();
}

TEST_CASE("nanolooper.wasm tick runs without error", "[nanolooper]") {
  auto bytecode = load_file(NANOLOOPER_WASM_PATH);
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);

  FrameState fs;
  fs.elapsed_time = 0;
  fs.bpm = 120;
  fs.bar_phase = 0.0;
  host.set_frame_state(id, &fs);

  DrawList dl;
  host.set_draw_list(id, &dl);

  REQUIRE(host.call_function(id, "init") == 0);
  REQUIRE(host.call_function_f64(id, "tick", 0.016) == 0);

  host.shutdown();
}

TEST_CASE("nanolooper.wasm render produces draw commands", "[nanolooper]") {
  auto bytecode = load_file(NANOLOOPER_WASM_PATH);
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);

  FrameState fs;
  fs.elapsed_time = 1.0;
  fs.bpm = 120;
  fs.bar_phase = 0.25;
  fs.viewport_w = 1920;
  fs.viewport_h = 1080;
  host.set_frame_state(id, &fs);

  DrawList dl;
  host.set_draw_list(id, &dl);

  REQUIRE(host.call_function(id, "init") == 0);
  REQUIRE(host.call_function_i32_i32(id, "render", 1920, 1080) == 0);

  INFO("draw commands: " << dl.size());
  REQUIRE(!dl.empty());

  // Should have a mix of fill_rect and draw_text commands
  int rect_count = 0, text_count = 0;
  for (const auto& cmd : dl.commands) {
    if (cmd.type == DrawCmd::FillRect) rect_count++;
    if (cmd.type == DrawCmd::DrawText) text_count++;
  }
  INFO("rects: " << rect_count << " texts: " << text_count);
  REQUIRE(rect_count > 0);
  REQUIRE(text_count > 0);

  host.shutdown();
}

TEST_CASE("nanolooper.wasm on_param_change triggers events", "[nanolooper]") {
  auto bytecode = load_file(NANOLOOPER_WASM_PATH);
  ParamCache cache;
  WasmHost host(cache);
  REQUIRE(host.init());

  int32_t id = host.load_module(bytecode.data(), bytecode.size());
  REQUIRE(id >= 0);

  FrameState fs;
  fs.elapsed_time = 0.5;
  fs.bpm = 120;
  fs.bar_phase = 0.1;
  host.set_frame_state(id, &fs);

  DrawList dl;
  host.set_draw_list(id, &dl);

  // Track audio triggers
  int triggered_channel = -1;
  host.set_audio_callback(id, [](int ch, void* ud) {
    *static_cast<int*>(ud) = ch;
  }, &triggered_channel);

  REQUIRE(host.call_function(id, "init") == 0);

  // Trigger channel 0 (press)
  REQUIRE(host.call_function_i32_f64(id, "on_param_change", 0, 1.0) == 0);

  // Audio callback should have fired for channel 0
  REQUIRE(triggered_channel == 0);

  host.shutdown();
}
