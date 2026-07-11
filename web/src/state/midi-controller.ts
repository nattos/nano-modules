/**
 * MidiController — glue between the MIDI world and the app.
 *
 * Owns the `MidiManager` (Web MIDI host) and the persisted device library,
 * mirroring coarse state into `appState.local.midi` (library, connections,
 * banks, unknown ports). Kept separate from AppController deliberately — the
 * device library is app-level and cross-sketch, not part of the undoable
 * database, and none of this belongs in the (already large) sketch controller.
 *
 * Every mutating action here explicitly persists (debounced per instance) and
 * explicitly refreshes matching / driver state — no MobX reactions drive
 * persistence or engine sync (repo rule).
 *
 * Lazy forking: templates are read-only factory originals. Any edit routed
 * through `ensureInstanceForEdit` transparently forks a template into a real
 * `DeviceInstance` first; callers re-target to the returned id.
 */

import { runInAction, toJS } from 'mobx';
import { getDeviceTemplate } from '../midi/device-registry';
import { forkInstance } from '../midi/matching';
import { MidiManager } from '../midi/midi-manager';
import type { ControlMapping, DeviceInstance, PhysicalIdentity } from '../midi/midi-types';
import { buildExternalScalars } from '../midi/wire-lowering';
import { appState } from './app-state';
import { loadDeviceLibrary, saveDeviceInstance } from './midi-device-store';

// Driver modules self-register their templates on import. Main thread only.
import '../midi/drivers/mft';

const SAVE_DEBOUNCE_MS = 300;

export class MidiController {
  readonly manager = new MidiManager();

  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pushQueued: Set<string> | null = null;
  private enginePush: ((json: string) => void) | null = null;
  private lastPushedJson = '';
  private bridge: { library: (instances: unknown) => void; sim: (table: unknown) => void } | null = null;
  private lastSimJson = '';

  constructor() {
    const midi = () => appState.local.midi;
    this.manager.bindLibrary(() => midi().library);
    this.manager.onConnectionChanged = (id, connected) => runInAction(() => {
      if (connected) midi().connected[id] = true;
      else delete midi().connected[id];
    });
    this.manager.onBankChanged = (id, bank) => runInAction(() => {
      midi().activeBanks[id] = bank;
    });
    this.manager.onUnknownPortsChanged = ports => runInAction(() => {
      midi().unknownPorts = ports.slice();
    });
    this.manager.onIdentityStamp = (id, identityIndex, webPortId) => {
      const instance = this.instance(id);
      const identity = instance?.identities[identityIndex];
      if (!instance || !identity) return;
      runInAction(() => { identity.webPortId = webPortId; instance.updatedAt = Date.now(); });
      this.schedulePersist(instance);
    };
    this.manager.onValuesChanged = id => this.scheduleValuePush(id);
  }

  // --- Boot ---

  /** Restore the library from IndexedDB (all app modes — devices are
   *  app-level). Requests MIDI access right away when the user already owns
   *  devices; an empty library defers the permission prompt to the first
   *  Devices-tab visit (`initMidi`). */
  async loadLibrary(): Promise<void> {
    const rows = await loadDeviceLibrary();
    runInAction(() => { appState.local.midi.library = rows; });
    if (rows.length > 0) void this.initMidi();
  }

  /** Request Web MIDI access + start matching. Safe to call repeatedly. */
  async initMidi(): Promise<boolean> {
    return this.manager.init();
  }

  // --- Library lookups ---

  instance(id: string): DeviceInstance | undefined {
    return appState.local.midi.library.find(i => i.id === id);
  }

  // --- Mutating actions ---

  /**
   * Resolve an edit target to a real instance, lazily forking a template on
   * first edit. `id` may be a template id or an instance id; returns the
   * instance (possibly freshly created — callers re-target UI state to it).
   */
  ensureInstanceForEdit(id: string): DeviceInstance {
    const existing = this.instance(id);
    if (existing) return existing;
    const template = getDeviceTemplate(id);
    if (!template) throw new Error(`[midi] unknown device/template id: ${id}`);
    return this.addFork(forkInstance(template, this.libraryNames()));
  }

