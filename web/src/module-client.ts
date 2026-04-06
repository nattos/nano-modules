import { observable, action, makeObservable, runInAction } from 'mobx';
import type { WasmHost, WasmModule, ConsoleEntry, ParamDecl } from './wasm-host';
import type { BridgeCoreClient } from './bridge-core';

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
 * When a BridgeCoreClient is available, uses the JSON patch protocol.
 * Otherwise falls back to direct host state access.
 */
export class ModuleClient {
  readonly store: ObservableModuleState;
  readonly pluginKey: string;

  private host: WasmHost;
  private wasmModule: WasmModule;
  private bridgeClient: BridgeCoreClient | null;
  private prevOnStateChange: ((state: any) => void) | null = null;
  private prevOnLog: ((entry: ConsoleEntry) => void) | null = null;

  constructor(pluginKey: string, host: WasmHost, wasmModule: WasmModule,
              bridgeClient?: BridgeCoreClient) {
    this.pluginKey = pluginKey;
    this.host = host;
    this.wasmModule = wasmModule;
    this.bridgeClient = bridgeClient ?? null;
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

    if (this.bridgeClient) {
      // Observe state and console via the patch protocol
      this.bridgeClient.observe(`/plugins/${pluginKey}/state`);
      this.bridgeClient.observe(`/plugins/${pluginKey}/console`);

      this.bridgeClient.onPatch((ops) => {
        // When patches arrive, refresh state from bridge core
        const newState = host.bridgeCore?.getPluginState(pluginKey) ?? host.pluginState;
        runInAction(() => {
          this.store.updateState(newState);
        });
      });
    }

    // Hook into state changes (for both bridge core and legacy paths)
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
    if (this.host.bridgeCore) {
      return this.host.bridgeCore.getPluginState(this.pluginKey);
    }
    return this.host.pluginState;
  }

  /** Write to the module's state (triggers on_state_changed) */
  patchState(partialState: Record<string, any>) {
    if (this.bridgeClient && this.host.bridgeCore) {
      // Use the JSON patch protocol
      const ops = Object.entries(partialState).map(([key, value]) => ({
        op: 'replace',
        path: `/${key}`,
        value,
      }));
      this.bridgeClient.patch(`/plugins/${this.pluginKey}/state`, ops);
      // Tick to process the patch
      this.host.bridgeCore.tick();
      // Update local cache
      this.host.pluginState = this.host.bridgeCore.getPluginState(this.pluginKey);
    } else {
      const current = this.host.pluginState;
      this.host.pluginState = { ...current, ...partialState };
    }
    this.wasmModule.onStateChanged?.();
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

  /** Drain messages from the bridge core client (call each frame). */
  drainMessages(): void {
    this.bridgeClient?.drain();
  }

  dispose() {
    if (this.bridgeClient) {
      this.bridgeClient.dispose();
      this.bridgeClient = null;
    }
    if (this.prevOnStateChange) {
      this.host.onStateChange = this.prevOnStateChange;
    }
    if (this.prevOnLog) {
      this.host.onLog = this.prevOnLog;
    }
  }
}
