import { runEngineTest } from './engine-test-helpers';

// Per-effect tests for `utility.paramlinker` against the shipping `core`
// bundle. paramlinker has no texture I/O — it's a state-only utility that
// observes Resolume parameter changes and links two of them. These tests
// cover what's verifiable without a Resolume-param-injection mechanism:
// metadata, schema, default state, and state response to its own toggle
// params (learn, active).

describe('Param Linker Effect E2E', () => {
  jest.setTimeout(30000);

  it('declares metadata and schema', async () => {
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        { type: 'instantiateEffect', effectId: 'utility.paramlinker' },
      ],
      waitFrames: 5,
      dumpName: 'pl_metadata',
    });

    expect(result.success).toBe(true);
    const pl = result.state.plugins.find((p: any) => p.id === 'utility.paramlinker');
    expect(pl).toBeDefined();
    // Key carries an instance-counter suffix (@N); the bundle warmup registers
    // the schema-only instance and instantiateEffect makes the live one, so the
    // exact N isn't load-bearing — just assert the id@N shape.
    expect(pl!.key).toMatch(/^utility\.paramlinker@\d+$/);
    const paramNames = pl!.params.map((p: any) => p.name).sort();
    expect(paramNames).toEqual(['active', 'learn']);
  });

  it('initial state has learn=false and no input/output linked', async () => {
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        { type: 'instantiateEffect', effectId: 'utility.paramlinker' },
      ],
      waitFrames: 5,
      dumpName: 'pl_initial',
    });

    expect(result.success).toBe(true);
    const pl = result.state.plugins.find((p: any) => p.id === 'utility.paramlinker');
    const pluginState = result.state.pluginStates?.[pl!.key];
    expect(pluginState).toBeDefined();
    expect(pluginState.learning).toBe(false);
    // Active is true by default, but linking is inactive until input/output assigned.
    expect(pluginState.active).toBe(true);
    // Without any resolume param events observed, no link is established.
    // Some implementations omit the field; treat -1 / null / undefined as "not linked".
    const inputId = pluginState.input_id ?? -1;
    const outputId = pluginState.output_id ?? -1;
    expect(inputId).toBeLessThan(0);
    expect(outputId).toBeLessThan(0);
  });

  it('toggling learn rises into learning state', async () => {
    const result = await runEngineTest({
      width: 32, height: 32,
      modules: ['com.nano.core'],
      commands: [
        { type: 'instantiateEffect', effectId: 'utility.paramlinker' },
        // Once instantiated, set the learn param to 1.0 — paramlinker treats
        // a rising edge (>=0.5) as "toggle learning".
        // setParam targets a sketch chain entry; this effect is in the unassigned
        // bucket sketch, so we route through there by effect-id state patches via
        // notifyStatePatched. The simplest harness path is to wrap the instance
        // in a single-module sketch.
        {
          type: 'createSketch',
          sketchId: 'pl_sketch',
          sketch: {
            anchor: null,
            chain: [
              {
                type: 'module',
                module_type: 'utility.paramlinker',
                instance_key: 'pl@0',
                // No initial state override — defaults stand.
              },
            ],
          },
        },
        // Toggle learn on
        {
          type: 'setParam',
          sketchId: 'pl_sketch', colIdx: 0, chainIdx: 0,
          paramKey: 'learn', value: 1.0,
        },
      ],
      waitFrames: 5,
      dumpName: 'pl_learn_on',
    });

    expect(result.success).toBe(true);
    const pluginState = result.state.pluginStates?.['pl@0']
      ?? result.state.pluginStates?.['utility.paramlinker@0'];
    expect(pluginState).toBeDefined();
    // After toggling learn, the module should be observing.
    expect(pluginState.learning).toBe(true);
  });
});
