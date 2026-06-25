/**
 * FrameBlitter — copy a GPUTexture to an ImageBitmap, GPU-resident, placing the
 * source frame into the output canvas per a scale mode + placement transform.
 *
 * Bridges a main-thread VideoPlaybackService output texture across the worker
 * boundary: the engine's render device lives in the engine-worker, so a texture
 * decoded on the main thread can't be sampled there directly. An ImageBitmap is
 * the transferable hand-off (same path the old <video> pump used). This is a
 * straight passthrough — unlike TraceCapture it does NOT checkerboard or force
 * opacity, so the engine receives the frame's exact pixels (straight alpha).
 *
 * The placement is a full-canvas quad whose fragment shader maps each output
 * pixel back to a source UV (honouring the scale-mode footprint, anchor, extra
 * scale, quarter-turn rotation and flips); pixels that fall outside the source
 * are left TRANSPARENT so layers below show through. Orientation matches
 * `createImageBitmap(<video>)`: source top row → bitmap top row.
 */

const BLIT_SHADER = /* wgsl */`
  struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
  }
  @vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    var out: VsOut;
    out.pos = vec4f(x, y, 0.0, 1.0);
    // Flip Y: framebuffer origin is top-left, clip-space Y is up → canvas uv
    // (0,0) is the top-left corner.
    out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
    return out;
  }
  // rect = (x, y, w, h) destination in normalised canvas coords; rotFlip =
  // (rot 0..3, flipH, flipV, _pad).
  struct Place { rect: vec4f, rotFlip: vec4f };
  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;
  @group(0) @binding(2) var<uniform> place: Place;
  @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let r = (uv - place.rect.xy) / place.rect.zw;     // rect-local [0,1]
    let rot = i32(place.rotFlip.x + 0.5);
    var s: vec2f;
    if (rot == 1)      { s = vec2f(r.y, 1.0 - r.x); } // 90° CW
    else if (rot == 2) { s = vec2f(1.0 - r.x, 1.0 - r.y); }
    else if (rot == 3) { s = vec2f(1.0 - r.y, r.x); } // 270° CW
    else               { s = r; }
    if (place.rotFlip.y > 0.5) { s.x = 1.0 - s.x; }
    if (place.rotFlip.z > 0.5) { s.y = 1.0 - s.y; }
    // Sample unconditionally (uniform control flow — no branch around the sample),
    // then mask outside-source pixels to transparent.
    let inside = select(0.0, 1.0, s.x >= 0.0 && s.x <= 1.0 && s.y >= 0.0 && s.y <= 1.0);
    return textureSample(src, samp, clamp(s, vec2f(0.0), vec2f(1.0))) * inside;
  }
`;

/** How the source frame scales into the target canvas. */
export type BlitFit = 'fit' | 'cover' | 'stretch' | 'none';

/** Placement transform layered on the scale-mode fit (see model SourceTransform). */
export interface BlitTransform {
  anchorX: number;
  anchorY: number;
  scale: number;
  rotation: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

const IDENTITY: BlitTransform = { anchorX: 0.5, anchorY: 0.5, scale: 1, rotation: 0, flipH: false, flipV: false };

/** Geometry the placement shader needs: destination rect (normalised canvas) +
 *  quarter-turn index + flips. */
export interface PlaceGeom {
  /** [x, y, w, h] in normalised canvas coords; may extend beyond [0,1] (overflow
   *  → clipped) or start negative (panned crop window). */
  rect: [number, number, number, number];
  /** Quarter-turn index 0..3 (×90° clockwise). */
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/**
 * Pure placement geometry. `W`/`H` are the blit target (maybe a downscaled
 * preview); `logicalW`/`logicalH` are the size 'none' reasons about — the
 * composition resolution — so "native pixels" is 1:1 against the COMPOSITION
 * then uniformly scaled into the preview. The base footprint per mode is computed
 * on the ROTATED aspect (a 90°/270° frame fits/covers by its turned bounding box),
 * then `scale` zooms about the centre and the anchor positions it; the same
 * `offset = anchor·(canvas − frame)` formula covers both letterbox (frame smaller)
 * and crop (frame larger) regimes.
 */
export function placeGeom(
  sw: number, sh: number, W: number, H: number, mode: BlitFit,
  xf: BlitTransform = IDENTITY, logicalW = W, logicalH = H,
): PlaceGeom {
  const rot = ((((xf.rotation / 90) | 0) % 4) + 4) % 4; // 0..3
  const rotated = rot === 1 || rot === 3;
  const esw = rotated ? sh : sw; // rotated frame's footprint aspect
  const esh = rotated ? sw : sh;
  let dw: number, dh: number;
  if (sw <= 0 || sh <= 0 || mode === 'stretch') {
    dw = W; dh = H;
  } else if (mode === 'cover') {
    const s = Math.max(W / esw, H / esh); dw = esw * s; dh = esh * s;
  } else if (mode === 'none') {
    dw = esw * (W / Math.max(1, logicalW)); dh = esh * (H / Math.max(1, logicalH));
  } else { // fit (contain)
    const s = Math.min(W / esw, H / esh); dw = esw * s; dh = esh * s;
  }
  const scale = Math.max(1e-3, xf.scale);
  dw *= scale; dh *= scale;
  const dx = xf.anchorX * (W - dw); // anchor 0 = left/top edges, 1 = right/bottom
  const dy = xf.anchorY * (H - dh);
  return { rect: [dx / W, dy / H, dw / W, dh / H], rot, flipH: !!xf.flipH, flipV: !!xf.flipV };
}

/** Test hook — the pure placement geometry. */
export const __placeGeomForTest = placeGeom;

export class FrameBlitter {
  private device: GPUDevice;
  private format: GPUTextureFormat = 'rgba8unorm';
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private canvas: OffscreenCanvas | null = null;
  private ctx: GPUCanvasContext | null = null;
  private w = 0;
  private h = 0;
  private placeBuf: GPUBuffer;

  constructor(device: GPUDevice) {
    this.device = device;
    this.placeBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const m = device.createShaderModule({ code: BLIT_SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: m, entryPoint: 'vs' },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: this.format }] },
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /**
   * Render `srcTexture` (rgba8) to an ImageBitmap of `width × height`, placing the
   * frame per `mode` + `xf`. Areas not covered by the source are left TRANSPARENT
   * so layers below show through.
   */
  toImageBitmap(
    srcTexture: GPUTexture, width: number, height: number, mode: BlitFit = 'stretch',
    xf: BlitTransform = IDENTITY, logicalW = width, logicalH = height,
  ): ImageBitmap {
    if (!this.canvas || this.w !== width || this.h !== height) {
      this.canvas = new OffscreenCanvas(width, height);
      this.ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
      // premultiplied (not opaque) so transparent areas survive.
      this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
      this.w = width;
      this.h = height;
    }
    const g = placeGeom(srcTexture.width, srcTexture.height, width, height, mode, xf, logicalW, logicalH);
    this.device.queue.writeBuffer(this.placeBuf, 0, new Float32Array([
      g.rect[0], g.rect[1], g.rect[2], g.rect[3],
      g.rot, g.flipH ? 1 : 0, g.flipV ? 1 : 0, 0,
    ]));
    const target = this.ctx!.getCurrentTexture();
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTexture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.placeBuf } },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, // transparent
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return this.canvas!.transferToImageBitmap();
  }
}
