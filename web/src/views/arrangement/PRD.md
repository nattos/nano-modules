# PRD — Nano Arrangement (beat-grid-native video editor)

## Context

We have a strong foundation: a statically-analyzable effect-chain engine (**Structor**),
sketches that take inputs and render video, robust seeking/playback machinery, a wire-based
modulation system, value/struct rails, a capabilities taxonomy, and a polished
"professional video tool" UI kit. The natural next product is a **video editor** that
arranges sketches over time — Ableton Live's arrangement view, reimagined for video.

This PRD defines that product. Two innovations distinguish it from a straight Ableton clone:

1. **Beat-grid-native with warps.** Clip timings are stored in beats, and the beat grid
   itself can be *warped* (e.g. sinusoidally) by devices in clips, so the grid visibly
   clumps and spreads. This is Ableton master-tempo modulation promoted to a first-class,
   precomputed-and-visualized citizen.
2. **Effect-only clips that export modulations.** Clips need not carry a video source; they
   can be pure effect/modulation. Exported modulations flow onto **value rails** —
   the equivalent of return tracks, but value-only — read/written with the *same* machinery
   as wires (mix mode, magnitude, curves).

The intended outcome of *this* document is a shared, comprehensive spec. **Milestone 1 — the
UI mockup with fake data — is now built** (all surfaces under `web/src/views/arrangement/`,
running at `arrangement.html`, no engine). The PRD covers the full vision and flags the v1 cut;
see **Milestone 1** below for the as-built feature list and **`MOCKUP_NOTES.md`** (sibling file)
for pitfalls, shortcomings, and component-reuse opportunities discovered while building it.

### Key decisions already made (this session)
- **Clip instancing:** none in v1. Every clip is a standalone copy. (Library/pool of
  on-disk reusable clips with dot-separated package paths is explicitly **future / out of scope**.)
- **App surface:** a **new standalone app entry** (own boot/route) that imports the shared
  state / widget / engine infrastructure. It owns its own controller; it does not couple to
  the effect IDE's state.
- **Engine:** a **timeline-native worker** (not a thin wrapper over the existing barrel
  executor), because we expect to need **global GPU synchronization** across all active
  clips/tracks. It calls into the existing sketch executor to render individual clip sketches.
  *This needs investigation* (see Open Questions) — the existing `engine-worker.ts` diff-mirror
  pattern is the model to copy, not necessarily the code to reuse wholesale.
- **First milestone:** **UI mockup with fake data** — all surfaces, hardcoded state, no real
  rendering. Visual iteration first.
- **Execution stays off the main thread from day one**, mirrored to the UI via JSON diffs/patches.
- **MobX for UI binding only. No reactions for business logic** — explicit callbacks/promises
  as signals (matches existing house style).

---

## Goals / Non-goals

### Goals (full vision)
- Arrangement view: tracks, groups (summing upward), clips, drag/resize/move, multi-select.
- Beat/bar-native timing with warpable grid; warps defined by clip devices; visualized.
- Effect-only clips and video clips; double-click creates an empty effect-only clip that
  *promotes* to a video clip when a source/generator is added.
- Value rails ("returns") for exported modulations, read/written like wires.
- Track-level **and** clip-level automation curves.
- Transport (top-center) + Ableton-style scrub/zoom area (top).
- Right vertical tab bar (settings, export, …); inspector on the right with an output monitor
  pinned to its bottom.
- Settable composition resolution.
- Multiple video play modes (forward/random/etc.), with the clip-level loop able to consume the
  computed timings from the chosen mode.
- "Precise" playback/render mode (always waits). "Live" mode is future.
- Offline-precomputable beat warps (v1: special-cased to the LFO in basic modes; identity otherwise).

### Non-goals (v1)
- Clip instancing / shared definitions.
- On-disk clip library + package addressing; media manager.
- Session view (clip launcher) — *maybe later*.
- "Live" barrel-through playback mode.
- General offline-renderable warp sources beyond the special-cased LFO.

---

