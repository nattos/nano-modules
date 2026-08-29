// util.triptych — three inputs, side by side in a row.
//
// A debug surface, built to look at source.mesh.three_walls: that card's three
// outputs are the three walls of one room, and the only way to see whether the
// picture actually carries around the corners is to put them next to each other
// in the order they physically sit. Left wall, back wall, right wall.
//
// Each panel gets an exact third of the width. The fit modes decide what
// happens when a source's shape does not match that third:
//
//   0 Fit     — letterbox: the whole source, uncropped, centred. The default,
//               because a measuring surface that distorts what it shows is a
//               worse measuring surface.
//   1 Stretch — squash it into the third. Wastes no space and keeps the panels
//               CONTINUOUS, which is what you want when the three are meant to
//               read as one space rather than be compared.
//   2 Fill    — crop to the third instead, so nothing is squashed but the edges
//               of the source are lost.
//
// Letterbox bars and the divider are transparent, not black, so the monitor's
// checkerboard makes it obvious they are nothing rather than dark picture.
//
// When an LED map is wired it takes a strip off the BOTTOM OF THE FRAME, under
// the middle third. Off the frame and not out of the middle panel: left, middle
// and right are three walls of one room and have to read as one picture, so
// they share a top and a bottom always. Shrinking only the middle would step
// the room at both seams, which is the one thing this surface must not do.
//
// The strip sits under the middle third alone, because it is a reading of what
// that panel shows rather than a fourth panel in the row. The thirds either
// side of it are left empty.

#include "nano_coords.hlsl"

Texture2D<float4>   midTex    : register(t0);
Texture2D<float4>   leftTex   : register(t1);
Texture2D<float4>   rightTex  : register(t2);
RWTexture2D<float4> outputTex : register(u3);
SamplerState        samp      : register(s4);
// The strip under the middle. Register 6 rather than 3: binding indices ARE
// register numbers and they are shared across resource types, so the storage
// texture already owns 3.
Texture2D<float4>   ledTex    : register(t6);

cbuffer Uniforms : register(b5) {
  float4 misc;   // fit mode, gap, has_left, has_right
  float4 view;   // vp_w, vp_h, -, -
  float4 led;    // has_led, strip height (fraction of the column), -, -
};

/// Column-local uv -> source uv, honouring the fit mode. Returns false when the
/// pixel falls outside the source (the letterbox bars).
bool panel_uv(float2 col_uv, float2 src_size, float2 col_size, int mode,
              out float2 uv) {
  uv = col_uv;
  if (mode == 1) return true;   // stretch: the column IS the source

  float src_aspect = src_size.x / max(src_size.y, 1.0);
  float col_aspect = col_size.x / max(col_size.y, 1.0);

  if (mode == 0) {
    // Fit: shrink to the tighter axis and centre, leaving bars on the other.
    if (src_aspect > col_aspect) {
      float h = col_aspect / src_aspect;
      uv.y = (col_uv.y - (1.0 - h) * 0.5) / h;
    } else {
      float w = src_aspect / col_aspect;
      uv.x = (col_uv.x - (1.0 - w) * 0.5) / w;
    }
    return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
  }

  // Fill: grow to the looser axis and crop around the centre.
  if (src_aspect > col_aspect) {
    float w = col_aspect / src_aspect;
    uv.x = 0.5 + (col_uv.x - 0.5) * w;
  } else {
    float h = src_aspect / col_aspect;
    uv.y = 0.5 + (col_uv.y - 0.5) * h;
  }
  return true;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  int   mode = int(misc.x + 0.5);
  float gap  = saturate(misc.y);
  bool  has_led = led.x > 0.5;
  float led_h = saturate(led.y);

  float2 vp = float2(float(W), float(H));
  float col_w = vp.x / 3.0;
  float y = (float(gid.y) + 0.5) / vp.y;

  // THE ROW COMES FIRST. The strip's height comes off the whole frame, so all
  // three panels keep the same top and the same bottom however tall it is.
  float row_h = (has_led && led_h > 0.0) ? (1.0 - led_h) : 1.0;

  // The divider under the row, at the same PIXEL thickness as a vertical seam
  // — one gap knob, one kind of line. Capped, so a wide gap on a short strip
  // narrows the divider rather than swallowing what is either side of it.
  float band = (row_h < 1.0)
      ? min(gap * col_w * 0.5 / vp.y, min(row_h, 1.0 - row_h) * 0.4)
      : 0.0;
  if (row_h < 1.0 && y > row_h - band && y < row_h + band) {
    outputTex[gid.xy] = float4(0, 0, 0, 0);
    return;
  }

  bool  in_strip = y >= row_h + band;
  float panel_h  = in_strip ? (1.0 - row_h - band) : (row_h - band);
  float y_local  = (in_strip ? (y - row_h - band) : y) / max(panel_h, 1e-4);

  // Which third, and where inside it.
  float fx = (float(gid.x) + 0.5) / col_w;
  int   col = int(fx);
  col = col < 0 ? 0 : (col > 2 ? 2 : col);
  float2 col_uv = float2(fx - float(col), y_local);
  float2 col_size = float2(col_w, vp.y * panel_h);

  // The divider eats a strip from each side of every seam, so the three panels
  // stay the same width as each other however wide the gap is.
  if (gap > 0.0) {
    float half_gap = gap * 0.5;
    if (col_uv.x < half_gap || col_uv.x > 1.0 - half_gap) {
      outputTex[gid.xy] = float4(0, 0, 0, 0);
      return;
    }
    col_uv.x = saturate((col_uv.x - half_gap) / max(1.0 - gap, 1e-4));
  }

  // Under the row, only the middle third carries anything.
  if (in_strip && col != 1) {
    outputTex[gid.xy] = float4(0, 0, 0, 0);
    return;
  }
  int src = in_strip ? 3 : col;   // 0 left, 1 mid, 2 right, 3 LED strip

  // An unwired side is transparent rather than a repeat of the middle: on a
  // debug surface "nothing is connected here" and "the same picture again" must
  // not look alike. The strip needs no such test — it only exists when wired.
  bool wired = (src == 0) ? (misc.z > 0.5) : (src == 2 ? (misc.w > 0.5) : true);
  if (!wired) {
    outputTex[gid.xy] = float4(0, 0, 0, 0);
    return;
  }

  uint sw, sh;
  if (src == 0)      leftTex.GetDimensions(sw, sh);
  else if (src == 2) rightTex.GetDimensions(sw, sh);
  else if (src == 3) ledTex.GetDimensions(sw, sh);
  else               midTex.GetDimensions(sw, sh);

  float2 uv;
  if (!panel_uv(col_uv, float2(float(sw), float(sh)),
                col_size, mode, uv)) {
    outputTex[gid.xy] = float4(0, 0, 0, 0);
    return;
  }

  float4 c;
  if (src == 0)      c = leftTex.SampleLevel(samp, uv, 0);
  else if (src == 2) c = rightTex.SampleLevel(samp, uv, 0);
  else if (src == 3) c = ledTex.SampleLevel(samp, uv, 0);
  else               c = midTex.SampleLevel(samp, uv, 0);

  outputTex[gid.xy] = c;
}
