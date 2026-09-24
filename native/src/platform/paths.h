// paths.h — the handful of filesystem questions that have a different answer on
// every OS: where am I loaded from, and where may I write.
//
// This exists because the same three lines of `dladdr` + string surgery were
// copy-pasted into five plugins, and `getenv("HOME")` + "/Library/..." into
// four more. Both are the *only* macOS-isms in otherwise portable code, so they
// are worth having in one place even before a Windows host exists — see
// WINDOWS.md for what a native port still needs beyond this.
//
// Header-only on purpose, like bridge/library_paths.h: every FFGL plugin links
// its own copy and there is no shared static library below them. Nothing here
// may be pulled into executor.wasm (no filesystem there).

#pragma once

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <iterator>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <direct.h>
// This header needs MultiByteToWideChar/WideCharToMultiByte and CP_UTF8, all
// of which <winnls.h> puts behind NONLS. A TU that reached windows.h FIRST with
// NONLS set -- which the FFGL SDK's headers do, and the barrel is how this was
// found -- ran winnls.h with its whole body skipped and its include guard left
// closed, so including it again normally is a no-op and the names never appear.
//
// CP_UTF8's absence is the reliable signal that this happened, and since
// nothing was declared on that pass, reopening the header now cannot duplicate
// anything. In the ordinary case the body was emitted, CP_UTF8 exists, and none
// of this runs.
#ifndef CP_UTF8
#undef NONLS
#undef _WINNLS_
#include <winnls.h>
#endif
#else
#include <dirent.h>
#include <sys/stat.h>
#ifndef __wasi__
#include <dlfcn.h>
#endif
#endif

