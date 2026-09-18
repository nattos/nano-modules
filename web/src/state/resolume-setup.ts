/**
 * Live status behind the Settings page's "Set up Resolume" checklist.
 *
 * The checklist has to work from EVERY surface, including the ones that have
 * no barrel connection at all (Effect Dev, Playground, Live-offline) — that is
 * precisely when someone reads it. So this keeps its own small WebSocket to
 * the shared NanoBarrel server rather than borrowing Live's client, and asks
 * for three things:
 *
 *   /global/host                  where the plugin + server are, and whether
 *                                 Resolume's own webserver answered
 *   /global/plugins               barrel instances that have actually rendered
 *   /global/composition_barrel_ids  every NanoBarrel in the composition,
 *                                 launched or not (needs Resolume's webserver)
 *
 * Those last two differ in exactly the way the checklist needs to explain: an
 * instance on a clip or a layer does not register until that content plays, so
 * "in the composition" and "alive" are separate checkmarks.
 *
 * Not `WsBridgeClient`: its backoff caps at 30 s and it logs every connect and
 * disconnect, neither of which suits something that sits open on a settings
 * page while the user is starting and stopping Resolume. This retries quietly
 * on a fixed interval instead.
 *
 * Ref-counted — <app-settings> starts it on connect and stops it on
 * disconnect, so nothing is open while the page isn't being looked at.
 */

import { observable, runInAction } from 'mobx';
import { appState } from './app-state';

/** `/global/host/plugin` — written once by the FFGL plugin at load. */
export interface HostPluginInfo {
  /** Absolute path of the `.bundle` Resolume actually loaded. */
  path?: string;
  /** The sibling `libbridge_server.dylib` it dlopen'd. */
  dylib?: string;
  /** Shared resource root it resolved — the effects + fonts it will run. */
  resourceRoot?: string;
  wasmDir?: string;
  id?: string;
}

/** `/global/host/server` — republished by the dylib on every transition. */
export interface HostServerInfo {
  path?: string;
  resourceRoot?: string;
  bridgePort?: number;
  /** e.g. `ws://127.0.0.1:8080/api/v1` — Resolume's own API endpoint. */
  resolumeUrl?: string;
  /** True while the dylib's client to Resolume's webserver is open. */
  resolumeConnected?: boolean;
}

export interface ResolumeSetupState {
  /** Health of OUR probe socket to the barrel (port 8081 by default). */
  probe: 'idle' | 'connecting' | 'open' | 'closed';
  plugin: HostPluginInfo | null;
  server: HostServerInfo | null;
  /** Barrel instances that have registered — i.e. rendered at least once. */
  liveInstances: number;
  /** NanoBarrels found in the composition, launched or not. Only ever
   *  non-zero while Resolume's webserver is on (it feeds the scan). */
  compositionInstances: number;
}

export const resolumeSetup = observable.object<ResolumeSetupState>({
  probe: 'idle',
  plugin: null,
  server: null,
  liveInstances: 0,
  compositionInstances: 0,
});

const RETRY_MS = 2000;

let refs = 0;
let ws: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

function countBarrels(plugins: unknown): number {
  if (!Array.isArray(plugins)) return 0;
  return plugins.filter((p: any) => p?.metadata?.id === 'com.nano.nanobarrel').length;
}

function ingest(path: string, data: any) {
  runInAction(() => {
    if (path === '/global/host') {
      resolumeSetup.plugin = data?.plugin ?? null;
      resolumeSetup.server = data?.server ?? null;
    } else if (path === '/global/plugins') {
      resolumeSetup.liveInstances = countBarrels(data);
    } else if (path === '/global/composition_barrel_ids') {
      resolumeSetup.compositionInstances = Array.isArray(data) ? data.length : 0;
    }
  });
}

const WATCHED = ['/global/host', '/global/plugins', '/global/composition_barrel_ids'];

