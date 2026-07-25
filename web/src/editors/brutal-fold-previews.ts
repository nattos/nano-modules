/**
 * Live tone-map preview widgets for source.brutal_fold.
 *
 *  <brutal-fold-diffuse-preview> — long & squat. Four axonometric prisms (the
 *    four extrusion levels); each has a front face, a shadowed side and a
 *    highlight top, shaded through the DIFFUSE tone map (replicated on the CPU,
 *    so it matches the shader exactly).
 *
 *  <brutal-fold-fog-preview> — square. Five depth slices splayed up-and-right
 *    (~30°, skewed as if the camera is angled), semi-transparent. Each slice is
 *    rendered on the GPU (WebGPU) with the REAL fog colour AND the volumetric
 *    blob's per-pixel density at that depth — so you see the blob's actual 3D
 *    shape sliced across the panels, live with drift. A "peel" slider hides the
 *    foreground slices so you can inspect the back ones.
 */

import { html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding } from '../widgets/field-editor';
import { requestStandardDevice } from '../webgpu-device';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// HSV→RGB (matches shaders_common nano_hsv_to_rgb). h,s,v in [0,1] → [0,1]³.
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// 3-control-point quadratic (Lagrange knots at 0, 0.5, 1) — mirrors bf_quad3.
function quad3(v0: number, v1: number, v2: number, t: number): number {
  t = clamp01(t);
  return v0 * (2 * t - 1) * (t - 1) + v1 * -4 * t * (t - 1) + v2 * t * (2 * t - 1);
}

// The render's three diffuse tone LEVELS (shadow≈0, front, top). Remap so the
// grade's 0/0.5/1 knots land on them — mirrors bf_toneNorm in common.hlsl.
const TONE_FRONT = 0.33, TONE_TOP = 0.62;
function toneNorm(t: number): number {
  if (t < TONE_FRONT) return 0.5 * t / TONE_FRONT;
  return clamp01(0.5 + 0.5 * (t - TONE_FRONT) / (TONE_TOP - TONE_FRONT));
}

