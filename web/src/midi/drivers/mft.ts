/**
 * Midi Fighter Twister (DJ TechTools) — template + driver.
 *
 * 4 banks x 16 rotary encoders; each encoder has a push button and a "shifted"
 * rotation (a different CC sent while the button is held, when the hardware is
 * configured that way). Wire endpoints per encoder: turn / press / shift.
 *
 * ALL protocol constants live in MftConfig (the template's defaultConfig) so a
 * fork's remapped CCs/channels/colors are pure data edits. Factory defaults
 * below follow the MF Twister manual's stock mapping:
 *   - encoder rotation:  CC 0..63 on channel 1 (bank*16 + index)
 *   - encoder buttons:   CC 0..63 on channel 2
 *   - shifted rotation:  CC 0..63 on channel 5
 *   - bank-change notifications: CC 0..3 (value 127) on channel 4
 *   - LED ring position echo: same CC/channel as the rotation
 *   - RGB (cap) color:   value 0..127 hue on the button channel
 * VERIFY against the hardware / MF Utility during bring-up — corrections are
 * defaultConfig data edits, not code changes. Ring *color* is not runtime
 * settable over plain CC (utility/sysex only), so `colors[].ring` is consumed
 * by the on-screen rendering alone for now.
 *
 * Parse/emit semantics are kept lock-step with the native C++ driver
 * (native/src/midi/mft_driver.h) via the shared goldens in mft.test.ts.
 */

import {
  bankedControlId, controlEndpoint, ControlMapping, DeviceDriver, DeviceLayout,
  DeviceTemplate, DriverContext, parseControlId,
} from '../midi-types';
import { registerDeviceTemplate } from '../device-registry';

export const MFT_TEMPLATE_ID = 'com.nano.midi.mft';

export const MFT_BANKS = 4;
export const MFT_ENCODERS_PER_BANK = 16;
const SLOTS = MFT_BANKS * MFT_ENCODERS_PER_BANK;

export interface MftEncoderConfig {
  cc: number;
  /** 'absolute': value 0..127 is the position. 'relative': offset-64 deltas
   *  (63 = -1, 65 = +1, faster spins send larger offsets), integrated by the
   *  driver against the current hardware value. */
  mode: 'absolute' | 'relative';
}

export interface MftConfig {
  /** 0-based MIDI channels. */
  channels: { encoder: number; button: number; shift: number; system: number };
  /** Indexed by slot = bank*16 + encoderIndex, 64 entries each. */
  encoders: MftEncoderConfig[];
  buttons: { cc: number }[];
  shift: { cc: number }[];
  /** Device color values 0..127 (the MFT hue wheel). `ring` is on-screen only
   *  for now (see header); `cap` is transmitted as the RGB color. */
  colors: { ring?: number; cap?: number }[];
}

export function defaultMftConfig(): MftConfig {
  const slots = [...Array(SLOTS).keys()];
  return {
    channels: { encoder: 0, button: 1, shift: 4, system: 3 },
    encoders: slots.map(i => ({ cc: i, mode: 'absolute' as const })),
    buttons: slots.map(i => ({ cc: i })),
    shift: slots.map(i => ({ cc: i })),
    colors: slots.map(() => ({})),
  };
}

function mftLayout(): DeviceLayout {
  const controls = [];
  for (let bank = 0; bank < MFT_BANKS; bank++) {
    for (let idx = 0; idx < MFT_ENCODERS_PER_BANK; idx++) {
      const col = idx % 4;
      const row = Math.floor(idx / 4);
      controls.push({
        id: bankedControlId(bank, idx),
        kind: 'encoder' as const,
        x: 0.03 + col * 0.25,
        y: 0.03 + row * 0.25,
        w: 0.19,
        h: 0.19,
        bank,
        gestures: ['turn', 'press', 'shift'] as const as ('turn' | 'press' | 'shift')[],
        label: `${idx + 1}`,
      });
    }
  }
  return { aspect: 1, banks: MFT_BANKS, controls };
}

