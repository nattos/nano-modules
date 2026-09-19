// nano_diag.cpp — one .exe you can hand to someone with a Windows machine.
//
// It runs everything we cannot run ourselves and writes a single log file to
// upload. The whole point is that the person running it does not have to know
// anything: double-click, wait, send back the .log.
//
// Structure: the driver runs each check as a CHILD PROCESS -- its own probes
// by re-executing itself with --probe, and the Catch2 suites that shipped
// beside it as they are. A child means a crash costs one FAIL line instead of
// the rest of the run, which matters because the headline check here is
// interop_texture_d3d11.cpp executing for the first time anywhere.
//
//   nano_diag.exe                 run everything, write nano-diag-<stamp>.log
//   nano_diag.exe --probe interop run one check in-process (what the driver does)
//   nano_diag.exe --list          what there is to run
//
// See README.md for how to build and package it.

#include <windows.h>

#include "diag.h"
#include "diag_build.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

namespace diag {

const Probe kProbes[] = {
    {"system",    "machine, folder contents, resource root", probeSystem,      60},
    {"adapters",  "DXGI adapters and the D3D11 device",      probeAdapters,    60},
    {"compiler",  "d3dcompiler_47.dll",                      probeCompiler,    60},
    {"gl",        "OpenGL context and WGL extensions",       probeGL,          60},
    {"interop",   "GL <-> D3D11 texture share",              probeInterop,    120},
    {"barrel",    "a rendered frame, GL in and GL out",      probeBarrelFrame,240},
    {"ffgl",      "NanoBarrel.dll through plugMain",         probeFfglHost,   240},
};
const int kProbeCount = (int)(sizeof(kProbes) / sizeof(kProbes[0]));

}  // namespace diag

namespace {

using namespace diag;

// Catch2 suites in cheapest-signal-first order, matching how the Windows port
// was triaged: if the texture-format gate is red nothing downstream means
// anything. Anything found beside the exe that is not named here still runs,
// after these.
const char* kSuiteOrder[] = {
    "test_texture_copy_format",  "test_gpu_conformance",
    "test_barrel_render",        "test_barrel_isolation",
    "test_sketch_output_format", "test_effect_render",
    "test_comp_render",          "test_executor_wasm",
    "test_plane_shear",          "test_tri_shear",
    "test_recompose",            "test_envelope_warp",
    "test_effect_driver",        "test_sdf_field",
    "test_spectral_curve",       "test_text_fonts",
    "test_text_precise",         "test_exec_order",
    "test_wasm_bundles",         "test_dxv_source",
};

struct Outcome {
  std::string name;
  std::string status;   // PASS / FAIL / TIMEOUT / CRASH
  double seconds = 0;
  std::string note;
};

std::vector<Outcome> g_outcomes;
std::vector<std::string> g_facts;

// --- child processes -------------------------------------------------------

const char* exceptionName(DWORD code) {
  switch (code) {
    case 0xC0000005: return "ACCESS_VIOLATION";
    case 0xC000001D: return "ILLEGAL_INSTRUCTION";
    case 0xC0000094: return "INTEGER_DIVIDE_BY_ZERO";
    case 0xC0000096: return "PRIVILEGED_INSTRUCTION";
    case 0xC00000FD: return "STACK_OVERFLOW";
    case 0xC0000409: return "STACK_BUFFER_OVERRUN";
    case 0xC0000374: return "HEAP_CORRUPTION";
    case 0xC000013A: return "CTRL_C_EXIT";
    default: return nullptr;
  }
}

struct RunResult {
  DWORD exitCode = 0;
  bool timedOut = false;
  bool started = false;
  double seconds = 0;
};

// Run `cmdline`, tee its output into the log as it arrives, kill it after
// `timeout_s`. Facts the child emits are collected for the summary.
RunResult runChild(const std::string& cmdline, unsigned timeout_s) {
  RunResult r;

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;

  HANDLE rd = nullptr, wr = nullptr;
  if (!CreatePipe(&rd, &wr, &sa, 1 << 16)) return r;
  SetHandleInformation(rd, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOA si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = wr;
  si.hStdError = wr;
  si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);

  PROCESS_INFORMATION pi{};
  std::vector<char> mutableCmd(cmdline.begin(), cmdline.end());
  mutableCmd.push_back('\0');

  const BOOL launched = CreateProcessA(nullptr, mutableCmd.data(), nullptr,
                                       nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                                       nullptr, &si, &pi);
  CloseHandle(wr);   // our copy; the child holds the only writer now
  if (!launched) {
    CloseHandle(rd);
    return r;
  }
  r.started = true;

  const ULONGLONG t0 = GetTickCount64();

  // Drain on a thread so a chatty child can never fill the pipe and deadlock
  // against our wait.
  std::string tail;
  std::thread drain([&] {
    char buf[4096];
    DWORD n = 0;
    while (ReadFile(rd, buf, sizeof(buf), &n, nullptr) && n > 0) {
      logRaw(buf, n);
      tail.append(buf, n);
      // Keep only enough to find whole ##FACT lines in.
      if (tail.size() > (1u << 20)) tail.erase(0, tail.size() - (1u << 18));
    }
  });

  if (WaitForSingleObject(pi.hProcess, timeout_s * 1000) == WAIT_TIMEOUT) {
    r.timedOut = true;
    TerminateProcess(pi.hProcess, 1);
    WaitForSingleObject(pi.hProcess, 5000);
  }
  CloseHandle(rd);   // unblocks the drain if the child left a handle behind
  drain.join();

  GetExitCodeProcess(pi.hProcess, &r.exitCode);
  r.seconds = (double)(GetTickCount64() - t0) / 1000.0;
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);