function scheduleRetry() {
  if (stopped || retryTimer != null) return;
  retryTimer = setTimeout(() => { retryTimer = null; open(); }, RETRY_MS);
}

function open() {
  if (stopped || ws) return;
  const url = appState.local.barrelUrl;
  let sock: WebSocket;
  try { sock = new WebSocket(url); }
  catch { runInAction(() => { resolumeSetup.probe = 'closed'; }); scheduleRetry(); return; }
  ws = sock;
  runInAction(() => { resolumeSetup.probe = 'connecting'; });

  sock.onopen = () => {
    runInAction(() => { resolumeSetup.probe = 'open'; });
    for (const p of WATCHED) {
      sock.send(JSON.stringify({ action: 'observe', path: p }));
      sock.send(JSON.stringify({ action: 'get', path: p }));
    }
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let msg: any;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'snapshot') {
      ingest(msg.path, msg.data);
    } else if (msg.type === 'patch' && Array.isArray(msg.ops)) {
      // Patches arrive as ops against arbitrary sub-paths; re-fetching the
      // whole (tiny) doc is simpler than applying them, and these change on
      // the order of once per user action, not per frame.
      const touched = new Set<string>();
      for (const op of msg.ops) {
        const p = String(op?.path ?? '');
        for (const w of WATCHED) if (p === w || p.startsWith(w + '/')) touched.add(w);
      }
      for (const w of touched) sock.send(JSON.stringify({ action: 'get', path: w }));
    }
  };
  const down = () => {
    if (ws !== sock) return;
    ws = null;
    runInAction(() => {
      resolumeSetup.probe = 'closed';
      // Everything below is knowledge the server held. Keeping a stale plugin
      // path checkmarked after Resolume quits would be a lie.
      resolumeSetup.plugin = null;
      resolumeSetup.server = null;
      resolumeSetup.liveInstances = 0;
      resolumeSetup.compositionInstances = 0;
    });
    scheduleRetry();
  };
  sock.onclose = down;
  sock.onerror = down;
}

/** Start watching (ref-counted). Returns the matching stop function. */
export function watchResolumeSetup(): () => void {
  refs++;
  if (refs === 1) { stopped = false; open(); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--refs > 0) return;
    stopped = true;
    if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
    if (ws) { const s = ws; ws = null; try { s.close(); } catch { /* ignore */ } }
    runInAction(() => { resolumeSetup.probe = 'idle'; });
  };
}

/** Test seam: drop all state and connections, whatever the ref count. */
export function resetResolumeSetup() {
  refs = 0;
  stopped = true;
  if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
  if (ws) { const s = ws; ws = null; try { s.close(); } catch { /* ignore */ } }
  runInAction(() => {
    resolumeSetup.probe = 'idle';
    resolumeSetup.plugin = null;
    resolumeSetup.server = null;
    resolumeSetup.liveInstances = 0;
    resolumeSetup.compositionInstances = 0;
  });
}

// ── The checklist's decision logic ──────────────────────────────────────────
//
// Pure, so the four "is this step done?" answers can be pinned without a
// WebSocket, a barrel or a GPU. The COPY lives in <app-settings> — this only
// decides state, plus the one line of it that has to quote live values.

export type SetupStepId = 'plugin' | 'webserver' | 'instance' | 'connect';
export type SetupStepState = 'ok' | 'pending' | 'warn';

export interface SetupStepStatus {
  state: SetupStepState;
  /** Current-state note, quoting live values. '' when there is nothing to add. */
  detail: string;
}

export interface SetupInput {
  /** The Resolume Remote kill-switch. Off means we never even probe. */
  remoteEnabled: boolean;
  probe: ResolumeSetupState['probe'];
  plugin: HostPluginInfo | null;
  server: HostServerInfo | null;
  liveInstances: number;
  compositionInstances: number;
  /** This app's own resource root, or null in a browser (nothing to compare). */
  appRoot: string | null;
  barrelUrl: string;
  barrelMode: boolean;
  barrelConnection: 'connecting' | 'open' | 'closed';
}

