#pragma once
// QuickTime / ISO-BMFF demuxer for DXV-in-mov files.
//
// Builds a flat per-frame table from a byte buffer that contains (at minimum)
// the `moov` atom. Callers can pass the whole file, just the moov region, or
// a tail-of-file slice — anywhere moov appears within the buffer is fine.
//
// All offsets in the resulting frame table are absolute file offsets, i.e.
// what `stco` / `co64` records. The host slices the source File/Blob with
// these offsets to pull individual frame payloads.

#include <cstdint>

namespace dxv {

struct FrameEntry {
    uint64_t offset;
    uint32_t size;
};

struct ParseResult {
    int      ok;            // 1 on success, 0 on failure
    uint32_t width;
    uint32_t height;
    uint32_t fourcc;        // e.g. 'DXD3' stored as the LE32 of the ASCII (DXV/Resolume convention)
    uint32_t frame_count;
    FrameEntry* frames;     // owned by Demuxer; valid until reset()
};

class Demuxer {
public:
    Demuxer();
    ~Demuxer();

    /// Parse `bytes`. On success, `result.frames` is valid until the next
    /// parse() or reset() call.
    ParseResult parse(const uint8_t* bytes, uint32_t length);

    void reset();

    const FrameEntry* frames() const { return m_frames; }
    uint32_t frame_count() const { return m_frame_count; }
    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }
    uint32_t fourcc() const { return m_fourcc; }

private:
    FrameEntry* m_frames = nullptr;
    uint32_t m_frame_count = 0;
    uint32_t m_capacity = 0;
    uint32_t m_width = 0;
    uint32_t m_height = 0;
    uint32_t m_fourcc = 0;
};

} // namespace dxv
