/*
 * dxv_decoder — WASM service module.
 *
 * Not an effect — registers no EffectDesc. Instead exports a small C ABI that
 * the host TS wrapper calls directly to:
 *   - parse a QuickTime container (moov atom) into a flat frame table,
 *   - LZ-decompress an individual DXV3 DXT1 frame,
 *   - dispatch a BC1→RGBA8 compute shader into a caller-provided texture.
 *
 * The host module path (TS) loads this via WasmHost.load() +
 * activateServiceModule(), then calls the exports through instance.exports.
 */

#include <module_api.h>   // not used (no nano::registerEffect) but kept to surface the imports
#include <host.h>
#include <gpu.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>

#include "dxv_demux.h"
#include "dxv_lz.h"
#include "dxv_decoder_shaders.h"   // DECODE_SPV / DECODE_SPV_SIZE — generated at build time

namespace {

dxv::Demuxer       s_demux;
gpu::ComputePSO    s_pso;
gpu::Buffer        s_block_buffer;
uint32_t           s_block_buffer_capacity = 0;
uint8_t*           s_scratch = nullptr;
uint32_t           s_scratch_capacity = 0;
bool               s_pso_ready = false;
bool               s_spv_registered = false;

void register_spv_once() {
    if (s_spv_registered) return;
    // The shader writes RGBA8 via a storage texture; tell the host to
    // substitute that into the WGSL naga emits.
    state::registerShaderSPV("dxv_bc1_decode",
                             DECODE_SPV, DECODE_SPV_SIZE,
                             "rgba8unorm", "write");
    s_spv_registered = true;
}

int ensure_pso() {
    if (s_pso_ready) return 0;
    if (gpu::Device::backend() == gpu::Backend::None) return -100;
    register_spv_once();
    auto mod = gpu::Device::createShaderModuleByName("dxv_bc1_decode");
    if (!mod) return -101;
    s_pso = gpu::Device::createComputePSO(
        mod, "main",
        gpu::Bindings()
            .storage(0)
            .storageTex2d(1, gpu::TextureFormat::RGBA8));
    if (!s_pso) return -102;
    s_pso_ready = true;
    return 0;
}

int ensure_block_buffer(uint32_t need_bytes) {
    if (s_block_buffer.valid() && s_block_buffer_capacity >= need_bytes) return 0;
    if (s_block_buffer.valid()) s_block_buffer.release();
    s_block_buffer = gpu::Device::createBuffer(int(need_bytes), gpu::BufferUsage::Storage);
    if (!s_block_buffer.valid()) return -110;
    s_block_buffer_capacity = need_bytes;
    return 0;
}

int ensure_scratch(uint32_t need_bytes) {
    if (s_scratch && s_scratch_capacity >= need_bytes) return 0;
    std::free(s_scratch);
    s_scratch = static_cast<uint8_t*>(std::malloc(need_bytes));
    if (!s_scratch) return -120;
    s_scratch_capacity = need_bytes;
    return 0;
}

} // namespace

extern "C" {

// Service modules register their SPV from nano_module_main; nothing else.
__attribute__((export_name("nano_module_main")))
void nano_module_main() {
    register_spv_once();
}

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

// Returns the codec FourCC as an LE32 (i.e. the ASCII bytes packed in order:
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

// --- Frame decode ---
//
// Caller has already sliced the frame payload from the source file and
// copied it into linear memory at `payload_ptr` (typically via dxv_alloc).
// The 12-byte DXV3 header is at the start; this routine reads it, runs LZ
// decompression (or the raw passthrough) into the scratch buffer, then
// dispatches the BC1 decode compute shader into `out_tex_handle`.
//
// Returns 0 on success, negative on failure.
__attribute__((export_name("dxv_decode_frame")))
int32_t dxv_decode_frame(const uint8_t* payload_ptr, uint32_t payload_len,
                         int32_t out_tex_handle) {
    if (s_demux.frame_count() == 0) return -1;
    if (payload_len < 12) return -2;
    if (out_tex_handle <= 0) return -3;

    // DXV3 12-byte per-frame header (see FFmpeg dxv_decode):
    //   4 bytes: FourCC (e.g. "DXT1", "DXT5", "YCG6"). Stored as LE u32 of
    //            the ASCII bytes, i.e. 'D'|'X'<<8|'T'<<16|'1'<<24 reading
    //            the bytes back as ASCII left-to-right.
    //   1 byte:  version_major (encoder value, FFmpeg subtracts 1)
    //   1 byte:  version_minor
    //   1 byte:  raw_flag — non-zero means the rest of the payload is the
    //            uncompressed texture data with no LZ pass.
    //   1 byte:  unknown
    //   4 bytes: payload_size (LE u32)
    uint32_t per_frame_fourcc;
    std::memcpy(&per_frame_fourcc, payload_ptr + 0, 4);
    uint8_t raw_flag = payload_ptr[6];
    uint32_t payload_size;
    std::memcpy(&payload_size, payload_ptr + 8, 4);
    const uint8_t* lz_in = payload_ptr + 12;
    if (uint64_t(payload_size) + 12 > payload_len) return -4;

    // We only handle plain BC1 in this slice. DXT5 / YCoCg variants ship
    // later; the FourCC dispatch hook is already here.
    //
    // DXV writes its per-frame FourCC big-endian-style ('D' in the high
    // byte) so that on an LE machine the bytes appear in memory as
    // '1','T','X','D'. Matches FFmpeg's MKBETAG('D','X','T','1') in
    // libavcodec/dxv.h.
    constexpr uint32_t FOURCC_DXT1 =
        (uint32_t('D') << 24) | (uint32_t('X') << 16) | (uint32_t('T') << 8) | uint32_t('1');
    if (per_frame_fourcc != FOURCC_DXT1) return -5;

    uint32_t w = s_demux.width();
    uint32_t h = s_demux.height();
    if (w == 0 || h == 0) return -6;
    // BC1 packs 4×4 pixels per 8-byte block. Round dimensions up to a
    // multiple of 4 to match the encoder's padding.
    uint32_t blocks_x = (w + 3) / 4;
    uint32_t blocks_y = (h + 3) / 4;
    uint32_t tex_bytes = blocks_x * blocks_y * 8;

    if (ensure_scratch(tex_bytes) < 0) return -7;

    if (raw_flag) {
        if (payload_size != tex_bytes) return -8;
        std::memcpy(s_scratch, lz_in, tex_bytes);
    } else {
        int rc = dxv::decompress_dxt1(lz_in, payload_size, s_scratch, tex_bytes);
        if (rc < 0) return -9 + rc;   // surface LZ error
    }

    if (ensure_pso() < 0) return -20;
    if (ensure_block_buffer(tex_bytes) < 0) return -21;

    s_block_buffer.writeBytes(s_scratch, int(tex_bytes), 0);

    auto cp = gpu::ComputePass::begin();
    cp.setPSO(s_pso);
    cp.setBuffer(s_block_buffer, 0);
    cp.setTexture(gpu::Texture(out_tex_handle), 1, /*access=*/1);
    cp.dispatch(int((w + 7) / 8), int((h + 7) / 8), 1);
    cp.end();
    gpu::Device::submit();

    return 0;
}

} // extern "C"
