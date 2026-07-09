/**
 * MidiManager — the main-thread Web MIDI host.
 *
 * Owns MIDI access, hot-plug (statechange) re-matching of physical ports to
 * device-library instances, one driver per connected instance, and the
 * per-instance control-value tables.
 *
 * Values are deliberately kept OUTSIDE MobX: a device exposes hundreds of
 * endpoints updating at drag rate — the UI polls `getValues()` from a rAF
 * loop (hero-node style) and the engine push is driven by the (throttled)
 * `onValuesChanged` callback. Only coarse state (connections, banks, unknown
 * ports) is mirrored into observables — by `state/midi-controller.ts`, which
 * wires every callback; this module itself knows nothing about appState,
 * MobX, or IndexedDB, so it stays unit-testable with a fake MIDIAccess.
 *
 * Value layering per instance: `hardware ⊕ simulation`. Simulation overrides
 * (on-screen control drags) sit above whatever the hardware last reported;
 * for connected devices the UI clears the override on pointer-up (snap back
 * to real), for disconnected devices it leaves it (sticky, session-only).
 * Drivers integrate relative encoders against the HARDWARE layer only.
 */

import { getDeviceTemplate } from './device-registry';
import { matchInstanceForPort } from './matching';
import type { ControlEvent, DeviceDriver, DeviceInstance, PhysicalIdentity } from './midi-types';

interface ValueTable {
  hardware: Map<string, number>;
  simulated: Map<string, number>;
  /** Merged view cache, rebuilt lazily after any write. */
  merged: ReadonlyMap<string, number> | null;
}

interface ConnectedDevice {
  instanceId: string;
  driver: DeviceDriver;
  input: MIDIInput;
  output: MIDIOutput | null;
}

const EMPTY_VALUES: ReadonlyMap<string, number> = new Map();

export class MidiManager {
  /** Unmatched inputs changed — drives the "define it" snackbar. */
  onUnknownPortsChanged?: (ports: PhysicalIdentity[]) => void;
  onConnectionChanged?: (instanceId: string, connected: boolean) => void;
  onBankChanged?: (instanceId: string, bank: number) => void;
  /** Some endpoint value changed (hardware or simulation). Fired synchronously
   *  per message batch — the listener throttles (rAF) before pushing on. */
  onValuesChanged?: (instanceId: string) => void;
  /** A tuple match succeeded against a port whose platform id isn't stamped on
   *  the instance yet — the listener persists the fast-path id. */
  onIdentityStamp?: (instanceId: string, identityIndex: number, webPortId: string) => void;

  private access: MIDIAccess | null = null;
  private getLibrary: () => readonly DeviceInstance[] = () => [];
  private connected = new Map<string, ConnectedDevice>();
  /** Survives disconnects (sticky simulation on disconnected devices). */
  private tables = new Map<string, ValueTable>();
  private unknown: PhysicalIdentity[] = [];

  /** The instance source for matching (the controller's observable library). */
  bindLibrary(getInstances: () => readonly DeviceInstance[]): void {
    this.getLibrary = getInstances;
  }