@customElement('brutal-fold-diffuse-preview')
export class BrutalFoldDiffusePreview extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;
  private rafId = 0;

  static styles = css`
    :host { display: block; }
    .group-label {
      font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding-bottom: 2px;
    }
    canvas {
      width: 100%; height: 58px; display: block; border-radius: 1px;
      border: 1px solid var(--app-border-color, #3a3346); background: #0e0c12;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => { this.rafId = requestAnimationFrame(tick); this.draw(); };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private draw() {
    const cv = this.renderRoot?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!cv || !this.binding) return;
    const b = this.binding;
    const num = (name: string, d: number) => {
      const v = b.getValue(name);
      return typeof v === 'number' ? v : d;
    };
    const hLo = num('diff_hue_lo', 0.58), hMid = num('diff_hue_mid', 0.08), hHi = num('diff_hue_hi', 0.11);
    const sOverall = num('diff_sat', 0);
    const sLo = num('diff_sat_lo', 1), sMid = num('diff_sat_mid', 1), sHi = num('diff_sat_hi', 1);
    const bLo = num('diff_bri_lo', 1), bMid = num('diff_bri_mid', 1), bHi = num('diff_bri_hi', 1);

    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Mirrors bf_gradeDiffuse: per-knot hue/sat/brightness over toneNorm(t).
    const grade = (tone: number) => {
      const tn = toneNorm(clamp01(tone));
      const hue = quad3(hLo, hMid, hHi, tn);
      const sat = clamp01(sOverall * quad3(sLo, sMid, sHi, tn));
      const bri = quad3(bLo, bMid, bHi, tn);
      const [r, g, b2] = hsvToRgb(hue, sat, 1);
      const v = clamp01(tone * bri);
      const to255 = (c: number) => Math.round(clamp01(v * c) * 255);
      return `rgb(${to255(r)}, ${to255(g)}, ${to255(b2)})`;
    };

    // The render produces three clustered diffuse tone LEVELS (from the atlas
    // sky/face): shadow/side ≈ 0, front ≈ 0.33, top/highlight ≈ 0.62. One quad
    // per level; the grade's Shadows/Mids/Highs land on them via toneNorm.
    const baseTones = [0.06, 0.33, 0.62];

    const n = baseTones.length;
    const slotW = W / n;
    const pad = Math.min(slotW, H) * 0.16;
    type P = [number, number];
    const poly = (pts: P[]) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.closePath();
    };
    const lerpP = (a: P, b: P, t: number): P => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

    for (let i = 0; i < n; i++) {
      const base = baseTones[i];
      const x0 = slotW * i + pad, y0 = pad;
      const w = slotW - pad * 2, h = H - pad * 2;
      // Deterministic per-shape jitter → a slightly random quad (not a rectangle).
      const rnd = (k: number) => {
        const s = Math.sin((i * 9.73 + k * 4.31)) * 43758.5453;
        return (s - Math.floor(s)) - 0.5;
      };
      const jx = w * 0.14, jy = h * 0.14, shear = w * 0.16; // top sheared right
      const TL: P = [x0 + shear + rnd(0) * jx, y0 + rnd(1) * jy];
      const TR: P = [x0 + w + shear + rnd(2) * jx, y0 + rnd(3) * jy];
      const BR: P = [x0 + w + rnd(4) * jx, y0 + h + rnd(5) * jy];
      const BL: P = [x0 + rnd(6) * jx, y0 + h + rnd(7) * jy];

      // Base quad.
      ctx.fillStyle = grade(base);
      poly([TL, TR, BR, BL]); ctx.fill();

      // Shadow: a parallelogram WITHIN the quad (inset + nudged toward BR, as if
      // an embossed recession band), darker than the base.
      const ctr: P = [(TL[0] + TR[0] + BR[0] + BL[0]) / 4, (TL[1] + TR[1] + BR[1] + BL[1]) / 4];
      const off: P = [w * 0.16, h * 0.16];
      const inset = (p: P): P => {
        const q = lerpP(p, ctr, 0.30);
        return [q[0] + off[0], q[1] + off[1]];
      };
      ctx.fillStyle = grade(base - 0.22);
      poly([inset(TL), inset(TR), inset(BR), inset(BL)]); ctx.fill();

      // Highlight: just ONE border edge of the quad (the top), drawn brighter.
      ctx.strokeStyle = grade(base + 0.24);
      ctx.lineWidth = Math.max(2, h * 0.06);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(TL[0], TL[1]);
      ctx.lineTo(TR[0], TR[1]);
      ctx.stroke();
    }
  }

  render() {
    return html`<div class="group-label">Diffuse tone map (shadow · front · highlight)</div>
      <canvas></canvas>`;
  }
}

// --- WebGPU plumbing for the fog preview (shared device + pipeline) ----------

const FOG_WGSL = /* wgsl */ `
struct U { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f, f: vec4f };
// a = (fog_hue_lo, fog_hue_mid, fog_hue_hi, fog_sat overall)
// b = (sky, vol_amount, N, peel)
// c = (anchor_x, anchor_y, anchor_z, shape)
// d = (angle, radius, softness_xy, depth)
// e = (fog_strength, softness_z, _, _)
// f = (fog_sat_lo, fog_sat_mid, fog_sat_hi, _)   per-knot fog saturation
@group(0) @binding(0) var<uniform> u: U;

fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3f {
  let hh = fract(h) * 6.0;
  let i = floor(hh);
  let f = hh - i;
  let p = v * (1.0 - s);
  let q = v * (1.0 - f * s);
  let t = v * (1.0 - (1.0 - f) * s);
  let idx = i32(i) % 6;
  if (idx == 0) { return vec3f(v, t, p); }
  if (idx == 1) { return vec3f(q, v, p); }
  if (idx == 2) { return vec3f(p, v, t); }
  if (idx == 3) { return vec3f(p, q, v); }
  if (idx == 4) { return vec3f(t, p, v); }
  return vec3f(v, p, q);
}
fn quad3(v0: f32, v1: f32, v2: f32, t0: f32) -> f32 {
  let t = clamp(t0, 0.0, 1.0);
  return v0 * (2.0 * t - 1.0) * (t - 1.0) + v1 * (-4.0 * t) * (t - 1.0) + v2 * t * (2.0 * t - 1.0);
}
fn gradeFog(depthT: f32) -> vec3f {
  let hue = quad3(u.a.x, u.a.y, u.a.z, depthT);
  let sat = u.a.w * quad3(u.f.x, u.f.y, u.f.z, depthT);   // overall × per-knot
  return u.b.x * hsv2rgb(hue, clamp(sat, 0.0, 1.0), 1.0);
}
// Mirrors bf_blob3 EXACTLY: XY disk × Z slab (separate softness), morphed by shape.
fn blob3(p: vec2f, dz: f32) -> f32 {
  let rxy = length(vec2f(p.x - u.c.x, p.y - u.c.y));
  let rz = abs(dz - u.c.z);
  let radius = u.d.y;
  let softXY = max(u.d.z, 1e-4);
  let depth = u.d.w;
  let softZ = max(u.e.y, 1e-4);
  // XY profile: solid → oriented band → radial disk.
  let ang = u.d.x * 6.2831853;
  let uu = (p.x - u.c.x) * cos(ang) + (p.y - u.c.y) * sin(ang);
  let xy_band = 1.0 - smoothstep(radius, radius + softXY, abs(uu));
  let xy_disk = 1.0 - smoothstep(radius, radius + softXY, rxy);
  let a = abs(u.c.w);
  var xy = mix(1.0, xy_band, clamp(a / 0.5, 0.0, 1.0));
  xy = mix(xy, xy_disk, clamp((a - 0.5) * 2.0, 0.0, 1.0));
  // Z window applies to every shape.
  let dZ = 1.0 - smoothstep(depth, depth + softZ, rz);
  var dens = xy * dZ;
  if (u.c.w < 0.0) { dens = 1.0 - dens; }
  return dens;
}
// Mirrors bf_fogAmount EXACTLY: distance base + ungated blob ADD (front works) and
// proportional CUT. vol_amount=0 → pure distance fog.
fn fogAmount(p: vec2f, depthLin: f32) -> f32 {
  let dens = blob3(p, depthLin);
  let baseRaw = u.e.x * depthLin;
  let s = 2.0 * dens - 1.0;
  let add = u.b.y * max(s, 0.0);
  let cut = u.b.y * max(-s, 0.0);
  return clamp(baseRaw * (1.0 - cut) + add, 0.0, 1.0);
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) depthT: f32,
  @location(2) vis: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let corner = corners[vi];
  let N = u.b.z;
  let depthIndex = (N - 1.0) - f32(inst);   // 0 = near (drawn last), N-1 = far
  let z = depthIndex;
  let persp = 1.0 - z * 0.08;               // far slices a touch smaller
  let s = 0.27 * persp;                      // panel half-size
  let step = 0.115;                          // depth spacing
  let dirx = 0.8660254;                      // recede up-and-right ~30°
  let diry = 0.5;
  // Centre the MIDDLE slice on the canvas (y-up normalized coords). Upright
  // squares (no shear) splayed along the depth direction.
  let zc = (N - 1.0) * 0.5;
  let cxr = 0.5 - zc * step * dirx + z * step * dirx;
  let cyr = 0.5 - zc * step * diry + z * step * diry;
  let nx = cxr + corner.x * s;
  let ny = cyr + corner.y * s;
  var o: VSOut;
  o.pos = vec4f(nx * 2.0 - 1.0, ny * 2.0 - 1.0, 0.0, 1.0);
  o.uv = corner;
  o.depthT = depthIndex / max(N - 1.0, 1.0);
  o.vis = select(0.0, 1.0, depthIndex >= u.b.w * (N - 1.0) - 0.001);
  return o;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  // Same fog amount the main render computes; the fog colour is indexed by it
  // (matching bf_gradeFog(sky, fogv)). A small base keeps empty slices visible.
  let fogv = fogAmount(in.uv, in.depthT);
  let col = gradeFog(in.depthT);   // hue by DEPTH (not the blob-modulated amount)
  let alpha = clamp(0.05 + fogv * 0.9, 0.0, 0.96) * in.vis;
  return vec4f(col, alpha);
}
`;

interface FogGpu {
  device: GPUDevice;
  format: GPUTextureFormat;
  pipeline: GPURenderPipeline;
}
let s_fogGpu: Promise<FogGpu | null> | null = null;
function getFogGpu(): Promise<FogGpu | null> {
  if (s_fogGpu) return s_fogGpu;
  s_fogGpu = (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      const device = await requestStandardDevice(adapter);
      const format = navigator.gpu.getPreferredCanvasFormat();
      const module = device.createShaderModule({ code: FOG_WGSL });
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module, entryPoint: 'fs',
          targets: [{
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
      });
      return { device, format, pipeline };
    } catch {
      return null;
    }
  })();
  return s_fogGpu;
}

@customElement('brutal-fold-fog-preview')
export class BrutalFoldFogPreview extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;
  @state() private slice = 0;   // 0 = show all; →1 hides foreground slices
  @state() private failed = false;
  private rafId = 0;

  private gpu: FogGpu | null = null;
  private ctx: GPUCanvasContext | null = null;
  private uniformBuf: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private readonly uData = new Float32Array(24);
  private readonly N = 5;

  static styles = css`
    :host { display: block; }
    .group-label {
      font-size: var(--app-fs-sm); color: var(--app-text-color2, #b0b0b0); padding-bottom: 2px;
    }
    .fog-wrap {
      position: relative; width: 100%; aspect-ratio: 1 / 1; border-radius: 1px;
      border: 1px solid var(--app-border-color, #3a3346); overflow: hidden;
    }
    .fog-wrap canvas { width: 100%; height: 100%; display: block; background: #0b0a0f; }
    /* The infinite-sky colour shown only as a thin bar along the bottom. */
    .sky-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 5%; }
    .note { font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0); padding: 8px 0; }
    .slice-row {
      display: flex; align-items: center; gap: 6px; margin-top: 4px;
      font-size: var(--app-fs-xs); color: var(--app-text-color2, #b0b0b0);
    }
    .slice-row input { flex: 1; }
  `;

  connectedCallback() {
    super.connectedCallback();
    const tick = () => { this.rafId = requestAnimationFrame(tick); void this.draw(); };
    this.rafId = requestAnimationFrame(tick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private readNum(name: string, fallback: number): number {
    const v = this.binding?.getValue(name);
    return typeof v === 'number' ? v : fallback;
  }

  private async ensureGpu(cv: HTMLCanvasElement): Promise<boolean> {
    if (this.gpu) return true;
    if (this.failed) return false;
    const gpu = await getFogGpu();
    if (!gpu) { this.failed = true; return false; }
    const ctx = cv.getContext('webgpu');
    if (!ctx) { this.failed = true; return false; }
    ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
    this.uniformBuf = gpu.device.createBuffer({
      size: this.uData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = gpu.device.createBindGroup({
      layout: gpu.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }],
    });
    this.ctx = ctx;
    this.gpu = gpu;
    return true;
  }

  private async draw() {
    const cv = this.renderRoot?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!cv || !this.binding) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.max(1, Math.round(cv.clientWidth * dpr));
    if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }

    if (!(await this.ensureGpu(cv)) || !this.gpu || !this.ctx || !this.uniformBuf || !this.bindGroup) {
      return;
    }
    const SKY = 0.85;
    const u = this.uData;
    u[0] = this.readNum('fog_hue_lo', 0.55);
    u[1] = this.readNum('fog_hue_mid', 0.6);
    u[2] = this.readNum('fog_hue_hi', 0.66);
    u[3] = this.readNum('fog_sat', 0);
    u[4] = SKY;
    u[5] = this.readNum('vol_amount', 0);
    u[6] = this.N;
    u[7] = this.slice;
    // Live (drifted) blob values broadcast by the effect (fall back to inputs).
    u[8] = this.readNum('vol_x_live', this.readNum('vol_anchor_x', 0));
    u[9] = this.readNum('vol_y_live', this.readNum('vol_anchor_y', 0));
    u[10] = this.readNum('vol_z_live', this.readNum('vol_z', 0.5));
    u[11] = this.readNum('vol_shape_live', this.readNum('vol_shape', 1));
    u[12] = this.readNum('vol_angle_live', this.readNum('vol_angle', 0));
    // Normalized sliders → shader's actual ranges (match main.cpp kVol*Max).
    u[13] = this.readNum('vol_radius', 0.5) * 2.0;
    u[14] = this.readNum('vol_softness_xy', 0.5) * 2.0;
    u[15] = this.readNum('vol_depth', 0.5) * 0.6;
    // Representative fog strength (the per-cell atlas fog isn't known here; the
    // `fog` param is the user multiplier). Stand-in for the shader's clamped fog.
    u[16] = clamp01(this.readNum('fog', 1) * 0.7);
    u[17] = this.readNum('vol_softness_z', 0.5) * 1.0;
    // f: per-knot fog saturation (near / mid / far).
    const fsLo = this.readNum('fog_sat_lo', 1), fsMid = this.readNum('fog_sat_mid', 1),
          fsHi = this.readNum('fog_sat_hi', 1);
    u[20] = fsLo; u[21] = fsMid; u[22] = fsHi;

    // Background = the infinite sky: far fog grade + the relative sky twist
    // (mirrors bf_gradeSky). Far hue/sat = the fog grade at depthT=1.
    const farHue = u[2];                       // quad3(...,1) = hi
    const farSat = u[3] * fsHi;                // overall × per-knot far sat
    const skyHue = (farHue + this.readNum('sky_hue', 0)) % 1;
    const skySat = clamp01(farSat + this.readNum('sky_sat', 0));
    const skyVal = clamp01(SKY * this.readNum('sky_bri', 1));
    const [skR, skG, skB] = hsvToRgb((skyHue + 1) % 1, skySat, skyVal);
    // Show the sky colour only as a thin bottom bar (a full-canvas sky was
    // overwhelming, especially when white). The canvas clears to neutral dark.
    const bar = this.renderRoot?.querySelector('.sky-bar') as HTMLElement | null;
    if (bar) {
      const u8 = (c: number) => Math.round(clamp01(c) * 255);
      bar.style.background = `rgb(${u8(skR)}, ${u8(skG)}, ${u8(skB)})`;
    }

    const { device, pipeline } = this.gpu;
    device.queue.writeBuffer(this.uniformBuf, 0, u);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0.043, g: 0.039, b: 0.06, a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6, this.N);   // 6 verts × N slice instances
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  render() {
    return html`
      <div class="group-label">Fog volume by depth (near → far)</div>
      ${this.failed
        ? html`<div class="note">WebGPU unavailable — fog preview disabled.</div>`
        : html`<div class="fog-wrap"><canvas></canvas><div class="sky-bar"></div></div>
          <div class="slice-row">
            <span>peel</span>
            <input type="range" min="0" max="1" step="0.01" .value=${String(this.slice)}
              @input=${(e: Event) => { this.slice = parseFloat((e.target as HTMLInputElement).value); }} />
          </div>`}
    `;
  }
}
