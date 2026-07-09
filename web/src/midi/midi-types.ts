/**
 * MIDI device model — templates, instances, drivers, and endpoint identity.
 *
 * A *device* is three things:
 *  1. A data-driven UI layout mirroring the physical hardware (`DeviceLayout`).
 *  2. Code-backed MIDI in/out mapping (`DeviceDriver`, the Ableton-remote-script
 *     model): the driver owns the wire protocol; everything remappable lives in
 *     the template's config type so forks customize DATA, not code.
 *  3. An instance with ShaderToy-style provenance (`DeviceInstance`): templates
 *     are code-registered factory originals, lazily forked on first edit.
 *     Lineage is bookkeeping only — forks have no behavioral link to ancestors.
 *
 * Endpoint identity: device controls are wire SOURCES addressed as
 * `Wire.src = { instanceKey: 'midi:<instanceId>', field: '<controlId>/<gesture>' }`
 * where controlId is LOGICAL (bank/position, e.g. 'b0/e05') — never a MIDI
 * address, so remapping a CC in a fork can't break wires. Every endpoint
 * publishes a normalized unsigned 0..1 value (buttons 0/1; relative encoders
 * are integrated to absolute by the driver).
 *
 * This module is pure types + string helpers — safe to import from workers.
 */

/** A wireable signal on a physical control. */
export type ControlGesture = 'turn' | 'press' | 'shift';

/** One physical control in a template's layout, positioned in a normalized
 *  0..1 coordinate space within the device body. Wire endpoint fields are
 *  `${id}/${gesture}` for each supported gesture. */
export interface DeviceControlDef {
  /** Stable logical id, e.g. 'b0/e05' (bank 0, encoder 5). */
  id: string;
  kind: 'encoder' | 'slider' | 'button' | 'pad';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Bank this control belongs to; absent = shown on all banks. */
  bank?: number;
  gestures: ControlGesture[];
  label?: string;
}

export interface DeviceLayout {
  /** Width / height of the device body. */
  aspect: number;
  /** Number of banks (1 = unbanked). */
  banks: number;
  controls: DeviceControlDef[];
}

/**
 * How a physical unit is recognized across sessions. Web MIDI port ids are NOT
 * stable across browsers/machines, so matching is by (name, manufacturer)
 * tuple; the platform-specific ids are opportunistic fast-paths re-stamped
 * whenever a match succeeds.
 */
export interface PhysicalIdentity {
  name: string;
  manufacturer: string;
  /** Last-seen Web MIDI port id (this browser only). */
  webPortId?: string;
  /** Last-seen CoreMIDI unique id (native host only). */
  coreMidiId?: number;
}

/** Normalized control update emitted by a driver (or injected as simulation).
 *  `controlId` is the full endpoint field, e.g. 'b0/e05/turn'; value is 0..1. */
export interface ControlEvent {
  controlId: string;
  value: number;
}

/** Host services handed to a driver instance. */
export interface DriverContext<C = unknown> {
  /** Live view of the owning instance's config (edited in place by the UI;
   *  the host calls `DeviceDriver.configChanged()` after mutations). */
  readonly config: C;
  /** Send raw bytes to the device's MIDI output (no-op when disconnected). */
  send(bytes: number[] | Uint8Array): void;
  /** Publish normalized control updates into the host's value table. */
  emit(events: ControlEvent[]): void;
  /** Read the current hardware value of an endpoint (0..1; 0 when unknown).
   *  Simulation overrides are deliberately NOT visible here — drivers integrate
   *  relative deltas against real hardware state only. */
  getValue(controlId: string): number;
  /** The device reported a bank change (side buttons on the hardware). */
  onBankChanged(bank: number): void;
}

/**
 * A device's protocol brain: parses raw MIDI into normalized control events and
 * renders outgoing state (LED rings, colors) back to the hardware. Semantics
 * are kept lock-step with the native C++ driver (shared golden fixtures) so
 * web and native produce identical ids/values.
 */
export interface DeviceDriver {
  /** Parse one raw MIDI message; calls ctx.emit / ctx.onBankChanged. */
  onMidiMessage(data: Uint8Array, timestampMs: number): void;
  /** Push full outgoing state (ring positions, colors) to the device. */
  renderOutput(values: ReadonlyMap<string, number>): void;
  /** Config was mutated (CC remap, colors) — refresh lookups + hardware. */
  configChanged(): void;
  readonly activeBank: number;
  dispose(): void;
}

