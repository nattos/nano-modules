import { describe, it, expect, beforeEach } from 'vitest';
import { store } from './store';
import { ArrColumnAdapter, clipTarget, trackTarget } from '../surfaces/arr-column-adapter';
import { clipInstanceKey } from '../engine/clip-sketch';
import { engineBridge } from '../engine/engine-bridge';

/**
 * Engine wire-modulation telemetry → store → column adapter (task #40).
 * The engine publishes modulationData keyed by the engine instance key
 * (`clip_<clipId>_<deviceId>`); the clip adapter must translate a bare device id
 * back to that key so sliders read the right band.
 */
describe('arrangement modulation telemetry', () => {
  beforeEach(() => {
    // Reset the singleton's telemetry between cases.
    store.modulationData = {};
    store.pluginStates = {};
  });

  it('applyModulationDataDiff applies changed + removed granularly', () => {
    const band = { value: 0.4, min: 0, max: 1, neutral: 0.5 };
    store.applyModulationDataDiff({ changed: { 'clip_c1_d1': { hue_shift: band } }, removed: [] });
    expect(store.modulationData['clip_c1_d1'].hue_shift).toEqual(band);

    // A second key arrives; the first survives.
    store.applyModulationDataDiff({ changed: { 'clip_c1_d2': { gain: band } }, removed: [] });
    expect(store.modulationData['clip_c1_d1']).toBeDefined();
    expect(store.modulationData['clip_c1_d2'].gain).toEqual(band);

    // Removal drops just that key.
    store.applyModulationDataDiff({ changed: {}, removed: ['clip_c1_d1'] });
    expect(store.modulationData['clip_c1_d1']).toBeUndefined();
    expect(store.modulationData['clip_c1_d2']).toBeDefined();
  });

  it('an empty diff is a no-op', () => {
    store.modulationData = { keep: { f: { value: 1, min: 0, max: 1, neutral: 0 } } };
    store.applyModulationDataDiff({ changed: {}, removed: [] });
    expect(store.modulationData.keep).toBeDefined();
  });

  it('clip adapter translates device id → engine key when reading modulation', () => {
    const band = { value: 0.7, min: -1, max: 1, neutral: 0 };
    store.modulationData[clipInstanceKey('clipA', 'devX')] = { amount: band };

    const adapter = new ArrColumnAdapter(clipTarget('trk1', 'clipA'));
    // column-group calls modulation() with the bare device id (from getSketch).
    expect(adapter.data.modulation('devX')).toEqual({ amount: band });
    // An unknown device → no band, not a throw.
    expect(adapter.data.modulation('devNope')).toBeUndefined();
  });

  it('applyPluginStatesDiff routes published outputs; adapter translates device id → engine key', () => {
    store.applyPluginStatesDiff({ changed: { [clipInstanceKey('clipA', 'lfo')]: { output: 0.73 } }, removed: [] });
    expect(store.pluginStates[clipInstanceKey('clipA', 'lfo')].output).toBe(0.73);

    const adapter = new ArrColumnAdapter(clipTarget('trk1', 'clipA'));
    // The output trace spark reads this via the bare device id → engine key.
    expect(adapter.data.pluginState('lfo')).toEqual({ output: 0.73 });
    expect(adapter.data.pluginState('nope')).toBeUndefined();

    // Removal drops it.
    store.applyPluginStatesDiff({ changed: {}, removed: [clipInstanceKey('clipA', 'lfo')] });
    expect(adapter.data.pluginState('lfo')).toBeUndefined();
  });

  it('traced texture frames route through the store + bridge TraceSource', () => {
    const flag = { closed: false };
    const fakeBitmap = { close() { flag.closed = true; } } as unknown as ImageBitmap;
    store.setTracedFrames({ 'tex/a': fakeBitmap });
    const g0 = store.traceGeneration;
    expect(engineBridge.traceSource.frame('tex/a')).toBe(fakeBitmap);
    expect(engineBridge.traceSource.generation).toBe(g0);
    // A new frame set closes the previous bitmap + bumps the generation.
    store.setTracedFrames({});
    expect(flag.closed).toBe(true);
    expect(engineBridge.traceSource.frame('tex/a')).toBeUndefined();
    expect(engineBridge.traceSource.generation).toBe(g0 + 1);
    // The clip adapter exposes the same trace seam to its column-group.
    const adapter = new ArrColumnAdapter(clipTarget('t', 'c'));
    expect(adapter.traceSource).toBe(engineBridge.traceSource);
  });

  it('track adapter has no engine telemetry (tracks do not render through the engine)', () => {
    store.modulationData[clipInstanceKey('clipA', 'devX')] = {
      amount: { value: 0.7, min: -1, max: 1, neutral: 0 },
    };
    const adapter = new ArrColumnAdapter(trackTarget('trk1'));
    expect(adapter.data.modulation('devX')).toBeUndefined();
  });
});
