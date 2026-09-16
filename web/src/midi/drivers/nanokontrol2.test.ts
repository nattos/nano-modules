/**
 * nanoKONTROL2 driver — parse/render behaviour.
 *
 * No shared native goldens yet (there is no C++ twin of this driver), so
 * these are TS-side unit tests rather than a lock-step byte contract. The
 * factory CC map is asserted explicitly: it is the one part of the template
 * that is copied from the manual rather than derived, so it deserves a test
 * that fails loudly if someone "tidies" the numbers.
 */

import { describe, expect, it } from 'vitest';
import { ControlEvent, DriverContext, parseControlId } from '../midi-types';
import {
  defaultNanoKontrol2Config, NanoKontrol2Config, NanoKontrol2Driver,
  nk2Endpoint, nk2GroupOf, NK2_SLOTS, NK2_SLOT_FADER, NK2_SLOT_KNOB,
  NK2_SLOT_MUTE, NK2_SLOT_REC, NK2_SLOT_SOLO, NK2_SLOT_TRANSPORT,
  NK2_TEMPLATE, NK2_TRANSPORT,
} from './nanokontrol2';

class FakeContext implements DriverContext<NanoKontrol2Config> {
  config = defaultNanoKontrol2Config();
  sent: number[][] = [];
  emitted: ControlEvent[] = [];
  banks: number[] = [];
  values = new Map<string, number>();
  send(bytes: number[] | Uint8Array) { this.sent.push([...bytes]); }
  emit(events: ControlEvent[]) { this.emitted.push(...events); }
  getValue(controlId: string) { return this.values.get(controlId) ?? 0; }
  onBankChanged(bank: number) { this.banks.push(bank); }
}

const cc = (channel: number, num: number, value: number) =>
  new Uint8Array([0xb0 | channel, num, value]);

