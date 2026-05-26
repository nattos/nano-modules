/**
 * AccessClassifier — infers a consumer's frame-pull pattern.
 *
 * One of seven mutually-exclusive modes describes the recent access stream;
 * each maps to a distinct cache policy in the playback service. The
 * classifier is pure logic (no GPU, no IO) and runs cheaply enough that
 * the cost is dwarfed by the texture upload it informs.
 *
 *   Sequential — forward play; ring-cache the next K frames.
 *   Reverse    — backward play; ring-cache the previous K frames.
 *   Strided    — every Nth frame (thumbnail strip / fast-forward).
 *   Loop       — periodic [A,B] range; pin the loop in cache.
 *   Hotspots   — a few specific frames hit far more than others; pin them.
 *   Scrub      — high stride variance with brief sequential bursts.
 *   Random     — no detectable structure; just-in-time fetch only.
 *
 * Per pull: append to a 128-entry ring + update a time-decayed
 * frame-frequency histogram. Every 16 pulls (or on a "shock" — a stride
 * far outside recent norms) the classifier rescores all modes; a candidate
 * mode only takes over the current if it beats it by a confidence margin
 * AND wins two consecutive classifier runs (hysteresis prevents thrashing
 * mid-scrub).
 */

export type AccessMode =
  | 'Sequential'
  | 'Reverse'
  | 'Strided'
  | 'Loop'
  | 'Hotspots'
  | 'Scrub'
  | 'Random';

export interface ClassifierSnapshot {
  mode: AccessMode;
  /** [0..1]; for Random this is "how certain we are it's NOT structured." */
  confidence: number;
  /** Filled for Strided. The dominant non-±1 stride. */
  stride?: number;
  /** Filled for Loop. [min, max] of the looping range. */
  loopRange?: [number, number];
  /** Filled for Hotspots. Top frame indices in descending weight order. */
  hotFrames?: number[];
}

const RING_MAX = 128;
const RECLASSIFY_EVERY = 16;
const HOT_HIST_CAP = 64;
/** Half-life for the frame-frequency time decay, in ms. */
const HOT_HIST_HALF_LIFE_MS = 5_000;
const HOT_HIST_DECAY_K = Math.LN2 / HOT_HIST_HALF_LIFE_MS;
/** Candidate must beat current by this confidence margin to challenge. */
const SWITCH_MARGIN = 0.15;
/** Min real-mode score; below this we fall through to Random. */
const MODE_FLOOR = 0.5;

interface PullEntry { frameIdx: number; monoTimeMs: number; }

interface FreqEntry { weight: number; lastSeenMs: number; }

export class AccessClassifier {
  private ring: PullEntry[] = [];
  private freqHist = new Map<number, FreqEntry>();

  private _mode: AccessMode = 'Sequential';   // sensible cold-start default
  private _confidence = 0;
  // Mode-specific extras for the current mode:
  private _stride: number | undefined;
  private _loopRange: [number, number] | undefined;
  private _hotFrames: number[] | undefined;

  // Hysteresis: a challenger must win two consecutive classifier runs to
  // unseat the current mode. We track "the candidate that won the LAST
  // run"; if the same candidate wins the next run, it commits.
  private candidateMode: AccessMode | null = null;

  // Stats for "shock" detection — abrupt stride magnitude change suggests
  // the pattern has changed and we should re-classify NOW instead of
  // waiting for the 16-pull tick.
  private recentMeanAbsStride = 1;

  private totalPulls = 0;

  /** Cold-start the mode from a persisted record (best-effort). The
   *  classifier will overwrite it on the next reclassify if reality
   *  disagrees. */
  seedFromPersisted(snap: Partial<ClassifierSnapshot>): void {
    if (snap.mode) this._mode = snap.mode;
    if (snap.confidence !== undefined) this._confidence = snap.confidence;
    this._stride = snap.stride;
    this._loopRange = snap.loopRange;
    this._hotFrames = snap.hotFrames;
  }