const CC_STATUS = 0xb0;

export class MftDriver implements DeviceDriver {
  private bank = 0;
  /** cc → slots, per lookup kind; rebuilt lazily after configChanged(). */
  private lookups: { encoder: Map<number, number[]>; button: Map<number, number[]>; shift: Map<number, number[]> } | null = null;
  /** Last transmitted 7-bit values, keyed by `${kind}:${slot}` — renderOutput
   *  may be called per-frame, so unchanged bytes are skipped. */
  private lastSent = new Map<string, number>();

  constructor(private readonly ctx: DriverContext<MftConfig>) {}

  get activeBank(): number { return this.bank; }

  configChanged(): void {
    this.lookups = null;
    this.lastSent.clear();
  }

  dispose(): void {}

  onMidiMessage(data: Uint8Array, _timestampMs: number): void {
    if (data.length < 3 || (data[0] & 0xf0) !== CC_STATUS) return;
    const ch = data[0] & 0x0f;
    const cc = data[1];
    const value = data[2];
    const { channels } = this.ctx.config;

    // Bank-change notifications take priority — the system channel is distinct
    // from the control channels in any sane config.
    if (ch === channels.system) {
      if (cc < MFT_BANKS && value >= 64 && cc !== this.bank) {
        this.bank = cc;
        this.ctx.onBankChanged(cc);
      }
      return;
    }
    if (ch === channels.encoder && this.handleTurn('encoder', cc, value, 'turn')) return;
    if (ch === channels.button && this.handleButton(cc, value)) return;
    if (ch === channels.shift) this.handleTurn('shift', cc, value, 'shift');
  }

  /** Absolute or relative rotation on the encoder/shift map. False if the CC
   *  matches no slot (lets overlapping channels fall through). */
  private handleTurn(kind: 'encoder' | 'shift', cc: number, value: number, gesture: 'turn' | 'shift'): boolean {
    const slot = this.resolveSlot(kind, cc);
    if (slot === null) return false;
    const endpoint = this.slotEndpoint(slot, gesture);
    // The shifted rotation follows its encoder slot's absolute/relative mode.
    const mode = this.ctx.config.encoders[slot]?.mode ?? 'absolute';
    let v: number;
    if (mode === 'relative') {
      const delta = (value - 64) / 127;
      v = Math.min(1, Math.max(0, this.ctx.getValue(endpoint) + delta));
    } else {
      v = value / 127;
    }
    this.ctx.emit([{ controlId: endpoint, value: v }]);
    return true;
  }

  private handleButton(cc: number, value: number): boolean {
    const slot = this.resolveSlot('button', cc);
    if (slot === null) return false;
    this.ctx.emit([{ controlId: this.slotEndpoint(slot, 'press'), value: value >= 64 ? 1 : 0 }]);
    return true;
  }

  /**
   * Full state push: LED ring positions (value echo — keeps rings honest for
   * relative mode and on-screen simulation) + RGB cap colors. Values are the
   * host's merged live+sim table.
   */
  renderOutput(values: ReadonlyMap<string, number>): void {
    const { channels, encoders, buttons, colors } = this.ctx.config;
    for (let slot = 0; slot < SLOTS; slot++) {
      const turn = values.get(this.slotEndpoint(slot, 'turn'));
      if (turn !== undefined) {
        this.sendOnce(`ring:${slot}`, channels.encoder, encoders[slot].cc, Math.round(turn * 127));
      }
      const cap = colors[slot]?.cap;
      if (cap !== undefined) {
        this.sendOnce(`cap:${slot}`, channels.button, buttons[slot].cc, cap);
      }
    }
  }

  private sendOnce(key: string, channel: number, cc: number, value: number): void {
    if (this.lastSent.get(key) === value) return;
    this.lastSent.set(key, value);
    this.ctx.send([CC_STATUS | (channel & 0x0f), cc & 0x7f, value & 0x7f]);
  }

