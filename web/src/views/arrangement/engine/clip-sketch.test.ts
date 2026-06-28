import { describe, it, expect } from 'vitest';
import { buildCompositeSketch, clipInstanceKey, trackInstanceKey } from './clip-sketch';
import { seedTestPlugins } from './test-plugins';

// The registry derives roles/fields from store.enginePlugins (empty offline) — seed
// the fakes so catalogEffect resolves source/effect roles + the LFO's signed output.
seedTestPlugins();

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
    ], { mode: 'transparent' })!;
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

  it('runs a track FX bus over the clip output, keyed per TRACK', () => {
    const track = { id: 'T', sketch: { devices: [dev('color.invert', 'tfx')] } } as any;
    const r = buildCompositeSketch([
      { clip: clip('A', 'source.solid_color'), track, opacity: 1 },
    ], { mode: 'transparent' })!;
    const keys = r.sketch.chain!.map((e) => (e as { instance_key?: string }).instance_key);
    // The track FX is keyed track_<id>_<dev> and chains AFTER the clip's device.
    expect(keys).toContain(trackInstanceKey('T', 'tfx'));
    expect(keys.indexOf(trackInstanceKey('T', 'tfx'))).toBeGreaterThan(keys.indexOf(clipInstanceKey('A', 'Ad0')));
    expect(r.sketch.chain!.find((e) => (e as { instance_key?: string }).instance_key === trackInstanceKey('T', 'tfx'))!.module_type)
      .toBe('color.invert');
  });

  it('a track FX instance is STABLE across the track\'s clips', () => {
    const track = { id: 'T', sketch: { devices: [dev('color.invert', 'tfx')] } } as any;
    const ka = buildCompositeSketch([{ clip: clip('A', 'source.solid_color'), track, opacity: 1 }], { mode: 'transparent' })!;
    const kb = buildCompositeSketch([{ clip: clip('B', 'source.noise'), track, opacity: 1 }], { mode: 'transparent' })!;
    // Different active clips, SAME track FX key (one persistent instance).
    const has = (r: typeof ka, k: string) => r.sketch.chain!.some((e) => (e as { instance_key?: string }).instance_key === k);
    expect(has(ka, trackInstanceKey('T', 'tfx'))).toBe(true);
    expect(has(kb, trackInstanceKey('T', 'tfx'))).toBe(true);
  });

  it('emits a colliding instance key ONCE (duplicate device id → no retype thrash)', () => {
    // Regression: a clip with two devices sharing an id (a data bug) maps both to
    // the SAME composite instance key. Emitting it twice with different module
    // types made the executor retype + recreate the instance every frame (1000s of
    // "module initialized"). The collision must be dropped, keeping the first.
    const broken = {
      id: 'X',
      sketch: { devices: [
        { id: 'dup', moduleType: 'source.solid_color', name: '', capabilities: [], state: {} },
        { id: 'dup', moduleType: 'color.invert', name: '', capabilities: [], state: {} },
      ] },
    } as any;
    const r = buildCompositeSketch([{ clip: broken, opacity: 1 }], { mode: 'transparent' })!;
    const key = clipInstanceKey('X', 'dup');
    const occ = r.sketch.chain!.filter((e) => (e as { instance_key?: string }).instance_key === key);
    expect(occ.length).toBe(1); // collision dropped, not emitted twice
    expect(occ[0].module_type).toBe('source.solid_color'); // first wins
  });

  it('a lone effect-only clip processes the transparent base (no blend, no wires)', () => {
    const r = buildCompositeSketch([{ clip: clip('E', 'color.invert'), opacity: 1 }], { mode: 'transparent' })!;
    expect(r.sketch.chain!.map((e) => e.module_type)).toEqual(['color.invert']);
    expect(r.sketch.wires).toEqual([]);
  });

  it('bakes the clip start (startSec) onto the clip effect chain entries (for effect seeks)', () => {
    const r = buildCompositeSketch([{ clip: clip('E', 'color.invert'), opacity: 1, startSec: 4.5 }], { mode: 'transparent' })!;
    const entry = r.sketch.chain!.find((e) => e.module_type === 'color.invert') as { startSec?: number };
    expect(entry.startSec).toBe(4.5);
    // Omitted ⇒ no startSec key (defaults to 0 in the executor).
    const r2 = buildCompositeSketch([{ clip: clip('E', 'color.invert'), opacity: 1 }], { mode: 'transparent' })!;
    expect((r2.sketch.chain!.find((e) => e.module_type === 'color.invert') as { startSec?: number }).startSec).toBeUndefined();
  });

  it('per-track opacity rides the blend for sources and __opacity__ for effects', () => {
    const r = buildCompositeSketch([
      { clip: clip('A', 'source.noise'), opacity: 1 },
      { clip: clip('B', 'source.noise'), opacity: 0.5, blendMode: 2 }, // source → blend
      { clip: clip('C', 'color.invert'), opacity: 0.3 }, // effect → __opacity__
    ], { mode: 'transparent' })!;
    const blend = r.sketch.chain!.find((e) => e.module_type === 'composite.blend')!;
    const bState = r.sketch.instances![blend.instance_key].state as any;
    expect(bState.opacity).toBe(0.5);
    expect(bState.mode).toBe(2); // blend mode threaded through
    const inv = r.sketch.chain!.find((e) => e.module_type === 'color.invert')!;
    expect((r.sketch.instances![inv.instance_key].state as any).__opacity__).toBe(0.3);
  });

  it('folds a clip modulation wire into the composite (remapped) and a mod node does not advance the accumulator', () => {
    const c = {
      id: 'M',
      sketch: {
        devices: [dev('source.solid_color', 'Md0'), dev('mod.source.lfo', 'Md1'), dev('color.saturate', 'Md2')],
        wires: [{ id: 'wq', src: { instanceKey: 'Md1', field: 'output' }, dest: { instanceKey: 'Md2', field: 'prescale' }, combine: 'add' }],
      },
    } as any;
    const r = buildCompositeSketch([{ clip: c, opacity: 1 }])!;
    // The LFO is in the chain (so it runs + publishes its output) ...
    expect(r.sketch.chain!.map((e) => e.module_type)).toContain('mod.source.lfo');
    // ... and the wire is folded in, remapped to composite instance keys.
    const w = r.sketch.wires!.find((x) => x.src.field === 'output')!;
    expect(w.src.instanceKey).toBe(clipInstanceKey('M', 'Md1'));
    expect(w.dest.instanceKey).toBe(clipInstanceKey('M', 'Md2'));
    expect(w.dest.field).toBe('prescale');
    expect(w.combine).toBe('add');
  });

  it('returns null for an empty stack', () => {
    expect(buildCompositeSketch([])).toBeNull();
  });

  describe('rail (return) routing → cross-clip wires', () => {
    const writerClip = (railId: string) => ({
      id: 'W',
      sketch: { devices: [dev('source.solid_color', 'Wsrc'), dev('mod.source.lfo', 'Wlfo')] },
      exports: [{ id: 'e1', railId, sourceDeviceId: 'Wlfo', sourceField: 'output', combine: 'add', magnitude: 'auto' }],
    }) as any;
    const readerClip = (railId: string, magnitude = 'signed') => ({
      id: 'R',
      sketch: { devices: [dev('source.noise', 'Rsrc')] },
      reads: [{ id: 'r1', railId, targetDeviceId: 'Rsrc', targetField: 'scale', combine: 'add', magnitude }],
    }) as any;

    it('routes writer → rail accumulator → reader in two stages; magnitude follows the return mode', () => {
      const r = buildCompositeSketch([
        { clip: writerClip('rail1'), opacity: 1 },
        { clip: readerClip('rail1'), opacity: 1 },
      ], { mode: 'transparent' })!;
      const railKey = 'rail_rail1';
      // A `mod.shaper.remap` accumulator node was inserted for the rail.
      expect(r.sketch.chain!.some((e) => (e as any).instance_key === railKey
        && e.module_type === 'mod.shaper.remap')).toBe(true);
      // Stage 1: writer output → rail.input (EXPORT combine). The LFO is a signed
      // [-1,1] source; into the default UNSIGNED rail it maps to [0,1] via the wire
      // remap (no magnitude — the combine folds the remapped value).
      const s1 = r.sketch.wires!.find((x) => x.src.instanceKey === clipInstanceKey('W', 'Wlfo'));
      expect(s1).toBeTruthy();
      expect(s1!.dest).toEqual({ instanceKey: railKey, field: 'input' });
      expect(s1!.combine).toBe('add');
      expect(s1!.magnitude).toBeUndefined();
      expect(s1!.mod?.remap).toMatchObject({ inMin: -1, inMax: 1, outMin: 0, outMax: 1 });
      // Stage 2: rail.output → reader param. Default return mode is unsigned.
      const s2 = r.sketch.wires!.find((x) => x.dest.instanceKey === clipInstanceKey('R', 'Rsrc') && x.dest.field === 'scale');
      expect(s2).toBeTruthy();
      expect(s2!.src).toEqual({ instanceKey: railKey, field: 'output' });
      expect(s2!.magnitude).toBe('unsigned');
    });

    it('a SIGNED return makes the rail bipolar: prescaled writers, [-1,1] relay, signed read', () => {
      const r = buildCompositeSketch(
        [{ clip: writerClip('rail1'), opacity: 1 }, { clip: readerClip('rail1'), opacity: 1 }],
        { mode: 'transparent' }, undefined, new Map([['rail1', true]]),
      )!;
      // The relay node carries bipolar values: remap widened to [-1,1]→[-1,1].
      const railNode = r.sketch.instances!['rail_rail1'] as { state?: Record<string, number> };
      expect(railNode.state).toMatchObject({ in_min: -1, in_max: 1, out_min: -1, out_max: 1 });
      // Stage 1 (writer → input): the LFO is already signed [-1,1], so into a signed
      // rail the remap is identity ([-1,1]→[-1,1]); NO magnitude (combine sums ±).
      const s1 = r.sketch.wires!.find((x) => x.dest.instanceKey === 'rail_rail1' && x.dest.field === 'input')!;
      expect(s1.magnitude).toBeUndefined();
      expect(s1.mod?.remap).toMatchObject({ inMin: -1, inMax: 1, outMin: -1, outMax: 1 });
      // Stage 2 (output → reader): signed magnitude maps the bipolar rail into the param.
      const s2 = r.sketch.wires!.find((x) => x.src.instanceKey === 'rail_rail1' && x.src.field === 'output')!;
      expect(s2.magnitude).toBe('signed');
    });

    it('a writer-less reader still gets the rail (base-curve) value: node + stage-2 wire, no stage-1', () => {
      const r = buildCompositeSketch([{ clip: readerClip('rail1'), opacity: 1 }], { mode: 'transparent' })!;
      expect(r.sketch.chain!.some((e) => (e as any).instance_key === 'rail_rail1')).toBe(true);
      // stage 2 exists (rail → reader); no stage-1 writer wire into the rail input.
      expect((r.sketch.wires ?? []).some((x) => x.src.instanceKey === 'rail_rail1' && x.dest.field === 'scale')).toBe(true);
      expect((r.sketch.wires ?? []).some((x) => x.dest.instanceKey === 'rail_rail1')).toBe(false);
    });

    it('bakes the rail base value into the accumulator input (writers fold onto it)', () => {
      const r = buildCompositeSketch(
        [{ clip: writerClip('rail1'), opacity: 1 }, { clip: readerClip('rail1'), opacity: 1 }],
        { mode: 'transparent' },
        new Map([['rail1', 0.42]]),
      )!;
      expect((r.sketch.instances!['rail_rail1'].state as any).input).toBe(0.42);
    });

    it('does not cross rails (writer on railA, reader on railB ⇒ no writer wire)', () => {
      const r = buildCompositeSketch([
        { clip: writerClip('railA'), opacity: 1 },
        { clip: readerClip('railB'), opacity: 1 },
      ], { mode: 'transparent' })!;
      expect((r.sketch.wires ?? []).some((x) => x.src.instanceKey === clipInstanceKey('W', 'Wlfo'))).toBe(false);
    });
  });

  describe('composite background base', () => {
    it('default (black) lays an opaque solid base UNDER all clips', () => {
      const r = buildCompositeSketch([{ clip: clip('A', 'source.noise'), opacity: 1 }])!;
      const base = r.sketch.chain![0];
      expect(base.module_type).toBe('source.solid_color');
      expect(base.instance_key).toBe('arr_bg');
      expect((r.sketch.instances!['arr_bg'].state as any).color).toEqual([0, 0, 0]);
      // The clip composites OVER the base (a blend appears even for the 1st layer).
      expect(r.sketch.chain!.some((e) => e.module_type === 'composite.blend')).toBe(true);
    });

    it('custom color sets the base color (hex → normalized rgb)', () => {
      const r = buildCompositeSketch(
        [{ clip: clip('A', 'source.noise'), opacity: 1 }],
        { mode: 'custom', color: '#ff8000' },
      )!;
      const c = (r.sketch.instances!['arr_bg'].state as any).color as number[];
      expect(c[0]).toBeCloseTo(1);
      expect(c[1]).toBeCloseTo(128 / 255);
      expect(c[2]).toBeCloseTo(0);
    });

    it('transparent adds NO base (keeps a transparent accumulator)', () => {
      const r = buildCompositeSketch([{ clip: clip('A', 'source.noise'), opacity: 1 }], { mode: 'transparent' })!;
      expect(r.sketch.chain!.some((e) => e.instance_key === 'arr_bg')).toBe(false);
    });

    it('an empty stack never gets a base (renders nothing)', () => {
      expect(buildCompositeSketch([], { mode: 'black' })).toBeNull();
    });
  });

  it('a video clip uses source.video.file as its source and composites over', () => {
    const r = buildCompositeSketch([
      { clip: clip('A', 'source.noise'), opacity: 1 }, // top background
      { clip: clip('V', 'source.video.file'), opacity: 1 }, // video below → blend over
    ], { mode: 'transparent' })!;
    const types = r.sketch.chain!.map((e) => e.module_type);
    expect(types).toContain('source.video.file');
    expect(types.filter((t) => t === 'composite.blend').length).toBe(1);
    // The video entry's instance key is exactly what the decode pump feeds.
    const vKey = clipInstanceKey('V', 'Vd0');
    expect(
      r.sketch.chain!.some((e) => e.instance_key === vKey && e.module_type === 'source.video.file'),
    ).toBe(true);
  });
});
