import { runGpuEffectTest, runGpuChainTest } from './gpu-test-helpers';

describe('Edges Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and I/O', async () => {
    const frame = await runGpuEffectTest({
      module: 'edges.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'edges_metadata',
    });
    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('filter.edges');
  });

  it('uniform input produces no edges (all background)', async () => {
    // Uniform → gradient magnitude = 0 → all pixels become bg colour (default black).
    const frame = await runGpuEffectTest({
      module: 'edges.wasm',
      bundle: 'core',
      inputColor: [0.5, 0.5, 0.5, 1.0],
      dumpName: 'edges_uniform',
    });
    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0 }, 4);
  });

  it('grid produces visible edges', async () => {
    const frame = await runGpuChainTest({
      chain: [
        { module: 'grid.wasm', params: [[0, 0.3], [1, 0.2]] },
        { module: 'edges.wasm', params: [[0, 0.05]] },  // threshold=0.05
      ],
      bundle: 'core',
      width: 64, height: 64,
      dumpName: 'edges_grid',
    });
    expect(frame.success).toBe(true);
    // Some pixels should be near-white (edges) and others near-black (cell interior).
    const white = frame.countPixels(c => c.r > 200 && c.g > 200 && c.b > 200);
    const black = frame.countPixels(c => c.r < 30 && c.g < 30 && c.b < 30);
    expect(white).toBeGreaterThan(0);
    expect(black).toBeGreaterThan(0);
  });
});
