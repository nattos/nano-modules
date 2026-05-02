// nano_coords.hlsl — Aspect-aware coordinate utilities.
//
// Cover-square coords: signed-normalized inside a 1:1 square that's "cover"
// fit to the viewport. (0,0) = viewport centre. ±1 along the long axis = the
// viewport edge; the short axis sees a smaller visible range.
//
// Helpers expect `aspect = (ax, ay)` precomputed by the host:
//   ax = max(W, H) / (2 * W)
//   ay = max(W, H) / (2 * H)
//
// See EFFECTS_STYLE_GUIDE.md §1.5.

#ifndef NANO_COORDS_HLSL
#define NANO_COORDS_HLSL

// Pixel center → viewport uv [0, 1].
float2 nano_pixel_to_uv(float2 pixel, float2 vp) {
  return (pixel + 0.5) / vp;
}

// Viewport uv → cover-square coords.
float2 nano_uv_to_cover_square(float2 uv, float2 aspect) {
  return (uv - 0.5) / aspect;
}

// Cover-square coords → viewport uv.
float2 nano_cover_square_to_uv(float2 sq, float2 aspect) {
  return sq * aspect + 0.5;
}

// Convenience: pixel center → cover-square in one call.
float2 nano_pixel_to_cover_square(float2 pixel, float2 vp, float2 aspect) {
  return nano_uv_to_cover_square(nano_pixel_to_uv(pixel, vp), aspect);
}

#endif
