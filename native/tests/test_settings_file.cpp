// test_settings_file.cpp — the shared settings folder, plugin side.
//
// The desktop apps and the plugin read and write the same files in
// <dataRoot>/Settings/, each watching for the others' (and agents') edits. What
// has to hold for that to work without loops or lost data: writes are atomic,
// our own writes never read back as external changes, an external edit always
// does, and the bytes match what the JS side (settings-files.ts) writes.

#include <catch2/catch_test_macros.hpp>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

#include "bridge/module_dirs.h"
#include "bridge/settings_file.h"
#include "platform/paths.h"

using nlohmann::ordered_json;
using nano_settings::WatchedFile;

namespace {

void setEnv(const char* name, const char* value) {
#ifdef _WIN32
  _putenv_s(name, value ? value : "");
#else
  if (value) setenv(name, value, 1);
  else unsetenv(name);
#endif
}

/// A throwaway data root, installed as NANO_DATA_DIR for the test's lifetime.
struct TempRoot {
  std::string root;
  TempRoot() {
    namespace fs = std::filesystem;
    static int n = 0;
    const fs::path dir = fs::temp_directory_path() /
        ("nano_settings_" + std::to_string(reinterpret_cast<uintptr_t>(&n) & 0xffff) + "_" +
         std::to_string(++n));
    fs::remove_all(dir);
    fs::create_directories(dir);
    root = dir.generic_string();
    setEnv("NANO_DATA_DIR", root.c_str());
  }
  ~TempRoot() {
    setEnv("NANO_DATA_DIR", nullptr);
    std::error_code ec;
    std::filesystem::remove_all(root, ec);
  }
};

/// Someone else writing the file (an agent, the other app): plain write.
void externalWrite(const std::string& path, const std::string& bytes) {
  std::filesystem::create_directories(std::filesystem::path(path).parent_path());
  std::ofstream(path, std::ios::binary | std::ios::trunc) << bytes;
}

}  // namespace

TEST_CASE("NANO_DATA_DIR moves every per-user location", "[settings_file]") {
  TempRoot t;
  setEnv("NANO_MODULES_DIR", nullptr);
  setEnv("NANO_MODULE_PATHS_FILE", nullptr);
  REQUIRE(nano_paths::dataRootPath() == t.root);
  REQUIRE(nano_paths::settingsDirPath() == t.root + "/Settings");
  REQUIRE(nano_modules::defaultModulesDirPath() == t.root + "/Modules");
  REQUIRE(nano_modules::modulePathsFilePath() == t.root + "/Settings/module-paths.json");
  REQUIRE(nano_settings::settingsFilePath("plugin.json") == t.root + "/Settings/plugin.json");
  // Readers don't create anything; writers do.
  REQUIRE_FALSE(nano_paths::dirExists(nano_paths::settingsDirPath()));
  REQUIRE(nano_paths::settingsDir() == t.root + "/Settings");
  REQUIRE(nano_paths::dirExists(t.root + "/Settings"));
}

TEST_CASE("our own writes never read back as external changes", "[settings_file]") {
  TempRoot t;
  WatchedFile f(nano_settings::settingsFilePath("midi-devices.json"));

  // Nothing there yet: nothing to apply.
  REQUIRE_FALSE(f.poll().has_value());

  REQUIRE(f.write(ordered_json::array({{{"id", "a"}}})));
  REQUIRE_FALSE(f.poll().has_value());
  // Same content again: skipped, not rewritten.
  REQUIRE_FALSE(f.write(ordered_json::array({{{"id", "a"}}})));
  // Atomic: the temp file is gone once the rename landed.
  REQUIRE_FALSE(nano_paths::fileExists(f.path() + ".tmp"));
  REQUIRE(f.read() == ordered_json::array({{{"id", "a"}}}));
}

TEST_CASE("an external edit is picked up once", "[settings_file]") {
  TempRoot t;
  const std::string path = nano_settings::settingsFilePath("plugin.json");
  externalWrite(path, "{\"previewHz\": 15}\n");

  WatchedFile f(path);
  auto first = f.poll();   // the file as it is at startup
  REQUIRE(first.has_value());
  REQUIRE(WatchedFile::parse(*first)["previewHz"] == 15);
  REQUIRE_FALSE(f.poll().has_value());

  // Different size, so the stamp moves even on a coarse clock.
  externalWrite(path, "{\"previewHz\": 60, \"previewMaxDim\": 512}\n");
  auto second = f.poll();
  REQUIRE(second.has_value());
  REQUIRE(WatchedFile::parse(*second)["previewMaxDim"] == 512);
  REQUIRE_FALSE(f.poll().has_value());

  // Broken JSON arrives as bytes that don't parse — the caller keeps its
  // values — and isn't reported again.
  externalWrite(path, "{ not json");
  auto broken = f.poll();
  REQUIRE(broken.has_value());
  REQUIRE(WatchedFile::parse(*broken).is_discarded());
  REQUIRE_FALSE(f.poll().has_value());
}

TEST_CASE("the bytes match what the desktop app writes", "[settings_file]") {
  // settings-files.ts: JSON.stringify(doc, null, 2) + '\n', key order kept.
  const auto doc = ordered_json::parse(R"({"zeta":[1,2],"alpha":{},"list":[],"s":"x"})");
  REQUIRE(nano_settings::formatJson(doc) ==
          "{\n  \"zeta\": [\n    1,\n    2\n  ],\n  \"alpha\": {},\n  \"list\": [],\n"
          "  \"s\": \"x\"\n}\n");
}

TEST_CASE("pushed rows merge into a shared list by id", "[settings_file]") {
  const auto file = ordered_json::parse(R"([
    {"id":"desk","label":"Footage","absolutePath":"/a","addedAt":1},
    {"id":"web","label":"Old","absolutePath":"/old","addedAt":2}
  ])");
  const auto pushed = ordered_json::parse(R"([
    {"id":"web","label":"New","absolutePath":"/new"},
    {"id":"web2","label":"Other","absolutePath":"/b"},
    {"label":"no id"}
  ])");
  const auto merged = nano_settings::upsertById(file, pushed);
  REQUIRE(merged.size() == 3);
  REQUIRE(merged[0]["id"] == "desk");                 // untouched
  REQUIRE(merged[1]["absolutePath"] == "/new");       // updated in place...
  REQUIRE(merged[1]["addedAt"] == 2);                 // ...keeping what it didn't carry
  REQUIRE(merged[2]["id"] == "web2");                 // appended
  // A missing/garbage file is an empty list.
  REQUIRE(nano_settings::upsertById(ordered_json(), pushed).size() == 2);
}
