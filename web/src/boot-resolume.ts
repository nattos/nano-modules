/**
 * Resolume Playground/Live surface boot. Invoked by `main.ts` when the
 * resolved mode is `'playground'` or `'live'` — mounts `<sketch-app>` and
 * boots the shared engine in one of three ways:
 *
 *   - BARREL (Live, connected): bound to the shared NanoBarrel server over
 *     WS; the remote bridge is the source of truth, nothing simulates
 *     locally.
 *   - LIVE OFFLINE (Live, disconnected): a local, Playground-like simulation
 *     of every cached Live instance (`state/live-cache-store.ts`) — the
 *     engine actually runs (see `bootLiveOffline`'s doc comment for why this
 *     needs a fresh boot rather than an in-place toggle). Entered when
 *     `barrelRemoteEnabled` is off, or the user accepts a failed-connect
 *     "edit offline?" offer (`LIVE_OFFLINE_KEY`, sessionStorage).
 *   - PLAYGROUND: a local simulation of the shared server — fake "instances"
 *     (one sketch each, all running simultaneously in the worker) persisted
 *     in their own IndexedDB store, for testing multi-instance routings
 *     without Resolume.
 */

import { boot } from './boot';
import {
  groupPreviewRequests, instanceKeyFromThumbTraceId,
  laneUrl, NbpcReassembler, previewTransportPorts,
  LIVE_OFFLINE_KEY,
} from './resolume-mode';
import { startBarrelProbe } from './barrel-probe';
import { installModeOffers } from './live-offers';
import { installDeviceDefineOffers } from './views/devices/define-offer';
import { midiController } from './state/midi-controller';
import { traceController } from './state/trace-controller';
import { loadUserSettings } from './state/user-settings';
import { loadAllPlaygroundInstances } from './state/playground-store';
import {
  loadLiveCacheInstance, loadAllLiveCacheInstances, saveLiveCacheInstance,
  type LiveCacheRecord,
} from './state/live-cache-store';
import { reconcileDecision } from './state/live-reconcile';
import { reconcileStore } from './views/reconcile-dialog';
import { instanceDisplayLabel } from './state/instance-labels';
import { snackbars } from './widgets/snackbars';
import { appController } from './state/controller';
import { appState } from './state/app-state';
import type { Sketch } from './sketch-types';
import { PLAYGROUND_ID_PREFIX, type BarrelInstanceInfo, type ResolumePlacement } from './state/types';
import { parseBarrelInstances, parseResolumePlacement } from './state/barrel-instances';
import { WsBridgeClient } from './ws-bridge-client';
import { normalizeSketchChains } from './sketch-types';
import { EFFECT_BUNDLES } from './effect-bundles';

// Import the root component (self-registering)
import './views/sketch-app';

// Dev-only WASM HMR listener (no-op in production).
import './wasm-hmr-client';

function forceOfflineFlag(): boolean {
  try { return sessionStorage.getItem(LIVE_OFFLINE_KEY) === '1'; } catch { return false; }
}

/**
 * @param mode 'barrel' (Live) or 'playground', already resolved by `main.ts`
 *   from the persisted `appMode` setting (or a `?playground`/`?barrel`
 *   boot-time override) — no URL parsing happens here.
 * @param barrelUrl Only meaningful for `mode: 'barrel'`.
 */
export async function bootResolume(mode: 'barrel' | 'playground', barrelUrl: string): Promise<void> {
  document.body.appendChild(document.createElement('sketch-app'));
  // Unknown-MIDI-device → "define it" snackbar. Installed once for every
  // <sketch-app> surface (the Devices tab lives here, not in the effect IDE).
  installDeviceDefineOffers();

  if (mode === 'playground') {
    await bootPlaygroundMode(barrelUrl);
    return;
  }

  // -- Live mode: peek `barrelRemoteEnabled` + the offline override BEFORE
  // booting the engine — this decides whether the engine actually simulates
  // locally (offline, like Playground) or stays idle waiting on the remote
  // barrel, and that choice is baked into the engine worker at construction
  // time with no supported way to change it after (see `bootLiveOffline`'s
  // doc comment). A second settings read (boot() below does its own) —
  // cheap, and keeps this decision self-contained.
  const settings = await loadUserSettings();
  const offlineFlag = forceOfflineFlag();
  console.log(`[live-cache] bootResolume dispatch: barrelRemoteEnabled=${settings.barrelRemoteEnabled}, forceOfflineFlag=${offlineFlag}`);
  if (!settings.barrelRemoteEnabled || offlineFlag) {
    await bootLiveOffline(barrelUrl);
    return;
  }

  // The playground simulates sketches in-worker — render at full 1920×1080
  // (the boot default is a tiny 320×180). Barrel mode never simulates (the
  // plugin renders), so the size is irrelevant there.
  await boot({ width: 1920, height: 1080, mode: 'barrel' });
  appController.setBarrelMode(true);
  installModeOffers();
  appController.setLiveMode(true);
  // User-settings persistence (the Remote toggle, appMode, the remembered
  // instance key) needs to actually save while in Live mode too — this was
  // previously skipped entirely for barrel mode (the remote bridge being the
  // source of truth for SKETCHES doesn't mean settings shouldn't persist).
  // Safe: Live-mode sketch ids are real barrel instance UUIDs, which never
  // match the effect-IDE project id patterns, so `flushProjectsSave`/
  // `flushPlaygroundSave` (also gated by this flag) stay no-ops here.
  appController.enablePersistence();
  connectBarrel(barrelUrl);
}

async function bootPlaygroundMode(barrelUrl: string): Promise<void> {
  await boot({ width: 1920, height: 1080, mode: 'playground' });
  appController.setBarrelMode(false);
  installModeOffers();
  appController.setPlaygroundMode(true);

  // Playground: every playground instance (`pg:` sketch) runs in the worker
  // simultaneously — that's the point (test multi-instance routings as if
  // Resolume were running). The `editingSketchId` disjunct additionally
  // admits ad-hoc sketches created directly by tests/devtools.
  appController.setEngineSketchFilter(
    (id) => id.startsWith(PLAYGROUND_ID_PREFIX) || id === appState.local.editingSketchId);

  // Load every effect bundle so all effects are reachable. Barrel mode
  // skips this — the worker never instantiates anything; the plugin list
  // comes from the barrel's WS state subtree (see connectBarrel).
  for (const bundle of EFFECT_BUNDLES) appController.loadModule(bundle);

  // Selecting a playground instance just opens its sketch (the barrel-mode
  // twin of this handler rewires the WS transport instead). Register BEFORE
  // loading instances so the boot-time default pick opens something.
  appController.setBarrelSelectHandler((key) => appController.editSketch(key));
  try {
    appController.loadInitialPlaygroundInstances(await loadAllPlaygroundInstances());
  } catch (err) {
    console.warn('[playground] failed to load instances', err);
  }
  // Persistence goes live only after the load, so loaded state isn't
  // immediately echoed back to the playground store.
  appController.enablePersistence();

  // Re-load the remembered global "test input" video (offline/playground stand-in
  // for Resolume's live feed) — silent, only if its handle permission survived.
  void appController.restoreGlobalInput();

  // Quietly watch for Resolume coming up so the shell can offer Live mode.
  startBarrelProbe(barrelUrl);
}

