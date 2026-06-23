/**
 * FrameBlitter — copy a GPUTexture to an ImageBitmap, GPU-resident.
 *
 * Bridges a main-thread VideoPlaybackService output texture across the
 * worker boundary: the engine's render device lives in the engine-worker,
 * so a texture decoded on the main thread can't be sampled there directly.
 * An ImageBitmap is the transferable hand-off (same path the old <video>
 * pump used). This is a straight passthrough — unlike TraceCapture it does
 * NOT checkerboard or force opacity, so the engine receives the frame's
 * exact pixels (the pipeline assumes straight alpha throughout).
 *
 * Orientation matches `createImageBitmap(<video>)`: texture top row →
 * bitmap top row, so the worker's `copyExternalImageToTexture(flipY:false)`
 * lands it upright.
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
    // Flip Y: framebuffer origin is top-left, clip-space Y is up.
    out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
    return out;
  }
  struct Xform { uvOff: vec2f, uvScale: vec2f };
  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;
  @group(0) @binding(2) var<uniform> xf: Xform;
  @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(src, samp, xf.uvOff + uv * xf.uvScale);
  }
`;

/** How the source frame scales into the target canvas. */
export type BlitFit = 'fit' | 'cover' | 'stretch' | 'none';

/** Destination viewport rect (px) + source UV region for a fit mode. */
function blitGeom(sw: number, sh: number, W: number, H: number, mode: BlitFit) {
  if (sw <= 0 || sh <= 0 || mode === 'stretch') {
    return { vx: 0, vy: 0, vw: W, vh: H, uOff: [0, 0], uScale: [1, 1] };
  }
  if (mode === 'cover') {
    const s = Math.max(W / sw, H / sh);
    const uw = W / (sw * s), uh = H / (sh * s);
    return { vx: 0, vy: 0, vw: W, vh: H, uOff: [(1 - uw) / 2, (1 - uh) / 2], uScale: [uw, uh] };
  }
  if (mode === 'none') {
    const dw = Math.min(sw, W), dh = Math.min(sh, H);
    const uw = dw / sw, uh = dh / sh;
    return { vx: (W - dw) / 2, vy: (H - dh) / 2, vw: dw, vh: dh, uOff: [(1 - uw) / 2, (1 - uh) / 2], uScale: [uw, uh] };
  }
  // fit (contain)
  const s = Math.min(W / sw, H / sh);
  const dw = sw * s, dh = sh * s;
  return { vx: (W - dw) / 2, vy: (H - dh) / 2, vw: dw, vh: dh, uOff: [0, 0], uScale: [1, 1] };
}

/** Test hook — the pure scale-mode geometry. */
export const __blitGeomForTest = blitGeom;

export class FrameBlitter {
  private device: GPUDevice;
  private format: GPUTextureFormat = 'rgba8unorm';
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private canvas: OffscreenCanvas | null = null;
  private ctx: GPUCanvasContext | null = null;
  private w = 0;
  private h = 0;
  private xformBuf: GPUBuffer;

  constructor(device: GPUDevice) {
    this.device = device;
    this.xformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const m = device.createShaderModule({ code: BLIT_SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: m, entryPoint: 'vs' },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: this.format }] },
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /**
   * Render `srcTexture` (rgba8) to an ImageBitmap of `width × height`, scaling
   * the frame into the canvas per `mode` (default 'stretch' = the old behavior).
   * Letterbox/pad areas are left TRANSPARENT so layers below show through.
   */
  toImageBitmap(srcTexture: GPUTexture, width: number, height: number, mode: BlitFit = 'stretch'): ImageBitmap {
    if (!this.canvas || this.w !== width || this.h !== height) {
      this.canvas = new OffscreenCanvas(width, height);
      this.ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
      // premultiplied (not opaque) so transparent letterbox bars survive.
      this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
      this.w = width;
      this.h = height;
    }
    const g = blitGeom(srcTexture.width, srcTexture.height, width, height, mode);
    this.device.queue.writeBuffer(this.xformBuf, 0,
      new Float32Array([g.uOff[0], g.uOff[1], g.uScale[0], g.uScale[1]]));
    const target = this.ctx!.getCurrentTexture();
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTexture.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.xformBuf } },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, // transparent padding
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setViewport(g.vx, g.vy, Math.max(1, g.vw), Math.max(1, g.vh), 0, 1);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return this.canvas!.transferToImageBitmap();
  }
}
