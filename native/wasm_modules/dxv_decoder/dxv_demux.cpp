#include "dxv_demux.h"
#include <cstdlib>
#include <cstring>

namespace dxv {

namespace {

// Big-endian readers. QuickTime / ISO-BMFF is BE for all box fields.
static inline uint16_t be16(const uint8_t* p) { return (uint32_t(p[0]) << 8) | p[1]; }
static inline uint32_t be32(const uint8_t* p) {
    return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16)
         | (uint32_t(p[2]) << 8)  |  uint32_t(p[3]);
}
static inline uint64_t be64(const uint8_t* p) {
    return (uint64_t(be32(p)) << 32) | be32(p + 4);
}

// FourCC as the 4 ASCII bytes packed BE — matches the on-wire box type.
static constexpr uint32_t fourcc(const char a, const char b, const char c, const char d) {
    return (uint32_t(uint8_t(a)) << 24)
         | (uint32_t(uint8_t(b)) << 16)
         | (uint32_t(uint8_t(c)) << 8)
         |  uint32_t(uint8_t(d));
}

// Codec FourCCs are conventionally stored LE in field-level identifiers
// (e.g. the DXV per-frame "DXT1" header), but in stsd's sample-entry slot
// the on-wire bytes are still ASCII order. We return the LE32 here for
// JS-side convenience — that's what `fourCCFromString` in the TS wrapper
// expects.
static inline uint32_t fourcc_le(const uint8_t* p) {
    return (uint32_t(p[3]) << 24) | (uint32_t(p[2]) << 16)
         | (uint32_t(p[1]) << 8)  |  uint32_t(p[0]);
}

constexpr uint32_t BOX_MOOV = fourcc('m', 'o', 'o', 'v');
constexpr uint32_t BOX_TRAK = fourcc('t', 'r', 'a', 'k');
constexpr uint32_t BOX_MDIA = fourcc('m', 'd', 'i', 'a');
constexpr uint32_t BOX_MINF = fourcc('m', 'i', 'n', 'f');
constexpr uint32_t BOX_STBL = fourcc('s', 't', 'b', 'l');
constexpr uint32_t BOX_HDLR = fourcc('h', 'd', 'l', 'r');
constexpr uint32_t BOX_STSD = fourcc('s', 't', 's', 'd');
constexpr uint32_t BOX_STSC = fourcc('s', 't', 's', 'c');
constexpr uint32_t BOX_STSZ = fourcc('s', 't', 's', 'z');
constexpr uint32_t BOX_STCO = fourcc('s', 't', 'c', 'o');
constexpr uint32_t BOX_CO64 = fourcc('c', 'o', '6', '4');
constexpr uint32_t HDLR_VIDE = fourcc('v', 'i', 'd', 'e');

struct Box {
    uint64_t size;      // total size including header
    uint32_t type;
    uint32_t header_size;
    const uint8_t* body;
    uint32_t body_size;
};

// Returns 0 on success and advances *p past the box. On failure (truncated
// header / size==0 sentinel at non-EOF / runaway size) returns -1.
static int read_box(const uint8_t** p, const uint8_t* end, Box& out) {
    if (*p + 8 > end) return -1;
    uint32_t size = be32(*p);
    uint32_t type = be32(*p + 4);
    uint32_t hdr = 8;
    uint64_t total;
    if (size == 1) {
        if (*p + 16 > end) return -1;
        total = be64(*p + 8);
        hdr = 16;
    } else if (size == 0) {
        // Extends to EOF — treat as "rest of buffer".
        total = uint64_t(end - *p);
    } else {
        total = size;
    }
    if (total < hdr) return -1;
    if (uint64_t(*p - (*p - 0)) > 0) {} // appease unused-var warnings
    if (*p + total > end) {
        // Truncated; clamp to end (mdat is often the last box and we may
        // have been handed only moov-tail bytes).
        total = uint64_t(end - *p);
    }
    out.size = total;
    out.type = type;
    out.header_size = hdr;
    out.body = *p + hdr;
    out.body_size = uint32_t(total - hdr);
    *p += total;
    return 0;
}

struct StblTables {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t fourcc = 0;

    // stsc: array of (first_chunk, samples_per_chunk, desc_index)
    uint32_t stsc_count = 0;
    const uint8_t* stsc_data = nullptr;

    // stsz: array of u32 sample sizes. If sample_size != 0, all samples have
    // that size and `stsz_data` is null.
    uint32_t stsz_sample_size = 0;
    uint32_t stsz_count = 0;
    const uint8_t* stsz_data = nullptr;