/**
 * Boot Live mode's offline fallback as a REAL local simulation — every
 * cached Live instance loaded at once and actually rendered by the local
 * WebGPU engine, exactly like Playground (just sourced from `liveCache`
 * instead of `playgroundInstances`, keyed by real barrel instance UUIDs so
 * whichever one you're editing reconciles against the right canonical
 * once reconnected).
 *
 * This needs a FRESH `boot()` call (a fresh `EngineProxy`/worker) rather
 * than flipping a flag on whatever's already running: the engine worker's
 * `barrelMode` is sent once in its `init` command and there is no exposed
 * way to change it afterward — with `barrelMode: true` the worker never
 * acquires a GPU device or starts its render loop at all (confirmed by
 * reading `engine-worker.ts`'s `init()`), so simulating anything requires
 * booting like Playground (`mode: 'live-offline'` — behaves identically to
 * `'playground'` for `boot()`'s purposes, see `BootOptions.mode`) from the
 * start. Reloading into this function (rather than mutating in place) is
 * the simplest way to guarantee that.
 */
async function bootLiveOffline(barrelUrl: string): Promise<void> {
  await boot({ width: 1920, height: 1080, mode: 'live-offline' });
  appController.setBarrelMode(false);
  installModeOffers();
  appController.setLiveMode(true);
  appController.setLiveOfflineMode(true);

  // Every cached instance simulates simultaneously — mirrors Playground's
  // `id.startsWith(PLAYGROUND_ID_PREFIX)`, just via explicit membership
  // since live-cache keys are real UUIDs with no common prefix to match on.
  appController.setEngineSketchFilter(
    (id) => appController.isLiveSketch(id) || id === appState.local.editingSketchId);
  for (const bundle of EFFECT_BUNDLES) appController.loadModule(bundle);

  // Direct switch, no network rewiring needed — the sketch is already
  // loaded locally (same as Playground's select handler).
  appController.setBarrelSelectHandler((key) => appController.editSketch(key));

  let records: LiveCacheRecord[] = [];
  try {
    records = await loadAllLiveCacheInstances();
  } catch (err) {
    console.warn('[live-cache] failed to load offline instances', err);
  }
  // NEVER load the whole cached pile — offline mode runs a real local executor
  // over EVERY instance in this list (for the Instances-tab thumbnails), so an
  // unbounded list melts the GPU. Always filter to a bounded working set:
  //   - members of the last-seen composition (`lastCompositionBarrelIds`,
  //     native's `/global/composition_barrel_ids`) — the legitimate set;
  //   - any `dirty` row (unsynced offline edits — the user's own recoverable
  //     work; reconciliation still folds these back in by exact key on the
  //     next reconnect regardless of composition membership);
  //   - the single last-edited instance, so there's always something to land
  //     on even before we've ever captured a composition (first-ever offline
  //     boot, or a not-yet-redeployed native barrel).
  // Everything else — clean ghosts from compositions you've moved on from —
  // stays in IndexedDB, UNLOADED (not rendered), until a reconnect re-lists it
  // or a future "forget instance" action purges it. There is deliberately NO
  // "show all" fallback: hidden-but-safe beats melting the GPU.
  {
    const member = new Set(appState.local.userSettings.lastCompositionBarrelIds);
    const lastKey = appState.local.userSettings.lastLiveInstanceKey;
    const allRecords = records;
    records = records.filter((r) => member.has(r.key) || r.dirty || r.key === lastKey);
    const hidden = allRecords.length - records.length;
    if (hidden > 0) {
      const offCompDirty = records.filter((r) => r.dirty && !member.has(r.key)).length;
      console.log(`[live-cache] offline boot: NOT loading ${hidden} cached instance(s) outside the working set — kept ${records.length} (${member.size} composition member(s) + ${offCompDirty} off-composition dirty + last-edited)`);
    }
  }
  console.log(`[live-cache] offline boot: loaded ${records.length} cached instance(s): [${records.map(r => `${r.key}${r.dirty ? '*' : ''}`).join(', ')}]`);
  appController.loadInitialLiveCacheInstances(records);
  appController.enablePersistence();

  // Re-load the remembered global "test input" video (offline stand-in for
  // Resolume's live feed) — silent, only if its handle permission survived.
  void appController.restoreGlobalInput();

  if (!appState.local.userSettings.barrelRemoteEnabled) {
    snackbars.show({
      message: 'Resolume Remote is disabled — editing offline.',
      timeoutMs: 0,
      dedupeKey: 'live-offline-active',
      actions: [{
        label: 'Enable Remote',
        run: () => {
          appController.setUserSetting('barrelRemoteEnabled', true);
          try { sessionStorage.removeItem(LIVE_OFFLINE_KEY); } catch { /* ignore */ }
          void appController.flushUserSettings().then(() => location.reload());
        },
      }],
    });
  } else {
    snackbars.show({
      message: records.length > 0
        ? 'Editing offline — changes reconcile once Resolume reconnects.'
        : 'Editing offline — nothing cached yet. This will need to reconcile once Resolume reconnects.',
      timeoutMs: 0,
      dedupeKey: 'live-offline-active',
      actions: [{
        label: 'Try reconnecting',
        run: () => {
          try { sessionStorage.removeItem(LIVE_OFFLINE_KEY); } catch { /* ignore */ }
          location.reload();
        },
      }],
    });
  }

  // Quietly watch for Resolume coming up, same as Playground — offers
  // switching to (actually connected) Live once detected.
  startBarrelProbe(barrelUrl);
}

/**
 * Connect to the shared NanoBarrel server (one WS server on a fixed port,
 * multiplexing every plugin instance under `/plugins/<uuid>/state`).
 *
 * Flow:
 *   - Observe `/global/plugins` → maintain the live instance list (the
 *     Organize tab renders it; the controller picks/persists a selection).
 *   - For the SELECTED instance, observe its `/plugins/<key>/state`, mirror
 *     its sketch into `appState.database.sketches[key]` (the sketch id IS
 *     the instance key — see `state/controller.ts`'s `liveSketchIds` doc
 *     comment), and wire the editor→bridge push + preview-request relay at
 *     that key.
 *   - Switching instances (Organize tab) re-points all of the above.
 *
 * We deliberately observe only `/global/plugins` + the state paths that are
 * actually in use — the selected instance, plus any instance with a live
 * Instances-tab thumbnail — so the native `key_observed` gate does real work:
 * unwatched instances produce no per-frame telemetry/preview data.
 *
 * Exposed on `window.__barrel` for ad-hoc devtools patching.
 */
