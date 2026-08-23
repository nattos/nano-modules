/**
 * Art-Net wire format — encode/decode for ArtDmx, plus the test-pattern
 * generator's per-frame channel math.
 *
 * Pure: no node, no DOM, no timers. The dev-server bridge
 * (`vite-plugins/udp-bridge.ts`) owns the socket and the clock; this module
 * owns the bytes, so both are testable without either.
 *
 * The native twin is `native/src/artnet/artnet_host.cpp`. Keep the parse rules
 * in lock-step — the two must agree about what counts as a frame, or the web
 * IDE and the barrel disagree about what the rig is sending.
 */

/** Art-Net's port, fixed by the specification. */
export const ARTNET_PORT = 6454;
/** Where `beatsync --artnet-mirror` and our test patterns send by default —
 *  off 6454 entirely, so Resolume neither sees them nor competes for them. */
export const ARTNET_MIRROR_PORT = 6455;
export const ARTNET_MAX_CHANNELS = 512;

const HEADER_LEN = 18;
const OP_DMX = 0x5000;

/** One decoded ArtDmx frame. */
export interface ArtDmxFrame {
  net: number;
  subnet: number;
  universe: number;
  /** Sequence byte; 0 means the sender disabled sequencing. */
  seq: number;
  /** Channel values, 0..255, exactly as many as the packet carried. */
  channels: Uint8Array;
}

/** `Net(7) | Subnet(4) | Universe(4)` — Art-Net's 15-bit port address. */
export function portAddress(net: number, subnet: number, universe: number): number {
  return ((net & 0x7f) << 8) | ((subnet & 0x0f) << 4) | (universe & 0x0f);
}

/** Stable string key for a universe, as the bridge protocol carries it. */
export function universeKey(net: number, subnet: number, universe: number): string {
  return `${net & 0x7f}.${subnet & 0x0f}.${universe & 0x0f}`;
}

/**
 * Decode one datagram, or null if it isn't an ArtDmx frame.
 *
 * Returns null for ArtSync (0x5200), ArtPoll (0x2000) and everything else on
 * the port — which is most of it on a Resolume rig, since Resolume broadcasts
 * its own Art-Net output back into its own input.
 *
 * The header is deliberately mixed-endian and that is not a bug here: the
 * opcode is LITTLE endian, the DMX length two bytes later is BIG endian.
 */
export function decodeArtDmx(buf: Uint8Array): ArtDmxFrame | null {
  if (buf.length < HEADER_LEN) return null;
  // "Art-Net\0"
  for (let i = 0; i < 7; i++) if (buf[i] !== 'Art-Net'.charCodeAt(i)) return null;
  if (buf[7] !== 0) return null;
  if ((buf[8] | (buf[9] << 8)) !== OP_DMX) return null;

  let len = (buf[16] << 8) | buf[17];
  // Trust what ARRIVED over what the header claims — a truncated packet with a
  // 512 in the header would otherwise read past the buffer.
  if (len > buf.length - HEADER_LEN) len = buf.length - HEADER_LEN;
  if (len > ARTNET_MAX_CHANNELS) len = ARTNET_MAX_CHANNELS;
  if (len <= 0) return null;

  return {
    net: buf[15] & 0x7f,
    subnet: (buf[14] >> 4) & 0x0f,
    universe: buf[14] & 0x0f,
    seq: buf[12],
    channels: buf.slice(HEADER_LEN, HEADER_LEN + len),
  };
}

/**
 * Encode one ArtDmx frame.
 *
 * The channel count is rounded UP to even because the spec requires it — an
 * odd length is the kind of thing a lenient receiver accepts and a strict one
 * silently drops, which reads as "Art-Net doesn't work" rather than as a
 * malformed packet.
 */
