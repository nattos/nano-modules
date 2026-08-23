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
import { renderWireModInspector } from './wire-mod-inspector';
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
function paths(rawDest = false): string[] {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(renderWireModInspector(wire, binding(), rawDest), host);
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
