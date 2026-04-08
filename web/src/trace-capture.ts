/**
 * TraceCapture — GPU-resident texture capture via OffscreenCanvas.
 *
 * For each trace point, maintains a dedicated OffscreenCanvas + WebGPU context.
 * Blits the source texture to the canvas via a full-screen textured quad render pass,
 * then calls transferToImageBitmap() — no CPU readback involved.
 */

const BLIT_SHADER = /* wgsl */`
  @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    // Full-screen triangle (covers [-1,1] with 3 vertices)
    let x = f32(i32(i) / 2) * 4.0 - 1.0;
    let y = f32(i32(i) % 2) * 4.0 - 1.0;
    return vec4f(x, y, 0.0, 1.0);
  }

  @group(0) @binding(0) var src: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;

  @fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let dims = vec2f(textureDimensions(src));
    let uv = pos.xy / dims;
    return textureSample(src, samp, uv);
  }
`;

interface CaptureSlot {
  canvas: OffscreenCanvas;
  context: GPUCanvasContext;
  width: number;
  height: number;
}

export class TraceCapture {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
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
    this.sampler = this.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  }

  private ensureSlot(id: string, width: number, height: number): CaptureSlot {
    let slot = this.slots.get(id);
    if (slot && slot.width === width && slot.height === height) return slot;

    // Create or recreate the OffscreenCanvas at the right size
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('webgpu') as GPUCanvasContext;
    context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });
    slot = { canvas, context, width, height };
    this.slots.set(id, slot);
    return slot;
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
    const slot = this.ensureSlot(id, w, h);

    const targetTex = slot.context.getCurrentTexture();

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: srcTexture.createView() },
        { binding: 1, resource: this.sampler! },
      ],
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targetTex.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3); // full-screen triangle
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    return slot.canvas.transferToImageBitmap();
  }

  dispose() {
    this.slots.clear();
  }
}
