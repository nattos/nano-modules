import { describe, it, expect } from 'vitest';
import { buildCompositeSketch, clipInstanceKey, trackInstanceKey, type CompositeNode } from './clip-sketch';
import { seedTestPlugins } from './test-plugins';

// Seed the offline registry so catalogEffect resolves source/effect roles.
seedTestPlugins();

/**
 * GROUP compositing: a group's children render into a sub-image over the group's
 * INPUT base, the group's own FX chain runs over that, and the result composites up
 * into the parent (group blend + own opacity). Pure-function tests on the tree the
 * store builds (store.compositeTreeAtBeat) — no engine.
 */
const dev = (moduleType: string, id: string) =>
  ({ id, moduleType, name: moduleType, capabilities: [], state: {} });
const clip = (id: string, ...mods: string[]) =>
  ({ id, sketch: { devices: mods.map((m, i) => dev(m, `${id}d${i}`)) } } as any);
const leaf = (c: any, opacity = 1, blendMode?: number): CompositeNode =>
  ({ type: 'clip', clip: c, opacity, blendMode } as any);
const group = (
  id: string,
  children: CompositeNode[],
  input: { mode: 'underlying' | 'black' | 'transparent' | 'custom'; color?: string } = { mode: 'transparent' },
  opacity = 1,
  blendMode?: number,
  fx: string[] = [],
): CompositeNode =>
  ({
    type: 'group',
    group: { id, sketch: { devices: fx.map((m, i) => dev(m, `${id}fx${i}`)) } },
    opacity,
    blendMode,
    input,
    children,
  } as any);

const types = (r: any) => r.sketch.chain!.map((e: any) => e.module_type);
const keys = (r: any) => r.sketch.chain!.map((e: any) => e.instance_key);

