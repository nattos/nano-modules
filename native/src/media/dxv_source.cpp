#include "dxv_source.h"

#include <chrono>
#include <cstring>

#include "gpu/gpu_backend.h"
#include "platform/paths.h"
#include "media_dxv_blit_spv.h"  // DXV_BLIT_SPV — shaders/build_shaders.sh
#include "runtime/shader_from_spv.h"
#include "dxv_demux.h"
#include "dxv_lz.h"

namespace nano_media {
namespace {

// BC1 staging → RGBA8 is shaders/dxv_blit.hlsl (SPIR-V, translated for the
// live backend at PSO-build). It SAMPLES — Metal has no read() on a
// block-compressed texture — so it carries a nearest sampler.

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
  if (!nano_paths::seekFile(f, offset)) return false;
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
    // The shader/PSO handles are cheap and shared-lifetime with the backend;
    // release them too so a re-open doesn't leak one per file.
    if (blitPso_ >= 0) backend_->release(blitPso_);
    if (blitShader_ >= 0) backend_->release(blitShader_);
    if (blitSampler_ >= 0) backend_->release(blitSampler_);
  }
  blitPso_ = blitShader_ = blitSampler_ = -1;
  backend_ = nullptr;
  if (file_) { std::fclose(file_); file_ = nullptr; }
  frameOffsets_.clear();
  frameSizes_.clear();
  info_ = DxvVideoInfo();
}

bool DxvSource::open(const std::string& path) {
  close();
  file_ = nano_paths::openFile(path, "rb");
  if (!file_) { error_ = "cannot open " + path; return false; }
  nano_paths::seekFile(file_, 0, SEEK_END);
  fileSize_ = nano_paths::tellFile(file_);

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

bool DxvSource::ensurePipeline(gpu::GPUBackend* backend) {
  if (backend_ && backend_ != backend) {
    error_ = "DxvSource reused across backends";
    return false;
  }
  backend_ = backend;
  if (blitPso_ < 0) {
    blitShader_ = effect_runtime::createShaderModuleFromSpv(backend, DXV_BLIT_SPV, DXV_BLIT_SPV_SIZE,
                                                            "dxv_blit");
    if (blitShader_ < 0) { error_ = "BC1 blit shader failed to compile"; return false; }
    blitPso_ = backend->createComputePSO(blitShader_, "main");
    if (blitPso_ < 0) { error_ = "BC1 blit PSO failed"; return false; }
  }
  if (blitSampler_ < 0) {
    gpu::GPUBackend::SamplerDesc d;
    d.minFilter = d.magFilter = d.mipFilter = 0;  // nearest: texel centres, exact
    blitSampler_ = backend->createSampler(d);
    if (blitSampler_ < 0) { error_ = "BC1 blit sampler failed"; return false; }
  }
  return true;
}

namespace {
struct DxvFrame : DecodedFrame {
  std::vector<uint8_t> bc1;
};
}  // namespace

std::unique_ptr<DecodedFrame> DxvSource::prepare(int idx) {
  if (!file_) { error_ = "decode before open"; return nullptr; }
  if (idx < 0 || idx >= info_.frameCount) {
    error_ = "frame index out of range";
    return nullptr;
  }
  const double t0 = nowMs();
  const uint32_t size = frameSizes_[idx];
  payload_.resize(size);
  if (!readAt(file_, frameOffsets_[idx], payload_.data(), size)) {
    error_ = "short read of frame payload";
    return nullptr;
  }
  auto f = std::make_unique<DxvFrame>();
  if (!decompressFrame(payload_.data(), size, info_.width, info_.height, &f->bc1, &error_)) {
    return nullptr;
  }
  f->index = idx;
  f->payloadBytes = size;
  f->prepareMs = nowMs() - t0;
  return f;
}

bool DxvSource::upload(gpu::GPUBackend* backend, const DecodedFrame& frame, int32_t outTexHandle) {
  const auto& bc1 = static_cast<const DxvFrame&>(frame).bc1;
  if (!ensurePipeline(backend)) return false;

  // A FRESH staging texture per decode. The upload lands on the CPU at once,
  // while the blit only runs when the command buffer does — so decodes batched
  // before one submit (a pull plus its read-ahead) sharing a staging texture
  // would all blit the LAST upload. The encoder retains it past release().
  const int32_t staging = backend->createTexture(info_.width, info_.height, kFmtBC1);
  if (staging < 0) { error_ = "BC1 staging texture allocation failed"; return false; }
  backend->writeTexture(staging, info_.width, info_.height, bc1.data(), (uint32_t)bc1.size());

  const int32_t pass = backend->beginComputePass();
  backend->computeSetPSO(pass, blitPso_);
  backend->computeSetTexture(pass, staging, 0, /*access=*/0);   // read
  backend->computeSetSampler(pass, blitSampler_, 1);
  backend->computeSetTexture(pass, outTexHandle, 2, /*access=*/1);  // write
  backend->computeDispatch(pass, (info_.width + 7) / 8, (info_.height + 7) / 8, 1);
  backend->endComputePass(pass);
  backend->release(staging);
  return true;
}

}  // namespace nano_media
