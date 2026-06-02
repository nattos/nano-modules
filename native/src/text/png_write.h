#pragma once
/*
 * png_write.h — tiny, dependency-free RGBA8 PNG writer (header-only).
 *
 * Emits a valid PNG using uncompressed ("stored") zlib/DEFLATE blocks — no
 * libz, no exceptions, compiles under wasm32-wasip1 and native. Used by the
 * text engine's reference-rasterizer tooling to dump real pixels to disk for
 * inspection and e2e-style golden artifacts. Not size-optimized (stored blocks
 * are large); fine for test dumps.
 */

#include <cstdint>
#include <cstdio>
#include <vector>

namespace png_write {

inline uint32_t crc32_(const uint8_t* p, size_t n, uint32_t crc = 0) {
  crc = ~crc;
  for (size_t i = 0; i < n; i++) {
    crc ^= p[i];
    for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (~(crc & 1) + 1));
  }
  return ~crc;
}

inline void put32(std::vector<uint8_t>& v, uint32_t x) {
  v.push_back((x >> 24) & 0xFF); v.push_back((x >> 16) & 0xFF);
  v.push_back((x >> 8) & 0xFF);  v.push_back(x & 0xFF);
}

inline void chunk(std::vector<uint8_t>& out, const char* tag,
                  const std::vector<uint8_t>& data) {
  put32(out, (uint32_t)data.size());
  size_t crcStart = out.size();
  out.insert(out.end(), tag, tag + 4);
  out.insert(out.end(), data.begin(), data.end());
  uint32_t crc = crc32_(out.data() + crcStart, out.size() - crcStart);
  put32(out, crc);
}

// Encode w*h RGBA8 (`rgba`, row-major, stride w*4) as a PNG byte vector.
inline std::vector<uint8_t> encode(const uint8_t* rgba, int w, int h) {
  // Raw scanlines with filter byte 0 prefixed per row.
  std::vector<uint8_t> raw;
  raw.reserve((size_t)h * (1 + w * 4));
  for (int y = 0; y < h; y++) {
    raw.push_back(0);
    raw.insert(raw.end(), rgba + (size_t)y * w * 4, rgba + (size_t)(y + 1) * w * 4);
  }

  // zlib wrapper around stored DEFLATE blocks.
  std::vector<uint8_t> z;
  z.push_back(0x78); z.push_back(0x01);           // CMF, FLG
  size_t off = 0;
  while (off < raw.size()) {
    size_t n = raw.size() - off;
    if (n > 65535) n = 65535;
    bool last = (off + n >= raw.size());
    z.push_back(last ? 1 : 0);                     // BFINAL, BTYPE=00 (stored)
    z.push_back(n & 0xFF); z.push_back((n >> 8) & 0xFF);
    uint16_t nlen = ~(uint16_t)n;
    z.push_back(nlen & 0xFF); z.push_back((nlen >> 8) & 0xFF);
    z.insert(z.end(), raw.begin() + off, raw.begin() + off + n);
    off += n;
  }
  // Adler-32 of raw.
  uint32_t a = 1, b = 0;
  for (uint8_t c : raw) { a = (a + c) % 65521; b = (b + a) % 65521; }
  uint32_t adler = (b << 16) | a;
  z.push_back((adler >> 24) & 0xFF); z.push_back((adler >> 16) & 0xFF);
  z.push_back((adler >> 8) & 0xFF);  z.push_back(adler & 0xFF);

  std::vector<uint8_t> out = {137, 80, 78, 71, 13, 10, 26, 10};
  std::vector<uint8_t> ihdr;
  put32(ihdr, (uint32_t)w); put32(ihdr, (uint32_t)h);
  ihdr.push_back(8);   // bit depth
  ihdr.push_back(6);   // color type RGBA
  ihdr.push_back(0); ihdr.push_back(0); ihdr.push_back(0);
  chunk(out, "IHDR", ihdr);
  chunk(out, "IDAT", z);
  chunk(out, "IEND", {});
  return out;
}

inline bool writeFile(const char* path, const uint8_t* rgba, int w, int h) {
  std::vector<uint8_t> png = encode(rgba, w, h);
  FILE* f = std::fopen(path, "wb");
  if (!f) return false;
  size_t wrote = std::fwrite(png.data(), 1, png.size(), f);
  std::fclose(f);
  return wrote == png.size();
}

} // namespace png_write
