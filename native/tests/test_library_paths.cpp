// test_library_paths.cpp — the native library-root resolver.
//
// This is what turns a document's `clip.source.ref = {libraryId, path[]}` into
// a real file. It resolves against the roots the web mirrors to
// /global/library_paths, so the cases that matter are: a root the browser
// couldn't give an absolute path for (dropped), an id from a machine that never
// authored it (label fallback), and a relative path trying to climb out.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

#include "bridge/library_paths.h"

using nlohmann::json;
using nano_assets::LibraryPaths;

namespace {

/// A throwaway directory tree: <tmp>/nano_libtest_<n>/footage/a.mov.
/// std::filesystem so the same test runs on the Windows build.
struct TempTree {
  std::string root;
  TempTree() {
    namespace fs = std::filesystem;
    static int n = 0;
    const fs::path dir = fs::temp_directory_path() /
        ("nano_libtest_" + std::to_string(reinterpret_cast<uintptr_t>(&n) & 0xffff) + "_" +
         std::to_string(++n));
    fs::create_directories(dir / "footage");
    std::ofstream(dir / "footage" / "a.mov") << "x";
    root = dir.generic_string();
  }
  ~TempTree() {
    std::error_code ec;
    std::filesystem::remove_all(root, ec);
  }
};

json rows(const std::string& root) {
  return json::array({
      {{"id", "L1"}, {"label", "Footage"}, {"absolutePath", root}},
  });
}

}  // namespace

TEST_CASE("resolves a document ref to a real file", "[library_paths]") {
  TempTree tree;
  auto& lp = LibraryPaths::instance();
  lp.setRoots(rows(tree.root));

  REQUIRE(lp.resolve("L1", {"footage", "a.mov"}) == tree.root + "/footage/a.mov");
  REQUIRE(lp.resolveRef(json{{"libraryId", "L1"}, {"path", json::array({"footage", "a.mov"})}}) ==
          tree.root + "/footage/a.mov");
  // The library root itself.
  REQUIRE(lp.resolve("L1", {}) == tree.root);
}

TEST_CASE("a file that isn't there resolves to nothing", "[library_paths]") {
  TempTree tree;
  auto& lp = LibraryPaths::instance();
  lp.setRoots(rows(tree.root));

  REQUIRE_FALSE(lp.resolve("L1", {"footage", "gone.mov"}).has_value());
  REQUIRE_FALSE(lp.resolve("NOSUCH", {"footage", "a.mov"}).has_value());
}

TEST_CASE("an unknown library id falls back to the label", "[library_paths]") {
  // Library ids are per-profile UUIDs, so a document authored elsewhere names
  // ids this machine has never seen. The label is the only bridge we have.
  TempTree tree;
  auto& lp = LibraryPaths::instance();
  lp.setRoots(rows(tree.root));

  REQUIRE(lp.resolve("Footage", {"footage", "a.mov"}) == tree.root + "/footage/a.mov");
  REQUIRE(lp.find("Footage").has_value());
  REQUIRE(lp.find("Footage")->id == "L1");
}

TEST_CASE("a relative path cannot climb out of its root", "[library_paths]") {
  TempTree tree;
  auto& lp = LibraryPaths::instance();
  lp.setRoots(rows(tree.root));

  REQUIRE_FALSE(lp.resolve("L1", {"..", "etc", "passwd"}).has_value());
  REQUIRE_FALSE(lp.resolve("L1", {"footage/../.."}).has_value()); // embedded separator
  REQUIRE_FALSE(lp.resolve("L1", {"."}).has_value());
  REQUIRE_FALSE(lp.resolve("L1", {""}).has_value());
}

TEST_CASE("rows without a usable absolute path are dropped", "[library_paths]") {
  // A handle-only library (web-picked, never located) means nothing here — the
  // web filters these out, but a stale mirror must not produce a root of "".
  auto& lp = LibraryPaths::instance();
  lp.setRoots(json::array({
      {{"id", "A"}, {"label", "no path"}},
      {{"id", ""}, {"label", "no id"}, {"absolutePath", "/tmp"}},
      {{"id", "B"}, {"label", "empty path"}, {"absolutePath", ""}},
  }));
  REQUIRE(lp.roots().empty());

  lp.setRoots(json("not an array"));
  REQUIRE(lp.roots().empty());
}

TEST_CASE("a trailing separator on a root is normalized away", "[library_paths]") {
  TempTree tree;
  auto& lp = LibraryPaths::instance();
  lp.setRoots(json::array({
      {{"id", "L1"}, {"label", "Footage"}, {"absolutePath", tree.root + "/"}},
  }));
  REQUIRE(lp.roots()[0].absolutePath == tree.root);
  REQUIRE(lp.resolve("L1", {"footage", "a.mov"}) == tree.root + "/footage/a.mov");
}

TEST_CASE("a malformed ref resolves to nothing", "[library_paths]") {
  TempTree tree;
  auto& lp = LibraryPaths::instance();
  lp.setRoots(rows(tree.root));

  REQUIRE_FALSE(lp.resolveRef(json("nope")).has_value());
  REQUIRE_FALSE(lp.resolveRef(json::object()).has_value());
  REQUIRE_FALSE(lp.resolveRef(json{{"libraryId", "L1"}, {"path", json::array({1, 2})}}).has_value());
  // A ref with no path array at all IS the library root.
  REQUIRE(lp.resolveRef(json{{"libraryId", "L1"}}) == tree.root);
}

TEST_CASE("a foreign id resolves through the ref's recorded label", "[library_paths]") {
  // A document from another profile: its id means nothing here, but it
  // recorded the library's label alongside.
  TempTree tree;
  auto& lp = LibraryPaths::instance();
  lp.setRoots(rows(tree.root));

  const json ref = {{"libraryId", "uuid-elsewhere"}, {"libraryLabel", "Footage"},
                    {"path", json::array({"footage", "a.mov"})}};
  REQUIRE(lp.resolveRef(ref) == tree.root + "/footage/a.mov");
  // The id still wins over the label when both could match.
  REQUIRE(lp.find("L1", "Other").has_value());
  REQUIRE_FALSE(lp.find("uuid-elsewhere", "Other").has_value());
}

#ifdef _WIN32
TEST_CASE("Windows separators are separators", "[library_paths]") {
  TempTree tree;
  auto& lp = LibraryPaths::instance();
  lp.setRoots(json::array({
      {{"id", "L1"}, {"label", "Footage"}, {"absolutePath", tree.root + "\\"}},
  }));
  REQUIRE(lp.roots()[0].absolutePath == tree.root);  // trailing '\' trimmed
  REQUIRE(lp.resolve("L1", {"footage", "a.mov"}).has_value());
  // An embedded backslash is a separator here: it must not smuggle a climb.
  REQUIRE_FALSE(lp.resolve("L1", {"footage\\..\\.."}).has_value());

  lp.setRoots(json::array({{{"id", "R"}, {"label", "root"}, {"absolutePath", "C:\\"}}}));
  REQUIRE(lp.roots()[0].absolutePath == "C:\\");  // a drive root stays a root
}
#endif