## Architecture

### Standalone app, shared infrastructure
A new app entry (e.g. `web/src/views/arrangement/` + an `arrangement.html` boot, mirroring
`effect-ide-app.ts` / `boot.ts`) with its own controller. It reuses, by import:

- **State layering** — copy the `AppState` split: a persisted, undo-able `database` tree
  (composition) and an ephemeral `local` tree (selection, viewport, transport, engine
  telemetry). See `web/src/state/app-state.ts`.
- **Undo/redo** — the immer `produce` + forward/inverse-patch `record()` / `LongEdit`
  machinery in `web/src/state/history.ts`, applied to live observables via
  `applyPatchesToObservable`. Reuse verbatim; the composition document is just a different shape.
- **Selectables** — the path-keyed `Selectable` registry with queued-promotion
  (`web/src/state/controller.ts`, `web/src/state/types.ts`). Tracks, clips, automation lanes,
  rails, and the monitor all become selectables; multi-select is a set of selectable paths.
- **Worker mirroring** — the per-key JSON-diff pattern in `web/src/engine-worker.ts`
  (`diffMap` → `{changed, removed}` frame channels → `applyPluginStatesDiff` etc. on the main
  thread). The arrangement worker emits analogous diff channels for transport position, warped
  clock, per-clip plugin state, rail values, and modulation telemetry.
- **Lit + MobX** — every component extends `MobxLitElement`
  (`web/src/mobx-lit-element.ts`); `render()` runs in an autorun.
- **Widgets** — the full field-editor library (`web/src/widgets/`: `scalar-slider` with
  modulation bands, `field-*`, `generic-inspector`, `field-layout-manager`,
  `texture-monitor`), the canvas-graph editors (`web/src/editors/`: `envelope-inspector`
  is the template for automation lanes), `category-color`, `smart-input` (effect picker).
- **Styling** — `web/src/style.css` design tokens (dark `#121418`/`#1a1d24`, JetBrains Mono,
  muted category accents, Photoshop checkerboard alpha). See `EFFECTS_STYLE_GUIDE.md` for
  the analogue/photolab sensibility (HDR float intermediates, non-linear warmth, normalized
  `[0,1]`/`[-1,1]` param ranges, aspect-ratio-baked math, cover-square anchors).

### Timeline-native worker
A new worker that owns:
- The **beat clock**: bars/beats ↔ seconds, including the **warp** transform (see below).
- The **track graph**: which clips are active at the current warped beat per track; group
  summing/compositing order.
- **Global GPU synchronization** across all active clip renders (the motivating reason for a
  fresh worker rather than wrapping the per-sketch barrel).
- Per-clip sketch rendering by calling into the existing sketch/barrel executor
  (`native/src/sketch/sketch_executor.h` via `executor.wasm`).
- **Compositing** via the existing blend path: `video_blend` effect
  (`native/wasm_modules/video_blend/main.cpp`, 16 modes) and/or host opacity blend
  (`native/src/sketch/host_blend.h` `WetDryBlend`). Track/group summing reuses this; the
  design leaves room for other mixers.

It mirrors back to the UI via JSON diff channels (transport, warped grid samples, plugin
states, rail values, modulation telemetry, traced monitor frames).

---

## Core data model

All timings in **beats** (double). The persisted composition (`database`) is sanitized with
`JSON.parse(JSON.stringify(toJS(...)))` before crossing to the worker (existing boundary rule).

