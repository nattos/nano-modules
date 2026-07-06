#pragma once
// preview_codec.h — the NBPV v2 binary preview-frame layout, shared by every
// producer that ships a thumbnail to the web over the bridge's binary channel.
//
// One WS server multiplexes many instances, so the producer's plugin key is
// embedded in the header and the web routes each frame to the matching
// instance. Matching decoder: web/src/widgets/texture-monitor.ts + the
// main-socket back-compat path in web/src/state/controller.ts
// (ingestBarrelPreviewFrame).
//
//   [0..3]   "NBPV"
//   [4]      version = 2
//   [5]      format  = 1 (RGBA8)
//   [6..7]   u16 keyLen   (little-endian)
//   [8..9]   u16 idLen    (traceId length)
//   [10..11] u16 width
//   [12..13] u16 height
//   [14 ..]  key bytes, then traceId bytes, then RGBA8 pixels
//
// Producers: the NanoBarrel runtime (per-sketch/sidechannel previews) and the
// NanoLooper Ch marker (per-clip thumbnails). Keep this the ONE definition of
// the format so the two never drift.

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace preview_codec {

// Build an NBPV v2 frame into `out` (typically a pooled/recycled vector — a
// fresh multi-MB allocation per frame can cost more than the readback itself).
inline void build_nbpv_frame(std::vector<uint8_t>& out,
                             const std::string& key, const std::string& traceId,
                             uint16_t width, uint16_t height,
                             const uint8_t* pixels, size_t pixelBytes) {
  const uint16_t keyLen = (uint16_t)key.size();
  const uint16_t idLen = (uint16_t)traceId.size();
  const size_t headerSize = 14 + keyLen + idLen;
  out.resize(headerSize + pixelBytes);
  out[0] = 'N'; out[1] = 'B'; out[2] = 'P'; out[3] = 'V';
  out[4] = 2;             // version
  out[5] = 1;             // format: RGBA8
  out[6] = (uint8_t)(keyLen & 0xFF);
  out[7] = (uint8_t)(keyLen >> 8);
  out[8] = (uint8_t)(idLen & 0xFF);
  out[9] = (uint8_t)(idLen >> 8);
  out[10] = (uint8_t)(width & 0xFF);
  out[11] = (uint8_t)(width >> 8);
  out[12] = (uint8_t)(height & 0xFF);
  out[13] = (uint8_t)(height >> 8);
  memcpy(out.data() + 14, key.data(), keyLen);
  memcpy(out.data() + 14 + keyLen, traceId.data(), idLen);
  if (pixelBytes) memcpy(out.data() + headerSize, pixels, pixelBytes);
}

}  // namespace preview_codec
