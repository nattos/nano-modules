// @vitest-environment happy-dom
/**
 * The wire-mod inspector's `raw` gate.
 *
 * A `raw` destination (schema "raw":true — host.h's Schema::raw()) opts out of
 * the executor's magnitude fold, so the Magnitude select would sit there doing
 * nothing. It's dropped for those wires and kept for every other one.
 *
 * Scope matters as much as presence: raw suppresses ONLY the magnitude fold —
 * the wire's own shaping stages and its combine mode still apply, matching
 * destIsRaw in sketch_executor.cpp. So the rest of the panel must survive.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from 'lit';
import { renderWireModInspector, wireModBinding } from './wire-mod-inspector';
import type { FieldBinding } from './field-editor';
import type { Wire } from '../sketch-types';

const wire: Wire = {
  id: 'w0',
  src: { instanceKey: 'lfo', field: 'output' },
  dest: { instanceKey: 'bc', field: 'brightness' },
  combine: 'replace',
};

function binding(): FieldBinding {
  return {
    instanceKey: 'k',
    getValue: (path: string) => (path === 'combine' ? 'replace'
                              : path === 'magnitude' ? 'auto' : undefined),
    setValue: vi.fn(),
    beginContinuousEdit: vi.fn(() => ({ update: vi.fn(), accept: vi.fn(), cancel: vi.fn() })),
  };
}

/**
 * The wire paths the panel renders a row for. Read off each row element's
 * `fieldPath` property rather than its text: the labels live inside the field
 * widgets' shadow roots, which textContent doesn't cross.
 */
function paths(rawDest = false, destDef?: { type?: string; hint?: string } | null,
                w: Wire = wire): string[] {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(renderWireModInspector(w, binding(), rawDest, destDef), host);
  const out: string[] = [];
  for (const el of Array.from(host.querySelectorAll('*'))) {
    const p = (el as unknown as { fieldPath?: unknown }).fieldPath;
    if (typeof p === 'string' && p) out.push(p);
  }
  host.remove();
  return out;
}

describe('renderWireModInspector raw gate', () => {
  it('offers Magnitude for an ordinary destination', () => {
    expect(paths(false)).toContain('magnitude');
  });

  it('drops Magnitude for a raw destination', () => {
    expect(paths(true)).not.toContain('magnitude');
  });

  it('keeps every other stage for a raw destination', () => {
    // The wire's shaping and combine are properties of the WIRE, not of the
    // dest field — raw must not take them with it.
    const shown = paths(true);
    for (const p of ['envelopeEnabled', 'remapEnabled', 'scale', 'delay', 'combine']) {
      expect(shown).toContain(p);
    }
  });

  it('defaults to the non-raw panel when the flag is omitted', () => {
    expect(paths()).toContain('magnitude');
  });
});

describe('renderWireModInspector vector rows', () => {
  const VEC2 = { type: 'float2' };
  const vecWire = (lane?: number): Wire => ({
    ...wire,
    dest: { instanceKey: 'tf', field: 'translate', ...(lane != null ? { lane } : {}) },
  });

  it('offers no lane or fit row for a scalar destination', () => {
    const shown = paths(false, { type: 'float' });
    expect(shown).not.toContain('lane');
    expect(shown).not.toContain('convert');
  });

  it('offers both for a whole-field vector wire', () => {
    const shown = paths(false, VEC2, vecWire());
    expect(shown).toContain('lane');
    expect(shown).toContain('convert');
  });

  it('drops the fit row once a lane is chosen — there is nothing left to fit', () => {
    const shown = paths(false, VEC2, vecWire(1));
    expect(shown).toContain('lane');
    expect(shown).not.toContain('convert');
  });

  it('keeps the ordinary stages for a vector destination', () => {
    // A vec wire folds per lane like any other, so its shaping controls are
    // the same ones. They used to be gated out of the field card entirely.
    const shown = paths(false, VEC2, vecWire(0));
    for (const p of ['magnitude', 'envelopeEnabled', 'remapEnabled', 'scale', 'combine']) {
      expect(shown).toContain(p);
    }
  });
});

describe('wireModBinding lane and convert', () => {
  const ops = (w: Wire) => ({
    getWire: () => w,
    updateWire: vi.fn(),
    beginUpdateWire: vi.fn(() => ({ accept: vi.fn(), cancel: vi.fn() })),
    updateUpdateWire: vi.fn(),
  });

  it("reads an absent lane as 'all'", () => {
    const w: Wire = { ...wire, dest: { instanceKey: 'tf', field: 'translate' } };
    const o = ops(w);
    expect(wireModBinding('k', o).getValue('lane')).toBe('all');
    expect(wireModBinding('k', o).getValue('convert')).toBe('auto');
  });

  it('reads a chosen lane as its index', () => {
    const w: Wire = { ...wire, dest: { instanceKey: 'tf', field: 'translate', lane: 2 } };
    expect(wireModBinding('k', ops(w)).getValue('lane')).toBe('2');
  });

  it('writing a lane replaces the endpoint, keeping instance and field', () => {
    const w: Wire = { ...wire, dest: { instanceKey: 'tf', field: 'translate' } };
    const o = ops(w);
    wireModBinding('k', o).setValue('lane', '1');
    expect(o.updateWire).toHaveBeenCalledWith(
      { dest: { instanceKey: 'tf', field: 'translate', lane: 1 } });
  });

  it("writing 'all' DROPS the key rather than storing a sentinel", () => {
    const w: Wire = { ...wire, dest: { instanceKey: 'tf', field: 'translate', lane: 1 } };
    const o = ops(w);
    wireModBinding('k', o).setValue('lane', 'all');
    const patch = o.updateWire.mock.calls[0][0] as { dest: Record<string, unknown> };
    expect('lane' in patch.dest).toBe(false);
    expect(patch.dest).toEqual({ instanceKey: 'tf', field: 'translate' });
  });
});
