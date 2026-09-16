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
 * Value layering per instance: `hardware ⊕ simulation ⊕ alias`. Simulation
 * overrides (on-screen control drags) sit above whatever the hardware last
 * reported; for connected devices the UI clears the override on pointer-up
 * (snap back to real), for disconnected devices it leaves it (sticky,
 * session-only). Drivers integrate relative encoders against the HARDWARE
 * layer only. On top of both, a control ALIAS (a device→device wire, see
 * alias-groups.ts) makes a set of endpoints read whichever of them was
 * written most recently — which is why every write stamps a monotonic
 * sequence number, and why alias peers on OTHER devices are re-notified (so
 * their LED rings and on-screen dials follow).
 */

import { getDeviceTemplate } from './device-registry';
import { matchInstanceForPort } from './matching';
import {
  aliasEndpointKey, aliasGroupIndex, aliasWinner,
  type AliasEndpoint, type AliasSample,
} from './alias-groups';
import type { ControlEvent, DeviceDriver, DeviceInstance, PhysicalIdentity } from './midi-types';

interface ValueTable {
  hardware: Map<string, number>;
  simulated: Map<string, number>;
  /** Write sequence per endpoint, per layer — the alias tie-break. */
  hardwareSeq: Map<string, number>;
  simulatedSeq: Map<string, number>;
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
  private initPromise: Promise<boolean> | null = null;
  private getLibrary: () => readonly DeviceInstance[] = () => [];
  private connected = new Map<string, ConnectedDevice>();
  /** Survives disconnects (sticky simulation on disconnected devices). */
  private tables = new Map<string, ValueTable>();
  private unknown: PhysicalIdentity[] = [];
  /** Control aliases, indexed endpointKey → the group it belongs to. Empty in
   *  the overwhelmingly common case, which is the fast path everywhere. */
  private aliases = new Map<string, AliasEndpoint[]>();
  /** Monotonic write counter — stamped on every hardware/sim value write so
   *  an alias group can resolve to its most recently touched member. */
  private writeSeq = 0;

  /** The instance source for matching (the controller's observable library). */
  bindLibrary(getInstances: () => readonly DeviceInstance[]): void {
    this.getLibrary = getInstances;
  }

