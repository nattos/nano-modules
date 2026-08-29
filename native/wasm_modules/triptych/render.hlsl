// util.triptych — three inputs, side by side in a row.
//
// A debug surface, built to look at source.mesh.three_walls: that card's three
// outputs are the three walls of one room, and the only way to see whether the
// picture actually carries around the corners is to put them next to each other
// in the order they physically sit. Left wall, back wall, right wall.
//
// --- The room -------------------------------------------------------------
//
// Flat out, the three panels are exact thirds. Two knobs bend that into the
// room it is a picture of:
//
//   Middle Size  widens the back wall past its third; the two side panels give
//                up whatever it takes.
//   Perspective  splays the side panels out into trapezoids — short where they
//                meet the back wall, tall at the frame edges, exactly the way
//                a corridor's walls read.
//
// The OUTER edges always fill the band, and the perspective works by pulling
// the back wall DOWN from it rather than by pushing the sides past it. So the
// room is bounded by construction, and at Perspective 0 every edge is the same
// height again — the aligned row, unchanged.
//
// How much shorter the back wall gets at full perspective is not a taste
// decision, it is the geometry: on a plane through the camera, screen height
// and distance-from-centre both go as 1/z, so the ratio between the frame edge
// and the seam is (half the frame) / (half the back wall) — one over the
// middle's width. The knob just dials in a fraction of that truth, because
// this is a measuring surface and the whole truth is a very deep room.
//
// The side panels then need PERSPECTIVE-CORRECT sampling, not a stretch into
// the trapezoid. Screen position interpolates linearly across the quad; the
// wall's own coordinate does not, and the difference is the whole reason the
// far half of a corridor looks compressed. See `wall_s` below.
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
//   3 Room    — the two answers at once, one per role. See below.
//
// ROOM is the mode the perspective wants, and it is not a fit at all — it is a
// different question. The other three take the panel as given and decide what
// to do with a source that does not match it. Room does the reverse: the BACK
// WALL is given, at its own aspect and square pixels, and the room is built
// around whatever shape that turns out to be. The sides then stretch, aspect
// and all, to meet it exactly.
//
// That split is the point. A back wall that squashes is a lie about the thing
// you are measuring; a side wall is already a projection of a plane you are
// looking at edge-on, so stretching it is what makes it correct, not what
// breaks it. And because the seam height IS the back wall's height rather than
// the panel's, the three meet with nothing between them at any perspective —
// which no combination of the other modes can do, since Fit leaves bars at the
// seams and Stretch fixes that by distorting the one panel that must not.
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
  float4 led;    // has_led, strip height (fraction of the frame), -, -
  float4 room;   // middle size (in thirds), perspective, -, -
};

/// The room's geometry, in frame-normalised units.
struct RoomGeom {
  float x_i;   ///< the left seam (the right one mirrors it)
  float h_i;   ///< half-height at the seam — the back wall's
  float h_o;   ///< half-height at the frame edges
};

/// How far along a side wall a pixel is, given how far across the panel it is.
///
/// `t` runs 0 at the seam to 1 at the frame edge, `h_seam` and `h_edge` are the
/// panel's half-heights at those two ends. Screen half-height goes as 1/z on a
/// plane, so the heights ARE the reciprocal depths, and this is the ordinary
/// perspective-correct interpolation written in terms of them. At h_seam ==
/// h_edge it collapses to `t`, which is why Perspective 0 costs nothing.
float wall_s(float t, float h_seam, float h_edge) {
  float h = lerp(h_seam, h_edge, t);
  return t * h_edge / max(h, 1e-6);
}