```
Composition
  meta:        { resolution: {w,h}, baseBPM, timeSignature, ... }
  tracks:      Track[]            // ordered; groups nest
  rails:       Rail[]             // value-only "return" channels
  playMode:    PlayModeConfig     // global default; clips may override
Track
  id, name, kind: 'track' | 'group'
  parentId:    string | null      // group nesting; groups sum upward
  sketch:      Sketch             // track/group-level effect chain (Structor sketch)
  automation:  AutomationLane[]   // track-level; targets THIS track's sketch fields only
  clips:       Clip[]             // (tracks only)
Clip
  id, name
  startBeat, lengthBeat
  kind:        'effect' | 'video' // promoted from 'effect' when a source/generator is added
  sketch:      Sketch             // the clip's effect chain (a full Structor sketch)
  source?:     VideoSourceRef     // present iff kind === 'video'
  loop:        ClipLoopConfig     // play mode + range; consumes computed timings
  automation:  AutomationLane[]   // clip-level; moves WITH the clip; targets this clip's sketch
  exports:     RailExport[]       // modulations this clip writes to rails
  warps:       WarpBinding[]      // devices in this clip that warp the beat grid
Rail
  id, name, defaultValue, range:{min,max}   // range = modulation contract (like an output's floatField)
AutomationLane
  targetField: { instanceKey, field }       // a field in the owning sketch
  points:      EnvelopePoint[]               // reuse envelope.h / envelope-inspector model
  // combine/magnitude semantics shared with wires
```

`Sketch`, `ChainEntry`, `Wire`, `InstanceState`, `TapMod`, `WireMagnitude`, `TapCombine`
are reused directly from `web/src/sketch-types.ts` — a clip *is* a sketch host.

**As-built extensions (mockup, `model/composition.ts`).** The mock added: `Track.kind` gains
`'rail'` (rail/return tracks live in the normal track list and are pinned-to-bottom only for the
main-bus group); `Track` carries `soloed`/`bypassed`/`level` (mixer), and for rail tracks
`railId` + `baseCurve`. `Clip` gains `reads: RailRead[]` (rail → field, alongside
`exports: RailExport[]` = field → rail). `RailExport`/`RailRead` extend a shared `RailTap`
(`scale`/`smoothing`/`remap`) for the tap-config popup. Devices carry `capabilities` and a
`deviceProcessesTexture()` helper drives the modulation-only-vs-insert inference. The beat/warp
transform lives in `model/beat-grid.ts` (`WarpCurve` + `BeatGrid`, `warpDeviationAt`).

---

## Surfaces / UI

```
┌──────────────────────────────────────────────────────────┬────┐
│            Transport (top-center): play / stop / loop      │    │  ← right
│              position (bar.beat), BPM, play-mode            │ R  │    vertical
├────────────────────────────────────────────────────────────┤ I  │    tab bar
│   Scrub / zoom ruler  (Ableton-style: drag-zoom, bar grid, │ G  │   (settings,
│   WARPED grid lines clump/spread)                           │ H  │    export, …)
├──────────┬─────────────────────────────────────────────────┤ T  │
│ track     │  ARRANGEMENT                                     │    │
│ headers   │   clips on tracks; groups; automation lanes      │ in │
│ (name,    │   warped grid behind clips                       │ sp │
│  group,   │                                                  │ ec │
│  sketch   │                                                  │ tor│
│  access)  │                                                  │────│
│           │                                                  │ OUT│  ← output
│           │                                                  │ MON│    monitor
│           │                                                  │ ITOR│   pinned bottom
└──────────┴─────────────────────────────────────────────────┴────┘
```

### Transport (top-center)
Play / stop / loop toggle, transport position (bar.beat), BPM, global play-mode selector,
Precise/Live mode (Live disabled in v1). Reuse the IDE transport idiom from
`views/effect-ide/ide-monitor.ts` (play/pause/restart/frame-step + FPS/GPU-headroom stats).

### Scrub / zoom ruler (top)
Ableton-style time ruler with the famously-confusing drag-to-zoom (vertical drag zooms,
horizontal drag scrolls). Renders the **warped** bar/beat grid — lines clump where the warp
speeds the grid and spread where it slows. Loop brace lives here. New canvas/zoom-pan widget;
borrow zoom/pan mechanics conceptually from `columns-view`/envelope-canvas transforms.

### Arrangement (center)
- Track lanes; **group tracks** nest children and **sum upward** (composite child outputs via
  the blend path, in order).
