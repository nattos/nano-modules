/**
 * MFT driver goldens — byte-level parse/render fixtures.
 *
 * The PARSE_GOLDENS / RENDER_GOLDENS tables are the lock-step contract with
 * the native C++ driver (native/src/midi/mft_driver.h): the Catch2 side will
 * consume the same cases so web and native emit identical ids/values.
 */
import { describe, expect, it } from 'vitest';
import { ControlEvent, DriverContext, parseControlId } from '../midi-types';
import { defaultMftConfig, MftConfig, MftDriver } from './mft';

class FakeContext implements DriverContext<MftConfig> {
  config = defaultMftConfig();
  sent: number[][] = [];
  emitted: ControlEvent[] = [];
  banks: number[] = [];
  values = new Map<string, number>();
  send(bytes: number[] | Uint8Array) { this.sent.push([...bytes]); }
  emit(events: ControlEvent[]) { this.emitted.push(...events); }
  getValue(controlId: string) { return this.values.get(controlId) ?? 0; }
  onBankChanged(bank: number) { this.banks.push(bank); }
}

function drive(ctx: FakeContext, messages: number[][]): MftDriver {
  const driver = new MftDriver(ctx);
  for (const m of messages) driver.onMidiMessage(new Uint8Array(m), 0);
  return driver;
}

// Factory config: encoders CC 0..63 ch1 (0-based 0), buttons ch2, shift ch5,
// bank notifications ch4. One golden per protocol behavior.
const PARSE_GOLDENS: {
  name: string;
  messages: number[][];
  expect: ControlEvent[];
}[] = [
  {
    name: 'encoder turn, bank 0',
    messages: [[0xb0, 5, 100]],
    expect: [{ controlId: 'b0/e05/turn', value: 100 / 127 }],
  },
  {
    name: 'encoder turn, bank 1 (factory CCs are bank*16+idx)',
    messages: [[0xb0, 21, 0]],
    expect: [{ controlId: 'b1/e05/turn', value: 0 }],
  },
  {
    name: 'encoder turn, full scale',
    messages: [[0xb0, 63, 127]],
    expect: [{ controlId: 'b3/e15/turn', value: 1 }],
  },
  {
    name: 'button press + release (threshold 64)',
    messages: [[0xb1, 5, 127], [0xb1, 5, 63]],
    expect: [
      { controlId: 'b0/e05/press', value: 1 },
      { controlId: 'b0/e05/press', value: 0 },
    ],
  },
  {
    name: 'shifted turn rides the shift channel',
    messages: [[0xb4, 12, 64]],
    expect: [{ controlId: 'b0/e12/shift', value: 64 / 127 }],
  },
  {
    name: 'unmapped CC is ignored',
    messages: [[0xb0, 90, 10]],
    expect: [],
  },
  {
    name: 'non-CC status is ignored',
    messages: [[0x90, 5, 100]],
    expect: [],
  },
  {
    name: 'bank change emits no control event',
    messages: [[0xb3, 2, 127]],
    expect: [],
  },
];

describe('MftDriver parse', () => {
  for (const g of PARSE_GOLDENS) {
    it(g.name, () => {
      const ctx = new FakeContext();
      drive(ctx, g.messages);
      expect(ctx.emitted).toEqual(g.expect);
    });
  }

  it('bank-change notification updates activeBank once', () => {
    const ctx = new FakeContext();
    const driver = drive(ctx, [[0xb3, 2, 127], [0xb3, 2, 127]]);
    expect(driver.activeBank).toBe(2);
    expect(ctx.banks).toEqual([2]);   // repeat is a no-op
  });

  it('relative mode integrates offset-64 deltas against the hardware value', () => {
    const ctx = new FakeContext();
    ctx.config.encoders[5].mode = 'relative';
    ctx.values.set('b0/e05/turn', 0.5);
    drive(ctx, [[0xb0, 5, 65]]);
    expect(ctx.emitted).toEqual([{ controlId: 'b0/e05/turn', value: 0.5 + 1 / 127 }]);

    const ctx2 = new FakeContext();
    ctx2.config.encoders[5].mode = 'relative';
    ctx2.values.set('b0/e05/turn', 0);
    drive(ctx2, [[0xb0, 5, 63]]);
    expect(ctx2.emitted).toEqual([{ controlId: 'b0/e05/turn', value: 0 }]);  // clamped
  });

  it('shifted turn follows its encoder slot mode (relative)', () => {
    const ctx = new FakeContext();
    ctx.config.encoders[5].mode = 'relative';
    ctx.values.set('b0/e05/shift', 0.5);
    drive(ctx, [[0xb4, 5, 66]]);
    expect(ctx.emitted).toEqual([{ controlId: 'b0/e05/shift', value: 0.5 + 2 / 127 }]);
  });

  it('duplicate CC across banks resolves to the active bank', () => {
    const ctx = new FakeContext();
    // "All banks send CC 0-15" style fork: bank 1's encoders reuse CC 0..15.
    for (let i = 0; i < 16; i++) ctx.config.encoders[16 + i].cc = i;
    const driver = new MftDriver(ctx);
    driver.onMidiMessage(new Uint8Array([0xb3, 1, 127]), 0);   // switch to bank 1
    driver.onMidiMessage(new Uint8Array([0xb0, 5, 127]), 0);
    expect(ctx.emitted).toEqual([{ controlId: 'b1/e05/turn', value: 1 }]);
  });

  it('config edits invalidate CC lookups', () => {
    const ctx = new FakeContext();
    const driver = new MftDriver(ctx);
    driver.onMidiMessage(new Uint8Array([0xb0, 5, 127]), 0);
    ctx.config.encoders[5].cc = 90;
    driver.configChanged();
    driver.onMidiMessage(new Uint8Array([0xb0, 90, 0]), 0);
    expect(ctx.emitted).toEqual([
      { controlId: 'b0/e05/turn', value: 1 },
      { controlId: 'b0/e05/turn', value: 0 },
    ]);
  });
});

describe('MftDriver renderOutput', () => {
  it('echoes ring positions and sends cap colors, skipping unchanged bytes', () => {
    const ctx = new FakeContext();
    ctx.config.colors[5] = { cap: 40 };
    const driver = new MftDriver(ctx);
    const values = new Map([['b0/e05/turn', 0.5], ['b1/e00/turn', 1]]);

    driver.renderOutput(values);
    expect(ctx.sent).toEqual([
      [0xb0, 5, 64],     // ring echo, round(0.5*127)
      [0xb1, 5, 40],     // cap color on the button channel
      [0xb0, 16, 127],   // bank 1 encoder 0 ring echo
    ]);

    ctx.sent.length = 0;
    driver.renderOutput(values);                 // nothing changed
    expect(ctx.sent).toEqual([]);

    values.set('b0/e05/turn', 0);
    driver.renderOutput(values);                 // only the delta goes out
    expect(ctx.sent).toEqual([[0xb0, 5, 0]]);
  });
});

describe('endpoint identity helpers', () => {
  it('round-trips endpoint fields', () => {
    expect(parseControlId('b2/e13/turn')).toEqual(
      { bank: 2, index: 13, gesture: 'turn', controlId: 'b2/e13' });
    expect(parseControlId('b0/e05/shift')?.gesture).toBe('shift');
    expect(parseControlId('nonsense')).toBeNull();
    expect(parseControlId('b0/e05')).toBeNull();
    expect(parseControlId('b0/e05/wiggle')).toBeNull();
  });
});