export function encodeArtDmx(
  net: number, subnet: number, universe: number,
  channels: Uint8Array, seq: number,
): Uint8Array {
  let n = channels.length;
  if (n < 2) n = 2;
  if (n > ARTNET_MAX_CHANNELS) n = ARTNET_MAX_CHANNELS;
  if (n & 1) n++;

  const p = new Uint8Array(HEADER_LEN + n);
  for (let i = 0; i < 7; i++) p[i] = 'Art-Net'.charCodeAt(i);
  p[7] = 0;
  p[8] = 0x00; p[9] = 0x50;          // OpDmx, little endian
  p[10] = 0x00; p[11] = 14;          // protocol 14, big endian
  p[12] = seq & 0xff;
  p[13] = 0;                          // physical port, informational
  p[14] = ((subnet & 0x0f) << 4) | (universe & 0x0f);
  p[15] = net & 0x7f;
  p[16] = (n >> 8) & 0xff;            // length, BIG endian
  p[17] = n & 0xff;
  p.set(channels.subarray(0, Math.min(channels.length, n)), HEADER_LEN);
  return p;
}

// --- test patterns -------------------------------------------------------

export const TEST_PATTERNS = ['chase', 'pulse', 'ramp', 'flat', 'beatsync'] as const;
export type TestPattern = (typeof TEST_PATTERNS)[number];

/** beatsync's gate shape, mirrored so the mimic behaves like the real source:
 *  90 ms hold at 0.9 duty (`g_artnetGateMs` / `g_artnetDuty` in v3_live.mm). */
const GATE_MS = 90;
const GATE_DUTY = 0.9;
/** One "hit" every 500 ms — a plain 120 BPM quarter note. */
const BEAT_MS = 500;
/** The beat pattern's grid. A gate is one 16th long (minus the duty gap), so
 *  consecutive steps read as separate hits rather than one held level. */
const SIXTEENTH_MS = BEAT_MS / 4;

/**
 * VELOCITY SQUASH — five positions, applied to every channel value a pattern
 * produces, mirroring `velSquash` in audiooptim's `v3_live.mm` so the mimic and
 * the real sender shape a hit the same way.
 *
 * IT ONLY EVER SQUASHES UPWARD, and that is the whole shape of the control.
 * Both ends are pinned — y(0)=0 and y(1)=1 — so blackout and full stay exactly
 * where they are and only the middle of the range moves: a position lifts the
 * quiet hits into view and can never dim the loud ones. That is the direction
 * the complaint runs, because a beat pattern's offbeats sit at 0.45-0.65 and
 * the top of the range is the part nothing reaches.
 *
 * The middle three are ONE family, a gamma halved per position: y = x^(2^-n),
 * n = 1..3. Position 4 is that family's LIMIT rather than a separate idea — as
 * the exponent goes to 0, x^g goes to 1 for every x above 0 — which is why the
 * ladder ends in a step instead of stopping at an arbitrary exponent. In
 * practice that makes it "every gate at full", which is the `flat` pattern's
 * wire check arriving as the end of a ladder rather than as a mode of its own.
 *
 * Position 0 returns the argument UNTOUCHED rather than raising it to the power
 * 1, so a generator nobody has aimed this at is bit-for-bit the generator that
 * existed before the control did.
 */
export const VEL_SQUASH_NAMES = ['linear', 'x^1/2', 'x^1/4', 'x^1/8', 'binary'] as const;
export const VEL_SQUASH_N = VEL_SQUASH_NAMES.length;

/** Clamp a stored/received position onto a real rung of the ladder. */
export function clampVelSquash(pos: number): number {
  if (!Number.isFinite(pos)) return 0;
  return Math.max(0, Math.min(VEL_SQUASH_N - 1, Math.round(pos)));
}

/** One value through the ladder. `v` is normalised 0..1, not a DMX byte. */
export function velSquash(v: number, pos: number): number {
  const n = clampVelSquash(pos);
  if (n <= 0 || !(v > 0)) return v > 0 ? v : 0;
  const c = Math.min(1, v);
  if (n >= VEL_SQUASH_N - 1) return 1;
  return Math.pow(c, 1 / (1 << n));
}

