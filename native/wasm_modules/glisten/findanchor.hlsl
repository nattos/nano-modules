// filter.legacy.glisten — anchor finder (single thread).
//
// Coarse/fine search for the brightest spot in the input, then a 4-tap
// finite-difference luminance gradient (the sparkle's stretch direction) and
// per-channel colour gradients (the local tint). Writes one anchor record.
// Mirrors NanoGraph GlistenFindAnchor.
//
// anchor buffer layout (floats):
//   [0,1]    Position.xy (uv)    [2,3]   Direction.xy (unit grad normal)
//   [4,5]    Grad.xy             [6..8]  Color.rgb
//   [9..11]  ColorGradX.rgb      [12..14] ColorGradY.rgb
//   [15]     valueAvg

Texture2D<float4>         inputTex : register(t0);
SamplerState             samp     : register(s1);
RWStructuredBuffer<float> anchor   : register(u2);

cbuffer U : register(b3) {
  float coarse;            // coarse grid resolution per axis
  float fine;              // fine refine resolution per axis
  float sampling_width;    // gradient finite-difference step (uv)
  float color_grad_soft;
  float color_grad_squash;
  float color_grad_adjust;
  float _p0, _p1;
};

static const float PI = 3.14159265358979323846;

float lum(float3 c) { return max(c.r, max(c.g, c.b)); }

[numthreads(1, 1, 1)]
void main(uint3 id : SV_DispatchThreadID) {
  int C = (int)coarse;
  int F = (int)fine;
  float2 cstep = 1.0 / float2(C, C);

  // ---- coarse pass ----
  float2 bestC = float2(0.5, 0.5);
  float  bestCV = -1.0;
  for (int cy = 0; cy < C; ++cy) {
    for (int cx = 0; cx < C; ++cx) {
      float2 uv = (float2(cx, cy) + 0.5) * cstep;
      float v = lum(inputTex.SampleLevel(samp, uv, 0).rgb);
      if (v > bestCV) { bestCV = v; bestC = float2(cx, cy) * cstep; }
    }
  }

  // ---- fine pass (within the best coarse cell) ----
  float2 fstep = cstep / float2(F, F);
  float2 anchorUV = bestC + cstep * 0.5;
  float  bestFV = -1.0;
  for (int fy = 0; fy < F; ++fy) {
    for (int fx = 0; fx < F; ++fx) {
      float2 uv = bestC + (float2(fx, fy) + 0.5) * fstep;
      float v = lum(inputTex.SampleLevel(samp, uv, 0).rgb);
      if (v > bestFV) { bestFV = v; anchorUV = uv; }
    }
  }

  // ---- local gradient (4 taps) ----
  float sw = sampling_width;
  float4 s01 = inputTex.SampleLevel(samp, anchorUV + float2(-sw, 0), 0);
  float4 s21 = inputTex.SampleLevel(samp, anchorUV + float2( sw, 0), 0);
  float4 s10 = inputTex.SampleLevel(samp, anchorUV + float2(0, -sw), 0);
  float4 s12 = inputTex.SampleLevel(samp, anchorUV + float2(0,  sw), 0);
  float v01 = lum(s01.rgb), v21 = lum(s21.rgb), v10 = lum(s10.rgb), v12 = lum(s12.rgb);
  float valueAvg = (v01 + v21 + v10 + v12) * 0.25;

  float2 grad = float2(v21 - v01, v12 - v10);
  float2 gradNorm = grad / max(1e-5, length(grad));

  float3 color = (s01.rgb + s21.rgb + s10.rgb + s12.rgb) * 0.25;
  float3 dCdx = s21.rgb - s01.rgb;
  float3 dCdy = s12.rgb - s10.rgb;

  // Soften each channel's colour gradient (atan compression).
  float3 lenC = float3(length(float2(dCdx.r, dCdy.r)),
                       length(float2(dCdx.g, dCdy.g)),
                       length(float2(dCdx.b, dCdy.b)));
  float3 soft = atan((lenC + color_grad_soft) * color_grad_squash) * (PI * 2.0);
  float3 colorGradX = (dCdx / max(soft, 1e-4)) * valueAvg;
  float3 colorGradY = (dCdy / max(soft, 1e-4)) * valueAvg;

  // Bias the base colour slightly down-gradient so the glint reads against
  // the local background (matches the original's colour adjust).
  color -= (gradNorm.x * colorGradX + gradNorm.y * colorGradY)
           * lerp(1.0, color_grad_adjust, saturate(valueAvg));

  anchor[0] = anchorUV.x; anchor[1] = anchorUV.y;
  anchor[2] = gradNorm.x; anchor[3] = gradNorm.y;
  anchor[4] = grad.x;     anchor[5] = grad.y;
  anchor[6] = color.r;    anchor[7] = color.g;    anchor[8] = color.b;
  anchor[9]  = colorGradX.r; anchor[10] = colorGradX.g; anchor[11] = colorGradX.b;
  anchor[12] = colorGradY.r; anchor[13] = colorGradY.g; anchor[14] = colorGradY.b;
  anchor[15] = valueAvg;
}
