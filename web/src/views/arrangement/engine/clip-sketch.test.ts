import { describe, it, expect } from 'vitest';
import { buildCompositeSketch, clipInstanceKey } from './clip-sketch';

/**
 * buildCompositeSketch — the layer pipeline. A SOURCE clip (generator at the top)
 * renders standalone and composites OVER the accumulator via a wired
 * `composite.blend`; an EFFECT-only clip chains inline to process the composite
 * above it. Per-track opacity rides the blend (sources) or `__opacity__` (effects).
 */
const dev = (moduleType: string, id: string) =>
  ({ id, moduleType, name: moduleType, capabilities: [], state: {} });
const clip = (id: string, ...mods: string[]) =>
  ({ id, sketch: { devices: mods.map((m, i) => dev(m, `${id}d${i}`)) } } as any);

describe('buildCompositeSketch', () => {
  it('source clips composite via wired composite.blend; effect clips chain inline', () => {
    const r = buildCompositeSketch([
      { clip: clip('A', 'source.solid_color'), opacity: 1 }, // top source = accumulator
      { clip: clip('B', 'source.noise'), opacity: 1 }, // source → blend over A
      { clip: clip('C', 'color.invert'), opacity: 1 }, // effect → inline on the composite
    ])!;
    expect(r).not.toBeNull();
    const types = r.sketch.chain!.map((e) => e.module_type);
    expect(types).toContain('source.solid_color');
    expect(types).toContain('source.noise');
    expect(types).toContain('color.invert');
    // Exactly ONE blend node (for the second source); the effect adds none.
    expect(types.filter((t) => t === 'composite.blend').length).toBe(1);

    // The blend is wired: slot 0 = A's output (accumulator), slot 1 = B's output.
    const blend = r.sketch.chain!.find((e) => e.module_type === 'composite.blend')!;
    const w0 = r.sketch.wires!.find((w) => w.dest.instanceKey === blend.instance_key && w.dest.field === '0');
    const w1 = r.sketch.wires!.find((w) => w.dest.instanceKey === blend.instance_key && w.dest.field === '1');
    expect(w0!.src.instanceKey).toBe(clipInstanceKey('A', 'Ad0'));
    expect(w1!.src.instanceKey).toBe(clipInstanceKey('B', 'Bd0'));

    // The effect (invert) comes after the blend in the chain and adds no wire —
    // it reads the blend's output (the composite) as its linear input.
    expect(types.indexOf('color.invert')).toBeGreaterThan(types.indexOf('composite.blend'));
  });

  it('a lone effect-only clip processes the transparent base (no blend, no wires)', () => {
    const r = buildCompositeSketch([{ clip: clip('E', 'color.invert'), opacity: 1 }])!;
    expect(r.sketch.chain!.map((e) => e.module_type)).toEqual(['color.invert']);
    expect(r.sketch.wires).toEqual([]);
  });

  it('per-track opacity rides the blend for sources and __opacity__ for effects', () => {
    const r = buildCompositeSketch([
      { clip: clip('A', 'source.noise'), opacity: 1 },
      { clip: clip('B', 'source.noise'), opacity: 0.5, blendMode: 2 }, // source → blend
      { clip: clip('C', 'color.invert'), opacity: 0.3 }, // effect → __opacity__
    ])!;
    const blend = r.sketch.chain!.find((e) => e.module_type === 'composite.blend')!;
    const bState = r.sketch.instances![blend.instance_key].state as any;
    expect(bState.opacity).toBe(0.5);
    expect(bState.mode).toBe(2); // blend mode threaded through
    const inv = r.sketch.chain!.find((e) => e.module_type === 'color.invert')!;
    expect((r.sketch.instances![inv.instance_key].state as any).__opacity__).toBe(0.3);
  });

  it('returns null for an empty stack', () => {
    expect(buildCompositeSketch([])).toBeNull();
  });
});
