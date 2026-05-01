# Effect IDE — Design

The Effect IDE is a development testbed for nano-modules effects. It is a sibling page to the existing sketch editor, sharing the same engine, sketch model, widgets, and editor registry, but with a UI optimized for iterating on a single effect at a time.

## Goals

- One UI per effect, dedicated to fast iteration.
- Every available effect has a default test project that exists "for free" — no manual setup.
- Customizations persist locally; reload restores the exact previous state.
- WASM modules reload automatically when their files change on disk.
- Drop a video or image onto an input card to inject it as the texture source.
- Pause and restart the rendering engine for inspection.

## Non-goals (for now)

- Multi-column projects in the IDE — restricted to a single column. Multi-column will come later by reusing the existing `columns-view` widget without a `columnCount=1` hard cap.
- Per-project run modes (e.g. offline render). The engine always runs live.
- Cloud sync. Persistence is local IndexedDB only.
- A full project file format spec. Projects are `Sketch` objects, serialized as the existing in-memory shape.

## Architecture overview

### Two Vite entry points

```
web/
  index.html              # Effect IDE (the new default)
  resolume/index.html     # The existing sketch editor, served at /resolume/
  src/
    boot.ts               # Shared engine + persistence bootstrap
    effect-ide-app.ts     # IDE entry — imports boot + mounts <effect-ide-app>
    resolume-app.ts       # Sketch editor entry — imports boot + mounts <sketch-app>
```

`web/vite.config.ts` declares both entries via `build.rollupOptions.input`. Each page has its own JS context and its own `AppState` instance. They share an IndexedDB database (same origin), so projects created in one are visible in the other.

There is **no in-app mode switch** — switching between the two is just navigating the URL. This keeps the JS layer free of routing logic and avoids growing branches in the root component.

### State tree

`appState.database` (existing, undo/redo via Immer history):
- `sketches: Record<string, Sketch>` — projects materialize here as `user:<uuid>` entries; transient `default:<effectId>` entries are inserted on selection so the engine can render them.

`appState.local` (existing, ephemeral, gains new fields):
- `userSettings: UserSettings` — persisted independently via debounced autorun (~300 ms). **Never** touched by `appController.mutate`; not in undo history.
- `userProjects: ProjectMeta[]` — manifest of `user:` projects loaded from IndexedDB.
- (existing fields — `availableEffects`, `engine`, etc. — stay as-is)

```ts
interface UserSettings {
  ideLeftPanelWidth: number;        // px
  ideLeftTab: 'explorer' | 'project_editor';
  selectedProjectId: string | null; // 'default:<effectId>' | 'user:<uuid>'
  scrollPositions: Record<string, number>; // keyed by tab id
  paused: boolean;
}
```

### Project lifecycle

Projects use a prefixed ID scheme:

- `default:<effectId>` — virtual. Synthesized on demand from `appState.local.availableEffects`. Single-column shape: `texture_input → module → texture_output`.
- `user:<uuid>` — materialized. Lives in IndexedDB and in `appState.database.sketches`.

**Selection**: `appController.selectProject(id)` writes `userSettings.selectedProjectId`. If the id is `default:` and the corresponding sketch isn't already in `appState.database.sketches`, a transient copy is inserted (without history) so the engine can render it.

**First edit (materialization)** runs inside one `runInAction` and one `appController.mutate`:

1. Mint `user:<uuid>`.
2. Copy the default sketch to `database.sketches['user:<uuid>']`.
3. Delete `database.sketches['default:<effectId>']`.
4. Rewrite `userSettings.selectedProjectId = 'user:<uuid>'`.
5. Apply the recipe to the user copy.
6. IndexedDB autosave picks up the new entry on the next debounce tick.

The function is idempotent: if a `user:` already exists for the same originating effect, it is reused.