/**
 * The channel bytes a pattern shows at time `tMs` (monotonic ms since start).
 *
 * Pure function of time, so the generator has no state to drift and a test can
 * assert any instant without running a clock.
 *
 * `squash` shapes every byte on the way out (see `velSquash`). It runs here,
 * once, rather than inside each pattern arm, because it is a property of the
 * TRANSMITTER and not of one pattern's rhythm — and because the pinned ends
 * make it inert on the gate-only patterns (`flat` / `pulse` / `chase` are 0 or
 * 255 and stay so), so only the two arms that carry a level actually move.
 */
export function patternFrame(
  pattern: TestPattern, tMs: number, count: number, squash = 0,
): Uint8Array {
  const n = Math.max(1, Math.min(count, ARTNET_MAX_CHANNELS));
  const out = new Uint8Array(n);

  switch (pattern) {
    case 'flat':
      // The wire check: a constant frame removes our gating from the picture.
      // If a receiver still flickers on a steady 255, the cause is downstream.
      out.fill(255);
      break;

    case 'ramp': {
      // Slow sweep over 4 s — for checking addressing and patch, since every
      // channel is visibly at a different point of the ramp.
      for (let i = 0; i < n; i++) {
        const phase = ((tMs / 4000) + i / n) % 1;
        out[i] = Math.round(phase * 255);
      }
      break;
    }

    case 'pulse': {
      // All channels gated together — separates "is anything arriving at all"
      // from "is my per-channel mapping right".
      const lit = tMs % BEAT_MS < GATE_MS * GATE_DUTY;
      out.fill(lit ? 255 : 0);
      break;
    }

    case 'chase': {
      // One channel at a time, in order: the fastest way to see which DMX
      // address a fixture (or a rail) is actually patched to.
      const step = Math.floor(tMs / BEAT_MS) % n;
      if (tMs % BEAT_MS < GATE_MS * GATE_DUTY) out[step] = 255;
      break;
    }

    case 'beatsync': {
      // What beatsync sends, in shape: a beat-locked trigger stream, not a
      // free-running LFO. Ch 1 fires on every quarter — the kick, the thing
      // you actually feel — and Ch 2-4 arp the three 16ths in between, so a
      // wire off any of them sees a rhythm rather than a blur.
      //
      // Four channels, deliberately, however many the card shows: the real
      // source sends four ROLES (heavy / regular / decor / uniform, in that
      // fixed order — see native/docs/ARTNET_CAPTURE.md). Lighting the rest
      // would make a 16-channel card look like a feed it will never get.
      //
      // Deterministic — no RNG — so a capture replays identically and a test
      // can assert any instant.
      const step = Math.floor(tMs / SIXTEENTH_MS);   // 16ths since start
      const inBeat = step & 3;                        // 0 = on the beat
      const beat = step >> 2;
      // The gate: one 16th, opened at the step boundary. Everything else in
      // this pattern decides WHICH channel — this decides whether any is lit.
      if (tMs - step * SIXTEENTH_MS >= SIXTEENTH_MS * GATE_DUTY) break;

      let ch: number;
      let vel: number;
      if (inBeat === 0) {
        ch = 0;
        // Accent the downbeat of each 4/4 bar; the other quarters sit under it
        // so a level meter shows the bar, not just a metronome.
        vel = (beat & 3) === 0 ? 1.0 : 0.8;
      } else {
        // Rotate the arp one channel per beat, so the three offbeat 16ths walk
        // 2-3-4, 3-4-2, 4-2-3 ... rather than repeating the same figure.
        ch = 1 + ((inBeat - 1 + beat) % 3);
        // Offbeats are quieter, and the last 16th of the beat quieter still —
        // enough dynamic range that a wire's modulation band has somewhere to
        // move.
        vel = 0.65 - 0.1 * (inBeat - 1);
      }
      if (ch < n) out[ch] = Math.round(vel * 255);
      break;
    }
  }

  const pos = clampVelSquash(squash);
  if (pos > 0) {
    for (let i = 0; i < n; i++) {
      if (out[i] === 0 || out[i] === 255) continue;   // pinned; no rounding drift
      out[i] = Math.round(velSquash(out[i] / 255, pos) * 255);
    }
  }
  return out;
}
