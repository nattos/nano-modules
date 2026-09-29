/**
 * Light devices — the library model (the devices push, D2).
 *
 * Three layers, the same words every device kind uses:
 *   - TEMPLATE (code): a parametric shape — `light.strip`, a bar of pixels.
 *   - TYPE (library): a template with its parameters filled in ("24 V bar:
 *     12 px × 5 LEDs, RGB"). Customised by forking, as MIDI templates are.
 *   - RIG (library): SLOTS, each a type plus an ADDRESS (universe, start
 *     channel, destination, network) and a default layout — "four bars as
 *     vertical strips". A lone bar is a one-slot rig.
 *
 * And NETWORKS (library): which interface a bar's DMX leaves from, plus
 * on-site "monkey patches" to its destinations — rebase every unicast
 * address onto the venue's subnet, or swap single destinations — without
 * touching the rigs. The built-in AUTO network lets the OS pick (and sends
 * `broadcast` to 255.255.255.255); a slot names a network in its address, so a
 * swap carries it along.
 *
 * There is no separate "unit": a slot's address IS the physical bar. Swapping
 * two slots exchanges their addresses (and types), which is how a rig hung in
 * the wrong order is fixed — in the library, so every show using the rig gets
 * it. What a SHOW owns is where each slot samples its frame (its placement's
 * per-slot layout, falling back to the rig's).
 *
 * Pure types + helpers — no DOM, no store.
 */

/** Channel layout per pixel. Lock-step: native lights/light_map.h Format. */
export type LightFormat = 'rgb' | 'grb' | 'bgr' | 'rgbw' | 'grbw';

export const LIGHT_FORMATS: readonly { id: LightFormat; label: string }[] = [
  { id: 'rgb', label: 'RGB' },
  { id: 'grb', label: 'GRB' },
  { id: 'bgr', label: 'BGR' },
  { id: 'rgbw', label: 'RGBW' },
  { id: 'grbw', label: 'GRBW' },
];

export function channelsPerPixel(f: LightFormat): number {
  return f === 'rgbw' || f === 'grbw' ? 4 : 3;
}

/** A rect in normalized frame coordinates (0,0 = top-left). A slot's pixels
 *  run along its TYPE's axis: top → bottom for a vertical type, left → right
 *  for a horizontal one (a slot's `reverse` flips that). */
export interface SlotRect { x: number; y: number; w: number; h: number }

/** Where a fixture listens. */
export interface LightAddress {
  /** The 15-bit Art-Net port address (net · subnet · universe), 0-based as
   *  the node is set. */
  universe: number;
  /** 1-based start channel, as a lighting desk shows it. */
  channel: number;
  /** 'broadcast', a node's IP, or 'ip:port'. */
  dest: string;
  /** The network it's sent on (a LightNetwork id); absent = Auto. */
  network?: string;
}

export interface LightTemplate {
  templateId: string;
  name: string;
  /** The parameters a new type starts with. */
  defaults: { pixels: number; ledsPerPixel: number; format: LightFormat; gamma: number; vertical: boolean };
}

/** The code-registered templates. One parametric strip covers bars of any
 *  length, RGB or RGBW, one LED per pixel or many (a 24 V segment). */
export const LIGHT_TEMPLATES: readonly LightTemplate[] = [
  {
    templateId: 'light.strip',
    name: 'LED strip',
    defaults: { pixels: 10, ledsPerPixel: 1, format: 'rgbw', gamma: 2.5, vertical: true },
  },
];

export function lightTemplate(templateId: string): LightTemplate | undefined {
  return LIGHT_TEMPLATES.find((t) => t.templateId === templateId);
}

interface RowBase {
  id: string;
  name: string;
  /** Lineage: the row (or template id) this was forked from. Bookkeeping only. */
  parentId: string;
  forkedAt: number;
  updatedAt: number;
  /** Soft delete — kept so a show that places it can say what it was. */
  deleted?: boolean;
}

export interface LightType extends RowBase {
  kind: 'type';
  templateId: string;
  /** Addressable pixels (DMX sees this many). */
  pixels: number;
  /** Physical LEDs each pixel lights (a 24 V segment is several) — drawing only. */
  ledsPerPixel: number;
  format: LightFormat;
  gamma: number;
  /** Hung vertically (pixels run top → bottom) or horizontally (left →
   *  right). Sets which way a slot's pixels run in its rect, and how a new
   *  rig of the type is laid out. */
  vertical: boolean;
}

export interface LightSlot {
  id: string;
  typeId: string;
  address: LightAddress;
  /** Pixel 0 at the other end (a bar hung upside down). */
  reverse?: boolean;
  /** The rig's default layout for this slot (a show can override it). */
  layout: SlotRect;
}

export interface LightRig extends RowBase {
  kind: 'rig';
  slots: LightSlot[];
}

/** A destination swap: 'broadcast' | ip | ip:port → the same. An `ip`
 *  `from` also matches that ip on any port (the port is kept unless `to`
 *  names one). */
export interface NetworkOverride { from: string; to: string }

