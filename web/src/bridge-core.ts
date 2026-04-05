/**
 * TypeScript wrapper for bridge_core.wasm — the shared protocol engine.
 *
 * Provides a high-level API over the C exports, managing memory allocation
 * and string marshaling. Includes a loopback transport that routes messages
 * between virtual clients and the bridge core without real WebSockets.
 */

import { createWasiShim } from './wasi-shim';

// Raw WASM exports from bridge_core.wasm
interface BridgeCoreExports {
  memory: WebAssembly.Memory;
  _initialize?: () => void;

  malloc(size: number): number;
  free(ptr: number): void;

  bridge_core_create(): number;
  bridge_core_destroy(h: number): void;
  bridge_core_tick(h: number): void;

  bridge_core_connect_client(h: number): number;
  bridge_core_disconnect_client(h: number, clientId: number): void;

  bridge_core_receive_message(h: number, clientId: number, msg: number, msgLen: number): void;
  bridge_core_poll_outgoing(h: number, clientId: number, buf: number, bufLen: number): number;

  bridge_core_register_plugin(h: number,
    id: number, idLen: number,
    major: number, minor: number, patch: number,
    keyBuf: number, keyBufLen: number): number;

  bridge_core_declare_param(h: number,
    pluginKey: number, pluginKeyLen: number,
    index: number,
    name: number, nameLen: number,
    type: number, defaultValue: number): void;

  bridge_core_log(h: number,
    pluginKey: number, pluginKeyLen: number,
    timestamp: number, level: number,
    msg: number, msgLen: number): void;

  bridge_core_log_structured(h: number,
    pluginKey: number, pluginKeyLen: number,
    timestamp: number, level: number,
    msg: number, msgLen: number,
    jsonData: number, jsonLen: number): void;

  bridge_core_set_plugin_state(h: number,
    pluginKey: number, pluginKeyLen: number,
    jsonState: number, jsonLen: number): void;

  bridge_core_get_plugin_state(h: number,
    pluginKey: number, pluginKeyLen: number,
    buf: number, bufLen: number): number;

  bridge_core_apply_client_patch(h: number,
    pluginKey: number, pluginKeyLen: number,
    patchJson: number, patchLen: number): void;

  bridge_core_declare_io(h: number,
    pluginKey: number, pluginKeyLen: number,
    index: number,
    name: number, nameLen: number,
    kind: number, role: number): void;

  bridge_core_get_param(h: number, paramId: bigint): number;
  bridge_core_set_param(h: number, paramId: bigint, value: number): void;
  bridge_core_queue_param_write(h: number, paramId: bigint, value: number): void;

  bridge_core_set_param_path(h: number, paramId: bigint,
    path: number, pathLen: number): void;
  bridge_core_get_param_path(h: number, paramId: bigint,
    buf: number, bufLen: number): number;

  bridge_core_get_at(h: number,
    path: number, pathLen: number,
    buf: number, bufLen: number): number;

  bridge_core_get_plugin_key(h: number,
    id: number, idLen: number,
    keyBuf: number, keyBufLen: number): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Scratch buffer size for reading strings from WASM
const SCRATCH_SIZE = 16384;

/**
 * High-level wrapper around the bridge_core WASM module.
 */
export class BridgeCore {
  private exports!: BridgeCoreExports;
  private memory!: WebAssembly.Memory;
  private handle: number = 0;
  private scratchPtr: number = 0;

  async init(): Promise<void> {
    const response = await fetch('/wasm/bridge_core.wasm');
    const bytes = await response.arrayBuffer();

    let memoryRef: WebAssembly.Memory;
    const importObject: WebAssembly.Imports = {
      wasi_snapshot_preview1: createWasiShim(() => memoryRef),
    };

    const result = await WebAssembly.instantiate(bytes, importObject);
    this.exports = result.instance.exports as unknown as BridgeCoreExports;
    this.memory = this.exports.memory;
    memoryRef = this.memory;

    if (this.exports._initialize) this.exports._initialize();

    this.handle = this.exports.bridge_core_create();
    this.scratchPtr = this.exports.malloc(SCRATCH_SIZE);
  }

  destroy(): void {
    if (this.handle) {
      this.exports.free(this.scratchPtr);
      this.exports.bridge_core_destroy(this.handle);
      this.handle = 0;
    }
  }

  // --- String marshaling helpers ---

