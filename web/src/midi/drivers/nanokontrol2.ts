/**
 * Korg nanoKONTROL2 — template + driver.
 *
 * A flat, unbanked control surface: 8 channel strips (rotary knob, fader, and
 * S/M/R buttons) plus a left-hand transport cluster. Unlike the Twister every
 * control is its own physical thing, so each gets its own slot and exactly one
 * gesture: knobs and faders publish 'turn', every button publishes 'press'.
 *
 * ALL protocol constants live in NanoKontrol2Config (the template's
 * defaultConfig) so a fork's remapped CCs are pure data edits. The factory
 * defaults below are the stock "CC mode" scene from the nanoKONTROL2 manual,
 * everything on one MIDI channel:
 *   - faders 1-8:  CC 0..7          - knobs 1-8:  CC 16..23
 *   - S buttons:   CC 32..39        - M buttons:  CC 48..55
 *   - R buttons:   CC 64..71
 *   - transport:   play 41, stop 42, rew 43, ff 44, rec 45, cycle 46,
 *                  track prev/next 58/59, marker set/prev/next 60/61/62
 * A unit reflashed with the Korg Kontrol Editor will differ — those are
 * defaultConfig edits on a fork, not code changes.
 *
 * Button VALUE semantics are deliberately mode-agnostic: >= 64 reads as 1 and
 * below as 0, which is right whether the hardware button is set to Momentary
 * (127 down, 0 up) or Toggle (127 on one press, 0 on the next). The driver
 * never needs to know which, and never latches state of its own.
 *
 * Known limitation: one `channel` for the whole surface. The Kontrol Editor
 * can give an individual control its own channel; the factory scene does not,
 * and modelling it would put a channel on all 51 slots to serve a case no
 * stock unit produces. A fork needing it is a config-shape change here.
 */

import {
  bankedControlId, controlEndpoint, ControlMapping, DeviceDriver, DeviceLayout,
  DeviceTemplate, DriverContext, parseControlId,
} from '../midi-types';
import { registerDeviceTemplate } from '../device-registry';

export const NK2_TEMPLATE_ID = 'com.nano.midi.nanokontrol2';

export const NK2_STRIPS = 8;

/** Transport buttons, in the order their config CCs are stored. */
export const NK2_TRANSPORT = [
  'trackPrev', 'trackNext', 'cycle', 'markerSet', 'markerPrev', 'markerNext',
  'rew', 'ff', 'stop', 'play', 'rec',
] as const;
export type Nk2TransportKey = (typeof NK2_TRANSPORT)[number];

/**
 * Slot numbering. Slots are the flat index space behind the logical control
 * ids ('b0/e17'), so these bases are part of the WIRE CONTRACT: changing one
 * silently re-points every saved wire at a different physical control. Append
 * new groups after the last base instead.
 */
export const NK2_SLOT_FADER = 0;
export const NK2_SLOT_KNOB = 8;
export const NK2_SLOT_SOLO = 16;
export const NK2_SLOT_MUTE = 24;
export const NK2_SLOT_REC = 32;
export const NK2_SLOT_TRANSPORT = 40;
export const NK2_SLOTS = NK2_SLOT_TRANSPORT + NK2_TRANSPORT.length;

/** Config sections, keyed the way `mapping` addresses them. */
export type Nk2Group = 'faders' | 'knobs' | 'solo' | 'mute' | 'rec' | 'transport';

export interface NanoKontrol2Config {
  /** 0-based MIDI channel, shared by every control (see header). */
  channel: number;
  faders: { cc: number }[];
  knobs: { cc: number }[];
  solo: { cc: number }[];
  mute: { cc: number }[];
  rec: { cc: number }[];
  /** Indexed by NK2_TRANSPORT order. */
  transport: { cc: number }[];
  /**
   * 'internal' = the hardware lights its own button lamps on press and ignores
   * incoming LED messages (the factory default). 'external' = the host owns
   * them, which is the only mode where renderOutput has anything to say — so
   * we stay silent otherwise rather than fighting the firmware.
   */
  ledMode: 'internal' | 'external';
}

const TRANSPORT_DEFAULT_CC: Record<Nk2TransportKey, number> = {
  trackPrev: 58, trackNext: 59, cycle: 46, markerSet: 60, markerPrev: 61,
  markerNext: 62, rew: 43, ff: 44, stop: 42, play: 41, rec: 45,
};

export function defaultNanoKontrol2Config(): NanoKontrol2Config {
  const strip = (base: number) => [...Array(NK2_STRIPS).keys()].map(i => ({ cc: base + i }));
  return {
    channel: 0,
    faders: strip(0),
    knobs: strip(16),
    solo: strip(32),
    mute: strip(48),
    rec: strip(64),
    transport: NK2_TRANSPORT.map(k => ({ cc: TRANSPORT_DEFAULT_CC[k] })),
    ledMode: 'internal',
  };
}

// --- Slot addressing ---