/**
 * A control endpoint's MIDI address as shown/edited in the details panel.
 * Which fields apply is template-specific; absent fields aren't editable for
 * that endpoint.
 */
export interface ControlMapping {
  cc?: number;
  /** 0-based MIDI channel. */
  channel?: number;
  mode?: 'absolute' | 'relative';
  /** Device color values 0..127 (visual customization, not addressing). */
  ringColor?: number;
  capColor?: number;
}

/** A factory device model, registered in code (see device-registry.ts). */
export interface DeviceTemplate<C = unknown> {
  /** Reverse-DNS id, e.g. 'com.nano.midi.mft'. */
  templateId: string;
  name: string;
  vendor: string;
  layout: DeviceLayout;
  /** Factory state — ALL protocol constants (channels, CC maps, colors) live
   *  here as data so a fork's customizations are config edits, not code. */
  defaultConfig: C;
  /** Ranks unknown-port suggestions in define mode. */
  portMatchers: RegExp[];
  createDriver(ctx: DriverContext<C>): DeviceDriver;
  /**
   * Generic mapping accessors — how the details panel reads/edits an
   * endpoint's MIDI address inside this template's opaque config. `set`
   * mutates `config` in place (the host persists + calls
   * `DeviceDriver.configChanged()` afterwards).
   */
  mapping: {
    get(config: C, endpointField: string): ControlMapping | null;
    set(config: C, endpointField: string, patch: ControlMapping): void;
  };
}

/** A user-owned fork of a template (or of another instance). Persisted in the
 *  device library (IndexedDB; mirrored to the bridge for the native host). */
export interface DeviceInstance<C = unknown> {
  /** uuid; the wire namespace is `midi:<id>`. */
  id: string;
  templateId: string;
  /** Lineage: the instance id this was forked from, or the templateId when
   *  forked straight off the factory original. Bookkeeping only. */
  parentId: string;
  forkedAt: number;
  /** User-editable display name ('Twister #2'). */
  name: string;
  /** Full config copy at fork time, edited in place afterwards. */
  config: C;
  /** Physical units claimed by this instance. */
  identities: PhysicalIdentity[];
  /** Soft delete — kept around for wire provenance + restore. */
  deleted?: boolean;
  updatedAt: number;
}

// --- Endpoint identity helpers ---

export const MIDI_INSTANCE_PREFIX = 'midi:';

/** The Wire.src.instanceKey namespace for a device instance. */
export function midiInstanceKey(deviceInstanceId: string): string {
  return MIDI_INSTANCE_PREFIX + deviceInstanceId;
}

export function isMidiInstanceKey(instanceKey: string): boolean {
  return instanceKey.startsWith(MIDI_INSTANCE_PREFIX);
}

/** Extract the device instance id from a `midi:<uuid>` key (null if not one). */
export function midiInstanceIdFromKey(instanceKey: string): string | null {
  return isMidiInstanceKey(instanceKey)
    ? instanceKey.slice(MIDI_INSTANCE_PREFIX.length)
    : null;
}

const CONTROL_GESTURES: readonly ControlGesture[] = ['turn', 'press', 'shift'];

/** Logical id of a banked, indexed control: 'b<bank>/e<idx, 2 digits>'. */
export function bankedControlId(bank: number, index: number): string {
  return `b${bank}/e${String(index).padStart(2, '0')}`;
}

/** Full endpoint field for one gesture on a control: 'b0/e05/turn'. */
export function controlEndpoint(controlId: string, gesture: ControlGesture): string {
  return `${controlId}/${gesture}`;
}

export interface ParsedControlId {
  bank: number;
  index: number;
  gesture: ControlGesture;
  /** The physical control id ('b0/e05') without the gesture segment. */
  controlId: string;
}

/** Parse an endpoint field ('b0/e05/turn'). Null on any malformed input. */
export function parseControlId(field: string): ParsedControlId | null {
  const m = /^b(\d+)\/e(\d+)\/([a-z-]+)$/.exec(field);
  if (!m) return null;
  const gesture = m[3] as ControlGesture;
  if (!CONTROL_GESTURES.includes(gesture)) return null;
  const bank = Number(m[1]);
  const index = Number(m[2]);
  return { bank, index, gesture, controlId: bankedControlId(bank, index) };
}