  private writeString(str: string): [number, number] {
    const encoded = encoder.encode(str);
    const ptr = this.exports.malloc(encoded.length);
    new Uint8Array(this.memory.buffer, ptr, encoded.length).set(encoded);
    return [ptr, encoded.length];
  }

  private freeString(ptr: number): void {
    this.exports.free(ptr);
  }

  private readScratch(len: number): string {
    return decoder.decode(new Uint8Array(this.memory.buffer, this.scratchPtr, len));
  }

  /** Call fn with a temporary string allocation, then free it. */
  private withString<T>(str: string, fn: (ptr: number, len: number) => T): T {
    const [ptr, len] = this.writeString(str);
    const result = fn(ptr, len);
    this.freeString(ptr);
    return result;
  }

  private withStrings<T>(strs: string[], fn: (ptrs: [number, number][]) => T): T {
    const allocs = strs.map(s => this.writeString(s));
    const result = fn(allocs);
    allocs.forEach(([ptr]) => this.freeString(ptr));
    return result;
  }

  // --- Core API ---

  tick(): void {
    this.exports.bridge_core_tick(this.handle);
  }

  connectClient(): number {
    return this.exports.bridge_core_connect_client(this.handle);
  }

  disconnectClient(clientId: number): void {
    this.exports.bridge_core_disconnect_client(this.handle, clientId);
  }

  sendMessage(clientId: number, msg: string): void {
    this.withString(msg, (ptr, len) => {
      this.exports.bridge_core_receive_message(this.handle, clientId, ptr, len);
    });
  }

  pollOutgoing(clientId: number): string | null {
    const len = this.exports.bridge_core_poll_outgoing(
      this.handle, clientId, this.scratchPtr, SCRATCH_SIZE);
    if (len === 0) return null;
    return this.readScratch(len);
  }

  /** Drain all pending outgoing messages for a client. */
  drainOutgoing(clientId: number): string[] {
    const messages: string[] = [];
    let msg: string | null;
    while ((msg = this.pollOutgoing(clientId)) !== null) {
      messages.push(msg);
    }
    return messages;
  }

  // --- Plugin registration ---

  registerPlugin(id: string, major: number, minor: number, patch: number): string {
    return this.withString(id, (idPtr, idLen) => {
      const keyLen = this.exports.bridge_core_register_plugin(
        this.handle, idPtr, idLen, major, minor, patch,
        this.scratchPtr, SCRATCH_SIZE);
      return this.readScratch(keyLen);
    });
  }

  declareParam(pluginKey: string, index: number, name: string,
               type: number, defaultValue: number): void {
    this.withStrings([pluginKey, name], ([[pkPtr, pkLen], [nPtr, nLen]]) => {
      this.exports.bridge_core_declare_param(
        this.handle, pkPtr, pkLen, index, nPtr, nLen, type, defaultValue);
    });
  }

  declareIO(pluginKey: string, index: number, name: string,
            kind: number, role: number): void {
    this.withStrings([pluginKey, name], ([[pkPtr, pkLen], [nPtr, nLen]]) => {
      this.exports.bridge_core_declare_io(
        this.handle, pkPtr, pkLen, index, nPtr, nLen, kind, role);
    });
  }

  log(pluginKey: string, timestamp: number, level: number, msg: string): void {
    this.withStrings([pluginKey, msg], ([[pkPtr, pkLen], [mPtr, mLen]]) => {
      this.exports.bridge_core_log(
        this.handle, pkPtr, pkLen, timestamp, level, mPtr, mLen);
    });
  }

  logStructured(pluginKey: string, timestamp: number, level: number,
                msg: string, jsonData: string): void {
    this.withStrings([pluginKey, msg, jsonData],
      ([[pkPtr, pkLen], [mPtr, mLen], [jPtr, jLen]]) => {
        this.exports.bridge_core_log_structured(
          this.handle, pkPtr, pkLen, timestamp, level, mPtr, mLen, jPtr, jLen);
      });
  }

  // --- Plugin state ---

  setPluginState(pluginKey: string, state: any): void {
    const json = JSON.stringify(state);
    this.withStrings([pluginKey, json], ([[pkPtr, pkLen], [jPtr, jLen]]) => {
      this.exports.bridge_core_set_plugin_state(
        this.handle, pkPtr, pkLen, jPtr, jLen);
    });
  }

  getPluginState(pluginKey: string): any {
    return this.withString(pluginKey, (pkPtr, pkLen) => {
      const len = this.exports.bridge_core_get_plugin_state(
        this.handle, pkPtr, pkLen, this.scratchPtr, SCRATCH_SIZE);
      if (len === 0) return {};
      return JSON.parse(this.readScratch(len));
    });
  }

