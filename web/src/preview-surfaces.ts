/**
 * preview-surfaces.ts — barrel previews as shared GPU surfaces (desktop app).
 *
 * Over the socket transport every preview frame is read back to the CPU in
 * Resolume, striped across eight WebSockets, reassembled here and uploaded
 * again: two full copies each way, per frame, per monitor — hot, and no way to
 * reach 4K. In the desktop app the FFGL plugin instead scales each frame into
 * one of a small ring of surfaces this process can open directly
 * (native: BarrelRuntime's publishSurfaceFrame), and says which in a tiny NBPS
 * message on the main socket:
 *
 *   [0..3] "NBPS" [4] u8 v=1 [5] u8 slot [6..7] u16 keyLen [8..9] u16 idLen
 *   [10..11] u16 w [12..13] u16 h [14..17] u32 seq [18..25] u64 token
 *   [26..] key, traceId                                       (little-endian)
 *
 * Here: open the token ONCE (the main process imports it with Electron's
 * sharedTexture — main-only — and hands it to this frame), then per message
 * take a VideoFrame over it, copy it GPU to GPU into the monitor's texture,
 * and once that copy has completed on the GPU, release the slot back to the
 * barrel. The barrel never rewrites a slot we still hold, which is the only
 * thing ordering the two processes' GPU work on one surface.
 *
 * Opt-in by request: `groupPreviewRequests(..., 'surface')` marks each request,
 * so a browser editor on the same barrel keeps the lanes.
 */

import { electronIpc } from './state/paths';
import { previewGpu } from './preview-gpu';

export interface NbpsMessage {
  slot: number;
  key: string;
  traceId: string;
  width: number;
  height: number;
  seq: number;
  token: number;
}

/** Parse an NBPS message, or null if `buf` is anything else. */
export function parseNbps(buf: ArrayBuffer): NbpsMessage | null {
  if (buf.byteLength < 26) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 0x4E || dv.getUint8(1) !== 0x42 ||   // 'N' 'B'
      dv.getUint8(2) !== 0x50 || dv.getUint8(3) !== 0x53) {   // 'P' 'S'
    return null;
  }
  if (dv.getUint8(4) !== 1) return null;
  const keyLen = dv.getUint16(6, true);
  const idLen = dv.getUint16(8, true);
  if (buf.byteLength < 26 + keyLen + idLen) return null;
  const text = new TextDecoder();
  return {
    slot: dv.getUint8(5),
    width: dv.getUint16(10, true),
    height: dv.getUint16(12, true),
    seq: dv.getUint32(14, true),
    token: Number(dv.getBigUint64(18, true)),
    key: text.decode(new Uint8Array(buf, 26, keyLen)),
    traceId: text.decode(new Uint8Array(buf, 26 + keyLen, idLen)),
  };
}

/** What the ingest needs from the app — kept as a seam so this module is
 *  testable without the controller. */
export interface SurfaceSink {
  /** Would this client show this frame? (Another editor's monitors are not ours.) */
  wants(key: string, traceId: string): boolean;
  /** Take the frame. False if it couldn't be used right now. */
  ingest(key: string, traceId: string, frame: VideoFrame, width: number, height: number): boolean;
  /** Hand the surface back to the barrel. */
  release(token: number): void;
}

interface Imported {
  getVideoFrame(): VideoFrame;
  release(): void;
}

/** A surface this frame holds, and when it was last announced. */
interface Held { tex: Imported; lastSeen: number }

/** Surfaces not announced for this long belong to a ring the barrel rebuilt
 *  (a resize) or a monitor that closed; drop our reference. */
const STALE_MS = 5000;

/** Where a frame's time goes, for surface_profile.mjs and devtools
 *  (`window.__previewSurfaces.stats`). Totals in ms. */
export interface SurfaceStats {
  frames: number;
  imports: number;
  importMs: number;
  copyMs: number;
  gpuWaitMs: number;
}

class PreviewSurfaces {
  readonly stats: SurfaceStats = { frames: 0, imports: 0, importMs: 0, copyMs: 0, gpuWaitMs: 0 };
  private enabled = false;
  private held = new Map<number, Held>();
  private waiting = new Map<number, (tex: Imported | null) => void>();

  get active(): boolean { return this.enabled; }

  /** Turn the transport on if this is the desktop app and its shell can import
   *  surfaces. Safe to call more than once. */
  async init(): Promise<boolean> {
    if (this.enabled) return true;
    const ipc = electronIpc();
    if (!ipc) return false;
    let supported = false;
    try { supported = !!(await ipc.invoke('nano.surfaceSupport')); } catch { /* old shell */ }
    const electron = (globalThis as any).require?.('electron');
    const st = electron?.sharedTexture;
    if (!supported || typeof st?.setSharedTextureReceiver !== 'function') return false;
    st.setSharedTextureReceiver((data: { importedSharedTexture: Imported }, token: number) => {
      const resolve = this.waiting.get(token);
      this.waiting.delete(token);
      if (resolve) resolve(data.importedSharedTexture);
      else data.importedSharedTexture.release();  // nobody asked (a late duplicate)
    });
    previewGpu.ensureInit();
    this.enabled = true;
    return true;
  }

  /**
   * Handle a binary message from the barrel's main socket. True if it was an
   * NBPS announcement (consumed, whether or not it was ours).
   */
  handle(buf: ArrayBuffer, sink: SurfaceSink): boolean {
    const msg = parseNbps(buf);
    if (!msg) return false;
    if (!this.enabled || !sink.wants(msg.key, msg.traceId)) return true;
    void this.consume(msg, sink);
    return true;
  }

  private async consume(msg: NbpsMessage, sink: SurfaceSink): Promise<void> {
    try {
      const t0 = performance.now();
      const tex = await this.open(msg);
      if (!tex) return;
      const t1 = performance.now();
      const frame = tex.getVideoFrame();
      try {
        sink.ingest(msg.key, msg.traceId, frame, msg.width, msg.height);
      } finally {
        frame.close();
      }
      const t2 = performance.now();
      await previewGpu.whenCopied();
      const s = this.stats;
      s.frames++;
      s.importMs += t1 - t0;
      s.copyMs += t2 - t1;
      s.gpuWaitMs += performance.now() - t2;
    } catch (err) {
      console.warn('[preview-surfaces] frame dropped:', err);
    } finally {
      sink.release(msg.token);
      this.sweep();
    }
  }

  private async open(msg: NbpsMessage): Promise<Imported | null> {
    const now = performance.now();
    const have = this.held.get(msg.token);
    if (have) { have.lastSeen = now; return have.tex; }
    const ipc = electronIpc();
    if (!ipc) return null;
    const arrived = new Promise<Imported | null>((resolve) => this.waiting.set(msg.token, resolve));
    const ok = await ipc.invoke('nano.importSurface',
      { token: msg.token, width: msg.width, height: msg.height });
    if (!ok) {
      this.waiting.get(msg.token)?.(null);
      this.waiting.delete(msg.token);
      return null;
    }
    const tex = await arrived;
    if (tex) { this.held.set(msg.token, { tex, lastSeen: now }); this.stats.imports++; }
    return tex;
  }

  private sweep(): void {
    const now = performance.now();
    for (const [token, h] of this.held) {
      if (now - h.lastSeen < STALE_MS) continue;
      this.held.delete(token);
      try { h.tex.release(); } catch { /* already gone */ }
      void electronIpc()?.invoke('nano.releaseSurface', token);
    }
  }
}

export const previewSurfaces = new PreviewSurfaces();
