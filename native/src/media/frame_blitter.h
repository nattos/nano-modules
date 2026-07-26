// frame_blitter.h — place a decoded source frame into the composition canvas.
//
// LOCK-STEP: web/src/video/frame-blitter.ts. `placeGeom` is the same pure
// math, and the shader is the same mapping (destination pixel → source UV,
// honouring the scale-mode footprint, anchor, extra scale, quarter-turn
// rotation and flips), with pixels outside the source left TRANSPARENT so the
// layers below show through.
//
// Why it exists at all: the injected frame is bound as input slot 0 and read
// 1:1 by the `source.video.file` effect, so the placement has to happen BEFORE
// injection. Web blits into an ImageBitmap because its decode lives on the main
// thread; natively there's no worker boundary, so this writes straight into a
// render-sized RGBA8 texture.
//
// HOST ONLY (GPU backend + filesystem-adjacent). Never include from
// src/sketch/comp/.

#pragma once

#include <cstdint>
#include <string>

namespace gpu { class GPUBackend; }

namespace nano_media {

/// How the source frame scales into the target canvas (model ScaleMode).
enum class BlitFit { Fit, Cover, Stretch, None };

BlitFit blitFitFromString(const std::string& s);

/// Placement transform layered on the scale-mode fit (model SourceTransform).
struct BlitTransform {
  double anchorX = 0.5;
  double anchorY = 0.5;
  double scale = 1;
  /// Degrees clockwise; only quarter turns are meaningful (0/90/180/270).
  double rotation = 0;
  bool flipH = false;
  bool flipV = false;
};

/// Geometry the placement shader needs.
struct PlaceGeom {
  /// [x, y, w, h] in normalised canvas coords; may extend beyond [0,1]
  /// (overflow → clipped) or start negative (panned crop window).
  double rect[4] = {0, 0, 1, 1};
  /// Quarter-turn index 0..3 (×90° clockwise).
  int rot = 0;
  bool flipH = false;
  bool flipV = false;
};

/**
 * Pure placement geometry. `W`/`H` are the blit target (maybe a downscaled
 * preview); `logicalW`/`logicalH` are the size `None` reasons about — the
 * composition resolution — so "native pixels" is 1:1 against the COMPOSITION
 * then uniformly scaled into the preview. The base footprint per mode is
 * computed on the ROTATED aspect (a 90°/270° frame fits/covers by its turned
 * bounding box), then `scale` zooms about the centre and the anchor positions
 * it; the same `offset = anchor·(canvas − frame)` formula covers both the
 * letterbox (frame smaller) and crop (frame larger) regimes.
 */
PlaceGeom placeGeom(int sw, int sh, int W, int H, BlitFit mode, const BlitTransform& xf,
                    int logicalW, int logicalH);

/**
 * The GPU half: samples `srcTex` into `dstTex` (RGBA8, W×H) per the geometry.
 * Areas the source doesn't cover are written TRANSPARENT, not left stale — the
 * destination is a reused cache texture.
 */
class FrameBlitter {
 public:
  ~FrameBlitter();
  bool blit(gpu::GPUBackend* backend, int32_t srcTex, int srcW, int srcH, int32_t dstTex,
            int W, int H, BlitFit mode, const BlitTransform& xf, int logicalW, int logicalH);

 private:
  bool ensurePipeline(gpu::GPUBackend* backend);

  gpu::GPUBackend* backend_ = nullptr;
  int32_t shader_ = -1;
  int32_t pso_ = -1;
  int32_t placeBuf_ = -1;
};

}  // namespace nano_media
