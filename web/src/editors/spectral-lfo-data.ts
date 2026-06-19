/**
 * spectral-lfo-data.ts — lazy loader for the editor data asset
 * (/data/spectral_lfo_editor.bin, baked by gen_atlas.mjs).
 *
 * Decodes the shared control points + per-metric Delaunay triangulation, and
 * ties them to spectral-lfo-morph so the inspector can (a) draw the mesh +
 * active triangle on the XY pad and (b) preview the morphed envelope — all
 * client-side, like the web prototype.
 */

import {
  SPEC_N, evaluateCurve, curveToSpectrum, blendSpectra, geometricStraighten,
  barycentric, type Spectrum,
} from './spectral-lfo-morph';

const ASSET_URL = '/data/spectral_lfo_editor.bin';
const MAGIC = 0x31464C53; // 'SLF1'

interface MetricMesh {
  numPts: number;
  numTris: number;
  coords: Float32Array;   // [x0,y0,...] incl. 4 virtual corners (t-SNE space)
  triToData: Uint16Array; // triangulation index → real data index
  tris: Uint16Array;      // numTris*3 indices into coords / triToData
}

export interface MorphResult {
  verts: [number, number, number];
  weights: [number, number, number];
  vertXY: [[number, number], [number, number], [number, number]];
  sources: [Float32Array, Float32Array, Float32Array];
  raw: Float32Array;       // pre-straighten blend (or the single shape)
  curve: Float32Array;     // final envelope, clamped [0,1]
  single: boolean;         // interpolation off → snapped to one shape
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class SpectralLfoData {
  readonly numMetrics: number;
  readonly numEntries: number;
  private cpX: Float32Array;
  private cpY: Float32Array;
  private cpF: Float32Array;
  private entryOffset: Uint32Array;
  private entryNcp: Uint16Array;
  private metrics: MetricMesh[];

  private constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    let p = 0;
    const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
    const u32a = (n: number) => { const a = new Uint32Array(buf.slice(p, p + n * 4)); p += n * 4; return a; };
    const u16a = (n: number) => { const a = new Uint16Array(buf.slice(p, p + n * 2)); p += n * 2; return a; };
    const u8a = (n: number) => { const a = new Uint8Array(buf.slice(p, p + n)); p += n; return a; };
    const f32a = (n: number) => { const a = new Float32Array(buf.slice(p, p + n * 4)); p += n * 4; return a; };

    if (i32() !== MAGIC) throw new Error('spectral_lfo: bad asset magic');
    this.numMetrics = i32();
    this.numEntries = i32();
    const totalCP = i32();

    this.entryOffset = u32a(this.numEntries);
    this.entryNcp = u16a(this.numEntries);
    const cpXq = u16a(totalCP), cpYq = u8a(totalCP), cpFq = u8a(totalCP);
    this.cpX = new Float32Array(totalCP); this.cpY = new Float32Array(totalCP); this.cpF = new Float32Array(totalCP);
    for (let i = 0; i < totalCP; i++) { this.cpX[i] = cpXq[i] / 65535; this.cpY[i] = cpYq[i] / 255; this.cpF[i] = cpFq[i] / 255; }

    this.metrics = [];
    for (let m = 0; m < this.numMetrics; m++) {
      const numPts = u32a(1)[0], numTris = u32a(1)[0];
      const coords = f32a(numPts * 2);
      const triToData = u16a(numPts);
      const tris = u16a(numTris * 3);
      this.metrics.push({ numPts, numTris, coords, triToData, tris });
    }
  }

  static async load(): Promise<SpectralLfoData> {
    const resp = await fetch(ASSET_URL);
    if (!resp.ok) throw new Error(`spectral_lfo: asset fetch failed (${resp.status})`);
    return new SpectralLfoData(await resp.arrayBuffer());
  }

  mesh(metric: number): MetricMesh {
    return this.metrics[Math.max(0, Math.min(this.numMetrics - 1, metric | 0))];
  }

  private evalEntry(entry: number): Float32Array {
    const off = this.entryOffset[entry], np = this.entryNcp[entry];
    return evaluateCurve(
      this.cpX.subarray(off, off + np),
      this.cpY.subarray(off, off + np),
      this.cpF.subarray(off, off + np),
      np, SPEC_N);
  }

