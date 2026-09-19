// diag_log.cpp — the log, and the two path helpers every probe needs.

#include "diag.h"

#include <windows.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <vector>

namespace diag {
namespace {

FILE* g_file = nullptr;
std::mutex g_mu;

void emit(const char* s, size_t n) {
  std::lock_guard<std::mutex> lk(g_mu);
  fwrite(s, 1, n, stdout);
  fflush(stdout);
  if (g_file) {
    fwrite(s, 1, n, g_file);
    fflush(g_file);   // the interesting runs are the ones that die
  }
}

void vemit(const char* fmt, va_list ap) {
  char buf[4096];
  va_list ap2;
  va_copy(ap2, ap);
  const int n = vsnprintf(buf, sizeof(buf), fmt, ap);
  if (n < 0) { va_end(ap2); return; }
  if ((size_t)n < sizeof(buf)) {
    emit(buf, (size_t)n);
  } else {
    std::vector<char> big((size_t)n + 1);
    vsnprintf(big.data(), big.size(), fmt, ap2);
    emit(big.data(), (size_t)n);
  }
  va_end(ap2);
}

}  // namespace

bool openLog(const std::string& path) {
  if (path.empty()) return true;
  g_file = fopen(path.c_str(), "wb");
  return g_file != nullptr;
}

void closeLog() {
  std::lock_guard<std::mutex> lk(g_mu);
  if (g_file) { fclose(g_file); g_file = nullptr; }
}

void logf(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vemit(fmt, ap);
  va_end(ap);
}

void logRaw(const char* data, size_t len) { emit(data, len); }

void section(const char* title) {
  logf("\n=== %s ", title);
  const int pad = 70 - (int)strlen(title);
  for (int i = 0; i < pad; ++i) logf("=");
  logf("\n");
}

void check(bool ok, const char* name, const char* fmt, ...) {
  logf("  [%s] %-34s ", ok ? "ok  " : "FAIL", name);
  va_list ap;
  va_start(ap, fmt);
  vemit(fmt, ap);
  va_end(ap);
  logf("\n");
}

void fact(const char* key, const char* fmt, ...) {
  logf("##FACT %s = ", key);
  va_list ap;
  va_start(ap, fmt);
  vemit(fmt, ap);
  va_end(ap);
  logf("\n");
}

std::string exeDir() {
  char buf[MAX_PATH * 2] = {0};
  const DWORD n = GetModuleFileNameA(nullptr, buf, sizeof(buf));
  if (n == 0) return std::string(".");
  std::string s(buf, n);
  const size_t slash = s.find_last_of("\\/");
  return slash == std::string::npos ? std::string(".") : s.substr(0, slash);
}

std::string besideExe(const char* name) {
  return exeDir() + "\\" + name;
}

bool fileExists(const std::string& path) {
  const DWORD a = GetFileAttributesA(path.c_str());
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

}  // namespace diag
