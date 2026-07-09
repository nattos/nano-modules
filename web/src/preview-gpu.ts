/**
 * preview-gpu.ts — shared WebGPU path for live preview frames.
 *
 * The old path decoded every barrel preview frame on the CPU: reassemble →
 * copy into a Uint8ClampedArray → ImageData → createImageBitmap → drawImage
 * per monitor. At full-res 1080p@30 that's ~500 MB/s of main-thread memcpy plus
 * a decode and N re-uploads. This module replaces it with a GPU-native path:
 *
 *   uploadFrame(traceId, bytes, w, h)  — one queue.writeTexture straight from the
 *     received bytes (a subview over the WS buffer — ZERO CPU copies) into a
 *     per-trace GPUTexture that is reused across frames (no per-frame alloc/GC).
 *   blitToCanvas(canvas, frame)        — samples that one texture into each
 *     monitor's <canvas> webgpu context. One upload, N cheap GPU blits, instead
 *     of N drawImage uploads.
 *
 * One device is shared by every preview canvas (WebGPU lets many canvas contexts
 * and this module's textures live on the same GPUDevice). Init is lazy + async;
 * frames that arrive before the device is ready are dropped (a few ms at boot).
 */

/** A preview frame that already lives on the GPU. Shares .width/.height with
 *  ImageBitmap so existing aspect/size reads keep working. */
export interface GpuPreviewFrame {
  readonly kind: 'gpu';
  texture: GPUTexture;
  width: number;
  height: number;
}

export type PreviewFrame = ImageBitmap | GpuPreviewFrame;

export function isGpuPreviewFrame(f: unknown): f is GpuPreviewFrame {
  return !!f && typeof f === 'object' && (f as GpuPreviewFrame).kind === 'gpu';
}

const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  // Texture origin is top-left; clip-space y is up — flip v.
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(tex, samp, in.uv);
  // Canvas is configured premultiplied so transparent pixels reveal the CSS
  // checkerboard (matching the old alpha 2d-canvas behaviour). Incoming pixels
  // are straight-alpha, so premultiply here.
  return vec4f(c.rgb * c.a, c.a);
}
`;

class PreviewGpu {
  private device: GPUDevice | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private pipeline: GPURenderPipeline | null = null;
  private sampler!: GPUSampler;
  private initStarted = false;
  private initFailed = false;

  /** Per-trace destination textures, reused across frames (size-stable). */
  private textures = new Map<string, GpuPreviewFrame>();
  /** Per-canvas configured webgpu context + its bind group for a given source
   *  texture (rebuilt when the source texture identity changes). */
  private canvasCtx = new WeakMap<HTMLCanvasElement, GPUCanvasContext>();
  private canvasBind = new WeakMap<HTMLCanvasElement, { tex: GPUTexture; bind: GPUBindGroup }>();

  /** Kick off device init once; safe to call repeatedly. */
  ensureInit(): void {
    if (this.initStarted || this.initFailed) return;
    this.initStarted = true;
    void this.init();
  }

  private async init(): Promise<void> {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) { this.initFailed = true; return; }
      const device = await adapter.requestDevice();
      this.format = navigator.gpu.getPreferredCanvasFormat();
      const module = device.createShaderModule({ code: BLIT_WGSL });
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      this.device = device;
    } catch {
      this.initFailed = true;
    }
  }

  get ready(): boolean { return this.device !== null; }
  get unavailable(): boolean { return this.initFailed; }

  /**
   * Upload one frame's RGBA8 bytes into this trace's (reused) GPUTexture.
   * `data` is read directly — pass a subview over the received buffer; no copy
   * is made here. Returns null until the device is ready (frame dropped).
   */
  uploadFrame(traceId: string, data: Uint8Array<ArrayBuffer>, width: number, height: number): GpuPreviewFrame | null {
    this.ensureInit();
    const device = this.device;
    if (!device) return null;
    let frame = this.textures.get(traceId);
    if (!frame || frame.width !== width || frame.height !== height) {
      frame?.texture.destroy();
      const texture = device.createTexture({
        size: [width, height],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      frame = { kind: 'gpu', texture, width, height };
      this.textures.set(traceId, frame);
    }
    device.queue.writeTexture(
      { texture: frame.texture },
      data,
      { bytesPerRow: width * 4, rowsPerImage: height },
      [width, height, 1],
    );
    return frame;
  }

  /** Free a trace's texture when its monitor goes away. */
  release(traceId: string): void {
    const f = this.textures.get(traceId);
    if (f) { f.texture.destroy(); this.textures.delete(traceId); }
  }

  /** Sample a GPU frame's texture into a monitor canvas (one GPU blit). */
  blitToCanvas(canvas: HTMLCanvasElement, frame: GpuPreviewFrame): void {
    const device = this.device;
    const pipeline = this.pipeline;
    if (!device || !pipeline) return;
    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;

    let ctx = this.canvasCtx.get(canvas);
    if (!ctx) {
      ctx = canvas.getContext('webgpu') as GPUCanvasContext | null ?? undefined;
      if (!ctx) return;
      ctx.configure({ device, format: this.format, alphaMode: 'premultiplied' });
      this.canvasCtx.set(canvas, ctx);
    }
    // Bind group depends on the source texture; rebuild only when it changes.
    let cb = this.canvasBind.get(canvas);
    if (!cb || cb.tex !== frame.texture) {
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: frame.texture.createView() },
        ],
      });
      cb = { tex: frame.texture, bind };
      this.canvasBind.set(canvas, cb);
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, cb.bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}

export const previewGpu = new PreviewGpu();
