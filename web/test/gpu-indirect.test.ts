/**
 * Indirect dispatch + draw golden (web mirror of the native
 * test_gpu_readback.mm "GPU-written args" case).
 *
 * A compute pass DECIDES the work size: kernel A writes {3,1,1} dispatch args
 * and {6,1,0,0} draw args into one storage buffer; kernel B runs under
 * dispatchWorkgroupsIndirect and stamps thread ids (3 groups × 4 threads = 12
 * elements, 13th untouched); a fullscreen-quad draw under drawIndirect covers
 * the target only when the GPU-written instance count says so.
 */
const BASE = process.env.GPU_TEST_BASE_URL || 'http://localhost:5173';

describe('GPUHost indirect dispatch + draw', () => {
  jest.setTimeout(30000);

  it('consumes GPU-written dispatch and draw args', async () => {
    page.on('console', (msg) => console.log('[browser]', msg.text()));
    await page.goto(`${BASE}/gpu-test-runner.html`, { waitUntil: 'networkidle0' });

    const result = await page.evaluate(`(async () => {
      const { GPUHost } = await import('/src/gpu-host.ts');
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const g = new GPUHost(device, 'rgba8unorm');

      // args[0..2] = dispatch {x,y,z}; args[3..6] = draw {vc, ic, fv, fi}.
      const args = g.createBuffer(7 * 4, /*Storage*/ 1);
      const data = g.createBuffer(64 * 4, /*Storage*/ 1);
      g.writeBuffer(data, 0, new Uint8Array(64 * 4));

      const writer = g.createShaderModule(\`
        @group(0) @binding(0) var<storage, read_write> args: array<u32>;
        @compute @workgroup_size(1) fn write_args() {
          args[0] = 3u; args[1] = 1u; args[2] = 1u;
          args[3] = 6u; args[4] = 1u; args[5] = 0u; args[6] = 0u;
        }\`);
      const stampSrc = g.createShaderModule(\`
        @group(0) @binding(0) var<storage, read_write> data: array<u32>;
        @compute @workgroup_size(4) fn stamp(@builtin(global_invocation_id) gid: vec3u) {
          data[gid.x] = 100u + gid.x;
        }\`);
      const rw = { slot: 0, kind: /*StorageRW*/ 2, format: 0, access: 0 };
      const writerPso = g.createComputePipelineWithLayout(writer, 'write_args', [rw]);
      const stampPso = g.createComputePipelineWithLayout(stampSrc, 'stamp', [rw]);

      let pass = g.beginComputePass();
      g.computeSetPipeline(pass, writerPso);
      g.computeSetBuffer(pass, args, 0, 0);
      g.computeDispatch(pass, 1, 1, 1);
      g.endComputePass(pass);

      pass = g.beginComputePass();
      g.computeSetPipeline(pass, stampPso);
      g.computeSetBuffer(pass, data, 0, 0);
      g.computeDispatchIndirect(pass, args, 0);
      g.endComputePass(pass);
      g.requestReadback(data, 64 * 4);
      g.flush();

      let stamped = null;
      for (let i = 0; i < 100; i++) {
        const { bytes, len } = g.getReadback(data);
        if (bytes && len >= 16 * 4) { stamped = Array.from(new Uint32Array(bytes.buffer, bytes.byteOffset, 16)); break; }
        await new Promise(r => setTimeout(r, 20));
        g.flush();
      }

      // Indirect draw from the SAME GPU-written args (offset 12): fullscreen
      // quad over a red clear → green. Then zero the instance count → red.
      const quad = g.createShaderModule(\`
        @vertex fn vmain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
          var p = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1),
                                  vec2f(-1,1), vec2f(1,-1), vec2f(1,1));
          return vec4f(p[vi], 0, 1);
        }
        @fragment fn fmain() -> @location(0) vec4f { return vec4f(0, 1, 0, 1); }\`);
      const rpso = g.createInstancedRenderPipelineWithLayout(
          quad, 'vmain', quad, 'fmain', /*RGBA8*/ 1, [], /*Replace*/ 2);
      const target = g.createTexture(16, 16, 1);

      pass = g.beginRenderPass(target, 1, 0, 0, 1);
      g.renderSetPipeline(pass, rpso);
      g.renderDrawIndirect(pass, args, 3 * 4);
      g.endRenderPass(pass);
      g.flush();
      const drawn = await g.readbackTexture(target, 16, 16);

      g.writeBuffer(args, 3 * 4, new Uint8Array(new Uint32Array([6, 0, 0, 0]).buffer));
      pass = g.beginRenderPass(target, 1, 0, 0, 1);
      g.renderSetPipeline(pass, rpso);
      g.renderDrawIndirect(pass, args, 3 * 4);
      g.endRenderPass(pass);
      g.flush();
      const empty = await g.readbackTexture(target, 16, 16);

      const c = (8 * 16 + 8) * 4;
      return {
        stamped,
        drawnPx: [drawn[c], drawn[c + 1]],
        emptyPx: [empty[c], empty[c + 1]],
      };
    })()`) as { stamped: number[] | null; drawnPx: number[]; emptyPx: number[] };

    // 3 GPU-decided workgroups × 4 threads = exactly 12 stamped elements.
    expect(result.stamped).not.toBeNull();
    for (let i = 0; i < 12; i++) expect(result.stamped![i]).toBe(100 + i);
    expect(result.stamped![12]).toBe(0);
    // GPU-written draw args drew the quad (green)...
    expect(result.drawnPx[1]).toBeGreaterThanOrEqual(250);
    expect(result.drawnPx[0]).toBeLessThanOrEqual(5);
    // ...and a zero instance count drew nothing (red clear survives).
    expect(result.emptyPx[0]).toBeGreaterThanOrEqual(250);
    expect(result.emptyPx[1]).toBeLessThanOrEqual(5);
  });
});
