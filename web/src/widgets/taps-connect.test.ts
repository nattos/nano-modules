// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { WireConnect } from './taps-connect';
import type { FieldConnectInfo } from '../sketch-types';

/**
 * Click-to-connect completion onto a rail endpoint. The rail lane lives outside the
 * column-group, so it completes the gesture itself (completeOnRail) rather than
 * relying on a field hit element — this verifies the picked-up field commits against
 * the rail and the gesture ends.
 */
describe('WireConnect.completeOnRail', () => {
  const field: FieldConnectInfo = {
    sketchId: 'clip/t/c', colIdx: 0, chainIdx: 0, fieldPath: 'level',
    isOutput: true, viewportY: 5, schemaDef: null,
  };

  it('commits the picked-up field against the rail and ends the gesture', () => {
    const calls: Array<[FieldConnectInfo, FieldConnectInfo]> = [];
    const wc = new WireConnect({
      getSketch: () => undefined,
      getPlugin: () => undefined,
      connectWire: (a, b) => calls.push([a, b]),
    });
    wc.beginFromFieldClick('clip/t/c', 'clip/t/c/0/0/level', field);
    expect(WireConnect.active).toBe(wc); // picked up → registered as the active gesture

    wc.completeOnRail('rail1');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual(field);       // source = the field
    expect(calls[0][1].railId).toBe('rail1'); // target = the rail
    expect(WireConnect.active).toBe(null);    // gesture ended + deregistered
  });

  it('does nothing when no field is picked up', () => {
    const calls: unknown[] = [];
    const wc = new WireConnect({
      getSketch: () => undefined, getPlugin: () => undefined, connectWire: () => calls.push(1),
    });
    wc.completeOnRail('rail1');
    expect(calls).toHaveLength(0);
  });
});
