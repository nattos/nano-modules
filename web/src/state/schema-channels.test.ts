/**
 * Port selection for a spliced node (state/schema-channels.ts).
 *
 * `modChannel` is a lock-step port of the executor's own lambda, so these cases
 * pin the selection rule: magnitude-marked float, primary bit winning.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IO_INPUT, IO_OUTPUT, modChannel, passthroughPorts, resolveWireKind,
         wireKindOfField, type WireEdge } from './schema-channels';

const shaper = {
  input: { type: 'float', io: 5, magnitude: 'inherit' },   // in | primary
  output: { type: 'float', io: 2, magnitude: 'inherit' },
  amount: { type: 'float', io: 1 },                        // no magnitude marker
};

const filter = {
  tex_in: { type: 'texture', io: 1, order: 0 },
  tex_out: { type: 'texture', io: 2, order: 3 },
  brightness: { type: 'float', io: 1 },
};

describe('modChannel', () => {
  it('picks the magnitude-marked float for each direction', () => {
    expect(modChannel(shaper, IO_INPUT)).toBe('input');
    expect(modChannel(shaper, IO_OUTPUT)).toBe('output');
  });

  it('ignores floats with no magnitude marker', () => {
    expect(modChannel({ amount: { type: 'float', io: 1 } }, IO_INPUT)).toBe('');
  });

  it('prefers the PRIMARY channel over a plain marked one', () => {
    const two = {
      alt: { type: 'float', io: 1, magnitude: 'signed' },
      main: { type: 'float', io: 5, magnitude: 'signed' },
    };
    expect(modChannel(two, IO_INPUT)).toBe('main');
  });

  it('falls back to the first marked channel when none is primary', () => {
    const two = {
      a: { type: 'float', io: 1, magnitude: 'signed' },
      b: { type: 'float', io: 1, magnitude: 'signed' },
    };
    expect(modChannel(two, IO_INPUT)).toBe('a');
  });

  it('is empty for a missing schema', () => {
    expect(modChannel(undefined, IO_INPUT)).toBe('');
  });
});

describe('wireKindOfField', () => {
  it('classifies by the producer field s declared type', () => {
    expect(wireKindOfField(shaper, 'output')).toBe('float');
    expect(wireKindOfField(filter, 'tex_out')).toBe('texture');
    expect(wireKindOfField({ s: { type: 'object', io: 2 } }, 's')).toBe('struct');
    expect(wireKindOfField({ s: { type: 'string', io: 2 } }, 's')).toBeNull();
    expect(wireKindOfField(filter, 'nope')).toBeNull();
  });

  it('reports a polymorphic field as unresolved rather than guessing', () => {
    expect(wireKindOfField({ c: { type: 'any', io: 9 } }, 'c')).toBe('any');
  });

  it('classifies vectors and colours as one vec class', () => {
    // Widths collapse here; the executor's rail records the component count.
    expect(wireKindOfField({ c: { type: 'float3', io: 2 } }, 'c')).toBe('vec');
    expect(wireKindOfField({ c: { type: 'float2', io: 2 } }, 'c')).toBe('vec');
    expect(wireKindOfField({ c: { type: 'float4', io: 2 } }, 'c')).toBe('vec');
  });
});

/**
 * The shared goldens, replayed by native/tests/test_wire_types.cpp too. If these
 * two ever disagree the editor draws a connection the engine dropped (or refuses
 * one it would have made) — a divergence nothing else would catch.
 */
describe('resolveWireKind (shared fixture)', () => {
  const fx = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../test/fixtures/wire-type-cases.json', import.meta.url)),
    'utf8'));

  for (const c of fx.cases as any[]) {
    it(c.name, () => {
      const schemaOf = (key: string) => fx.schemas[c.chain[key]];
      const got = resolveWireKind(schemaOf, c.wires as WireEdge[],
                                  c.query.instanceKey, c.query.field);
      expect(got).toBe(c.expected);
    });
  }
});

describe('passthroughPorts', () => {
  it('routes a float wire through the modulation channels', () => {
    expect(passthroughPorts(shaper, 'float')).toEqual({ input: 'input', output: 'output' });
  });

  it('falls back to plain floats when the module declares no channel', () => {
    const plain = {
      gain: { type: 'float', io: 1, order: 1 },
      level: { type: 'float', io: 2, order: 2 },
    };
    expect(passthroughPorts(plain, 'float')).toEqual({ input: 'gain', output: 'level' });
  });

  it('routes a texture wire through the texture ports', () => {
    expect(passthroughPorts(filter, 'texture')).toEqual({ input: 'tex_in', output: 'tex_out' });
  });

  it('routes a vec wire through the vec ports', () => {
    const relay = { color: { type: 'float3', io: 7, order: 0 } };   // in|out|primary
    expect(passthroughPorts(relay, 'vec')).toEqual({ input: 'color', output: 'color' });
  });

  it('splices any wire through a polymorphic node', () => {
    // `any` ports carry whatever they are handed, so they match every concrete
    // class — that is what lets one Switch sit on a float wire or a texture one.
    const poly = {
      select: { type: 'float', io: 5, magnitude: 'unsigned', order: 0 },
      case_1: { type: 'any', io: 9, order: 1 },
      output: { type: 'any', io: 6, order: 2 },
    };
    expect(passthroughPorts(poly, 'texture')).toEqual({ input: 'case_1', output: 'output' });
    expect(passthroughPorts(poly, 'vec')).toEqual({ input: 'case_1', output: 'output' });
    // ...but an UNRESOLVED wire has no class to match, so there is nothing to
    // splice it through.
    expect(passthroughPorts(poly, 'any')).toBeNull();
  });

  it('refuses a module that cannot carry the wire in BOTH directions', () => {
    // A source: float out, no float in — nothing can be spliced through it.
    expect(passthroughPorts({ output: { type: 'float', io: 2, magnitude: 'signed' } },
                            'float')).toBeNull();
    expect(passthroughPorts(shaper, 'texture')).toBeNull();
    expect(passthroughPorts(shaper, null)).toBeNull();
  });
});