    // chunk offsets: either stco (u32) or co64 (u64)
    bool co64 = false;
    uint32_t chunk_count = 0;
    const uint8_t* chunk_data = nullptr;
};

static int parse_stsd(const uint8_t* body, uint32_t body_size, StblTables& t) {
    // version(1) + flags(3) + entry_count(4) = 8 bytes header
    if (body_size < 16) return -1;
    uint32_t entry_count = be32(body + 4);
    if (entry_count == 0) return -1;
    // Walk just the first entry (video tracks have one).
    const uint8_t* p = body + 8;
    const uint8_t* end = body + body_size;
    if (p + 8 > end) return -1;
    uint32_t entry_size = be32(p);
    uint32_t format = be32(p + 4);
    if (entry_size < 8 || p + entry_size > end) return -1;
    t.fourcc = fourcc_le(p + 4);
    (void)format;
    // VisualSampleEntry layout (offsets from entry start):
    //   8 reserved+ref bytes, 16 pre_defined/reserved, then width@32 + height@34.
    if (entry_size < 36) return -1;
    t.width  = be16(p + 32);
    t.height = be16(p + 34);
    return 0;
}

static int parse_stsc(const uint8_t* body, uint32_t body_size, StblTables& t) {
    if (body_size < 8) return -1;
    uint32_t entry_count = be32(body + 4);
    if (uint64_t(8) + uint64_t(entry_count) * 12 > body_size) return -1;
    t.stsc_count = entry_count;
    t.stsc_data = body + 8;
    return 0;
}

static int parse_stsz(const uint8_t* body, uint32_t body_size, StblTables& t) {
    if (body_size < 12) return -1;
    uint32_t sample_size  = be32(body + 4);
    uint32_t sample_count = be32(body + 8);
    if (sample_size == 0) {
        if (uint64_t(12) + uint64_t(sample_count) * 4 > body_size) return -1;
        t.stsz_data = body + 12;
    } else {
        t.stsz_data = nullptr;
    }
    t.stsz_sample_size = sample_size;
    t.stsz_count = sample_count;
    return 0;
}

static int parse_stco(const uint8_t* body, uint32_t body_size, StblTables& t,
                      bool is_co64) {
    if (body_size < 8) return -1;
    uint32_t count = be32(body + 4);
    uint32_t entry_bytes = is_co64 ? 8 : 4;
    if (uint64_t(8) + uint64_t(count) * entry_bytes > body_size) return -1;
    t.co64 = is_co64;
    t.chunk_count = count;
    t.chunk_data = body + 8;
    return 0;
}

static int walk_stbl(const uint8_t* body, uint32_t body_size, StblTables& t) {
    const uint8_t* p = body;
    const uint8_t* end = body + body_size;
    while (p < end) {
        Box b;
        if (read_box(&p, end, b) < 0) return -1;
        switch (b.type) {
            case BOX_STSD: if (parse_stsd(b.body, b.body_size, t) < 0) return -1; break;
            case BOX_STSC: if (parse_stsc(b.body, b.body_size, t) < 0) return -1; break;
            case BOX_STSZ: if (parse_stsz(b.body, b.body_size, t) < 0) return -1; break;
            case BOX_STCO: if (parse_stco(b.body, b.body_size, t, false) < 0) return -1; break;
            case BOX_CO64: if (parse_stco(b.body, b.body_size, t, true)  < 0) return -1; break;
            default: break;
        }
    }
    return 0;
}

// Walk a `mdia` body; returns 1 if this is a video track (and fills `t`),
// 0 if non-video (skip), -1 on parse error.
static int walk_mdia(const uint8_t* body, uint32_t body_size, StblTables& t) {
    const uint8_t* p = body;
    const uint8_t* end = body + body_size;
    bool is_video = false;
    bool stbl_done = false;
    while (p < end) {
        Box b;
        if (read_box(&p, end, b) < 0) return -1;
        if (b.type == BOX_HDLR) {
            // version+flags(4) + pre_defined(4) + handler_type(4)
            if (b.body_size < 12) return -1;
            uint32_t handler = be32(b.body + 8);
            if (handler == HDLR_VIDE) is_video = true;
        } else if (b.type == BOX_MINF) {
            // Recurse into minf → stbl.
            const uint8_t* mp = b.body;
            const uint8_t* mend = b.body + b.body_size;
            while (mp < mend) {
                Box mb;
                if (read_box(&mp, mend, mb) < 0) return -1;
                if (mb.type == BOX_STBL) {
                    if (walk_stbl(mb.body, mb.body_size, t) < 0) return -1;
                    stbl_done = true;
                }
            }
        }
    }
    if (!is_video) return 0;
    if (!stbl_done) return -1;
    return 1;
}

// Walk a `moov` body, find the first video track, return its tables.
static int walk_moov(const uint8_t* body, uint32_t body_size, StblTables& t) {
    const uint8_t* p = body;
    const uint8_t* end = body + body_size;
    while (p < end) {
        Box b;
        if (read_box(&p, end, b) < 0) return -1;
        if (b.type != BOX_TRAK) continue;
        // Scan trak's children for mdia.
        const uint8_t* tp = b.body;
        const uint8_t* tend = b.body + b.body_size;
        while (tp < tend) {
            Box tb;
            if (read_box(&tp, tend, tb) < 0) return -1;
            if (tb.type != BOX_MDIA) continue;
            int r = walk_mdia(tb.body, tb.body_size, t);
            if (r < 0) return -1;
            if (r == 1) return 0;   // got a video track
        }
    }
    return -1; // no video track
}

} // namespace

