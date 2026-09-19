// diag.h — the shared spine of nano_diag: logging, facts, and the probe table.
//
// nano_diag is two programs in one binary. Run with no arguments it is the
// DRIVER: it writes a log, runs every check as a CHILD PROCESS and summarises
// what happened. Run as `nano_diag --probe <name>` it is that one check,
// in-process, writing to stdout and exiting 0 or 1.
//
// The split is not ceremony. Half of what we want to learn on real Windows
// hardware is what happens when the GL<->D3D share is touched for the first
// time, and "it crashed" is a perfectly good answer that must not take the
// rest of the run with it. A child process turns an access violation into one
// FAIL line.

#pragma once

#include <string>

namespace diag {

// --- Log ------------------------------------------------------------------
// Everything goes to stdout; the driver additionally tees to a file. Every
// write is flushed, because the interesting runs are the ones that die.

/// Open the log file. Empty path = console only (the probe child's mode).
bool openLog(const std::string& path);
void closeLog();

void logf(const char* fmt, ...);
/// Write an already-formed block (a child's captured output) verbatim.
void logRaw(const char* data, size_t len);

/// A titled section header.
void section(const char* title);
/// One check's verdict inside a probe.
void check(bool ok, const char* name, const char* fmt, ...);

/// A headline fact — GPU name, driver version, interop support. Probes emit
/// these as `##FACT <key> = <value>` lines; the driver scrapes them out of the
/// child's output and reprints them all together at the top of the summary, so
/// the first screen of an uploaded log answers "what machine was this".
void fact(const char* key, const char* fmt, ...);

// --- Probes ---------------------------------------------------------------

using ProbeFn = bool (*)();

struct Probe {
  const char* name;     // --probe <name>
  const char* title;    // one line, for the log
  ProbeFn fn;
  unsigned timeout_s;   // the driver kills it after this
};

extern const Probe kProbes[];
extern const int kProbeCount;

// The probes themselves.
bool probeSystem();      // OS, CPU, RAM, what is in our own directory
bool probeAdapters();    // DXGI adapters, D3D11 device, feature level
bool probeCompiler();    // d3dcompiler_47.dll + a real D3DCompile
bool probeGL();          // WGL context, GL strings, WGL extensions
bool probeInterop();     // WGL_NV_DX_interop2 round trip, both directions
bool probeBarrelFrame(); // the plugin's whole frame, minus FFGL
bool probeFfglHost();    // NanoBarrel.dll driven through plugMain

// --- Helpers shared by the probes ----------------------------------------

/// Directory holding this executable, with no trailing separator.
std::string exeDir();
/// `<exeDir>\<name>`.
std::string besideExe(const char* name);
bool fileExists(const std::string& path);

/// A hidden-window OpenGL context, current on the calling thread for its
/// lifetime, with GLEW initialised. This is nano_diag standing in for the
/// host: Resolume makes the context, we have to make our own.
class GLContext {
 public:
  GLContext();
  ~GLContext();
  bool ok() const { return ok_; }
  const char* error() const { return error_.c_str(); }
  /// True once glewInit() has succeeded — nothing WGL-extension-shaped works
  /// before that.
  bool glewReady() const { return glew_ready_; }

  GLContext(const GLContext&) = delete;
  GLContext& operator=(const GLContext&) = delete;

 private:
  void* hwnd_ = nullptr;
  void* hdc_ = nullptr;
  void* hglrc_ = nullptr;
  bool ok_ = false;
  bool glew_ready_ = false;
  std::string error_;
};

/// Print the GL error queue, if any, tagged with where we were. Returns true
/// when the queue was empty.
bool glErrorsClear(const char* where);

}  // namespace diag