function connectBarrel(url: string) {
  const barrel = new WsBridgeClient(url);
  (window as any).__barrel = barrel;

  // The instance currently wired for editing.
  let currentKey: string | null = null;
  // The composition placement most recently known for a key (from the merged
  // instance list), so every offline-cache write records where the instance
  // sits in Resolume — the offline Instances tab reproduces the same rows.
  const placementForKey = (key: string): ResolumePlacement | undefined =>
    appState.local.barrelInstances.find((i) => i.key === key)?.resolumePlacement;
  // Snapshot handlers are keyed by exact path; register each instance's
  // handlers once and have them bail if they're no longer the selected key.
  const handlersWired = new Set<string>();

  // -- Live-mode readonly cache / reconciliation state -------------------
  // `resolvedKey` is the key we've finished reconciling THIS wiring session
  // (cleared whenever `wireInstance` picks a new key); `dialogKey` guards
  // against reopening the conflict dialog while one is already showing for
  // the same key (a patch can arrive mid-decision). Cache loads are
  // memoized per key so a pre-connect guess and the real wire (often the
  // same key) share one IndexedDB read.
  let resolvedKey: string | null = null;
  let dialogKey: string | null = null;
  // Latest canonical seen while `dialogKey` is open — a later, more complete
  // snapshot can arrive and update the dialog's display (see below); the
  // eventual resolve must apply that latest value, not whatever was current
  // when the dialog first opened.
  let dialogCanonical: Sketch | null = null;
  const cacheLoadByKey = new Map<string, Promise<LiveCacheRecord | undefined>>();
  const getCacheLoad = (key: string) => {
    let p = cacheLoadByKey.get(key);
    if (!p) { p = loadLiveCacheInstance(key); cacheLoadByKey.set(key, p); }
    return p;
  };
  // Wire the editor→bridge push only once reconciliation resolves for a key
  // (adopt-canonical, or the conflict dialog's choice) — withholds any push
  // of a possibly-about-to-be-discarded cached copy while the user decides.
  const wirePusher = (key: string) => {
    const statePath = `/plugins/${key}/state`;
    appController.setBarrelPusher(key, (snapshot) => {
      if (currentKey !== key) return;
      barrel.patch(statePath, [{ op: 'replace', path: '/sketch', value: snapshot }]);
    });
  };

  // Composition-wide sketch access for repairs (e.g. the Devices tab's
  // ghost-device scan): fetch ANY live instance's sketch over the
  // bridge, independent of the wired-for-editing key. Fetch is one-shot with
  // a timeout so offline placeholder instances (registered in the
  // composition but not launched) resolve null instead of hanging.
  {
    const waiters = new Map<string, ((s: Sketch | null) => void)[]>();
    const wired = new Set<string>();
    appController.setBarrelSketchOps({
      fetch: (key: string) => new Promise<Sketch | null>((resolve) => {
        const statePath = `/plugins/${key}/state`;
        if (!wired.has(statePath)) {
          wired.add(statePath);
          barrel.onSnapshot(statePath, (state) => {
            const ws = waiters.get(statePath);
            if (!ws?.length) return;   // passive-cache / reconcile traffic
            waiters.delete(statePath);
            const sketch = coerceSketch(state?.sketch ?? {});
            for (const w of ws) w(sketch);
          });
        }
        const ws = waiters.get(statePath) ?? [];
        ws.push(resolve);
        waiters.set(statePath, ws);
        barrel.get(statePath);
        setTimeout(() => {
          const cur = waiters.get(statePath);
          if (!cur?.includes(resolve)) return;
          waiters.set(statePath, cur.filter(r => r !== resolve));
          resolve(null);
        }, 3000);
      }),
    });
  }

  // Every barrel instance — not just the one actively wired for editing —
  // gets a one-shot, non-continuous cache mirror so the offline fallback
  // (`bootLiveOffline`) has something for ALL of them, not only whichever one
  // happened to be selected when the connection dropped (previously the
  // only instance ever cached at all). One `get()` per newly-seen key, no
  // `observe()` — cheap, and avoids the native `key_observed` per-frame cost
  // that continuous observation of every instance would impose. Never
  // touches a key that's dirty (unresolved offline edits) or the currently
  // wired key (the main reconciliation flow owns that one).
  const passiveCached = new Set<string>();
  const cachePassiveInstanceOnce = (key: string) => {
    if (key === currentKey || passiveCached.has(key)) return;
    passiveCached.add(key);
    const statePath = `/plugins/${key}/state`;
    barrel.onSnapshot(statePath, (state) => {
      if (key === currentKey) return;  // promoted to wired — that path owns it now
      void (async () => {
        const existing = await loadLiveCacheInstance(key);
        if (existing?.dirty) return;  // don't clobber unresolved offline edits
        const sketch = coerceSketch(state?.sketch ?? {});
        await saveLiveCacheInstance(key, instanceDisplayLabel(key), sketch, false, placementForKey(key));
        console.log(`[live-cache] passively cached instance key=${key} (not the wired instance)`);
      })();
    });
    barrel.get(statePath);
  };

  // A freshly-launched instance can briefly register under a PROVISIONAL
  // UUID before the real persisted config arrives and re-keys it to the
  // confirmed one (native's ensureRegistered → adoptRestoredUuid — a real,
  // consistently-observed ~50-90ms window, not a hypothetical). Since
  // `liveCache` rows are never pruned (see the /global/plugins handler
  // below), passively caching a key the instant it's seen would leave a
  // permanent ghost row for every one of those transient provisional keys —
  // this is the actual mechanism behind "offline mode piling up tons of
  // instances" over repeated Resolume restarts. Debounce so a key that
  // disappears from /global/plugins before the window elapses (see
  // `cancelPendingPassiveCache`) never gets written at all.
  const PASSIVE_CACHE_DEBOUNCE_MS = 500;
  const pendingPassiveCache = new Map<string, ReturnType<typeof setTimeout>>();
  const cachePassiveInstanceOnceDebounced = (key: string) => {
    if (key === currentKey || passiveCached.has(key) || pendingPassiveCache.has(key)) return;
    pendingPassiveCache.set(key, setTimeout(() => {
      pendingPassiveCache.delete(key);
      cachePassiveInstanceOnce(key);
    }, PASSIVE_CACHE_DEBOUNCE_MS));
  };
  const cancelPendingPassiveCache = (liveKeys: Set<string>) => {
    for (const [key, timer] of pendingPassiveCache) {
      if (!liveKeys.has(key)) {
        clearTimeout(timer);
        pendingPassiveCache.delete(key);
        console.log(`[live-cache] key=${key} vanished from /global/plugins before the passive-cache debounce elapsed — likely a provisional UUID, skipping`);
      }
    }
  };

  // Phase A: readonly until reconciled (see below), before we even know
  // whether the barrel will respond.
  appController.setReadonly(true);

  // The "can't reach Resolume" offer (Edit offline / Switch to Playground) is
  // owned by `live-offers.ts` — it fires off the same `barrelConnection` state
  // after a grace window, covering BOTH the initial connect timeout and a
  // mid-session disconnect with a single unified sticky snackbar.

  // Pre-connect: show the last-cached copy for this browser's remembered
  // instance immediately, before we know whether the barrel will even
  // respond. `wireInstance` (once the real selection is known) applies its
  // OWN cache load for whatever key actually turns out to be selected —
  // this is only a best-effort guess to avoid a blank screen during the
  // (usually brief) connect wait.
  {
    const guessKey = appState.local.userSettings.lastLiveInstanceKey;
    console.log(`[live-cache] pre-connect guess: lastLiveInstanceKey=${guessKey ?? '(none)'}`);
    if (guessKey) {
      void getCacheLoad(guessKey).then((record) => {
        console.log(`[live-cache] pre-connect guess resolved: key=${guessKey}`,
          record ? `found (dirty=${record.dirty}, updatedAt=${new Date(record.updatedAt).toISOString()})` : 'NOT FOUND in liveCache store',
          `currentKey=${currentKey ?? '(none)'}`);
        // A real wire already happened by the time this resolved — its own
        // load path (below) owns the display now.
        if (currentKey !== null || !record) return;
        appController.setBarrelSketch(guessKey, record.sketch);
        appController.editSketch(guessKey);
        console.log('[live-cache] pre-connect guess APPLIED to appState');
      });
    }
  }

  // -- Instance-state observations (single ownership) -------------------
  // The native `key_observed` gate only lets an instance do preview/telemetry
  // work while some client observes its `/plugins/<key>/state`. Two things
  // want that: the instance wired for editing, and every instance with a live
  // Instances-tab thumbnail. The client's subscription set is not refcounted,
  // so one reconciler owns ALL instance-state observations — computing the
  // desired set from (currentKey ∪ thumbKeys) and diffing against what's
  // actually observed. Never observe/unobserve these paths elsewhere.
  const observedInstancePaths = new Set<string>();
  let thumbKeys = new Set<string>();
  const reconcileObservations = () => {
    const desired = new Set<string>();
    if (currentKey) desired.add(`/plugins/${currentKey}/state`);
    for (const k of thumbKeys) desired.add(`/plugins/${k}/state`);
    for (const p of desired) {
      if (!observedInstancePaths.has(p)) {
        barrel.observe(p);
        observedInstancePaths.add(p);
      }
    }
    for (const p of [...observedInstancePaths]) {
      if (!desired.has(p)) {
        barrel.unobserve(p);
        observedInstancePaths.delete(p);
      }
    }
  };


  /**
   * Apply a sketch snapshot arriving for `forKey`. Steady-state (already
   * reconciled this wiring session): adopt it directly, like before — this
   * covers both a genuine remote change and the pusher's own edits echoing
   * back. Otherwise this is the FIRST snapshot since `wireInstance` picked
   * this key: run `reconcileDecision` against whatever cache load is
   * pending for it (memoized — the same promise a pre-connect guess or
   * `wireInstance` already started).
   */
  const applySketchFromSnapshot = async (sketch: any, forKey: string) => {
    if (forKey !== currentKey) return;  // superseded by a later wireInstance
    const canonical = coerceSketch(sketch);
    if (resolvedKey === forKey) {
      appController.setBarrelSketch(forKey, canonical);
      appController.editSketch(forKey);
      // Keep the offline cache current with the authoritative barrel state.
      // The FIRST snapshot after wiring can arrive before the barrel has
      // decoded the sketch (empty) — the adopt path below saved THAT, and
      // `setBarrelSketch` bypasses mutate/postRecordHook, so a later complete
      // snapshot would otherwise never reach IndexedDB, leaving a blank
      // offline copy for a never-edited instance. Change-detected + debounced,
      // so echoes of our own pushes and unchanged remote snapshots don't churn.
      appController.requestLiveCacheSave();
      return;
    }
    if (dialogKey === forKey) {
      // A dialog is already open for this key — a later, more complete
      // snapshot (e.g. the first `/plugins/<key>/state` fired before its
      // `sketch` field was populated) must still update what's on screen,
      // not be dropped, or the dialog is stuck showing "0 effects · 0 wires".
      const cachedForDialog = await getCacheLoad(forKey);
      if (forKey !== currentKey || dialogKey !== forKey) return;
      const decision = reconcileDecision({ cached: cachedForDialog ?? null, canonical });
      dialogCanonical = canonical;
      reconcileStore.updateCanonical(forKey, canonical, decision.recommended);
      return;
    }

    const cached = await getCacheLoad(forKey);
    if (forKey !== currentKey) return;  // superseded while awaiting the cache load

    const label = instanceDisplayLabel(forKey);
    const decision = reconcileDecision({ cached: cached ?? null, canonical });
    console.log(`[live-cache] reconcile for key=${forKey}: cached=${cached ? `dirty=${cached.dirty}` : 'none'} → ${decision.action}`);
    if (decision.action === 'adopt-canonical') {
      appController.setBarrelSketch(forKey, canonical);
      appController.editSketch(forKey);
      void saveLiveCacheInstance(forKey, label, canonical, false, placementForKey(forKey));
      appController.setReadonly(false);
      resolvedKey = forKey;
      wirePusher(forKey);
      return;
    }

    // Conflict — keep showing the cached copy already on screen, stay
    // readonly, and withhold the pusher until the user decides.
    dialogKey = forKey;
    dialogCanonical = canonical;
    reconcileStore.open({
      instanceKey: forKey,
      instanceLabel: label,
      cached: cached!.sketch,
      canonical,
      recommended: decision.recommended,
      onResolve: (choice) => {
        // Apply whatever canonical was last seen while the dialog was open
        // (it may have been refreshed after the initial, possibly-incomplete
        // snapshot), not the value captured when the dialog first opened.
        const resolvedCanonical = dialogCanonical ?? canonical;
        if (choice === 'keep-cached') {
          wirePusher(forKey);
          appController.forcePushBarrelSketch();
          void saveLiveCacheInstance(forKey, label, cached!.sketch, false, placementForKey(forKey));
        } else {
          appController.setBarrelSketch(forKey, resolvedCanonical);
          appController.editSketch(forKey);
          void saveLiveCacheInstance(forKey, label, resolvedCanonical, false, placementForKey(forKey));
          wirePusher(forKey);
        }
        appController.setReadonly(false);
        resolvedKey = forKey;
        dialogKey = null;
        dialogCanonical = null;
      },
    });
  };

  /**
   * Adopt the barrel's published effect schemas. The controller derives
   * `params` / `io` from the raw schema fields so its inspector + augmenter
   * behave the same as local mode — except no WasmHost runs on the web.
   */
  const applyPluginSchemasFromSnapshot = (schemasObj: any) => {
    if (!schemasObj || typeof schemasObj !== 'object') return;
    const remotePlugins = Object.values(schemasObj)
      .filter((v: any) => v && typeof v === 'object' && typeof v.id === 'string') as any[];
    appController.setBarrelPlugins(remotePlugins);
  };

  // Telemetry values arrive as real JSON objects: BridgeServer::set_at parses
  // the native side's dump() before storing, so both the snapshot fields and
  // the patch-op values are objects. Accept a string too (defensive — older
  // paths double-encoded).
  const coerceJsonObject = (data: any): Record<string, any> | null => {
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return null; }
    }
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  };

  // Per-frame float-rail telemetry (native mirror of the local executor's
  // /sketch_state), carried in one patch op. Keyed by `currentKey` — only
  // ever called from contexts where that's guaranteed to be the right key
  // (a per-key snapshot handler already gated on it, or barrel.onPatch's
  // own currentKey-scoped path derivation below).
  const ingestRailState = (data: any) => {
    const railState = coerceJsonObject(data);
    if (!railState || !currentKey) return;
    appController.applySketchStateDiff({
      changed: { [currentKey]: railState }, removed: [],
    });
  };

  // Per-instance control.barrel_macros output values (live macro knobs).
  const ingestMacroOutputs = (data: any) => {
    const states = coerceJsonObject(data);
    if (!states) return;
    appController.applyPluginStatesDiff({ changed: states, removed: [] });
  };

  // Per-instance live set_val outputs (effect broadcasts — e.g. shape_fold's
  // autopilot_x/_y), the native mirror of the worker's pluginStates channel.
  // Keyed by bare instance_key.
  const ingestPluginStates = (data: any) => {
    const states = coerceJsonObject(data);
    if (!states) return;
    appController.applyPluginStatesDiff({ changed: states, removed: [] });
  };

  // Per-modulated-input value+band telemetry (the dest slider's gold band),
  // the native mirror of the worker's modulationData channel. The native side
  // publishes the FULL table each change, so drop instance keys that vanished
  // (a removed wire must clear its band, not pin the last one).
  const ingestModulationData = (data: any) => {
    const states = coerceJsonObject(data);
    if (!states) return;
    const removed = Object.keys(appState.local.engine.modulationData)
      .filter((k) => !(k in states));
    appController.applyModulationDataDiff({ changed: states, removed });
  };

  // Apply a full /plugins/<key>/state object (schemas first — the sketch
  // apply path backfills instance defaults from them).
  const applyInstanceState = (state: any, forKey: string) => {
    if (!state || typeof state !== 'object') return;
    applyPluginSchemasFromSnapshot(state.plugin_schemas);
    void applySketchFromSnapshot(state.sketch ?? {}, forKey);
    ingestRailState(state.sketch_state);
    ingestMacroOutputs(state.macro_outputs);
    ingestPluginStates(state.plugin_states);
    ingestModulationData(state.modulation_data);
  };

  // Parse /global/plugins into the NanoBarrel instance list for the Organize
  // tab (hoisted to a testable module function).
  const parseInstances = parseBarrelInstances;

  // (Re)wire the bridge for the selected instance key. Registered as the
  // controller's barrel select handler, and also called for the initial pick.
  const wireInstance = (key: string) => {
    const statePath = `/plugins/${key}/state`;
    if (currentKey === key && observedInstancePaths.has(statePath)) {
      // Already wired — just refetch so the editor reflects latest.
      barrel.get(statePath);
      return;
    }
    const isNewKey = currentKey !== key;
    currentKey = key;
    const sketchPath = `${statePath}/sketch`;

    if (isNewKey) {
      // A different instance than whatever was wired before (including the
      // very first wire): reset reconciliation for it and remember it for
      // next session's pre-connect guess, and as the sole tracked live
      // sketch (connected mode only ever actively edits one at a time).
      // Readonly stays/goes true until its first snapshot resolves (below)
      // — its own cache load (started here, memoized) may already be
      // running from a pre-connect guess.
      resolvedKey = null;
      dialogKey = null;
      // If a conflict dialog was still open for the PREVIOUS key (e.g. Resolume
      // dropped it and the controller auto-selected this one), abandon it —
      // resolving it now would wire a pusher / clear readonly for a key that's
      // no longer wired, leaving this instance unreconciled.
      reconcileStore.dismissForOtherKey(key);
      console.log(`[live-cache] wireInstance: new key=${key} — persisting as lastLiveInstanceKey`);
      appController.setUserSetting('lastLiveInstanceKey', key);
      appController.setLiveSketchIds([key]);
      appController.setReadonly(true);
      void getCacheLoad(key).then((record) => {
        console.log(`[live-cache] wireInstance cache load resolved: key=${key}`,
          record ? `found (dirty=${record.dirty})` : 'NOT FOUND',
          `currentKey=${currentKey}, resolvedKey=${resolvedKey}`);
        if (currentKey !== key || resolvedKey === key || !record) return;
        appController.setBarrelSketch(key, record.sketch);
        appController.editSketch(key);
        console.log(`[live-cache] wireInstance cache APPLIED for key=${key}`);
      });
    }

    // Move the active observation to this instance (precise gating).
    reconcileObservations();

    // Register snapshot handlers once per key; they no-op once superseded.
    if (!handlersWired.has(key)) {
      handlersWired.add(key);
      barrel.onSnapshot(statePath, (state) => {
        if (key !== currentKey) return;
        applyInstanceState(state, key);
      });
      barrel.onSnapshot(sketchPath, (latest) => {
        if (key !== currentKey) return;
        void applySketchFromSnapshot(latest, key);
      });
      // Telemetry-channel refetch targets (the onPatch fallback for ops too
      // deep to merge in place).
      barrel.onSnapshot(`${statePath}/sketch_state`, (data) => {
        if (key === currentKey) ingestRailState(data);
      });
      barrel.onSnapshot(`${statePath}/plugin_states`, (data) => {
        if (key === currentKey) ingestPluginStates(data);
      });
      barrel.onSnapshot(`${statePath}/modulation_data`, (data) => {
        if (key === currentKey) ingestModulationData(data);
      });
    }

    // Editor → bridge push for this instance's sketch is wired by
    // `wirePusher()` once `applySketchFromSnapshot` resolves reconciliation
    // for this key (adopt-canonical, or the conflict dialog's choice) — not
    // here, so an in-flight edit can't push a possibly-about-to-be-discarded
    // cached copy while the user is still deciding.

    // Fetch the newly selected instance's full state, and re-flush the trace
    // registrations — they haven't changed, but their preview requests now
    // route to this instance (the preview pusher below keys them by currentKey).
    barrel.get(statePath);
    traceController.requestFlush();
    console.log(`[barrel] editing instance ${key}`);
  };

  // Trace controller → bridge preview-request relay. One global pusher for
  // ALL instances: thumbnail registrations (id embeds the instance key) go to
  // their own instance's /preview_requests; everything else (edit preview,
  // chain-entry monitors) to the instance wired for editing. Instances whose
  // requests all went away get one explicit `{}` push so the native side
  // stops capturing.
  const lastPushedRequests = new Map<string, string>();
  appController.setBarrelPreviewPusher((tracePoints) => {
    // Sidechannel thumbnails route to each channel's writer instance.
    const writers: Record<string, string> = {};
    for (const [ch, info] of Object.entries(appState.local.engine.sidechannels)) {
      if (info?.writer) writers[ch] = info.writer;
    }
    const groups = groupPreviewRequests(tracePoints, currentKey, writers);

    // Every instance we push requests AT must be observed for the native
    // watched-gate — thumbnailed instances plus sidechannel writers.
    thumbKeys = new Set([
      ...tracePoints.map((tp) => instanceKeyFromThumbTraceId(tp.id))
        .filter((k): k is string => !!k),
      ...[...groups.keys()].filter((k) => k !== currentKey),
    ]);
    reconcileObservations();

    for (const key of [...lastPushedRequests.keys()]) {
      if (!groups.has(key)) groups.set(key, {});
    }
    for (const [key, requests] of groups) {
      const json = JSON.stringify(requests);
      if (lastPushedRequests.get(key) === json) continue;
      lastPushedRequests.set(key, json);
      barrel.patch(`/plugins/${key}/state`,
        [{ op: 'add', path: '/preview_requests', value: requests }]);
    }
    // A cleared instance needs no further pushes — forget it (its `{}` just
    // went out; were it kept, the sweep above would re-add it every flush).
    for (const [key, json] of [...lastPushedRequests]) {
      if (json === '{}') lastPushedRequests.delete(key);
    }
  });

  // The controller drives instance selection (Organize tab + default pick);
  // it calls back here to rewire the transport.
  appController.setBarrelSelectHandler(wireInstance);

  // The Instances tab shows the UNION of two server signals: `/global/plugins`
  // (instances Resolume has actually launched — these have live thumbnails and
  // are editable) and `/global/composition_barrel_ids` (EVERY NanoBarrel in
  // the loaded composition, launched or not). A composition-resident clip
  // Resolume hasn't launched yet has no bridge registration, so it shows as a
  // read-only `unlaunched` placeholder card; when it's later launched it
  // graduates to a live instance under the SAME key (selection preserved).
  // Both handlers below feed these two vars and recompute the merged list.
  let latestLivePlugins: BarrelInstanceInfo[] = [];
  let latestCompositionMembers: Array<{
    uuid: string; name: string; location: string; placement?: ResolumePlacement;
  }> = [];
  const recomputeInstanceList = () => {
    const liveByKey = new Set(latestLivePlugins.map((i) => i.key));
    const placeholders: BarrelInstanceInfo[] = latestCompositionMembers
      .filter((m) => !liveByKey.has(m.uuid))
      .map((m) => ({
        key: m.uuid,
        id: 'com.nano.nanobarrel',
        label: m.name || (m.uuid.split('-')[0] || m.uuid),
        resolumeLocation: m.location || undefined,
        resolumePlacement: m.placement,
        unlaunched: true,
      }));
    // Launched first, so the default selection / first-in-list pick lands on a
    // real, editable instance rather than a read-only placeholder.
    appController.setBarrelInstances([...latestLivePlugins, ...placeholders]);
  };

  // Maintain the live instance list from /global/plugins. Deliberately does
  // NOT prune `liveCache` rows whose key drops out of this list: instances
  // unregister one at a time (observed during a Resolume shutdown: 4 → 2 → 1
  // → 0 over several publishes before the socket even closes), so an absent
  // key is not reliable evidence the instance is gone for good — treating it
  // as such deleted the offline safety net at exactly the moment (Resolume
  // closing) it exists to protect against. Stale rows just sit in IndexedDB
  // unused; a future manual "forget this instance" action would be a safer
  // place for cleanup than an automatic one keyed off this snapshot.
  barrel.onSnapshot('/global/plugins', (arr) => {
    (window as any).__barrelInstances = arr;
    const instances = parseInstances(arr);
    console.log(`[live-cache] /global/plugins: ${instances.length} instance(s): [${instances.map(i => i.key).join(', ')}]`);
    latestLivePlugins = instances;
    recomputeInstanceList();
    const liveKeys = new Set(instances.map((inst) => inst.key));
    cancelPendingPassiveCache(liveKeys);
    for (const inst of instances) cachePassiveInstanceOnceDebounced(inst.key);
  });

  // The FULL composition-known NanoBarrel set — launched or not (native's
  // InstanceLocator structurally scans the composition independent of plugin
  // registration; see nano_barrel_plugin.mm's ensureRegistered doc). Each
  // entry is `{uuid, name, location}` so an unlaunched placeholder card gets a
  // real Resolume-derived name without a live plugin registration. Two uses:
  //   1. Placeholder cards for unlaunched composition members (recompute above).
  //   2. Persisting `lastCompositionBarrelIds` — the authoritative member set
  //      `bootLiveOffline` filters its instance list to, so instances from a
  //      composition you've switched away from stop piling up offline.
  // Tolerates the legacy bare-string[] payload from a not-yet-redeployed
  // native barrel (uuid only, no name) so scoping still engages.
  barrel.onSnapshot('/global/composition_barrel_ids', (arr) => {
    const members = Array.isArray(arr)
      ? arr.flatMap((m: any) => {
          if (typeof m === 'string') return [{ uuid: m, name: '', location: '' }];
          if (m && typeof m.uuid === 'string') return [{
            uuid: m.uuid,
            name: typeof m.name === 'string' ? m.name : '',
            location: typeof m.location === 'string' ? m.location : '',
            placement: parseResolumePlacement(m.placement),
          }];
          return [];
        })
      : [];
    latestCompositionMembers = members;
    const ids = members.map((m) => m.uuid);
    // Persist the member set for offline scoping, but only on a real change,
    // and NEVER overwrite a known set with an empty one: a transient `[]`
    // (mid-reload, or the composition momentarily reporting no barrels) would
    // otherwise wipe scoping and re-show every cached instance — the same
    // class of bug as the reverted liveCache auto-prune.
    const prevIds = appState.local.userSettings.lastCompositionBarrelIds;
    const changed = ids.length !== prevIds.length || !ids.every((id) => prevIds.includes(id));
    if (changed && ids.length > 0) {
      appController.setUserSetting('lastCompositionBarrelIds', ids);
      console.log(`[live-cache] composition members (${ids.length}): [${ids.join(', ')}]`);
    }
    recomputeInstanceList();
  });
  barrel.get('/global/composition_barrel_ids');
  barrel.observe('/global/composition_barrel_ids');

  // Sidechannel-bus channel metadata (channel → writer plugin key + size),
  // published by the native runtime only when it changes. Feeds the same
  // observable the playground's worker push does, so the channel-labeling UI
  // is mode-agnostic.
  const ingestSidechannels = (data: any) => {
    if (!data || typeof data !== 'object') return;
    appController.setSidechannels(data);
    // Channel metadata (esp. WRITER identity) steers sidechannel preview
    // routing — re-flush so open thumbnails follow a writer change. Metadata
    // pushes are change-gated upstream, so this is not per-frame traffic.
    traceController.requestFlush();
  };
  barrel.onSnapshot('/global/sidechannels', ingestSidechannels);

  // Scalar (value) sidechannels — their own channel namespace, published under
  // the same version gate as the texture channels above. Metadata only (writer),
  // so there is no preview routing to re-flush.
  const ingestScalarSidechannels = (data: any) => {
    if (!data || typeof data !== 'object') return;
    appController.setScalarSidechannels(data);
  };
  barrel.onSnapshot('/global/sidechannels_scalar', ingestScalarSidechannels);

  // Channel → registered marker clips (from CompositionCache), published only
  // when the map changes. Feeds the Instances-tab "Trigger Channels" grid.
  const ingestTriggerChannels = (data: any) => {
    if (!data || typeof data !== 'object') return;
    appController.setTriggerChannels(data);
  };
  barrel.onSnapshot('/global/channels', ingestTriggerChannels);

  // Per-clip connected state (keyed "<layer>:<clip>"), published only on change.
  // Drives the Instances-tab clip cards' play/stop button.
  const ingestClipStates = (data: any) => {
    if (!data || typeof data !== 'object') return;
    appController.setClipStates(data);
  };
  barrel.onSnapshot('/global/clip_states', ingestClipStates);

  // Clip control: the web triggers/disconnects Resolume clips and reassigns
  // trigger channels through the barrel's WS action channel. Fire-and-forget —
  // the result surfaces as a /global/channels + /global/clip_states patch.
  appController.setBarrelClipCommander((cmd) => {
    if (cmd.kind === 'trigger') {
      barrel.triggerClip({ key: cmd.key, layer: cmd.layer, clip: cmd.clip }, cmd.on);
    } else {
      barrel.reassignChannel(cmd.key, cmd.channel);
    }
  });
  // NOTE: marker instance-state observation (the native key_observed gate) is
  // handled by the single-owner reconcileObservations() above — each Trigger
  // Channels thumbnail is an `inst_thumb:<markerKey>` trace point, so its key
  // lands in `thumbKeys` and gets observed like any other thumbnail. Do NOT add
  // a second observer here: the subscription set isn't refcounted, so a rival
  // reconciler clobbers it into a stuck not-observed state.

  // -- Preview lanes (binary plane) --------------------------------------
  // Pixel frames never ride the main bridge socket: the barrel advertises N
  // auxiliary WS ports in /global/preview_transport and stripes each NBPV
  // frame across them as NBPC chunks. Reconcile a lane client per advertised
  // port (WsBridgeClient reused purely for its reconnect/backoff + arraybuffer
  // binary delivery — lanes carry no JSON protocol), reassemble, and feed the
  // controller's existing NBPV ingest.
  const laneClients = new Map<number, WsBridgeClient>();
  const reassembler = new NbpcReassembler();
  const onLaneFrame = (buf: ArrayBuffer) => {
    const full = reassembler.ingest(buf);
    if (full) void appController.ingestBarrelPreviewFrame(full);
  };
  const reconcileLanes = (doc: any) => {
    const desired = new Set(previewTransportPorts(doc));
    for (const port of desired) {
      if (laneClients.has(port)) continue;
      const lane = new WsBridgeClient(laneUrl(url, port));
      lane.onBinaryFrame = onLaneFrame;
      laneClients.set(port, lane);
    }
    for (const [port, lane] of [...laneClients]) {
      if (!desired.has(port)) {
        lane.dispose();
        laneClients.delete(port);
      }
    }
    if (desired.size > 0) {
      console.log(`[barrel] preview lanes: ${[...desired].join(', ')}`);
    }
  };
  barrel.onSnapshot('/global/preview_transport', reconcileLanes);

  // Binary frames on the MAIN socket only occur with an old server (pre-lane
  // protocol, whole NBPV frames) — keep decoding them for back-compat.
  barrel.onBinaryFrame = (buf) => {
    void appController.ingestBarrelPreviewFrame(buf);
  };

  // Telemetry publishes go through the doc-diffing set_at, so AFTER the first
  // publish the ops arrive FINE-GRAINED (e.g. .../plugin_states/sf@0/autopilot_x
  // per frame under autopilot) — an exact-path match would only ever see the
  // initial whole-object add. Merge instance-level and field-level ops into
  // the live pluginStates map; anything deeper is refetched wholesale.
  const applyInstanceStatesLeaf = (relPath: string, value: any): boolean => {
    const parts = relPath.slice(1).split('/');   // '/<ik>' or '/<ik>/<field>'
    const ik = parts[0];
    if (!ik) return false;
    if (parts.length === 1) {
      const obj = coerceJsonObject(value);
      if (obj) appController.applyPluginStatesDiff({ changed: { [ik]: obj }, removed: [] });
      return !!obj;
    }
    if (parts.length !== 2) return false;        // nested value — refetch instead
    const cur = (appState.local.engine.pluginStates as Record<string, any>)[ik];
    appController.applyPluginStatesDiff({
      changed: { [ik]: { ...(cur ?? {}), [parts[1]]: value } }, removed: [],
    });
    return true;
  };
  // Modulation-band leaf update. The band record is 3 levels deep
  // (/<ik>/<field>/{value,min,max,neutral}) and `value` changes per frame, so
  // ops arrive at every depth. Merge in place; anything odd → refetch.
  const applyModulationLeaf = (relPath: string, value: any): boolean => {
    const parts = relPath.slice(1).split('/');
    const ik = parts[0];
    if (!ik) return false;
    const md = appState.local.engine.modulationData as Record<string, any>;
    if (parts.length === 1) {
      const obj = coerceJsonObject(value);
      if (obj) appController.applyModulationDataDiff({ changed: { [ik]: obj }, removed: [] });
      return !!obj;
    }
    if (parts.length === 2) {
      const obj = coerceJsonObject(value);
      if (!obj) return false;
      appController.applyModulationDataDiff({
        changed: { [ik]: { ...(md[ik] ?? {}), [parts[1]]: obj } }, removed: [],
      });
      return true;
    }
    if (parts.length === 3 && typeof value === 'number') {
      const cur = md[ik]?.[parts[1]];
      if (!cur) return false;
      appController.applyModulationDataDiff({
        changed: { [ik]: { ...md[ik], [parts[1]]: { ...cur, [parts[2]]: value } } }, removed: [],
      });
      return true;
    }
    return false;
  };
  // Rail leaf update: /sketch_state/<railId>. Rails live under the
  // currently-wired instance's own entry in engine.sketchState.
  const applyRailLeaf = (relPath: string, value: any): boolean => {
    const parts = relPath.slice(1).split('/');
    if (parts.length !== 1 || !parts[0] || !currentKey) return false;
    const cur = (appState.local.engine.sketchState as Record<string, any>)[currentKey];
    appController.applySketchStateDiff({
      changed: { [currentKey]: { ...(cur ?? {}), [parts[0]]: value } }, removed: [],
    });
    return true;
  };

  barrel.onPatch((ops) => {
    let globalTouched = false;
    const statePath = currentKey ? `/plugins/${currentKey}/state` : null;
    const sketchPath = statePath ? `${statePath}/sketch` : null;
    const sketchStatePath = statePath ? `${statePath}/sketch_state` : null;
    const macroOutputsPath = statePath ? `${statePath}/macro_outputs` : null;
    const pluginStatesPath = statePath ? `${statePath}/plugin_states` : null;
    const modulationDataPath = statePath ? `${statePath}/modulation_data` : null;
    let sketchTouched = false;
    let railRefetch = false;
    let pluginStatesRefetch = false;
    let modulationRefetch = false;
    for (const op of ops) {
      const p = typeof op?.path === 'string' ? op.path : '';
      if (p === '/global/plugins' || p.startsWith('/global/plugins')) {
        globalTouched = true;          // instance added/removed
      } else if (p === '/global/sidechannels') {
        ingestSidechannels(op.value);  // whole-object replace per publish
      } else if (p === '/global/sidechannels_scalar') {
        ingestScalarSidechannels(op.value);  // whole-object replace per publish
      } else if (p === '/global/channels') {
        ingestTriggerChannels(op.value);  // whole-object replace per publish
      } else if (p === '/global/clip_states') {
        ingestClipStates(op.value);       // whole-object replace per publish
      } else if (p.startsWith('/global/clip_states')) {
        barrel.get('/global/clip_states'); // partial patch — refetch whole
      } else if (p === '/global/preview_transport') {
        reconcileLanes(op.value);      // published whole on (re)start
      } else if (p.startsWith('/global/preview_transport/')) {
        barrel.get('/global/preview_transport');  // partial patch — refetch
      } else if (sketchPath && (p === sketchPath || p.startsWith(sketchPath + '/'))) {
        sketchTouched = true;
      } else if (p === sketchStatePath) {
        ingestRailState(op.value);
      } else if (sketchStatePath && p.startsWith(sketchStatePath + '/')) {
        if (!applyRailLeaf(p.slice(sketchStatePath.length), op.value)) railRefetch = true;
      } else if (p === macroOutputsPath) {
        ingestMacroOutputs(op.value);
      } else if (macroOutputsPath && p.startsWith(macroOutputsPath + '/')) {
        if (!applyInstanceStatesLeaf(p.slice(macroOutputsPath.length), op.value))
          pluginStatesRefetch = true;
      } else if (p === pluginStatesPath) {
        ingestPluginStates(op.value);
      } else if (pluginStatesPath && p.startsWith(pluginStatesPath + '/')) {
        if (!applyInstanceStatesLeaf(p.slice(pluginStatesPath.length), op.value))
          pluginStatesRefetch = true;
      } else if (p === modulationDataPath) {
        ingestModulationData(op.value);
      } else if (modulationDataPath && p.startsWith(modulationDataPath + '/')) {
        if (!applyModulationLeaf(p.slice(modulationDataPath.length), op.value))
          modulationRefetch = true;
      }
    }
    if (globalTouched) barrel.get('/global/plugins');  // refresh the list
    if (sketchTouched && sketchPath) barrel.get(sketchPath);
    if (railRefetch && sketchStatePath) barrel.get(sketchStatePath);
    if (pluginStatesRefetch && pluginStatesPath) barrel.get(pluginStatesPath);
    if (modulationRefetch && modulationDataPath) barrel.get(modulationDataPath);
  });

  const subscribe = () => {
    barrel.get('/global/plugins');
    barrel.observe('/global/plugins');
    barrel.get('/global/sidechannels');
    barrel.observe('/global/sidechannels');
    barrel.get('/global/sidechannels_scalar');
    barrel.observe('/global/sidechannels_scalar');
    barrel.get('/global/channels');
    barrel.observe('/global/channels');
    barrel.get('/global/clip_states');
    barrel.observe('/global/clip_states');
    barrel.get('/global/preview_transport');
    barrel.observe('/global/preview_transport');
    // If a selection already exists (reconnect), rewire it.
    const sel = appController.getSelectedBarrelKey();
    if (sel) wireInstance(sel);
  };
  // Surface connection health for the shell's "switch to Playground?" offer.
  // MIDI bridge mirror: the device library + on-screen simulation overrides
  // flow to the native CoreMIDI host over whitelisted /global/midi_* writes.
  // bindBridge re-pushes the library, so re-binding on every (re)open keeps
  // a restarted barrel seeded.
  //
  // ADOPT-DON'T-CLOBBER guard: binding pushes the WHOLE library, replacing
  // the server copy — an editor opened in a fresh browser profile (empty
  // IndexedDB) would wipe /global/midi_devices, the barrel rekeys hardware
  // within ~1s AND persists the empty library to its sidecar, and every
  // midi: wire in the composition goes dead (the show-night failure). So an
  // editor with a strictly EMPTY library first reads the server copy and
  // IMPORTS it instead of pushing. (A library holding only deleted rows is
  // deliberate user state — it still pushes; ghost cards cover repair.)
  const midiLibWaiters: ((v: unknown) => void)[] = [];
  barrel.onSnapshot('/global/midi_devices', (data) => {
    const ws = midiLibWaiters.splice(0);
    for (const w of ws) w(data);
  });
  const fetchServerMidiLibrary = () => new Promise<unknown>((resolve) => {
    midiLibWaiters.push(resolve);
    barrel.get('/global/midi_devices');
    setTimeout(() => {
      const i = midiLibWaiters.indexOf(resolve);
      if (i >= 0) { midiLibWaiters.splice(i, 1); resolve(null); }
    }, 3000);
  });
  const bindMidiBridge = async () => {
    if (midiController.libraryIsEmpty()) {
      const server = await fetchServerMidiLibrary();
      const imported = midiController.importLibrary(server);
      if (imported > 0) {
        console.log(`[midi] adopted ${imported} device(s) from the barrel — local library was empty`);
      }
    }
    midiController.bindBridge({
      library: instances => barrel.setGlobal('/global/midi_devices', instances),
      sim: table => barrel.setGlobal('/global/midi_sim', table),
    });
  };
  void bindMidiBridge();

  barrel.onOpen = () => {
    appController.setBarrelConnectionState('open');
    subscribe();
    void bindMidiBridge();
  };
  barrel.onClose = () => appController.setBarrelConnectionState('closed');
  if (barrel.isOpen) {
    appController.setBarrelConnectionState('open');
    subscribe();
  }

  let storedSelectedKey: string | null = null;
  try { storedSelectedKey = localStorage.getItem('barrel.selectedKey'); } catch { /* ignore */ }
  console.log(`[barrel] connecting ${url} (window.__barrel / __barrelInstances), localStorage barrel.selectedKey=${storedSelectedKey ?? '(none)'}`);
}

