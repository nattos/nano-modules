/**
 * MidiManager tests against a fake MIDIAccess — connection matching,
 * hot-plug, value tables, and simulation layering.
 */
import { describe, expect, it } from 'vitest';
import { MFT_TEMPLATE } from './drivers/mft';
import { forkInstance } from './matching';
import { MidiManager } from './midi-manager';
import type { DeviceInstance } from './midi-types';

class FakePort {
  state = 'connected';
  onmidimessage: ((e: { data: Uint8Array; timeStamp: number }) => void) | null = null;
  sent: number[][] = [];
  constructor(public id: string, public name: string, public manufacturer: string) {}
  send(bytes: number[]) { this.sent.push([...bytes]); }
}

class FakeAccess {
  inputs = new Map<string, FakePort>();
  outputs = new Map<string, FakePort>();
  onstatechange: (() => void) | null = null;

  addPair(id: string, name: string, manufacturer: string) {
    const input = new FakePort(`in-${id}`, name, manufacturer);
    const output = new FakePort(`out-${id}`, name, manufacturer);
    this.inputs.set(input.id, input);
    this.outputs.set(output.id, output);
    this.onstatechange?.();
    return { input, output };
  }

  removePair(input: FakePort) {
    this.inputs.delete(input.id);
    for (const [k, v] of this.outputs) {
      if (v.name === input.name) this.outputs.delete(k);
    }
    this.onstatechange?.();
  }
}

function twisterInstance(): DeviceInstance {
  const inst = forkInstance(MFT_TEMPLATE);
  inst.identities.push({ name: 'Midi Fighter Twister', manufacturer: 'DJ TechTools' });
  return inst;
}

function setup(library: DeviceInstance[]) {
  const access = new FakeAccess();
  const manager = new MidiManager();
  const events = {
    connections: [] as [string, boolean][],
    unknown: [] as string[][],
    stamps: [] as [string, number, string][],
    changed: [] as string[],
  };
  manager.onConnectionChanged = (id, c) => events.connections.push([id, c]);
  manager.onUnknownPortsChanged = ports => events.unknown.push(ports.map(p => p.name));
  manager.onIdentityStamp = (id, idx, portId) => events.stamps.push([id, idx, portId]);
  manager.onValuesChanged = id => events.changed.push(id);
  manager.bindLibrary(() => library);
  manager.attachAccess(access as unknown as MIDIAccess);
  return { access, manager, events };
}