  /** Request Web MIDI access (no sysex — lower permission friction). False
   *  when unsupported or denied; safe to call repeatedly. */
  async init(): Promise<boolean> {
    if (this.access) return true;
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) return false;
    try {
      this.attachAccess(await navigator.requestMIDIAccess({ sysex: false }));
      return true;
    } catch (err) {
      console.warn('[midi] requestMIDIAccess failed', err);
      return false;
    }
  }

  /** Adopt a (possibly fake) MIDIAccess — the seam unit tests inject through. */
  attachAccess(access: MIDIAccess): void {
    this.access = access;
    access.onstatechange = () => this.refreshMatching();
    this.refreshMatching();
  }

  get initialized(): boolean { return this.access !== null; }

  isConnected(instanceId: string): boolean { return this.connected.has(instanceId); }

  activeBank(instanceId: string): number { return this.connected.get(instanceId)?.driver.activeBank ?? 0; }

  unknownPorts(): readonly PhysicalIdentity[] { return this.unknown; }

  /** Merged live+sim endpoint values. Cheap: cached until the next write. */
  getValues(instanceId: string): ReadonlyMap<string, number> {
    const table = this.tables.get(instanceId);
    if (!table) return EMPTY_VALUES;
    if (!table.merged) {
      const merged = new Map(table.hardware);
      for (const [k, v] of table.simulated) merged.set(k, v);
      table.merged = merged;
    }
    return table.merged;
  }

  getValue(instanceId: string, controlId: string): number {
    return this.getValues(instanceId).get(controlId) ?? 0;
  }

  /** Inject/clear an on-screen simulation override. `null` clears (connected
   *  snap-back); values clamp to 0..1. */
  setSimulatedValue(instanceId: string, controlId: string, value: number | null): void {
    const table = this.table(instanceId);
    if (value === null) {
      if (!table.simulated.delete(controlId)) return;
    } else {
      table.simulated.set(controlId, Math.min(1, Math.max(0, value)));
    }
    table.merged = null;
    this.onValuesChanged?.(instanceId);
  }

  /** Push full outgoing state (ring echo, colors) to a connected device. */
  renderOutput(instanceId: string): void {
    this.connected.get(instanceId)?.driver.renderOutput(this.getValues(instanceId));
  }

  /** Config was edited — refresh the driver's lookups + hardware state. */
  notifyConfigChanged(instanceId: string): void {
    const device = this.connected.get(instanceId);
    if (!device) return;
    device.driver.configChanged();
    device.driver.renderOutput(this.getValues(instanceId));
  }

  /**
   * Re-derive port↔instance pairings from the current port list + library.
   * Called on statechange, after library edits (claim/fork/delete), and once
   * at attach. Deterministic: inputs in port order, exact-id matches first
   * via matchInstanceForPort, one instance per physical input per pass.
   */
  refreshMatching(): void {
    if (!this.access) return;
    const library = this.getLibrary();
    const inputs = [...this.access.inputs.values()].filter(p => p.state === 'connected');
    const outputs = [...this.access.outputs.values()].filter(p => p.state === 'connected');

    const taken = new Set<string>();
    const usedOutputs = new Set<string>();
    const next = new Map<string, ConnectedDevice>();
    const unknown: PhysicalIdentity[] = [];

    for (const input of inputs) {
      const identity: PhysicalIdentity = {
        name: input.name ?? '',
        manufacturer: input.manufacturer ?? '',
        webPortId: input.id,
      };
      const match = matchInstanceForPort(library, identity, taken);
      if (!match) {
        unknown.push(identity);
        continue;
      }
      taken.add(match.instance.id);
      if (!match.exact) {
        this.onIdentityStamp?.(match.instance.id, match.identityIndex, input.id);
      }
      // Pair the same physical unit's output by (name, manufacturer) — Web
      // MIDI gives in/out distinct ids but identical labeling.
      const output = outputs.find(o =>
        !usedOutputs.has(o.id) && (o.name ?? '') === identity.name &&
        (o.manufacturer ?? '') === identity.manufacturer) ?? null;
      if (output) usedOutputs.add(output.id);

      const existing = this.connected.get(match.instance.id);
      if (existing && existing.input.id === input.id && (existing.output?.id ?? null) === (output?.id ?? null)) {
        next.set(match.instance.id, existing);
        this.connected.delete(match.instance.id);
        continue;
      }
      next.set(match.instance.id, this.openDevice(match.instance.id, input, output));
    }

    // Anything left in `connected` lost its port (or its instance) this pass.
    for (const [instanceId, device] of this.connected) {
      device.input.onmidimessage = null;
      device.driver.dispose();
      this.onConnectionChanged?.(instanceId, false);
    }
    this.connected = next;

    const unknownChanged = JSON.stringify(unknown) !== JSON.stringify(this.unknown);
    this.unknown = unknown;
    if (unknownChanged) this.onUnknownPortsChanged?.(unknown);
  }

  private openDevice(instanceId: string, input: MIDIInput, output: MIDIOutput | null): ConnectedDevice {
    const manager = this;
    const instance = () => manager.getLibrary().find(i => i.id === instanceId);
    const template = getDeviceTemplate(instance()?.templateId ?? '');
    if (!template) throw new Error(`[midi] no template registered for instance ${instanceId}`);
    const table = this.table(instanceId);

    const driver = template.createDriver({
      get config() { return instance()?.config as never; },
      send: bytes => {
        try { output?.send([...bytes]); } catch (err) { console.warn('[midi] send failed', err); }
      },
      emit: (events: ControlEvent[]) => {
        for (const e of events) table.hardware.set(e.controlId, e.value);
        table.merged = null;
        manager.onValuesChanged?.(instanceId);
      },
      getValue: controlId => table.hardware.get(controlId) ?? 0,
      onBankChanged: bank => manager.onBankChanged?.(instanceId, bank),
    });

    input.onmidimessage = (e: MIDIMessageEvent) => {
      if (e.data) driver.onMidiMessage(e.data, e.timeStamp);
    };
    this.onConnectionChanged?.(instanceId, true);
    // Initial hardware sync: ring echo + colors reflect our current state.
    driver.renderOutput(this.getValues(instanceId));
    return { instanceId, driver, input, output };
  }

  private table(instanceId: string): ValueTable {
    let table = this.tables.get(instanceId);
    if (!table) {
      table = { hardware: new Map(), simulated: new Map(), merged: null };
      this.tables.set(instanceId, table);
    }
    return table;
  }

  dispose(): void {
    for (const [instanceId, device] of this.connected) {
      device.input.onmidimessage = null;
      device.driver.dispose();
      this.onConnectionChanged?.(instanceId, false);
    }
    this.connected.clear();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
  }
}
