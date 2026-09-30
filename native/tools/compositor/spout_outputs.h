// spout_outputs.h — display outputs published as Spout senders (Windows), on
// the vendored Spout protocol core (third_party/spout: the sender-name
// registry, the sender info block, the frame counter — no DirectX or GL
// helpers: the compositor scales each frame into the sender's texture itself).
//
// One sender per output, named "Nano Modules - <slot name>" (Spout may suffix
// a clash: "…_1"). Its texture is BGRA8, shared by a legacy handle — what every
// Spout receiver opens — and made on a device of this class's own, on the
// ENGINE's adapter (gpu/d3d11_adapter_win.h: a shared texture opens only on the
// adapter that made it). The engine opens the handle and presents into it
// (GPUBackend::createSurfacePresentTarget); once the GPU has finished a frame,
// publish() bumps Spout's frame count.
//
// ensure/close on the window thread; publish from any thread.

#pragma once

#include <memory>
#include <string>

namespace compositor {

class SpoutOutputs {
 public:
  SpoutOutputs();
  ~SpoutOutputs();
  SpoutOutputs(const SpoutOutputs&) = delete;
  SpoutOutputs& operator=(const SpoutOutputs&) = delete;

  /// The sender for `key` (started on first use), named after `name`, with a
  /// width × height BGRA8 texture. Returns its share HANDLE (the same one until
  /// the size or name changes), or null on failure.
  void* ensure(const std::string& key, const std::string& name, int width, int height);
  /// A new frame is in `key`'s texture: tell the receivers.
  void publish(const std::string& key);
  /// Stop `key`'s sender (receivers see it go).
  void close(const std::string& key);
  bool has(const std::string& key) const;
  /// The name receivers list it under ("" if there's no such sender).
  std::string senderName(const std::string& key) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace compositor