  /**
   * Define-mode commit: bind a physical port to `sourceId`. A template forks
   * first (lazy-fork rule); an EXISTING instance claims the port directly —
   * forking a copy here would strand the instance's wires on the original
   * while the hardware feeds the copy (knobs turn, nothing moves).
   *
   * The claim is exclusive: the same platform port id is revoked from every
   * other instance, so repeated defines can't leave stale claims that steal
   * the device back by library order. Tuple-only identities on OTHER
   * instances are left alone — they may be a second identical unit.
   */
  claimPort(sourceId: string, port: PhysicalIdentity): DeviceInstance {
    const instance = this.ensureInstanceForEdit(sourceId);
    runInAction(() => {
      // Refresh an existing tuple claim in place (re-define after an id
      // drift) rather than accumulating one identity per define.
      const existing = instance.identities.find(
        i => i.name === port.name && i.manufacturer === port.manufacturer);
      if (existing) existing.webPortId = port.webPortId;
      else instance.identities.push({ ...port });
      instance.updatedAt = Date.now();

      if (port.webPortId !== undefined) {
        for (const other of appState.local.midi.library) {
          if (other.id === instance.id) continue;
          const kept = other.identities.filter(i => i.webPortId !== port.webPortId);
          if (kept.length !== other.identities.length) {
            other.identities = kept;
            other.updatedAt = Date.now();
            this.schedulePersist(other);
          }
        }
      }
    });
    this.schedulePersist(instance);
    this.manager.refreshMatching();
    return instance;
  }

  renameDevice(id: string, name: string): void {
    const instance = this.ensureInstanceForEdit(id);
    runInAction(() => { instance.name = name; instance.updatedAt = Date.now(); });
    this.schedulePersist(instance);
  }

  /** Read an endpoint's MIDI mapping (works on templates too — read-only). */
  getControlMapping(id: string, endpointField: string): ControlMapping | null {
    const instance = this.instance(id);
    const template = getDeviceTemplate(instance?.templateId ?? id);
    if (!template) return null;
    return template.mapping.get(instance?.config ?? template.defaultConfig, endpointField);
  }

  /**
   * Apply one mapping patch to several endpoints (single edit = one endpoint).
   * Lazy-forks templates; returns the (possibly new) instance id.
   */
  updateControlMapping(id: string, endpointFields: string[], patch: ControlMapping): string {
    const instance = this.ensureInstanceForEdit(id);
    const template = getDeviceTemplate(instance.templateId)!;
    runInAction(() => {
      for (const field of endpointFields) template.mapping.set(instance.config, field, patch);
      instance.updatedAt = Date.now();
    });
    this.afterConfigEdit(instance);
    return instance.id;
  }

  /**
   * Multi-select numeric edit: SHIFT each endpoint's `key` by `delta` (rather
   * than setting them all to one value), clamped to the 7-bit/channel range.
   */
  shiftControlMappings(id: string, endpointFields: string[], key: 'cc' | 'channel', delta: number): string {
    const instance = this.ensureInstanceForEdit(id);
    const template = getDeviceTemplate(instance.templateId)!;
    const max = key === 'cc' ? 127 : 15;
    runInAction(() => {
      for (const field of endpointFields) {
        const current = template.mapping.get(instance.config, field)?.[key];
        if (current === undefined) continue;
        const next = Math.min(max, Math.max(0, current + delta));
        template.mapping.set(instance.config, field, { [key]: next });
      }
      instance.updatedAt = Date.now();
    });
    this.afterConfigEdit(instance);
    return instance.id;
  }

  softDeleteDevice(id: string): void {
    const instance = this.instance(id);
    if (!instance) return;
    runInAction(() => { instance.deleted = true; instance.updatedAt = Date.now(); });
    this.schedulePersist(instance);
    this.manager.refreshMatching();
  }