/// Where the three panels sit, given the mode.
///
/// `row_bot` is the bottom of the band the row lives in, `half_g` the
/// divider's half-width, `mid_src` the back wall source's pixel size.
///
/// The two paths differ in which end the back wall's height comes from. Outside
/// Room it is pulled DOWN from the band by the depth ratio; in Room it is the
/// back wall's own aspect, and the ratio comes out instead.
///
/// EITHER WAY BOTH ENDS STAY INSIDE THE BAND. Letting the sides grow past it and
/// cropping them looked defensible — a corridor's walls do leave the frame — and
/// it is not what happens here: the crop lands at the band's edge, which is
/// wherever the LED strip happens to start, so the walls get a flat cut across
/// them with the perspective still visibly climbing into it, and the picture
/// inside them is lost from there on. So the outer half-height is interpolated
/// TO the band rather than multiplied past it.
///
/// That is not a fudge either. At full perspective the true outer half-height
/// works out at (frame aspect / source aspect) / 2, so for a source shaped like
/// the frame with no strip below it, filling the band IS the true geometry —
/// this only departs from it by as much as the strip has taken, and in the
/// direction of a slightly shallower room rather than a cropped one.
RoomGeom room_geom(int mode, float mid_slot, float persp, float row_bot,
                   float half_g, float2 vp, float2 mid_src) {
  RoomGeom g;
  if (mode == 3) {
    float w = max(mid_slot - 2.0 * half_g, 1e-4);
    // Square pixels: the height that width implies at the source's own aspect.
    float h = w * (vp.x / vp.y) * max(mid_src.y, 1.0) / max(mid_src.x, 1.0);
    // Too tall to fit the band, so take it from the width instead — shrinking
    // the back wall keeps every pixel of it, where cropping would not.
    if (h > row_bot) { w *= row_bot / max(h, 1e-4); h = row_bot; }
    g.x_i = (1.0 - (w + 2.0 * half_g)) * 0.5;
    g.h_i = h * 0.5;
    g.h_o = lerp(g.h_i, row_bot * 0.5, persp);
  } else {
    g.x_i = (1.0 - mid_slot) * 0.5;
    g.h_o = row_bot * 0.5;
    g.h_i = g.h_o / lerp(1.0, 1.0 / max(mid_slot, 1e-3), persp);
  }
  return g;
}

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
  float persp = saturate(room.y);

  float2 vp = float2(float(W), float(H));
  float xn = (float(gid.x) + 0.5) / vp.x;
  float y  = (float(gid.y) + 0.5) / vp.y;

  // THE ROW COMES FIRST. The strip's height comes off the whole frame, so all
  // three panels keep the same top and the same bottom however tall it is.
  float row_h = (has_led && led_h > 0.0) ? (1.0 - led_h) : 1.0;

  // The divider under the row, at the same PIXEL thickness as a vertical seam
  // — one gap knob, one kind of line. Capped, so a wide gap on a short strip
  // narrows the divider rather than swallowing what is either side of it.
  float band = (row_h < 1.0)
      ? min(gap * vp.x / (6.0 * vp.y), min(row_h, 1.0 - row_h) * 0.4)
      : 0.0;
  if (row_h < 1.0 && y > row_h - band && y < row_h + band) {
    outputTex[gid.xy] = float4(0, 0, 0, 0);
    return;
  }

  // The room's geometry. `half_g` is the divider's half-width in frame units —
  // gap is a fraction of ONE PANEL, and a panel is a third.
  float mid_slot = clamp(room.x / 3.0, 0.02, 0.999);
  float half_g = gap / 6.0;
  float row_bot = row_h - band;

  uint msw, msh;
  midTex.GetDimensions(msw, msh);
  RoomGeom geom = room_geom(mode, mid_slot, persp, row_bot, half_g, vp,
                            float2(float(msw), float(msh)));
  float x_i = geom.x_i;              // the left seam
  float x_o = 1.0 - x_i;             // the right seam

  // Room is the geometry talking, not the fit: each panel is filled outright,
  // and it is the SHAPE OF THE PANEL that carries the back wall's aspect.
  int fit = (mode == 3) ? 1 : mode;

  int    src = 1;                    // 0 left, 1 mid, 2 right, 3 LED strip
  float2 col_uv = float2(0.0, 0.0);
  float2 col_size = float2(1.0, 1.0);

  if (y >= row_h + band) {
    // Under the row: the strip, and it follows the middle panel rather than
    // the middle THIRD — it is a reading of what that panel shows.
    if (xn < x_i + half_g || xn > x_o - half_g) {
      outputTex[gid.xy] = float4(0, 0, 0, 0);
      return;
    }
    float w = x_o - x_i - 2.0 * half_g;
    float h = 1.0 - row_h - band;
    src = 3;
    col_uv = float2((xn - x_i - half_g) / max(w, 1e-4),
                    (y - row_h - band) / max(h, 1e-4));
    col_size = float2(vp.x * w, vp.y * h);
  } else {
    float cy  = row_bot * 0.5;
    float h_i = geom.h_i;                              // at the back wall
    float h_o = geom.h_o;                              // at the frame edges
    float run = x_i - 2.0 * half_g;                    // a side panel's width

    if (xn >= x_i + half_g && xn <= x_o - half_g) {
      // The back wall: a rectangle, centred in the band.
      float w = x_o - x_i - 2.0 * half_g;
      float top = cy - h_i;
      if (y < top || y > cy + h_i) {
        outputTex[gid.xy] = float4(0, 0, 0, 0);        // above it, or below it
        return;
      }
      src = 1;
      col_uv = float2((xn - x_i - half_g) / max(w, 1e-4),
                      (y - top) / max(2.0 * h_i, 1e-4));
      col_size = float2(vp.x * w, vp.y * 2.0 * h_i);
    } else if (xn >= half_g && xn <= x_i - half_g) {
      // The left wall. Its far end abuts the back wall, so the seam is where
      // the source's own far end goes — which is its RIGHT edge, the way
      // three_walls lays a side camera out. Hence `1 - s`.
      float t = (x_i - half_g - xn) / max(run, 1e-4);
      float ht = lerp(h_i, h_o, t);
      float top = cy - ht;
      if (y < top || y > cy + ht) {
        outputTex[gid.xy] = float4(0, 0, 0, 0);
        return;
      }
      src = 0;
      col_uv = float2(1.0 - wall_s(t, h_i, h_o), (y - top) / max(2.0 * ht, 1e-4));
      col_size = float2(vp.x * run, vp.y * 2.0 * h_i);
    } else if (xn >= x_o + half_g && xn <= 1.0 - half_g) {
      float t = (xn - x_o - half_g) / max(run, 1e-4);
      float ht = lerp(h_i, h_o, t);
      float top = cy - ht;
      if (y < top || y > cy + ht) {
        outputTex[gid.xy] = float4(0, 0, 0, 0);
        return;
      }
      src = 2;
      col_uv = float2(wall_s(t, h_i, h_o), (y - top) / max(2.0 * ht, 1e-4));
      col_size = float2(vp.x * run, vp.y * 2.0 * h_i);
    } else {
      outputTex[gid.xy] = float4(0, 0, 0, 0);          // a divider
      return;
    }
  }

  // An unwired side is transparent rather than a repeat of the middle: on a
  // debug surface "nothing is connected here" and "the same picture again" must
  // not look alike. The strip needs no such test — it only exists when wired.
  bool wired = (src == 0) ? (misc.z > 0.5) : (src == 2 ? (misc.w > 0.5) : true);
  if (!wired) {
    outputTex[gid.xy] = float4(0, 0, 0, 0);
    return;
  }

  uint sw = msw, sh = msh;
  if (src == 0)      leftTex.GetDimensions(sw, sh);
  else if (src == 2) rightTex.GetDimensions(sw, sh);
  else if (src == 3) ledTex.GetDimensions(sw, sh);

  float2 uv;
  if (!panel_uv(col_uv, float2(float(sw), float(sh)), col_size, fit, uv)) {
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