  private slotEndpoint(slot: number, gesture: 'turn' | 'press' | 'shift'): string {
    return controlEndpoint(
      bankedControlId(Math.floor(slot / MFT_ENCODERS_PER_BANK), slot % MFT_ENCODERS_PER_BANK),
      gesture);
  }

  /** cc → slot. When a fork maps the same CC in several banks (the "all banks
   *  send CC 0-15" style), the active bank's slot wins. */
  private resolveSlot(kind: 'encoder' | 'button' | 'shift', cc: number): number | null {
    if (!this.lookups) {
      const build = (arr: { cc: number }[]) => {
        const m = new Map<number, number[]>();
        arr.forEach((e, slot) => {
          const list = m.get(e.cc);
          if (list) list.push(slot); else m.set(e.cc, [slot]);
        });
        return m;
      };
      const cfg = this.ctx.config;
      this.lookups = {
        encoder: build(cfg.encoders),
        button: build(cfg.buttons),
        shift: build(cfg.shift),
      };
    }
    const candidates = this.lookups[kind].get(cc);
    if (!candidates?.length) return null;
    const inBank = candidates.find(s => Math.floor(s / MFT_ENCODERS_PER_BANK) === this.bank);
    return inBank ?? candidates[0];
  }
}

/** Endpoint field → slot index, bounds-checked. */
function mftSlot(field: string): { slot: number; gesture: 'turn' | 'press' | 'shift' } | null {
  const parsed = parseControlId(field);
  if (!parsed || parsed.bank >= MFT_BANKS || parsed.index >= MFT_ENCODERS_PER_BANK) return null;
  return { slot: parsed.bank * MFT_ENCODERS_PER_BANK + parsed.index, gesture: parsed.gesture };
}

export const MFT_TEMPLATE: DeviceTemplate<MftConfig> = {
  templateId: MFT_TEMPLATE_ID,
  name: 'Midi Fighter Twister',
  vendor: 'DJ TechTools',
  layout: mftLayout(),
  defaultConfig: defaultMftConfig(),
  portMatchers: [/midi\s*fighter\s*twister/i, /\btwister\b/i],
  createDriver: ctx => new MftDriver(ctx),
  mapping: {
    // Colors are per-encoder, surfaced on the 'turn' endpoint only. The
    // channel is shared per gesture class on the MFT — editing it moves the
    // whole class, which the details panel should surface.
    get(config, field): ControlMapping | null {
      const at = mftSlot(field);
      if (!at) return null;
      const { channels, encoders, buttons, shift, colors } = config;
      switch (at.gesture) {
        case 'turn': return {
          cc: encoders[at.slot].cc, channel: channels.encoder, mode: encoders[at.slot].mode,
          ringColor: colors[at.slot]?.ring, capColor: colors[at.slot]?.cap,
        };
        case 'press': return { cc: buttons[at.slot].cc, channel: channels.button };
        case 'shift': return { cc: shift[at.slot].cc, channel: channels.shift, mode: encoders[at.slot].mode };
      }
    },
    set(config, field, patch) {
      const at = mftSlot(field);
      if (!at) return;
      const { channels, encoders, buttons, shift, colors } = config;
      if (patch.mode !== undefined) encoders[at.slot].mode = patch.mode;
      if (patch.ringColor !== undefined) (colors[at.slot] ??= {}).ring = patch.ringColor;
      if (patch.capColor !== undefined) (colors[at.slot] ??= {}).cap = patch.capColor;
      switch (at.gesture) {
        case 'turn':
          if (patch.cc !== undefined) encoders[at.slot].cc = patch.cc;
          if (patch.channel !== undefined) channels.encoder = patch.channel;
          break;
        case 'press':
          if (patch.cc !== undefined) buttons[at.slot].cc = patch.cc;
          if (patch.channel !== undefined) channels.button = patch.channel;
          break;
        case 'shift':
          if (patch.cc !== undefined) shift[at.slot].cc = patch.cc;
          if (patch.channel !== undefined) channels.shift = patch.channel;
          break;
      }
    },
  },
};

registerDeviceTemplate(MFT_TEMPLATE);
