#include "dxv_source.h"

#include <chrono>
#include <cstring>

#include "gpu/gpu_backend.h"
#include "dxv_demux.h"
#include "dxv_lz.h"

namespace nano_media {
namespace {

/// BC1 staging → RGBA8. `read()` isn't defined for block-compressed textures in
/// MSL, so this SAMPLES with pixel coordinates instead; the hardware BC1 unit
/// decompresses on the way out. Raw MSL because this is host-only code that
/// never enters a wasm bundle (the same route host_impls_text.cpp takes).
/// MSL doesn't encode a threadgroup shape, so the backend reads the
/// `nano_threadgroup` hint below (and warns when a raw kernel omits it). 8×8
/// matches both the dispatch here and the web blit's @workgroup_size.
constexpr const char* kBlitMSL = R"MSL(
// nano_threadgroup: 8 8 1
#include <metal_stdlib>
using namespace metal;

kernel void dxv_blit(texture2d<float, access::sample> src [[texture(0)]],
                     texture2d<float, access::write>  dst [[texture(1)]],
                     uint2 gid [[thread_position_in_grid]]) {
  if (gid.x >= dst.get_width() || gid.y >= dst.get_height()) return;
  constexpr sampler s(coord::pixel, filter::nearest, address::clamp_to_edge);
  dst.write(src.sample(s, float2(gid) + 0.5f), gid);
}
)MSL";

/// TextureFormat::BC1 (gpu.h) — host-only staging format.
constexpr int32_t kFmtBC1 = 8;
constexpr int32_t kFmtRGBA8 = 1;

uint32_t readBE32(const uint8_t* p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}

uint64_t readBE64(const uint8_t* p) {
  return ((uint64_t)readBE32(p) << 32) | readBE32(p + 4);
}

bool readAt(std::FILE* f, uint64_t offset, void* dst, size_t len) {
  if (std::fseek(f, (long)offset, SEEK_SET) != 0) return false;
  return std::fread(dst, 1, len, f) == len;
}

std::string fourCCToString(uint32_t le32) {
  // Stored as the LE32 of the ASCII bytes in file order.
  char s[5] = {(char)(le32 & 0xff), (char)((le32 >> 8) & 0xff), (char)((le32 >> 16) & 0xff),
               (char)((le32 >> 24) & 0xff), 0};
  return std::string(s);
}

double nowMs() {
  using clock = std::chrono::steady_clock;
  return std::chrono::duration<double, std::milli>(clock::now().time_since_epoch()).count();
}

/**
 * Walk the top-level ISO-BMFF boxes and return the byte range of the first
 * `moov`. Reads 8 or 16 bytes per box, so skipping past a multi-gigabyte mdat
 * is essentially free. Twin of findMoov() in web/src/dxv-decoder.ts.
 */
bool findMoov(std::FILE* f, uint64_t fileSize, uint64_t* outOffset, uint64_t* outSize) {
  uint64_t pos = 0;
  while (pos < fileSize) {
    const uint64_t remaining = fileSize - pos;
    if (remaining < 8) break;
    uint8_t hdr[16];
    const size_t want = remaining < 16 ? (size_t)remaining : 16;
    if (!readAt(f, pos, hdr, want)) return false;
    uint64_t size = readBE32(hdr);
    const uint32_t type = readBE32(hdr + 4);
    if (size == 1) {
      if (want < 16) return false;
      size = readBE64(hdr + 8);  // 64-bit extended size
    } else if (size == 0) {
      size = remaining;          // "to end of file"
    }
    if (size < 8 || size > remaining) return false;
    if (type == 0x6d6f6f76 /* 'moov' */) {
      *outOffset = pos;
      *outSize = size;
      return true;
    }
    pos += size;
  }
  return false;
}

/// The DXV3 per-frame header, lifted from wasm_modules/dxv_decoder/main.cpp so
/// both hosts read the payload the same way.
///   4 bytes FourCC (MKBETAG('D','X','T','1')), 1 version_major,
///   1 version_minor, 1 raw_flag (uncompressed BC1 follows), 1 unknown,
///   4 bytes LE payload_size.
bool decompressFrame(const uint8_t* payload, uint32_t payloadLen, uint32_t width,
                     uint32_t height, std::vector<uint8_t>* out, std::string* error) {
  if (payloadLen < 12) { *error = "frame payload shorter than its 12-byte header"; return false; }
  uint32_t perFrameFourcc = 0;
  std::memcpy(&perFrameFourcc, payload, 4);
  const uint8_t rawFlag = payload[6];
  uint32_t payloadSize = 0;
  std::memcpy(&payloadSize, payload + 8, 4);
  const uint8_t* lzIn = payload + 12;
  if ((uint64_t)payloadSize + 12 > payloadLen) { *error = "frame payload size overruns"; return false; }

  // DXT1 only, matching the wasm module. DXV writes its FourCC big-endian-style
  // so the bytes read '1','T','X','D' on an LE machine.
  constexpr uint32_t kFourccDXT1 =
      ((uint32_t)'D' << 24) | ((uint32_t)'X' << 16) | ((uint32_t)'T' << 8) | (uint32_t)'1';
  if (perFrameFourcc != kFourccDXT1) {
    *error = "unsupported per-frame codec (DXT1 only)";
    return false;
  }

  const uint32_t blocksX = (width + 3) / 4;
  const uint32_t blocksY = (height + 3) / 4;
  const uint32_t texBytes = blocksX * blocksY * 8;
  out->resize(texBytes);

  if (rawFlag) {
    if (payloadSize != texBytes) { *error = "raw frame size mismatch"; return false; }
    std::memcpy(out->data(), lzIn, texBytes);
    return true;
  }
  if (dxv::decompress_dxt1(lzIn, payloadSize, out->data(), texBytes) < 0) {
    *error = "LZ decompress failed";
    return false;
  }
  return true;
}

}  // namespace