  recordPull(frameIdx: number, monoTimeMs: number): void {
    // Dedupe consecutive same-frame pulls. They mean "still presenting
    // this frame" (e.g., 60 Hz render loop reading a 30 fps playhead),
    // not "the sink wants a new frame" — feeding them in would inject
    // stride-zero noise that fools the classifier into Strided/Hotspots
    // patterns the access stream doesn't actually have.
    if (this.ring.length > 0
        && this.ring[this.ring.length - 1].frameIdx === frameIdx) {
      // Touch the freq-hist anyway so a *truly* held frame (the `hold`
      // controller) accumulates weight and is still detectable as
      // Hotspots over time. We just skip the ring/stride pipeline.
      this.updateFreqHist(frameIdx, monoTimeMs);
      return;
    }

    // Stride for shock detection (vs the previous pull's index).
    let shock = false;
    if (this.ring.length > 0) {
      const prev = this.ring[this.ring.length - 1].frameIdx;
      const absStride = Math.abs(frameIdx - prev);
      if (absStride > this.recentMeanAbsStride * 4 && absStride > 4) shock = true;
      // EWMA the abs stride lightly so the shock threshold tracks reality.
      this.recentMeanAbsStride = 0.9 * this.recentMeanAbsStride + 0.1 * absStride;
    }

    this.ring.push({ frameIdx, monoTimeMs });
    if (this.ring.length > RING_MAX) this.ring.shift();

    this.updateFreqHist(frameIdx, monoTimeMs);
    this.totalPulls++;

    if (shock || this.totalPulls % RECLASSIFY_EVERY === 0) {
      this.runClassifier();
    }
  }

  snapshot(): ClassifierSnapshot {
    return {
      mode: this._mode,
      confidence: this._confidence,
      stride: this._mode === 'Strided' ? this._stride : undefined,
      loopRange: this._mode === 'Loop' ? this._loopRange : undefined,
      hotFrames: this._mode === 'Hotspots' ? this._hotFrames : undefined,
    };
  }

  /** Direct mode read — convenience for the cache policy lookup. */
  get mode(): AccessMode { return this._mode; }

  reset(): void {
    this.ring = [];
    this.freqHist.clear();
    this._mode = 'Sequential';
    this._confidence = 0;
    this._stride = this._loopRange = this._hotFrames = undefined;
    this.candidateMode = null;
    this.recentMeanAbsStride = 1;
    this.totalPulls = 0;
  }

  // --- Internal: hot-frame histogram with time decay ---

  private updateFreqHist(frameIdx: number, nowMs: number): void {
    // Decay every entry to "now" so weights are comparable.
    for (const entry of this.freqHist.values()) {
      const dt = nowMs - entry.lastSeenMs;
      if (dt > 0) entry.weight *= Math.exp(-HOT_HIST_DECAY_K * dt);
      entry.lastSeenMs = nowMs;
    }
    const existing = this.freqHist.get(frameIdx);
    if (existing) {
      existing.weight += 1;
    } else {
      // Evict the lowest-weight entry if at cap.
      if (this.freqHist.size >= HOT_HIST_CAP) {
        let minKey = -1;
        let minWeight = Infinity;
        for (const [k, v] of this.freqHist) {
          if (v.weight < minWeight) { minWeight = v.weight; minKey = k; }
        }
        if (minKey >= 0) this.freqHist.delete(minKey);
      }
      this.freqHist.set(frameIdx, { weight: 1, lastSeenMs: nowMs });
    }
  }

  // --- Internal: classifier core ---

  private runClassifier(): void {
    if (this.ring.length < 4) return;   // not enough signal yet
    const strides = this.computeStrides();

    const scored: Array<[AccessMode, number, ModeExtras]> = [
      ...withExtras('Sequential', this.scoreSequential(strides), {}),
      ...withExtras('Reverse',    this.scoreReverse(strides),    {}),
      ...withExtras('Strided',    this.scoreStridedWithExtras(strides)),
      ...withExtras('Loop',       this.scoreLoopWithExtras()),
      ...withExtras('Hotspots',   this.scoreHotspotsWithExtras()),
      ...withExtras('Scrub',      this.scoreScrub(strides), {}),
    ];

    let topMode: AccessMode = 'Random';
    let topScore = MODE_FLOOR;       // anything below this falls through
    let topExtras: ModeExtras = {};
    for (const [m, s, ex] of scored) {
      if (s > topScore) { topScore = s; topMode = m; topExtras = ex; }
    }

    // Same mode as before → just refresh confidence + extras.
    if (topMode === this._mode) {
      this._confidence = topMode === 'Random' ? 1 - maxOf(scored) : topScore;
      this.assignExtras(topMode, topExtras);
      this.candidateMode = null;
      return;
    }

    // Different — compare against the CURRENT mode's score IN THIS WINDOW
    // (not its stale historical confidence). Otherwise a mode that locked
    // in at confidence=1.0 can never be unseated, no matter what the data
    // shows now.
    const currentNow = currentModeScore(scored, this._mode);
    const beatsByMargin = topScore > currentNow + SWITCH_MARGIN;
    if (!beatsByMargin) {
      this.candidateMode = null;
      return;
    }
    if (this.candidateMode === topMode) {
      // Won two runs in a row → commit.
      this._mode = topMode;
      this._confidence = topScore;
      this.assignExtras(topMode, topExtras);
      this.candidateMode = null;
    } else {
      this.candidateMode = topMode;
    }
  }

