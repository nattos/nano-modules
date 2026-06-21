/*
 * dxv_decoder — WASM service module.
 *
 * Not an effect — registers no EffectDesc. Exposes a small C ABI the host
 * TS wrapper calls directly to:
 *   - parse a QuickTime container (moov atom) into a flat frame table,
 *   - LZ-decompress one DXV3 DXT1 frame into a scratch buffer in wasm
 *     linear memory.
 *
 * GPU work is owned by the TS wrapper: BC1 native upload via
 * device.queue.writeTexture into a bc1-rgba-unorm texture, plus a one-
 * compute-pass blit into the caller-supplied rgba8unorm output texture.
 * No shader is bundled here — the GPU does BC1 decode in hardware at
 * sample time.
 */

#include <cstdint>
#include <cstdlib>
#include <cstring>

#include "dxv_demux.h"
#include "dxv_lz.h"
#include "../include/module_api.h"  // NANO_EXPORT_ABI_VERSION (no effects registered)

// State for the LZ scratch buffer (decompressed BC1 bytes). Sized to fit
// the largest BC1 frame we'll see; grown on demand.
namespace {

dxv::Demuxer s_demux;
uint8_t*     s_scratch = nullptr;
uint32_t     s_scratch_capacity = 0;

int ensure_scratch(uint32_t need_bytes) {
    if (s_scratch && s_scratch_capacity >= need_bytes) return 0;
    std::free(s_scratch);
    s_scratch = static_cast<uint8_t*>(std::malloc(need_bytes));
    if (!s_scratch) return -1;
    s_scratch_capacity = need_bytes;
    return 0;
}

} // namespace

extern "C" {

// Service modules don't register effects; the entry point exists so the
// host's WasmHost.load() has something to call.
NANO_EXPORT_ABI_VERSION()

__attribute__((export_name("nano_module_main")))
void nano_module_main() {}

// --- Scratch buffer helpers (so JS can copy file bytes into linear memory) ---

__attribute__((export_name("dxv_alloc")))
void* dxv_alloc(uint32_t n) {
    return std::malloc(n);
}

__attribute__((export_name("dxv_free")))
void dxv_free(void* p) {
    std::free(p);
}

// --- Container parse ---

// Parse the bytes (must contain `moov`). Returns frame count, or -1 on error.
__attribute__((export_name("dxv_parse_container")))
int32_t dxv_parse_container(const uint8_t* bytes, uint32_t len) {
    auto r = s_demux.parse(bytes, len);
    if (!r.ok) return -1;
    return int32_t(r.frame_count);
}

__attribute__((export_name("dxv_frame_count")))
uint32_t dxv_frame_count_ex() { return s_demux.frame_count(); }

__attribute__((export_name("dxv_video_width")))
uint32_t dxv_video_width_ex() { return s_demux.width(); }

__attribute__((export_name("dxv_video_height")))
uint32_t dxv_video_height_ex() { return s_demux.height(); }

// Returns the codec FourCC as an LE32 (ASCII bytes packed in file order:
// "DXD3" → 0x33445844). Callers comparing against ASCII can either decode
// the LE32 or compare against the same packed constant.
__attribute__((export_name("dxv_video_fourcc")))
uint32_t dxv_video_fourcc_ex() { return s_demux.fourcc(); }

// 64-bit offset return — JS sees a BigInt.
__attribute__((export_name("dxv_get_frame_offset")))
uint64_t dxv_get_frame_offset_ex(uint32_t idx) {
    if (idx >= s_demux.frame_count()) return 0;
    return s_demux.frames()[idx].offset;
}

__attribute__((export_name("dxv_get_frame_size")))
uint32_t dxv_get_frame_size_ex(uint32_t idx) {
    if (idx >= s_demux.frame_count()) return 0;
    return s_demux.frames()[idx].size;
}

// --- Frame decompress ---
//
// Reads the 12-byte DXV3 header, runs LZ decompression (or raw-mode
// passthrough) into the module's scratch buffer, and returns a wasm
// linear-memory pointer to the decompressed BC1 bytes. The output byte
// length is always (ceil(w/4) * ceil(h/4) * 8) for DXT1 — the caller
// already knows this from the demuxer.
//
// Returns 0 on failure. Subsequent calls overwrite the scratch buffer.
__attribute__((export_name("dxv_lz_decompress_frame")))
uint32_t dxv_lz_decompress_frame(const uint8_t* payload_ptr,
                                  uint32_t payload_len) {
    if (s_demux.frame_count() == 0) return 0;
    if (payload_len < 12) return 0;

    // DXV3 12-byte per-frame header (see FFmpeg dxv_decode):
    //   4 bytes: FourCC, MKBETAG('D','X','T','1') for DXT1
    //   1 byte:  version_major (encoder value, FFmpeg subtracts 1)
    //   1 byte:  version_minor
    //   1 byte:  raw_flag — non-zero means the rest of the payload is
    //            the uncompressed BC1 data with no LZ pass.
    //   1 byte:  unknown
    //   4 bytes: payload_size (LE u32) — size of the LZ stream that
    //            follows the header.
    uint32_t per_frame_fourcc;
    std::memcpy(&per_frame_fourcc, payload_ptr + 0, 4);
    uint8_t raw_flag = payload_ptr[6];
    uint32_t payload_size;
    std::memcpy(&payload_size, payload_ptr + 8, 4);
    const uint8_t* lz_in = payload_ptr + 12;
    if (uint64_t(payload_size) + 12 > payload_len) return 0;

    // DXT1 only for now; DXT5 / YCoCg variants are the future hook.
    // DXV writes its FourCC big-endian-style so on an LE machine the
    // bytes appear as '1','T','X','D'. Matches FFmpeg's
    // MKBETAG('D','X','T','1') in libavcodec/dxv.h.
    constexpr uint32_t FOURCC_DXT1 =
        (uint32_t('D') << 24) | (uint32_t('X') << 16) | (uint32_t('T') << 8) | uint32_t('1');
    if (per_frame_fourcc != FOURCC_DXT1) return 0;

    uint32_t w = s_demux.width();
    uint32_t h = s_demux.height();
    if (w == 0 || h == 0) return 0;
    uint32_t blocks_x = (w + 3) / 4;
    uint32_t blocks_y = (h + 3) / 4;
    uint32_t tex_bytes = blocks_x * blocks_y * 8;

    if (ensure_scratch(tex_bytes) < 0) return 0;

    if (raw_flag) {
        if (payload_size != tex_bytes) return 0;
        std::memcpy(s_scratch, lz_in, tex_bytes);
    } else {
        int rc = dxv::decompress_dxt1(lz_in, payload_size, s_scratch, tex_bytes);
        if (rc < 0) return 0;
    }

    return uint32_t(reinterpret_cast<uintptr_t>(s_scratch));
}

} // extern "C"
