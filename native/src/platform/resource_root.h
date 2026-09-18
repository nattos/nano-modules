// resource_root.h — where the READ-ONLY shared payload lives: the effect WASM
// bundles (+ their per-arch AOT sidecars) and the fonts.
//
// The barrel used to carry a private 60 MB copy of all of it inside
// NanoBarrel.bundle/Contents/Resources, deployed by a CMake stamp that had to
// re-codesign the bundle on every effect rebuild (any write into Resources
// after `codesign` breaks the ad-hoc seal, and Resolume then refuses the load).
// Now one directory serves both the plugin and the Electron app:
//
//     <root>/nano-resources.json     marker, so a walk can recognise the root
//     <root>/wasm/<bundle>.wasm      + <bundle>-<arch>.aot
//     <root>/fonts/default.ttf
//
// In the dev tree that root is the repo's `build/`. In a release it is
// `Nano.app/Contents/Resources/nano/` (Windows: `resources\nano\`), with the
// plugin nested at `<root>/ffgl/NanoBarrel.bundle`.
//
// ---------------------------------------------------------------------------
// THE ORDER BELOW IS LOAD-BEARING. tools/barrel_host_portability.sh (a
// registered ctest) and tools/soak_test.py run the DEV-BUILT bundle with no env
// override and simply inherit whatever the plugin resolves. If the installed
// app's record outranked the image-relative walk, a dev-tree test run would
// silently load a RELEASED app's effects and "pass" against the wrong code.
// So the record is last, below both the env vars and the walk. Pinned by
// tests/test_resource_root.cpp.
// ---------------------------------------------------------------------------

#pragma once

#include <fstream>
#include <string>
#include <vector>

#include "platform/paths.h"

namespace nano_paths {

/// Filename that marks a directory as a resource root.
inline constexpr const char* kResourceMarker = "nano-resources.json";

/// A root is only accepted if it actually carries the payload — a marker beside
/// an empty wasm/ is a half-finished build, not a usable root, and accepting it
/// would turn a clear "no such directory" into `ERROR: no WASM effects loaded`.
inline bool looksLikeResourceRoot(const std::string& dir) {
  if (dir.empty()) return false;
  return fileExists(joinPath(dir, kResourceMarker)) &&
         fileExists(joinPath(joinPath(dir, "wasm"), "core.wasm"));
}

/// Read `resourceRoot` out of the Electron app's install record. Hand-parsed:
/// this header is included by plugins that don't otherwise link nlohmann/json,
/// and the file has exactly one field we care about.
inline std::string installRecordRoot() {
  const std::string dir = supportDir();
  if (dir.empty()) return {};
  std::ifstream f(joinPath(dir, "electron_app.json"));
  if (!f.good()) return {};
  const std::string s((std::istreambuf_iterator<char>(f)),
                      std::istreambuf_iterator<char>());
  const std::string key = "\"resourceRoot\"";
  auto k = s.find(key);
  if (k == std::string::npos) return {};
  auto colon = s.find(':', k + key.size());
  if (colon == std::string::npos) return {};
  auto open = s.find('"', colon);
  if (open == std::string::npos) return {};
  std::string out;
  for (size_t i = open + 1; i < s.size(); ++i) {
    if (s[i] == '\\' && i + 1 < s.size()) { out += s[++i]; continue; }
    if (s[i] == '"') return out;
    out += s[i];
  }
  return {};
}

/**
 * Resolve the shared resource root. Empty if nothing usable was found — the
 * caller should log loudly, because every effect will be missing.
 *
 * `selfAddr` is the address of a function in the CALLER's image (see
 * paths.h::imagePathContaining); pass nullptr to skip the image-relative step.
 */
inline std::string resourceRoot(const void* selfAddr) {
  // 1. Explicit override. Tests, CI and tools use this; it beats everything.
  if (const char* e = getenv("NANO_RESOURCE_ROOT"); e && *e) {
    if (dirExists(e)) return std::string(e);
  }

  // 2. Back-compat: NANO_BARREL_WASM_DIR names the WASM DIR, so the root is its
  //    parent. Honoured even when the parent has no marker — several scripts
  //    point it straight at build/wasm and must keep working.
  if (const char* e = getenv("NANO_BARREL_WASM_DIR"); e && *e) {
    if (dirExists(e)) return parentDir(std::string(e));
  }

  // 3. Image-relative: walk up from whatever image we're loaded in, looking for
  //    a marked root at each ancestor and at `<ancestor>/build`. That second
  //    probe is what finds the dev tree — the plugin lives at
  //    <repo>/native/build/NanoBarrel.bundle/... while the root is <repo>/build.
  const std::string self = imagePathContaining(selfAddr);
  if (!self.empty()) {
    std::string dir = parentDir(self);
    for (int depth = 0; depth < 12 && !dir.empty(); ++depth) {
      if (looksLikeResourceRoot(dir)) return dir;
      const std::string build = joinPath(dir, "build");
      if (looksLikeResourceRoot(build)) return build;
      const std::string next = parentDir(dir);
      if (next == dir) break;
      dir = next;
    }
  }

  // 4. Legacy in-bundle payload, so a bundle deployed before this change keeps
  //    working. `.bundle/` (with the slash) matches the executable path only,
  //    never a stray directory component.
  if (!self.empty()) {
    const auto pos = self.find(".bundle/");
    if (pos != std::string::npos) {
      const std::string res = self.substr(0, pos + 8) + "Contents/Resources";
      if (fileExists(joinPath(joinPath(res, "wasm"), "core.wasm"))) return res;
    }
  }

  // 5. Last: wherever the installed Electron app says it put things. Only
  //    reachable when none of the above applied, i.e. the plugin was copied out
  //    of the app into a host's own plug-ins folder.
  const std::string rec = installRecordRoot();
  if (looksLikeResourceRoot(rec)) return rec;

  return {};
}

/// `<root>/wasm`, honouring NANO_BARREL_WASM_DIR verbatim when set (it names
/// the directory itself, not the root).
inline std::string wasmDir(const void* selfAddr) {
  if (const char* e = getenv("NANO_BARREL_WASM_DIR"); e && *e) return std::string(e);
  const std::string root = resourceRoot(selfAddr);
  return root.empty() ? std::string() : joinPath(root, "wasm");
}

/// `<root>/fonts/<name>`. Empty is survivable — the text service falls back to
/// system faces (see runtime/host_impls_font.mm) — but parity with the web
/// build is lost, so callers should log it.
inline std::string fontPath(const void* selfAddr, const char* name) {
  const std::string root = resourceRoot(selfAddr);
  return root.empty() ? std::string() : joinPath(joinPath(root, "fonts"), name);
}

}  // namespace nano_paths
