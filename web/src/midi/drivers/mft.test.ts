/**
 * MFT driver goldens — byte-level parse/render fixtures.
 *
 * The cases live in native/tests/fixtures/mft_goldens.json, the LOCK-STEP
 * contract shared with the native C++ driver (native/src/midi/mft_driver.h,
 * exercised by native/tests/test_mft_driver.cpp): same MIDI bytes in → same
 * {controlId, value} out on both platforms.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ControlEvent, DriverContext, parseControlId } from '../midi-types';
import { defaultMftConfig, MftConfig, MftDriver } from './mft';

interface GoldenCase {
  name: string;
  configPatch?: Record<string, Record<string, Record<string, unknown>>>;
  seedValues?: Record<string, number>;
  messages: number[][];
  expect: ControlEvent[];
  expectBank?: number;
}
interface RenderCase {
  name: string;
  configPatch?: GoldenCase['configPatch'];
  values: Record<string, number>;
  expect: number[][];
  repeatExpect: number[][];
}

const GOLDENS: { parse: GoldenCase[]; render: RenderCase[] } = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../native/tests/fixtures/mft_goldens.json', import.meta.url)),
  'utf8'));

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

/** Sparse fixture patch: { encoders: { "5": { mode: "relative" } } } merges
 *  into config.encoders[5] — same application as the C++ test. */
function applyConfigPatch(config: MftConfig, patch?: GoldenCase['configPatch']) {
  for (const [section, entries] of Object.entries(patch ?? {})) {
    for (const [idx, fields] of Object.entries(entries)) {
      Object.assign((config as unknown as Record<string, Record<string, object>>)[section][idx], fields);
    }
  }
}

describe('MftDriver parse (shared goldens)', () => {
  for (const g of GOLDENS.parse) {
    it(g.name, () => {
      const ctx = new FakeContext();
      applyConfigPatch(ctx.config, g.configPatch);
      for (const [k, v] of Object.entries(g.seedValues ?? {})) ctx.values.set(k, v);
      const driver = new MftDriver(ctx);
      for (const m of g.messages) driver.onMidiMessage(new Uint8Array(m), 0);
      expect(ctx.emitted.map(e => e.controlId)).toEqual(g.expect.map(e => e.controlId));
      ctx.emitted.forEach((e, i) => expect(e.value).toBeCloseTo(g.expect[i].value, 6));
      if (g.expectBank !== undefined) expect(driver.activeBank).toBe(g.expectBank);
    });
  }
});

describe('MftDriver renderOutput (shared goldens)', () => {
  for (const g of GOLDENS.render) {
    it(g.name, () => {
      const ctx = new FakeContext();
      applyConfigPatch(ctx.config, g.configPatch);
      const driver = new MftDriver(ctx);
      const values = new Map(Object.entries(g.values));
      driver.renderOutput(values);
      expect(ctx.sent).toEqual(g.expect);
      ctx.sent.length = 0;
      driver.renderOutput(values);
      expect(ctx.sent).toEqual(g.repeatExpect);
    });
  }

  it('sends only the delta after a value change', () => {
    const ctx = new FakeContext();
    const driver = new MftDriver(ctx);
    const values = new Map([['b0/e05/turn', 0.5], ['b1/e00/turn', 1]]);
    driver.renderOutput(values);
    ctx.sent.length = 0;
    values.set('b0/e05/turn', 0);
    driver.renderOutput(values);
    expect(ctx.sent).toEqual([[0xb0, 5, 0]]);
  });
});

// TS-side extras (not part of the byte contract).
describe('MftDriver config invalidation', () => {
  it('config edits invalidate CC lookups after configChanged()', () => {
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

  it('bank-change notification updates activeBank once', () => {
    const ctx = new FakeContext();
    const driver = new MftDriver(ctx);
    driver.onMidiMessage(new Uint8Array([0xb3, 2, 127]), 0);
    driver.onMidiMessage(new Uint8Array([0xb3, 2, 127]), 0);
    expect(driver.activeBank).toBe(2);
    expect(ctx.banks).toEqual([2]);
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