  // Scrape the headline facts back out of what the child printed.
  size_t pos = 0;
  while ((pos = tail.find("##FACT ", pos)) != std::string::npos) {
    const size_t end = tail.find('\n', pos);
    if (end == std::string::npos) break;
    std::string line = tail.substr(pos + 7, end - pos - 7);
    while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
    if (!line.empty()) g_facts.push_back(line);
    pos = end + 1;
  }
  return r;
}

void record(const std::string& name, const RunResult& r) {
  Outcome o;
  o.name = name;
  o.seconds = r.seconds;
  if (!r.started) {
    o.status = "NORUN";
    o.note = "could not be launched";
  } else if (r.timedOut) {
    o.status = "TIMEOUT";
  } else if (r.exitCode == 0) {
    o.status = "PASS";
  } else if (const char* e = exceptionName(r.exitCode)) {
    o.status = "CRASH";
    o.note = e;
  } else if (r.exitCode >= 0xC0000000) {
    o.status = "CRASH";
    char b[32];
    snprintf(b, sizeof(b), "0x%08lX", (unsigned long)r.exitCode);
    o.note = b;
  } else {
    o.status = "FAIL";
    char b[48];
    snprintf(b, sizeof(b), "exit %lu", (unsigned long)r.exitCode);
    o.note = b;
  }
  g_outcomes.push_back(o);
}

// --- driver ----------------------------------------------------------------

std::string quoted(const std::string& s) { return "\"" + s + "\""; }

std::string selfPath() {
  char buf[MAX_PATH * 2] = {0};
  GetModuleFileNameA(nullptr, buf, sizeof(buf));
  return buf;
}

std::string timestamp() {
  SYSTEMTIME t{};
  GetLocalTime(&t);
  char b[32];
  snprintf(b, sizeof(b), "%04u%02u%02u-%02u%02u%02u", t.wYear, t.wMonth, t.wDay,
           t.wHour, t.wMinute, t.wSecond);
  return b;
}