namespace nano_paths {

/// Path separator this platform's APIs hand back. We WRITE '/' everywhere
/// (Win32 accepts it) but must READ both, because GetModuleFileNameW does not.
inline bool isSep(char c) {
#ifdef _WIN32
  return c == '/' || c == '\\';
#else
  return c == '/';
#endif
}

/// Everything before the last separator, with the separator dropped. Empty if
/// there isn't one.
inline std::string parentDir(const std::string& p) {
  for (size_t i = p.size(); i-- > 0;)
    if (isSep(p[i])) return p.substr(0, i);
  return {};
}

/// Join with a single '/'. Tolerates a trailing separator on `a` and a leading
/// one on `b`; an empty `a` yields `b` unchanged (so it composes with the
/// "empty means couldn't resolve" convention used throughout).
inline std::string joinPath(const std::string& a, const std::string& b) {
  if (a.empty()) return b;
  if (b.empty()) return a;
  std::string out = a;
  if (isSep(out.back())) out.pop_back();
  return out + '/' + (isSep(b.front()) ? b.substr(1) : b);
}

#ifdef _WIN32
/// UTF-8 → the wide string the W APIs take. Our paths are UTF-8 everywhere;
/// the A APIs would read them in the ANSI code page and miss any non-ASCII
/// name (a user's footage folder is exactly where those turn up).
inline std::wstring widen(const std::string& s) {
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (n <= 0) return std::wstring();
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  w.resize(static_cast<size_t>(n - 1));
  return w;
}
#endif

inline bool fileExists(const std::string& p) {
  if (p.empty()) return false;
#ifdef _WIN32
  const DWORD a = GetFileAttributesW(widen(p).c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
#else
  struct stat st;
  return ::stat(p.c_str(), &st) == 0 && S_ISREG(st.st_mode);
#endif
}

inline bool dirExists(const std::string& p) {
  if (p.empty()) return false;
#ifdef _WIN32
  const DWORD a = GetFileAttributesW(widen(p).c_str());
  return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
#else
  struct stat st;
  return ::stat(p.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
#endif
}

/**
 * The names (not paths) of the regular files directly inside `dir`, sorted, so
 * a caller that picks among them is deterministic across filesystems. Empty
 * when the directory is missing or unreadable. UTF-8 in and out on every
 * platform -- a user's module directory is exactly the kind of path that has a
 * non-ASCII name in it.
 */
inline std::vector<std::string> listFiles(const std::string& dir) {
  std::vector<std::string> out;
  if (dir.empty()) return out;
#ifdef _WIN32
  const std::string pattern = joinPath(dir, "*");
  const int wlen = MultiByteToWideChar(CP_UTF8, 0, pattern.c_str(), -1, nullptr, 0);
  if (wlen <= 0) return out;
  std::wstring wpattern(static_cast<size_t>(wlen), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, pattern.c_str(), -1, wpattern.data(), wlen);
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(wpattern.c_str(), &fd);
  if (h == INVALID_HANDLE_VALUE) return out;
  do {
    if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
    const int need = WideCharToMultiByte(CP_UTF8, 0, fd.cFileName, -1, nullptr, 0,
                                         nullptr, nullptr);
    if (need <= 1) continue;
    std::string name(static_cast<size_t>(need - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, fd.cFileName, -1, name.data(), need, nullptr,
                        nullptr);
    out.push_back(std::move(name));
  } while (FindNextFileW(h, &fd));
  FindClose(h);
#else
  DIR* d = ::opendir(dir.c_str());
  if (!d) return out;
  while (dirent* e = ::readdir(d)) {
    const std::string name = e->d_name;
    if (name == "." || name == "..") continue;
    if (fileExists(joinPath(dir, name))) out.push_back(name);
  }
  ::closedir(d);
#endif
  std::sort(out.begin(), out.end());
  return out;
}

/**
 * Absolute path of the loaded image (bundle executable / dylib / DLL) that
 * CONTAINS `addr`. Empty if it can't be determined.
 *
 * Pass the address of a function defined in the calling translation unit — the
 * point is to locate the caller's own image, and a function defined in THIS
 * header would resolve to whichever image the linker happened to keep. Every
 * caller already did exactly this with `dladdr`; the argument keeps that
 * semantics explicit rather than accidental.
 */
inline std::string imagePathContaining(const void* addr) {
  if (!addr) return {};
#ifdef _WIN32
  HMODULE mod = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                              GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCWSTR>(addr), &mod) ||
      !mod)
    return {};
  wchar_t wide[MAX_PATH * 4];
  const DWORD n = GetModuleFileNameW(mod, wide, static_cast<DWORD>(std::size(wide)));
  if (n == 0 || n >= std::size(wide)) return {};
  const int need = WideCharToMultiByte(CP_UTF8, 0, wide, static_cast<int>(n),
                                       nullptr, 0, nullptr, nullptr);
  if (need <= 0) return {};
  std::string out(static_cast<size_t>(need), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide, static_cast<int>(n), out.data(), need,
                      nullptr, nullptr);
  return out;
#elif defined(__wasi__)
  // bridge_core.wasm reaches this header through trig_log.h. A wasm module is
  // not a loaded image with a path; "can't be determined" is the answer.
  return {};
#else
  Dl_info info;
  if (!dladdr(addr, &info) || !info.dli_fname) return {};
  return std::string(info.dli_fname);
#endif
}

/// Create a directory, ignoring "already exists". False only on real failure.
inline bool ensureDir(const std::string& p) {
  if (p.empty()) return false;
#ifdef _WIN32
  return _wmkdir(widen(p).c_str()) == 0 || dirExists(p);
#else
  return ::mkdir(p.c_str(), 0755) == 0 || dirExists(p);
#endif
}

/// The platform's per-user app-data directory -- what Electron calls
/// `app.getPath('appData')`. Empty when the environment doesn't say.
inline std::string appDataDirPath() {
#ifdef _WIN32
  const char* base = getenv("APPDATA");
  return base && *base ? std::string(base) : std::string();
#else
  const char* home = getenv("HOME");
  if (!home || !*home) return {};
#ifdef __APPLE__
  return joinPath(home, "Library/Application Support");
#else
  const char* xdg = getenv("XDG_CONFIG_HOME");
  return xdg && *xdg ? std::string(xdg) : joinPath(home, ".config");
#endif
#endif
}

/**
 * The per-user DATA ROOT shared by the desktop apps and every plugin:
 *   macOS   ~/Library/Application Support/Nano Modules
 *   Windows %APPDATA%\Nano Modules
 * `NANO_DATA_DIR` overrides it (every test sets it). Empty when the
 * environment doesn't say where home is.
 *
 *   Modules/    effect bundles (bridge/module_dirs.h)
 *   Settings/   one JSON file per surface plus the shared ones -- the MIDI
 *               device library, library paths, mapped module directories,
 *               plugin.json (bridge/settings_file.h)
 *   install.json where the packaged app lives (platform/resource_root.h)
 *
 * The JS half is web/electron/data-root.cjs -- KEEP THE TWO IN STEP. Read-only
 * resources are elsewhere: platform/resource_root.h.
 */
inline std::string dataRootPath() {
  if (const char* e = getenv("NANO_DATA_DIR"); e && *e) return e;
  const std::string base = appDataDirPath();
  return base.empty() ? std::string() : joinPath(base, "Nano Modules");
}

/// `<dataRoot>/Settings`, not created. Readers should use this -- merely
/// loading the plugin must not leave directories behind in every host's home.
inline std::string settingsDirPath() {
  const std::string root = dataRootPath();
  return root.empty() ? std::string() : joinPath(root, "Settings");
}

/// As above, created on demand (for writers).
inline std::string settingsDir() {
  const std::string dir = settingsDirPath();
  if (!dir.empty()) {
    ensureDir(dataRootPath());
    ensureDir(dir);
  }
  return dir;
}

/// A whole file as bytes; false when it can't be opened. UTF-8 path.
inline bool readFileBytes(const std::string& p, std::string& out) {
  if (p.empty()) return false;
#ifdef _WIN32
  FILE* f = _wfopen(widen(p).c_str(), L"rb");
#else
  FILE* f = fopen(p.c_str(), "rb");
#endif
  if (!f) return false;
  out.clear();
  char buf[16384];
  size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  const bool ok = !ferror(f);
  fclose(f);
  return ok;
}

/// Replace `p` with `bytes` ATOMICALLY: write `<p>.tmp`, then rename over.
/// A reader (the other app, an agent's editor) never sees half a file.
inline bool writeFileAtomic(const std::string& p, const std::string& bytes) {
  if (p.empty()) return false;
  const std::string tmp = p + ".tmp";
#ifdef _WIN32
  FILE* f = _wfopen(widen(tmp).c_str(), L"wb");
#else
  FILE* f = fopen(tmp.c_str(), "wb");
#endif
  if (!f) return false;
  const bool wrote = fwrite(bytes.data(), 1, bytes.size(), f) == bytes.size();
  const bool closed = fclose(f) == 0;
  if (!wrote || !closed) return false;
#ifdef _WIN32
  return MoveFileExW(widen(tmp).c_str(), widen(p).c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
  return ::rename(tmp.c_str(), p.c_str()) == 0;
#endif
}

/// Cheap change detection: modification time + size. `exists` false when the
/// file is missing. Two stamps compare equal iff nothing observable changed
/// (a same-size rewrite within the clock's resolution is caught by the byte
/// compare the callers do after).
struct FileStamp {
  bool exists = false;
  long long mtimeNs = 0;
  long long size = 0;
  bool operator==(const FileStamp& o) const {
    return exists == o.exists && mtimeNs == o.mtimeNs && size == o.size;
  }
  bool operator!=(const FileStamp& o) const { return !(*this == o); }
};

inline FileStamp statFile(const std::string& p) {
  FileStamp s;
  if (p.empty()) return s;
#ifdef _WIN32
  WIN32_FILE_ATTRIBUTE_DATA d;
  if (!GetFileAttributesExW(widen(p).c_str(), GetFileExInfoStandard, &d)) return s;
  if (d.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) return s;
  s.exists = true;
  s.mtimeNs = static_cast<long long>(((unsigned long long)d.ftLastWriteTime.dwHighDateTime << 32) |
                                     d.ftLastWriteTime.dwLowDateTime) * 100;
  s.size = static_cast<long long>(((unsigned long long)d.nFileSizeHigh << 32) | d.nFileSizeLow);
#else
  struct stat st;
  if (::stat(p.c_str(), &st) != 0 || !S_ISREG(st.st_mode)) return s;
  s.exists = true;
#ifdef __APPLE__
  s.mtimeNs = (long long)st.st_mtimespec.tv_sec * 1000000000LL + st.st_mtimespec.tv_nsec;
#else
  s.mtimeNs = (long long)st.st_mtim.tv_sec * 1000000000LL + st.st_mtim.tv_nsec;
#endif
  s.size = (long long)st.st_size;
#endif
  return s;
}

/**
 * Our per-user LOG directory for `name`, created on demand:
 *   macOS   ~/Library/Logs/<name>
 *   Windows %LOCALAPPDATA%\<name>\Logs
 * Empty when the environment doesn't say where home is. Log writers treat an
 * empty result as "logging off" rather than an error — a missing log must never
 * take the render path down with it.
 */
inline std::string logDir(const char* name) {
#ifdef _WIN32
  const char* base = getenv("LOCALAPPDATA");
  if (!base || !*base) return {};
  const std::string parent = joinPath(base, name);
  ensureDir(parent);
  const std::string dir = joinPath(parent, "Logs");
#else
  const char* home = getenv("HOME");
  if (!home || !*home) return {};
  const std::string dir = joinPath(joinPath(home, "Library/Logs"), name);
#endif
  ensureDir(dir);
  return dir;
}

}  // namespace nano_paths
