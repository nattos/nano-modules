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

  bridge_core_register_with_schema(h: number,
    id: number, idLen: number,
    major: number, minor: number, patch: number,
    schemaJson: number, schemaJsonLen: number,
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

  bridge_core_set_at(h: number,
    path: number, pathLen: number,
    jsonValue: number, jsonLen: number): void;

  bridge_core_get_at(h: number,
    path: number, pathLen: number,
    buf: number, bufLen: number): number;

  bridge_core_get_plugin_key(h: number,
    id: number, idLen: number,
    keyBuf: number, keyBufLen: number): number;

  // Val handle store
  bridge_core_val_null(h: number): number;
  bridge_core_val_bool(h: number, v: number): number;
  bridge_core_val_number(h: number, v: number): number;
  bridge_core_val_string(h: number, s: number, len: number): number;
  bridge_core_val_array(h: number): number;
  bridge_core_val_object(h: number): number;

  bridge_core_val_type_of(h: number, valH: number): number;
  bridge_core_val_as_number(h: number, valH: number): number;
  bridge_core_val_as_bool(h: number, valH: number): number;
  bridge_core_val_as_string(h: number, valH: number, buf: number, bufLen: number): number;

  bridge_core_val_get(h: number, objH: number, key: number, keyLen: number): number;
  bridge_core_val_set(h: number, objH: number, key: number, keyLen: number, valH: number): void;
  bridge_core_val_keys_count(h: number, objH: number): number;
  bridge_core_val_key_at(h: number, objH: number, index: number, buf: number, bufLen: number): number;

  bridge_core_val_get_index(h: number, arrH: number, index: number): number;
  bridge_core_val_push(h: number, arrH: number, valH: number): void;
  bridge_core_val_length(h: number, arrH: number): number;

  bridge_core_val_release(h: number, valH: number): void;
  bridge_core_val_to_json(h: number, valH: number, buf: number, bufLen: number): number;

  bridge_core_commit_val(h: number,
    pluginKey: number, pluginKeyLen: number,
    path: number, pathLen: number,
    valH: number): void;
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

  /**
   * Call the C API with the persistent scratch buffer. If the C side
   * reports it needed more space than SCRATCH_SIZE, allocate a one-shot
   * larger buffer and call again. Returns null when the result is
   * empty (len === 0); otherwise the decoded string.
   *
   * `call(buf, bufLen)` MUST return the REQUIRED full size of the
   * result (write_to_buf in bridge_core_api.cpp returns this).
   */
  private readGrowable(call: (buf: number, bufLen: number) => number): string | null {
    const needed = call(this.scratchPtr, SCRATCH_SIZE);
    if (needed === 0) return null;
    if (needed <= SCRATCH_SIZE) return this.readScratch(needed);
    // Scratch was too small. Alloc a temp buffer and retry.
    const tmp = this.exports.malloc(needed);
    try {
      const got = call(tmp, needed);
      if (got === 0) return null;
      // Defensive: if the result somehow grew between calls, clamp to
      // what we asked for to avoid reading past the buffer.
      const clamped = Math.min(got, needed);
      return decoder.decode(new Uint8Array(this.memory.buffer, tmp, clamped));
    } finally {
      this.exports.free(tmp);
    }
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
    return this.readGrowable((buf, bufLen) =>
      this.exports.bridge_core_poll_outgoing(this.handle, clientId, buf, bufLen));
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

  /**
   * Bumped on every plugin registration. The CHEAP change signal for per-frame
   * consumers (compSeedSchemas): registrations are the only way the /global
   * plugin list grows, so comparing this integer replaces fetching /global —
   * which nlohmann-serializes the ENTIRE state doc (every plugin's schema +
   * state), copies it out of wasm, and JSON.parses it. Doing that each frame
   * just to read plugins.length was >80% of the engine worker's CPU at idle.
   */
  registrationEpoch = 0;

  registerPlugin(id: string, major: number, minor: number, patch: number): string {
    this.registrationEpoch++;
    return this.withString(id, (idPtr, idLen) => {
      return this.readGrowable((buf, bufLen) =>
        this.exports.bridge_core_register_plugin(
          this.handle, idPtr, idLen, major, minor, patch, buf, bufLen)) ?? '';
    });
  }

  registerWithSchema(id: string, major: number, minor: number, patch: number, schemaJson: string): string {
    this.registrationEpoch++;
    return this.withStrings([id, schemaJson], ([[idPtr, idLen], [sPtr, sLen]]) => {
      return this.readGrowable((buf, bufLen) =>
        this.exports.bridge_core_register_with_schema(
          this.handle, idPtr, idLen, major, minor, patch, sPtr, sLen, buf, bufLen)) ?? '';
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
      const json = this.readGrowable((buf, bufLen) =>
        this.exports.bridge_core_get_plugin_state(this.handle, pkPtr, pkLen, buf, bufLen));
      return json === null ? {} : JSON.parse(json);
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
    const path = this.readGrowable((buf, bufLen) =>
      this.exports.bridge_core_get_param_path(this.handle, paramId, buf, bufLen));
    return path ?? `param/${paramId}`;
  }

  // --- State queries ---

  setAt(path: string, value: any): void {
    const json = JSON.stringify(value);
    this.withStrings([path, json], ([[pPtr, pLen], [vPtr, vLen]]) => {
      this.exports.bridge_core_set_at(this.handle, pPtr, pLen, vPtr, vLen);
    });
  }

  getAt(path: string): any {
    return this.withString(path, (ptr, len) => {
      const json = this.readGrowable((buf, bufLen) =>
        this.exports.bridge_core_get_at(this.handle, ptr, len, buf, bufLen));
      return json === null ? null : JSON.parse(json);
    });
  }

  getPluginKey(id: string): string | null {
    return this.withString(id, (ptr, len) =>
      this.readGrowable((buf, bufLen) =>
        this.exports.bridge_core_get_plugin_key(this.handle, ptr, len, buf, bufLen)));
  }

  // --- Val handle store ---

  valNull(): number { return this.exports.bridge_core_val_null(this.handle); }
  valBool(v: boolean): number { return this.exports.bridge_core_val_bool(this.handle, v ? 1 : 0); }
  valNumber(v: number): number { return this.exports.bridge_core_val_number(this.handle, v); }
  valString(s: string): number {
    return this.withString(s, (ptr, len) =>
      this.exports.bridge_core_val_string(this.handle, ptr, len));
  }
  valArray(): number { return this.exports.bridge_core_val_array(this.handle); }
  valObject(): number { return this.exports.bridge_core_val_object(this.handle); }

  valTypeOf(valH: number): number { return this.exports.bridge_core_val_type_of(this.handle, valH); }
  valAsNumber(valH: number): number { return this.exports.bridge_core_val_as_number(this.handle, valH); }
  valAsBool(valH: number): boolean { return this.exports.bridge_core_val_as_bool(this.handle, valH) !== 0; }
  valAsString(valH: number): string {
    return this.readGrowable((buf, bufLen) =>
      this.exports.bridge_core_val_as_string(this.handle, valH, buf, bufLen)) ?? '';
  }

  valGet(objH: number, key: string): number {
    return this.withString(key, (ptr, len) =>
      this.exports.bridge_core_val_get(this.handle, objH, ptr, len));
  }
  valSet(objH: number, key: string, valH: number): void {
    this.withString(key, (ptr, len) => {
      this.exports.bridge_core_val_set(this.handle, objH, ptr, len, valH);
    });
  }
  valKeysCount(objH: number): number { return this.exports.bridge_core_val_keys_count(this.handle, objH); }
  valKeyAt(objH: number, index: number): string {
    return this.readGrowable((buf, bufLen) =>
      this.exports.bridge_core_val_key_at(this.handle, objH, index, buf, bufLen)) ?? '';
  }

  valGetIndex(arrH: number, index: number): number { return this.exports.bridge_core_val_get_index(this.handle, arrH, index); }
  valPush(arrH: number, valH: number): void { this.exports.bridge_core_val_push(this.handle, arrH, valH); }
  valLength(arrH: number): number { return this.exports.bridge_core_val_length(this.handle, arrH); }

  valRelease(valH: number): void { this.exports.bridge_core_val_release(this.handle, valH); }
  valToJson(valH: number): string {
    return this.readGrowable((buf, bufLen) =>
      this.exports.bridge_core_val_to_json(this.handle, valH, buf, bufLen)) ?? '';
  }

  /** Write a val handle's value directly into a plugin's state document. */
  commitVal(pluginKey: string, path: string, valH: number): void {
    this.withStrings([pluginKey, path], ([[pkPtr, pkLen], [pPtr, pLen]]) => {
      this.exports.bridge_core_commit_val(this.handle, pkPtr, pkLen, pPtr, pLen, valH);
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
