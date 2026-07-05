import { runGpuTest } from './gpu-test-helpers';

// Per-effect tests for `source.solid_color` against the shipping `core`
// bundle. solid_color is a generator (no texture input). It exposes one
// vec3 color field (`color`, hint=color) which the IDE shows as an RGB
// picker. Tests pass it as a name+array tuple via the test runner's
// schema-field path.

describe('Solid Color Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and a single color input', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      dumpName: 'sc_metadata',
    });

    expect(frame.success).toBe(true);
    expect(frame.metadata?.id).toBe('source.solid_color');
    // float3 fields don't appear in the legacy params[] list (only
    // scalars do). solid_color has no scalar params after the migration.
    expect(frame.params.length).toBe(0);
  });

  it('default params produce mid-grey', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      dumpName: 'sc_default_grey',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 128, g: 128, b: 128, a: 255 }, 4);
  });

  it('renders pure red', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      params: [['color', [1.0, 0.0, 0.0]]],
      dumpName: 'sc_red',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 0, b: 0, a: 255 }, 2);
  });

  it('renders pure green', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      params: [['color', [0.0, 1.0, 0.0]]],
      dumpName: 'sc_green',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 255, b: 0, a: 255 }, 2);
  });

  it('renders pure blue', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      params: [['color', [0.0, 0.0, 1.0]]],
      dumpName: 'sc_blue',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 255, a: 255 }, 2);
  });

  it('renders black at all-zero', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      params: [['color', [0.0, 0.0, 0.0]]],
      dumpName: 'sc_black',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 0, g: 0, b: 0, a: 255 }, 2);
  });

  it('renders white at all-one', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      params: [['color', [1.0, 1.0, 1.0]]],
      dumpName: 'sc_white',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 255, a: 255 }, 2);
  });

  it('mixes channels independently', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      params: [['color', [1.0, 1.0, 0.0]]],
      dumpName: 'sc_yellow',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor({ r: 255, g: 255, b: 0, a: 255 }, 2);
  });

  it('output is uniform across the entire frame', async () => {
    const frame = await runGpuTest({
      module: 'source.solid_color',
      bundle: 'core',
      width: 96, height: 96,
      params: [['color', [0.3, 0.6, 0.9]]],
      samplePoints: [[0, 0], [95, 0], [0, 95], [95, 95], [48, 48]],
      dumpName: 'sc_uniform',
    });

    expect(frame.success).toBe(true);
    frame.expectUniformColor(
      { r: Math.round(0.3 * 255), g: Math.round(0.6 * 255), b: Math.round(0.9 * 255), a: 255 },
      2,
    );
  });
});
