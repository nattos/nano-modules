import { buildFontAtlas, FONT_ATLAS_W, FONT_ATLAS_H, FONT_ATLAS_COLS, FONT_GLYPH_W, FONT_GLYPH_H } from './font8x8';
import shaderSource from './shaders.wgsl?raw';

export interface DrawCmd {
  type: 'fill_rect' | 'draw_image' | 'draw_text';
  x: number; y: number; w: number; h: number;
  r: number; g: number; b: number; a: number;
  texId?: number;
  text?: string;
  fontSize?: number;
}

const MAX_QUAD_VERTS = 64000;
const MAX_TEXT_VERTS = 64000;
const QUAD_STRIDE = 24; // 6 floats
const TEXT_STRIDE = 32; // 8 floats

export class GPURenderer {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;

  // Quad pipeline
  private quadPipeline!: GPURenderPipeline;
  private quadVertBuf!: GPUBuffer;
  private quadUniformBuf!: GPUBuffer;
  private quadBindGroup!: GPUBindGroup;

  // Text pipeline
  private textPipeline!: GPURenderPipeline;
  private textVertBuf!: GPUBuffer;
  private textUniformBuf!: GPUBuffer;
  private fontTexture!: GPUTexture;
  private textBindGroup!: GPUBindGroup;

  // Batch data
  private quadData = new Float32Array(MAX_QUAD_VERTS * 6);
  private quadCount = 0;
  private textData = new Float32Array(MAX_TEXT_VERTS * 8);
  private textCount = 0;

  // Current frame
  private encoder!: GPUCommandEncoder;
  private passEncoder!: GPURenderPassEncoder;
  private viewportW = 0;
  private viewportH = 0;