  restoreDevice(id: string): void {
    const instance = this.instance(id);
    if (!instance) return;
    runInAction(() => { delete instance.deleted; instance.updatedAt = Date.now(); });
    this.schedulePersist(instance);
    this.manager.refreshMatching();
  }

  // --- Engine push (external scalars) ---

  /** Boot wires this to `engine.setExternalScalars` (see boot.ts). */
  bindEnginePush(push: (json: string) => void): void {
    this.enginePush = push;
    this.lastPushedJson = '';
    this.pushExternalScalars();
  }

  /**
   * Live-mode bridge mirror (boot-resolume wires this once the barrel WS
   * client exists): the device library rides /global/midi_devices (so the
   * native CoreMIDI host maps hardware headlessly) and on-screen simulation
   * overrides ride /global/midi_sim (native merges them over its own
   * hardware values). Call again on reconnect — it re-pushes the library.
   */
  bindBridge(bridge: { library: (instances: unknown) => void; sim: (table: unknown) => void } | null): void {
    this.bridge = bridge;
    this.lastSimJson = '';
    if (bridge) this.mirrorLibrary();
  }

  private mirrorLibrary(): void {
    if (!this.bridge) return;
    this.bridge.library(toJS(appState.local.midi.library));
  }

  private mirrorSim(): void {
    if (!this.bridge) return;
    const table = this.manager.getSimulatedTable();
    const json = JSON.stringify(table);
    if (json === this.lastSimJson) return;
    this.lastSimJson = json;
    this.bridge.sim(table);
  }

  /**
   * Lower the current device values through the sketches' `midi:` wires into
   * the executor's external-scalar table. Called from the rAF-coalesced value
   * trigger below AND from AppController's postRecord hook (wire edits change
   * which endpoints are referenced). Deduped by JSON compare — identical
   * states cost one string build, no worker message.
   */
  pushExternalScalars(): void {
    if (!this.enginePush) return;
    const json = buildExternalScalars(
      appState.database.sketches, id => this.manager.getValues(id));
    if (json === this.lastPushedJson) return;
    this.lastPushedJson = json;
    this.enginePush(json);
  }

  // --- Internals ---

  private libraryNames(): string[] {
    return appState.local.midi.library.map(i => i.name);
  }

  private addFork(fork: DeviceInstance): DeviceInstance {
    runInAction(() => { appState.local.midi.library.push(fork); });
    const instance = this.instance(fork.id)!;   // the observable proxy
    this.schedulePersist(instance);
    this.manager.refreshMatching();
    return instance;
  }

  private afterConfigEdit(instance: DeviceInstance): void {
    this.schedulePersist(instance);
    this.manager.notifyConfigChanged(instance.id);
    this.manager.refreshMatching();
  }

  /** Debounced per-instance IndexedDB save (color drags edit at pointer rate). */
  private schedulePersist(instance: DeviceInstance): void {
    const prior = this.saveTimers.get(instance.id);
    if (prior !== undefined) clearTimeout(prior);
    this.saveTimers.set(instance.id, setTimeout(() => {
      this.saveTimers.delete(instance.id);
      saveDeviceInstance(instance).catch(err =>
        console.warn('[midi] failed to persist device instance', instance.id, err));
      // Keep the native host's copy in step with every library edit.
      this.mirrorLibrary();
    }, SAVE_DEBOUNCE_MS));
  }

  /** Coalesce high-rate value changes to one push + LED render per frame. */
  private scheduleValuePush(instanceId: string): void {
    if (this.pushQueued) { this.pushQueued.add(instanceId); return; }
    this.pushQueued = new Set([instanceId]);
    const flush = () => {
      const ids = this.pushQueued!;
      this.pushQueued = null;
      for (const id of ids) this.manager.renderOutput(id);
      this.pushExternalScalars();
      this.mirrorSim();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }
}

export const midiController = new MidiController();