describe('MidiManager', () => {
  it('matches a claimed port, stamps the platform id, and routes messages', () => {
    const inst = twisterInstance();
    const { access, manager, events } = setup([inst]);
    const { input } = access.addPair('a', 'Midi Fighter Twister', 'DJ TechTools');

    expect(events.connections).toEqual([[inst.id, true]]);
    expect(events.stamps).toEqual([[inst.id, 0, 'in-a']]);   // tuple match → re-stamp
    expect(manager.isConnected(inst.id)).toBe(true);

    input.onmidimessage!({ data: new Uint8Array([0xb0, 5, 127]), timeStamp: 0 });
    expect(manager.getValue(inst.id, 'b0/e05/turn')).toBe(1);
    expect(events.changed).toEqual([inst.id]);
  });

  it('reassigning a port to another instance keeps the new message handler', () => {
    // Regression: the disposal pass nulled input.onmidimessage AFTER
    // openDevice installed the new owner's handler on the same input —
    // reassigned devices showed connected but received nothing.
    const a = twisterInstance();
    const b = twisterInstance();
    b.identities[0].webPortId = 'in-a';        // b claims the port exactly
    const library = [a, b];
    const { access, manager } = setup(library);
    const { input } = access.addPair('a', 'Midi Fighter Twister', 'DJ TechTools');
    expect(manager.isConnected(b.id)).toBe(true);

    // Reassign: the exact claim moves b → a (what claimPort does), rematch.
    a.identities[0].webPortId = 'in-a';
    b.identities = [];
    manager.refreshMatching();
    expect(manager.isConnected(a.id)).toBe(true);
    expect(manager.isConnected(b.id)).toBe(false);
    expect(typeof input.onmidimessage).toBe('function');
    input.onmidimessage!({ data: new Uint8Array([0xb0, 5, 127]), timeStamp: 0 });
    expect(manager.getValue(a.id, 'b0/e05/turn')).toBe(1);
  });

  it('concurrent init() shares one requestMIDIAccess (boot vs Devices tab)', async () => {
    const manager = new MidiManager();
    let calls = 0;
    const access = new FakeAccess();
    (navigator as any).requestMIDIAccess = async () => { calls++; return access; };
    try {
      const [a, b] = await Promise.all([manager.init(), manager.init()]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(calls).toBe(1);
    } finally {
      delete (navigator as any).requestMIDIAccess;
    }
  });

  it('replug with a new port id in ONE pass stays connected in the mirror', () => {
    // Regression: when the unplug statechange is missed/coalesced, one
    // refresh sees the instance's old pairing (stale input) AND its new
    // port. The disposal pass fired (id, false) AFTER openDevice's
    // (id, true) — UI showed disconnected while messages flowed.
    const inst = twisterInstance();
    const { access, manager, events } = setup([inst]);
    const { input } = access.addPair('a', 'Midi Fighter Twister', 'DJ TechTools');
    expect(manager.isConnected(inst.id)).toBe(true);

    // Unplug + replug with a different id, with NO event in between.
    access.inputs.delete(input.id);
    const input2 = new FakePort('in-b', 'Midi Fighter Twister', 'DJ TechTools');
    access.inputs.set(input2.id, input2);
    manager.refreshMatching();

    expect(manager.isConnected(inst.id)).toBe(true);
    expect(events.connections.at(-1)).toEqual([inst.id, true]);   // no trailing false
    input2.onmidimessage!({ data: new Uint8Array([0xb0, 5, 127]), timeStamp: 0 });
    expect(manager.getValue(inst.id, 'b0/e05/turn')).toBe(1);
  });

  it('reports unmatched ports as unknown', () => {
    const { access, events } = setup([]);
    access.addPair('x', 'Mystery Pad', 'Acme');
    expect(events.unknown.at(-1)).toEqual(['Mystery Pad']);
  });

  it('disconnects when the port goes away, values persist', () => {
    const inst = twisterInstance();
    const { access, manager, events } = setup([inst]);
    const { input } = access.addPair('a', 'Midi Fighter Twister', 'DJ TechTools');
    input.onmidimessage!({ data: new Uint8Array([0xb0, 5, 127]), timeStamp: 0 });

    access.removePair(input);
    expect(events.connections.at(-1)).toEqual([inst.id, false]);
    expect(manager.isConnected(inst.id)).toBe(false);
    expect(manager.getValue(inst.id, 'b0/e05/turn')).toBe(1);   // sticky last value
  });

  it('layers simulation above hardware; clearing snaps back', () => {
    const inst = twisterInstance();
    const { access, manager } = setup([inst]);
    const { input } = access.addPair('a', 'Midi Fighter Twister', 'DJ TechTools');
    input.onmidimessage!({ data: new Uint8Array([0xb0, 5, 127]), timeStamp: 0 });

    manager.setSimulatedValue(inst.id, 'b0/e05/turn', 0.25);
    expect(manager.getValue(inst.id, 'b0/e05/turn')).toBe(0.25);
    manager.setSimulatedValue(inst.id, 'b0/e05/turn', null);
    expect(manager.getValue(inst.id, 'b0/e05/turn')).toBe(1);   // snap back to hardware
  });

  it('simulation on a disconnected device is sticky', () => {
    const inst = twisterInstance();
    const { manager, events } = setup([inst]);
    manager.setSimulatedValue(inst.id, 'b1/e03/turn', 0.7);
    expect(manager.getValue(inst.id, 'b1/e03/turn')).toBe(0.7);
    expect(events.changed).toEqual([inst.id]);
  });

  it('ring echo goes out to the paired output', () => {
    const inst = twisterInstance();
    const { access, manager } = setup([inst]);
    const { input, output } = access.addPair('a', 'Midi Fighter Twister', 'DJ TechTools');
    input.onmidimessage!({ data: new Uint8Array([0xb0, 5, 127]), timeStamp: 0 });
    manager.renderOutput(inst.id);
    expect(output.sent).toContainEqual([0xb0, 5, 127]);
  });

  it('two identical units pair to two instances in library order', () => {
    const a = twisterInstance();
    const b = twisterInstance();
    const { access, events } = setup([a, b]);
    access.addPair('u1', 'Midi Fighter Twister', 'DJ TechTools');
    access.addPair('u2', 'Midi Fighter Twister', 'DJ TechTools');
    // First unit claims the first tuple match (a); the re-match on the second
    // hot-plug keeps that pairing silently, and the second unit falls through
    // to b. No disconnect events in between.
    expect(events.connections).toEqual([[a.id, true], [b.id, true]]);
  });
});
