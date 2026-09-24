// settings_file.h — the plugin's half of the shared settings folder.
//
// The desktop apps and the FFGL plugin keep their settings in
// `<dataRoot>/Settings/` (nano_paths::settingsDirPath): one JSON file per
// surface, plus files for data several of them share —
//
//   plugin.json          this plugin's knobs (barrel_runtime.cpp)
//   midi-devices.json    the MIDI device library, shared with Remote Control
//   library-paths.json   library roots, shared with the arrangement app
//   module-paths.json    mapped module directories (module_dirs.h, read-only here)
//
// The JS half is web/src/state/settings-files.ts. KEEP THE TWO IN STEP:
//
//   - Writes are atomic (`<name>.tmp`, then rename), pretty-printed with two
//     spaces and a trailing newline — the same bytes JSON.stringify(x, null, 2)
//     produces for the same key order, which is why `ordered_json` is used.
//   - A write whose bytes equal what we last read or wrote is skipped, and a
//     poll ignores content equal to that same last-known content. That is how
//     our own saves don't come back as "external" changes.
//   - External edits apply LIVE. The plugin has no directory watcher; its
//     existing 1 Hz housekeeping poll checks each file's mtime+size and only
//     re-reads when that moved.
//   - Invalid JSON is ignored (the current values stay).
//
// Header-only, like platform/paths.h, so tests exercise exactly this code.

#pragma once

#include <optional>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "platform/paths.h"

namespace nano_settings {

/// `<settingsDir>/<name>`; empty when home can't be determined.
inline std::string settingsFilePath(const char* name) {
  const std::string dir = nano_paths::settingsDirPath();
  return dir.empty() ? std::string() : nano_paths::joinPath(dir, name);
}

/// Serialize the way every writer does, so equal content is equal bytes.
inline std::string formatJson(const nlohmann::ordered_json& j) {
  return j.dump(2) + "\n";
}

/**
 * One settings file this process reads, watches and writes.
 *
 * Not thread-safe: each is owned by the thread that polls it (the runtime's
 * housekeeping tick).
 */
class WatchedFile {
 public:
  WatchedFile() = default;
  explicit WatchedFile(std::string path) : path_(std::move(path)) {}

  const std::string& path() const { return path_; }

  /**
   * The file's bytes if it changed on disk since we last read or wrote it,
   * else nullopt. The first call reports the file as it is (if present). A
   * deleted file is not a change — nothing to apply.
   */
  std::optional<std::string> poll() {
    if (path_.empty()) return std::nullopt;
    const nano_paths::FileStamp now = nano_paths::statFile(path_);
    if (now == stamp_ && primed_) return std::nullopt;
    primed_ = true;
    stamp_ = now;
    if (!now.exists) return std::nullopt;
    std::string bytes;
    if (!nano_paths::readFileBytes(path_, bytes)) return std::nullopt;
    if (known_ && bytes == lastBytes_) return std::nullopt;
    lastBytes_ = bytes;
    known_ = true;
    return bytes;
  }

  /// The parsed document behind `poll()`'s bytes, or discarded on bad JSON.
  static nlohmann::ordered_json parse(const std::string& bytes) {
    return nlohmann::ordered_json::parse(bytes, nullptr, false);
  }

  /// The current file, parsed (without consuming a change). Discarded when
  /// missing or malformed.
  nlohmann::ordered_json read() const {
    std::string bytes;
    if (path_.empty() || !nano_paths::readFileBytes(path_, bytes))
      return nlohmann::ordered_json(nlohmann::ordered_json::value_t::discarded);
    return parse(bytes);
  }

  /// Atomically replace the file with `j`. False when skipped (unchanged, or
  /// no path) or the write failed.
  bool write(const nlohmann::ordered_json& j) {
    if (path_.empty()) return false;
    const std::string bytes = formatJson(j);
    if (known_ && bytes == lastBytes_) return false;
    nano_paths::ensureDir(nano_paths::dataRootPath());
    nano_paths::ensureDir(nano_paths::parentDir(path_));
    if (!nano_paths::writeFileAtomic(path_, bytes)) return false;
    lastBytes_ = bytes;
    known_ = true;
    stamp_ = nano_paths::statFile(path_);
    primed_ = true;
    return true;
  }

 private:
  std::string path_;
  nano_paths::FileStamp stamp_;
  bool primed_ = false;
  std::string lastBytes_;
  bool known_ = false;
};

/**
 * Upsert `rows` into `base` by their "id" field: a row with a known id
 * overwrites that row's fields in place (fields it doesn't carry are kept —
 * `addedAt`, say), a new id is appended, and every other row of
 * `base` is kept. Rows without a string id are ignored. Used where a list is
 * pushed by one party but the file is shared — a browser's library roots
 * merge INTO library-paths.json rather than erasing the desktop's.
 */
inline nlohmann::ordered_json upsertById(const nlohmann::ordered_json& base,
                                         const nlohmann::ordered_json& rows) {
  nlohmann::ordered_json out =
      base.is_array() ? base : nlohmann::ordered_json::array();
  if (!rows.is_array()) return out;
  for (const auto& r : rows) {
    if (!r.is_object() || !r.contains("id") || !r["id"].is_string()) continue;
    bool replaced = false;
    for (auto& o : out) {
      if (o.is_object() && o.contains("id") && o["id"] == r["id"]) {
        for (auto it = r.begin(); it != r.end(); ++it) o[it.key()] = it.value();
        replaced = true;
        break;
      }
    }
    if (!replaced) out.push_back(r);
  }
  return out;
}

}  // namespace nano_settings
