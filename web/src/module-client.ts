import { observable, action, makeObservable, runInAction } from 'mobx';
import type { WasmHost, WasmModule, ConsoleEntry, ParamDecl } from './wasm-host';

/**
 * Observable store for a module's state. Editors bind to this reactively.
 * Updated automatically when the WASM module publishes state via state.set.
 */
export class ObservableModuleState {
  @observable.ref state: any = {};
  @observable.ref metadata: { id: string; version: string } | null = null;
  @observable.shallow params: ParamDecl[] = [];
  @observable.shallow consoleLogs: ConsoleEntry[] = [];

  constructor() {
    makeObservable(this);
  }

  @action
  updateState(newState: any) {
    this.state = newState;
  }

  @action
  updateMetadata(meta: { id: string; version: string } | null) {
    this.metadata = meta;
  }

  @action
  updateParams(params: ParamDecl[]) {
    this.params = params;
  }

  @action
  addLog(entry: ConsoleEntry) {
    this.consoleLogs = [...this.consoleLogs.slice(-99), entry];
  }
}

/**
 * Client interface for an editor to interact with a module's state.
 * Wraps the WasmHost and WasmModule, presenting an async-friendly API
 * that mirrors what a real WebSocket client would look like.
 */
export class ModuleClient {
  readonly store: ObservableModuleState;
  readonly pluginKey: string;

  private host: WasmHost;
  private wasmModule: WasmModule;
  private prevOnStateChange: ((state: any) => void) | null = null;
  private prevOnLog: ((entry: ConsoleEntry) => void) | null = null;

  constructor(pluginKey: string, host: WasmHost, wasmModule: WasmModule) {
    this.pluginKey = pluginKey;
    this.host = host;
    this.wasmModule = wasmModule;
    this.store = new ObservableModuleState();

    // Seed from current host state
    runInAction(() => {
      this.store.updateState(host.pluginState);
      this.store.updateMetadata(host.metadata);
      this.store.updateParams([...host.params]);
      for (const log of host.consoleLogs) {
        this.store.addLog(log);
      }
    });

    // Hook into state changes
    this.prevOnStateChange = host.onStateChange;
    host.onStateChange = (state) => {
      this.store.updateState(state);
      this.prevOnStateChange?.(state);
    };

    this.prevOnLog = host.onLog;
    host.onLog = (entry) => {
      this.store.addLog(entry);
      this.prevOnLog?.(entry);
    };
  }

  /** Get current state snapshot */
  getState(): any {
    return this.host.pluginState;
  }

  /** Write to the module's state (triggers on_state_changed) */
  patchState(partialState: Record<string, any>) {
    const current = this.host.pluginState;
    this.host.pluginState = { ...current, ...partialState };
    this.wasmModule.onStateChanged();
  }

  /** Set a plugin parameter (like pressing a button) */
  setParam(index: number, value: number) {
    this.host.frameState.params[index] = value;
    this.wasmModule.onParamChange(index, value);
  }

  /** Pulse a boolean parameter (press then release) */
  pulseParam(index: number) {
    this.setParam(index, 1.0);
    // Release on next microtask
    queueMicrotask(() => this.setParam(index, 0.0));
  }

  dispose() {
    if (this.prevOnStateChange) {
      this.host.onStateChange = this.prevOnStateChange;
    }
    if (this.prevOnLog) {
      this.host.onLog = this.prevOnLog;
    }
  }
}