DxvSource::~DxvSource() { close(); }

void DxvSource::close() {
  if (backend_) {
    if (bc1Tex_ >= 0) backend_->release(bc1Tex_);
    // The shader/PSO handles are cheap and shared-lifetime with the backend;
    // release them too so a re-open doesn't leak one per file.
    if (blitPso_ >= 0) backend_->release(blitPso_);
    if (blitShader_ >= 0) backend_->release(blitShader_);
  }
  bc1Tex_ = blitPso_ = blitShader_ = -1;
  bc1TexW_ = bc1TexH_ = 0;
  backend_ = nullptr;
  if (file_) { std::fclose(file_); file_ = nullptr; }
  frameOffsets_.clear();
  frameSizes_.clear();
  info_ = DxvVideoInfo();
}

bool DxvSource::open(const std::string& path) {
  close();
  file_ = std::fopen(path.c_str(), "rb");
  if (!file_) { error_ = "cannot open " + path; return false; }
  std::fseek(file_, 0, SEEK_END);
  fileSize_ = (uint64_t)std::ftell(file_);

  uint64_t moovOff = 0, moovSize = 0;
  if (!findMoov(file_, fileSize_, &moovOff, &moovSize)) {
    error_ = "no moov atom in " + path;
    close();
    return false;
  }
  std::vector<uint8_t> moov((size_t)moovSize);
  if (!readAt(file_, moovOff, moov.data(), moov.size())) {
    error_ = "short read of moov";
    close();
    return false;
  }

  dxv::Demuxer demux;
  const dxv::ParseResult r = demux.parse(moov.data(), (uint32_t)moov.size());
  if (!r.ok) { error_ = "container parse failed"; close(); return false; }

  info_.width = r.width;
  info_.height = r.height;
  info_.fourcc = r.fourcc;
  info_.fourccStr = fourCCToString(r.fourcc);
  info_.frameCount = (int)r.frame_count;
  info_.fps = 0;  // see the header — consumers fall back to the document's fps

  // Any ISO-BMFF parses; only a DXV stream carries a DX* codec tag. Reject the
  // rest so the caller can route it to another decoder instead of decoding
  // garbage. Mirrors DxvFrameSource.create's NotDxvError.
  if (info_.fourccStr.size() < 2 || info_.fourccStr[0] != 'D' || info_.fourccStr[1] != 'X') {
    error_ = "not a DXV stream (codec '" + info_.fourccStr + "')";
    close();
    return false;
  }

  frameOffsets_.resize(r.frame_count);
  frameSizes_.resize(r.frame_count);
  uint32_t maxSize = 0;
  for (uint32_t i = 0; i < r.frame_count; i++) {
    frameOffsets_[i] = r.frames[i].offset;
    frameSizes_[i] = r.frames[i].size;
    if (r.frames[i].size > maxSize) maxSize = r.frames[i].size;
  }
  payload_.reserve(maxSize);
  return true;
}