  applyClientPatch(pluginKey: string, ops: any[]): void {
    const json = JSON.stringify(ops);
    this.withStrings([pluginKey, json], ([[pkPtr, pkLen], [jPtr, jLen]]) => {
      this.exports.bridge_core_apply_client_patch(
        this.handle, pkPtr, pkLen, jPtr, jLen);
    });
  }

  // --- Resolume param cache ---

  getParam(paramId: bigint): number {
    return this.exports.bridge_core_get_param(this.handle, paramId);
  }

  setParam(paramId: bigint, value: number): void {
    this.exports.bridge_core_set_param(this.handle, paramId, value);
  }

  queueParamWrite(paramId: bigint, value: number): void {
    this.exports.bridge_core_queue_param_write(this.handle, paramId, value);
  }

  setParamPath(paramId: bigint, path: string): void {
    this.withString(path, (ptr, len) => {
      this.exports.bridge_core_set_param_path(this.handle, paramId, ptr, len);
    });
  }

  getParamPath(paramId: bigint): string {
    const len = this.exports.bridge_core_get_param_path(
      this.handle, paramId, this.scratchPtr, SCRATCH_SIZE);
    if (len === 0) return `param/${paramId}`;
    return this.readScratch(len);
  }

  // --- State queries ---

  getAt(path: string): any {
    return this.withString(path, (ptr, len) => {
      const resultLen = this.exports.bridge_core_get_at(
        this.handle, ptr, len, this.scratchPtr, SCRATCH_SIZE);
      if (resultLen === 0) return null;
      return JSON.parse(this.readScratch(resultLen));
    });
  }

  getPluginKey(id: string): string | null {
    return this.withString(id, (ptr, len) => {
      const keyLen = this.exports.bridge_core_get_plugin_key(
        this.handle, ptr, len, this.scratchPtr, SCRATCH_SIZE);
      if (keyLen === 0) return null;
      return this.readScratch(keyLen);
    });
  }
}

/**
 * A virtual WebSocket-like client that communicates with a BridgeCore
 * instance via the loopback transport (in-memory message passing).
 */
export class BridgeCoreClient {
  readonly clientId: number;
  private core: BridgeCore;
  private patchHandlers: ((ops: any[]) => void)[] = [];
  private snapshotHandlers: Map<string, ((data: any) => void)[]> = new Map();

  constructor(core: BridgeCore) {
    this.core = core;
    this.clientId = core.connectClient();
  }

  dispose(): void {
    this.core.disconnectClient(this.clientId);
  }

  /** Subscribe to state changes at a path. */
  observe(path: string): void {
    this.core.sendMessage(this.clientId, JSON.stringify({ action: 'observe', path }));
  }

  /** Unsubscribe from state changes at a path. */
  unobserve(path: string): void {
    this.core.sendMessage(this.clientId, JSON.stringify({ action: 'unobserve', path }));
  }

  /** Request a snapshot of state at a path. */
  get(path: string): void {
    this.core.sendMessage(this.clientId, JSON.stringify({ action: 'get', path }));
  }

  /** Send a JSON patch to the bridge core. */
  patch(target: string, ops: any[]): void {
    this.core.sendMessage(this.clientId, JSON.stringify({ action: 'patch', target, ops }));
  }

  /** Register a handler for incoming patch messages. */
  onPatch(handler: (ops: any[]) => void): void {
    this.patchHandlers.push(handler);
  }

  /** Register a handler for snapshot responses. */
  onSnapshot(path: string, handler: (data: any) => void): void {
    const handlers = this.snapshotHandlers.get(path) ?? [];
    handlers.push(handler);
    this.snapshotHandlers.set(path, handlers);
  }

  /**
   * Drain all pending outgoing messages and dispatch to handlers.
   * Call this after bridge_core_tick().
   */
  drain(): void {
    const messages = this.core.drainOutgoing(this.clientId);
    for (const raw of messages) {
      const msg = JSON.parse(raw);
      if (msg.type === 'patch' && msg.ops) {
        for (const handler of this.patchHandlers) {
          handler(msg.ops);
        }
      } else if (msg.type === 'snapshot') {
        const handlers = this.snapshotHandlers.get(msg.path);
        if (handlers) {
          for (const handler of handlers) {
            handler(msg.data);
          }
        }
      }
    }
  }
}
