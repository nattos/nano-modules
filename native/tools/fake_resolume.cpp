// fake_resolume — stand up a fake Resolume WebSocket server serving a canned
// composition, so the shared server + editor can be driven headlessly with no
// live Resolume.
//
// Usage:
//   ./fake_resolume [port] [uuid ...]
//     port      — WS port to listen on (default 8090)
//     uuid ...  — instance UUIDs to place, one NanoBarrel per layer clip[0]
//                 (default: three sample UUIDs)
//     --markers — instead serve NanoLooper Ch scene markers (channels 1/2/3,
//                 clip 1 Connected), each with an inline config blob + a
//                 thumbnail — for debugging the Trigger Channels grid headlessly
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
  bool markers = false;
  std::vector<std::string> uuids;
  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    if (arg == "--markers") {
      markers = true;
    } else if (uuids.empty() && port == 8090 && std::atoi(arg.c_str()) > 0 &&
               arg.find('-') == std::string::npos) {
      port = std::atoi(arg.c_str());
    } else {
      uuids.push_back(arg);
    }
  }

  bridge::FakeResolumeServer fake;
  size_t count = 0;
  const char* kind = "NanoBarrel";
  if (markers) {
    using MS = bridge::FakeResolumeServer::MarkerSpec;
    std::vector<MS> specs = {
      MS{"D1E59BA1-DD92-4238-8F04-9D8E4B611602", 1, "Bass",  "Connected",    false},
      MS{"EF291FB9-6A37-4D85-9240-A3A8ACBB05C1", 2, "Drums", "Disconnected", false},
      MS{"104B7ED2-1256-44EE-95A1-B944D048994D", 3, "",      "Disconnected", false},
    };
    fake.set_composition(bridge::FakeResolumeServer::make_marker_composition(specs));
    count = specs.size();
    kind = "NanoLooper Ch marker";
  } else {
    if (uuids.empty()) {
      uuids = {
        "9B96D63F-FFFC-4477-97B2-78F8E0CE1795",
        "3E98E36B-635C-4998-85BF-570E12F378D1",
        "775ED20A-7351-43CE-A358-6C401DA2E8B7",
      };
    }
    fake.set_composition(bridge::FakeResolumeServer::make_default_composition(uuids));
    count = uuids.size();
  }
  if (!fake.start(port)) {
    std::fprintf(stderr, "fake_resolume: failed to bind port %d\n", port);
    return 1;
  }
  std::printf("fake_resolume: serving %zu %s(s) on port %d\n", count, kind, port);
  std::printf("  point the dylib at it with:\n");
  std::printf("    NANO_RESOLUME_URL=ws://127.0.0.1:%d/api/v1\n", port);
  std::fflush(stdout);

  // Serve until killed.
  while (true) std::this_thread::sleep_for(std::chrono::seconds(1));
  return 0;
}