- Clips drawn at `startBeat`/`lengthBeat` in *warped* space (clip rectangles distort with the
  grid). Effect-clips vs video-clips visually distinguished (category-dot / thumbnail).
- **Double-click empty lane → new empty effect-only clip.** Adding a video source or an effect
  with the **source/generator** capability promotes it to a video clip.
- Automation lanes expand under tracks (track-level) and ride within clips (clip-level).
- Multi-select (rubber-band + shift-click); selection is a set of `Selectable` paths.

### Track headers (left)
Name, group expander, mute/solo (future), a compact view of the track's sketch + an access
indicator. Selecting a header shows the track's sketch + track-level automation in the inspector.

### Right vertical tab bar
Built-in tabs, each rendering into the inspector area:
- **Settings** — composition settings (resolution, BPM, time signature) **and** app-wide user
  settings, combined in one list.
- **Export** — offline render (Precise mode, always-waits) to file.
- (room for: rails/returns manager, browser, …)

### Inspector + pinned output monitor (right)
The inspector renders `selection.renderInspectorContent?.()` from the selectable registry
(exactly like `edit-tab.ts renderRightPanel`). The **output monitor is pinned to the bottom**
(reuse `texture-monitor` / `ide-monitor`, checkerboard alpha, fit mode). Monitor target
re-routes to a selected selectable's `traceTarget` when present, else the composition output —
the same `traceController.register` autorun pattern already in `edit-tab.ts`.

In the mock the inspector shows: clip/track fields, an **effect chain** (`arr-chain`, real
`scalar-slider`s via a `FakeBinding`), a **Dashboard** (exposed-input knobs above the chain,
output trace-cards below), and **pips** on wired fields/outputs that open the wire tap popup.

### Rail (return) tracks — *as-built*
Rails render as **tracks** in the normal list (movable; the main-bus group is the only pinned
track). Each rail lane (`arr-rail-lane`) draws a value envelope: a dashed **base curve** plus
**writer contributions** summed on top. Headers show range + writer/reader counts.

### Wire overlay (rail modulation) — *as-built*
A **W**ires toggle (next to the **A**utomation toggle) gates a viewport-level SVG overlay
(`arr-overlay`) that draws writer (clip→rail), reader (rail→field), and beat-warp wires in the
sketch wire aesthetic (arcing bezier, marching ants, pips, red-selected). Endpoints come from a
**cross-shadow anchor registry** (`anchor-registry.ts`) so a reader wire can terminate at the
actual inspector field editor; writers reroute to a clip's **output trace card** when selected.
Pips (on wires AND on inspector fields/outputs) open a tap-config popup (combine / magnitude /
smoothing / remap / scale) — working regardless of wire mode.

### Beat-warp track — *as-built*
In automation mode a **Beat Warp** automation track renders below the main bus showing the warp
curve; the warp clip's wire targets it, or reroutes to the **main bus** when wire mode is on but
the warp track is hidden.

