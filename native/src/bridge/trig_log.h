#pragma once
// trig_log.h — low-noise diagnostic log for the trigger-rail → clip-launch
// pipeline, written to ~/Library/Logs/NanoBarrel/trigger.log.
//
// Deliberately ALWAYS ON (no env gate — a GUI-hosted Resolume can't easily get
// one) but only called at low-frequency points: composition CHANGES (marker
// channel resolution) and actual trigger EVENTS / launches. So it stays quiet
// until something happens, and a repro just needs `tail -f` on the file.
// Temporary aid while validating against live Resolume; safe to gate/remove.

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace bridge {

inline std::mutex& trig_log_mu() { static std::mutex m; return m; }
inline FILE*& trig_log_file() { static FILE* f = nullptr; return f; }

inline void trig_log(const char* fmt, ...) {
  std::lock_guard<std::mutex> g(trig_log_mu());
  if (!trig_log_file()) {
    const char* home = getenv("HOME");
    if (!home) return;
    std::string dir = std::string(home) + "/Library/Logs/NanoBarrel";
    mkdir(dir.c_str(), 0755);
    const std::string path = dir + "/trigger.log";
    trig_log_file() = fopen(path.c_str(), "a");
    if (!trig_log_file()) return;
    fprintf(trig_log_file(), "# trigger.log opened pid=%d\n", (int)getpid());
  }
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  const double sec = (double)(ts.tv_sec % 100000) + ts.tv_nsec / 1e9;
  fprintf(trig_log_file(), "[%9.3f] ", sec);
  va_list ap;
  va_start(ap, fmt);
  vfprintf(trig_log_file(), fmt, ap);
  va_end(ap);
  fputc('\n', trig_log_file());
  fflush(trig_log_file());
}

}  // namespace bridge
