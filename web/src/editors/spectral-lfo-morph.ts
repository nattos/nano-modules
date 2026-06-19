/**
 * spectral-lfo-morph.ts — client-side mirror of the native spectral_morph.h
 * (itself a port of nano-lfo's lfo_spectral_morph.ts). Used by the custom
 * inspector to preview the morphed envelope and to locate the active triangle,
 * exactly like the web prototype.
 *
 * Only the default-on path is implemented: blendSpectra (Lanczos sigma + phase
 * coherence) + geometricStraighten. Matches the module's locked options.
 */

export const SPEC_N = 2048;

// ─── FFT (radix-2 in-place) ────────────────────────────────────────────
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const angle = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

// ─── Curve evaluation (Serum power-curve easing) ───────────────────────
export function evaluateCurve(px: Float32Array, py: Float32Array, pf: Float32Array,
                              np: number, n: number): Float32Array {
  const out = new Float32Array(n);
  if (np < 2) { out.fill(0.5); return out; }
  for (let s = 0; s < n; s++) {
    const t = s / (n - 1);
    let seg = 0;
    for (let i = 0; i < np - 1; i++) if (px[i] <= t) seg = i;
    const i1 = Math.min(seg + 1, np - 1);
    const dx = px[i1] - px[seg];
    if (dx < 1e-10) { out[s] = py[seg]; continue; }
    let lt = Math.max(0, Math.min(1, (t - px[seg]) / dx));
    if (Math.abs(pf[seg] - 0.5) > 0.001) {
      const power = Math.pow(2, 2 * (1 - pf[seg]) - 1);
      lt = lt > 0 ? Math.pow(lt, power) : 0;
    }
    out[s] = py[seg] + (py[i1] - py[seg]) * lt;
  }
  return out;
}

export interface Spectrum { mag: Float64Array; phase: Float64Array; }

export function curveToSpectrum(curve: Float32Array): Spectrum {
  const re = new Float64Array(SPEC_N), im = new Float64Array(SPEC_N);
  for (let i = 0; i < SPEC_N; i++) re[i] = curve[i];
  fft(re, im);
  const mag = new Float64Array(SPEC_N), phase = new Float64Array(SPEC_N);
  for (let i = 0; i < SPEC_N; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    phase[i] = Math.atan2(im[i], re[i]);
  }
  return { mag, phase };
}

// ─── Barycentric spectral blend + IFFT ─────────────────────────────────
export function blendSpectra(specs: [Spectrum, Spectrum, Spectrum],
                             weights: [number, number, number],
                             sigma: number, phaseCoherence: number): Float32Array {
  const re = new Float64Array(SPEC_N), im = new Float64Array(SPEC_N);
  const half = SPEC_N / 2;
  for (let k = 0; k < SPEC_N; k++) {
    const mag = weights[0] * specs[0].mag[k] + weights[1] * specs[1].mag[k] + weights[2] * specs[2].mag[k];
    let pRe = 0, pIm = 0;
    for (let v = 0; v < 3; v++) { pRe += weights[v] * Math.cos(specs[v].phase[k]); pIm += weights[v] * Math.sin(specs[v].phase[k]); }
    const ph = Math.atan2(pIm, pRe);
    let sf = 1.0;
    if (sigma > 0 && k > 0) {
      const kn = k <= half ? k : SPEC_N - k;
      const x = Math.PI * kn / half;
      sf = 1.0 - sigma * (1.0 - Math.sin(x) / x);
    }
    if (phaseCoherence > 0 && k > 0) {
      const coherence = Math.sqrt(pRe * pRe + pIm * pIm);
      sf *= 1.0 - phaseCoherence * (1.0 - coherence);
    }
    re[k] = sf * mag * Math.cos(ph);
    im[k] = sf * mag * Math.sin(ph);
  }
  fft(re, im, true);
  const out = new Float32Array(SPEC_N);
  for (let i = 0; i < SPEC_N; i++) out[i] = re[i];
  return out;
}

// ─── Geometric straightening ───────────────────────────────────────────
const GEO_SMOOTH_W = 12, GEO_EXTREMA_TOL = 0.015, GEO_SLOPE_THRESH = 0.25;
const GEO_STEP_THRESH = 0.08, GEO_STEP_SPAN = 12, GEO_MIN_NODE_DIST = 16;

const CANDIDATE_POWERS = (() => {
  const ps: number[] = [];
  for (let k = 0; k <= 28; k++) { const f = 0.15 + k * 0.025; ps.push(Math.pow(2, 2 * (1 - f) - 1)); }
  return ps.sort((a, b) => a - b);
})();

function boxSmooth(curve: Float32Array, w: number): Float32Array {
  const N = curve.length;
  const prefix = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) prefix[i + 1] = prefix[i] + curve[i];
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const lo = Math.max(0, i - w), hi = Math.min(N, i + w + 1);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