  async init(canvas: HTMLCanvasElement): Promise<boolean> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return false;
    this.device = await adapter.requestDevice();
    this.context = canvas.getContext('webgpu') as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });

    const shaderModule = this.device.createShaderModule({ code: shaderSource });

    // Quad pipeline
    this.quadVertBuf = this.device.createBuffer({
      size: MAX_QUAD_VERTS * QUAD_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.quadUniformBuf = this.device.createBuffer({
      size: 16, // vec2<f32> aligned to 16
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const quadBindGroupLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });

    this.quadBindGroup = this.device.createBindGroup({
      layout: quadBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.quadUniformBuf } }],
    });

    const blendState: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };

    this.quadPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [quadBindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'quad_vertex',
        buffers: [{
          arrayStride: QUAD_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },  // pos
            { shaderLocation: 1, offset: 8, format: 'float32x4' },  // color
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'quad_fragment',
        targets: [{ format: this.format, blend: blendState }],
      },
      primitive: { topology: 'triangle-list' },
    });

    // Font atlas texture
    const atlasData = buildFontAtlas();
    this.fontTexture = this.device.createTexture({
      size: [FONT_ATLAS_W, FONT_ATLAS_H],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.fontTexture },
      atlasData,
      { bytesPerRow: FONT_ATLAS_W },
      [FONT_ATLAS_W, FONT_ATLAS_H],
    );

    // Text pipeline
    this.textVertBuf = this.device.createBuffer({
      size: MAX_TEXT_VERTS * TEXT_STRIDE,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.textUniformBuf = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const fontSampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    });

    const textBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });

    this.textBindGroup = this.device.createBindGroup({
      layout: textBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.textUniformBuf } },
        { binding: 1, resource: this.fontTexture.createView() },
        { binding: 2, resource: fontSampler },
      ],
    });

    this.textPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [textBindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'text_vertex',
        buffers: [{
          arrayStride: TEXT_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },   // pos
            { shaderLocation: 1, offset: 8, format: 'float32x2' },   // uv
            { shaderLocation: 2, offset: 16, format: 'float32x4' },  // color
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'text_fragment',
        targets: [{ format: this.format, blend: blendState }],
      },
      primitive: { topology: 'triangle-list' },
    });

    return true;
  }

  beginFrame(viewportW: number, viewportH: number) {
    this.viewportW = viewportW;
    this.viewportH = viewportH;
    this.quadCount = 0;
    this.textCount = 0;

    const uniformData = new Float32Array([viewportW, viewportH, 0, 0]);
    this.device.queue.writeBuffer(this.quadUniformBuf, 0, uniformData);
    this.device.queue.writeBuffer(this.textUniformBuf, 0, uniformData);

    this.encoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    this.passEncoder = this.encoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.07, g: 0.08, b: 0.09, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
  }

  private pushQuad(x: number, y: number, w: number, h: number,
                    r: number, g: number, b: number, a: number) {
    if (this.quadCount + 6 > MAX_QUAD_VERTS) return;
    const d = this.quadData;
    const o = this.quadCount * 6;
    const x1 = x + w, y1 = y + h;
    // Triangle 1
    d[o]    = x;  d[o+1]  = y;  d[o+2]  = r; d[o+3]  = g; d[o+4]  = b; d[o+5]  = a;
    d[o+6]  = x1; d[o+7]  = y;  d[o+8]  = r; d[o+9]  = g; d[o+10] = b; d[o+11] = a;
    d[o+12] = x;  d[o+13] = y1; d[o+14] = r; d[o+15] = g; d[o+16] = b; d[o+17] = a;
    // Triangle 2
    d[o+18] = x1; d[o+19] = y;  d[o+20] = r; d[o+21] = g; d[o+22] = b; d[o+23] = a;
    d[o+24] = x1; d[o+25] = y1; d[o+26] = r; d[o+27] = g; d[o+28] = b; d[o+29] = a;
    d[o+30] = x;  d[o+31] = y1; d[o+32] = r; d[o+33] = g; d[o+34] = b; d[o+35] = a;
    this.quadCount += 6;
  }

  private pushTextGlyph(ch: number, x: number, y: number, size: number,
                         r: number, g: number, b: number, a: number) {
    let idx = ch - 32;
    if (idx < 0 || idx >= 96) idx = 0;
    const col = idx % FONT_ATLAS_COLS;
    const row = Math.floor(idx / FONT_ATLAS_COLS);
    const u0 = (col * FONT_GLYPH_W) / FONT_ATLAS_W;
    const v0 = (row * FONT_GLYPH_H) / FONT_ATLAS_H;
    const u1 = ((col + 1) * FONT_GLYPH_W) / FONT_ATLAS_W;
    const v1 = ((row + 1) * FONT_GLYPH_H) / FONT_ATLAS_H;

    if (this.textCount + 6 > MAX_TEXT_VERTS) return;
    const d = this.textData;
    const o = this.textCount * 8;
    const x1 = x + size, y1 = y + size;
    // Triangle 1
    d[o]    = x;  d[o+1]  = y;  d[o+2]  = u0; d[o+3]  = v0; d[o+4]  = r; d[o+5]  = g; d[o+6]  = b; d[o+7]  = a;
    d[o+8]  = x1; d[o+9]  = y;  d[o+10] = u1; d[o+11] = v0; d[o+12] = r; d[o+13] = g; d[o+14] = b; d[o+15] = a;
    d[o+16] = x;  d[o+17] = y1; d[o+18] = u0; d[o+19] = v1; d[o+20] = r; d[o+21] = g; d[o+22] = b; d[o+23] = a;
    // Triangle 2
    d[o+24] = x1; d[o+25] = y;  d[o+26] = u1; d[o+27] = v0; d[o+28] = r; d[o+29] = g; d[o+30] = b; d[o+31] = a;
    d[o+32] = x1; d[o+33] = y1; d[o+34] = u1; d[o+35] = v1; d[o+36] = r; d[o+37] = g; d[o+38] = b; d[o+39] = a;
    d[o+40] = x;  d[o+41] = y1; d[o+42] = u0; d[o+43] = v1; d[o+44] = r; d[o+45] = g; d[o+46] = b; d[o+47] = a;
    this.textCount += 6;
  }

  private flushQuads() {
    if (this.quadCount === 0) return;
    this.device.queue.writeBuffer(this.quadVertBuf, 0, this.quadData, 0, this.quadCount * 6);
    this.passEncoder.setPipeline(this.quadPipeline);
    this.passEncoder.setBindGroup(0, this.quadBindGroup);
    this.passEncoder.setVertexBuffer(0, this.quadVertBuf);
    this.passEncoder.draw(this.quadCount);
    this.quadCount = 0;
  }

  private flushText() {
    if (this.textCount === 0) return;
    this.device.queue.writeBuffer(this.textVertBuf, 0, this.textData, 0, this.textCount * 8);
    this.passEncoder.setPipeline(this.textPipeline);
    this.passEncoder.setBindGroup(0, this.textBindGroup);
    this.passEncoder.setVertexBuffer(0, this.textVertBuf);
    this.passEncoder.draw(this.textCount);
    this.textCount = 0;
  }

  execute(drawList: DrawCmd[]) {
    for (const cmd of drawList) {
      switch (cmd.type) {
        case 'fill_rect':
          this.pushQuad(cmd.x, cmd.y, cmd.w, cmd.h, cmd.r, cmd.g, cmd.b, cmd.a);
          break;
        case 'draw_text':
          if (cmd.text && cmd.fontSize) {
            let cx = cmd.x;
            for (let i = 0; i < cmd.text.length; i++) {
              const code = cmd.text.charCodeAt(i);
              if (code >= 32 && code < 127) {
                this.pushTextGlyph(code, cx, cmd.y, cmd.fontSize, cmd.r, cmd.g, cmd.b, cmd.a);
              }
              cx += cmd.fontSize;
            }
          }
          break;
        case 'draw_image':
          // TODO: textured quads for thumbnails
          // For now, draw a placeholder rect
          this.pushQuad(cmd.x, cmd.y, cmd.w, cmd.h, 0.15, 0.15, 0.15, 0.6);
          break;
      }
    }
  }

  endFrame() {
    this.flushQuads();
    this.flushText();
    this.passEncoder.end();
    this.device.queue.submit([this.encoder.finish()]);
  }
}