describe('nanoKONTROL2 factory config', () => {
  it('matches the manual\'s stock CC-mode scene', () => {
    const c = defaultNanoKontrol2Config();
    expect(c.channel).toBe(0);
    expect(c.faders.map(f => f.cc)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(c.knobs.map(k => k.cc)).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
    expect(c.solo.map(s => s.cc)).toEqual([32, 33, 34, 35, 36, 37, 38, 39]);
    expect(c.mute.map(m => m.cc)).toEqual([48, 49, 50, 51, 52, 53, 54, 55]);
    expect(c.rec.map(r => r.cc)).toEqual([64, 65, 66, 67, 68, 69, 70, 71]);
    expect(Object.fromEntries(NK2_TRANSPORT.map((k, i) => [k, c.transport[i].cc]))).toEqual({
      trackPrev: 58, trackNext: 59, cycle: 46, markerSet: 60, markerPrev: 61,
      markerNext: 62, rew: 43, ff: 44, stop: 42, play: 41, rec: 45,
    });
  });

  it('assigns every slot a distinct CC', () => {
    const c = defaultNanoKontrol2Config();
    const all = [...c.faders, ...c.knobs, ...c.solo, ...c.mute, ...c.rec, ...c.transport];
    expect(all).toHaveLength(NK2_SLOTS);
    expect(new Set(all.map(e => e.cc)).size).toBe(NK2_SLOTS);
  });
});

describe('nanoKONTROL2 layout', () => {
  const { layout } = NK2_TEMPLATE;

  it('has one control per slot, all on the single bank', () => {
    expect(layout.banks).toBe(1);
    expect(layout.controls).toHaveLength(NK2_SLOTS);
    const ids = new Set(layout.controls.map(c => c.id));
    expect(ids.size).toBe(NK2_SLOTS);
    for (const c of layout.controls) expect(c.bank).toBeUndefined();
  });

  it('gives each control exactly the gesture its kind publishes', () => {
    for (const c of layout.controls) {
      const slot = parseControlId(`${c.id}/turn`)!.index;
      const group = nk2GroupOf(slot)!.group;
      if (group === 'faders') expect(c.kind).toBe('slider');
      else if (group === 'knobs') expect(c.kind).toBe('encoder');
      else expect(c.kind).toBe('button');
      expect(c.gestures).toEqual([c.kind === 'button' ? 'press' : 'turn']);
    }
  });

  it('keeps every control inside the body and clear of its neighbours', () => {
    for (const c of layout.controls) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(1);
      expect(c.y + c.h).toBeLessThanOrEqual(1);
    }
    // Overlap would make one control physically unclickable behind another —
    // the kind of layout bug that is invisible until someone tries to grab it.
    const overlaps = (a: typeof layout.controls[0], b: typeof layout.controls[0]) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const hits: string[] = [];
    for (let i = 0; i < layout.controls.length; i++) {
      for (let j = i + 1; j < layout.controls.length; j++) {
        if (overlaps(layout.controls[i], layout.controls[j])) {
          hits.push(`${layout.controls[i].id}/${layout.controls[j].id}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('recognizes both of the unit\'s port names', () => {
    // The hardware presents different labels for its input and its output.
    for (const name of ['nanoKONTROL2 SLIDER/KNOB', 'nanoKONTROL2 CTRL']) {
      expect(NK2_TEMPLATE.portMatchers.some(re => re.test(`KORG INC. ${name}`))).toBe(true);
    }
  });
});

describe('NanoKontrol2Driver parse', () => {
  it('maps faders and knobs to absolute 0..1 on turn', () => {
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    driver.onMidiMessage(cc(0, 0, 127), 0);      // fader 1 full
    driver.onMidiMessage(cc(0, 7, 0), 0);        // fader 8 zero
    driver.onMidiMessage(cc(0, 20, 64), 0);      // knob 5 middle
    expect(ctx.emitted).toEqual([
      { controlId: nk2Endpoint(NK2_SLOT_FADER + 0), value: 1 },
      { controlId: nk2Endpoint(NK2_SLOT_FADER + 7), value: 0 },
      { controlId: nk2Endpoint(NK2_SLOT_KNOB + 4), value: 64 / 127 },
    ]);
  });

  it('maps S/M/R and transport to 0 or 1 on press', () => {
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    driver.onMidiMessage(cc(0, 32, 127), 0);     // S1 down
    driver.onMidiMessage(cc(0, 32, 0), 0);       // S1 up
    driver.onMidiMessage(cc(0, 48, 127), 0);     // M1
    driver.onMidiMessage(cc(0, 64, 127), 0);     // R1
    driver.onMidiMessage(cc(0, 41, 127), 0);     // play
    expect(ctx.emitted).toEqual([
      { controlId: nk2Endpoint(NK2_SLOT_SOLO + 0), value: 1 },
      { controlId: nk2Endpoint(NK2_SLOT_SOLO + 0), value: 0 },
      { controlId: nk2Endpoint(NK2_SLOT_MUTE + 0), value: 1 },
      { controlId: nk2Endpoint(NK2_SLOT_REC + 0), value: 1 },
      { controlId: nk2Endpoint(NK2_SLOT_TRANSPORT + NK2_TRANSPORT.indexOf('play')), value: 1 },
    ]);
  });

  it('reads a toggle-mode button the same as a momentary one', () => {
    // Momentary sends 127-then-0 across press/release; Toggle sends 127 on
    // one press and 0 on the next. A >= 64 threshold is right for both, and
    // the driver deliberately latches nothing of its own.
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    for (const v of [127, 0, 127, 0]) driver.onMidiMessage(cc(0, 46, v), 0);
    expect(ctx.emitted.map(e => e.value)).toEqual([1, 0, 1, 0]);
  });

  it('ignores other channels and non-CC status bytes', () => {
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    driver.onMidiMessage(cc(1, 0, 127), 0);               // wrong channel
    driver.onMidiMessage(new Uint8Array([0x90, 0, 127]), 0); // note on
    driver.onMidiMessage(new Uint8Array([0xb0, 0]), 0);      // truncated
    driver.onMidiMessage(cc(0, 100, 127), 0);             // unmapped CC
    expect(ctx.emitted).toEqual([]);
  });

  it('follows the config channel after a remap', () => {
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    ctx.config.channel = 5;
    driver.configChanged();
    driver.onMidiMessage(cc(0, 0, 127), 0);
    expect(ctx.emitted).toEqual([]);
    driver.onMidiMessage(cc(5, 0, 127), 0);
    expect(ctx.emitted).toEqual([{ controlId: nk2Endpoint(NK2_SLOT_FADER), value: 1 }]);
  });

  it('invalidates the CC lookup after a config edit', () => {
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    driver.onMidiMessage(cc(0, 0, 127), 0);
    ctx.config.faders[0].cc = 90;
    driver.configChanged();
    driver.onMidiMessage(cc(0, 0, 127), 0);   // old CC is dead
    driver.onMidiMessage(cc(0, 90, 0), 0);
    expect(ctx.emitted).toEqual([
      { controlId: nk2Endpoint(NK2_SLOT_FADER), value: 1 },
      { controlId: nk2Endpoint(NK2_SLOT_FADER), value: 0 },
    ]);
  });

  it('moves every control a duplicated CC is mapped to', () => {
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    ctx.config.knobs[0].cc = 0;   // gang knob 1 onto fader 1's CC
    driver.configChanged();
    driver.onMidiMessage(cc(0, 0, 127), 0);
    expect(ctx.emitted.map(e => e.controlId)).toEqual([
      nk2Endpoint(NK2_SLOT_FADER), nk2Endpoint(NK2_SLOT_KNOB),
    ]);
  });

  it('never reports a bank change on this unbanked surface', () => {
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    for (let n = 0; n < 128; n++) driver.onMidiMessage(cc(0, n, 127), 0);
    expect(driver.activeBank).toBe(0);
    expect(ctx.banks).toEqual([]);
  });
});

describe('NanoKontrol2Driver renderOutput', () => {
  it('stays silent in internal LED mode', () => {
    // The factory default: the hardware lights its own lamps and ignores us.
    const ctx = new FakeContext();
    const driver = new NanoKontrol2Driver(ctx);
    driver.renderOutput(new Map([[nk2Endpoint(NK2_SLOT_SOLO), 1]]));
    expect(ctx.sent).toEqual([]);
  });

  it('drives button lamps in external mode, once per change', () => {
    const ctx = new FakeContext();
    ctx.config.ledMode = 'external';
    const driver = new NanoKontrol2Driver(ctx);
    const values = new Map([
      [nk2Endpoint(NK2_SLOT_SOLO), 1],
      [nk2Endpoint(NK2_SLOT_MUTE + 2), 0],
    ]);
    driver.renderOutput(values);
    expect(ctx.sent).toEqual([[0xb0, 32, 127], [0xb0, 50, 0]]);
    ctx.sent.length = 0;
    driver.renderOutput(values);
    expect(ctx.sent).toEqual([]);            // unchanged → nothing on the wire
    values.set(nk2Endpoint(NK2_SLOT_SOLO), 0);
    driver.renderOutput(values);
    expect(ctx.sent).toEqual([[0xb0, 32, 0]]);
  });

  it('never echoes faders or knobs, which have no indicators', () => {
    const ctx = new FakeContext();
    ctx.config.ledMode = 'external';
    const driver = new NanoKontrol2Driver(ctx);
    driver.renderOutput(new Map([
      [nk2Endpoint(NK2_SLOT_FADER), 1],
      [nk2Endpoint(NK2_SLOT_KNOB), 1],
    ]));
    expect(ctx.sent).toEqual([]);
  });
});

describe('nanoKONTROL2 mapping accessors', () => {
  it('reads each group\'s CC through the endpoint field', () => {
    const c = defaultNanoKontrol2Config();
    const get = (slot: number) => NK2_TEMPLATE.mapping.get(c, nk2Endpoint(slot));
    expect(get(NK2_SLOT_FADER + 3)).toEqual({ cc: 3, channel: 0 });
    expect(get(NK2_SLOT_KNOB + 3)).toEqual({ cc: 19, channel: 0 });
    expect(get(NK2_SLOT_REC + 7)).toEqual({ cc: 71, channel: 0 });
    expect(get(NK2_SLOT_TRANSPORT + NK2_TRANSPORT.indexOf('cycle'))).toEqual({ cc: 46, channel: 0 });
  });

  it('rejects a field addressing a control by the wrong gesture', () => {
    const c = defaultNanoKontrol2Config();
    // A fader has no 'press' and a button has no 'turn'; answering anyway
    // would let the details panel edit a control the user never selected.
    expect(NK2_TEMPLATE.mapping.get(c, 'b0/e00/press')).toBeNull();
    expect(NK2_TEMPLATE.mapping.get(c, 'b0/e32/turn')).toBeNull();
    expect(NK2_TEMPLATE.mapping.get(c, 'b1/e00/turn')).toBeNull();
    expect(NK2_TEMPLATE.mapping.get(c, `b0/e${NK2_SLOTS}/press`)).toBeNull();
    expect(NK2_TEMPLATE.mapping.get(c, 'nonsense')).toBeNull();
  });

  it('writes a CC back into the right group, and the channel globally', () => {
    const c = defaultNanoKontrol2Config();
    NK2_TEMPLATE.mapping.set(c, nk2Endpoint(NK2_SLOT_MUTE + 1), { cc: 99 });
    expect(c.mute[1].cc).toBe(99);
    expect(c.solo[1].cc).toBe(33);          // neighbours untouched
    NK2_TEMPLATE.mapping.set(c, nk2Endpoint(NK2_SLOT_FADER), { channel: 9 });
    expect(c.channel).toBe(9);
  });

  it('ignores a write to an unaddressable field', () => {
    const c = defaultNanoKontrol2Config();
    const before = JSON.stringify(c);
    NK2_TEMPLATE.mapping.set(c, 'b0/e00/press', { cc: 99 });
    NK2_TEMPLATE.mapping.set(c, 'garbage', { cc: 99 });
    expect(JSON.stringify(c)).toBe(before);
  });
});
