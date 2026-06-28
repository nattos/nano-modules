# Thumbnail cache — design & roadmap

The arrangement's film-strip thumbnails come from a tiered, zoom-aware, persistent
cache. This doc records what's built, the **deferred remaining bits** for the
static (file-source) path, and the **design for dynamic generator sources**
(realtime-captured) — both deferred, captured here while fresh.

## Built (today)

```
ThumbnailManager  (views = prefetch intent; peek = best-available + stretch)
  ├─ memory tier   ThumbnailCache<ImageBitmap>   (LRU + pin + dedup + async-fill)
  ├─ warm tier     PersistentThumbStore<S>        (the seam)
  │     · MockThumbStore (dev)
  │     · WorkerThumbStore → thumbnail-worker → PackedThumbStore → OpfsBlockIO + WebP
  └─ cold tier     ThumbnailProducer (VideoThumbnailProducer = decode via playback svc)
```

Key ideas already in place (don't re-derive):
- **Mip-in-time** (`thumbnail-mip.ts`): `stride(L)=base·2^L`; frames snap to a level;
  coincident frames **share one entry** across levels. Levels are a prefetch/lookup
  concept, not a storage axis.
- **Views vs peek** (`thumbnail-manager.ts`): readers declare `{sourceKey, level,
  range, pattern:'window'|'loop'}` (write side, prefetch + pin); `peek()` is sync,
  non-scheduling, returns the exact tile or the **nearest cached substitute** =
  the "stretching" primitive. The UI rate-limits level changes.
- **On-disk format** (`packed-thumb-store.ts` + `block-io.ts` + `pack-index.ts`):
  chunk **by frame range only** (`floor(frame/framesPerChunk)`), append-only WebP
  tiles + a compact binary index, immutable tiles, reopen reads from disk.
- **OPFS substrate in a worker** (`opfs-block-io.ts`, `thumbnail-worker.ts`,
  `worker-thumb-store.ts`): disk I/O + encode/decode off the main thread.
- **Identity**: `sourceKey = name|size|lastModified` ⇒ a file change is a new key
  (free invalidation); old packs orphan out.

---

## Deferred — remaining bits (static cache)

Both are isolated; neither blocks anything above.

### 1. Wire `WorkerThumbStore` into the app's real `ThumbnailManager`
Today the manager + OPFS store are exercised only by testbeds; `arr-clip` still draws
procedural reels (`film-reel.ts`). Production wiring:
- One app-level `ThumbnailManager<ImageBitmap, ImageBitmap>(producer, new WorkerThumbStore(),
  identityCodec)`.
- `producer` = `VideoThumbnailProducer` fed by the clip's media handle
  (`workspace/media-store.ts` → `openMedia(sourceKey)` → playback service).
- `arr-clip.drawFilmReel` / clip-view source mode: derive level from `pxPerFrame`,
  `manager.setView(...)` for the visible range (rate-limited), and draw via `peek()`
  (substitute → stretch; procedural placeholder only until the first real tile lands).
- **Blocked on**: clips carrying real media (the `ClipSketch → Sketch` + source wiring),
  which is downstream of the engine/clip-model work.

### 2. Per-source LRU budget eviction (OPFS)
OPFS is quota-bound; a derived cache must self-trim.
- Add a small **manifest** (`thumbs/manifest.json`, owned by the worker): `sourceHash →
  { sourceKey, bytes, lastAccessAt }`. Touch `lastAccessAt` on read/write; track `bytes`
  from `appendData`.
- On write, if `BlockIO.totalBytes() > budget`, evict **whole sources** LRU
  (`clear(sourceKey)` → `io.remove(<hash>/)`) until under budget. Coarse (per-source) is
  fine — a source's tiles are cheap relative to the source itself.
- Run lazily in the worker so it never blocks a draw. Surface `stats()` (bytes/budget)
  for a settings readout.

---

## Dynamic generator sources — BUILT (#120), diverged from the design below

Generator film strips now work end-to-end. The original design (kept below for the
reasoning) assumed it would REUSE the static packed-atlas cache; in practice it didn't
fit, so the shipped version is a small dedicated subsystem. What was actually built:

- **Live push-capture, per-clip trace.** While a generator clip is under the playhead its
  OUTPUT is tapped from the live composite via the existing per-device trace seam
  (`engine-bridge` `traceSource` → `remapDeviceTrace` → `store.tracedFrames`) and
  downscaled async (`createImageBitmap`). Non-blocking: GPU-side bitmap, off-main resize,
  and the trace is registered ONLY while a clip has uncached samples then dropped — so the
  compositor does no thumbnail work in steady state. Driven from the arrangement rAF tick
  (`media/generator-thumb-capture.ts`). Fixed 24 samples across a clip, decoupled from the
  zoom-dependent draw cell count.
- **Tolerance-bucketed fingerprint** (`engine/generator-fingerprint.ts`): the clip device
  chain's float params bucketed (≈1.5%) + vec/other numbers + fps. So a continuous slider
  drag doesn't thrash the cache. `time_independent` generators capture ONE representative
  frame for the whole strip.
- **Bespoke two-tier cache** (`media/generator-thumb-cache.ts`), NOT `ThumbnailManager`:
  a hot in-memory LRU over the disk tier. `peekBest(fps, sample)` searches the clip's
  recent fingerprints (current → pre-edit) and returns a `stale` flag — so a cell always
  shows the latest valid frame (substitute or older-fingerprint) and `drawGeneratorReel`
  shades stale ones (`drawStaleCell`, a mid-tone wash that reads on dark generator frames).
  A param edit never blanks the strip — it shows the old frame shaded until re-capture.
- **Disk tier = DIRECT OPFS files** (`media/generator-thumb-disk.ts`), NOT the packed store.
  One WebP per `g<hash>#<sample>` under `gen-thumbs/`, durably flushed on `close()`. The
  packed store was tried first and lost most tiles across a reload (its per-chunk index
  flushes on a debounce that a reload races); direct files survive restarts reliably.
  `prefetch()` warms memory from disk when a clip becomes visible (deduped). `arr-clip`
  `render()` touches `store.enginePlugin(type)` so the strip redraws once plugin discovery
  lands on load (otherwise the clip renders before the registry → reel skipped until a click).
- **Still TODO:** disk eviction — fingerprints are unbounded as params edit (files are tiny
  WebP, deferred); see the per-source LRU sketch above, adapted to `g<hash>` keys.

---

## Dynamic generator sources (ORIGINAL design — superseded in parts by the above)

### The problem
Static video sources are **deterministic**: frame N always decodes to the same pixels,
so we precompute/pull any frame on demand and cache it forever (keyed by file identity).

**Generator/effect clips are not.** Their output at a position can depend on:
- the playhead position (animated),
- the clip's editable parameters,
- **accumulated state** (particles, feedback, integrators) — so the output at beat 40
  depends on the *trajectory* taken to reach it, not just the instantaneous position,
- realtime/non-repeatable inputs (audio reactivity, modulation rails, randomness).

You cannot decode "frame N" of a stateful generator out of order. Its thumbnail is only
*knowable when the playhead actually passes over it during real playback*. So the model
flips from **pull** (decode on demand) to **push** (capture what was observed) — "a system
for remembering and compressing *some* actual playback trajectory."

### Core idea: capture, don't render
Reuse the entire tiered/mip/views/peek/OPFS cache **unchanged**. The only differences are
*who fills it* and *how entries are keyed*:

| | Static (file) | Dynamic (generator) |
| --- | --- | --- |
| Fill | **pull** — producer decodes any frame | **push** — recorder captures observed frames |
| On miss | decode on demand | stays a miss → peek substitutes/placeholder until the playhead covers it |
| Key namespace | `sourceKey = name\|size\|mtime` | `captureKey = clipId : paramFingerprint` |
| Invalidation | file changes → new sourceKey | params change → new fingerprint |
| Temporal coverage | complete (any frame) | sparse — only where playback has gone, at the zoom it was seen |

Because `captureKey` plugs into the existing `sourceKey` slot, **mip, views, peek,
stretching, packs, and OPFS all work as-is**. Dynamic strips just look sparser and densify
as the user plays/scrubs over them.

### Source classification
Per clip, classify from the capability taxonomy (extends `deviceProcessesTexture` /
`composition.ts`, mirrors the engine's `time_independent` / `offline_renderable` tags):
- **Static / offline-renderable** — every output-affecting device is deterministic given
  `(frame, params)`. Use the pull path (current system).
- **Dynamic / realtime-captured** — any device is stateful/animated/realtime. Use the push
  path. No on-demand producer (or a `NullProducer` that always misses).

A clip can flip classes as devices are added/removed (e.g. an effect-only clip promotes to
a stateful generator); the manager just switches which fill path is active for that source.

### Param fingerprinting (the "smart update")
The capture is only valid while the generator's **output-affecting parameters** are
unchanged. Fingerprint them:
- `fingerprint(clip) = hash(canonical(output-affecting params))` — the clip's device chain +
  each device's editable config/state, **excluding** arrangement metadata (name, position,
  selection) and transient runtime state.
- `captureKey = ${clipId}:${fingerprint}`. A param edit that changes output → new fingerprint
  → new namespace; the strip goes cold and re-densifies as playback re-covers it.
- **Granularity:** whole-clip (coarse) is correct because thumbnails are *final composited
  output* — any param anywhere in the chain changes the pixels. (Finer per-stage fingerprints
  could enable partial reuse but don't help final-output tiles; punt.)
- **Smart, not thrashy:**
  - Debounce fingerprinting so a slider drag doesn't spawn a namespace per tick — fingerprint
    on edit-commit (the history `record`, not long-edit previews).
  - Only the **edited clip** invalidates.
  - Keep the **last-K fingerprints** per clip rather than hard-deleting on every change, so
    undo / nudging a value back instantly restores its captures; older fingerprints fall to
    the LRU budget.

### Capture pipeline (realtime-safe)
A `CaptureController` rides the engine's per-frame output (Component C — `ArrEngine` /
timeline worker), for clips that are **dynamic AND currently under the playhead AND playing**:
1. Compute the clip-local **frame** + the **mip level** to capture at (default: the coarsest
   level any active view wants — capture cheap, densify on zoom-in + replay).
2. If `(captureKey, frame, level)` is already resident for the current fingerprint, skip.
3. Otherwise grab the just-rendered clip output (already a GPU texture), **downsample** to a
   thumbnail (GPU blit or a small readback), and hand it to the thumbnail worker to WebP-encode
   + persist — i.e. `manager.put(captureKey, frame, bitmap)` (a push counterpart to `ensure`).
4. **Rate-limit + best-effort:** capture at most once per tile-boundary crossing (or per N ms);
   drop captures under load. Never stall playback — capture is fire-and-forget.

This is just `store.write` + a memory insert on the existing tiers; no new storage code.

### Temporal compression & "some trajectory"
- **Spatial:** WebP (already).
- **Temporal:** capture at mip granularity — store sparse tiles at the viewed level, not every
  frame. Zooming in shows stretched coarse tiles (existing peek behavior) until a finer-zoom
  replay captures finer tiles. The mip *is* the temporal compressor.
- **Trajectory tagging:** because stateful output is path-dependent, tag each capture with how
  it was reached — `entered-from-clip-start` (canonical) vs `scrubbed-in` / `mid-jump`
  (approximate). `peek` prefers canonical captures; approximate ones are fallback. This is the
  "*some* trajectory" honesty: we remember a representative pass, not every possible one.

### Read path
Unchanged: `peek(captureKey, frame, level)` → exact capture, else nearest captured substitute
(stretch), else null → procedural placeholder. Dynamic clips simply have more misses early and
fewer as coverage grows.

### Eviction
Same per-source LRU as the static cache, but the "source" is a `captureKey`
(`clipId:fingerprint`). Orphaned fingerprints (old param values beyond last-K) are reclaimed by
the budget. Deleting a clip evicts all its `clipId:*` namespaces.

### Honest limitations
- **Path-dependence:** identical params reached via different playback paths can differ;
  we keep a representative (canonical-preferred) capture, not all of them.
- **Non-repeatable inputs** (audio/random): captures are snapshots of one performance; "last
  observed wins." Tag with a timestamp; never assert they're reproducible.
- **Coverage gaps** are expected and visible (sparse/stretched strip) until the user plays
  through — by design.

### What actually changes in code (small; cache core untouched)
- `composition.ts`: `classifySource(clip) → 'static' | 'dynamic'` (capability inspection) and
  `fingerprintClip(clip) → string` (output-affecting params hash).
- A `SourceDescriptor { kind, key, fingerprint? }` the manager resolves to a fill path
  (producer vs none).
- `ThumbnailManager.put(key, frame, level, bitmap, {trajectory})` — the push entry point
  (write to memory + store, like a manual fill).
- `CaptureController` — engine-frame subscriber that drives `put` (rate-limited, best-effort).
- Reuse everything else: mip, views, peek/stretch, PackedThumbStore, OPFS worker, LRU budget.

### Open questions
- Capture cadence/level policy (coarsest-active vs a fixed base) and overhead budget.
- last-K fingerprint retention K, and whether to persist across sessions or only in OPFS.
- Whether canonical captures should be opportunistically refreshed (re-capture on a clean
  play-through) to improve fidelity over time.
- GPU downsample-in-place vs small readback for the capture grab (perf).
