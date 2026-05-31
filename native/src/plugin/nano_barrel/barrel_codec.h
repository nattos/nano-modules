// barrel_codec.h — header-only base64 encode/decode for wrapping a
// sketch config JSON payload inside the FF_TYPE_FILE param string.
//
// Probe 3 showed Resolume persists FILE param values intact up to 16 MB
// as long as the string contains no newlines and looks pathy. We wrap
// in `nanobarrel://config?<base64>` so:
//   - the prefix triggers Resolume's "FILE" widget rendering (no chug),
//   - base64 contains no newlines / null bytes / quotes,
//   - a human reading the composition file sees a recognizable scheme.

#pragma once

#include <cstdint>
#include <string>

namespace barrel_codec {

inline const char* b64_alphabet() {
  return "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
}

inline std::string base64_encode(const std::string& data) {
  const char* alpha = b64_alphabet();
  std::string out;
  out.reserve(((data.size() + 2) / 3) * 4);
  size_t i = 0;
  for (; i + 3 <= data.size(); i += 3) {
    uint32_t v = ((uint8_t)data[i] << 16) | ((uint8_t)data[i + 1] << 8) | (uint8_t)data[i + 2];
    out += alpha[(v >> 18) & 0x3f];
    out += alpha[(v >> 12) & 0x3f];
    out += alpha[(v >> 6) & 0x3f];
    out += alpha[v & 0x3f];
  }
  if (i < data.size()) {
    uint32_t v = (uint8_t)data[i] << 16;
    if (i + 1 < data.size()) v |= (uint8_t)data[i + 1] << 8;
    out += alpha[(v >> 18) & 0x3f];
    out += alpha[(v >> 12) & 0x3f];
    if (i + 1 < data.size()) {
      out += alpha[(v >> 6) & 0x3f];
      out += '=';
    } else {
      out += "==";
    }
  }
  return out;
}

inline int b64_decode_char(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

inline std::string base64_decode(const std::string& data) {
  std::string out;
  out.reserve((data.size() / 4) * 3);
  uint32_t buf = 0;
  int bits = 0;
  for (char c : data) {
    if (c == '=' || c == ' ' || c == '\n' || c == '\r' || c == '\t') continue;
    int v = b64_decode_char(c);
    if (v < 0) continue;
    buf = (buf << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += (char)((buf >> bits) & 0xff);
    }
  }
  return out;
}

// -- Wrapper format ----------------------------------------------------
// Output:  "nanobarrel://config?<base64-encoded-json>"
// Input:   any of the above; returns the decoded JSON or "" on failure.
constexpr const char* kConfigPrefix = "nanobarrel://config?";

inline std::string wrap_config(const std::string& json) {
  return std::string(kConfigPrefix) + base64_encode(json);
}

inline std::string unwrap_config(const std::string& wrapped) {
  size_t plen = strlen(kConfigPrefix);
  if (wrapped.size() < plen) return "";
  if (wrapped.compare(0, plen, kConfigPrefix) != 0) return "";
  return base64_decode(wrapped.substr(plen));
}

}  // namespace barrel_codec
