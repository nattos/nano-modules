/**
 * TraceCapture — GPU-resident texture capture via OffscreenCanvas.
 *
 * For each trace point, maintains a dedicated OffscreenCanvas + WebGPU context.
 * Blits the source texture to the canvas via a full-screen textured quad render pass,
 * then calls transferToImageBitmap() — no CPU readback involved.
 *
 * Minification goes through a PYRAMID, not a single pass. A thumbnail is a ~15x
 * linear reduction (1920x1080 -> 128x72); a `linear` sampler is only a 2x2 tap,
 * so at that ratio it reads 4 of every ~225 source texels and degenerates to
 * point sampling — pixel-level noise aliases straight through and the thumbnail
 * looks crunchy. Halving repeatedly first makes each linear tap an exact 2x2 box
 * filter, so every source texel contributes. The pyramid is cached per slot, so
 * the steady-state cost is a handful of tiny passes.
 */

const BLIT_SHADER = /* wgsl */`
  struct VsOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
  }

  @vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
    // Full-screen triangle (covers [-1,1] with 3 vertices)
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    var out: VsOut;
    out.pos = vec4f(x, y, 0.0, 1.0);
    // UV: flip Y since framebuffer origin is top-left but clip-space Y is up.
    out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
    return out;
  }

  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;

  // A plain resampling copy, used for the halving pyramid levels. Straight alpha
  // is carried through untouched — only the final pass composites.
  @fragment fn fs_copy(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(src, samp, uv);
  }

  // Composite the source texture (assumed straight-alpha) over a
  // light/dark checkerboard so transparent regions show through as
  // the conventional "this is empty" pattern. Output alpha is always
  // 1.0 — the canvas is configured opaque, so alpha would be
  // discarded anyway, and the composite gives the IDE monitor a
  // self-contained image to display.
  @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
    let c = textureSample(src, samp, uv);
    let dims = vec2f(textureDimensions(src));
    // 8-px cells in source-texture space. Two grays (0.55 / 0.75)
    // give enough contrast to read on either bright or dark images
    // without dominating the foreground.
    let cell = floor(uv * dims / 8.0);
    let parity = u32(cell.x + cell.y) & 1u;
    let bg = select(0.55, 0.75, parity == 0u);
    let bg_rgb = vec3f(bg);
    // Source-over with straight alpha:
    //   out.rgb = src.rgb * src.a + bg.rgb * (1 - src.a)
    let composited = c.rgb * c.a + bg_rgb * (1.0 - c.a);
    return vec4f(composited, 1.0);
  }
`;

interface CaptureSlot {
  canvas: OffscreenCanvas;
  context: GPUCanvasContext;
  width: number;
  height: number;
  /** Halving pyramid between the source and the target size (may be empty). */
  pyramid: GPUTexture[];
  /** Source dims the pyramid was built for — a resize rebuilds it. */
  srcWidth: number;
  srcHeight: number;
}

export class TraceCapture {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private halvePipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private slots = new Map<string, CaptureSlot>();

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  private ensurePipeline() {
    if (this.pipeline) return;

    const module = this.device.createShaderModule({ code: BLIT_SHADER });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
    });
    // Pyramid levels keep straight alpha (no checkerboard) — the checkerboard
    // composite happens once, in the final pass onto the canvas.
    this.halvePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs_copy',
        targets: [{ format: this.format }],
      },
    });
    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  private ensureSlot(id: string, width: number, height: number,
                     srcWidth: number, srcHeight: number): CaptureSlot {
    let slot = this.slots.get(id);
    if (slot && slot.width === width && slot.height === height &&
        slot.srcWidth === srcWidth && slot.srcHeight === srcHeight) {
      return slot;
    }

    if (slot) {
      for (const t of slot.pyramid) t.destroy();
      slot.pyramid.length = 0;
    }

    // Create or recreate the OffscreenCanvas at the right size
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('webgpu') as GPUCanvasContext;
    context.configure({
      device: this.device,
      format: this.format,
      // Opaque so the captured ImageBitmap holds the raw post-effect
      // pixels without the browser pre-applying alpha to RGB. The
      // engine's pipeline uses straight alpha throughout; matching
      // here keeps trace captures faithful for monitor previews.
      alphaMode: 'opaque',
    });
    slot = { canvas, context, width, height, pyramid: [], srcWidth, srcHeight };

    // Halve until one more halving would undershoot the target — the last level
    // is then within 2x of it, which is exactly where a bilinear tap is honest.
    // Nothing is allocated when the source is already near the target size.
    let w = srcWidth, h = srcHeight;
    while (w >> 1 >= width && h >> 1 >= height && (w >> 1) >= 1 && (h >> 1) >= 1) {
      w >>= 1;
      h >>= 1;
      slot.pyramid.push(this.device.createTexture({
        size: { width: w, height: h },
        format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }));
    }

    this.slots.set(id, slot);
    return slot;
  }

  /** One full-screen pass: `src` -> `target`, with `pipeline`'s fragment shader. */
  private blit(encoder: GPUCommandEncoder, pipeline: GPURenderPipeline,
               src: GPUTextureView, target: GPUTextureView) {
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: src },
        { binding: 1, resource: this.sampler! },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // full-screen triangle
    pass.end();
  }

  /**
   * Capture a GPU texture as an ImageBitmap (GPU-resident, no CPU readback).
   *
   * Renders the source texture to a dedicated OffscreenCanvas via a blit pass,
   * then calls transferToImageBitmap().
   *
   * @param overrideSize If provided, the capture canvas is sized to these dimensions
   *   instead of matching the source texture. Useful for low-res thumbnails.
   */
  capture(id: string, srcTexture: GPUTexture, overrideSize?: { width: number; height: number }): ImageBitmap {
    this.ensurePipeline();
    const w = overrideSize?.width ?? srcTexture.width;
    const h = overrideSize?.height ?? srcTexture.height;
    const slot = this.ensureSlot(id, w, h, srcTexture.width, srcTexture.height);

    const encoder = this.device.createCommandEncoder();

    // Walk the halving pyramid. Each step is an exact 2x2 box filter, so no
    // source texel is skipped by the time we reach the final pass. An empty
    // pyramid (no minification, or barely any) leaves `view` as the source.
    let view = srcTexture.createView();
    for (const level of slot.pyramid) {
      const next = level.createView();
      this.blit(encoder, this.halvePipeline!, view, next);
      view = next;
    }

    // Final pass onto the canvas: now a <2x reduction, and the one that
    // composites over the transparency checkerboard.
    this.blit(encoder, this.pipeline!, view, slot.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);

    return slot.canvas.transferToImageBitmap();
  }

  dispose() {
    for (const slot of this.slots.values()) {
      for (const t of slot.pyramid) t.destroy();
    }
    this.slots.clear();
  }
}
