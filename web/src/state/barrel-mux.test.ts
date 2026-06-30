/**
 * Barrel multiplexing (Phase 2 web): instance enumeration/selection on the
 * controller, and NBPV v2 preview-frame decode + key routing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appController } from './controller';
import { appState } from './app-state';
import type { BarrelInstanceInfo } from './types';

const inst = (key: string): BarrelInstanceInfo => ({ key, id: 'com.nano.nanobarrel', label: key.split('-')[0] });

describe('barrel instance selection', () => {
  beforeEach(() => {
    appController.setBarrelSelectHandler(null);
    appController.setBarrelInstances([]);
  });

  it('selects the first instance by default and rewires it', () => {
    const wired: string[] = [];
    appController.setBarrelSelectHandler(k => wired.push(k));
    appController.setBarrelInstances([inst('A'), inst('B')]);
    expect(appState.local.selectedBarrelKey).toBe('A');
    expect(wired).toEqual(['A']);
  });

  it('preserves the current selection across list refreshes', () => {
    appController.setBarrelInstances([inst('A'), inst('B')]);
    appController.selectBarrelInstance('B');
    const wired: string[] = [];
    appController.setBarrelSelectHandler(k => wired.push(k));
    appController.setBarrelInstances([inst('B'), inst('A')]);  // reordered, B still live
    expect(appState.local.selectedBarrelKey).toBe('B');
    expect(wired).toEqual([]);  // no rewire — selection unchanged
  });

  it('re-picks a default when the selected instance disappears', () => {
    appController.setBarrelInstances([inst('A'), inst('B')]);
    appController.selectBarrelInstance('B');
    appController.setBarrelInstances([inst('A')]);  // B gone
    expect(appState.local.selectedBarrelKey).toBe('A');
  });

  it('clears selection when no instances remain', () => {
    appController.setBarrelInstances([inst('A')]);
    appController.setBarrelInstances([]);
    expect(appState.local.selectedBarrelKey).toBeNull();
  });
});

// --- NBPV v2 frame builder (mirrors native buildPreviewFrameBytes) ---
function nbpv2(key: string, traceId: string, w: number, h: number, version = 2): ArrayBuffer {
  const keyB = new TextEncoder().encode(key);
  const idB = new TextEncoder().encode(traceId);
  const px = w * h * 4;
  const buf = new ArrayBuffer(14 + keyB.length + idB.length + px);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x4e); dv.setUint8(1, 0x42); dv.setUint8(2, 0x50); dv.setUint8(3, 0x56);
  dv.setUint8(4, version); dv.setUint8(5, 1);
  dv.setUint16(6, keyB.length, true);
  dv.setUint16(8, idB.length, true);
  dv.setUint16(10, w, true);
  dv.setUint16(12, h, true);
  new Uint8Array(buf, 14, keyB.length).set(keyB);
  new Uint8Array(buf, 14 + keyB.length, idB.length).set(idB);
  return buf;
}

describe('NBPV v2 preview decode + routing', () => {
  beforeEach(() => {
    // node env has no ImageData/createImageBitmap — stub them.
    (globalThis as any).ImageData = class { constructor(public data: any, public width: number, public height: number) {} };
    (globalThis as any).createImageBitmap = vi.fn(async () => ({ close() {} } as any));
    appState.local.engine.tracedFrames = {};
    appController.setBarrelInstances([inst('SEL'), inst('OTHER')]);
    appController.selectBarrelInstance('SEL');
  });

  it('decodes a frame for the selected instance', async () => {
    await appController.ingestBarrelPreviewFrame(nbpv2('SEL', 'trace1', 2, 2));
    expect(appState.local.engine.tracedFrames['trace1']).toBeDefined();
    expect((globalThis as any).createImageBitmap).toHaveBeenCalledOnce();
  });

  it('drops a frame addressed to a different instance', async () => {
    await appController.ingestBarrelPreviewFrame(nbpv2('OTHER', 'trace1', 2, 2));
    expect(appState.local.engine.tracedFrames['trace1']).toBeUndefined();
    expect((globalThis as any).createImageBitmap).not.toHaveBeenCalled();
  });

  it('drops a v1 (legacy) frame — clean break', async () => {
    await appController.ingestBarrelPreviewFrame(nbpv2('SEL', 'trace1', 2, 2, /*version=*/1));
    expect(appState.local.engine.tracedFrames['trace1']).toBeUndefined();
  });
});