uint64_t DxvSource::frameOffset(int idx) const {
  return (idx >= 0 && idx < (int)frameOffsets_.size()) ? frameOffsets_[idx] : 0;
}

uint32_t DxvSource::frameSize(int idx) const {
  return (idx >= 0 && idx < (int)frameSizes_.size()) ? frameSizes_[idx] : 0;
}

bool DxvSource::ensureStaging(gpu::GPUBackend* backend) {
  if (backend_ && backend_ != backend) {
    error_ = "DxvSource reused across backends";
    return false;
  }
  backend_ = backend;
  if (bc1Tex_ < 0 || bc1TexW_ != info_.width || bc1TexH_ != info_.height) {
    if (bc1Tex_ >= 0) backend->release(bc1Tex_);
    bc1Tex_ = backend->createTexture(info_.width, info_.height, kFmtBC1);
    if (bc1Tex_ < 0) { error_ = "BC1 staging texture allocation failed"; return false; }
    bc1TexW_ = info_.width;
    bc1TexH_ = info_.height;
  }
  if (blitPso_ < 0) {
    blitShader_ = backend->createShaderModule(kBlitMSL);
    if (blitShader_ < 0) { error_ = "BC1 blit shader failed to compile"; return false; }
    blitPso_ = backend->createComputePSO(blitShader_, "dxv_blit");
    if (blitPso_ < 0) { error_ = "BC1 blit PSO failed"; return false; }
  }
  return true;
}

bool DxvSource::decode(gpu::GPUBackend* backend, int idx, int32_t outTexHandle) {
  if (!file_) { error_ = "decode before open"; return false; }
  if (idx < 0 || idx >= info_.frameCount) {
    error_ = "frame index out of range";
    return false;
  }
  const double t0 = nowMs();

  const uint32_t size = frameSizes_[idx];
  payload_.resize(size);
  if (!readAt(file_, frameOffsets_[idx], payload_.data(), size)) {
    error_ = "short read of frame payload";
    return false;
  }
  if (!decompressFrame(payload_.data(), size, info_.width, info_.height, &bc1_, &error_)) {
    return false;
  }
  if (!ensureStaging(backend)) return false;

  backend->writeTexture(bc1Tex_, info_.width, info_.height, bc1_.data(), (uint32_t)bc1_.size());

  const int32_t pass = backend->beginComputePass();
  backend->computeSetPSO(pass, blitPso_);
  backend->computeSetTexture(pass, bc1Tex_, 0, /*access=*/0);   // read
  backend->computeSetTexture(pass, outTexHandle, 1, /*access=*/1);  // write
  backend->computeDispatch(pass, (info_.width + 7) / 8, (info_.height + 7) / 8, 1);
  backend->endComputePass(pass);

  lastDecodeMs_ = nowMs() - t0;
  return true;
}

}  // namespace nano_media
