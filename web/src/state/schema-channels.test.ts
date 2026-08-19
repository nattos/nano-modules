/**
 * Port selection for a spliced node (state/schema-channels.ts).
 *
 * `modChannel` is a lock-step port of the executor's own lambda, so these cases
 * pin the selection rule: magnitude-marked float, primary bit winning.
 */
import { describe, it, expect } from 'vitest';
import { IO_INPUT, IO_OUTPUT, modChannel, passthroughPorts, wireKindOfField }
  from './schema-channels';

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

  it('refuses a module that cannot carry the wire in BOTH directions', () => {
    // A source: float out, no float in — nothing can be spliced through it.
    expect(passthroughPorts({ output: { type: 'float', io: 2, magnitude: 'signed' } },
                            'float')).toBeNull();
    expect(passthroughPorts(shaper, 'texture')).toBeNull();
    expect(passthroughPorts(shaper, null)).toBeNull();
  });
});