function fitSegmentPower(curve: Float32Array, a: number, b: number, ya: number, yb: number): number {
  const len = b - a;
  if (len < 4) return 1.0;
  const dy = yb - ya;
  if (Math.abs(dy) < 1e-6) return 1.0;
  let bestPower = 1.0, bestErr = Infinity;
  for (const power of CANDIDATE_POWERS) {
    let err = 0;
    for (let i = a; i <= b; i++) {
      const t = (i - a) / len;
      const d = curve[i] - (ya + dy * (t > 0 ? Math.pow(t, power) : 0));
      err += d * d;
    }
    if (err < bestErr) { bestErr = err; bestPower = power; }
  }
  return bestPower;
}

function detectNodes(curve: Float32Array): number[] {
  const N = curve.length;
  const mark = new Uint8Array(N);
  mark[0] = 1; mark[N - 1] = 1;
  const smooth = boxSmooth(curve, GEO_SMOOTH_W);
  for (let i = 1; i < N - 1; i++) {
    const isPeak = smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1] && smooth[i] > smooth[i - 1] + 1e-6;
    const isValley = smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1] && smooth[i] < smooth[i - 1] - 1e-6;
    if (!isPeak && !isValley) continue;
    let leftDepth = 0, rightDepth = 0;
    if (isPeak) {
      let minL = smooth[i]; for (let j = i - 1; j >= 0; j--) { minL = Math.min(minL, smooth[j]); if (smooth[j] > smooth[i]) break; } leftDepth = smooth[i] - minL;
      let minR = smooth[i]; for (let j = i + 1; j < N; j++) { minR = Math.min(minR, smooth[j]); if (smooth[j] > smooth[i]) break; } rightDepth = smooth[i] - minR;
    } else {
      let maxL = smooth[i]; for (let j = i - 1; j >= 0; j--) { maxL = Math.max(maxL, smooth[j]); if (smooth[j] < smooth[i]) break; } leftDepth = maxL - smooth[i];
      let maxR = smooth[i]; for (let j = i + 1; j < N; j++) { maxR = Math.max(maxR, smooth[j]); if (smooth[j] < smooth[i]) break; } rightDepth = maxR - smooth[i];
    }
    if (Math.min(leftDepth, rightDepth) >= GEO_EXTREMA_TOL) mark[i] = 1;
  }
  for (let i = GEO_STEP_SPAN; i < N - GEO_STEP_SPAN; i++) {
    if (Math.abs(smooth[i + GEO_STEP_SPAN] - smooth[i - GEO_STEP_SPAN]) > GEO_STEP_THRESH) {
      let maxSlope = 0, maxJ = i;
      for (let j = i - GEO_STEP_SPAN; j < i + GEO_STEP_SPAN; j++) {
        const s = Math.abs(smooth[Math.min(N - 1, j + 1)] - smooth[Math.max(0, j)]);
        if (s > maxSlope) { maxSlope = s; maxJ = j; }
      }
      mark[Math.max(0, maxJ - 2)] = 1; mark[Math.min(N - 1, maxJ + 2)] = 1;
    }
  }
  const d1 = new Float32Array(N);
  for (let i = 1; i < N; i++) d1[i] = smooth[i] - smooth[i - 1];
  const d1s = boxSmooth(d1, GEO_SMOOTH_W);
  for (let i = GEO_SMOOTH_W + 1; i < N - GEO_SMOOTH_W - 1; i++) {
    if (Math.abs(d1s[i + 1] - d1s[i - 1]) > GEO_SLOPE_THRESH / N) mark[i] = 1;
  }
  const nodes: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!mark[i]) continue;
    if (nodes.length === 0 || i - nodes[nodes.length - 1] >= GEO_MIN_NODE_DIST) nodes.push(i);
  }
  if (nodes.length === 0 || nodes[nodes.length - 1] !== N - 1) nodes.push(N - 1);
  return nodes;
}

export function geometricStraighten(spectral: Float32Array, strength: number): Float32Array {
  const N = spectral.length;
  if (strength <= 0) return new Float32Array(spectral);
  const nodes = detectNodes(spectral);
  const eased = new Float32Array(N);
  for (let seg = 0; seg + 1 < nodes.length; seg++) {
    const a = nodes[seg], b = nodes[seg + 1];
    const ya = spectral[a], yb = spectral[b], len = b - a;
    const power = fitSegmentPower(spectral, a, b, ya, yb);
    const dy = yb - ya;
    for (let i = a; i <= b; i++) { const t = (i - a) / len; eased[i] = ya + dy * (t > 0 ? Math.pow(t, power) : 0); }
  }
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = spectral[i] * (1 - strength) + eased[i] * strength;
  return out;
}

// ─── Barycentric coordinates ───────────────────────────────────────────
export function barycentric(px: number, py: number, ax: number, ay: number,
                            bx: number, by: number, cx: number, cy: number): [number, number, number] | null {
  const v0x = bx - ax, v0y = by - ay, v1x = cx - ax, v1y = cy - ay, v2x = px - ax, v2y = py - ay;
  const d00 = v0x * v0x + v0y * v0y, d01 = v0x * v1x + v0y * v1y, d11 = v1x * v1x + v1y * v1y;
  const d20 = v2x * v0x + v2y * v0y, d21 = v2x * v1x + v2y * v1y;
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return null;
  const v = (d11 * d20 - d01 * d21) / denom, w = (d00 * d21 - d01 * d20) / denom;
  return [1 - v - w, v, w];
}
