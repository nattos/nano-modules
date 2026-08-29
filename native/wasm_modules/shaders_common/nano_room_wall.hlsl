// nano_room_wall.hlsl — the side wall of a room, both ways round.
//
// A room seen head-on: a back wall square to the camera, and two side walls
// running out toward the viewer. `util.triptych` composites three pictures
// INTO that room; `util.room_wrap` takes one picture and cuts it UP into the
// three the room wants. They are inverses of each other, and this is the one
// piece of geometry they share — kept here so they cannot drift, because a
// picture that comes apart at a seam is the only way either of them fails.
//
// --- The geometry ---------------------------------------------------------
//
// Put the camera at the origin. The back wall sits at depth d and the side wall
// is the plane hanging off its edge, running from d (the SEAM) forward to some
// nearer depth. A point at depth z projects to screen x = f*m/z and screen
// y = f*y/z: BOTH go as 1/z, so as the wall comes toward the viewer its image
// slides outward and grows taller by exactly the same factor. That single ratio
//
//     h_edge / h_seam  =  d / z_near
//
// is the whole shape of a side wall. Everything below is that one number.
//
// Two coordinates run along the wall and they are NOT the same coordinate:
//
//   t  SCREEN-linear.  Where the pixel is in the picture. Even steps in `t` are
//      even steps across the frame.
//   s  WALL-linear.    Where the pixel is on the physical wall — what a
//      projector aimed at it paints evenly, and what the wall's own texture is
//      parameterised by.
//
// Both run 0 at the seam and 1 at the outer end. The gap between them is
// exactly why the far half of a corridor looks compressed, and getting it
// wrong is the classic "stretched into the trapezoid" look: correct at both
// ends, visibly sliding everywhere between them.
//
// So a compositor walks the frame and needs the wall coordinate under each
// pixel (nano_wall_s); an un-projector walks the wall and needs to know where
// in the frame it lands (nano_wall_t). Same map, read in either direction.
//
// Both collapse to the identity when h_seam == h_edge, which is the FLAT ROW —
// three panels in a line, no room at all. That is not a special case anywhere
// in either effect; it falls out, so "perspective 0" costs nothing and is
// exactly the un-bent picture rather than nearly it.

#ifndef NANO_ROOM_WALL_HLSL
#define NANO_ROOM_WALL_HLSL

/// SCREEN-linear t -> WALL-linear s. For a compositor: how far along the wall's
/// own texture the pixel at frame position `t` is looking.
///
/// The heights ARE the reciprocal depths (both go as 1/z, so their ratio is the
/// depth ratio), which makes this the ordinary perspective-correct interpolation
/// written in the only two numbers either effect actually has.
float nano_wall_s(float t, float h_seam, float h_edge) {
  float h = lerp(h_seam, h_edge, t);
  return t * h_edge / max(h, 1e-6);
}

/// WALL-linear s -> SCREEN-linear t. For an un-projector: where on the frame
/// the wall's own position `s` shows up.
///
/// Algebraically inverse to nano_wall_s, not approximately: solving
/// s = t*h_e / (h_s + (h_e - h_s)*t) for t gives exactly this, and a round trip
/// through the pair is the identity to float precision. `util.room_wrap` ->
/// `util.triptych` is that round trip made of real pixels.
float nano_wall_t(float s, float h_seam, float h_edge) {
  return s * h_seam / max(h_edge - s * (h_edge - h_seam), 1e-6);
}

#endif  // NANO_ROOM_WALL_HLSL
