// filter.reconstruct.line — pass 6: reconstruction + composite.
//
// Reads the analysis textures and repaints crisp lines (box-AA, uniform-width,
// energy-gain "4K-downsample" look), gated by the pass-6 same-side / flank-
// disparity / flank-vs-wide-background tests and the orientation-coherence veto,
// then composites over the input. `strength` enters ONLY here (0 = identity).
// The point + deband branches (wp/wg) land in the next stage. debug_view != 0
// shows an internal classifier stage. (Port of reconstruct.pass_reconstruct line
// branch + composite.)

#include "common.hlsl"
#include "nano_color.hlsl"   // nano_hsv_to_rgb (orientation-hue debug)

Texture2D<float4>   inputTex   : register(t0);
Texture2D<float4>   flankTex   : register(t1);   // sep_gauss(img, 0.7)  (bg taps)
Texture2D<float4>   cmnTex     : register(t2);   // rgb 3x3 min
Texture2D<float4>   cmxTex     : register(t3);   // rgb 3x3 max
Texture2D<float4>   cstarTex   : register(t4);   // (c*, -, -, -)
Texture2D<float4>   y3Tex      : register(t5);   // sigma-5.6 luma (wide context)
Texture2D<float4>   s0Tex      : register(t6);   // smoothed (cos2t, sin2t, w_est, -)
Texture2D<float4>   s1Tex      : register(t7);   // (w_line_s, w_point_s, w_grad_s, ori_coh)
Texture2D<float4>   sdTex      : register(t8);   // (delta_shared, trust, -, -)
Texture2D<float4>   m2Tex      : register(t9);   // (dbx, dby, r_est, sigma_s)
SamplerState        samp       : register(s10);
RWTexture2D<float4> outputTex  : register(u11);
cbuffer Uniforms : register(b12) { LRUniforms u; };

float3 texBilinear(Texture2D<float4> t, float2 pix, float2 dim) {
  return t.SampleLevel(samp, (pix + 0.5) / dim, 0.0).rgb;
}

[numthreads(8, 8, 1)]
void main(uint3 gid : SV_DispatchThreadID) {
  uint w, h;
  outputTex.GetDimensions(w, h);
  if (gid.x >= w || gid.y >= h) return;
  float2 dim = float2(w, h);
  float2 pf  = float2(gid.xy);

  float4 cin = inputTex[gid.xy];
  float4 S0  = s0Tex[gid.xy];
  float4 S1  = s1Tex[gid.xy];

  // ---- debug views (internal classifier stages) ----
  if (u.debug_view != 0u) {
    float3 dbg = cin.rgb;
    if (u.debug_view == 1u) {
      dbg = saturate(S1.xyz);
    } else if (u.debug_view == 2u) {
      dbg = (S0.z / max(u.max_width, 1e-3)).xxx * lr_smoothstep(0.15, 0.35, S1.x);
    } else if (u.debug_view == 3u) {
      float ang = atan2(S0.y, S0.x);
      dbg = nano_hsv_to_rgb(float3(frac(ang / 6.2831853 + 0.5), 1.0, saturate(S1.x)));
    } else if (u.debug_view == 4u) {
      float d = sdTex[gid.xy].x;
      float g = lr_smoothstep(0.15, 0.35, S1.x);
      dbg = float3(saturate(d), 0.0, saturate(-d)) * g + 0.05 * g;
    } else if (u.debug_view == 5u) {
      dbg = saturate(S1.w).xxx;
    }
    outputTex[gid.xy] = float4(saturate(dbg), cin.a);
    return;
  }

  // ---- line branch ----
  float c2 = S0.x, s2 = S0.y, west = S0.z;
  float nrm = sqrt(c2 * c2 + s2 * s2 + 1e-12);
  float c2n = c2 / nrm, s2n = s2 / nrm;
  float nx = sqrt(clamp(0.5 * (1.0 + c2n), 0.0, 1.0));
  float ny = sign(s2n) * sqrt(clamp(0.5 * (1.0 - c2n), 0.0, 1.0));
  float2 nrml = float2(nx, ny);

  float delta   = sdTex[gid.xy].x;
  float sigma_s = m2Tex[gid.xy].w;
  float2 pc = pf + delta * nrml;

  float f = clamp(west * 0.5 + 1.5 * sigma_s + 1.0, 2.0, 6.0);
  float3 bg_p = texBilinear(flankTex, pc + f * nrml, dim);
  float3 bg_m = texBilinear(flankTex, pc - f * nrml, dim);
  float3 c_center = texBilinear(inputTex, pc, dim);

  float d_signed = -delta;
  float t = saturate((d_signed + f) / (2.0 * f));
  float3 bg_d = lerp(bg_m, bg_p, t);
  float3 bg_0 = 0.5 * (bg_m + bg_p);

  // retarget pull tapers off for wide strokes (their flat interior can't be
  // localized by these small operators — AA-clean at own width instead).
  float pull = u.retarget * (1.0 - lr_smoothstep(1.8, 3.0, west));
  float w_t  = max(west + (u.target_width - west) * pull, 0.75);
  float gain = clamp(0.9 * west / w_t, 1.0, 4.0);          // energy re-concentration
  float3 fg_raw = saturate(bg_0 + (c_center - bg_0) * gain);

  float3 cmn_g = cmnTex[gid.xy].rgb, cmx_g = cmxTex[gid.xy].rgb;
  float3 cmn_c = texBilinear(cmnTex, pc, dim), cmx_c = texBilinear(cmxTex, pc, dim);
  float3 lo = min(cmn_g, cmn_c) - 2.0 * LSB;
  float3 hi = max(cmx_g, cmx_c) + 2.0 * LSB;
  float3 fg_loc = clamp(fg_raw, lo, hi);
  float3 fg = fg_loc + (fg_raw - fg_loc) * u.recover;       // recover: trust past local range

  float a = lr_band_coverage(d_signed, w_t);                // box-AA coverage
  float3 c_line = lerp(bg_d, fg, a);

  // ---- pass-6 gates (flanks are available here) ----
  float cs = max(cstarTex[gid.xy].r, 1e-4);
  float yc = lr_luma709(c_center), yp = lr_luma709(bg_p), ym = lr_luma709(bg_m);
  float same = (yc - yp) * (yc - ym) / (cs * cs);
  float gate_ridge = lr_smoothstep(0.0, 0.02, same);        // center on same side of both flanks
  float disparity = abs(yp - ym) / cs;
  float gate_flank = 1.0 - lr_smoothstep(FLANK0, FLANK1, disparity);   // flanks agree
  float y_wide = y3Tex[gid.xy].r;
  float gate_bg = 1.0 - lr_smoothstep(0.25, 0.55, abs(0.5 * (yp + ym) - y_wide) / cs);
  float wl = S1.x * gate_ridge * gate_flank * gate_bg;

  // ---- composite (strength enters here; sharpen confidence into commitment,
  // orientation-coherence veto AFTER the sharpen) ----
  wl = u.strength * lr_smoothstep(0.10, 0.45, wl) * lr_smoothstep(0.50, 0.80, S1.w);
  float3 outc = lerp(cin.rgb, c_line, saturate(wl));

  outputTex[gid.xy] = float4(saturate(outc), cin.a);
}
