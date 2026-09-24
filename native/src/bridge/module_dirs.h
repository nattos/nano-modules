// module_dirs.h — where effect bundles come from.
//
// An effect bundle is a `<stem>.wasm` (bundle id `com.nano.<stem>`). They come
// from three kinds of directory, in rising priority:
//
//   1. BUILT-IN  — the resource root's wasm/ (resource_root.h). A package ships
//                  core, text and richtext there. A dev tree's build/wasm holds
//                  every bundle the repo builds, plus service modules (executor,
//                  bridge_core, naga_spv, ...) that are NOT effect bundles — so
//                  this directory is never scanned: only the known shipping
//                  names are taken from it, and only if present.
//   2. DEFAULT   — the per-user modules directory (defaultModulesDirPath()),
//                  which the installer seeds with the extras (nano, lights,
//                  legacy). It supplies ONLY stems the built-in directory lacks:
//                  a dev tree has fresh builds of those bundles, and a seeded
//                  copy from an installed release must never shadow them — the
//                  same safety rule resource_root.h follows for the install
//                  record.
//   3. MAPPED    — directories the user added (module-paths.json). Every
//                  `*.wasm` in one is an effect bundle, and a mapped stem
//                  REPLACES the same stem from anywhere below: that is how a
//                  developer overrides a shipped bundle with a working copy.
//                  Between two mapped directories, the later one wins.
//
// Replacement is by STEM, so the answer doesn't depend on registration order
// (the native registry is first-wins, the web's last-wins). Two DIFFERENT
// bundles declaring the same effect id is undefined — don't.
//
// The web resolves the same thing in web/electron/module-dirs.cjs; the two
// read one config file, because the barrel runs inside Resolume with no editor
// attached and cannot learn the paths over the bridge.
//
// Header-only, like library_paths.h: consumers are native hosts only, never
// executor.wasm (no filesystem there).

#pragma once

#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "platform/paths.h"

namespace nano_modules {

/// The bundles a package may carry in its resource root, in load order. A dev
/// tree has all of them; a package has core, text and richtext. Keep in step
/// with SHIPPED_EFFECT_BUNDLES in web/src/effect-bundles.ts.
inline const std::vector<std::string>& builtinBundleStems() {
  static const std::vector<std::string> kStems = {
      "core", "text", "richtext", "nano", "lights", "legacy"};
  return kStems;
}

/**
 * The per-user modules directory the installer seeds:
 *   macOS   ~/Library/Application Support/Nano Modules/Modules
 *   Windows %APPDATA%\Nano Modules\Modules
 * i.e. `<dataRoot>/Modules` (nano_paths::dataRootPath, so NANO_DATA_DIR moves
 * it too). `NANO_MODULES_DIR` overrides it (tests, and anyone who wants it elsewhere).
 * Empty when home can't be determined. Not created here.
 */
inline std::string defaultModulesDirPath() {
  if (const char* e = getenv("NANO_MODULES_DIR")) return e;
  const std::string root = nano_paths::dataRootPath();
  return root.empty() ? std::string() : nano_paths::joinPath(root, "Modules");
}

/// `<dataRoot>/Settings/module-paths.json` — the user's mapped directories,
/// written by the desktop app. `NANO_MODULE_PATHS_FILE` overrides it.
inline std::string modulePathsFilePath() {
  if (const char* e = getenv("NANO_MODULE_PATHS_FILE")) return e;
  const std::string dir = nano_paths::settingsDirPath();
  return dir.empty() ? std::string() : nano_paths::joinPath(dir, "module-paths.json");
}

/// The ENABLED mapped directories from `{ "paths": [{ "path", "enabled" }] }`,
/// in file order. A missing or malformed file is simply "none mapped".
inline std::vector<std::string> readMappedDirs(const std::string& file) {
  std::vector<std::string> out;
  if (file.empty()) return out;
  std::ifstream f(file);
  if (!f.good()) return out;
  const std::string blob((std::istreambuf_iterator<char>(f)),
                         std::istreambuf_iterator<char>());
  const auto doc = nlohmann::json::parse(blob, nullptr, false);
  if (!doc.is_object() || !doc.contains("paths") || !doc["paths"].is_array()) return out;
  for (const auto& row : doc["paths"]) {
    if (!row.is_object() || !row.contains("path") || !row["path"].is_string()) continue;
    if (row.contains("enabled") && row["enabled"].is_boolean() && !row["enabled"].get<bool>())
      continue;
    const std::string p = row["path"].get<std::string>();
    if (!p.empty()) out.push_back(p);
  }
  return out;
}

enum class Origin { Builtin, Default, Mapped };

inline const char* originName(Origin o) {
  switch (o) {
    case Origin::Builtin: return "builtin";
    case Origin::Default: return "default";
    case Origin::Mapped:  return "mapped";
  }
  return "?";
}

struct BundleSource {
  std::string stem;  // "nano" -> bundle id com.nano.nano
  std::string path;  // <dir>/<stem>.wasm
  std::string dir;
  Origin origin;
};

/// `<stem>` when `name` is `<stem>.wasm`, else empty.
inline std::string wasmStem(const std::string& name) {
  static const std::string kExt = ".wasm";
  if (name.size() <= kExt.size() ||
      name.compare(name.size() - kExt.size(), kExt.size(), kExt) != 0)
    return {};
  return name.substr(0, name.size() - kExt.size());
}

/**
 * Resolve the bundle set. Pure apart from reading directory listings, so a
 * test can drive it with temp directories. One entry per stem, in load order:
 * built-in stems first (in builtinBundleStems() order), then the rest by first
 * appearance.
 */
inline std::vector<BundleSource> resolveBundles(const std::string& builtinDir,
                                                const std::string& defaultDir,
                                                const std::vector<std::string>& mappedDirs) {
  std::vector<BundleSource> out;
  auto find = [&](const std::string& stem) -> BundleSource* {
    for (auto& b : out) if (b.stem == stem) return &b;
    return nullptr;
  };

  for (const auto& stem : builtinBundleStems()) {
    const std::string p = nano_paths::joinPath(builtinDir, stem + ".wasm");
    if (!builtinDir.empty() && nano_paths::fileExists(p))
      out.push_back({stem, p, builtinDir, Origin::Builtin});
  }
  for (const auto& name : nano_paths::listFiles(defaultDir)) {
    const std::string stem = wasmStem(name);
    if (stem.empty() || find(stem)) continue;  // never shadows the built-in dir
    out.push_back({stem, nano_paths::joinPath(defaultDir, name), defaultDir, Origin::Default});
  }
  for (const auto& dir : mappedDirs) {
    for (const auto& name : nano_paths::listFiles(dir)) {
      const std::string stem = wasmStem(name);
      if (stem.empty()) continue;
      BundleSource src{stem, nano_paths::joinPath(dir, name), dir, Origin::Mapped};
      if (BundleSource* existing = find(stem)) *existing = std::move(src);
      else out.push_back(std::move(src));
    }
  }
  return out;
}

/// The whole answer for this machine: the built-in directory the host already
/// resolved, plus the default and configured mapped directories.
inline std::vector<BundleSource> resolveBundlesForHost(const std::string& builtinDir) {
  return resolveBundles(builtinDir, defaultModulesDirPath(),
                        readMappedDirs(modulePathsFilePath()));
}

}  // namespace nano_modules