Demuxer::Demuxer() = default;
Demuxer::~Demuxer() { reset(); }

void Demuxer::reset() {
    if (m_frames) {
        std::free(m_frames);
        m_frames = nullptr;
    }
    m_frame_count = 0;
    m_capacity = 0;
    m_width = m_height = m_fourcc = 0;
}

ParseResult Demuxer::parse(const uint8_t* bytes, uint32_t length) {
    reset();
    ParseResult r{};
    if (!bytes || length < 16) return r;

    // Walk the top-level boxes until we find `moov`.
    const uint8_t* p = bytes;
    const uint8_t* end = bytes + length;
    StblTables t;
    bool found_moov = false;
    while (p < end) {
        Box b;
        if (read_box(&p, end, b) < 0) break;
        if (b.type == BOX_MOOV) {
            if (walk_moov(b.body, b.body_size, t) == 0) {
                found_moov = true;
            }
            break;
        }
    }
    if (!found_moov) return r;

    // Build the per-sample frame table by walking stsc + chunk offsets +
    // stsz. Each stsc entry RLE-encodes a range of chunks that share the
    // same samples-per-chunk count. The last entry runs to chunk_count.
    if (t.chunk_count == 0 || t.stsz_count == 0 || t.stsc_count == 0) return r;

    m_capacity = t.stsz_count;
    m_frames = static_cast<FrameEntry*>(std::malloc(sizeof(FrameEntry) * m_capacity));
    if (!m_frames) return r;

    auto chunk_offset = [&](uint32_t i) -> uint64_t {
        if (t.co64) return be64(t.chunk_data + uint64_t(i) * 8);
        return uint64_t(be32(t.chunk_data + uint64_t(i) * 4));
    };
    auto sample_size = [&](uint32_t i) -> uint32_t {
        if (!t.stsz_data) return t.stsz_sample_size;
        return be32(t.stsz_data + uint64_t(i) * 4);
    };

    uint32_t sample_idx = 0;
    for (uint32_t e = 0; e < t.stsc_count && sample_idx < t.stsz_count; e++) {
        uint32_t first_chunk      = be32(t.stsc_data + e * 12 + 0);
        uint32_t samples_per_chunk = be32(t.stsc_data + e * 12 + 4);
        uint32_t next_first_chunk = (e + 1 < t.stsc_count)
            ? be32(t.stsc_data + (e + 1) * 12 + 0)
            : t.chunk_count + 1;
        if (first_chunk < 1 || first_chunk > t.chunk_count) break;
        uint32_t hi = (next_first_chunk - 1);
        if (hi > t.chunk_count) hi = t.chunk_count;
        for (uint32_t c = first_chunk; c <= hi && sample_idx < t.stsz_count; c++) {
            uint64_t base = chunk_offset(c - 1);
            uint64_t running = 0;
            for (uint32_t s = 0; s < samples_per_chunk && sample_idx < t.stsz_count; s++) {
                uint32_t sz = sample_size(sample_idx);
                m_frames[sample_idx].offset = base + running;
                m_frames[sample_idx].size   = sz;
                running += sz;
                sample_idx++;
            }
        }
    }

    m_frame_count = sample_idx;
    m_width  = t.width;
    m_height = t.height;
    m_fourcc = t.fourcc;

    r.ok = 1;
    r.width = m_width;
    r.height = m_height;
    r.fourcc = m_fourcc;
    r.frame_count = m_frame_count;
    r.frames = m_frames;
    return r;
}

} // namespace dxv
