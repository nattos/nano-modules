/**
 * RemoteCompEngine — a CompEngine whose composition executor runs in a native
 * process (native/tools/nano_compositor.cpp), reached over the bridge
 * WebSocket the same way Remote Control reaches a NanoBarrel.
 *
 * What crosses, per direction:
 *  - out: `comp_*` actions (the worker's compLoadDoc / compControl / compOp
 *    payloads, plus resize / readback / visibility), and a patch of this key's
 *    `preview_requests` for the traces the bridge wants;
 *  - in: an NBCJ `comp_report` per rendered frame (CompFrameInfo), NBCJ
 *    replies matched by reqId, preview frames (NBPS surfaces in the desktop
 *    app, NBPV over the fan-out lanes otherwise), and `plugin_schemas` /
 *    `plugin_states` / `modulation_data` from the state document.
 *
 * The process decodes video itself (`ownsVideoPump`), so no frames or
 * readiness ever travel from here.
 *
 * A compositor that restarted comes back empty, so a RE-connect replays what
 * this editor last told it: the document, the sticky transport/mode controls,
 * and the cheap ops since that document.
 */

import type { CompFrameInfo, PluginInfo, StateDiff, TracePoint } from '../../../engine-types';
import { previewGpu, type PreviewFrame } from '../../../preview-gpu';
import { previewSurfaces, type SurfaceSink } from '../../../preview-surfaces';
import { groupPreviewRequests, laneUrl, NbpcReassembler, previewTransportPorts } from '../../../resolume-mode';
import { WsBridgeClient } from '../../../ws-bridge-client';
import { catalogEntries, pluginInfosFromCatalog } from '../../../state/plugin-catalog';
import type { CompControlMsg, CompEngine, CompOpMsg } from './comp-engine';

/** comp_export_start's payload (bridge/barrel_runtime.cpp startCompExport). */
export interface NativeExportRequest {
  /** The composition document, as JSON. */
  json: string;
  /** Absolute output path (.mp4). */
  path: string;
  width: number;
  height: number;
  fps: number;
  startBeat: number;
  endBeat: number;
  bitrate: number;
  ignoreSolo: boolean;
  /** Backdrop RGB 0..255 (MP4 has no alpha). */
  background: [number, number, number];
}

export interface NativeExportResult {
  frames: number;
  engineFrames: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
}

export interface RemoteCompOptions {
  /** The compositor's bridge URL, e.g. ws://127.0.0.1:8091. */
  url: string;
  /** Its plugin key (nano_compositor --key; default "compositor"). */
  key?: string;
  /** The socket dropped (`up` false) or came back after a drop (`up` true) —
   *  the compositor crashed and restarted, or the remote went away. The
   *  engine replays its state on reconnect by itself; this is for telling the
   *  user. Not called for the first connect. */
  onConnectionChange?: (up: boolean) => void;
}

/** The two telemetry channels mirrored from the state document. */
type Channel = 'plugin_states' | 'modulation_data';

export class RemoteCompEngine implements CompEngine {
  readonly ownsVideoPump = true;
  readonly discovered = new Set<string>();
  readonly lastDebugStats: unknown = null;
  readonly ready: Promise<void>;

  onFrameSet: ((frames: Record<string, PreviewFrame>) => void) | null = null;
  onFps: ((fps: number) => void) | null = null;
  onGpuTime: ((gpuMs: number) => void) | null = null;
  onError: ((message: string) => void) | null = null;
  onModulationDataDiff: ((diff: StateDiff) => void) | null = null;
  onPluginStatesDiff: ((diff: StateDiff) => void) | null = null;
  onPlugins: ((plugins: PluginInfo[]) => void) | null = null;
  onCompInfo: ((info: CompFrameInfo) => void) | null = null;

  private readonly key: string;
  private readonly base: string;
  private readonly client: WsBridgeClient;
  private resolveReady!: () => void;
  private width: number;
  private height: number;

  private compositeId: string | null = null;
  private baseTraces: TracePoint[] = [];
  private extraTraces: TracePoint[] = [];
  private lastRequestsJson = '';
  private surfaces = false;

  /** The latest frame per non-composite trace — every delivered set carries
   *  all of them (the bridge REPLACES its device-frame map per set). */
  private deviceFrames: Record<string, PreviewFrame> = {};
  /** Mirror of this key's telemetry channels (JSON-patched in place). */
  private channels: Record<Channel, Record<string, any>> = { plugin_states: {}, modulation_data: {} };