// Every suite beside us, in the order above, then anything unlisted.
std::vector<std::string> findSuites() {
  std::vector<std::string> found;
  WIN32_FIND_DATAA fd{};
  HANDLE h = FindFirstFileA((exeDir() + "\\test_*.exe").c_str(), &fd);
  if (h != INVALID_HANDLE_VALUE) {
    do {
      if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) {
        std::string n = fd.cFileName;
        n.resize(n.size() - 4);   // drop .exe
        found.push_back(n);
      }
    } while (FindNextFileA(h, &fd));
    FindClose(h);
  }
  std::vector<std::string> ordered;
  for (const char* want : kSuiteOrder) {
    auto it = std::find(found.begin(), found.end(), want);
    if (it != found.end()) { ordered.push_back(*it); found.erase(it); }
  }
  std::sort(found.begin(), found.end());
  ordered.insert(ordered.end(), found.begin(), found.end());
  return ordered;
}

bool ownsConsole() {
  DWORD pids[4];
  return GetConsoleProcessList(pids, 4) <= 1;
}

int usage() {
  printf(
      "nano_diag -- Windows diagnostics for the nano barrel.\n\n"
      "  nano_diag.exe                 run everything, write a log beside the exe\n"
      "  nano_diag.exe --probe <name>  run one check in this process\n"
      "  nano_diag.exe --only <text>   only checks whose name contains <text>\n"
      "  nano_diag.exe --probes-only   skip the Catch2 suites\n"
      "  nano_diag.exe --timeout <s>   per-suite limit (default 900)\n"
      "  nano_diag.exe --strict        NANO_D3D_STRICT=1 (abort on a bad HRESULT)\n"
      "  nano_diag.exe --no-pause      do not wait for a keypress at the end\n"
      "  nano_diag.exe --list          list the checks\n");
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  // No "program has stopped working" box: a crash has to stay a line in the
  // log, not a modal dialog on an unattended machine.
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);

  std::string probe, only;
  bool pause = true, probesOnly = false, strict = false;
  unsigned timeout = 900;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--probe" && i + 1 < argc) probe = argv[++i];
    else if (a == "--only" && i + 1 < argc) only = argv[++i];
    else if (a == "--timeout" && i + 1 < argc) timeout = (unsigned)atoi(argv[++i]);
    else if (a == "--probes-only") probesOnly = true;
    else if (a == "--strict") strict = true;
    else if (a == "--no-pause") pause = false;
    else if (a == "--list") {
      for (int p = 0; p < kProbeCount; ++p)
        printf("  %-10s %s\n", kProbes[p].name, kProbes[p].title);
      return 0;
    } else if (a == "-h" || a == "--help") return usage();
    else { printf("unknown argument: %s\n\n", a.c_str()); return usage(); }
  }

  // --- child mode ---------------------------------------------------------
  if (!probe.empty()) {
    openLog("");   // stdout only; the parent is tee-ing it
    for (int p = 0; p < kProbeCount; ++p) {
      if (probe == kProbes[p].name) {
        const bool ok = kProbes[p].fn();
        fflush(stdout);
        return ok ? 0 : 1;
      }
    }
    printf("no such probe: %s\n", probe.c_str());
    return 2;
  }

  // --- driver mode --------------------------------------------------------
  const std::string self = selfPath();
  const std::string stamp = timestamp();
  std::string logPath = exeDir() + "\\nano-diag-" + stamp + ".log";
  if (!openLog(logPath)) {
    // Program Files, a read-only share, a zip opened in place -- fall back
    // rather than lose the whole run.
    char tmp[MAX_PATH] = {0};
    GetTempPathA(sizeof(tmp), tmp);
    logPath = std::string(tmp) + "nano-diag-" + stamp + ".log";
    if (!openLog(logPath)) {
      printf("cannot write a log file anywhere. Giving up.\n");
      return 2;
    }
  }

  logf("nano_diag -- nano barrel diagnostics for Windows\n");
#ifdef NANO_DIAG_BUILD
  // Baked by CMake rather than __DATE__/__TIME__, which the build forbids for
  // reproducibility. Knowing WHICH build produced a log is the whole point.
  logf("build %s\n", NANO_DIAG_BUILD);
