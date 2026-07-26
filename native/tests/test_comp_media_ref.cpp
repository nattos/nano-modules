// test_comp_media_ref.cpp — a document read off DISK still finds its media.
//
// `clip.source.url` is runtime-only: the web store rebuilds it from a handle
// (`relinkMedia`) and `serializeComposition` strips it before writing. So a
// `.nano-arr` on disk carries only the portable `clip.source.ref`
// ({libraryId, path[]}), and until the host resolves that, every video clip in
// it parses as effect-only — no video desc, no content stream, nothing for a
// pump to decode. The web never notices because its store fills `url` in long
// before the document reaches the engine.
//
// comp_model.h can't do the lookup itself (it is dual-compiled into
// executor.wasm, which has no filesystem), so it takes a resolver from the
// host — bridge/comp_media_resolver.h. These tests pin that seam.

#include <catch2/catch_test_macros.hpp>

#include <cstdlib>
#include <fstream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include <nlohmann/json.hpp>

#include "bridge/comp_media_resolver.h"
#include "bridge/library_paths.h"
#include "sketch/comp/comp_executor.h"

using json = nlohmann::json;

namespace {

/// A throwaway library root: <tmp>/nano_mediaref_<pid>/footage/a.mov
struct TempLibrary {
  std::string root;
  TempLibrary() {
    const char* tmp = getenv("TMPDIR");
    root = std::string(tmp ? tmp : "/tmp");
    if (!root.empty() && root.back() == '/') root.pop_back();
    root += "/nano_mediaref_" + std::to_string(::getpid());
    ::mkdir(root.c_str(), 0755);
    ::mkdir((root + "/footage").c_str(), 0755);
    std::ofstream(root + "/footage/a.mov") << "x";
    nano_assets::LibraryPaths::instance().setRoots(json::array({
        {{"id", "L1"}, {"label", "Footage"}, {"absolutePath", root}},
    }));
  }
  ~TempLibrary() {
    nano_assets::LibraryPaths::instance().setRoots(json::array());
    ::remove((root + "/footage/a.mov").c_str());
    ::rmdir((root + "/footage").c_str());
    ::rmdir(root.c_str());
  }
  std::string media() const { return root + "/footage/a.mov"; }
};

/// The resolver is a process-global installed once at host startup; these tests
/// install and remove it around themselves so ordering can't leak.
struct ResolverGuard {
  ResolverGuard() { nano_assets::installLibraryMediaResolver(); }
  ~ResolverGuard() { comp::setMediaRefResolver(nullptr); }
};

json mkDevice(const std::string& id, const std::string& type) {
  return {{"id", id}, {"moduleType", type}, {"name", type},
          {"capabilities", json::array()}, {"state", json::object()}};
}

/// A video clip whose `source` block is supplied verbatim — the whole point of
/// these tests is which of `url` / `ref` it carries.
json mkVideoClip(const std::string& id, json source) {
  return {{"id", id}, {"name", id}, {"startBeat", 0}, {"lengthBeat", 8},
          {"kind", "video"},
          {"sketch", {{"devices", json::array({mkDevice(id + "_v", "source.video.file")})}}},
          {"loop", {{"mode", "time"}, {"startSec", 0}, {"speed", 1}, {"direction", "forward"}}},
          {"automation", json::array()}, {"exports", json::array()},
          {"warps", json::array()},
          {"source", std::move(source)}};
}

json mkDoc(json clip) {
  return {{"meta", {{"resolution", {{"width", 1920}, {"height", 1080}}},
                    {"baseBPM", 120}, {"timeSignature", {4, 4}}}},
          {"tracks", json::array({
              {{"id", "t1"}, {"name", "t1"}, {"kind", "track"}, {"parentId", nullptr},
               {"sketch", {{"devices", json::array()}}}, {"automation", json::array()},
               {"clips", json::array({std::move(clip)})}},
              {{"id", "main-bus"}, {"name", "Main Bus"}, {"kind", "group"},
               {"parentId", nullptr}, {"sketch", {{"devices", json::array()}}},
               {"automation", json::array()}, {"clips", json::array()}}})},
          {"rails", json::array()},
          {"playMode", {{"defaultMode", "time"}}}};
}

/// Null backends — update() never touches effrt/gpu on this document, so the
/// desc contract is testable without a device.
struct Harness {
  comp::CompExecutor cx{nullptr, nullptr, nullptr};
  Harness() {
    cx.registerSchema("source.video.file", json::object());
    cx.registerCapabilities("source.video.file", json::array({"generator"}));
  }
  /// The video descs after settling on the clip. Fluid transport: a Precise
  /// hold would freeze on the (never-ready) media and tell us nothing.
  json descs(const json& doc) {
    cx.loadDocument(doc);
    cx.setTransportMode(false);
    cx.seekBeat(1.0);
    cx.update(0.0);
    return json::parse(cx.videoDescsJson());
  }
};

json libRef() {
  return json{{"libraryId", "L1"}, {"path", json::array({"footage", "a.mov"})}};
}

json refSource(json ref) {
  return json{{"label", "a.mov"}, {"durationFrames", 300}, {"sourceKey", "k1"},
              {"fps", 30}, {"ref", std::move(ref)}};
}

}  // namespace

