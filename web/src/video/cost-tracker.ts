/**
 * CostTracker — source-side timing profile for one video source.
 *
 * Tracks EWMAs of frame decode time, seek decode time, first-byte read
 * latency, and compressed payload size. Derives a coarse `CostClass` that
 * the playback service uses to size its read-ahead window: a `FastRandom`
 * source can satisfy random seeks cheaply, a `SlowSeek` source must cache
 * aggressively because every miss is expensive.
 *
 * All math here is pure — no GPU, no IO. Easy to unit-test, easy to seed
 * from a persisted IDB record.
 */

export type CostClass = 'FastRandom' | 'SlowSeek' | 'SlowDecode' | 'Unknown';

export interface CostSnapshot {
  /** EWMA of decode time on **contiguous** (stride=+1) pulls. */
  meanFrameDecodeMs: number;
  /** EWMA of decode time on **non-contiguous** (seek) pulls. */
  seekDecodeMs: number;
  /** Derived: seekDecodeMs − meanFrameDecodeMs (clamped ≥0). */
  seekPenaltyMs: number;
  /** EWMA of time from `source.slice()` call to first byte. */
  firstByteLatencyMs: number;
  /** Running mean of compressed sample size. */
  payloadBytesPerFrame: number;
  /** Count of pulls feeding the EWMAs. */
  samples: number;
  /** Pulls observed with stride === +1 (contiguous decodes). */
  contiguousSamples: number;
  /** Pulls observed with stride !== +1 — "the codec had to seek." On
   *  codecs where seek is expensive (h264 keyframe walk) this is the
   *  count of expensive operations. On DXV it's just "how often a
   *  jump happened" since seeks are free. */
  seekSamples: number;
  /** Coarse classification, see `classify`. */
  costClass: CostClass;
}

export interface CostPullOpts {
  /** Frame-index delta from the previous pull. +1 for contiguous play. */
  stride: number;
  /** Time from pull request to texture-ready (ms). */
  decodeMs: number;
  /** Time from source.slice() call to first byte (ms). Optional. */
  firstByteMs?: number;
  /** Compressed payload size for this frame (bytes). Optional. */
  payloadBytes?: number;
}

/** EWMA smoothing factor. 0.1 = ~10-sample half-life. */
const ALPHA = 0.1;

/** Below this sample count we report `Unknown` and the service uses
 *  conservative defaults. */
const MIN_SAMPLES_FOR_CLASS = 32;

/** When seeding from IDB we cap the running sample count so a few fresh
 *  observations can still nudge the EWMAs. */
const SEED_SAMPLE_CAP = 32;

export class CostTracker {
  private meanDecode = 0;
  private seekDecode = 0;
  private firstByte = 0;
  private payloadBytes = 0;
  private payloadCount = 0;
  // Per-bucket "have we seen at least one sample yet" flags. First sample
  // into a bucket initializes the EWMA directly; subsequent samples
  // smooth. Tracking these per-bucket (rather than off the global sample
  // count) is essential — otherwise the first seek of a session smooths
  // from 0 and takes ~30 measurements to catch up.
  private decodeSeeded = false;
  private seekSeeded = false;
  private firstByteSeeded = false;
  private _samples = 0;
  private _contiguousSamples = 0;
  private _seekSamples = 0;

  /** Number of pulls observed since the last reset. */
  get samples(): number { return this._samples; }
  get contiguousSamples(): number { return this._contiguousSamples; }
  get seekSamples(): number { return this._seekSamples; }