export interface Nk2Slot { group: Nk2Group; index: number }

/** Slot index → which config array it lives in. Null when out of range. */
export function nk2GroupOf(slot: number): Nk2Slot | null {
  if (slot < 0 || slot >= NK2_SLOTS) return null;
  if (slot >= NK2_SLOT_TRANSPORT) return { group: 'transport', index: slot - NK2_SLOT_TRANSPORT };
  if (slot >= NK2_SLOT_REC) return { group: 'rec', index: slot - NK2_SLOT_REC };
  if (slot >= NK2_SLOT_MUTE) return { group: 'mute', index: slot - NK2_SLOT_MUTE };
  if (slot >= NK2_SLOT_SOLO) return { group: 'solo', index: slot - NK2_SLOT_SOLO };
  if (slot >= NK2_SLOT_KNOB) return { group: 'knobs', index: slot - NK2_SLOT_KNOB };
  return { group: 'faders', index: slot - NK2_SLOT_FADER };
}

/** Faders and knobs are continuous ('turn'); everything else is a button. */
export function nk2IsContinuous(group: Nk2Group): boolean {
  return group === 'faders' || group === 'knobs';
}

export function nk2Endpoint(slot: number): string {
  const at = nk2GroupOf(slot);
  const gesture = at && nk2IsContinuous(at.group) ? 'turn' : 'press';
  return controlEndpoint(bankedControlId(0, slot), gesture);
}

/** Endpoint field → slot, rejecting the wrong gesture for that control. */
function nk2Slot(field: string): number | null {
  const parsed = parseControlId(field);
  if (!parsed || parsed.bank !== 0) return null;
  const at = nk2GroupOf(parsed.index);
  if (!at) return null;
  const want = nk2IsContinuous(at.group) ? 'turn' : 'press';
  return parsed.gesture === want ? parsed.index : null;
}

// --- Layout ---

/**
 * Body proportions and control placement traced from the hardware's face.
 * Normalized 0..1 within the body on each axis independently, so a square
 * control is `h = w * aspect` — hence knobs and buttons being far "taller"
 * than they are wide in these numbers.
 */
const ASPECT = 3.4;
const STRIP_X0 = 0.288;
const STRIP_PITCH = 0.0835;

/** Square on the face: the body's two axes are normalized independently. */
const SQ = (w: number) => w * ASPECT;

function nk2Layout(): DeviceLayout {
  const controls: DeviceLayout['controls'] = [];
  const button = (slot: number, x: number, y: number, w: number, h: number, label: string) => {
    controls.push({
      id: bankedControlId(0, slot), kind: 'button' as const,
      x, y, w, h, gestures: ['press'] as const as ('press')[], label,
    });
  };

  for (let i = 0; i < NK2_STRIPS; i++) {
    const sx = STRIP_X0 + i * STRIP_PITCH;
    controls.push({
      id: bankedControlId(0, NK2_SLOT_KNOB + i), kind: 'encoder',
      x: sx + 0.040, y: 0.10, w: 0.042, h: 0.042 * ASPECT,
      gestures: ['turn'], label: `${i + 1}`,
    });
    controls.push({
      id: bankedControlId(0, NK2_SLOT_FADER + i), kind: 'slider',
      x: sx + 0.045, y: 0.33, w: 0.032, h: 0.56,
      gestures: ['turn'], label: `${i + 1}`,
    });
    button(NK2_SLOT_SOLO + i, sx, 0.42, 0.033, SQ(0.033), 'S');
    button(NK2_SLOT_MUTE + i, sx, 0.555, 0.033, SQ(0.033), 'M');
    button(NK2_SLOT_REC + i, sx, 0.69, 0.033, SQ(0.033), 'R');
  }

  // Left cluster. TRACK / CYCLE / MARKER are WIDE SHORT ovals on the face, so
  // their width and height vary independently and they can't go through SQ.
  // The five transport keys below them are the larger square ones.
  //
  // Glyphs are all U+25xx geometric shapes. The obvious U+23EA / U+23E9
  // (rewind / fast-forward) and U+23F9 / U+23FA carry Emoji_Presentation, so
  // a browser draws them as full-colour emoji beside the monochrome arrows —
  // doubled triangles keep the row consistent without depending on a
  // variation selector surviving the font stack.
  const OVAL_H = 0.075;
  const t = (key: Nk2TransportKey) => NK2_SLOT_TRANSPORT + NK2_TRANSPORT.indexOf(key);
  button(t('trackPrev'), 0.035, 0.445, 0.032, OVAL_H, '◀');
  button(t('trackNext'), 0.078, 0.445, 0.032, OVAL_H, '▶');
  button(t('cycle'), 0.028, 0.585, 0.048, OVAL_H, 'CYCLE');
  button(t('markerSet'), 0.127, 0.585, 0.036, OVAL_H, 'SET');
  button(t('markerPrev'), 0.170, 0.585, 0.032, OVAL_H, '◀');
  button(t('markerNext'), 0.211, 0.585, 0.032, OVAL_H, '▶');
  button(t('rew'), 0.030, 0.715, 0.038, SQ(0.038), '◀◀');
  button(t('ff'), 0.076, 0.715, 0.038, SQ(0.038), '▶▶');
  button(t('stop'), 0.122, 0.715, 0.038, SQ(0.038), '■');
  button(t('play'), 0.168, 0.715, 0.038, SQ(0.038), '▶');
  button(t('rec'), 0.214, 0.715, 0.038, SQ(0.038), '●');

  return { aspect: ASPECT, banks: 1, controls };
}