  private assignExtras(mode: AccessMode, ex: ModeExtras): void {
    this._stride    = mode === 'Strided'  ? ex.stride    : undefined;
    this._loopRange = mode === 'Loop'     ? ex.loopRange : undefined;
    this._hotFrames = mode === 'Hotspots' ? ex.hotFrames : undefined;
  }

  // --- Mode scoring (each returns [0..1] confidence) ---

  private computeStrides(): number[] {
    const out: number[] = [];
    for (let i = 1; i < this.ring.length; i++) {
      out.push(this.ring[i].frameIdx - this.ring[i - 1].frameIdx);
    }
    return out;
  }

  private scoreSequential(strides: number[]): number {
    if (strides.length === 0) return 0;
    let hits = 0;
    let resets = 0;       // backward jumps of meaningful magnitude
    for (const s of strides) {
      if (s === 1) hits++;
      else if (s < -4) resets++;
    }
    const raw = hits / strides.length;
    // Each meaningful reset costs Sequential's score — pure-sequential
    // play doesn't have resets. ≥3 resets is loop-shaped, not sequential.
    const penalty = Math.min(0.6, resets * 0.2);
    return Math.max(0, raw - penalty);
  }

  private scoreReverse(strides: number[]): number {
    if (strides.length === 0) return 0;
    let hits = 0;
    let resets = 0;       // forward jumps of meaningful magnitude
    for (const s of strides) {
      if (s === -1) hits++;
      else if (s > 4) resets++;
    }
    const raw = hits / strides.length;
    const penalty = Math.min(0.6, resets * 0.2);
    return Math.max(0, raw - penalty);
  }

  private scoreStridedWithExtras(strides: number[]): [number, ModeExtras] {
    if (strides.length === 0) return [0, {}];
    const hist = new Map<number, number>();
    for (const s of strides) {
      if (s === 1 || s === -1) continue;       // those are Sequential/Reverse
      hist.set(s, (hist.get(s) ?? 0) + 1);
    }
    let bestStride = 0;
    let bestCount = 0;
    for (const [s, c] of hist) {
      if (c > bestCount) { bestCount = c; bestStride = s; }
    }
    if (bestCount === 0) return [0, {}];
    return [bestCount / strides.length, { stride: bestStride }];
  }

  private scoreLoopWithExtras(): [number, ModeExtras] {
    // Loop signature: ≥3 "resets" (frameIdx drops sharply), with the post-
    // reset starting points clustered AND the pre-reset peaks clustered.
    // Between resets the index should generally increase.
    const r = this.ring;
    if (r.length < 12) return [0, {}];

    const resets: number[] = [];   // indices into r where a reset starts
    for (let i = 1; i < r.length; i++) {
      // Drop of at least 4 frames AND the index actually goes backward
      // by ≥ half of the previous forward run's length.
      if (r[i].frameIdx < r[i - 1].frameIdx - 4) resets.push(i);
    }
    if (resets.length < 3) return [0, {}];

    // Collect (post-reset start, pre-reset peak, reset magnitude) per cycle.
    const starts: number[] = [];
    const peaks: number[] = [];
    const magnitudes: number[] = [];
    for (let k = 0; k < resets.length; k++) {
      const startIdx = resets[k];
      starts.push(r[startIdx].frameIdx);
      const peakIdx = startIdx - 1;
      peaks.push(r[peakIdx].frameIdx);
      magnitudes.push(r[peakIdx].frameIdx - r[startIdx].frameIdx);
    }
    // Reset magnitudes must cluster — that's what makes a periodic loop
    // distinguishable from random negative jumps that happen to repeat
    // 3+ times by chance.
    const magMean = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
    const magStd = stdev(magnitudes);
    if (magMean <= 0 || magStd > magMean * 0.25) return [0, {}];
    // Starts and peaks must each individually cluster tightly. The
    // denominator is the *loop period* (mean magnitude), not the
    // overall span — otherwise wide-range patterns where each cycle
    // sits at a different base trip the threshold.
    const startStd = stdev(starts);
    const peakStd = stdev(peaks);
    const tolerance = Math.max(2, magMean * 0.1);
    if (startStd > tolerance || peakStd > tolerance) return [0, {}];
    // ≥3 clean cycles is enough to max-confidence a Loop classification —
    // any further cycles are extra confirmation but don't raise the bar.
    const cycleScore = Math.min(1, resets.length / 3);
    const score = cycleScore;
    const A = Math.round(median(starts));
    const B = Math.round(median(peaks));
    return [score, { loopRange: [A, B] }];
  }