### Bottom clip view — *as-built*
A bottom panel (toggled from the tab bar's bottom icon, resizable, right edge at the inspector)
with a **shared zoomable gridded time view** (`time-strip`: pan/zoom/scrub/hover, playhead, loop
shading). **Source mode**: preview + film strip, hover mini-preview, drag-scrub, play-mode
shading; preview hides when short. **Automation mode**: curve editor + film strip + loop/clip
timing toggle. Procedural film frames stand in for real thumbnails (`film-reel.ts`
`drawFrameCell`). Intended to grow Ableton-style editing of loop markers + automation nodes.

---

## Innovation 1 — Beat warp

**Model.** The beat clock maps beat ↔ seconds. A **warp** is a function applied on top of the
nominal tempo that locally speeds/slows the grid (e.g. sinusoidal). Warps are contributed by
**devices inside clips** over the clip's time range — conceptually identical to modulating
Ableton's master-track tempo, but first-class.

**Visualization.** The scrub ruler and arrangement grid render the warped beat positions, so
grid lines (and the clip rectangles laid out in beat space) visibly clump and spread.

**Offline precomputation (hard requirement).** Because warp affects the global beat→time map,
it must be resolvable **offline** (not just at the live playhead). Both the grid render and
seeking depend on integrating the warp over time.
- **v1 cut:** special-case the **LFO** (`native/wasm_modules/env_lfo/main.cpp`) in its **basic
  (deterministic) modes** — Sine/Square/Triangle/Saw are pure `f(phase, shape, amplitude)` and
  fully reproducible, so we integrate them analytically/by stepping to build the warp curve.
  Any warp binding whose value does **not** come from a supported LFO mode **fails gracefully
  to identity** (no warp) for now.
- **Forward-looking:** a new **`offline_renderable` capability** (added to the capabilities
  enum in `native/wasm_modules/include/host.h` + `capabilityName()`, surfaced through
  `PluginInfo.capabilities`) will later let arbitrary modulation sources declare themselves
  precomputable, replacing the LFO special-case. **Punting this is acceptable** as long as the
  code paths (warp binding → precomputed curve → grid/seek) are general; only the *source* is
  special-cased.

`WarpBinding` lives on the clip and points at a modulation source instance within that clip's
sketch; the worker precomputes a warp curve when the binding/source goes dirty.

---

## Innovation 2 — Effect-only clips + exported modulations (value rails / returns)

- **Effect-only clips** carry a sketch with no source. Whether such a clip **processes video
  frames** (acts as an insert on the track's running composite) vs. is **modulation-only** is
  determined automatically by **capability inspection**: if every effect in the clip's sketch
  carries *only* modulation capabilities, the clip is modulation-only (it touches no texture and
  just exports values); if any effect processes textures, the clip also processes the track
  composite. No manual toggle.
- **Rails are value-only return channels.** A clip **exports** a modulation by writing a sketch
  output value onto a named rail; other clips/tracks **read** the rail as a modulation source.
- **Read/write reuse the wire system.** Writing-to / reading-from a rail uses the same
  `tap_mod` pipeline as wires (`native/src/sketch/tap_mod.h` ↔ `web/src/tap-mod.ts`): remap
  curves, scale, `combineTap` (Replace/Mix/Add/Mul) with `mixFactor`, and `applyMagnitude`
  (signed/unsigned folding into the destination field's `[min,max]`). The rail's declared
  `range` **is** its modulation contract, exactly as an output's `floatField` min/max is today.
  Users get the same nice options (mix mode, magnitude, curves) via the existing tap UI.
- Telemetry: per-rail value + per-modulated-input `{value,min,max,neutral}` ride diff channels
  to the UI, reusing the `recordModBand` / `modulationData` pattern so sliders draw bands.

---

## Automation (track-level and clip-level)

- **Track/group automation** targets only fields in **that track's/group's** sketch. Lanes
  expand under the track header.
- **Clip automation** targets fields in **that clip's** sketch and **moves with the clip** when
  the clip is moved/resized.
- Both reuse the **envelope** model: `native/src/sketch/envelope.h` math + the
  `editors/envelope-inspector.ts` canvas editor (double-click add/remove points, drag to bend
  easing, live input cursor). Combine/magnitude semantics are shared with wires/rails so the
  evaluation path is one lock-step pipeline.

---

## Video play modes + computed timings

Reuse the testbed playhead model (`web/src/video/playhead-controllers.ts`): `loop`,
`reverse-loop`, `pingpong`, `random-jumps`, `hold`, with `inFrame/outFrame/fps/speed`. The
arrangement is **aware** of the play mode: the **clip-level loop consumes the computed frame
timings** from the selected mode where available (so a clip set to `random-jumps` loops over
the jump-computed positions, not naive wraparound). The access classifier
(`web/src/video/access-classifier.ts`) + playback service inform caching/prefetch under Precise
mode (which always waits for reads to catch up — and is also the offline-render mode).

---

## Composition / output settings & Sketch scalar outputs

- **Resolution** is settable in composition settings (right-tab Settings). Drives the render
  target size for the monitor and export.
- **Export** (right-tab) does an offline Precise render (always-waits) to a file.
- **Sketch scalar outputs ("dashboard for outputs"):** today there is no way to declare a
  *sketch-level* scalar output. We need a **"dashboard"-style mechanism, but for outputs** — a
  way to promote chosen instance fields to named sketch outputs. These named outputs are what a
  clip exports onto rails and what clip/track automation and warps can read/target. (Mirror the
  existing input-dashboard concept; this is new surface to design in the implementation phase.)

---

## Milestones

### Milestone 1 — UI mockup with fake data — ✅ BUILT
All surfaces run against fake state (`model/fake-data.ts`); no engine/worker. Standalone store
(`state/store.ts`, `makeAutoObservable`, explicit actions — no business reactions). Delivered:
- **Shell**: standalone `arrangement.html`; grid layout (transport / arrangement / inspector+
  monitor / right tab bar / bottom clip view); rAF transport ticker; keyboard (space, ⌫, esc).
- **Transport**: play/stop/loop, bar.beat, BPM, Precise/Live, **A**utomation + **W**ires toggles.
- **Warped ruler + grid**: Ableton drag-zoom (down = in, anchored to the original click point),
  +/- center-zoom; warped bar/beat lines clump/spread; playhead + play-from marker + time-region
  composite **above** clips; loop shading behind.
- **Arrangement**: groups (main bus pinned bottom), tracks with **mixer strips** (fader + meter)
  + **solo/bypass**; clips drawn in warped space with **16:9 film-reel** thumbnails (video) or
  device chips (effect); header-drag moves, body-drag = grid behavior, edge-resize; **grid
  quantize** with Alt to break out; double-click creates an effect clip that promotes to video.
- **Time × track selection**: rectangular region drag (main-bus-start = all tracks), selects
  covered clips; **Split / Delete (gap) / Insert Time / Delete Time** ops; ⌫ = delete (gap).
- **Rails/returns**: rail tracks with envelope preview; **wire overlay** (writers/readers/warp)
  anchored to clips, rail lanes, inspector fields, trace cards; **tap pips + popup**.
- **Inspector**: selection fields, effect chain (real sliders), dashboard inputs/outputs, pips;
  Settings (composition + app) and Export tabs; pinned output monitor (drifting placeholder).
- **Beat warp**: warp track in automation mode; offline warp curve drives grid clumping.
- **Clip view**: shared zoomable `time-strip`; source (preview + film strip + scrub/hover) and
  automation (curve + strip) modes.
- **Verified**: typechecks clean; `test/arrangement-smoke.test.ts` (Puppeteer) passes;
  screenshots reviewed. Run at `http://localhost:5174/arrangement.html`.

### Milestone 2 — Engine vertical slice — ✅ BUILT
Real render through `executor.wasm` (NOT a bespoke timeline-native worker — reuses `EngineProxy`/
`engine-worker.ts`): `engine/` ArrEngine + engine-bridge + clip-sketch; real clip effect chains
(`effect-catalog.ts`); modulation telemetry diff-mirrored to the store. **Now MULTI-TRACK**: the
monitor composites the active clip per track at the playhead (groups/bypass/solo/opacity; engine +
media layers) — `store.compositeLayersAtBeat` → bridge renders engine layers → monitor composites.
(Global-GPU-sync question moot for now: layers render as independent traced sketches.)

### Milestone 3 — Beat warp (LFO-special-cased) — ✅ BUILT (offline clock)
`engine/warp-clock.ts` = beat↔seconds seek map on the SAME `WarpCurve` as the grid (one source of
truth); transport advances in real warped seconds. Remaining: the beat-warp LANE preview is still a
faked sine sum (reconcile to the integrated tempo); binding a real LFO instance is a follow-up.

### Milestone 4 — Rails/returns + automation — ◐ PARTIAL
✅ **Automation**: editable curves (`<arr-automation-editor>` over the shared `<envelope-graph>`),
lock-step eval (`automation-eval.ts` → `envelope.h` twin). ✅ **Dashboard**: real `<scalar-knob>` +
`<spark-chart>` bindings. ⏳ **Rails (values)**: rail read/write still mocked — blocked on an
architecture fork (the TS `tap-mod.ts` twin was deleted; reintroduce it +goldens vs. native
cross-clip integration). ⏳ **Sketch-output "dashboard for outputs"** (promote fields → named outputs).

### Later
Real empty-state/file-open boot (Component A is built but unused at boot); compositor blend modes +
group-bus chains; overlay rAF-gating + z-order; time-view unification; clip loop/in-out editing +
track reorder/group DnD; `offline_renderable` (generalize warps); Live mode; instancing; clip
library/packages; session view; media manager.

---

## Reuse map

| Need | Reuse |
| --- | --- |
| State layering / undo | `state/app-state.ts`, `state/history.ts` (immer + patches, `LongEdit`) |
| Selection / multi-select | `Selectable` registry, `state/types.ts`, `state/controller.ts` |
| Worker value mirroring | `engine-worker.ts` `diffMap` → `{changed,removed}` diff channels |
| Lit+MobX, no business reactions | `mobx-lit-element.ts` + explicit callbacks |
| Field widgets / inspector | `widgets/*` (`scalar-slider` mod bands, `generic-inspector`, `field-layout-manager`, `texture-monitor`, `smart-input`) |
| Automation editor | `editors/envelope-inspector.ts` + `native/src/sketch/envelope.h` |
| Clip = sketch host | `sketch-types.ts` (`Sketch`/`ChainEntry`/`Wire`/`InstanceState`/`TapMod`) |
| Rail read/write (mix/magnitude/curves) | `native/src/sketch/tap_mod.h` (⚠️ the TS twin `web/src/tap-mod.ts` was DELETED — no JS tap_mod; real rail values are an open fork) |
| Warp source (v1) | `native/wasm_modules/env_lfo/main.cpp` (deterministic modes) |
| Play modes / seeking | `video/playhead-controllers.ts`, `video/access-classifier.ts`, `video/playback-service.ts` |
| Compositing | `native/wasm_modules/video_blend/main.cpp`, `native/src/sketch/host_blend.h` |
| Capabilities (`source`/`offline_renderable`) | `native/wasm_modules/include/host.h` + `PluginInfo.capabilities` |
| Styling | `web/src/style.css`, `EFFECTS_STYLE_GUIDE.md` |

---

## Open questions / risks
- **Global GPU sync** is the stated reason for a timeline-native worker but is *unvalidated*.
  Investigate whether per-clip renders can be batched into one command buffer with the existing
  begin/endSubmitBatch path, and how cross-frame stateful-compute syncs (cf. the phase_fold
  IOSurface pitfall) behave when many clips render per frame. May force design changes to the
  worker boundary.
- **Warp generality vs LFO special-case** — confirm the warp-curve interface is source-agnostic
  so swapping in `offline_renderable` later is non-breaking.
- **Sketch-output "dashboard"** mechanism is genuinely new surface (no existing analog for
  *outputs*); needs its own mini-design.
- **Warped-space hit-testing/layout** — drawing and editing clips in warped beat space needs a
  clean beat↔pixel transform that stays invertible through the warp.

## Verification (per milestone)
- **M1 (mockup):** runs in the dev server (`npm run dev` from `web/`) at the new route; all
  surfaces render from the fake `Composition`; interactions (select/multi-select, create clip,
  drag/resize, zoom/scrub, lane expand) work; visual review against `style.css`/style guide.
  Add a Puppeteer smoke test (mirror `video-testbed-smoke.test.ts`) that boots the app and
  asserts surfaces mount.
- **M2+:** Vitest unit tests for the beat/warp clock and rail/automation evaluation (lock-step
  with `tap-mod`/`envelope` goldens); GPU e2e (`GPU_TEST_BASE_URL`) asserting monitor pixels;
  native Catch2 parity where the executor path is shared.
