// nano_octahedral.hlsl — octahedral S² parameterization (dir ↔ uv).
//
// Maps the unit sphere onto the unit square with near-uniform area and NO
// trig: the upper hemisphere projects onto the center diamond, the lower
// hemisphere folds into the four corners. Continuous everywhere on the
// interior of the map; the four OUTER edges are seams (the -Y region is
// split across the corners), so with a clamp sampler the values within
// half a texel of the border interpolate slightly flat. Keep the border
// texels authored (evaluate the field at nano_oct_decode(uv) like any
// other texel) and that error stays sub-texel.
//
// Convention: uv ∈ [0,1]², texel centers at (i + 0.5) / res. Sim stencils
// that need true cross-seam neighbors must mirror-fold their taps
// (future work — noted in the plume plan).

#ifndef NANO_OCTAHEDRAL_HLSL
#define NANO_OCTAHEDRAL_HLSL

// Componentwise sign that never returns 0 (sign(0) == 0 breaks the fold).
float2 nano_oct_sign_(float2 v) {
  return float2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
}

// Unit direction -> uv in [0,1]².
float2 nano_oct_encode(float3 dir) {
  float l1 = abs(dir.x) + abs(dir.y) + abs(dir.z);
  float3 n = dir / max(l1, 1e-8);
  float2 e = (n.y >= 0.0) ? n.xz
                          : (1.0 - abs(n.zx)) * nano_oct_sign_(n.xz);
  return e * 0.5 + 0.5;
}

// uv in [0,1]² -> unit direction.
float3 nano_oct_decode(float2 uv) {
  float2 e = uv * 2.0 - 1.0;
  float3 n = float3(e.x, 1.0 - abs(e.x) - abs(e.y), e.y);
  float t = saturate(-n.y);
  n.xz += nano_oct_sign_(n.xz) * -t;
  return normalize(n);
}

#endif // NANO_OCTAHEDRAL_HLSL
