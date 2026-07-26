#include "frame_blitter.h"

#include <algorithm>
#include <cmath>

#include "gpu/gpu_backend.h"

namespace nano_media {
namespace {

/// The MSL twin of frame-blitter.ts's BLIT_SHADER. Web runs it as a
/// full-screen-triangle fragment pass; here it's a compute kernel, which lands
/// on the same pixel centres: the fragment's interpolated uv at pixel p is
/// (p + 0.5)/size, and `gid` addresses the same top-left-origin grid.
constexpr const char* kBlitMSL = R"MSL(
// nano_threadgroup: 8 8 1
#include <metal_stdlib>
using namespace metal;

struct Place { float4 rect; float4 rotFlip; };

kernel void frame_blit(texture2d<float, access::sample> src [[texture(0)]],
                       texture2d<float, access::write>  dst [[texture(1)]],
                       constant Place& place [[buffer(0)]],
                       uint2 gid [[thread_position_in_grid]]) {
  const uint w = dst.get_width();
  const uint h = dst.get_height();
  if (gid.x >= w || gid.y >= h) return;
  const float2 uv = (float2(gid) + 0.5f) / float2(w, h);
  const float2 r = (uv - place.rect.xy) / place.rect.zw;   // rect-local [0,1]
  const int rot = int(place.rotFlip.x + 0.5f);
  float2 s;
  if (rot == 1)      { s = float2(r.y, 1.0f - r.x); }      // 90 CW
  else if (rot == 2) { s = float2(1.0f - r.x, 1.0f - r.y); }
  else if (rot == 3) { s = float2(1.0f - r.y, r.x); }      // 270 CW
  else               { s = r; }
  if (place.rotFlip.y > 0.5f) { s.x = 1.0f - s.x; }
  if (place.rotFlip.z > 0.5f) { s.y = 1.0f - s.y; }
  // Sample unconditionally, then mask outside-source pixels to transparent.
  const float inside = (s.x >= 0.0f && s.x <= 1.0f && s.y >= 0.0f && s.y <= 1.0f) ? 1.0f : 0.0f;
  constexpr sampler samp(coord::normalized, filter::linear, address::clamp_to_edge);
  dst.write(src.sample(samp, clamp(s, float2(0.0f), float2(1.0f))) * inside, gid);
}
)MSL";

/// gpu.h BufferUsage::Uniform.
constexpr int32_t kBufferUsageUniform = 2;

}  // namespace

BlitFit blitFitFromString(const std::string& s) {
  if (s == "cover") return BlitFit::Cover;
  if (s == "stretch") return BlitFit::Stretch;
  if (s == "none") return BlitFit::None;
  return BlitFit::Fit;
}

PlaceGeom placeGeom(int sw, int sh, int W, int H, BlitFit mode, const BlitTransform& xf,
                    int logicalW, int logicalH) {
  PlaceGeom g;
  // TS: ((((xf.rotation / 90) | 0) % 4) + 4) % 4 — truncating divide, then a
  // positive modulo so a negative rotation still lands in 0..3.
  const int turns = (int)(xf.rotation / 90.0);
  g.rot = ((turns % 4) + 4) % 4;
  const bool rotated = g.rot == 1 || g.rot == 3;
  const double esw = rotated ? sh : sw;  // rotated frame's footprint aspect
  const double esh = rotated ? sw : sh;
  double dw = 0, dh = 0;
  if (sw <= 0 || sh <= 0 || mode == BlitFit::Stretch) {
    dw = W; dh = H;
  } else if (mode == BlitFit::Cover) {
    const double s = std::max(W / esw, H / esh);
    dw = esw * s; dh = esh * s;
  } else if (mode == BlitFit::None) {
    dw = esw * (W / (double)std::max(1, logicalW));
    dh = esh * (H / (double)std::max(1, logicalH));
  } else {  // Fit (contain)
    const double s = std::min(W / esw, H / esh);
    dw = esw * s; dh = esh * s;
  }
  const double scale = std::max(1e-3, xf.scale);
  dw *= scale; dh *= scale;
  const double dx = xf.anchorX * (W - dw);  // anchor 0 = left/top edges, 1 = right/bottom
  const double dy = xf.anchorY * (H - dh);
  g.rect[0] = dx / W;
  g.rect[1] = dy / H;
  g.rect[2] = dw / W;
  g.rect[3] = dh / H;
  g.flipH = xf.flipH;
  g.flipV = xf.flipV;
  return g;
}

FrameBlitter::~FrameBlitter() {
  if (!backend_) return;
  if (placeBuf_ >= 0) backend_->release(placeBuf_);
  if (pso_ >= 0) backend_->release(pso_);
  if (shader_ >= 0) backend_->release(shader_);
}

bool FrameBlitter::ensurePipeline(gpu::GPUBackend* backend) {
  if (backend_ && backend_ != backend) return false;
  backend_ = backend;
  if (pso_ < 0) {
    shader_ = backend->createShaderModule(kBlitMSL);
    if (shader_ < 0) return false;
    pso_ = backend->createComputePSO(shader_, "frame_blit");
    if (pso_ < 0) return false;
  }
  if (placeBuf_ < 0) {
    placeBuf_ = backend->createBuffer(32, kBufferUsageUniform);
    if (placeBuf_ < 0) return false;
  }
  return true;
}

bool FrameBlitter::blit(gpu::GPUBackend* backend, int32_t srcTex, int srcW, int srcH,
                        int32_t dstTex, int W, int H, BlitFit mode, const BlitTransform& xf,
                        int logicalW, int logicalH) {
  if (!backend || srcTex < 0 || dstTex < 0 || W <= 0 || H <= 0) return false;
  if (!ensurePipeline(backend)) return false;

  const PlaceGeom g = placeGeom(srcW, srcH, W, H, mode, xf, logicalW, logicalH);
  const float place[8] = {
      (float)g.rect[0], (float)g.rect[1], (float)g.rect[2], (float)g.rect[3],
      (float)g.rot,     g.flipH ? 1.f : 0.f, g.flipV ? 1.f : 0.f, 0.f,
  };
  backend->writeBuffer(placeBuf_, 0, reinterpret_cast<const uint8_t*>(place), sizeof(place));

  const int32_t pass = backend->beginComputePass();
  backend->computeSetPSO(pass, pso_);
  backend->computeSetTexture(pass, srcTex, 0, /*access=*/0);
  backend->computeSetTexture(pass, dstTex, 1, /*access=*/1);
  backend->computeSetBuffer(pass, placeBuf_, 0, /*slot=*/0);
  backend->computeDispatch(pass, (W + 7) / 8, (H + 7) / 8, 1);
  backend->endComputePass(pass);
  return true;
}

}  // namespace nano_media
