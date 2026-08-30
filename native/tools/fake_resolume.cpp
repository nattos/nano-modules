// fake_resolume — stand up a fake Resolume WebSocket server serving a canned
// composition, so the shared server + editor can be driven headlessly with no
// live Resolume.
//
// Usage:
//   ./fake_resolume [port] [uuid ...]
//     port      — WS port to listen on (default 8090)
//     uuid ...  — instance UUIDs to place, one NanoBarrel per layer clip[0]
//                 (default: three sample UUIDs)
//     --rebroadcast HZ — push the whole composition to every client HZ times a
//                 second, the way live Resolume rebroadcasts on any change. This
//                 is the pump-thread load a barrel actually runs against, and
//                 without it a headless bench measures an idle bridge.
//     --clips N — give every layer N clips instead of 1, and pad each clip with
//                 the transform/audio/mixer parameter blocks a real Arena clip
//                 carries. The canned composition is ~10 KB; a real show
//                 composition is hundreds of KB, and the dylib's per-broadcast
//                 cost scales with that, so a bench on the bare canned doc
//                 measures nothing.
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

// Pad the canned composition out to show size: every layer gets `clips` clips,
// and every clip the parameter blocks Arena actually broadcasts (transform,
// audio, mixer, autopilot, playback). Only clip 0 keeps the NanoBarrel effect —
// the copies are ballast, which is exactly what they are in a real composition
// too, since the dylib walks the whole doc looking for barrels.
static void fatten(nlohmann::json& comp, int clips, int64_t& next_id) {
  using nlohmann::json;
  auto param = [&](const char* type, json value) {
    return json{{"id", next_id++}, {"valuetype", type}, {"value", std::move(value)}};
  };
  auto clip_params = [&]() {
    json p = json::object();
    for (const char* n : {"Position X", "Position Y", "Position Z", "Scale",
                          "Scale X", "Scale Y", "Rotate X", "Rotate Y", "Rotate Z",
                          "Anchor X", "Anchor Y", "Anchor Z", "Opacity", "Volume",
                          "Pan", "Speed", "Duration", "Playhead", "Cue Point",
                          "Blend Mode", "Crossfader Group", "Fade In", "Fade Out"})
      p[n] = param("ParamRange", 0.5);
    for (const char* n : {"Bypassed", "Solo", "Muted", "Loop", "Autopilot"})
      p[n] = param("ParamBoolean", false);
    p["Name"] = param("ParamString", "clip");
    return p;
  };
  for (auto& layer : comp["layers"]) {
    if (!layer.contains("clips") || !layer["clips"].is_array()) continue;
    json first = layer["clips"][0];
    first["transform"] = clip_params();
    first["audio"] = clip_params();
    first["thumbnail"] = bridge::FakeResolumeServer::make_thumbnail(next_id);
    layer["clips"][0] = first;
    for (int c = 1; c < clips; ++c) {
      json extra = first;
      extra["id"] = next_id++;
      extra["video"] = json{{"effects", json::array()}};
      layer["clips"].push_back(std::move(extra));
    }
    layer["transform"] = clip_params();
    layer["audio"] = clip_params();
  }
}

int main(int argc, char** argv) {
  int port = 8090;
  bool markers = false;
  double rebroadcastHz = 0;
  int clipsPerLayer = 1;
  std::vector<std::string> uuids;
  for (int i = 1; i < argc; i++) {
    std::string arg = argv[i];
    if (arg == "--markers") {
      markers = true;
    } else if (arg == "--rebroadcast" && i + 1 < argc) {
      rebroadcastHz = std::atof(argv[++i]);
    } else if (arg == "--clips" && i + 1 < argc) {
      clipsPerLayer = std::atoi(argv[++i]);
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
    nlohmann::json comp = bridge::FakeResolumeServer::make_default_composition(uuids);
    if (clipsPerLayer > 1) {
      int64_t next_id = 900000;
      fatten(comp, clipsPerLayer, next_id);
    }
    std::printf("fake_resolume: composition is %zu KB\n", comp.dump().size() / 1024);
    fake.set_composition(comp);
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

  // Serve until killed. With --rebroadcast, push the composition on a timer.
  if (rebroadcastHz > 0) {
    std::printf("  rebroadcasting the composition at %.1f Hz\n", rebroadcastHz);
    std::fflush(stdout);
    const auto step = std::chrono::duration_cast<std::chrono::steady_clock::duration>(
        std::chrono::duration<double>(1.0 / rebroadcastHz));
    auto next = std::chrono::steady_clock::now();
    while (true) {
      next += step;
      std::this_thread::sleep_until(next);
      fake.rebroadcast();
    }
  }
  while (true) std::this_thread::sleep_for(std::chrono::seconds(1));
  return 0;
}