  private scoreHotspotsWithExtras(): [number, ModeExtras] {
    if (this.freqHist.size < 2) return [0, {}];
    let total = 0;
    const items: Array<[number, number]> = [];
    for (const [frame, e] of this.freqHist) {
      total += e.weight;
      items.push([frame, e.weight]);
    }
    if (total <= 0) return [0, {}];
    items.sort((a, b) => b[1] - a[1]);
    const top = items.slice(0, 8);
    let topMass = 0;
    for (const [, w] of top) topMass += w;
    const coverage = topMass / total;
    // Real hotspot patterns concentrate ≥75% of weight in the top-8 with
    // each hot frame visited multiple times. Random/uniform data trips
    // the 60% bar by chance on small samples, so we keep the bar higher
    // AND require the top frame to have weight ≥3 (otherwise nothing
    // is truly "hot", it's just the most-recent few unique entries).
    const topWeight = top[0]?.[1] ?? 0;
    if (coverage < 0.75 || topWeight < 3) return [0, {}];
    return [coverage, { hotFrames: top.map(t => t[0]) }];
  }

  private scoreScrub(strides: number[]): number {
    if (strides.length < 8) return 0;
    // Loop has priority over Scrub: if the negative jumps (the resets)
    // cluster around one magnitude, this is loop-shaped, not scrub-shaped.
    // Without this check, Scrub commits at 2 cycles before Loop can hit
    // its 3-cycle threshold — and once Scrub is locked in, Loop can't
    // beat it by the hysteresis margin even when its score reaches 1.0.
    const resets: number[] = [];
    for (const s of strides) if (s < -4) resets.push(s);
    if (resets.length >= 2) {
      const mean = resets.reduce((a, b) => a + b, 0) / resets.length;
      const sd = stdev(resets);
      if (sd <= Math.abs(mean) * 0.2) return 0;   // looks like a loop
    }

    // High stride variance + at least 2 BRIEF sequential bursts (≥3 +1s
    // in a row). A long run of +1s with one big negative jump (the
    // first wrap of a Loop, before there are enough cycles to detect
    // Loop properly) trips this gate otherwise — even though that's
    // clearly not scrub-shaped. Cap the longest burst length so the
    // "first wraparound" case stays Sequential until Loop catches up.
    const variance = stdev(strides);
    if (variance < 3) return 0;       // too smooth → not scrub-like
    let bursts = 0;
    let run = 0;
    let longestBurst = 0;
    for (const s of strides) {
      if (s === 1) {
        run++;
        if (run === 3) bursts++;
        if (run > longestBurst) longestBurst = run;
      } else {
        run = 0;
      }
    }
    if (bursts < 2) return 0;
    // A "brief" burst is a UI-scrub-sized run — interactive drags rarely
    // stay on the slider for more than ~15 frames. Anything past that
    // is sequential-with-a-reset, not scrubbing.
    if (longestBurst > 20) return 0;
    // Confidence rises with both variance and burst count; cap at 1.
    return Math.min(1, 0.55 + 0.1 * bursts + Math.min(0.25, variance / 40));
  }
}

// --- Helpers ---

interface ModeExtras { stride?: number; loopRange?: [number, number]; hotFrames?: number[]; }

function withExtras(
  mode: AccessMode, scoreOrPair: number | [number, ModeExtras], explicitExtras?: ModeExtras,
): Array<[AccessMode, number, ModeExtras]> {
  if (Array.isArray(scoreOrPair)) {
    return [[mode, scoreOrPair[0], scoreOrPair[1]]];
  }
  return [[mode, scoreOrPair, explicitExtras ?? {}]];
}

function maxOf(scored: Array<[AccessMode, number, ModeExtras]>): number {
  let m = 0;
  for (const [, s] of scored) if (s > m) m = s;
  return m;
}

function currentModeScore(
  scored: Array<[AccessMode, number, ModeExtras]>,
  mode: AccessMode,
): number {
  // Random's "score" in this window is the inverse of the strongest real
  // mode — we hold our position iff nothing else has substantially won.
  if (mode === 'Random') return 1 - maxOf(scored);
  for (const [m, s] of scored) if (m === mode) return s;
  return 0;
}

function stdev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length & 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
