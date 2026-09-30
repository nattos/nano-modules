import { describe, it, expect, vi } from 'vitest';

// The shell says it can share, but every import fails — another GPU, or a GPU
// process that fell back to software. The monitors must not stay black.
const invoke = vi.fn(async (channel: string) => channel === 'nano.surfaceSupport');
vi.mock('./state/paths', () => ({ electronIpc: () => ({ invoke }) }));
vi.mock('./preview-gpu', () => ({
  previewGpu: { ensureInit: () => {}, whenCopied: async () => {} },
}));

import { previewSurfaces } from './preview-surfaces';

function nbps(token: number): ArrayBuffer {
  const key = new TextEncoder().encode('K');
  const id = new TextEncoder().encode('mon');
  const buf = new ArrayBuffer(26 + key.length + id.length);
  const dv = new DataView(buf);
  [0x4E, 0x42, 0x50, 0x53, 1, 0].forEach((b, i) => dv.setUint8(i, b));
  dv.setUint16(6, key.length, true);
  dv.setUint16(8, id.length, true);
  dv.setUint16(10, 4, true);
  dv.setUint16(12, 4, true);
  dv.setBigUint64(18, BigInt(token), true);
  new Uint8Array(buf, 26).set(key);
  new Uint8Array(buf, 26 + key.length).set(id);
  return buf;
}

describe('shared surfaces that cannot be imported', () => {
  it('turn themselves off after a few failures, once, and hand the slots back', async () => {
    (globalThis as any).require = () => ({ sharedTexture: { setSharedTextureReceiver: () => {} } });
    expect(await previewSurfaces.init()).toBe(true);
    const disabled = vi.fn();
    previewSurfaces.onDisabled(disabled);
    const released: number[] = [];
    const sink = { wants: () => true, ingest: () => true, release: (t: number) => released.push(t) };
    for (let t = 1; t <= 5; t++) {
      expect(previewSurfaces.handle(nbps(t), sink)).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(disabled).toHaveBeenCalledTimes(1);
    expect(previewSurfaces.active).toBe(false);
    // Every announced slot went back to the producer, imported or not.
    expect(released.slice(0, 3)).toEqual([1, 2, 3]);
    delete (globalThis as any).require;
  });
});
