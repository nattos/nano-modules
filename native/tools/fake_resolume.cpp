// fake_resolume — stand up a fake Resolume WebSocket server serving a canned
// composition with a few NanoBarrel effects, so the shared server + editor can
// be driven headlessly with no live Resolume.
//
// Usage:
//   ./fake_resolume [port] [uuid ...]
//     port     — WS port to listen on (default 8090)
//     uuid ... — instance UUIDs to place, one NanoBarrel per layer clip[0]
//                (default: three sample UUIDs)
//
// Then point the dylib at it:
//   NANO_RESOLUME_URL=ws://127.0.0.1:<port>/api/v1 <run the barrel / a tool>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "../tests/fake_resolume_server.h"

int main(int argc, char** argv) {
  int port = 8090;
  std::vector<std::string> uuids;
  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    if (i == 1) {
      port = std::atoi(arg.c_str());
      if (port <= 0) port = 8090;
    } else {
      uuids.push_back(arg);
    }
  }
  if (uuids.empty()) {
    uuids = {
      "9B96D63F-FFFC-4477-97B2-78F8E0CE1795",
      "3E98E36B-635C-4998-85BF-570E12F378D1",
      "775ED20A-7351-43CE-A358-6C401DA2E8B7",
    };
  }

  bridge::FakeResolumeServer fake;
  fake.set_composition(bridge::FakeResolumeServer::make_default_composition(uuids));
  if (!fake.start(port)) {
    std::fprintf(stderr, "fake_resolume: failed to bind port %d\n", port);
    return 1;
  }
  std::printf("fake_resolume: serving %zu NanoBarrel(s) on port %d\n", uuids.size(), port);
  std::printf("  point the dylib at it with:\n");
  std::printf("    NANO_RESOLUME_URL=ws://127.0.0.1:%d/api/v1\n", port);
  std::fflush(stdout);

  // Serve until killed.
  while (true) std::this_thread::sleep_for(std::chrono::seconds(1));
  return 0;
}