TEST_CASE("a disk-loaded document resolves source.ref to a real file", "[comp_media_ref]") {
  TempLibrary lib;
  ResolverGuard guard;
  Harness h;

  const json descs = h.descs(mkDoc(mkVideoClip("v1", refSource(libRef()))));
  REQUIRE(descs.is_array());
  REQUIRE(descs.size() == 1);
  CHECK(descs[0]["clipId"] == "v1");
  // The desc ships the ABSOLUTE PATH, not a url — the native pump opens files.
  CHECK(descs[0]["url"] == lib.media());
  CHECK(descs[0]["sourceKey"] == "k1");
}

TEST_CASE("without a resolver installed, a ref-only clip is effect-only", "[comp_media_ref]") {
  TempLibrary lib;  // roots present, but nothing bridges them to the model
  Harness h;

  // This is the shipped behaviour before the resolver seam existed, and it is
  // still the correct answer on a host that can't reach a filesystem (web,
  // where the store has already filled `url` in by this point).
  CHECK(h.descs(mkDoc(mkVideoClip("v1", refSource(libRef())))).empty());
}

TEST_CASE("a ref pointing at missing media stays effect-only", "[comp_media_ref]") {
  TempLibrary lib;
  ResolverGuard guard;
  Harness h;

  // No desc, and — the part that matters — no readiness gate: a Precise
  // transport must not sit holding the playhead for media nobody can open.
  const json gone = json{{"libraryId", "L1"}, {"path", json::array({"footage", "nope.mov"})}};
  CHECK(h.descs(mkDoc(mkVideoClip("v1", refSource(gone)))).empty());
}

TEST_CASE("a runtime url still wins over the ref", "[comp_media_ref]") {
  TempLibrary lib;
  ResolverGuard guard;
  Harness h;

  // The web path: the store relinked the media this session and handed the
  // engine a live object url. The portable ref rides along but must not
  // displace it.
  json src = refSource(libRef());
  src["url"] = "blob:media/v1";
  const json descs = h.descs(mkDoc(mkVideoClip("v1", std::move(src))));
  REQUIRE(descs.size() == 1);
  CHECK(descs[0]["url"] == "blob:media/v1");
}

TEST_CASE("an unknown library id resolves to nothing", "[comp_media_ref]") {
  TempLibrary lib;
  ResolverGuard guard;
  Harness h;

  const json other = json{{"libraryId", "L-other"}, {"path", json::array({"footage", "a.mov"})}};
  CHECK(h.descs(mkDoc(mkVideoClip("v1", refSource(other)))).empty());
}
