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
//   t  SCREEN-linear.  Where the pixel is in the PICTURE. Even steps in `t` are
//      even steps across the frame.
//   s  PLANE-linear.   Where it is on the flat thing being looked at. Even
//      steps in `s` are even steps along the wall itself.
//
// Both run 0 where the plane is FURTHEST from the viewer and 1 where it is
// nearest — for a room's side wall, 0 at the seam with the back wall. The gap
// between them is exactly why the far half of a corridor looks compressed, and
// getting it wrong is the classic "stretched into the trapezoid" look: correct
// at both ends, visibly sliding everywhere between them.
//
// One function, and both cards call it the same way round: give it a position
// in a PICTURE and it hands back the position on the PLANE that picture is of.
//
//   triptych    the picture is its own frame, the plane is the wall's texture.
//   room_wrap   the picture is the panel it is producing, the plane is the
//               strip of the source that panel is a view of.
//
// Which is why both walls come out with their NEAR end enlarged — the end that
// is closest to the viewer is the one a perspective view spreads out. There was
// briefly an inverse here (a `nano_wall_t`) for the other reading of what a
// side panel is: not a picture of the wall but the texture to paint ON one,
// which a projector spreads evenly over the surface and which therefore has to
// carry the near end SMALL. That is the right answer for a warper driving a
// real angled surface and the wrong one for every rig we actually have, where
// the panel is a picture that gets shown. See `util.room_wrap`.
//
// It collapses to the identity when h_seam == h_edge, which is the FLAT ROW —
// three panels in a line, no room at all. That is not a special case anywhere
// in either effect; it falls out, so "perspective 0" costs nothing and is
// exactly the un-bent picture rather than nearly it.

#ifndef NANO_ROOM_WALL_HLSL
#define NANO_ROOM_WALL_HLSL

/// SCREEN-linear t -> PLANE-linear s. Where on the flat thing the pixel at
/// picture position `t` is looking.
///
/// The heights ARE the reciprocal depths (both screen axes go as 1/z, so their
/// ratio IS the depth ratio), which makes this the ordinary perspective-correct
/// interpolation written in the only two numbers either effect actually has.
float nano_wall_s(float t, float h_seam, float h_edge) {
  float h = lerp(h_seam, h_edge, t);
  return t * h_edge / max(h, 1e-6);
}

#endif  // NANO_ROOM_WALL_HLSL