/** Port out of `ws://127.0.0.1:8080/api/v1`, or '' if it can't be read. */
export function resolumeApiPort(url: string | undefined): string {
  if (!url) return '';
  try { return new URL(url).port || ''; } catch { return ''; }
}

/** Trailing separators off, so two spellings of one directory compare equal. */
function normalizeRoot(p: string | null | undefined): string {
  if (!p) return '';
  let s = p.trim().replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export function setupStatuses(i: SetupInput): Record<SetupStepId, SetupStepStatus> {
  const serverUp = i.probe === 'open';
  const pluginPath = i.plugin?.path ?? '';

  // 1. Is a NanoBarrel plug-in loaded, and is it OURS?
  //
  // A mismatched resourceRoot is the one thing here that's worth shouting
  // about: the plug-in loads fine, renders fine, and silently runs a different
  // build of every effect than the app you're editing in. Comparing the ROOT
  // rather than the bundle path is deliberate — a plug-in copied out of the
  // app still resolves back to the app's resources through the install record,
  // and that configuration is correct.
  let plugin: SetupStepStatus;
  if (!serverUp || !pluginPath) {
    plugin = {
      state: 'pending',
      detail: i.remoteEnabled
        ? `Nothing answering on ${i.barrelUrl}.`
        : 'Resolume Remote is off.',
    };
  } else {
    const appRoot = normalizeRoot(i.appRoot);
    const pluginRoot = normalizeRoot(i.plugin?.resourceRoot);
    if (appRoot && pluginRoot && appRoot !== pluginRoot) {
      plugin = {
        state: 'warn',
        detail: `Loaded, but it runs effects from ${pluginRoot} — this app ships ${appRoot}. ` +
                'Point Resolume at the plug-in inside this app, or reinstall it.',
      };
    } else if (appRoot && !pluginRoot) {
      plugin = { state: 'warn', detail: `Loaded from ${pluginPath}, but it found no effect bundles at all.` };
    } else {
      plugin = { state: 'ok', detail: pluginPath };
    }
  }

  // 2. Resolume's own webserver. Off is survivable — rendering never touches
  //    it — but everything structural goes quiet, so it earns a checkmark.
  let webserver: SetupStepStatus;
  const apiPort = resolumeApiPort(i.server?.resolumeUrl) || '8080';
  if (!serverUp) {
    webserver = { state: 'pending', detail: '' };
  } else if (i.server?.resolumeConnected) {
    webserver = { state: 'ok', detail: `Connected on port ${apiPort}.` };
  } else {
    webserver = {
      state: 'pending',
      detail: `NanoBarrel is loaded, but nothing answered on port ${apiPort}.`,
    };
  }

  // 3. An instance in the composition. The gap between "in the composition"
  //    and "alive" IS the trap: a barrel on a clip or a layer doesn't register
  //    until that content actually plays.
  let instance: SetupStepStatus;
  if (i.liveInstances > 0) {
    instance = {
      state: 'ok',
      detail: `${i.liveInstances} instance${i.liveInstances === 1 ? '' : 's'} running.`,
    };
  } else if (i.compositionInstances > 0) {
    instance = {
      state: 'pending',
      detail: `${i.compositionInstances} in the composition, none playing yet — ` +
              'trigger the clip, or a clip on that layer.',
    };
  } else {
    instance = { state: 'pending', detail: '' };
  }

  // 4. This editor bound to it.
  let connect: SetupStepStatus;
  if (i.barrelMode && i.barrelConnection === 'open') {
    connect = { state: 'ok', detail: 'Editing the live composition.' };
  } else if (i.barrelMode) {
    connect = { state: 'pending', detail: 'In Live mode, still connecting.' };
  } else {
    connect = { state: 'pending', detail: 'Not in Live mode.' };
  }

  return { plugin, webserver, instance, connect };
}