  private findTriangle(metric: number, tx: number, ty: number):
      { verts: [number, number, number]; weights: [number, number, number] } | null {
    const { coords, tris, triToData, numTris } = this.mesh(metric);
    for (let t = 0; t < numTris; t++) {
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      const bc = barycentric(tx, ty,
        coords[a * 2], coords[a * 2 + 1], coords[b * 2], coords[b * 2 + 1], coords[c * 2], coords[c * 2 + 1]);
      if (bc && bc[0] >= -0.001 && bc[1] >= -0.001 && bc[2] >= -0.001) {
        const w0 = Math.max(0, bc[0]), w1 = Math.max(0, bc[1]), w2 = Math.max(0, bc[2]);
        const s = w0 + w1 + w2;
        return { verts: [triToData[a], triToData[b], triToData[c]], weights: [w0 / s, w1 / s, w2 / s] };
      }
    }
    return null;
  }

  private nearest(metric: number, tx: number, ty: number): number {
    const { coords } = this.mesh(metric);
    let best = Infinity, bestIdx = 0;
    for (let i = 0; i < this.numEntries; i++) {
      const dx = coords[i * 2] - tx, dy = coords[i * 2 + 1] - ty;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bestIdx = i; }
    }
    return bestIdx;
  }

  /** Lightweight triangle lookup (no morph) for the pad's active-triangle. */
  triangleAt(metric: number, x: number, y: number): [[number, number], [number, number], [number, number]] | null {
    const hit = this.findTriangle(metric, x, y);
    if (!hit) return null;
    const { coords } = this.mesh(metric);
    return [
      [coords[hit.verts[0] * 2], coords[hit.verts[0] * 2 + 1]],
      [coords[hit.verts[1] * 2], coords[hit.verts[1] * 2 + 1]],
      [coords[hit.verts[2] * 2], coords[hit.verts[2] * 2 + 1]],
    ];
  }

  /** Mirror of the module's recompute(): triangle lookup → morph → clean. */
  computeMorph(metric: number, x: number, y: number, interpolation: boolean): MorphResult {
    const hit = this.findTriangle(metric, x, y);
    const verts: [number, number, number] = hit ? hit.verts : (() => { const n = this.nearest(metric, x, y); return [n, n, n]; })();
    const weights: [number, number, number] = hit ? hit.weights : [1, 0, 0];

    const { coords } = this.mesh(metric);
    const vertXY: MorphResult['vertXY'] = [
      [coords[verts[0] * 2], coords[verts[0] * 2 + 1]],
      [coords[verts[1] * 2], coords[verts[1] * 2 + 1]],
      [coords[verts[2] * 2], coords[verts[2] * 2 + 1]],
    ];
    const sources: [Float32Array, Float32Array, Float32Array] =
      [this.evalEntry(verts[0]), this.evalEntry(verts[1]), this.evalEntry(verts[2])];

    if (!interpolation) {
      let bi = 0;
      if (weights[1] > weights[bi]) bi = 1;
      if (weights[2] > weights[bi]) bi = 2;
      const curve = sources[bi];
      return { verts, weights, vertXY, sources, raw: curve, curve, single: true };
    }

    const spectra: [Spectrum, Spectrum, Spectrum] =
      [curveToSpectrum(sources[0]), curveToSpectrum(sources[1]), curveToSpectrum(sources[2])];
    const raw = blendSpectra(spectra, weights, /*sigma=*/0, /*phaseCoherence=*/1);
    const curve = geometricStraighten(raw, 1);
    for (let i = 0; i < curve.length; i++) curve[i] = clamp01(curve[i]);
    return { verts, weights, vertXY, sources, raw, curve, single: false };
  }
}

// Module-level cached singleton (one fetch shared by every inspector instance).
let cached: Promise<SpectralLfoData> | null = null;
export function loadSpectralLfoData(): Promise<SpectralLfoData> {
  if (!cached) cached = SpectralLfoData.load();
  return cached;
}
