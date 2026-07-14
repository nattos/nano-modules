import { describe, it, expect } from 'vitest';
import {
  effectPath, parseEffectPath, buildEffectsPayload, remapEffectsPayload, isEffectsClipboard,
} from './effects-payload';
import type { Sketch } from '../sketch-types';
import { UI_ONLY_KEY } from '../sketch-types';

/** Three-module sketch: blur → lfo → tint, with an internal wire (lfo→tint),
 *  an external one (blur→lfo — external once only [lfo, tint] is copied), and
 *  a MIDI mapping into tint (external source that must still ride along). */
function makeSketch(): Sketch {
  return {
    chain: [
      { type: 'module', module_type: 'video.blur', instance_key: 'blur@1' },
      {
        type: 'module', module_type: 'source.lfo', instance_key: 'lfo@1',
        fieldOptions: { rate: { smoothing: { enabled: true, timeMs: 50 } } } as any,
      },
      { type: 'module', module_type: 'video.tint', instance_key: 'tint@1' },
    ],
    wires: [
      {
        id: 'w_ext',
        src: { instanceKey: 'blur@1', field: 'radius' },
        dest: { instanceKey: 'lfo@1', field: 'rate' },
      },
      {
        id: 'w_int',
        src: { instanceKey: 'lfo@1', field: 'value' },
        dest: { instanceKey: 'tint@1', field: 'amount' },
        combine: 'add',
      },
      {
        id: 'w_midi',
        src: { instanceKey: 'midi:devA', field: 'b0/e05/turn' },
        dest: { instanceKey: 'tint@1', field: 'color' },
        combine: 'replace',
        mod: { scale: 0.5 },
      },
    ],
    instances: {
      'blur@1': { module_type: 'video.blur', state: { radius: 3 } },
      'lfo@1': { module_type: 'source.lfo', state: { rate: 2, [UI_ONLY_KEY]: { collapsed: true } } },
      'tint@1': { module_type: 'video.tint', state: { amount: 0.5 } },
    },
  } as unknown as Sketch;
}

describe('effect paths', () => {
  it('round-trips through parse', () => {
    expect(parseEffectPath(effectPath('pg:abc', 0, 3)))
      .toEqual({ sketchId: 'pg:abc', colIdx: 0, chainIdx: 3 });
  });

  it('rejects non-effect and malformed paths', () => {
    expect(parseEffectPath('wire/sk/w_1')).toBeNull();
    expect(parseEffectPath('field/sk/0/1/rate')).toBeNull();
    expect(parseEffectPath('effect/sk/x/y')).toBeNull();
    expect(parseEffectPath('effect/sk')).toBeNull();
  });
});

describe('buildEffectsPayload', () => {
  it('captures items in chain order with internal + midi wires only', () => {
    // Keys deliberately in REVERSE chain order — items must come out in chain order.
    const p = buildEffectsPayload(makeSketch(), ['tint@1', 'lfo@1'])!;
    expect(p.kind).toBe('effects');
    expect(p.items.map(i => i.key)).toEqual(['lfo@1', 'tint@1']);
    expect(p.items.map(i => i.moduleType)).toEqual(['source.lfo', 'video.tint']);
    // Internal wire (lfo→tint) + midi mapping (midi:devA→tint) captured;
    // external (blur→lfo) dropped.
    expect(p.wires.map(w => w.id)).toEqual(['w_int', 'w_midi']);
    expect(p.wires[0].combine).toBe('add');
  });

  it('drops a midi wire whose DEST is outside the group', () => {
    const p = buildEffectsPayload(makeSketch(), ['lfo@1'])!;
    expect(p.wires).toEqual([]);
  });

  it('strips UI-only state and keeps fieldOptions', () => {
    const p = buildEffectsPayload(makeSketch(), ['lfo@1'])!;
    expect(p.items[0].state).toEqual({ rate: 2 });
    expect(p.items[0].fieldOptions).toEqual({ rate: { smoothing: { enabled: true, timeMs: 50 } } });
  });

  it('deep-copies (mutating the payload leaves the sketch alone)', () => {
    const sk = makeSketch();
    const p = buildEffectsPayload(sk, ['tint@1'])!;
    p.items[0].state.amount = 999;
    expect((sk.instances!['tint@1'].state as any).amount).toBe(0.5);
  });

  it('returns null when no key resolves to a live entry', () => {
    expect(buildEffectsPayload(makeSketch(), ['nope@1'])).toBeNull();
    expect(buildEffectsPayload(makeSketch(), [])).toBeNull();
  });
});

describe('remapEffectsPayload', () => {
  it('mints fresh keys and remaps wire endpoints + ids onto them', () => {
    const p = buildEffectsPayload(makeSketch(), ['lfo@1', 'tint@1'])!;
    const r = remapEffectsPayload(p, (mt, i) => `new_${mt}_${i}`, i => `wire_new_${i}`);
    expect(r.items.map(i => i.newKey)).toEqual(['new_source.lfo_0', 'new_video.tint_1']);
    expect(r.wires).toHaveLength(2);
    expect(r.wires[0].id).toBe('wire_new_0');
    expect(r.wires[0].src).toEqual({ instanceKey: 'new_source.lfo_0', field: 'value' });
    expect(r.wires[0].dest).toEqual({ instanceKey: 'new_video.tint_1', field: 'amount' });
    // The midi mapping keeps its app-level source verbatim; dest + id are fresh.
    expect(r.wires[1].id).toBe('wire_new_1');
    expect(r.wires[1].src).toEqual({ instanceKey: 'midi:devA', field: 'b0/e05/turn' });
    expect(r.wires[1].dest).toEqual({ instanceKey: 'new_video.tint_1', field: 'color' });
    expect(r.wires[1].mod).toEqual({ scale: 0.5 });
  });

  it('drops wires whose endpoints are missing from the items (hand-edited JSON)', () => {
    const p = buildEffectsPayload(makeSketch(), ['lfo@1', 'tint@1'])!;
    p.wires.push({
      id: 'w_bogus',
      src: { instanceKey: 'ghost@1', field: 'x' },
      dest: { instanceKey: 'tint@1', field: 'amount' },
    });
    const r = remapEffectsPayload(p, (_mt, i) => `k${i}`, i => `w${i}`);
    // w_int + w_midi survive (fresh ids); the ghost-sourced wire is dropped.
    expect(r.wires.map(w => w.id)).toEqual(['w0', 'w1']);
  });
});

describe('isEffectsClipboard', () => {
  it('accepts a built payload (including after a JSON round-trip)', () => {
    const p = buildEffectsPayload(makeSketch(), ['lfo@1', 'tint@1'])!;
    expect(isEffectsClipboard(p)).toBe(true);
    expect(isEffectsClipboard(JSON.parse(JSON.stringify(p)))).toBe(true);
  });

  it('rejects other shapes', () => {
    expect(isEffectsClipboard(null)).toBe(false);
    expect(isEffectsClipboard({ kind: 'effect', moduleType: 'x', state: {} })).toBe(false);
    expect(isEffectsClipboard({ kind: 'effects', items: [] })).toBe(false);
    expect(isEffectsClipboard({ kind: 'effects', items: [{ moduleType: 'x' }] })).toBe(false);
    expect(isEffectsClipboard({ kind: 'effects', items: [{ moduleType: 'x', key: 'k', state: {} }], wires: 'no' })).toBe(false);
  });
});
