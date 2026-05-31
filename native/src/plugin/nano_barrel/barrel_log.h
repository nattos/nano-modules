// barrel_log.h — sibling of the probe_log headers, for NanoBarrel.
//
// One line per event to ~/Library/Logs/NanoBarrel/run-<pid>-<unixms>.log
// AND os_log subsystem com.nano.NanoBarrel. Monotonic timestamp from
// plugin construction; per-instance frame counter set in ProcessOpenGL.

#pragma once

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include <mach/mach_time.h>
#include <os/log.h>

namespace nano_barrel_log {

inline double now_ms_since_start(double start_ms = -1) {
  static mach_timebase_info_data_t tb = {0, 0};
  if (tb.denom == 0) mach_timebase_info(&tb);
  uint64_t t = mach_absolute_time();
  double ms = (double)t * tb.numer / tb.denom / 1e6;
  static double start = ms;
  if (start_ms >= 0) start = start_ms;
  return ms - start;
}

inline double now_ms() {
  static mach_timebase_info_data_t tb = {0, 0};
  if (tb.denom == 0) mach_timebase_info(&tb);
  uint64_t t = mach_absolute_time();
  return (double)t * tb.numer / tb.denom / 1e6;
}

struct Context {
  int frame = 0;
};

inline Context& ctx() {
  static Context c;
  return c;
}

inline std::mutex& mu() {
  static std::mutex m;
  return m;
}

inline FILE*& file() {
  static FILE* f = nullptr;
  return f;
}

inline os_log_t& oslog() {
  static os_log_t l = os_log_create("com.nano.NanoBarrel", "barrel");
  return l;
}

inline void ensure_open() {
  if (file()) return;
  const char* home = getenv("HOME");
  if (!home) return;
  std::string dir = std::string(home) + "/Library/Logs/NanoBarrel";
  mkdir(dir.c_str(), 0755);
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  uint64_t unixms = (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
  char buf[1024];
  snprintf(buf, sizeof(buf), "%s/run-%d-%llu.log",
           dir.c_str(), (int)getpid(), (unsigned long long)unixms);
  file() = fopen(buf, "a");
  if (file()) {
    fprintf(file(), "# NanoBarrel log opened pid=%d unixms=%llu path=%s\n",
            (int)getpid(), (unsigned long long)unixms, buf);
    fflush(file());
    now_ms_since_start(0);
  }
}

inline void log_line(const char* event, const char* fmt, ...) {
  std::lock_guard<std::mutex> g(mu());
  ensure_open();
  char details[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(details, sizeof(details), fmt, ap);
  va_end(ap);
  char line[3072];
  snprintf(line, sizeof(line),
           "[t=%9.3f][frame=%5d] %s: %s",
           now_ms_since_start(), ctx().frame, event, details);
  if (file()) {
    fprintf(file(), "%s\n", line);
    fflush(file());
  }
  os_log(oslog(), "%{public}s", line);
}

inline std::string redact(const char* s, size_t n_chars = 80) {
  if (!s) return std::string("<null>");
  size_t len = strlen(s);
  std::string head(s, std::min(len, n_chars));
  std::string out;
  out.reserve(head.size() + 16);
  for (char c : head) {
    if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if ((unsigned char)c < 0x20) {
      char b[8]; snprintf(b, sizeof(b), "\\x%02x", (unsigned char)c);
      out += b;
    } else out += c;
  }
  char tail[64];
  snprintf(tail, sizeof(tail), "  (len=%zu)", len);
  if (len > n_chars) out += "...";
  out += tail;
  return out;
}

}  // namespace nano_barrel_log

#define BARREL_LOG(event, fmt, ...) \
  ::nano_barrel_log::log_line((event), (fmt), ##__VA_ARGS__)

#define BARREL_REDACT(...) ::nano_barrel_log::redact(__VA_ARGS__)

#define BARREL_CTX_FRAME(n) (::nano_barrel_log::ctx().frame = (n))