**User project autosave**: an `autorun` over `appState.database.sketches` filters keys starting with `user:` and writes them to IndexedDB on a debounce. Deletes are explicit (the explorer's "delete" action calls `projectStore.delete(id)` and removes the in-memory entry).

### Engine command additions

```ts
type WorkerCommand =
  | ...existing...
  | { type: 'setPaused'; paused: boolean }
  | { type: 'restart' }
  | { type: 'reloadWasm'; wasmUrl: string }
  | { type: 'setSketchInput'; sketchId: string; bitmap: ImageBitmap | null };
```

- **`setPaused`**: sets a module-level flag in `engine-worker.ts`. `frame()` keeps requesting animation frames and posts `fps: 0`, but skips `simulateTick` and `markDirty`. This keeps the UI's pause indicator reactive.
- **`restart`**: resets `elapsed = 0` and `lastTime = performance.now()/1000`. Does not unload modules or reset module state — the module's `onStatePatched` handler decides what counts as a restart from its own POV.
- **`reloadWasm`**: see HMR flow below.
- **`setSketchInput`**: uploads an `ImageBitmap` to a `GPUTexture` cached per `sketchId` and routes it as the column's `inputTextureHandle` on each frame. Pass `null` to clear.

### WASM HMR flow

1. `web/src/vite-plugins/wasm-hmr.ts` is registered in `vite.config.ts`. In `configureServer(server)`, it watches `public/wasm/*.wasm` (chokidar). On change, it sends `server.ws.send({ type: 'custom', event: 'wasm:reload', data: { url: '/wasm/<name>.wasm' } })`.
2. `web/src/wasm-hmr-client.ts` (imported by both entry points in dev) registers `import.meta.hot.on('wasm:reload', ...)` and forwards to `engine.reloadWasm(url)`.
3. The worker's `reloadWasm` handler:
   1. Awaits `frameInFlight === false` (existing flag).
   2. Evicts the cached `WasmModule` and removes its effect entries from `effectRegistry`.
   3. Re-fetches and re-instantiates the WASM.
   4. For every live sketch instance whose `module_type` belongs to that module, re-runs the same code path used by `instantiateEffect`/`changeInstanceType` to rebuild the live instance. The sketch's `instances[key].state` is preserved verbatim, so `onStatePatched` rehydrates the new module to the previous state.
4. The next `frame()` ticks the rebuilt modules. Slider values, taps, and rails remain bound.

### Drag-drop input lifecycle

1. `column-group.ts` renders a `<texture-drop-zone>` overlay only on the column's `texture_input` card.
2. On drop, `texture-drop-zone` resolves the `DataTransfer` to either:
   - **Image**: `createImageBitmap(blob)` → one-shot bitmap.
   - **Video** (Phase 7b, deferred for the first cut): create an off-screen `<video>` element, set up a `MediaStreamTrackProcessor` from `video.captureStream()`, pull `VideoFrame`s in a `requestVideoFrameCallback` loop. Each frame is converted to an `ImageBitmap` via `createImageBitmap(videoFrame)` before being shipped.
3. The result is sent to the worker via `setSketchInput(sketchId, bitmap)` with `[bitmap]` in the transfer list.
4. The main thread caches the source `Blob`/`File` so re-pushing a fresh `ImageBitmap` after the previous one is consumed by transfer is straightforward.

### Layout

```
+------+--------------------+--------------------------------+
|      |                    |                                |
|  i   |  left tab content  |       monitor / output         |
|  c   |   (Explorer or     |                                |
|  o   |   Project Editor)  |                                |
|  n   |                    |                                |
|  s   |                    |   ▶ pause   ⟲ restart          |
|      |                    |                                |
+------+--------------------+--------------------------------+
       ^                    ^
       icon bar             splitter (drag to resize left)
```

Implemented as a CSS grid: `grid-template-columns: var(--ide-icon-bar-w) var(--ide-left-w) 1fr`. The splitter writes through `appController.setUserSetting('ideLeftPanelWidth', ...)` on drag (debounced autosave persists it).

### Future tabs

The icon bar is intentionally extensible — adding a new left tab is a single new component plus an entry in the icon bar registry. Likely future tabs:

- **Inspector**: full per-instance schema editor (more advanced than the inline column-group widgets).
- **Settings**: app-wide settings (theme, default project behavior).
- **Devtools**: WASM module list, GPU memory, frame timeline.

## Open questions / deferred

- **Multi-column expansion**: how to surface the rest of a sketch's columns once we lift the `columnCount=1` cap. Likely a sub-tab or a horizontal scroll within the project editor.
- **Video frame pipeline**: the first cut handles only static images. Streaming video frames via `MediaStreamTrackProcessor` requires deciding on a frame-rate cap, color space, and how to throttle when the worker is behind.
- **UDP / non-browser bridges**: a Vite middleware will eventually proxy datagram protocols to a server-side helper. The plan leaves a stub comment in `vite.config.ts` indicating where it will mount.
- **Cross-origin WASM**: not currently a concern, but if WASM is ever hosted off-origin, the HMR plugin needs a server-side counterpart.
- **Default-project freshness**: when a WASM module changes its parameter set, materialized user projects keep the old shape. Migration is manual for now (delete + re-create).
