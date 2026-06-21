/*
 * trap_test — a test-only effect whose module_init deliberately TRAPS, used to
 * verify the host's trap REPORTING (EffectInstance::moduleInitTrapped + the loud
 * log in doModuleInit).
 *
 * The native bundles path runs every effect's module_init eagerly at
 * registration, all in ONE shared wasm instance. WAMR does not unwind the C
 * aux-stack pointer when a call traps mid-function, so a trap here leaks the
 * stack-pointer decrement and poisons every effect registered AFTER it (they hit
 * "out of bounds memory access" and silently publish empty schemas). That can't
 * be cleanly contained (the shared instance also holds earlier effects' type-
 * level state), so the host instead makes the trap loud and queryable, and this
 * effect is registered LAST in the testonly bundle so it poisons nothing.
 *
 * module_init publishes a (valid) schema FIRST — so a passing test can tell the
 * effect actually ran — then forces a real stack frame and traps before the
 * epilogue restores the stack pointer. This effect is never instantiated in a
 * sketch (web loads effects lazily, so its module_init never runs there); the
 * lifecycle callbacks below are inert stubs only present to satisfy the ABI.
 */

#include <host.h>
#include <cstdint>

namespace trap_test {

void module_init() {
  state::init("debug.trap_test", {1, 0, 0},
    state::Schema()
      .floatField("dummy", 0.0f, 0.0f, 1.0f, state::PrimaryInput));

  // Force a non-trivial stack frame (the prologue decrements __stack_pointer),
  // keep it live, then trap before the epilogue restores it. `volatile` + the
  // read prevent the compiler from optimizing the frame away.
  volatile char buf[4096];
  for (int i = 0; i < 4096; ++i) buf[i] = (char)i;
  if (buf[1234] == 0x7F) return;   // never true — keeps `buf` live
  __builtin_trap();
}

// Inert ABI stubs — trap_test is never created/rendered.
void* create() { return nullptr; }
void  destroy(void*) {}
void  init(void*) {}
void  tick(void*, double) {}
void  render(void*, int, int) {}
void  on_state_patched(void*, int, const char*, const int*, const int*, const int*) {}

}  // namespace trap_test
