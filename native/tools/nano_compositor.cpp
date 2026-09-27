// nano_compositor — the arrangement's composition engine as a native process.
//
// The editor (the arrangement app, or a test) talks to it exactly as Remote
// Control talks to the FFGL barrel: over the bridge's WebSocket, with the
// state document plus actions. Everything real lives in libbridge_server —
// the shared runtime and its composition instance (BarrelRuntime::createComp);
// this process only starts them and paces the frames.
//
//   nano_compositor [--port 8091] [--key compositor] [--size 640x360] [--hz 60]
//
// Protocol (all actions carry {"key": <key>}; see barrel_runtime.h createComp):
//   comp_load_doc / comp_control / comp_op / comp_resize / comp_clock /
//   comp_step / comp_readback / comp_visibility
// Out: NBCJ messages (comp_report every frame, replies), NBPS/NBPV previews
// for /plugins/<key>/state/preview_requests, and plugin_states /
// modulation_data / plugin_schemas in the state document.
//
// Prints one line, "nano_compositor ready port=<p> key=<k>", once it listens.
// Exits on SIGINT/SIGTERM, or when stdin reaches EOF if stdin isn't a
// terminal — so a parent that dies (Electron, a test) takes it with it.
//
// Environment: NANO_RESOURCE_ROOT (where wasm/ and fonts/ are; otherwise found
// by walking up from this executable), NANO_DATA_DIR (settings + modules),
// NANO_BRIDGE_PORT (instead of --port). Resolume is never dialled.

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

#include <unistd.h>

#include "bridge/bridge_api.h"
#include "platform/resource_root.h"

namespace {

std::atomic<bool> g_stop{false};
std::atomic<bool> g_dirty{true};

void onSignal(int) { g_stop.store(true); }

void onPatch(const char*, void*) { g_dirty.store(true); }

struct Args {
  int port = 0;
  std::string key = "compositor";
  int width = 640;
  int height = 360;
  double hz = 60.0;
};

bool parseArgs(int argc, char** argv, Args& a) {
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto next = [&]() -> const char* { return i + 1 < argc ? argv[++i] : nullptr; };
    if (arg == "--port") {
      const char* v = next();
      if (!v) return false;
      a.port = std::atoi(v);
    } else if (arg == "--key") {
      const char* v = next();
      if (!v) return false;
      a.key = v;
    } else if (arg == "--size") {
      const char* v = next();
      if (!v || std::sscanf(v, "%dx%d", &a.width, &a.height) != 2) return false;
    } else if (arg == "--hz") {
      const char* v = next();
      if (!v) return false;
      a.hz = std::atof(v);
    } else {
      return false;
    }
  }
  return a.width > 0 && a.height > 0 && a.hz > 0;
}

}  // namespace

int main(int argc, char** argv) {
  Args args;
  if (!parseArgs(argc, argv, args)) {
    std::fprintf(stderr,
        "usage: nano_compositor [--port N] [--key K] [--size WxH] [--hz N]\n");
    return 2;
  }
  // Before bridge_init: the server reads both while it starts.
  setenv("NANO_NO_RESOLUME", "1", 1);
  if (args.port > 0) setenv("NANO_BRIDGE_PORT", std::to_string(args.port).c_str(), 1);
  const char* portEnv = getenv("NANO_BRIDGE_PORT");
  const int port = portEnv && std::atoi(portEnv) > 0 ? std::atoi(portEnv) : 8081;

  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);
  std::signal(SIGPIPE, SIG_IGN);

  BridgeHandle h = bridge_init();
  if (!h) {
    std::fprintf(stderr, "nano_compositor: bridge_init failed\n");
    return 1;
  }

  const std::string wasmDir = nano_paths::wasmDir((const void*)&main);
  const std::string fontPath = nano_paths::fontPath((const void*)&main, "default.ttf");
  if (wasmDir.empty()) {
    std::fprintf(stderr, "nano_compositor: no resource root (set NANO_RESOURCE_ROOT)\n");
    bridge_release(h);
    return 1;
  }
  if (!bridge_rt_acquire(h, wasmDir.c_str(), fontPath.c_str())) {
    std::fprintf(stderr, "nano_compositor: no effects loaded from %s\n", wasmDir.c_str());
    bridge_release(h);
    return 1;
  }

  char keyBuf[256] = {0};
  bridge_register_plugin(h, "com.nano.compositor", 1, 0, 0, "", args.key.c_str(),
                         keyBuf, (int32_t)sizeof(keyBuf));
  const std::string key = keyBuf;
  if (char* schemas = bridge_rt_schemas(h)) {
    bridge_set_at(h, ("/plugins/" + key + "/state/plugin_schemas").c_str(), schemas);
    bridge_free_string(schemas);
  }
  if (!bridge_comp_create(h, key.c_str(), args.width, args.height)) {
    std::fprintf(stderr, "nano_compositor: this build has no composition host\n");
    bridge_unregister_plugin(h, key.c_str());
    bridge_rt_release(h);
    bridge_release(h);
    return 1;
  }
  bridge_register_patch_listener(h, key.c_str(), onPatch, nullptr);

  // A parent that goes away closes our stdin: go with it.
  if (!isatty(STDIN_FILENO)) {
    std::thread([] {
      char buf[256];
      while (read(STDIN_FILENO, buf, sizeof(buf)) > 0) {}
      g_stop.store(true);
    }).detach();
  }

  std::printf("nano_compositor ready port=%d key=%s\n", port, key.c_str());
  std::fflush(stdout);

  using clock = std::chrono::steady_clock;
  const auto period = std::chrono::duration_cast<clock::duration>(
      std::chrono::duration<double>(1.0 / args.hz));
  auto last = clock::now();
  auto next = last;
  while (!g_stop.load()) {
    const auto now = clock::now();
    // Clamp: a stall (a debugger, a long shader compile) must not hand the
    // effects one giant step.
    const double dt = std::min(0.25, std::chrono::duration<double>(now - last).count());
    last = now;
    bridge_comp_render(h, key.c_str(), dt, g_dirty.exchange(false) ? 1 : 0);
    next += period;
    if (next < clock::now()) next = clock::now();  // fell behind: don't burst
    std::this_thread::sleep_until(next);
  }

  bridge_unregister_patch_listener(h, key.c_str());
  bridge_comp_destroy(h, key.c_str());
  bridge_unregister_plugin(h, key.c_str());
  bridge_rt_release(h);
  bridge_release(h);
  return 0;
}
