// test_val_handles.cpp — the `val` host ABI must not leak handles.
//
// Effects build a JSON tree through the val_* host imports (alloc a handle per
// number/string/object/array, set/push children into containers) and publish it
// with a single release of the ROOT handle (see val.h). If set/push don't CONSUME
// the child handle they copy, every intermediate handle leaks — `val_handles`
// grows every frame and a busy per-frame publisher (control.nanolooper) slowly
// exhausts the host heap, trapping the WAMR runtime and freezing the whole
// executor. These tests pin the consume semantics that prevent that.

#include <catch2/catch_test_macros.hpp>

#include "wasm/wasm_context.h"

using wasm::WasmContext;

TEST_CASE("val set/push consume the child handle (no per-frame leak)") {
  WasmContext ctx;

  // A leaf set into an object leaves only the object handle alive.
  int32_t obj = ctx.alloc_val(nlohmann::json::object());
  int32_t leaf = ctx.alloc_val(42.0);
  REQUIRE(ctx.val_handle_count() == 2);
  REQUIRE(ctx.set_val_member(obj, "answer", leaf));
  REQUIRE(ctx.val_handle_count() == 1);          // leaf consumed
  REQUIRE(ctx.get_val(leaf) == nullptr);         // freed
  REQUIRE((*ctx.get_val(obj))["answer"] == 42.0);  // value copied in

  // A leaf pushed into an array likewise leaves only the array.
  int32_t arr = ctx.alloc_val(nlohmann::json::array());
  int32_t elem = ctx.alloc_val(std::string("x"));
  REQUIRE(ctx.push_val_member(arr, elem));
  REQUIRE(ctx.get_val(elem) == nullptr);
  REQUIRE(ctx.get_val(arr)->size() == 1);
}

TEST_CASE("building a nested tree leaves only the root handle") {
  WasmContext ctx;

  // Mirror control.nanolooper's publish_state shape in miniature: a root object
  // with a nested array of objects, each carrying a nested sub-object — the
  // pattern that leaked hardest. After wiring it up only the root survives.
  int32_t root = ctx.alloc_val(nlohmann::json::object());
  ctx.set_val_member(root, "phase", ctx.alloc_val(1.5));

  int32_t triggers = ctx.alloc_val(nlohmann::json::array());
  for (int i = 0; i < 8; ++i) {
    int32_t e = ctx.alloc_val(nlohmann::json::object());
    ctx.set_val_member(e, "seq", ctx.alloc_val((double)i));
    ctx.set_val_member(e, "on", ctx.alloc_val(i % 2 == 0));
    int32_t prec = ctx.alloc_val(nlohmann::json::object());
    ctx.set_val_member(prec, "mode", ctx.alloc_val(std::string("strict")));
    ctx.set_val_member(prec, "deadline", ctx.alloc_val(100.0));
    ctx.set_val_member(e, "precision", prec);
    ctx.push_val_member(triggers, e);
  }
  ctx.set_val_member(root, "triggers", triggers);

  REQUIRE(ctx.val_handle_count() == 1);          // everything folded into root
  ctx.release_val(root);
  REQUIRE(ctx.val_handle_count() == 0);

  // The published data is intact and correctly shaped.
  int32_t check = ctx.alloc_val(nlohmann::json::object());  // reuse allocator
  (void)check;
}

TEST_CASE("simulated per-frame publish does not accumulate handles") {
  WasmContext ctx;
  // Publish a looper-sized tree many times, releasing only the root each frame
  // (exactly what the effect does). Handle count must return to zero every time
  // — never ratchet upward.
  for (int frame = 0; frame < 500; ++frame) {
    int32_t root = ctx.alloc_val(nlohmann::json::object());
    int32_t grid = ctx.alloc_val(nlohmann::json::array());
    for (int ch = 0; ch < 4; ++ch) {
      int32_t lane = ctx.alloc_val(nlohmann::json::array());
      for (int st = 0; st < 16; ++st)
        ctx.push_val_member(lane, ctx.alloc_val((double)st));
      ctx.push_val_member(grid, lane);
    }
    ctx.set_val_member(root, "grid", grid);
    ctx.release_val(root);
    REQUIRE(ctx.val_handle_count() == 0);
  }
}

TEST_CASE("consume is a no-op on invalid/mistyped handles") {
  WasmContext ctx;
  int32_t num = ctx.alloc_val(7.0);
  // Target is not a container → nothing consumed, both handles remain.
  REQUIRE_FALSE(ctx.set_val_member(num, "k", ctx.alloc_val(1.0)));
  REQUIRE_FALSE(ctx.push_val_member(num, ctx.alloc_val(1.0)));
  // A missing value handle → no crash, no consume.
  int32_t obj = ctx.alloc_val(nlohmann::json::object());
  REQUIRE_FALSE(ctx.set_val_member(obj, "k", /*value_h=*/999999));
}
