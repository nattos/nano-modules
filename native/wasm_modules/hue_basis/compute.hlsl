// video.hue_basis — Channel-mix into a basis defined by three hues.
//
// The C++ side derives an RGB basis vector b_i from each hue (HSV at
// S=V=1) and normalizes each so that its three components sum to 1
// (b'_i = b_i / dot(b_i, 1)). The matrix M with columns b'_i has the
// property that the SUM of any column = 1, so:
//
//   Forward  out = M^T · in:  per-row-j sum = sum of column j of M = 1
//                              → white input always produces white output.
//   Reverse  out = M  · in:  inverse approximation — exact when the
//                              basis is orthogonal, otherwise collapses
//                              gracefully without producing NaNs.
//
// Default basis is (red, green, blue); M = identity; both directions
// pass through unchanged.

Texture2D<float4> inputTex   : register(t0);
RWTexture2D<float4> outputTex : register(u1);

cbuffer Uniforms : register(b2) {
  float4 col0;       // normalized basis vector b'_0 in .xyz
  float4 col1;
  float4 col2;
  int   direction;   // 0 = Forward, 1 = Reverse
  int   _pad0;
  int   _pad1;
  int   _pad2;
};

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;

  float4 c = inputTex[gid.xy];
  float3 v = c.rgb;

  float3 r;
  if (direction == 0) {
    // Forward: M^T · v — output channel i = dot(b'_i, v)
    r = float3(dot(col0.xyz, v), dot(col1.xyz, v), dot(col2.xyz, v));
  } else {
    // Reverse: M · v — sum each basis vector weighted by the
    // corresponding input channel
    r = col0.xyz * v.x + col1.xyz * v.y + col2.xyz * v.z;
  }

  outputTex[gid.xy] = float4(r, c.a);
}
