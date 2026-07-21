/**
 * composition-transport.test.ts — the transport-section precedence rule
 * (clipTransportDevice / clipTransportDriven), mirroring the native truth
 * table in native/tests/test_comp_transport_fx.cpp (transportDeviceOf). The
 * web side reads the doc's device capabilities; native reads its catalog —
 * same rule, same answers.
 */
import { describe, it, expect } from 'vitest';
import {
  clipTransportDevice,
  clipTransportDriven,
  deviceIsTransportController,
  loopViewOf,
  type Clip,
  type Device,
} from './composition';

const dev = (id: string, caps: Device['capabilities']): Device => ({
  id, moduleType: `m.${id}`, name: id, capabilities: caps, state: {},
});

const clip = (transport?: { devices: Device[] }): Clip => ({
  id: 'c1', name: 'c1', startBeat: 0, lengthBeat: 8, kind: 'effect',
  sketch: { devices: [] },
  ...(transport ? { transport } : {}),
  loop: { mode: 'time', startSec: 0, speed: 1, direction: 'forward' },
  automation: [], exports: [], warps: [],
});

describe('clip transport-section precedence (lock-step truth table)', () => {
  it('no section / empty section ⇒ ClipLoopConfig drives', () => {
    expect(clipTransportDriven(clip())).toBe(false);
    expect(clipTransportDevice(clip({ devices: [] }))).toBe(null);
  });

  it('a section without a transport controller is inert', () => {
    const c = clip({ devices: [dev('m1', ['modulation_source'])] });
    expect(clipTransportDriven(c)).toBe(false);
  });

  it('one controller drives; the LAST controller wins among several', () => {
    const one = clip({ devices: [dev('t1', ['transport_controller'])] });
    expect(clipTransportDevice(one)?.id).toBe('t1');
    const many = clip({
      devices: [
        dev('t1', ['transport_controller']),
        dev('t2', ['transport_controller']),
        dev('m1', ['modulation_source']),  // trailing non-transport can't steal
      ],
    });
    expect(clipTransportDevice(many)?.id).toBe('t2');
    expect(clipTransportDriven(many)).toBe(true);
  });

  it('deviceIsTransportController reads the capability tag', () => {
    expect(deviceIsTransportController(dev('t', ['transport_controller']))).toBe(true);
    expect(deviceIsTransportController(dev('m', ['modulation_source']))).toBe(false);
  });

  it('loopViewOf: clip.loop when undriven; synthesized config for core effects; null for third-party', () => {
    // Undriven → the clip's own loop.
    expect(loopViewOf(clip())).toEqual(clip().loop);
    // A recognized core effect synthesizes the exact ClipLoopConfig view
    // (sentinels resolved: endSec<=0 = source end, playStartSec<0 = unset).
    const core: Device = {
      id: 't1', moduleType: 'core.transport.time', name: 'T',
      capabilities: ['transport_controller'],
      state: { startSec: 1, endSec: 4, playStartSec: -1, speed: 2, direction: 1, pingpong: true },
    };
    const view = loopViewOf(clip({ devices: [core] }))!;
    expect(view).toEqual({
      mode: 'time', startSec: 1, endSec: 4, speed: 2,
      direction: 'reverse', pingpong: true,
    });
    // endSec 0 sentinel drops the field (= source end).
    const full: Device = { ...core, state: { startSec: 0, endSec: 0 } };
    expect(loopViewOf(clip({ devices: [full] }))!.endSec).toBeUndefined();
    // Third-party controller → no analytic view.
    const other = dev('x', ['transport_controller']);
    expect(loopViewOf(clip({ devices: [other] }))).toBe(null);
  });
});