#endif
  logf("started %s\n", stamp.c_str());
  logf("log file: %s\n", logPath.c_str());
  logf("\nThis runs unattended and takes a few minutes. Windows may ask whether\n"
       "to allow network access -- the engine opens a local port for the editor.\n"
       "Either answer is fine; nothing here needs the network.\n");

  // The children inherit all of this. It is what makes the zip work without
  // anybody configuring anything.
  const std::string dir = exeDir();
  SetEnvironmentVariableA("NANO_RESOURCE_ROOT", dir.c_str());
  SetEnvironmentVariableA("NANO_WASM_DIR", (dir + "\\wasm").c_str());
  SetEnvironmentVariableA("NANO_LIB_DIR", dir.c_str());
  // The Metal backend returns from a submit as soon as the frame is SCHEDULED,
  // leaving cross-API ordering to the host; a CPU pixel consumer has to ask for
  // the blocking flush instead. D3D11's Map(READ) is already ordered, so this
  // is belt and braces -- and it is free.
  SetEnvironmentVariableA("NANO_WAIT_COMPLETED", "1");
  // Off the default port, so a diagnostic run next to a live Resolume with a
  // barrel loaded does not fight it for :8081.
  SetEnvironmentVariableA("NANO_BRIDGE_PORT", "18081");
  if (strict) SetEnvironmentVariableA("NANO_D3D_STRICT", "1");

  const ULONGLONG t0 = GetTickCount64();

  for (int p = 0; p < kProbeCount; ++p) {
    const Probe& pr = kProbes[p];
    if (!only.empty() && std::string(pr.name).find(only) == std::string::npos) continue;
    printf("\n>>> %s (%s)\n", pr.name, pr.title);
    const RunResult r = runChild(
        quoted(self) + " --probe " + pr.name + " --no-pause", pr.timeout_s);
    record(pr.name, r);
    logf("  --> %s in %.1fs\n", g_outcomes.back().status.c_str(), r.seconds);
  }

  if (!probesOnly) {
    const std::vector<std::string> suites = findSuites();
    section("Test suites");
    logf("  %d suite%s beside the exe\n", (int)suites.size(),
         suites.size() == 1 ? "" : "s");
    for (const std::string& s : suites) {
      if (!only.empty() && s.find(only) == std::string::npos) continue;
      logf("\n--- %s ---------------------------------------------------\n",
           s.c_str());
      const RunResult r = runChild(
          quoted(dir + "\\" + s + ".exe") + " -r compact -d yes", timeout);
      record(s, r);
      logf("  --> %s in %.1fs\n", g_outcomes.back().status.c_str(), r.seconds);
    }
  }

  // --- summary ------------------------------------------------------------
  section("SUMMARY");
  for (const std::string& f : g_facts) logf("  %s\n", f.c_str());

  logf("\n");
  int pass = 0, bad = 0;
  for (const Outcome& o : g_outcomes) {
    logf("  %-8s %-30s %6.1fs  %s\n", o.status.c_str(), o.name.c_str(),
         o.seconds, o.note.c_str());
    if (o.status == "PASS") ++pass; else ++bad;
  }
  logf("\n  %d of %d checks passed, in %.0f seconds total.\n", pass,
       (int)g_outcomes.size(),
       (double)(GetTickCount64() - t0) / 1000.0);
  if (bad) {
    logf("\n  %d did not pass. That is what the log is for -- send the whole\n"
         "  file; a failure here is information, not a mistake by whoever ran it.\n",
         bad);
  }
  logf("\n  SEND THIS FILE: %s\n", logPath.c_str());
  closeLog();

  printf("\nDone. Send this file:\n  %s\n", logPath.c_str());
  if (pause && ownsConsole()) {
    printf("\nPress Enter to close.\n");
    (void)getchar();
  }
  return bad ? 1 : 0;
}
