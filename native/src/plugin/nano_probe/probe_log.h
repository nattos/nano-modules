// probe_log.h — single-line logger for the NanoProbe FFGL plugin.
//
// One line per event, written to two places:
//   1. ~/Library/Logs/NanoProbe/run-<pid>-<unixms>.log  (durable, tail -f)
//   2. os_log subsystem com.nano.NanoProbe              (live in Console.app)
//
// Format: [t=<ms.fff>][frame=<N>][phase=<X.XX>] <event>: <details>
// `t` is monotonic from plugin construction; `frame` and `phase` are set
// by the plugin via probe_log_set_context() each ProcessOpenGL tick.

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

namespace nano_probe_log {

inline double now_ms_since_start(double start_ms = -1) {
  static mach_timebase_info_data_t tb = {0, 0};
  if (tb.denom == 0) mach_timebase_info(&tb);
  uint64_t t = mach_absolute_time();
  double ms = (double)t * tb.numer / tb.denom / 1e6;
  static double start = ms;
  if (start_ms >= 0) start = start_ms;
  return ms - start;
}

struct Context {
  int frame = 0;
  float phase = 0.0f;
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
  static os_log_t l = os_log_create("com.nano.NanoProbe", "probe");
  return l;
}

inline void ensure_open() {
  if (file()) return;
  const char* home = getenv("HOME");
  if (!home) return;
  std::string dir = std::string(home) + "/Library/Logs/NanoProbe";
  mkdir(dir.c_str(), 0755);  // ignore EEXIST
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  uint64_t unixms = (uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
  char buf[1024];
  snprintf(buf, sizeof(buf), "%s/run-%d-%llu.log",
           dir.c_str(), (int)getpid(), (unsigned long long)unixms);
  file() = fopen(buf, "a");
  if (file()) {
    fprintf(file(), "# NanoProbe log opened pid=%d unixms=%llu path=%s\n",
            (int)getpid(), (unsigned long long)unixms, buf);
    fflush(file());
    // Seed t=0 marker.
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
           "[t=%9.3f][frame=%5d][phase=%4.2f] %s: %s",
           now_ms_since_start(), ctx().frame, ctx().phase, event, details);
  if (file()) {
    fprintf(file(), "%s\n", line);
    fflush(file());
  }
  os_log(oslog(), "%{public}s", line);
}

// Shorten long text values for log readability — show first N chars and
// total length so we can still verify byte-identical round-trip.
inline std::string redact(const char* s, size_t n_chars = 80) {
  if (!s) return std::string("<null>");
  size_t len = strlen(s);
  std::string head(s, std::min(len, n_chars));
  // Escape control chars to a single line.
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

}  // namespace nano_probe_log

#define PROBE_LOG(event, fmt, ...) \
  ::nano_probe_log::log_line((event), (fmt), ##__VA_ARGS__)

#define PROBE_CTX_FRAME(n) (::nano_probe_log::ctx().frame = (n))
#define PROBE_CTX_PHASE(p) (::nano_probe_log::ctx().phase = (p))