  /** Request Web MIDI access (no sysex — lower permission friction). False
   *  when unsupported or denied; safe to call repeatedly and concurrently —
   *  boot and the Devices tab race here, and two live MIDIAccess objects
   *  would both fire statechange forever. */
  async init(): Promise<boolean> {
    if (this.access) return true;
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) return false;
    this.initPromise ??= navigator.requestMIDIAccess({ sysex: false }).then(
      access => { this.attachAccess(access); return true; },
      err => {
        console.warn('[midi] requestMIDIAccess failed', err);
        this.initPromise = null;   // allow a retry (e.g. after granting)
        return false;
      });
    return this.initPromise;
  }

  /** Adopt a (possibly fake) MIDIAccess — the seam unit tests inject through. */
  attachAccess(access: MIDIAccess): void {
    this.access = access;
    access.onstatechange = () => this.refreshMatching();
    this.refreshMatching();
  }

  get initialized(): boolean { return this.access !== null; }

  isConnected(instanceId: string): boolean { return this.connected.has(instanceId); }

  /** The physical port an instance is currently paired with — feeds the
   *  "reassign" flow (re-enter define mode for an already-claimed device). */
  connectedPortIdentity(instanceId: string): PhysicalIdentity | null {
    const device = this.connected.get(instanceId);
    if (!device) return null;
    return {
      name: device.input.name ?? '',
      manufacturer: device.input.manufacturer ?? '',
      webPortId: device.input.id,
    };
  }

  activeBank(instanceId: string): number { return this.connected.get(instanceId)?.driver.activeBank ?? 0; }

  unknownPorts(): readonly PhysicalIdentity[] { return this.unknown; }

  /**
   * Replace the control-alias groups (from the document's device→device
   * wires — see state/midi-controller.ts). Cheap and idempotent; every
   * merged-value cache is dropped because a group spans devices.
   */
  setAliasGroups(groups: readonly AliasEndpoint[][]): void {
    const next = aliasGroupIndex(groups);
    if (next.size === 0 && this.aliases.size === 0) return;
    this.aliases = next;
    for (const table of this.tables.values()) table.merged = null;
  }

  /** One endpoint's own (pre-alias) value + write sequence. Simulation wins
   *  over hardware for the same endpoint, as it does in the plain merge. */
  private sampleEndpoint(ep: AliasEndpoint): AliasSample | undefined {
    const table = this.tables.get(ep.deviceId);
    if (!table) return undefined;
    const sim = table.simulated.get(ep.field);
    if (sim !== undefined) return { value: sim, seq: table.simulatedSeq.get(ep.field) ?? 0 };
    const hw = table.hardware.get(ep.field);
    if (hw === undefined) return undefined;
    return { value: hw, seq: table.hardwareSeq.get(ep.field) ?? 0 };
  }

  /** Merged live+sim+alias endpoint values. Cheap: cached until the next
   *  write (any write, once aliases exist — a group spans devices). */
  getValues(instanceId: string): ReadonlyMap<string, number> {
    // A device that has never reported anything still shows aliased values —
    // its peer may be the only one anyone has touched — so materialize a
    // table for it rather than recomputing the overlay on every rAF read.
    const table = this.tables.get(instanceId)
      ?? (this.aliases.size > 0 ? this.table(instanceId) : undefined);
    if (!table) return EMPTY_VALUES;
    if (!table.merged) {
      const merged = new Map(table.hardware);
      for (const [k, v] of table.simulated) merged.set(k, v);
      table.merged = this.aliases.size > 0 ? this.applyAliases(instanceId, merged) : merged;
    }
    return table.merged;
  }

  /**
   * Overlay this device's aliased endpoints with their group's winner. An
   * endpoint the device itself has never reported still lands in the map when
   * a peer has a value — that is what makes a spare controller show the live
   * desk's positions the moment it is plugged in.
   */
  private applyAliases(
    instanceId: string, merged: Map<string, number>,
  ): ReadonlyMap<string, number> {
    for (const [key, group] of this.aliases) {
      const sep = key.indexOf('\u0000');
      if (key.slice(0, sep) !== instanceId) continue;
      const winner = aliasWinner(group, ep => this.sampleEndpoint(ep));
      if (winner) merged.set(key.slice(sep + 1), winner.value);
    }
    return merged;
  }

  /** Every OTHER device sharing an alias group with one of `fields` — their
   *  merged values just changed too, so their listeners must re-render. */
  private aliasPeers(instanceId: string, fields: Iterable<string>): Set<string> {
    const peers = new Set<string>();
    if (this.aliases.size === 0) return peers;
    for (const field of fields) {
      const group = this.aliases.get(aliasEndpointKey(instanceId, field));
      if (!group) continue;
      for (const ep of group) if (ep.deviceId !== instanceId) peers.add(ep.deviceId);
    }
    return peers;
  }

  /** Invalidate every cross-device merged cache after a write into an alias
   *  group, then fan the change notification out to the peers. */
  private notifyValues(instanceId: string, fields: Iterable<string>): void {
    const peers = this.aliasPeers(instanceId, fields);
    if (peers.size > 0) {
      for (const table of this.tables.values()) table.merged = null;
    }
    this.onValuesChanged?.(instanceId);
    for (const peer of peers) this.onValuesChanged?.(peer);
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
      table.simulatedSeq.delete(controlId);
    } else {
      table.simulated.set(controlId, Math.min(1, Math.max(0, value)));
      table.simulatedSeq.set(controlId, ++this.writeSeq);
    }
    table.merged = null;
    this.notifyValues(instanceId, [controlId]);
  }

  /** Push full outgoing state (ring echo, colors) to a connected device. */
  renderOutput(instanceId: string): void {
    this.connected.get(instanceId)?.driver.renderOutput(this.getValues(instanceId));
  }

  /** All live simulation overrides, per instance — the blob mirrored to the
   *  native host in live mode (/global/midi_sim). {} when nothing is
   *  simulated. */
  getSimulatedTable(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [instanceId, table] of this.tables) {
      if (table.simulated.size === 0) continue;
      out[instanceId] = Object.fromEntries(table.simulated);
    }
    return out;
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
      // Pair the same physical unit's output. Identical in/out labeling is
      // the common case (the Twister reports 'Midi Fighter Twister' both
      // ways) but NOT universal: a nanoKONTROL2 presents its input as
      // 'nanoKONTROL2 SLIDER/KNOB' and its output as 'nanoKONTROL2 CTRL'.
      // An exact-tuple rule leaves such a unit with output null, so every
      // LED write becomes a silent no-op with nothing logged — so fall back
      // to the template's own portMatchers, which already describe what this
      // model's ports are called. Same manufacturer is required either way,
      // so a matcher can't reach across to a different vendor's port.
      const free = outputs.filter(o => !usedOutputs.has(o.id) &&
        (o.manufacturer ?? '') === identity.manufacturer);
      const template = getDeviceTemplate(match.instance.templateId);
      const output = free.find(o => (o.name ?? '') === identity.name)
        ?? free.find(o => template?.portMatchers.some(re =>
          re.test(o.name ?? '') || re.test(`${o.manufacturer ?? ''} ${o.name ?? ''}`)))
        ?? null;
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
    // If the port was REASSIGNED to another instance (define-mode reassign),
    // openDevice above already installed the new handler on the same input —
    // don't null it out from under the new owner. Same idea for the
    // connection callback: an instance that REOPENED on a different port id
    // this pass (replug whose unplug event was missed/coalesced) is in
    // `next` — its stale pairing must not fire (id, false) AFTER openDevice
    // fired (id, true), or the UI shows disconnected while the knobs work.
    const reassignedInputs = new Set([...next.values()].map(d => d.input.id));
    for (const [instanceId, device] of this.connected) {
      if (!reassignedInputs.has(device.input.id)) device.input.onmidimessage = null;
      device.driver.dispose();
      if (!next.has(instanceId)) this.onConnectionChanged?.(instanceId, false);
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
        for (const e of events) {
          table.hardware.set(e.controlId, e.value);
          table.hardwareSeq.set(e.controlId, ++manager.writeSeq);
        }
        table.merged = null;
        manager.notifyValues(instanceId, events.map(e => e.controlId));
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
      table = {
        hardware: new Map(), simulated: new Map(),
        hardwareSeq: new Map(), simulatedSeq: new Map(), merged: null,
      };
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
    this.initPromise = null;
  }
}
