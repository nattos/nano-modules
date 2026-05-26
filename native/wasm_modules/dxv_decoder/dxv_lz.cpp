#include "dxv_lz.h"
#include <cstring>

namespace dxv {

namespace {

// Little-endian reads. wasm32 is LE so memcpy gives us the right byte order
// for both aligned and unaligned addresses.
static inline uint32_t read_le32(const uint8_t* p) {
    uint32_t v;
    std::memcpy(&v, p, 4);
    return v;
}
static inline uint16_t read_le16(const uint8_t* p) {
    uint16_t v;
    std::memcpy(&v, p, 2);
    return v;
}
static inline void write_le32(uint8_t* p, uint32_t v) {
    std::memcpy(p, &v, 4);
}

} // namespace

int decompress_dxt1(const uint8_t* in_ptr, uint32_t in_size,
                    uint8_t* out_ptr, uint32_t out_size) {
    // Texture data is laid out as 4-byte elements; positions are counted
    // in those units, matching the FFmpeg reference. For DXT1 each block
    // is 8 bytes = 2 elements, and back-references are scaled by `x=2`.
    if (out_size < 8 || (out_size & 3) != 0) return -1;
    const uint8_t* in_end = in_ptr + in_size;
    const uint8_t* p = in_ptr;
    const uint32_t total_elems = out_size / 4;

    auto get_le32 = [&](uint32_t& out) -> int {
        if (p + 4 > in_end) return -1;
        out = read_le32(p);
        p += 4;
        return 0;
    };
    auto get_le16 = [&](uint16_t& out) -> int {
        if (p + 2 > in_end) return -1;
        out = read_le16(p);
        p += 2;
        return 0;
    };
    auto get_byte = [&](uint8_t& out) -> int {
        if (p >= in_end) return -1;
        out = *p++;
        return 0;
    };

    // First two elements (the first DXT1 block) are written verbatim.
    uint32_t v;
    if (get_le32(v) < 0) return -2;
    write_le32(out_ptr + 0, v);
    if (get_le32(v) < 0) return -2;
    write_le32(out_ptr + 4, v);

    uint32_t pos = 2;
    uint32_t value = 0;
    int state = 0;
    uint32_t idx = 0;
    uint32_t op = 0;

    auto checkpoint = [&](uint32_t x) -> int {
        if (state == 0) {
            uint32_t fresh;
            if (get_le32(fresh) < 0) return -1;
            value = fresh;
            state = 16;
        }
        op = value & 0x3u;
        value >>= 2;
        state--;
        switch (op) {
            case 0: break;
            case 1: idx = x; break;
            case 2: {
                uint8_t b;
                if (get_byte(b) < 0) return -1;
                idx = (uint32_t(b) + 2u) * x;
                if (idx > pos) return -1;
                break;
            }
            case 3: {
                uint16_t w;
                if (get_le16(w) < 0) return -1;
                idx = (uint32_t(w) + 0x102u) * x;
                if (idx > pos) return -1;
                break;
            }
        }
        return 0;
    };

    while (pos + 2 <= total_elems) {
        if (checkpoint(2) < 0) return -3;

        if (op != 0) {
            // Pair of back-referenced elements.
            uint32_t a = read_le32(out_ptr + 4 * (pos - idx));
            write_le32(out_ptr + 4 * pos, a);
            pos++;
            uint32_t b = read_le32(out_ptr + 4 * (pos - idx));
            write_le32(out_ptr + 4 * pos, b);
            pos++;
        } else {
            // Each of the next two elements is decided by its own op.
            for (int i = 0; i < 2; i++) {
                if (checkpoint(2) < 0) return -4;
                uint32_t prev;
                if (op != 0) {
                    prev = read_le32(out_ptr + 4 * (pos - idx));
                } else {
                    if (get_le32(prev) < 0) return -5;
                }
                write_le32(out_ptr + 4 * pos, prev);
                pos++;
            }
        }
    }

    return 0;
}

} // namespace dxv