  /** Record one pull's timing. Seek vs contiguous is determined by
   *  `stride === 1`; everything else (including the first pull of a
   *  session where the caller passes stride=0) is treated as a seek. */
  recordPull(opts: CostPullOpts): void {
    if (opts.stride === 1) {
      this.meanDecode = ewma(this.meanDecode, opts.decodeMs, !this.decodeSeeded);
      this.decodeSeeded = true;
      this._contiguousSamples++;
    } else {
      this.seekDecode = ewma(this.seekDecode, opts.decodeMs, !this.seekSeeded);
      this.seekSeeded = true;
      this._seekSamples++;
    }
    if (opts.firstByteMs !== undefined) {
      this.firstByte = ewma(this.firstByte, opts.firstByteMs, !this.firstByteSeeded);
      this.firstByteSeeded = true;
    }
    if (opts.payloadBytes !== undefined) {
      this.payloadCount++;
      this.payloadBytes += (opts.payloadBytes - this.payloadBytes) / this.payloadCount;
    }
    this._samples++;
  }

  /** Seed from a persisted profile (an IDB lookup result). Caps the sample
   *  count so subsequent live observations can still nudge the EWMAs. */
  seedFromPersisted(snap: CostSnapshot): void {
    this.meanDecode = snap.meanFrameDecodeMs;
    this.seekDecode = snap.seekDecodeMs;
    this.firstByte = snap.firstByteLatencyMs;
    this.payloadBytes = snap.payloadBytesPerFrame;
    this.payloadCount = snap.payloadBytesPerFrame > 0 ? 1 : 0;
    this.decodeSeeded    = snap.meanFrameDecodeMs > 0;
    this.seekSeeded      = snap.seekDecodeMs > 0;
    this.firstByteSeeded = snap.firstByteLatencyMs > 0;
    this._samples = Math.min(snap.samples, SEED_SAMPLE_CAP);
  }

  /** Resets all state. Used when a persisted profile is stale (>30 days). */
  reset(): void {
    this.meanDecode = 0;
    this.seekDecode = 0;
    this.firstByte = 0;
    this.payloadBytes = 0;
    this.payloadCount = 0;
    this.decodeSeeded = false;
    this.seekSeeded = false;
    this.firstByteSeeded = false;
    this._samples = 0;
    this._contiguousSamples = 0;
    this._seekSamples = 0;
  }

  snapshot(): CostSnapshot {
    const seekPenalty = Math.max(0, this.seekDecode - this.meanDecode);
    return {
      meanFrameDecodeMs: this.meanDecode,
      seekDecodeMs: this.seekDecode,
      seekPenaltyMs: seekPenalty,
      firstByteLatencyMs: this.firstByte,
      payloadBytesPerFrame: this.payloadBytes,
      samples: this._samples,
      contiguousSamples: this._contiguousSamples,
      seekSamples: this._seekSamples,
      costClass: classify(this._samples, this.meanDecode, this.seekDecode),
    };
  }
}

/** Cost classification logic exposed for direct testing. */
export function classify(samples: number, meanDecode: number, seekDecode: number): CostClass {
  if (samples < MIN_SAMPLES_FOR_CLASS) return 'Unknown';
  if (meanDecode > 50) return 'SlowDecode';
  // When the contiguous-decode bucket is undersampled (which happens
  // whenever aggressive read-ahead keeps every sequential pull warm in
  // the cache), fall back to the seek bucket alone — it's the only
  // signal we have about raw decode cost.
  if (meanDecode === 0) {
    if (seekDecode === 0) return 'Unknown';
    if (seekDecode > 50) return 'SlowDecode';
    if (seekDecode < 10) return 'FastRandom';
    return 'SlowSeek';
  }
  const penalty = Math.max(0, seekDecode - meanDecode);
  // FastRandom requires BOTH cheap decode AND cheap seek.
  if (meanDecode < 10 && penalty < 2 * Math.max(meanDecode, 1)) return 'FastRandom';
  // Everything else (moderate decode, or large seek penalty) leans toward
  // aggressive caching — SlowSeek captures it. SlowDecode already
  // shortcircuited above.
  return 'SlowSeek';
}

function ewma(prev: number, next: number, isFirst: boolean): number {
  return isFirst ? next : (ALPHA * next + (1 - ALPHA) * prev);
}
