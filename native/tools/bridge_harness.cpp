#include <chrono>
#include <cstdio>
#include <thread>

#include "plugin/bridge_loader.h"

#ifndef BRIDGE_DYLIB_PATH
#error "BRIDGE_DYLIB_PATH must be defined at compile time"
#endif

int main() {
  printf("Bridge Harness — loading dylib from: %s\n", BRIDGE_DYLIB_PATH);

  plugin::BridgeLoader loader;
  if (!loader.load(BRIDGE_DYLIB_PATH)) {
    fprintf(stderr, "Failed to load bridge dylib\n");
    return 1;
  }
  printf("Dylib loaded successfully\n");

  BridgeHandle bridge = loader.bridge_init();
  if (!bridge) {
    fprintf(stderr, "bridge_init() returned null\n");
    return 1;
  }
  printf("Bridge initialized (handle: %p)\n", bridge);

  // Set a test parameter
  loader.bridge_set_param(bridge, 1, 0.5);
  printf("Set param 1 = 0.5, readback = %f\n", loader.bridge_get_param(bridge, 1));

  // Tick loop at ~60Hz for a few seconds
  printf("Running tick loop (60Hz, 3 seconds)...\n");
  auto start = std::chrono::steady_clock::now();
  int ticks = 0;
  while (true) {
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count();
    if (elapsed >= 3000) break;

    loader.bridge_tick(bridge);
    ticks++;
    std::this_thread::sleep_for(std::chrono::milliseconds(16));
  }
  printf("Completed %d ticks in 3 seconds\n", ticks);

  loader.bridge_release(bridge);
  printf("Bridge released. Done.\n");
  return 0;
}
