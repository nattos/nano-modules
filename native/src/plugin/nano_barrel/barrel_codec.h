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
#include <cstring>
#include <string>

#include <nlohmann/json.hpp>

#include "miniz.h"

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

// -- zlib (RFC 1950) compress/uncompress via vendored miniz ------------
// The sketch is the bulk of the config; compressing it cuts the FILE-param
// value (which Resolume re-broadcasts on every clip trigger) by ~2/3. Returns
// "" on failure so callers can fall back to the uncompressed form.
inline std::string zlib_compress(const std::string& in) {
  mz_ulong bound = mz_compressBound((mz_ulong)in.size());
  std::string out(bound, '\0');
  mz_ulong outlen = bound;
  int rc = mz_compress2(reinterpret_cast<unsigned char*>(&out[0]), &outlen,
                        reinterpret_cast<const unsigned char*>(in.data()),
                        (mz_ulong)in.size(), MZ_BEST_COMPRESSION);
  if (rc != MZ_OK) return "";
  out.resize(outlen);
  return out;
}

inline std::string zlib_uncompress(const std::string& in) {
  if (in.empty()) return "";
  // Decompressed size isn't stored in the stream — grow the buffer until it fits.
  size_t cap = in.size() * 4 + 64;
  for (int attempt = 0; attempt < 24; ++attempt) {
    std::string out(cap, '\0');
    mz_ulong outlen = (mz_ulong)cap;
    int rc = mz_uncompress(reinterpret_cast<unsigned char*>(&out[0]), &outlen,
                           reinterpret_cast<const unsigned char*>(in.data()),
                           (mz_ulong)in.size());
    if (rc == MZ_OK) { out.resize(outlen); return out; }
    if (rc == MZ_BUF_ERROR) { cap *= 2; continue; }  // buffer too small — grow
    return "";                                       // corrupt / not zlib
  }
  return "";
}

// -- Wrapper format ----------------------------------------------------
// NEW:    "nanobarrel://config?<uuid>~<base64(zlib(sketch_json))>"
// LEGACY: "nanobarrel://config?<base64(json{uuid,sketch})>"
//
// The uuid rides as PLAINTEXT ahead of the '~' so the InstanceLocator's de-dup
// pass reads identity WITHOUT decompressing (config_uuid); only a full load
// inflates the sketch. wrap/unwrap still speak the {uuid,sketch} ENVELOPE so
// their callers (barrel plugin, fork writer) are unchanged — only the on-wire
// bytes differ. '~' is in neither the base64 nor the uuid alphabet, so its
// presence unambiguously distinguishes the new form from the legacy base64 JSON.
constexpr const char* kConfigPrefix = "nanobarrel://config?";
constexpr char kUuidSep = '~';

// Split an envelope {uuid, sketch} JSON into its parts. A bare sketch (no
// envelope) is tolerated: uuid stays empty, sketch_json is the whole input.
inline void split_envelope(const std::string& env_json, std::string& uuid,
                           std::string& sketch_json) {
  uuid.clear();
  auto env = nlohmann::json::parse(env_json, nullptr, false);
  if (env.is_object()) {
    if (auto u = env.find("uuid"); u != env.end() && u->is_string())
      uuid = u->get<std::string>();
    if (auto s = env.find("sketch"); s != env.end()) { sketch_json = s->dump(); return; }
  }
  sketch_json = env_json;
}

inline std::string wrap_config(const std::string& envelope_json) {
  std::string uuid, sketch_json;
  split_envelope(envelope_json, uuid, sketch_json);
  std::string z = zlib_compress(sketch_json);
  // uuid must not contain the separator (uuids never do); guard anyway so a
  // stray value can't corrupt the frame — fall back to the legacy form.
  if (z.empty() || uuid.find(kUuidSep) != std::string::npos)
    return std::string(kConfigPrefix) + base64_encode(envelope_json);
  return std::string(kConfigPrefix) + uuid + kUuidSep + base64_encode(z);
}

// Read the barrel uuid WITHOUT decompressing — the de-dup hot path. "" if none.
inline std::string config_uuid(const std::string& wrapped) {
  size_t plen = std::strlen(kConfigPrefix);
  if (wrapped.size() < plen || wrapped.compare(0, plen, kConfigPrefix) != 0) return "";
  std::string payload = wrapped.substr(plen);
  size_t sep = payload.find(kUuidSep);
  if (sep != std::string::npos) return payload.substr(0, sep);  // new form
  // legacy: base64 JSON envelope — decode (no decompress) + read uuid.
  auto env = nlohmann::json::parse(base64_decode(payload), nullptr, false);
  if (env.is_object())
    if (auto u = env.find("uuid"); u != env.end() && u->is_string())
      return u->get<std::string>();
  return "";
}

// Unwrap to the {uuid, sketch} ENVELOPE JSON (both formats). "" on failure.
inline std::string unwrap_config(const std::string& wrapped) {
  size_t plen = std::strlen(kConfigPrefix);
  if (wrapped.size() < plen || wrapped.compare(0, plen, kConfigPrefix) != 0) return "";
  std::string payload = wrapped.substr(plen);
  size_t sep = payload.find(kUuidSep);
  if (sep == std::string::npos)
    return base64_decode(payload);  // legacy: already the envelope JSON
  std::string uuid = payload.substr(0, sep);
  std::string sketch_json = zlib_uncompress(base64_decode(payload.substr(sep + 1)));
  nlohmann::json sketch = nlohmann::json::parse(sketch_json, nullptr, false);
  if (sketch.is_discarded()) sketch = nlohmann::json::object();
  nlohmann::json env = {{"uuid", uuid}, {"sketch", std::move(sketch)}};
  return env.dump();
}

}  // namespace barrel_codec
