#include "frame_source.h"

#include <chrono>

#include "dxv_source.h"
#ifdef __APPLE__
#include "avf_source.h"
#endif

namespace nano_media {

bool FrameSource::decode(gpu::GPUBackend* backend, int idx, int32_t outTexHandle) {
  const auto t0 = std::chrono::steady_clock::now();
  const auto frame = prepare(idx);
  const bool ok = frame && upload(backend, *frame, outTexHandle);
  lastDecodeMs_ = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - t0).count();
  return ok;
}

std::unique_ptr<FrameSource> openFrameSource(const std::string& path, std::string* error) {
  // DXV first: AVFoundation would happily parse a DXV .mov and then fail to
  // decode it (no system codec), and the codec tag settles it for free.
  auto dxv = std::make_unique<DxvSource>();
  if (dxv->open(path)) return dxv;
  std::string why = "dxv: " + dxv->error();
#ifdef __APPLE__
  std::string e;
  if (auto img = openImageFrameSource(path, &e)) return img;
  why += "; image: " + e;
  e.clear();
  if (auto vid = openAvfVideoSource(path, &e)) return vid;
  why += "; avfoundation: " + e;
#endif
  if (error) *error = why;
  return nullptr;
}

}  // namespace nano_media
