# Nano Arrangement — Mockup Notes

Companion to `PRD.md`. Captures what we learned building the **Milestone 1 mockup**
(`web/src/views/arrangement/`): pitfalls to avoid, shortcuts that must be replaced for the real
thing, and where to reuse code — especially **whole components from the Effect IDE / Sketch IDE**,
since making the two surfaces look and feel the same is a deliberate goal.

> **STATUS 2026-06-22:** M1 was a fake-data mockup; most of it is now real (engine, undo +
> disk persistence, real clip chains, editable automation, real dashboard, real thumbnails,
> multi-track compositing). `surfaces/fake-binding.ts` + `surfaces/arr-chain.ts` are RETIRED
> (the inspector mounts the real shared `<column-group>`). Mockup-only leftovers still standing:
> `model/fake-data.ts` (RETIRED as the boot default — the app now boots an empty document;
> it's an opt-in DEMO via `store.loadDemoComposition()` + a "Load demo" button) and
> `surfaces/film-reel.ts` (procedural fallback when no decoded thumbnail is available).
> See the per-item status below; the canonical running history lives in the memory note
> `nano-arrangement-project` and the plan file.

> **WIRES (2026-06-23):** intra-sketch modulation wiring is live behind the inspector "Wires"
> toggle — click/drag a field port to connect; arcs draw in-column (`column-group`, scoped to
> its shadow); double-click an arc to remove. `mod.*` sources/shapers (LFO, ADSR, Spectral LFO,
> Remap, Smooth, Delay) are in the arrangement catalog with a declared `output`. NOT yet wired:
> **DONE since:** (a) wires now EXECUTE — `buildCompositeSketch` folds `ClipSketch.wires` into the
> composite (remapped to `clip_<clipId>_<deviceId>`); the executor applies them. (b) SCALAR output
> traces are LIVE — the engine's `pluginStatesDiff` is routed to `store.pluginStates` and read by the
> adapter's `pluginState()`, so an LFO `output` spark animates. (c) the wire-mod inspector is in
> (select an arc → combine/curve/magnitude/envelope/scale/delay).
> (d) TEXTURE output traces are LIVE too — `<texture-monitor>` takes an injectable `TraceSource`; the
> arrangement's (on `engineBridge`) registers each device's clip-local chain_entry target, remaps it
> to the live composite chain index, captures via the engine, and routes frames to `store.tracedFrames`.
> Caveat: a clip's device only previews while the clip is ACTIVE at the playhead (it must be in the
> composite). Still open: **rail/return endpoints** for wires (`connectSketchWire` requires same-sketch;
> the `Wire` model is instanceKey-based and ready) and migrating the IDE off `taps-overlay`.

---

## Known pitfalls (hit while building — don't relearn these)

- **Main-bus identity is by ID, not shape.** `isMainBus` once tested `kind==='group' &&
  parentId===null`, which silently matched ANY user-created top-level group — so the new group
  got pinned to the bottom like the bus and its children rendered above it. The master bus is now
  keyed by the reserved id `MAIN_BUS_ID` (`'main-bus'`). A user group is a normal top-level group:
  it renders ABOVE its (indented) children; the bus stays pinned last.

- **Lit host height collapse.** A component whose only content is an absolutely-positioned
  canvas collapses to height 0 unless the host is `position:absolute; inset:0` (or the parent is
  flex). Bit us on `arr-rail-lane` (canvas drew into a 0-px host → blank envelopes). Probe with
  `getBoundingClientRect().height` before assuming a draw bug.
- **Never mutate MobX observables during `render()`.** `FakeBinding` seeding `device.state` in
  its constructor (called from `arr-chain.render()`) threw "uncaught exception in reaction".
  Write to observables only in event handlers / actions; return defaults lazily in render.
- **Signed shift on a hash.** `h >> k` goes negative past 2³¹ → negative array index →
  `undefined is not iterable`. Use `>>>` (`fakeParamsFor`).
- **Canvas `fillStyle` ignores CSS vars.** `ctx.fillStyle = 'var(--app-…)'` is a silent no-op;
  pass real hex in canvas code (kept a few `--app-*`→hex duplications as a result).
- **requestAnimationFrame ordering.** Parent `updated()` can run before child elements relayout,
  so wire geometry read there is a frame stale. The overlay recomputes on a rAF loop to dodge it.
- **Cross-shadow geometry.** You can't `querySelector` through nested shadow roots cleanly. We
  added an **anchor registry** (`anchor-registry.ts`): components register elements by key,
  consumers read `getBoundingClientRect()`. This is the load-bearing trick for the global wire
  overlay and should stay.
- **Dev server.** This workspace's vite always runs on **localhost:5174** — never `pkill vite`;
  point e2e/screenshots there (`ARR_BASE_URL=http://localhost:5174`).
