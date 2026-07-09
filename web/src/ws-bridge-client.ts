/**
 * WsBridgeClient — real-WebSocket sibling of `BridgeCoreClient`.
 *
 * Same public surface as the in-process loopback client in
 * `bridge-core.ts` (observe / unobserve / get / patch / onPatch /
 * onSnapshot / drain / dispose), but the underlying transport is a
 * `WebSocket` connection to a remote BridgeCore — currently the
 * per-instance bridge hosted inside the NanoBarrel FFGL plugin.
 *
 * The wire format is unchanged: outgoing `{action, …}`, incoming
 * `{type, …}`, both JSON. This file does no protocol work beyond
 * connection management — the protocol lives entirely on the server
 * (the native BridgeCore).
 *
 * Connection management:
 *   - The constructor opens the socket immediately.
 *   - Calls made before `open` are queued and flushed on connect.
 *   - The subscription list is remembered; on reconnect the client
 *     re-issues every `observe` automatically so the editor keeps
 *     seeing patches across a NanoBarrel restart.
 *   - Auto-reconnect uses exponential backoff capped at 30 s.
 *
 * `drain()` is a no-op — incoming WebSocket messages dispatch to
 * handlers as they arrive, with no synchronous "tick" needed. Kept on
 * the surface so it's a drop-in for `BridgeCoreClient`.
 */

export class WsBridgeClient {
  /** Surface compatibility with BridgeCoreClient; not used externally. */
  readonly clientId: number = 1;
  readonly url: string;

  /** Fired once the underlying WebSocket reaches OPEN (first connect
   *  and every reconnect). Re-subscriptions have already been replayed
   *  by the time this fires. */
  onOpen?: () => void;
  /** Fired on close (will be followed by a reconnect attempt unless
   *  `dispose()` was called). */
  onClose?: () => void;
  /** Fired on transport-level error events. */
  onError?: (err: Event) => void;
  /** Fired for every WebSocket binary frame from the server. The barrel
   *  uses this for out-of-band data — currently RGBA preview frames; the
   *  JSON-patch protocol stays text-only. */
  onBinaryFrame?: (buf: ArrayBuffer) => void;

  private ws: WebSocket | null = null;
  private sendQueue: string[] = [];
  private patchHandlers: ((ops: any[]) => void)[] = [];
  private snapshotHandlers: Map<string, ((data: any) => void)[]> = new Map();
  /** Tracked so reconnects automatically re-subscribe. */
  private subscriptions = new Set<string>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Subscribe to state changes at `path`. Remembered for reconnect. */
  observe(path: string): void {
    this.subscriptions.add(path);
    this.send({ action: 'observe', path });
  }

  /** Unsubscribe. Also removes from the reconnect set. */
  unobserve(path: string): void {
    this.subscriptions.delete(path);
    this.send({ action: 'unobserve', path });
  }

  /** Request a snapshot. Use `onSnapshot(path, …)` first to receive it. */
  get(path: string): void {
    this.send({ action: 'get', path });
  }

  /** Send a JSON patch. `target` is normally `/plugins/<key>/state`. */
  patch(target: string, ops: any[]): void {
    this.send({ action: 'patch', target, ops });
  }

  /**
   * Connect (`on`) or disconnect a Resolume clip. Address it by marker uuid
   * (`key`) OR by 0-based composition `layer`/`clip` indices. Fire-and-forget:
   * the native barrel resolves the clip and issues the Resolume WS trigger; the
   * result arrives as the usual /global/channels + /global/clip_states patch.
   */
  triggerClip(target: { key?: string; layer?: number; clip?: number }, on: boolean): void {
    this.send({ action: 'trigger_clip', ...target, on });
  }

  /** Reassign a clip (by marker uuid) to a new 1-based trigger channel. The
   *  native barrel writes the marker's Channel param over the Resolume WS. */
  reassignChannel(key: string, channel: number): void {
    this.send({ action: 'reassign_channel', key, channel });
  }

  onPatch(handler: (ops: any[]) => void): void {
    this.patchHandlers.push(handler);
  }

  onSnapshot(path: string, handler: (data: any) => void): void {
    const handlers = this.snapshotHandlers.get(path) ?? [];
    handlers.push(handler);
    this.snapshotHandlers.set(path, handlers);
  }

  /** No-op — WS messages dispatch on arrival. Kept for surface parity. */
  drain(): void {}

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.patchHandlers = [];
    this.snapshotHandlers.clear();
    this.subscriptions.clear();
    this.sendQueue = [];
  }

  // -- Internal -------------------------------------------------------

  private connect(): void {
    if (this.disposed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.warn(`[WsBridgeClient] failed to construct WebSocket(${this.url}):`, err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // The browser delivers binary frames as Blob by default, which
    // forces an async .arrayBuffer() round-trip. Request ArrayBuffer
    // directly so onBinaryFrame can hand the buffer to a typed-array
    // view in the same tick.
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => {
      console.log(`[WsBridgeClient] connected ${this.url}`);
      this.reconnectAttempts = 0;
      // Re-issue every subscription so reconnects are transparent.
      for (const path of this.subscriptions) {
        ws.send(JSON.stringify({ action: 'observe', path }));
      }
      const queued = this.sendQueue;
      this.sendQueue = [];
      for (const msg of queued) ws.send(msg);
      this.onOpen?.();
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data) this.handleMessage(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        this.onBinaryFrame?.(ev.data);
      }
    });
    ws.addEventListener('close', () => {
      console.log(`[WsBridgeClient] disconnected ${this.url}`);
      this.ws = null;
      this.onClose?.();
      this.scheduleReconnect();
    });
    ws.addEventListener('error', (ev) => {
      console.warn(`[WsBridgeClient] error on ${this.url}`, ev);
      this.onError?.(ev);
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer != null) return;
    // 500ms, 1s, 2s, 4s, … capped at 30s.
    const delay = Math.min(30000, 500 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private send(obj: any): void {
    const msg = JSON.stringify(obj);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this.sendQueue.push(msg);
    }
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); }
    catch (err) {
      console.warn(`[WsBridgeClient] malformed message:`, err, raw.slice(0, 200));
      return;
    }
    if (msg.type === 'patch' && Array.isArray(msg.ops)) {
      for (const h of this.patchHandlers) h(msg.ops);
    } else if (msg.type === 'snapshot') {
      const handlers = this.snapshotHandlers.get(msg.path);
      if (handlers) for (const h of handlers) h(msg.data);
    }
  }
}
