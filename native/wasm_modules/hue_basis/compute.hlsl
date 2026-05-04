// video.hue_basis — Channel-mix into a basis defined by three hues.
//
// The CPU uploads three column vectors, one per output channel. The
// shader applies them as dot-products: out[i] = dot(col_i, in). This
// is `M^T · in` where M is the matrix with col_i as columns.
//
// The CPU picks WHICH matrix to upload based on direction:
//   Forward → cols of M    (basis vectors normalized so each col sums
//                            to 1; white preserved by construction).
//   Reverse → cols of M^-1 (true closed-form 3×3 inverse — round-trip
//                            with Forward is identity for any
//                            non-singular basis. Falls back to M
//                            cols if M is singular, in which case
//                            the round-trip "collapses" but stays
//                            NaN-free.)

Texture2D<float4> inputTex   : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float4 col0;       // .xyz = first row of the upload matrix
  float4 col1;
  float4 col2;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c = inputTex[gid.xy];
  float3 v = c.rgb;

  float3 r = float3(dot(col0.xyz, v),
                    dot(col1.xyz, v),
                    dot(col2.xyz, v));

  outputTex[gid.xy] = float4(r, c.a);
}
