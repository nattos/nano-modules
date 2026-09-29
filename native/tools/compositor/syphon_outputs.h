// syphon_outputs.h — display outputs published as Syphon servers, on the
// vendored Syphon protocol core (third_party/syphon; no GL/Metal renderers:
// the compositor scales each frame into the server's IOSurface itself).
//
// One server per output, named after its display slot; clients list it as
// "Nano Modules – Display 1" (the process names itself — display_windows).
// MAIN THREAD ONLY: Syphon's server swaps its surface and publishes without a
// lock, and announces itself through distributed notifications on the main run
// loop.

#pragma once

#include <IOSurface/IOSurfaceRef.h>

#include <memory>
#include <string>

namespace compositor {

class SyphonOutputs {
 public:
  /// `privateServers` (tests): don't announce them system-wide — a client
  /// still connects by description(), but no Syphon app lists them.
  explicit SyphonOutputs(bool privateServers = false);
  ~SyphonOutputs();
  SyphonOutputs(const SyphonOutputs&) = delete;
  SyphonOutputs& operator=(const SyphonOutputs&) = delete;

  /// The server for `key` (started on first use), named `name`, with a
  /// width × height BGRA surface. Returns that surface RETAINED (+1; the same
  /// one until the size changes), or null on failure.
  IOSurfaceRef ensure(const std::string& key, const std::string& name, int width, int height);
  /// A new frame is in `key`'s surface: tell its clients.
  void publish(const std::string& key);
  /// Stop `key`'s server (clients see it retire).
  void close(const std::string& key);
  bool has(const std::string& key) const;
  /// The server's description (`NSDictionary*`, what a client connects with) —
  /// tests. Null if there's no such server.
  void* description(const std::string& key) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace compositor