  private reqSeq = 0;
  private replies = new Map<number, (msg: any) => void>();

  private lanes = new Map<number, WsBridgeClient>();
  private reassembler = new NbpcReassembler();

  /** Replay state for a reconnect (see the header). */
  private opened = false;
  private lastDoc: string | null = null;
  private opsSinceDoc: CompOpMsg[] = [];
  private stickyControls = new Map<string, CompControlMsg>();
  /** The playhead as last reported — where a replay resumes. */
  private lastPositionBeat: number | null = null;

  private reportCount = 0;
  private fpsWindowStart = performance.now();

  constructor(width: number, height: number, opts: RemoteCompOptions) {
    this.width = width;
    this.height = height;
    this.key = opts.key ?? 'compositor';
    this.base = `/plugins/${this.key}/state`;
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });

    this.client = new WsBridgeClient(opts.url);
    // A fresh engine for this editor session, as a worker engine would be —
    // the FIRST message queued, so it lands before any document. `mediaBase`
    // is what a clip url that isn't a file path (a dev server's `/media/…`)
    // resolves against; the compositor fetches it (media_fetch.h).
    this.action('comp_reset', { mediaBase: location.href });
    this.client.onOpen = () => {
      // A reconnect: a restarted compositor never saw the first reset (so it
      // has no media base), a surviving one holds a stale session. Either way
      // start clean and replay.
      if (this.opened) {
        this.action('comp_reset', { mediaBase: location.href });
        this.replay();
        opts.onConnectionChange?.(true);
      }
      this.opened = true;
      this.action('comp_resize', { width: this.width, height: this.height });
      // Everything change-gated (chain keys, scenes, pump set) again: this
      // may be a reconnect to a compositor that has been running all along.
      this.action('comp_control', { op: 'resync' });
      this.lastRequestsJson = '';
      this.pushRequests();
      this.client.get(this.base);
    };
    this.client.onClose = () => { if (this.opened) opts.onConnectionChange?.(false); };
    this.client.onSnapshot(this.base, (state) => this.applyState(state));
    this.client.onSnapshot('/global/preview_transport', (doc) => this.reconcileLanes(doc));
    this.client.onPatch((ops) => this.applyPatches(ops));
    this.client.onBinaryFrame = (buf) => this.onBinary(buf);
    this.client.observe(this.base);
    this.client.observe('/global/preview_transport');
    this.client.get('/global/preview_transport');

    // In the desktop app previews come as shared GPU surfaces; until the
    // shell answers, requests go out without the flag and are re-sent.
    void previewSurfaces.init().then((ok) => {
      if (!ok) return;
      this.surfaces = true;
      this.pushRequests();
    });
  }

  // ── CompEngine ─────────────────────────────────────────────────────────

  async warmBundles(): Promise<void> {
    // The compositor loads every bundle it can find at startup.
  }

  evaluateVisibility(moduleType: string, state: Record<string, unknown>): Promise<string[] | null> {
    return this.request('comp_visibility', { moduleType, state })
      .then((r) => (Array.isArray(r?.hidden) ? r.hidden as string[] : null))
      .catch(() => null);
  }

  async compEnable(compositeId: string): Promise<void> {
    this.compositeId = compositeId;
    this.baseTraces = [{ id: compositeId, target: { type: 'sketch_output', sketchId: compositeId } }];
    this.pushRequests();
  }

  compLoadDoc(json: string): void {
    this.lastDoc = json;
    this.opsSinceDoc = [];
    this.action('comp_load_doc', { json });
  }

  compControl(msg: CompControlMsg): void {
    // play/pause share one slot, as do the other settings per op.
    const slot = msg.op === 'play' || msg.op === 'pause' ? 'transport' : msg.op;
    if (slot !== 'videoReady') this.stickyControls.set(slot, msg);
    this.action('comp_control', msg);
  }

  compOp(msg: CompOpMsg): void {
    this.opsSinceDoc.push(msg);
    this.action('comp_op', msg);
  }

  private replay() {
    if (this.lastDoc !== null) this.action('comp_load_doc', { json: this.lastDoc });
    // Settings first, then where the playhead WAS (not the last seek — it has
    // moved on since), then whether it runs.
    for (const slot of ['mode', 'loop', 'clipTiming', 'ignoreSolo']) {
      const msg = this.stickyControls.get(slot);
      if (msg) this.action('comp_control', msg);
    }
    const seek = this.stickyControls.get('seek');
    if (this.lastPositionBeat !== null) this.action('comp_control', { op: 'seek', beat: this.lastPositionBeat, seq: seek?.seq });
    else if (seek) this.action('comp_control', seek);
    const transport = this.stickyControls.get('transport');
    if (transport) this.action('comp_control', transport);
    for (const op of this.opsSinceDoc) this.action('comp_op', op);
  }

  setExtraTracePoints(tps: TracePoint[]): void {
    this.extraTraces = tps;
    // Frames of traces nobody wants any more must not keep riding the sets.
    const live = new Set(tps.map((t) => t.id));
    for (const id of Object.keys(this.deviceFrames)) if (!live.has(id)) delete this.deviceFrames[id];
    this.pushRequests();
  }

  setInstanceTexture(_instanceKey: string, bitmap: ImageBitmap | null): void {
    bitmap?.close(); // the compositor decodes for itself (ownsVideoPump)
  }

  async readbackTrace(id: string): Promise<{ width: number; height: number; pixels: Uint8Array }> {
    if (id !== this.compositeId) throw new Error(`RemoteCompEngine: only the composite reads back (not ${id})`);
    const r = await this.request('comp_readback', {});
    if (!r?.hasContent || typeof r.pixels !== 'string') return { width: 0, height: 0, pixels: new Uint8Array() };
    const bin = atob(r.pixels);
    const pixels = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) pixels[i] = bin.charCodeAt(i);
    return { width: r.width, height: r.height, pixels };
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.action('comp_resize', { width, height });
  }

  setDebugMode(_on: boolean): void { /* no debug stats from the native host yet */ }

  destroy(): void {
    // Stop the compositor capturing for us; it keeps running (it isn't ours).
    this.client.patch(this.base, [{ op: 'add', path: '/preview_requests', value: {} }]);
    for (const [, reply] of this.replies) reply(null);
    this.replies.clear();
    for (const lane of this.lanes.values()) lane.dispose();
    this.lanes.clear();
    this.client.dispose();
  }

  // ── Outgoing ───────────────────────────────────────────────────────────

  private action(action: string, payload: object) {
    // Queued until open, so commands issued during boot keep their order.
    this.client.sendAction(action, { key: this.key, ...payload });
  }

  private request(action: string, payload: object): Promise<any> {
    const reqId = ++this.reqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(reqId);
        reject(new Error(`${action} timed out`));
      }, 10_000);
      this.replies.set(reqId, (msg) => { clearTimeout(timer); resolve(msg); });
      this.action(action, { ...payload, reqId });
    });
  }

  private pushRequests() {
    const tps = [...this.baseTraces, ...this.extraTraces];
    const groups = groupPreviewRequests(tps, this.key, {}, this.surfaces ? 'surface' : undefined);
    const requests = groups.get(this.key) ?? {};
    const json = JSON.stringify(requests);
    if (json === this.lastRequestsJson) return;
    this.lastRequestsJson = json;
    this.client.patch(this.base, [{ op: 'add', path: '/preview_requests', value: requests }]);
  }

  // ── Incoming ───────────────────────────────────────────────────────────

  private onBinary(buf: ArrayBuffer) {
    if (this.handleCompJson(buf)) return;
    if (previewSurfaces.handle(buf, this.surfaceSink)) return;
    this.ingestNbpv(buf);  // an NBPV on the main socket (a server without lanes)
  }

  /** NBCJ: [0..3] "NBCJ" [4] u8 v=1 [5..6] u16 keyLen, key, JSON. */
  private handleCompJson(buf: ArrayBuffer): boolean {
    if (buf.byteLength < 7) return false;
    const b = new Uint8Array(buf);
    if (b[0] !== 0x4e || b[1] !== 0x42 || b[2] !== 0x43 || b[3] !== 0x4a) return false;
    const keyLen = b[5] | (b[6] << 8);
    const dec = new TextDecoder();
    if (dec.decode(b.subarray(7, 7 + keyLen)) !== this.key) return true;
    let msg: any;
    try { msg = JSON.parse(dec.decode(b.subarray(7 + keyLen))); } catch { return true; }
    if (typeof msg?.type === 'string' && msg.type.startsWith('export_')) {
      this.onExportMessage(msg);
    } else if (msg?.type === 'comp_report') {
      this.resolveReady();
      if (typeof msg.positionBeat === 'number') this.lastPositionBeat = msg.positionBeat;
      this.countFps();
      const { type: _type, ...info } = msg;
      this.onCompInfo?.(info as CompFrameInfo);
    } else if (typeof msg?.reqId === 'number') {
      const reply = this.replies.get(msg.reqId);
      this.replies.delete(msg.reqId);
      reply?.(msg);
    }
    return true;
  }

  // ── Offline export (bridge/comp_export.h) ─────────────────────────────────
  private exportSeq = 0;
  private exportJob: {
    id: number;
    onProgress?: (done: number, total: number) => void;
    resolve: (r: NativeExportResult) => void;
    reject: (e: Error) => void;
  } | null = null;

  /**
   * Render + encode an MP4 IN the compositor process — its own engine beside
   * the live one, AVFoundation decode (exact H.264 frames) and a hardware H.264
   * encode — straight to `path`. Resolves when the file is on disk; rejects
   * with an AbortError on `signal`.
   */
  exportFile(req: NativeExportRequest, onProgress?: (done: number, total: number) => void,
             signal?: AbortSignal): Promise<NativeExportResult> {
    if (this.exportJob) return Promise.reject(new Error('an export is already running'));
    const id = ++this.exportSeq;
    return new Promise<NativeExportResult>((resolve, reject) => {
      this.exportJob = { id, onProgress, resolve, reject };
      signal?.addEventListener('abort', () => this.action('comp_export_cancel', { jobId: id }), { once: true });
      this.action('comp_export_start', { jobId: id, ...req });
    });
  }

  private onExportMessage(msg: any) {
    const job = this.exportJob;
    if (!job || msg.jobId !== job.id) return;
    if (msg.type === 'export_progress') {
      job.onProgress?.(msg.done, msg.total);
      return;
    }
    this.exportJob = null;
    if (msg.type === 'export_error') job.reject(new Error(msg.message || 'export failed'));
    else if (msg.canceled) job.reject(new DOMException('Export canceled', 'AbortError'));
    else job.resolve({ frames: msg.frames, engineFrames: msg.engineFrames,
                       durationSec: msg.durationSec, width: msg.width, height: msg.height, fps: msg.fps });
  }

  private countFps() {
    this.reportCount++;
    const now = performance.now();
    if (now - this.fpsWindowStart >= 1000) {
      this.onFps?.((this.reportCount * 1000) / (now - this.fpsWindowStart));
      this.reportCount = 0;
      this.fpsWindowStart = now;
    }
  }

  private readonly surfaceSink: SurfaceSink = {
    wants: (key) => key === this.key,
    ingest: (_key, traceId, source, w, h) => {
      const frame = previewGpu.uploadVideoFrame(traceId, source, w, h);
      if (!frame) return false;
      this.deliver(traceId, frame);
      return true;
    },
    release: (token) => this.client.previewRelease(token),
  };

  /** NBPV v2 (preview_codec.h): pixels → this trace's pooled GPU texture. */
  private ingestNbpv(buf: ArrayBuffer) {
    if (buf.byteLength < 14) return;
    const dv = new DataView(buf);
    if (dv.getUint32(0, false) !== 0x4e425056 /* NBPV */ || dv.getUint8(4) !== 2 || dv.getUint8(5) !== 1) return;
    const keyLen = dv.getUint16(6, true);
    const idLen = dv.getUint16(8, true);
    const width = dv.getUint16(10, true);
    const height = dv.getUint16(12, true);
    const headerEnd = 14 + keyLen + idLen;
    const pixelBytes = width * height * 4;
    if (buf.byteLength < headerEnd + pixelBytes) return;
    const dec = new TextDecoder();
    if (dec.decode(new Uint8Array(buf, 14, keyLen)) !== this.key) return;
    const traceId = dec.decode(new Uint8Array(buf, 14 + keyLen, idLen));
    const frame = previewGpu.uploadFrame(traceId, new Uint8Array(buf, headerEnd, pixelBytes), width, height);
    if (frame) this.deliver(traceId, frame);
  }

  private deliver(traceId: string, frame: PreviewFrame) {
    if (traceId === this.compositeId) {
      this.onFrameSet?.({ ...this.deviceFrames, [traceId]: frame });
    } else {
      this.deviceFrames[traceId] = frame;
      this.onFrameSet?.({ ...this.deviceFrames });
    }
  }

  private reconcileLanes(doc: unknown) {
    const desired = new Set(previewTransportPorts(doc));
    for (const port of desired) {
      if (this.lanes.has(port)) continue;
      const lane = new WsBridgeClient(laneUrl(this.client.url, port));
      lane.onBinaryFrame = (buf) => {
        const full = this.reassembler.ingest(buf);
        if (full) this.ingestNbpv(full);
      };
      this.lanes.set(port, lane);
    }
    for (const [port, lane] of [...this.lanes]) {
      if (!desired.has(port)) { lane.dispose(); this.lanes.delete(port); }
    }
  }

  /** A full snapshot of this key's state. */
  private applyState(state: any) {
    if (!state || typeof state !== 'object') return;
    this.adoptSchemas(state.plugin_schemas);
    for (const ch of ['plugin_states', 'modulation_data'] as Channel[]) {
      const next = state[ch] && typeof state[ch] === 'object' ? state[ch] : {};
      const removed = Object.keys(this.channels[ch]).filter((k) => !(k in next));
      this.channels[ch] = structuredClone(next);
      this.emit(ch, new Set(Object.keys(next)), removed);
    }
  }

  private adoptSchemas(schemas: unknown) {
    const entries = catalogEntries(schemas);
    if (!entries.length) return;
    for (const e of entries) this.discovered.add(e.id);
    this.onPlugins?.(pluginInfosFromCatalog(entries));
  }

  /** JSON-patch ops against the whole document: keep the ones under this key. */
  private applyPatches(ops: any[]) {
    const touched: Record<Channel, Set<string>> = { plugin_states: new Set(), modulation_data: new Set() };
    let schemas = false;
    for (const op of ops) {
      const path: string = op?.path ?? '';
      if (!path.startsWith(this.base + '/')) continue;
      const rel = path.slice(this.base.length + 1).split('/').map(unescapePointer);
      const ch = rel[0];
      if (ch === 'plugin_schemas') { schemas = true; continue; }
      if (ch !== 'plugin_states' && ch !== 'modulation_data') continue;
      if (rel.length === 1) {
        // The whole channel replaced.
        const next = op.op === 'remove' ? {} : (op.value ?? {});
        for (const k of Object.keys(this.channels[ch])) touched[ch].add(k);
        for (const k of Object.keys(next)) touched[ch].add(k);
        this.channels[ch] = structuredClone(next);
        continue;
      }
      touched[ch].add(rel[1]);
      applyPointerOp(this.channels[ch], rel.slice(1), op);
    }
    if (schemas) this.client.get(this.base);  // rare (a module reload): refetch whole
    for (const ch of ['plugin_states', 'modulation_data'] as Channel[]) {
      if (!touched[ch].size) continue;
      const present = new Set([...touched[ch]].filter((k) => k in this.channels[ch]));
      const removed = [...touched[ch]].filter((k) => !(k in this.channels[ch]));
      this.emit(ch, present, removed);
    }
  }

  private emit(ch: Channel, changedKeys: Set<string>, removed: string[]) {
    if (!changedKeys.size && !removed.length) return;
    const changed: Record<string, any> = {};
    for (const k of changedKeys) changed[k] = structuredClone(this.channels[ch][k]);
    const diff: StateDiff = { changed, removed };
    if (ch === 'plugin_states') this.onPluginStatesDiff?.(diff);
    else this.onModulationDataDiff?.(diff);
  }
}

/** RFC 6901 token unescape. */
function unescapePointer(t: string): string {
  return t.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Apply one add/replace/remove op at `path` (tokens) inside `root`. */
function applyPointerOp(root: Record<string, any>, path: string[], op: any) {
  let node: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    const t = path[i];
    if (node[t] === undefined || node[t] === null || typeof node[t] !== 'object') {
      if (op.op === 'remove') return;
      node[t] = {};
    }
    node = node[t];
  }
  const last = path[path.length - 1];
  if (op.op === 'remove') {
    if (Array.isArray(node)) node.splice(Number(last), 1);
    else delete node[last];
  } else if (Array.isArray(node) && op.op === 'add') {
    if (last === '-') node.push(op.value);
    else node.splice(Number(last), 0, op.value);
  } else {
    node[last] = op.value;
  }
}
