/**
 * ProfileStore unit tests. The underlying IDB wrapper (`idb-store`) is
 * mocked so we exercise schema versioning, staleness, and the
 * coalescing writer's timing logic without booting an in-memory IDB.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the IDB wrapper. Tests drive `idbGet` / `idbPut` return values
// directly so we never actually open a database.
vi.mock('../state/idb-store', () => {
  const store = new Map<string, any>();
  return {
    STORE_VIDEO_SOURCE_PROFILES: 'videoSourceProfiles',
    STORE_VIDEO_CLIP_PROFILES: 'videoClipProfiles',
    idbGet: vi.fn(async (s: string, k: string) => store.get(`${s}/${k}`)),
    idbPut: vi.fn(async (s: string, v: any) => {
      const keyField = s === 'videoSourceProfiles' ? 'sourceKey' : 'clipKey';
      store.set(`${s}/${v[keyField]}`, v);
    }),
    __reset: () => store.clear(),
  };
});

import {
  CoalescingWriter,
  SOURCE_STALENESS_MS,
  buildSourceProfileRecord,
  buildClipProfileRecord,
  writeSourceProfile, readSourceProfile,
  writeClipProfile, readClipProfile,
  type SourceProfileRecord,
  type ClipProfileRecord,
} from './profile-store';
import * as idbStore from '../state/idb-store';

beforeEach(() => {
  // Clear the mock store between tests.
  (idbStore as any).__reset();
  (idbStore.idbGet as any).mockClear();
  (idbStore.idbPut as any).mockClear();
});

describe('SourceProfileRecord round-trip', () => {
  it('writes and reads back identical fields', async () => {
    const rec: SourceProfileRecord = {
      sourceKey: 'foo.mov|12345|9999',
      schemaVersion: 1,
      costClass: 'FastRandom',
      meanFrameDecodeMs: 3.2,
      seekDecodeMs: 4.1,
      firstByteLatencyMs: 0.5,
      payloadBytesPerFrame: 800_000,
      samples: 128,
      lastSeenAt: Date.now(),
    };
    await writeSourceProfile(rec);
    const back = await readSourceProfile(rec.sourceKey);
    expect(back).toEqual(rec);
  });

  it('returns null when stale (> 30 days)', async () => {
    const now = 1_700_000_000_000;
    const rec: SourceProfileRecord = {
      sourceKey: 'stale.mov|1|1',
      schemaVersion: 1,
      costClass: 'FastRandom',
      meanFrameDecodeMs: 3, seekDecodeMs: 4,
      firstByteLatencyMs: 0, payloadBytesPerFrame: 0,
      samples: 64,
      lastSeenAt: now - SOURCE_STALENESS_MS - 1,
    };
    await writeSourceProfile(rec);
    expect(await readSourceProfile(rec.sourceKey, now)).toBeNull();
  });

  it('returns the record when fresh (within staleness window)', async () => {
    const now = 1_700_000_000_000;
    const rec: SourceProfileRecord = {
      sourceKey: 'fresh.mov|1|1',
      schemaVersion: 1,
      costClass: 'FastRandom',
      meanFrameDecodeMs: 3, seekDecodeMs: 4,
      firstByteLatencyMs: 0, payloadBytesPerFrame: 0,
      samples: 64,
      lastSeenAt: now - 1000,         // 1 second old
    };
    await writeSourceProfile(rec);
    expect(await readSourceProfile(rec.sourceKey, now)).not.toBeNull();
  });

  it('returns null on schema-version mismatch', async () => {
    const rec = {
      sourceKey: 'wrongv.mov|1|1',
      schemaVersion: 99,                 // not 1
      costClass: 'FastRandom', meanFrameDecodeMs: 0, seekDecodeMs: 0,
      firstByteLatencyMs: 0, payloadBytesPerFrame: 0, samples: 0,
      lastSeenAt: Date.now(),
    } as unknown as SourceProfileRecord;
    await writeSourceProfile(rec);
    expect(await readSourceProfile(rec.sourceKey)).toBeNull();
  });
});

describe('ClipProfileRecord round-trip', () => {
  it('persists the loopRange field for Loop mode', async () => {
    const rec = buildClipProfileRecord(
      'src::clipA',
      { mode: 'Loop', confidence: 0.9, loopRange: [30, 60] },
      0.85,
    );
    await writeClipProfile(rec);
    const back = await readClipProfile(rec.clipKey);
    expect(back?.mode).toBe('Loop');
    expect(back?.loopRange).toEqual([30, 60]);
    expect(back?.observedHitRate).toBeCloseTo(0.85);
  });

  it('returns null on schema-version mismatch', async () => {
    const rec: ClipProfileRecord = {
      clipKey: 'src::v99',
      schemaVersion: 99 as unknown as 1,
      mode: 'Sequential', modeConfidence: 1,
      observedHitRate: 0,
      lastSeenAt: Date.now(),
    };
    await writeClipProfile(rec);
    expect(await readClipProfile(rec.clipKey)).toBeNull();
  });
});

describe('buildSourceProfileRecord / buildClipProfileRecord', () => {
  it('copies fields out of a CostSnapshot into the persistent shape', () => {
    const rec = buildSourceProfileRecord('k', {
      meanFrameDecodeMs: 3, seekDecodeMs: 4, seekPenaltyMs: 1,
      firstByteLatencyMs: 0.1, payloadBytesPerFrame: 1024,
      samples: 50, contiguousSamples: 30, seekSamples: 20, costClass: 'FastRandom',
    });
    expect(rec.costClass).toBe('FastRandom');
    expect(rec.meanFrameDecodeMs).toBe(3);
    expect(rec.payloadBytesPerFrame).toBe(1024);
    expect(rec.samples).toBe(50);
  });
});

describe('CoalescingWriter', () => {
  it('collapses multiple schedule() calls within the window to one write', async () => {
    vi.useFakeTimers();
    const writer = vi.fn().mockResolvedValue(undefined);
    const cw = new CoalescingWriter<number>(writer, 100);

    cw.schedule(1);
    cw.schedule(2);
    cw.schedule(3);                    // only the last value should be written

    await vi.advanceTimersByTimeAsync(100);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });

  it('flush() fires immediately even before the timer expires', async () => {
    vi.useFakeTimers();
    const writer = vi.fn().mockResolvedValue(undefined);
    const cw = new CoalescingWriter<number>(writer, 1_000_000);

    cw.schedule(42);
    await cw.flush();

    expect(writer).toHaveBeenCalledWith(42);
    expect(writer).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('flush() with nothing pending is a no-op', async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const cw = new CoalescingWriter<number>(writer, 100);
    await cw.flush();
    expect(writer).not.toHaveBeenCalled();
  });
});
