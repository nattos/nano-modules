// util.room_wrap — one picture, cut into the three a room wants.
//
// The inverse of `util.triptych`'s Room mode. Triptych takes three pictures and
// composites them into the frame a viewer sees; this takes the picture a viewer
// should see and works out what has to be ON each of the three walls for that
// to be what they get. Feed this card's three outputs into that one with the
// same knobs and you get your input back — which is the test, and the reason
// the projection they share lives in one file (nano_room_wall.hlsl).
//
// --- What the three panes are ---------------------------------------------
//
// Everything is measured on the BACK WALL: it spans screen x in [-1, 1] and
// y in [-a, a], where `a` is the mid output's own height over its width. So the
// mid pane is square pixels by construction, at any zoom.
//
// The source is a rectangle in that same screen space, half-width S_x and
// half-height S_y, centred, at the source's own aspect — cover-fitted onto the
// back wall at Scale 1 and grown from there. Scale is the ONLY thing that puts
// picture on the side walls: at 1 a source shaped like the mid output fits it
// exactly and there is nothing left over.
//
//   mid   the part of that rectangle lying over the back wall. A plain zoom.
//   left  everything that overflowed to the left of it, and ALL of it.
//   right the same, mirrored.
//
// So the three panes tile the source's full width with no overlap and nothing
// dropped, whatever the perspective is set to. That is the invariant worth
// protecting: an atmospheric wipe crossing the room must not stall, repeat, or
// skip as it crosses a seam.
//
// --- The keystone ---------------------------------------------------------
//
// A side pane is a PICTURE OF a wall, not a texture to paint onto one. Its own
// x is where you are in that picture, and nano_wall_s turns that into where on
// the wall — and so on the source strip — you are looking. `Perspective` is how
// much of that map to apply:
//
//   R = lerp(1, S_x, perspective)
//
// R is the depth ratio: how much nearer the wall's outer end is than its seam
// end. At perspective 1 it is S_x, which is exactly the ratio that puts the
// wall's far end on the source's outer edge, so the three panes cover the whole
// picture. At 0 the map is the identity and each side is a plain linear stretch
// of its overflow: three flat panels in a row, no room, and no cost for saying
// so.
//
// SO THE OUTER EDGE IS THE ENLARGED ONE. That end of the wall is the end
// nearest the viewer, and a perspective view spreads out what is near and packs
// what is far: at Perspective 1 and Scale 3 the outer quarter of a pane carries
// a fifth of the picture the quarter beside the seam does. Reading it the other
// way round — near end packed SMALL, so that a projector spreading the panel
// evenly across a real angled surface lands it right — is the other half of the
// same geometry, and is not what any of our rigs want: the panel here is a
// picture that gets shown, not a texture that gets projected. That reading was
// built first and looked wrong on sight, because a wall whose nearest corner is
// its most crowded is a wall receding the wrong way.
//
// The vertical rides the SAME R over the same run, which is not tidiness — the
// two really are one number (both screen axes go as 1/z), and letting them
// drift apart is what makes a keystone read as a distortion rather than as a
// corner.
//
// --- Seams ----------------------------------------------------------------
//
// At the seam the wall parameter is 0, so the map is the identity there and the
// vertical multiplier is exactly 1: a side pane's seam edge samples the source
// at precisely the column and the rows the mid pane's edge does, at every
// setting. The join is continuous by construction, not by tuning — the same
// column of the picture, never a jump. Its SCALE steps there, and deliberately:
// that is the corner, and the whole reason to keystone at all.
//
// The far end is where the source can run out. A source shaped like the mid
// output never does — its height grows with Scale by exactly the factor the
// wall's height grows by, which is the same coincidence that makes the tiling
// exact — but a WIDER source runs out of height before it runs out of width,
// and those corners clamp to the source's edge rows. Smooth material does not
// show it; a hard edge along the top of the source would streak.
//
// Sampling is plain bilinear. The far end of a wall minifies by up to R, so a
// detailed source will alias out there — this card is for light, wipes and
// atmospherics, where there is nothing to alias, and a mip chain for the sake
// of a case it is not for would cost every frame.

#include "nano_room_wall.hlsl"

Texture2D<float4>   srcTex    : register(t0);
RWTexture2D<float4> outputTex : register(u1);
SamplerState        samp      : register(s2);

cbuffer Uniforms : register(b3) {
  // The back wall's half-height rides along because a side pane's dispatch
  // reads its OWN dimensions, and every length here is measured on the MID
  // output — the one pane whose shape the room is built around.
  float4 pane;   // which pane (0 mid, 1 left, 2 right), scale, perspective, a
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint W, H;
  outputTex.GetDimensions(W, H);
  if (gid.x >= W || gid.y >= H) return;

  int   which = int(pane.x + 0.5);
  float zoom  = max(pane.y, 1e-3);
  float persp = saturate(pane.z);
  float a     = max(pane.w, 1e-6);

  // Where the source sits in back-wall screen units. COVER at Scale 1 — grown
  // to the tighter axis and cropped on the other — so the mid pane is never
  // letterboxed and Scale only ever adds overflow to give the walls.
  uint sw, sh;
  srcTex.GetDimensions(sw, sh);
  float A_s = float(max(sw, 1u)) / float(max(sh, 1u));
  float S_x = zoom * max(1.0, a * A_s);
  float S_y = S_x / A_s;

  float xn = (float(gid.x) + 0.5) / float(W);
  float yn = (float(gid.y) + 0.5) / float(H);

  float2 uv;
  if (which == 0) {
    // The back wall. A rectangle of the screen, so this is a plain centred
    // zoom — and the only pane whose pixels stay square.
    float sx = 2.0 * xn - 1.0;
    float sy = a * (1.0 - 2.0 * yn);
    uv = float2(0.5 + sx / (2.0 * S_x), 0.5 - sy / (2.0 * S_y));
  } else {
    // A side wall, walked in ITS OWN coordinate: `p` is 0 at the seam and 1 at
    // the far end, and the left pane runs the other way across its texture so
    // its right edge is the one that meets the mid — the layout triptych reads.
    // R is the depth ratio: at Perspective 1 it is exactly the reach that puts
    // the wall's far end on the source's outer edge, so the three panes tile
    // the picture. At 0 it is 1 and the map below is the identity.
    //
    // `p` is 0 at the seam, which is the FAR end, so `t` comes back spread
    // toward the near end — the outer edge of the pane gets the magnification.
    float R = lerp(1.0, S_x, persp);
    float u_seam = (which == 1) ? (0.5 - 1.0 / (2.0 * S_x))
                                : (0.5 + 1.0 / (2.0 * S_x));
    float u_far  = (which == 1) ? 0.0 : 1.0;

    float p = (which == 1) ? (1.0 - xn) : xn;
    float t = nano_wall_s(p, 1.0, R);   // picture position -> position on the wall

    // Screen x and screen y both go as 1/z, so one factor carries both: the
    // source column moves out linearly in `t`, and the wall's half-height
    // grows by the same law over the same run.
    float m = lerp(1.0, R, t);
    float sy = a * m * (1.0 - 2.0 * yn);
    uv = float2(lerp(u_seam, u_far, t), 0.5 - sy / (2.0 * S_y));
  }

  outputTex[gid.xy] = srcTex.SampleLevel(samp, uv, 0);
}
