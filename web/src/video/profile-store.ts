/**
 * ProfileStore — typed read/write for the video playback service's two
 * IndexedDB stores. Wraps the project's `idb-store` helpers with schema-
 * versioned record shapes, staleness rules, and a coalesced flush timer
 * so the pull path never awaits IDB.
 */

import {
  idbGet, idbPut,
  STORE_VIDEO_SOURCE_PROFILES, STORE_VIDEO_CLIP_PROFILES,
} from '../state/idb-store';
import type { CostClass, CostSnapshot } from './cost-tracker';
import type { AccessMode, ClassifierSnapshot } from './access-classifier';

/** Persist-format record for a single video source (codec/file-level
 *  cost profile, identity, restore handle). */
export interface SourceProfileRecord {
  sourceKey: string;          // 'name|size|lastModified'
  schemaVersion: 1;
  costClass: CostClass;
  meanFrameDecodeMs: number;
  seekDecodeMs: number;
  firstByteLatencyMs: number;
  payloadBytesPerFrame: number;
  samples: number;
  lastSeenAt: number;         // Date.now() at last write
  handle?: FileSystemFileHandle;   // optional for restore
  /** For <video>-backed sources: whether the clip must play-forward
   *  (sparse keyframes — seeking returns black) vs. supports random
   *  access. Determined by a seek probe at first open; reused on
   *  subsequent opens to skip re-probing. Undefined for DXV / unprobed. */
  videoStreaming?: boolean;
}

/** Persist-format record for a single clip (source + salt) — access
 *  pattern + cache hints. */
export interface ClipProfileRecord {
  clipKey: string;            // `${sourceKey}::${salt}`
  schemaVersion: 1;
  mode: AccessMode;
  modeConfidence: number;
  // Mode-specific payloads — only the field for the matched mode is filled:
  loopRange?: [number, number];
  hotFrames?: number[];
  stride?: number;
  observedHitRate: number;    // last session's hit rate (debug / sanity)
  lastSeenAt: number;
}

/** How long a source cost profile is considered fresh. Past this we
 *  re-measure rather than blindly trust the persisted EWMAs (codec
 *  versions, decode paths, and hardware change). */
export const SOURCE_STALENESS_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

const SCHEMA_VERSION = 1;

/** Coalesces multiple flush requests within `windowMs` into one IDB write. */
export class CoalescingWriter<T> {
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writer: (value: T) => Promise<void>;
  private windowMs: number;

  constructor(writer: (value: T) => Promise<void>, windowMs: number = 250) {
    this.writer = writer;
    this.windowMs = windowMs;
  }

  schedule(value: T): void {
    this.pending = value;
    if (this.timer) return;
    this.timer = setTimeout(() => this.fire(), this.windowMs);
  }

  /** Force-flush immediately (used by visibilitychange / beforeunload). */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending === null) return;
    const v = this.pending;
    this.pending = null;
    await this.writer(v);
  }

  private fire(): void {
    this.timer = null;
    if (this.pending === null) return;
    const v = this.pending;
    this.pending = null;
    // Fire-and-forget; errors are logged but not surfaced — the pull
    // path is the hot loop and shouldn't pay attention to IDB drift.
    this.writer(v).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[video] ProfileStore write failed', err);
    });
  }
}

/** Derive a stable source key from a File or FileSystemFileHandle. Uses
 *  ONLY metadata that's safe to read without triggering a content
 *  download (cloud-drive friendly). */
export async function deriveSourceKey(
  source: File | { getFile(): Promise<File> },
): Promise<{ sourceKey: string; file: File }> {
  const file = source instanceof File ? source : await source.getFile();
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  return { sourceKey: key, file };
}

/** Read the persisted source profile if any. Returns null on miss or
 *  when the record is stale or has a different schema version. */
export async function readSourceProfile(
  sourceKey: string,
  now: number = Date.now(),
): Promise<SourceProfileRecord | null> {
  const rec = await idbGet<SourceProfileRecord>(STORE_VIDEO_SOURCE_PROFILES, sourceKey);
  if (!rec) return null;
  if (rec.schemaVersion !== SCHEMA_VERSION) return null;
  if (now - rec.lastSeenAt > SOURCE_STALENESS_MS) return null;
  return rec;
}

/** Write/overwrite the source profile. */
export async function writeSourceProfile(rec: SourceProfileRecord): Promise<void> {
  await idbPut(STORE_VIDEO_SOURCE_PROFILES, rec);
}

/** Read the persisted clip profile if any. Returns null on miss or
 *  on schema-version mismatch. No staleness for clip records — the
 *  most recent observation always wins. */
export async function readClipProfile(clipKey: string): Promise<ClipProfileRecord | null> {
  const rec = await idbGet<ClipProfileRecord>(STORE_VIDEO_CLIP_PROFILES, clipKey);
  if (!rec) return null;
  if (rec.schemaVersion !== SCHEMA_VERSION) return null;
  return rec;
}

export async function writeClipProfile(rec: ClipProfileRecord): Promise<void> {
  await idbPut(STORE_VIDEO_CLIP_PROFILES, rec);
}

/** Build a SourceProfileRecord from live CostTracker output. */
export function buildSourceProfileRecord(
  sourceKey: string,
  cost: CostSnapshot,
  handle?: FileSystemFileHandle,
  now: number = Date.now(),
  videoStreaming?: boolean,
): SourceProfileRecord {
  return {
    sourceKey,
    schemaVersion: SCHEMA_VERSION,
    costClass: cost.costClass,
    meanFrameDecodeMs: cost.meanFrameDecodeMs,
    seekDecodeMs: cost.seekDecodeMs,
    firstByteLatencyMs: cost.firstByteLatencyMs,
    payloadBytesPerFrame: cost.payloadBytesPerFrame,
    samples: cost.samples,
    lastSeenAt: now,
    handle,
    videoStreaming,
  };
}

/** Build a ClipProfileRecord from live classifier output + observed hit rate. */
export function buildClipProfileRecord(
  clipKey: string,
  cls: ClassifierSnapshot,
  observedHitRate: number,
  now: number = Date.now(),
): ClipProfileRecord {
  return {
    clipKey,
    schemaVersion: SCHEMA_VERSION,
    mode: cls.mode,
    modeConfidence: cls.confidence,
    loopRange: cls.loopRange,
    hotFrames: cls.hotFrames,
    stride: cls.stride,
    observedHitRate,
    lastSeenAt: now,
  };
}