describe('group compositing', () => {
  it('a group with a transparent input composites its child, then blends up over the parent', () => {
    // bg (arr_bg) under: a top leaf, then a group containing one source child.
    const r = buildCompositeSketch([
      leaf(clip('A', 'source.noise')),
      group('G', [leaf(clip('C', 'source.noise'))]),
    ])!;
    // The child source is present, and a group blend node composites the group up.
    expect(keys(r)).toContain(clipInstanceKey('C', 'Cd0'));
    expect(keys(r)).toContain('group_G_blend');
    // No group bg solid for a transparent input.
    expect(keys(r)).not.toContain('group_G_bg');
  });

  it("an 'underlying' (pass-through) group runs its FX over the composite BELOW it (no fresh base, no blend at full opacity)", () => {
    const r = buildCompositeSketch([
      leaf(clip('A', 'source.noise')),
      group('G', [leaf(clip('C', 'color.invert'))], { mode: 'underlying' }, 1, 0, ['color.saturate']),
    ])!;
    // Pass-through: no fresh solid base, and at full opacity it replaces the
    // accumulator inline (no group blend node).
    expect(keys(r)).not.toContain('group_G_bg');
    expect(keys(r)).not.toContain('group_G_blend');
    // The group's FX bus runs (keyed per group) AFTER the child.
    const gfx = trackInstanceKey('G', 'Gfx0');
    expect(keys(r)).toContain(gfx);
    expect(keys(r).indexOf(gfx)).toBeGreaterThan(keys(r).indexOf(clipInstanceKey('C', 'Cd0')));
  });

  it("a partially-opaque 'underlying' group blends (wet/dry) over the below content", () => {
    const r = buildCompositeSketch([
      leaf(clip('A', 'source.noise')),
      group('G', [leaf(clip('C', 'color.invert'))], { mode: 'underlying' }, 0.4),
    ])!;
    const b = r.sketch.chain!.find((e: any) => e.instance_key === 'group_G_blend')!;
    expect((r.sketch.instances!['group_G_blend'].state as any).opacity).toBe(0.4);
  });

  it("a 'black' input group lays a solid base under its children, then composites over the parent", () => {
    const r = buildCompositeSketch([
      leaf(clip('A', 'source.noise')),
      group('G', [leaf(clip('C', 'source.noise'))], { mode: 'black' }),
    ])!;
    expect(keys(r)).toContain('group_G_bg');
    expect((r.sketch.instances!['group_G_bg'].state as any).color).toEqual([0, 0, 0]);
    expect(keys(r)).toContain('group_G_blend');
  });

  it("a 'custom' input group uses the hex color for its base", () => {
    const r = buildCompositeSketch([
      leaf(clip('A', 'source.noise')),
      group('G', [leaf(clip('C', 'source.noise'))], { mode: 'custom', color: '#ff8000' }),
    ])!;
    const c = (r.sketch.instances!['group_G_bg'].state as any).color as number[];
    expect(c[0]).toBeCloseTo(1);
    expect(c[1]).toBeCloseTo(128 / 255);
    expect(c[2]).toBeCloseTo(0);
  });

  it('a group threads its blend mode + own opacity onto the blend-up node', () => {
    const r = buildCompositeSketch([
      leaf(clip('A', 'source.noise')),
      group('G', [leaf(clip('C', 'source.noise'))], { mode: 'transparent' }, 0.6, 3),
    ])!;
    const st = r.sketch.instances!['group_G_blend'].state as any;
    expect(st.opacity).toBe(0.6);
    expect(st.mode).toBe(3);
  });

  it('runs the group FX chain over the composited children (keyed per group)', () => {
    const r = buildCompositeSketch([
      group('G', [leaf(clip('C', 'source.noise'))], { mode: 'transparent' }, 1, 0, ['color.invert']),
    ], { mode: 'transparent' })!;
    const gfx = trackInstanceKey('G', 'Gfx0');
    expect(keys(r)).toContain(gfx);
    expect(types(r)).toContain('color.invert');
    // FX comes after the child in the chain (it processes the children's result).
    expect(keys(r).indexOf(gfx)).toBeGreaterThan(keys(r).indexOf(clipInstanceKey('C', 'Cd0')));
  });

  it('the MAIN BUS runs its FX chain over the FINAL composite (master FX bus)', () => {
    const mainBus = { id: 'main-bus', sketch: { devices: [dev('color.invert', 'mbfx0')] } } as any;
    const r = buildCompositeSketch(
      [leaf(clip('A', 'source.noise')), leaf(clip('B', 'source.noise'))],
      undefined, undefined, undefined, mainBus,
    )!;
    const mfx = trackInstanceKey('main-bus', 'mbfx0');
    // Master FX present and keyed per the bus track (so its automation targets it).
    expect(keys(r)).toContain(mfx);
    expect(types(r)).toContain('color.invert');
    // It is the LAST chain entry — it processes everything that summed before it.
    expect(keys(r).indexOf(mfx)).toBe(r.sketch.chain!.length - 1);
    expect(keys(r).indexOf(mfx)).toBeGreaterThan(keys(r).indexOf(clipInstanceKey('B', 'Bd0')));
  });

  it('an empty timeline gets NO master FX (nothing to process)', () => {
    const mainBus = { id: 'main-bus', sketch: { devices: [dev('color.invert', 'mbfx0')] } } as any;
    // No nodes → null composite; the bus FX must not resurrect an empty chain.
    const r = buildCompositeSketch([], undefined, undefined, undefined, mainBus);
    expect(r).toBeNull();
  });

  it('nested groups compose (inner group blends inside the outer)', () => {
    // Default (black) composition bg → the outer group has a base to blend up over.
    const r = buildCompositeSketch([
      group('OUT', [
        leaf(clip('A', 'source.noise')),
        group('IN', [leaf(clip('B', 'source.noise'))], { mode: 'black' }),
      ], { mode: 'transparent' }),
    ])!;
    expect(keys(r)).toContain('group_IN_bg');
    expect(keys(r)).toContain('group_IN_blend');
    // The inner group's bg/blend appear before the outer group blends up.
    expect(keys(r)).toContain('group_OUT_blend');
  });
});
