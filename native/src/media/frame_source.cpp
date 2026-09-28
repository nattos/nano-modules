#include "frame_source.h"

#include "dxv_source.h"
#ifdef __APPLE__
#include "avf_source.h"
#endif

namespace nano_media {

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