const CC_STATUS = 0xb0;

export class NanoKontrol2Driver implements DeviceDriver {
  /** cc → slots, rebuilt lazily after configChanged(). */
  private lookup: Map<number, number[]> | null = null;
  /** Last transmitted value per slot — renderOutput may run per frame. */
  private lastSent = new Map<number, number>();

  constructor(private readonly ctx: DriverContext<NanoKontrol2Config>) {}

  /** Unbanked surface: always bank 0, and onBankChanged is never called. */
  get activeBank(): number { return 0; }

  configChanged(): void {
    this.lookup = null;
    this.lastSent.clear();
  }

  dispose(): void {}

  onMidiMessage(data: Uint8Array, _timestampMs: number): void {
    if (data.length < 3 || (data[0] & 0xf0) !== CC_STATUS) return;
    if ((data[0] & 0x0f) !== this.ctx.config.channel) return;
    const slots = this.resolveSlots(data[1]);
    if (!slots) return;
    // Every matching slot fires, not just the first. With no banks a duplicate
    // CC can only be a deliberate gang (or a config mistake worth seeing), so
    // moving both controls is the honest reading.
    this.ctx.emit(slots.map(slot => {
      const at = nk2GroupOf(slot)!;
      return {
        controlId: nk2Endpoint(slot),
        value: nk2IsContinuous(at.group) ? data[2] / 127 : (data[2] >= 64 ? 1 : 0),
      };
    }));
  }

  /**
   * Button lamps, and only in external LED mode — in internal mode the
   * hardware drives them itself and ignores what we send. Faders and knobs
   * have no indicators at all, so there is nothing to echo for them.
   */
  renderOutput(values: ReadonlyMap<string, number>): void {
    if (this.ctx.config.ledMode !== 'external') return;
    const { channel } = this.ctx.config;
    for (let slot = NK2_SLOT_SOLO; slot < NK2_SLOTS; slot++) {
      const v = values.get(nk2Endpoint(slot));
      if (v === undefined) continue;
      const out = v >= 0.5 ? 127 : 0;
      if (this.lastSent.get(slot) === out) continue;
      this.lastSent.set(slot, out);
      this.ctx.send([CC_STATUS | (channel & 0x0f), this.ccOf(slot) & 0x7f, out]);
    }
  }

  private ccOf(slot: number): number {
    const at = nk2GroupOf(slot)!;
    return this.ctx.config[at.group][at.index].cc;
  }

  private resolveSlots(cc: number): number[] | undefined {
    if (!this.lookup) {
      const m = new Map<number, number[]>();
      for (let slot = 0; slot < NK2_SLOTS; slot++) {
        const list = m.get(this.ccOf(slot));
        if (list) list.push(slot); else m.set(this.ccOf(slot), [slot]);
      }
      this.lookup = m;
    }
    return this.lookup.get(cc);
  }
}

export const NK2_TEMPLATE: DeviceTemplate<NanoKontrol2Config> = {
  templateId: NK2_TEMPLATE_ID,
  name: 'nanoKONTROL2',
  vendor: 'Korg',
  layout: nk2Layout(),
  defaultConfig: defaultNanoKontrol2Config(),
  // The unit presents its input as 'nanoKONTROL2 SLIDER/KNOB' and its output
  // as 'nanoKONTROL2 CTRL', so match the model name rather than a whole label.
  portMatchers: [/nano\s*kontrol\s*2/i],
  createDriver: ctx => new NanoKontrol2Driver(ctx),
  mapping: {
    get(config, field): ControlMapping | null {
      const slot = nk2Slot(field);
      if (slot === null) return null;
      const at = nk2GroupOf(slot)!;
      // No `mode`: these are absolute pots and plain buttons — there is no
      // relative-encoder reading of either, so the panel should not offer one.
      return { cc: config[at.group][at.index].cc, channel: config.channel };
    },
    set(config, field, patch) {
      const slot = nk2Slot(field);
      if (slot === null) return;
      const at = nk2GroupOf(slot)!;
      if (patch.cc !== undefined) config[at.group][at.index].cc = patch.cc;
      // One channel for the whole surface — editing it here moves every
      // control, which the details panel should make clear.
      if (patch.channel !== undefined) config.channel = patch.channel;
    },
  },
};

registerDeviceTemplate(NK2_TEMPLATE);
