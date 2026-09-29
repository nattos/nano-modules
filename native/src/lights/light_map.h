// light_map.h — pixel mapping for LIGHT devices: a composed frame → DMX.
//
// The arrangement page resolves its light library (types, rigs, the show's
// per-slot layout) into a flat PLAN and hands it to the compositor
// (`comp_lights`). Everything a machine knows about its lights arrives already
// resolved: each fixture is an address plus one footprint per pixel, in
// normalized frame coordinates (0,0 = top-left). Nothing here knows what a rig
// or a type is — and nothing here touches a socket or the GPU:
//
//   readback (RGBA8)  ──sampleFootprints──▶  colours  ──encodeFixture──▶  DMX
//                                             ▲
//                              patternColor ──┘ (identify / test patterns)
//
// Pure and header-only so the goldens in test_light_map.cpp pin it without a
// GPU, and the comp host (CompHost's light runner) runs exactly this.

#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <map>
#include <string>
#include <tuple>
#include <vector>

#include <nlohmann/json.hpp>

namespace lights {

constexpr int kUniverseSize = 512;

/// Channel layout per pixel. Lock-step: web/src/lights/light-types.ts LightFormat.
enum class Format { RGB, GRB, BGR, RGBW, GRBW };

inline Format parseFormat(const std::string& s) {
  if (s == "grb") return Format::GRB;
  if (s == "bgr") return Format::BGR;
  if (s == "rgbw") return Format::RGBW;
  if (s == "grbw") return Format::GRBW;
  return Format::RGB;
}

inline int channelsPerPixel(Format f) {
  return f == Format::RGBW || f == Format::GRBW ? 4 : 3;
}

struct Rgb {
  float r = 0, g = 0, b = 0;
  bool operator==(const Rgb& o) const { return r == o.r && g == o.g && b == o.b; }
};

/// One physical fixture (a rig slot): an address and a footprint per pixel.
struct Fixture {
  std::string slotId;
  int universe = 0;          // 15-bit Art-Net port address (net:subnet:universe)
  int channel = 1;           // 1-based start channel, as a desk shows it
  std::string dest = "broadcast";  // 'broadcast' | ip | ip:port
  Format format = Format::RGB;
  float gamma = 1.0f;
  std::vector<std::array<float, 4>> footprints;  // u0, v0, u1, v1 per pixel
};

/// One placed light device in the show.
struct Output {
  std::string placementId;
  bool enabled = true;
  std::vector<Fixture> fixtures;
};

struct Plan {
  std::vector<Output> outputs;
  bool anyEnabled() const {
    for (const auto& o : outputs) {
      if (o.enabled && !o.fixtures.empty()) return true;
    }
    return false;
  }
};

/// The page's plan JSON (light-plan.ts buildLightPlan). Malformed entries are
/// skipped, never fatal: a bad plan means dark lights, not a dead compositor.
inline Plan parsePlan(const nlohmann::json& j) {
  Plan plan;
  if (!j.is_object() || !j.contains("outputs") || !j["outputs"].is_array()) return plan;
  for (const auto& oj : j["outputs"]) {
    if (!oj.is_object()) continue;
    Output o;
    o.placementId = oj.value("placementId", std::string());
    o.enabled = oj.value("enabled", true);
    if (o.placementId.empty()) continue;
    if (oj.contains("fixtures") && oj["fixtures"].is_array()) {
      for (const auto& fj : oj["fixtures"]) {
        if (!fj.is_object()) continue;
        Fixture f;
        f.slotId = fj.value("slotId", std::string());
        f.universe = std::clamp(fj.value("universe", 0), 0, 0x7fff);
        f.channel = std::clamp(fj.value("channel", 1), 1, kUniverseSize);
        f.dest = fj.value("dest", std::string("broadcast"));
        f.format = parseFormat(fj.value("format", std::string("rgb")));
        f.gamma = std::clamp(fj.value("gamma", 1.0f), 0.1f, 5.0f);
        if (fj.contains("footprints") && fj["footprints"].is_array()) {
          for (const auto& p : fj["footprints"]) {
            if (!p.is_array() || p.size() != 4) continue;
            f.footprints.push_back({p[0].get<float>(), p[1].get<float>(),
                                    p[2].get<float>(), p[3].get<float>()});
          }
        }
        o.fixtures.push_back(std::move(f));
      }
    }
    plan.outputs.push_back(std::move(o));
  }
  return plan;
}

/// The smallest footprint side across enabled outputs (normalized), so the
/// runner can size its readback: a footprint must span a couple of texels or
/// the box average degenerates into a point sample. 1 when there is none.
inline float smallestFootprint(const Plan& plan) {
  float m = 1.0f;
  for (const auto& o : plan.outputs) {
    if (!o.enabled) continue;
    for (const auto& f : o.fixtures) {
      for (const auto& p : f.footprints) {
        m = std::min(m, std::max(1e-4f, std::min(std::fabs(p[2] - p[0]), std::fabs(p[3] - p[1]))));
      }
    }
  }
  return m;
}

/// Box-average each footprint of an RGBA8 image (row 0 = top). Texels whose
/// CENTRES fall inside the footprint count; a footprint too small to hold one
/// takes the texel under its centre. Values are the frame's own (sRGB-encoded)
/// 0..1 — gamma is the fixture's, applied at encode.
inline std::vector<Rgb> sampleFootprints(const uint8_t* rgba, int w, int h, const Fixture& f) {
  std::vector<Rgb> out(f.footprints.size());
  if (!rgba || w <= 0 || h <= 0) return out;
  for (size_t i = 0; i < f.footprints.size(); i++) {
    const auto& p = f.footprints[i];
    const float u0 = std::min(p[0], p[2]) * w, u1 = std::max(p[0], p[2]) * w;
    const float v0 = std::min(p[1], p[3]) * h, v1 = std::max(p[1], p[3]) * h;
    int x0 = (int)std::ceil(u0 - 0.5f), x1 = (int)std::floor(u1 - 0.5f);
    int y0 = (int)std::ceil(v0 - 0.5f), y1 = (int)std::floor(v1 - 0.5f);
    if (x1 < x0) x0 = x1 = (int)std::floor((u0 + u1) * 0.5f);
    if (y1 < y0) y0 = y1 = (int)std::floor((v0 + v1) * 0.5f);
    x0 = std::clamp(x0, 0, w - 1); x1 = std::clamp(x1, 0, w - 1);
    y0 = std::clamp(y0, 0, h - 1); y1 = std::clamp(y1, 0, h - 1);
    double r = 0, g = 0, b = 0;
    int n = 0;
    for (int y = y0; y <= y1; y++) {
      const uint8_t* row = rgba + (size_t)y * (size_t)w * 4;
      for (int x = x0; x <= x1; x++) {
        r += row[x * 4 + 0]; g += row[x * 4 + 1]; b += row[x * 4 + 2];
        n++;
      }
    }
    if (n > 0) out[i] = {(float)(r / n / 255.0), (float)(g / n / 255.0), (float)(b / n / 255.0)};
  }
  return out;
}

/// DMX frames being assembled: (dest, universe) → 512 channels.
using UniverseKey = std::pair<std::string, int>;
using Frames = std::map<UniverseKey, std::array<uint8_t, kUniverseSize>>;

inline uint8_t toByte(float v, float gamma) {
  v = std::clamp(v, 0.0f, 1.0f);
  if (gamma != 1.0f) v = std::pow(v, gamma);
  return (uint8_t)std::lround(v * 255.0f);
}

/// Write one fixture's colours into its universe. Pixels that would run past
/// channel 512 are dropped (the page warns about the address, it never spills
/// into the next universe). RGBW takes white out of the colour: w = min(r,g,b).
inline void encodeFixture(const Fixture& f, const std::vector<Rgb>& colors, Frames& frames) {
  auto& u = frames[{f.dest, f.universe}];  // value-initialised: all zero
  const int cpp = channelsPerPixel(f.format);
  for (size_t i = 0; i < colors.size(); i++) {
    const int base = f.channel - 1 + (int)i * cpp;
    if (base + cpp > kUniverseSize) break;
    const uint8_t R = toByte(colors[i].r, f.gamma);
    const uint8_t G = toByte(colors[i].g, f.gamma);
    const uint8_t B = toByte(colors[i].b, f.gamma);
    switch (f.format) {
      case Format::RGB: u[base] = R; u[base + 1] = G; u[base + 2] = B; break;
      case Format::GRB: u[base] = G; u[base + 1] = R; u[base + 2] = B; break;
      case Format::BGR: u[base] = B; u[base + 1] = G; u[base + 2] = R; break;
      case Format::RGBW:
      case Format::GRBW: {
        const uint8_t W = std::min({R, G, B});
        const uint8_t r = (uint8_t)(R - W), g = (uint8_t)(G - W), b = (uint8_t)(B - W);
        if (f.format == Format::RGBW) { u[base] = r; u[base + 1] = g; u[base + 2] = b; }
        else { u[base] = g; u[base + 1] = r; u[base + 2] = b; }
        u[base + 3] = W;
        break;
      }
    }
  }
}

// ── Identify + test patterns ────────────────────────────────────────────────
//
// Transient: they replace a light's sampled colours while active and are never
// saved. Colours are pre-gamma like sampled ones (so white is full on).

enum class Pattern { None, Off, White, Colors, Chase, Numbers, Bars, Identify };

inline Pattern parsePattern(const std::string& s) {
  if (s == "off") return Pattern::Off;
  if (s == "white") return Pattern::White;
  if (s == "colors") return Pattern::Colors;
  if (s == "chase") return Pattern::Chase;
  if (s == "numbers") return Pattern::Numbers;
  if (s == "bars") return Pattern::Bars;
  if (s == "identify") return Pattern::Identify;
  return Pattern::None;
}

/// A pattern's colour for pixel `px` of `count` in slot `slot` (of `slots`)
/// at time `t` (seconds since it started).
///   colors   — the whole light steps red → green → blue → white, 1 s each;
///   chase    — one dot runs along every slot, 12 px/s;
///   numbers  — slot k lights its first k+1 pixels (which bar is which);
///   bars     — one slot at a time, in rig order, kBarSec each (where each
///              bar hangs, and in what order);
///   identify — a dot walks the slot, pixel 0 held red (so direction shows).
constexpr double kBarSec = 0.75;

inline Rgb patternColor(Pattern p, int slot, int slots, int px, int count, double t) {
  static const Rgb kWhite{1, 1, 1}, kBlack{0, 0, 0}, kRed{1, 0, 0};
  switch (p) {
    case Pattern::None:
    case Pattern::Off: return kBlack;
    case Pattern::White: return kWhite;
    case Pattern::Colors: {
      static const Rgb kSteps[4] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}, {1, 1, 1}};
      return kSteps[(int64_t)std::floor(std::max(0.0, t)) % 4];
    }
    case Pattern::Chase:
    case Pattern::Identify: {
      if (count <= 0) return kBlack;
      const int at = (int)((int64_t)std::floor(std::max(0.0, t) * 12.0) % count);
      if (p == Pattern::Identify && px == 0) return kRed;
      return px == at ? kWhite : kBlack;
    }
    case Pattern::Numbers: return px <= slot ? kWhite : kBlack;
    case Pattern::Bars: {
      if (slots <= 0) return kBlack;
      const int at = (int)((int64_t)std::floor(std::max(0.0, t) / kBarSec) % slots);
      return slot == at ? kWhite : kBlack;
    }
  }
  return kBlack;
}

}  // namespace lights