export interface LightNetwork extends RowBase {
  kind: 'network';
  /** The interface to send from ('en0'); '' = auto (the OS picks). */
  iface: string;
  /** Rebase unicast destinations onto this subnet ('10.0.5.0/24'): each keeps
   *  its host part (192.168.1.40 → 10.0.5.40). Absent / '' = off. */
  rebase?: string;
  /** Checked before the rebase; the first match wins. */
  overrides?: NetworkOverride[];
}

export const AUTO_NETWORK_ID = 'net.auto';

/** The built-in network: no interface chosen, destinations as the rigs say. */
export const AUTO_NETWORK: LightNetwork = {
  kind: 'network', id: AUTO_NETWORK_ID, name: 'Auto', parentId: '', forkedAt: 0, updatedAt: 0, iface: '',
};

export type LightRow = LightType | LightRig | LightNetwork;

/** Channels one slot of `type` occupies. */
export function slotChannels(type: Pick<LightType, 'pixels' | 'format'>): number {
  return type.pixels * channelsPerPixel(type.format);
}

/** The rig default for slot `i` of `n`: vertical strips spread across the
 *  frame, each 1/60 wide (the Resolume shows' 32 px of 1920) — or, for a
 *  horizontal type, full-width strips stacked down it, as thick (32 px of
 *  1080 at 16:9). */
export function defaultStripLayout(i: number, n: number, vertical = true): SlotRect {
  if (!vertical) {
    const h = (1 / 60) * (16 / 9);
    return { x: 0, y: (i + 0.5) / n - h / 2, w: 1, h };
  }
  const w = 1 / 60;
  return { x: (i + 0.5) / n - w / 2, y: 0, w, h: 1 };
}

/** Addresses for `count` fixtures of `type`, one after another from `start`.
 *  A fixture that wouldn't fit in what's left of a universe starts the next. */
export function consecutiveAddresses(count: number, type: Pick<LightType, 'pixels' | 'format'>,
                                     start: LightAddress): LightAddress[] {
  const n = slotChannels(type);
  const out: LightAddress[] = [];
  let universe = start.universe;
  let channel = start.channel;
  for (let i = 0; i < count; i++) {
    if (channel > 1 && channel + n - 1 > 512) { universe++; channel = 1; }
    out.push({ universe, channel, dest: start.dest });
    channel += n;
  }
  return out;
}

/** One footprint per pixel: the rect cut into `pixels` cells down it
 *  (`vertical`) or across it, pixel 0 at the top (or left) unless `reverse`.
 *  [u0, v0, u1, v1]. */
export function slotFootprints(r: SlotRect, pixels: number, vertical: boolean,
                               reverse = false): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  const n = Math.max(0, Math.floor(pixels));
  for (let i = 0; i < n; i++) {
    const k = reverse ? n - 1 - i : i;
    if (vertical) {
      const y0 = r.y + (r.h * k) / n;
      out.push([r.x, y0, r.x + r.w, y0 + r.h / n]);
    } else {
      const x0 = r.x + (r.w * k) / n;
      out.push([x0, r.y, x0 + r.w / n, r.y + r.h]);
    }
  }
  return out;
}

function ipToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** 'a.b.c.d/n' (n 1..32) → its network + mask, else null. */
export function parseCidr(s: string): { net: number; mask: number } | null {
  const m = /^\s*([\d.]+)\/(\d{1,2})\s*$/.exec(s);
  if (!m) return null;
  const ip = ipToInt(m[1]);
  const bits = Number(m[2]);
  if (ip === null || bits < 1 || bits > 32) return null;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return { net: (ip & mask) >>> 0, mask };
}

/**
 * Where a destination really goes on `network`: its first matching override,
 * else its rebase (unicast only — `broadcast` is the interface's to resolve),
 * else as the rig says.
 */
export function resolveNetworkDest(dest: string, network: LightNetwork | undefined): string {
  if (!network) return dest;
  const d = dest.trim() || 'broadcast';
  const colon = d.lastIndexOf(':');
  const host = colon >= 0 ? d.slice(0, colon) : d;
  const port = colon >= 0 ? d.slice(colon + 1) : '';
  for (const o of network.overrides ?? []) {
    const from = o.from.trim();
    const to = o.to.trim();
    if (!from || !to) continue;
    if (from === d) return to;
    if (port && from === host) return to.includes(':') || to === 'broadcast' ? to : `${to}:${port}`;
  }
  const cidr = network.rebase ? parseCidr(network.rebase) : null;
  const ip = ipToInt(host);
  if (cidr && ip !== null) {
    const moved = intToIp(((cidr.net & cidr.mask) | (ip & ~cidr.mask)) >>> 0);
    return port ? `${moved}:${port}` : moved;
  }
  return d;
}

/** "u 3 · ch 41" (and the destination when it isn't broadcast). */
export function addressLabel(a: LightAddress): string {
  const base = `u${a.universe} · ch ${a.channel}`;
  return a.dest && a.dest !== 'broadcast' ? `${base} → ${a.dest}` : base;
}

/** Is `dest` something the transmitter accepts ('broadcast' | ip | ip:port)? */
export function validDest(dest: string): boolean {
  if (dest === 'broadcast') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/.exec(dest.trim());
  if (!m) return false;
  if (m.slice(1, 5).some((o) => Number(o) > 255)) return false;
  return m[5] === undefined || (Number(m[5]) > 0 && Number(m[5]) <= 65535);
}
