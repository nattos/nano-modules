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
  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;
  @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(src, samp, uv);
  }
`;

export class FrameBlitter {
  private device: GPUDevice;
  private format: GPUTextureFormat = 'rgba8unorm';
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private canvas: OffscreenCanvas | null = null;
  private ctx: GPUCanvasContext | null = null;
  private w = 0;
  private h = 0;

  constructor(device: GPUDevice) {
    this.device = device;
    const m = device.createShaderModule({ code: BLIT_SHADER });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: m, entryPoint: 'vs' },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: this.format }] },
    });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /** Render `srcTexture` (rgba8) to an ImageBitmap of `width × height`. */
  toImageBitmap(srcTexture: GPUTexture, width: number, height: number): ImageBitmap {
    if (!this.canvas || this.w !== width || this.h !== height) {
      this.canvas = new OffscreenCanvas(width, height);
      this.ctx = this.canvas.getContext('webgpu') as GPUCanvasContext;
      this.ctx.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
      this.w = width;
      this.h = height;
    }
    const target = this.ctx!.getCurrentTexture();
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTexture.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
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
