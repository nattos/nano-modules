// dxv_source.h — a file-backed DXV frame source for the native host.
//
// The native twin of web/src/dxv-decoder.ts + web/src/video/dxv-frame-source.ts,
// and it REUSES their decoder: `wasm_modules/dxv_decoder/{dxv_demux,dxv_lz}.cpp`
// are pure portable C++ (only cstdint/cstdlib/cstring), so they compile into
// this target unchanged rather than being ported. Only the two halves the web
// keeps in TS are written here: the container walk that finds `moov`, and the
// GPU upload.
//
// The GPU path matches web exactly: LZ-decompress to BC1 bytes, upload into a
// BC1 staging texture, then one compute pass that samples it (the hardware
// decompresses on read) into the caller's RGBA8 texture.
//
// HOST ONLY. Nothing under src/sketch/comp/ may include this — it touches the
// filesystem and the GPU backend, and comp is dual-compiled into executor.wasm.

#pragma once

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace gpu { class GPUBackend; }

namespace nano_media {

struct DxvVideoInfo {
  uint32_t width = 0;
  uint32_t height = 0;
  /// Codec FourCC packed as the LE32 of the ASCII bytes ("DXD3" → 0x33445844).
  uint32_t fourcc = 0;
  /// Codec FourCC as a 4-char string ("DXD3", "DXDA", ...).
  std::string fourccStr;
  int frameCount = 0;
  /// Real container frame rate, or 0 = unknown.
  ///
  /// Always 0 today: the frame rate lives in the moov's mvhd/mdhd, which the
  /// demuxer doesn't read (web parses it separately in bmff-meta.ts). Every
  /// consumer already falls back to the document's `source.fps` — which is
  /// probed from the same container at import — so this costs nothing until
  /// something needs the rate without a document.
  double fps = 0;
};

/**
 * One opened DXV file. Random access: every frame is independent, so there is
 * no seek cost and no play-forward-only constraint (the `streaming` flag on the
 * web FrameSource interface is false for exactly this reason).
 */
class DxvSource {
 public:
  ~DxvSource();
  DxvSource(const DxvSource&) = delete;
  DxvSource& operator=(const DxvSource&) = delete;
  DxvSource() = default;

  /**
   * Open `path` and build the frame table from its `moov` atom. Reads only the
   * top-level box headers plus the moov body — never mdat, so this stays cheap
   * on multi-gigabyte files.
   *
   * Returns false and fills `error()` when the file can't be read, doesn't
   * parse, or isn't a DXV stream (the container parses for any ISO-BMFF, so the
   * codec tag is the only thing that separates a DXV .mov from an h264 one).
   */
  bool open(const std::string& path);

  bool isOpen() const { return file_ != nullptr; }
  const DxvVideoInfo& info() const { return info_; }
  const std::string& error() const { return error_; }

  /// Absolute file offset / compressed size of a frame. For diagnostics and
  /// the cost tracker's payload-size EWMA.
  uint64_t frameOffset(int idx) const;
  uint32_t frameSize(int idx) const;

  /**
   * Decode frame `idx` into the RGBA8 texture `outTexHandle` (a handle from the
   * same backend). Returns false on a bad index, a short read, or a decompress
   * failure; `error()` says which.
   *
   * The BC1 staging texture and the blit pipeline are created lazily on the
   * first decode and reused.
   */
  bool decode(gpu::GPUBackend* backend, int idx, int32_t outTexHandle);

  /// Milliseconds spent inside the last decode() — the cost tracker's input.
  double lastDecodeMs() const { return lastDecodeMs_; }

  void close();

 private:
  bool ensureStaging(gpu::GPUBackend* backend);

  std::FILE* file_ = nullptr;
  uint64_t fileSize_ = 0;
  DxvVideoInfo info_;
  std::string error_;

  std::vector<uint64_t> frameOffsets_;
  std::vector<uint32_t> frameSizes_;

  std::vector<uint8_t> payload_;   // compressed scratch, grown on demand
  std::vector<uint8_t> bc1_;       // decompressed BC1 bytes

  gpu::GPUBackend* backend_ = nullptr;
  int32_t bc1Tex_ = -1;
  uint32_t bc1TexW_ = 0;
  uint32_t bc1TexH_ = 0;
  int32_t blitShader_ = -1;
  int32_t blitPso_ = -1;

  double lastDecodeMs_ = 0;
};

}  // namespace nano_media