/**
 * Force the remote state.sketch blob into a minimally-valid Sketch
 * shape. The barrel's persisted state is just opaque JSON from the
 * plugin's perspective — early bring-up sometimes leaves arbitrary
 * payloads in there (eg the `{hello:'world'}` round-trip test) that
 * would crash the edit tab's chain reads. We bridge the gap by filling
 * in defaults for any missing fields; the editor then renders an empty
 * sketch instead of throwing.
 */
function coerceSketch(remote: any): Sketch {
  const r = (remote && typeof remote === 'object' && !Array.isArray(remote))
              ? remote
              : {};
  const draft: Sketch = {
    anchor: typeof r.anchor === 'string' ? r.anchor : null,
    // Accept either the canonical `chain` or any legacy `columns` blob;
    // normalizeSketchChains flattens whichever is present into `chain`.
    chain: Array.isArray(r.chain) ? r.chain : undefined,
    wires: Array.isArray(r.wires) ? r.wires : undefined,
    instances: (r.instances && typeof r.instances === 'object' && !Array.isArray(r.instances))
                  ? r.instances
                  : undefined,
    // Must survive the echo of our own push: applySketchFromSnapshot adopts
    // every snapshot through this coercion, so a field dropped here snaps the
    // UI back to defaults while the barrel keeps rendering with it (and the
    // "reset to default" click then produces zero immer patches — nothing is
    // ever pushed to undo it). normalizeSketchChains sanitizes the value.
    outputFormat: (r.outputFormat && typeof r.outputFormat === 'object' && !Array.isArray(r.outputFormat))
                  ? r.outputFormat
                  : undefined,
    // Carried through opaquely — round-trips via the barrel and Resolume's
    // own composition-file persistence unchanged (confirmed: neither treats
    // `sketch` as anything but generic JSON). Used only by the live-mode
    // reconciliation dialog's recency display (state/live-reconcile.ts).
    lastModified: typeof r.lastModified === 'number' ? r.lastModified : undefined,
  };
  // Carry any legacy multi-column blob through untyped so normalize can flatten it.
  if (!draft.chain && Array.isArray(r.columns)) (draft as any).columns = r.columns;
  // Strip any legacy explicit I/O chain entries — texture input/output
  // are implicit in the current model — and flatten to the single `chain`.
  return normalizeSketchChains(draft);
}