- **Effect-only clip → identity on re-activation (FIXED).** A time-independent effect (e.g.
  `brightness_contrast` brightness=1.0 → white) rendered correctly the FIRST time a clip was
  active, then collapsed to identity/passthrough on every later activation (came back for exactly
  one activation after any param edit / move / a live wire). Root cause is web-side only: the
  composite is re-issued as the playhead crosses clip boundaries; when a device leaves the chain
  its web instance is **pruned** (`pruneInstancesExcept`, bounds WASM memory), but the executor's
  native `lastAppliedState_` cache (in `executor.wasm`, keyed by instance_key) persists. On return
  the instance is recreated **fresh (default params)** yet `maybeApplyState` skips because the
  cached state still matches the JSON → the effect runs with defaults → identity. Fix in
  `executor-host.ts`: track `slot.appliedKeys`; if a chain entry is recreated fresh while its key is
  in `appliedKeys`, **rebuild the executor slot** (`executor_destroy` + recreate) so all state
  re-applies. `deleteSketch` also drops the slot (full-teardown path). The native barrel is immune
  (its instance pool persists). GPU repro: `test/arr-effect-only-repro.test.ts` drives the real
  `arr-engine-testbed.html` composite (it DOES get a headless GPU adapter — only `arrangement.html`'s
  worker doesn't), white→solid→white.

---

## Shortcomings — status (M1 shortcuts, what's real now)

**✅ Resolved:**
- ~~No engine~~ — real render via `executor.wasm` (`engine/`: ArrEngine/EngineProxy, engine-bridge,
  clip-sketch). Warped transport clock real (`warp-clock.ts`).
- ~~No undo/persistence~~ — `state/history.ts` immer+patch `DocHistory` + `.nano-arr` files on a
  mounted workspace (`workspace/`). All writes funnel through `store.mutate(desc,recipe[,ck])`.
- ~~Dashboard synthesized~~ — real `<scalar-knob>` (rail-read inputs) + `<spark-chart>` (export
  outputs) via `buildClipFieldBinding` (`arr-column-adapter.ts`).
- ~~Display-only AUTOMATION~~ — editable via `<arr-automation-editor>` wrapping the shared
  `<envelope-graph>` (clip-view + clip/track inspector). Curves eval lock-step (`automation-eval.ts`).
- ~~Film thumbnails procedural~~ — real decode + cache (`media/`, Component D); procedural reel is
  now only the not-yet-decoded fallback.
- **(new) Multi-track compositing** — the monitor plays the timeline: `store.compositeLayersAtBeat`
  (groups/bypass/solo/opacity) → bridge renders engine layers → monitor composites engine + media
  bottom→top at per-track opacity.

**⏳ Still open (real TODOs):**
- **Precache: warm effect/sketch instances (PUNTED).** The Precise transport gate + video-decode
  lookahead landed (`engine-bridge` Precise hold + `VideoCompositor.clipReady`/warm pulls +
  `store.videoClipsInWindow`). NOT done: pre-instantiating upcoming clips' WASM effect modules /
  pre-loading their bundles ahead of the playhead. Video decode is the dominant hiccup (covered);
  effect-instance warming is the next lever if heavy effect-chain clips still hitch on activation.
- **Rail-lane preview fidelity (rails MODULATE for real).** Rails/returns work end-to-end:
  `composite-frame` folds rail bases (`evalCurveAt` on the return's `baseCurve`) + writer wires into
  the executor's parameter-automation; the executor applies them; the `modulationData` channel
  reports them. The rail LANE also draws the rail's real value (base + every active writer, evaluated
  offline in `offline-curve-eval.ts`). The ONLY gap is PREVIEW fidelity for writers without a real
  block source: `mod.source.lfo` uses a hand-written TS mirror (`lfoBlockAt`, an `env_lfo` twin) and
  every other effect falls back to a generic seeded uncertainty band. The fix is the **offline-
  evaluable modulation-block effect ABI** (effects emit their own `{mean,lo,hi}` blocks) — makes the
  preview real for ALL modulators and retires the TS mirror. (The old "MOCK oscillation /
  `contribAt`" claim here was stale — that code is gone.)
- ~~**Real empty-state / file-open flow.**~~ DONE — the app boots an empty document (one starter
  track over the main bus via `emptyComposition()`); a remembered workspace re-opens over it on
  boot, the Files tab opens/creates `.nano-arr` files, and the old mockup is opt-in
  (`store.loadDemoComposition()` + a "Load demo" button). `fake-data.ts` survives only as that demo
  + an e2e fixture.
- **Continuous rAF overlay.** `arr-overlay` reconciles wires every frame even when idle — gate it.
- **Overlay z-order.** Viewport overlay (z 60) draws wires *over* the bottom clip view.
- **Warp single-source + faked.** Beat-warp lane is a direct sine sum, not the integrated tempo the
  grid uses; reconcile to one source of truth in `beat-grid.ts`.
- **Time-view unification.** `time-strip` (linear) vs `BeatGrid` (warped) are separate; unify behind
  one zoomable gridded time view.
- **Other display-only edits.** Clip-view loop/in-out markers; track reorder / group DnD.
- **Group-bus effect chains.** Blend modes are DONE (`Track`/`Clip.blendMode`, lock-step
  `BLEND_MODE_NAMES`, 16-mode inspector selector, applied through the executor). Still open: a GROUP
  track's own effect chain processing its summed children (groups currently only sum upward).
- **Dynamic-generator film-strip thumbnails (push-capture).** Designed in `media/THUMBNAIL_CACHE.md`
  but not built: generators are non-deterministic, so flip from pull (decode-on-demand) to push
  (capture observed composited frames), keyed `clipId:paramFingerprint`, reusing the whole cache.
- **Single-keyframe video sources don't advance.** Video clips render via the main-thread decode
  pump (`engine/video-compositor.ts`), which opens sources with random access
  (`sequential: false`). Sources with sparse/single keyframes (e.g. some Adobe Stock `.mov`
  exports) seek to their lone keyframe on every pull → the clip freezes on one frame. DXV + normal
  H264 (`/media/test_h264.mp4`) work. Fix needs sequential decode (forward play from the keyframe
  + forward-cache) for sparse-keyframe sources — detect at open via the playback service's
  seek-strategy probe. See [[host-injected-texture-via-slot]].

---

## Opportunities for reuse (internal)

- ✅ **Undo/redo + persistence.** DONE — `state/history.ts` `DocHistory` (immer+patch, adapted from
  the IDE) + `.nano-arr` files on a mounted workspace (`workspace/`).
- ⏳ **One time-view abstraction.** Still TODO: generalize `BeatGrid` (warped) and `time-strip`'s
  linear view into one shared transform + gridded-canvas (ruler / grid / clip view / automation).
- ◐ **Selectable registry.** Partial — selection is still the bespoke `Set<path>` + `primaryPath`;
  the IDE's path-keyed `Selectable`/`defineSelectable` isn't adopted (the shared `<column-group>`
  routes its own selection through the adapter).
- ✅ **Worker diff mirror.** DONE for modulation telemetry — `onModulationDataDiff` →
  `store.applyModulationDataDiff` mirrors `appState.local.engine.modulationData`.
- ⚠️ **Lock-step math.** automation/rail curves eval through `automation-eval.ts` → `envelope-math.ts`
  (the real `envelope.h` twin). The rail `tap_mod` twin `web/src/tap-mod.ts` was **DELETED** (zombie):
  actual rail modulation is applied **natively** by the executor (no TS tap_mod). The rail-lane
  PREVIEW uses `offline-curve-eval.ts`, which mirrors `env_lfo` for the LFO and stubs other writers
  until the offline-evaluable modulation-block effect ABI lands (see "Still open" above).

---

## Reuse of **whole components** from the Effect IDE / Sketch IDE

Look-and-feel parity with the IDEs is a goal. These already-built components should be lifted in
(some are already imported; most are not yet):

| Need in arrangement | Reuse from IDE / sketch | Status |
| --- | --- | --- |
| Effect chain in inspector | **`widgets/column-group.ts`** | ✅ DONE — `arr-chain` retired; inspector mounts the real `<column-group>` behind a `ColumnAdapter` (`arr-column-adapter.ts`; caps gate tracing/wiring/smoothing off). |
| Field editors | **`scalar-slider`/`scalar-knob`**, `generic-inspector` | ✅ DONE — column-group's `generic-inspector` param rows + real `<scalar-knob>`/`<spark-chart>` dashboard via `buildClipFieldBinding`. |
| Text rename + autocomplete | **`widgets/editable-label.ts`** (extracted this arc) | ✅ DONE — clip/track names (dblclick-to-edit); shared with the IDE. |
| Rect tracking | **`widgets/field-layout-manager.ts`** | ✅ DONE — anchor-registry delegates to one `FieldLayoutManager` (no second registry). |
| Automation / envelope editing | **`editors/envelope-inspector.ts`** (`<envelope-graph>`) | ✅ DONE — `<arr-automation-editor>` wraps the generic `<envelope-graph>` (clip-view + inspector). |
| Output monitor / preview | **`widgets/texture-monitor.ts`** idioms | ◐ PARTIAL — `arr-monitor` is the real unified compositor (checkerboard + cover-fit) but bespoke (not `texture-monitor`/`ide-monitor`). |
| Wire / tap drawing + tap card | **`widgets/taps-overlay.ts`** (+ `taps-connect.ts`) | ⏳ TODO — `arr-overlay` still re-skins it; caps keep wiring off in the arrangement column. |
| Effect picker (add device) | **`widgets/smart-input.ts`** | ✅ DONE — column-group's header retype/insert uses smart-input (via the adapter's `availableEffects`). |
| App shell / panels / splitter | **`splitter.ts`**, IDE shell | ⏳ TODO — resize handle still bespoke. |
| Category color + icons / reactivity / style | `category-color`, `ui-icon`, `mobx-lit-element`, `style.css` | ✅ used. |

**Bottom line (updated):** the big reuse refactor LANDED — the arrangement now mounts the *actual*
IDE widgets (`column-group`, `scalar-knob`/`spark-chart`, `envelope-graph`, `editable-label`,
`field-layout-manager`, `smart-input`) instead of re-skins. Remaining re-skins: the wire/tap overlay
(`arr-overlay` vs `taps-overlay`), the monitor (bespoke vs `texture-monitor`), and the app
shell/splitter.
