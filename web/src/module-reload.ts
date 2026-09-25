/**
 * Asking the FFGL plugin's shared server to reload its effect bundles.
 *
 * The plugin's runtime lives as long as Resolume does, and it does not watch
 * the disk: the app does (wasm-hmr-client.ts, electron/main.cjs, the vite
 * plugin), so the app is who notices a rebuilt bundle or a module folder
 * checked in Settings. It then OFFERS to pass that on — a snackbar — and
 * Settings → Resolume has the same thing as a button.
 *
 * The request is `{action:"reload_modules"}` on the bridge. The server serves
 * it on the next frame any NanoBarrel renders and publishes what happened at
 * `/global/modules_reload` (native/src/bridge/barrel_runtime.cpp). This keeps
 * its own short-lived socket, so it works from every surface — Remote Control,
 * or an editor that has only DETECTED the barrel.
 */

import { appState } from './state/app-state';
import { snackbars } from './widgets/snackbars';
import { bundleLabel } from './effect-bundles';

/** `/global/modules_reload` — one reload's outcome. */
export interface ModuleReloadResult {
  seq: number;
  ms?: number;
  reloaded: { id: string; path: string; from: string; effects?: number }[];
  added: { id: string; path: string; effects?: number }[];
  removed: { id: string; path: string }[];
  failed: { id: string; path: string; error?: string }[];
  unchanged: number;
}

/** What asking produced: the server's answer, or why there isn't one. */
export type ModuleReloadOutcome =
  | { kind: 'done'; result: ModuleReloadResult }
  | { kind: 'unreachable' }
  /** Sent, but no frame rendered to serve it before we stopped waiting. It
   *  still happens on the next frame — nothing is lost. */
  | { kind: 'queued' };

/** One line for a snackbar or the Settings page. */
export function describeReload(o: ModuleReloadOutcome): string {
  if (o.kind === 'unreachable') return "Couldn't reach Resolume's NanoBarrel server.";
  if (o.kind === 'queued') {
    return 'Resolume will reload the modules on the next frame a NanoBarrel renders.';
  }
  const r = o.result;
  const names = (rows: { id: string }[]) => rows.map((x) => bundleLabel(x.id)).join(', ');
  const parts: string[] = [];
  if (r.reloaded.length) parts.push(`reloaded ${names(r.reloaded)}`);
  if (r.added.length) parts.push(`added ${names(r.added)}`);
  if (r.removed.length) parts.push(`removed ${names(r.removed)}`);
  if (r.failed.length) parts.push(`couldn't load ${names(r.failed)} (kept the old copy)`);
  if (!parts.length) return 'Resolume already has the current modules — nothing changed.';
  const s = parts.join('; ');
  return `Resolume ${s}.`;
}

/** A bundle the app and the plugin resolve differently. */
export interface ModuleDrift {
  id: string;
  /** The copy the app uses, or null when the app has none. */
  app: string | null;
  /** The copy the plugin runs, or null when it has none. */
  resolume: string | null;
}

/**
 * Where the plugin runs a different copy of a bundle than the app — a module
 * folder checked since Resolume loaded, say. Only bundles that come from a
 * module folder on either side count: the built-in ones live in each host's
 * own resource root, which are different directories in a dev tree and say
 * nothing about staleness. Paths compare with separators normalized.
 */
export function moduleDrift(
  app: { id: string; path?: string; origin: string }[],
  resolume: { id: string; path: string; origin: string }[],
): ModuleDrift[] {
  const norm = (p: string | undefined) => (p ?? '').replace(/\\/g, '/');
  const ids = new Set([...app, ...resolume].filter((b) => b.origin !== 'builtin').map((b) => b.id));
  const out: ModuleDrift[] = [];
  for (const id of ids) {
    const a = app.find((b) => b.id === id);
    const r = resolume.find((b) => b.id === id);
    if (a && r && a.origin === 'builtin' && r.origin === 'builtin') continue;
    if (a && r && norm(a.path) === norm(r.path)) continue;
    out.push({ id, app: a ? (a.path ?? a.id) : null, resolume: r ? r.path : null });
  }
  return out;
}

/** The shared server is there to ask: Remote Control connected to it, or
 *  another surface's probe found it — and Resolume Remote is on. */
export function barrelReachable(): boolean {
  const l = appState.local;
  if (!l.userSettings.barrelRemoteEnabled) return false;
  return (l.barrelMode && l.barrelConnection === 'open') || l.barrelDetected;
}

/**
 * Send `reload_modules` and wait for its outcome. `timeoutMs` bounds the wait
 * for a frame to serve it (a paused composition renders nothing).
 */
export function requestBarrelModuleReload(
  url: string = appState.local.barrelUrl,
  timeoutMs = 8000,
): Promise<ModuleReloadOutcome> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { resolve({ kind: 'unreachable' }); return; }
    let baseline: number | null = null;
    let sent = false;
    let settled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    const finish = (o: ModuleReloadOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (poll) clearInterval(poll);
      try { ws.close(); } catch { /* ignore */ }
      resolve(o);
    };
    const deadline = setTimeout(() => finish(sent ? { kind: 'queued' } : { kind: 'unreachable' }),
      timeoutMs);
    const get = () => ws.send(JSON.stringify({ action: 'get', path: '/global/modules_reload' }));
    ws.onopen = () => get();
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'snapshot' || msg.path !== '/global/modules_reload') return;
      const seq = typeof msg.data?.seq === 'number' ? msg.data.seq : 0;
      if (!sent) {
        // Anything newer than what was there before we asked is our answer.
        baseline = seq;
        sent = true;
        ws.send(JSON.stringify({ action: 'reload_modules' }));
        poll = setInterval(get, 150);
      } else if (baseline !== null && seq > baseline) {
        finish({ kind: 'done', result: msg.data as ModuleReloadResult });
      }
    };
    ws.onerror = () => finish(sent ? { kind: 'queued' } : { kind: 'unreachable' });
    ws.onclose = () => finish(sent ? { kind: 'queued' } : { kind: 'unreachable' });
  });
}

/** Ask, then say how it went. */
export async function reloadBarrelModulesAndReport(): Promise<ModuleReloadOutcome> {
  const outcome = await requestBarrelModuleReload();
  snackbars.show({ message: describeReload(outcome), dedupeKey: 'module-reload' });
  return outcome;
}

/** Bundles named by offers still on screen — a build_all rebuilds several. */
const offered = new Set<string>();
let lastOfferAt = 0;
const OFFER_WINDOW_MS = 60_000;

/**
 * Offer to reload Resolume's modules, when there is a Resolume to reload.
 * `what` is a bundle that was rebuilt ("Nano") or, with `rebuilt` false, a
 * whole sentence ("Module folders changed"). Offers replace each other, and a
 * burst of rebuilt bundles is named in one.
 */
export function offerBarrelModuleReload(what: string, rebuilt = true) {
  if (!barrelReachable()) return;
  const now = Date.now();
  if (now - lastOfferAt > OFFER_WINDOW_MS) offered.clear();
  lastOfferAt = now;
  let head = what;
  if (rebuilt) {
    offered.add(what);
    const names = [...offered];
    head = `${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} rebuilt`;
  }
  const done = () => { offered.clear(); };
  snackbars.show({
    message: `${head}. Resolume is still running the modules it loaded.`,
    timeoutMs: 0,
    dedupeKey: 'module-reload',
    actions: [
      { label: 'Reload in Resolume', run: () => { done(); void reloadBarrelModulesAndReport(); } },
      { label: 'Not now', run: done },
    ],
  });
}
