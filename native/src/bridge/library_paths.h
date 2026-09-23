// library_paths.h — the native half of the web's library-path mechanism
// (web/src/state/library-paths.ts).
//
// A document addresses its media RELATIVE to a library root
// (`clip.source.ref = {libraryId, path[]}` — see web/.../model/composition.ts),
// because that's the only binding that survives leaving the browser profile
// that authored it. Turning one back into a file needs the root's ABSOLUTE
// PATH, which the browser cannot discover: the web mirrors whatever roots it
// does have a path for to /global/library_paths, and BarrelRuntime persists
// them to a sidecar so headless restarts keep resolving.
//
// Header-only ON PURPOSE. The comp code is dual-compiled into executor.wasm,
// which has no filesystem — nothing under src/sketch/comp/ may include this.
// Its consumer is the native host.

#pragma once

#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "platform/paths.h"

namespace nano_assets {

struct LibraryRoot {
  std::string id;
  std::string label;
  std::string absolutePath;  // no trailing separator
};

class LibraryPaths {
 public:
  static LibraryPaths& instance() {
    static LibraryPaths inst;
    return inst;
  }

  /// Replace the roots. `rows` is the /global/library_paths array:
  /// [{id, label, absolutePath}]. Rows without a usable absolute path are
  /// dropped — a handle-only library means nothing here.
  void setRoots(const nlohmann::json& rows) {
    std::vector<LibraryRoot> next;
    if (rows.is_array()) {
      for (const auto& r : rows) {
        if (!r.is_object()) continue;
        LibraryRoot root;
        root.id = r.value("id", std::string());
        root.label = r.value("label", std::string());
        root.absolutePath = trimTrailingSlash(r.value("absolutePath", std::string()));
        if (root.id.empty() || root.absolutePath.empty()) continue;
        next.push_back(std::move(root));
      }
    }
    std::lock_guard<std::mutex> lk(mu_);
    roots_ = std::move(next);
  }

  std::vector<LibraryRoot> roots() const {
    std::lock_guard<std::mutex> lk(mu_);
    return roots_;
  }

  /// Absolute path of `relPath` under library `libraryId`, or nullopt when the
  /// library is unknown, the relative path is unsafe, or nothing is there.
  ///
  /// Falls back to matching by LABEL when the id misses. Library ids are
  /// per-profile UUIDs, so a document authored on another machine carries ids
  /// this one has never seen; the label the document recorded
  /// (`ref.libraryLabel`) is the only bridge. An id that IS a label also
  /// matches, for documents from before labels were recorded.
  std::optional<std::string> resolve(const std::string& libraryId,
                                     const std::vector<std::string>& relPath,
                                     const std::string& libraryLabel = std::string()) const {
    std::string base;
    {
      std::lock_guard<std::mutex> lk(mu_);
      const LibraryRoot* hit = findLocked(libraryId, libraryLabel);
      if (!hit) return std::nullopt;
      base = hit->absolutePath;
    }
    std::string full = base;
    for (const auto& seg : relPath) {
      // Never let a document's relative path climb out of its library root.
      if (seg.empty() || seg == "." || seg == "..") return std::nullopt;
      for (char ch : seg) {
        if (nano_paths::isSep(ch)) return std::nullopt;
      }
      full = nano_paths::joinPath(full, seg);
    }
    if (!nano_paths::fileExists(full) && !nano_paths::dirExists(full)) return std::nullopt;
    return full;
  }

  /// Same, taking the document's ref object verbatim:
  /// {libraryId, path:[...], libraryLabel?}.
  std::optional<std::string> resolveRef(const nlohmann::json& ref) const {
    if (!ref.is_object()) return std::nullopt;
    const std::string id = ref.value("libraryId", std::string());
    if (id.empty()) return std::nullopt;
    std::vector<std::string> rel;
    if (ref.contains("path") && ref["path"].is_array()) {
      for (const auto& p : ref["path"]) {
        if (!p.is_string()) return std::nullopt;
        rel.push_back(p.get<std::string>());
      }
    }
    std::string label;
    if (ref.contains("libraryLabel") && ref["libraryLabel"].is_string())
      label = ref["libraryLabel"].get<std::string>();
    return resolve(id, rel, label);
  }

  /// The root a ref would resolve against, for diagnostics/UI.
  std::optional<LibraryRoot> find(const std::string& libraryId,
                                  const std::string& libraryLabel = std::string()) const {
    std::lock_guard<std::mutex> lk(mu_);
    const LibraryRoot* hit = findLocked(libraryId, libraryLabel);
    return hit ? std::optional<LibraryRoot>(*hit) : std::nullopt;
  }

 private:
  LibraryPaths() = default;

  /// Id, then the recorded label, then an id that is itself a label.
  const LibraryRoot* findLocked(const std::string& libraryId,
                                const std::string& libraryLabel) const {
    for (const auto& r : roots_) if (r.id == libraryId) return &r;
    for (const std::string& want : {libraryLabel, libraryId}) {
      if (want.empty()) continue;
      for (const auto& r : roots_) if (!r.label.empty() && r.label == want) return &r;
    }
    return nullptr;
  }

  static std::string trimTrailingSlash(std::string p) {
    // Keep a bare root ("/", "C:\") intact.
    while (p.size() > 1 && nano_paths::isSep(p.back()) &&
           !(p.size() == 3 && p[1] == ':')) {
      p.pop_back();
    }
    return p;
  }

  mutable std::mutex mu_;
  std::vector<LibraryRoot> roots_;
};

}  // namespace nano_assets
