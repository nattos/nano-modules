/**
 * Vite plugin: UDP bridge — Art-Net in, test patterns out.
 *
 * Browsers cannot open a UDP socket, so in the web IDE the dev server holds it
 * and relays over Vite's existing HMR WebSocket:
 *
 *   beatsync / a lighting desk  ──udp:6454──>  vite (this plugin)
 *                                                  │ coalesced, ~60 Hz
 *                                                  ▼
 *                                      browser  ──> executor.wasm
 *
 * THIS IS THE DEBUG PATH, NOT THE REAL ONE. The shipping path is
 * `native/src/artnet/artnet_host.cpp` inside the shared-server dylib, which
 * drives the barrel with no browser and no dev server involved. Everything
 * here is a development convenience and disappears from a production build
 * (`apply: 'serve'`), which is exactly why the test-pattern TRANSMITTER lives
 * here rather than in the native host.
 *
 * --- co-binding a live rig's control port ---
 *
 * Sharing Art-Net's port requires SO_REUSEPORT on EVERY socket bound to it.
 * Resolume sets it, and so must we — SO_REUSEADDR alone gets EADDRINUSE.
 *
 * Which node option delivers that is PLATFORM-DEPENDENT, and the names lie.
 * On Darwin libuv maps `reuseAddr` to SO_REUSEADDR *and* SO_REUSEPORT (BSD
 * needs the pair), so `reuseAddr` is the sharing flag; the separate `reusePort`
 * option is a newer Linux load-balancing feature that throws ENOTSUP here.
 * On Linux the reverse holds. So we ask for `reusePort` where it works and
 * fall back to `reuseAddr`, rather than reasoning from the option's name.
 *
 * Only BROADCAST frames are delivered to every co-bound socket. A unicast
 * frame goes to exactly ONE of them, and which one is the kernel's PCB lookup
 * rather than a promise — so a test pattern or a beatsync mirror aimed at
 * 127.0.0.1 will be eaten by whichever listener bound first. Prefer broadcast
 * when more than one thing on the box needs to hear the same stream.
 *
 * A bind failure is REPORTED, never thrown: a dev server that wouldn't start
 * because of a debug feature would be a bad trade.
 *
 * --- what does NOT go over the wire ---
 *
 * The receive path never forwards per-packet. An idle Resolume rig already
 * carries ~500 packets/second of its own Art-Net output looping back into its
 * own input, and relaying that to the browser one message per datagram would
 * cost more than the feature is worth. Frames are coalesced and pushed at most
 * every ~16 ms, and only for universes that actually changed.
 */

import type { Plugin, ViteDevServer } from 'vite';
import { createSocket, type Socket } from 'node:dgram';
import {
  ARTNET_MIRROR_PORT, ARTNET_PORT, decodeArtDmx, encodeArtDmx, patternFrame,
  universeKey, type TestPattern,
} from '../artnet/artnet-packet';

/** Client → server: ask for status + a fresh snapshot. */
const EV_HELLO = 'nano:artnet:hello';
/** Client → server: start/stop the test-pattern generator. */
const EV_TEST = 'nano:artnet:test';
/** Server → client: bind status (and why, when it failed). */
const EV_STATUS = 'nano:artnet:status';
/** Server → client: coalesced channel data. */
const EV_FRAME = 'nano:artnet:frame';

/** Push at most this often — one browser frame. */
const PUSH_INTERVAL_MS = 16;
/** The generator's send rate. 100 Hz, matching beatsync: at 40 Hz a 90 ms gate
 *  quantises badly and the duty pause can vanish inside one frame. */
const TX_HZ = 100;

interface UniverseState {
  channels: Uint8Array;
  src: string;
  packets: number;
  drops: number;
  lastSeq: number;
  stamp: number;
  dirty: boolean;
}

interface TestConfig {
  pattern: TestPattern;
  net: number;
  subnet: number;
  universe: number;
  count: number;
  /** 'mirror' → the mirror port, ours alone. 'broadcast' → :6454 on the subnet
   *  broadcast, which Resolume also receives and may act on. */
  dest: 'mirror' | 'broadcast';
  host: string;
}

export function udpBridgePlugin(): Plugin {
  const universes = new Map<string, UniverseState>();
  let rxMain: Socket | null = null;
  let rxMirror: Socket | null = null;
  let tx: Socket | null = null;
  let pushTimer: ReturnType<typeof setInterval> | null = null;
  let txTimer: ReturnType<typeof setInterval> | null = null;
  let txStart = 0;
  let txSeq = 1;
  let txConfig: TestConfig | null = null;
  // Ports report what is ACTUALLY bound (0 = not), so the UI can distinguish
  // "no bridge at all" from "the mirror works but 6454 is held by something
  // that didn't set SO_REUSEPORT" — which are very different instructions to
  // give the person staring at a card that reads 0.
  const status = { listening: false, port: 0, mirrorPort: 0, error: '' };

  function ingest(buf: Buffer, srcIp: string) {
    const frame = decodeArtDmx(new Uint8Array(buf));
    if (!frame) return;                       // ArtSync/ArtPoll/anything else
    const key = universeKey(frame.net, frame.subnet, frame.universe);
    let u = universes.get(key);
    if (!u) {
      u = { channels: new Uint8Array(0), src: srcIp, packets: 0, drops: 0,
            lastSeq: 0, stamp: 0, dirty: true };
      universes.set(key, u);
    }
    // Sequence is 1..255; 0 means the sender disabled ordering.
    if (frame.seq !== 0 && u.lastSeq !== 0) {
      const expected = u.lastSeq === 255 ? 1 : u.lastSeq + 1;
      if (frame.seq !== expected) u.drops++;
    }
    u.lastSeq = frame.seq;
    u.packets++;
    u.src = srcIp;
    u.stamp = Date.now();
    // Mark dirty only on real change — a refresh loop resending an unchanged
    // frame at 100 Hz must not wake the browser 100 times a second.
    if (u.channels.length !== frame.channels.length ||
        !u.channels.every((v, i) => v === frame.channels[i])) {
      u.channels = frame.channels;
      u.dirty = true;
    }
  }

  function snapshot(all: boolean) {
    const out: Record<string, unknown> = {};
    const now = Date.now();
    for (const [key, u] of universes) {
      if (!all && !u.dirty) continue;
      u.dirty = false;
      out[key] = {
        ch: [...u.channels],
        src: u.src,
        ageMs: now - u.stamp,
        packets: u.packets,
        drops: u.drops,
      };
    }
    return out;
  }

  /**
   * Can this platform give a UDP socket SO_REUSEPORT?
   *
   * Probed by actually trying it rather than switch()ing on `process.platform`:
   * the answer is a libuv build detail. libuv reports it at BIND time, not at
   * construction, so the probe binds an ephemeral port (0) and closes it.
   */
  function reusePortSupported(): Promise<boolean> {
    return new Promise(resolve => {
      let sock: Socket;
      try {
        sock = createSocket({ type: 'udp4', reuseAddr: true, reusePort: true });
      } catch { resolve(false); return; }
      const done = (ok: boolean) => {
        try { sock.close(); } catch { /* already closed */ }
        resolve(ok);
      };
      sock.once('error', () => done(false));
      try {
        sock.bind(0, '0.0.0.0', () => done(true));
      } catch { done(false); }
    });
  }

  function bind(server: ViteDevServer, port: number, label: string,
                withReusePort: boolean): Socket | null {
    const sock = createSocket(
      withReusePort ? { type: 'udp4', reuseAddr: true, reusePort: true }
                    : { type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => ingest(buf, rinfo.address));
    sock.on('error', err => {
      // EADDRINUSE here means whoever already holds the port did NOT set
      // SO_REUSEPORT — nothing we can do from this side.
      status.error = `${label}: ${(err as Error).message}`;
      server.config.logger.warn(`[artnet] ${label} bind failed: ${(err as Error).message}`);
      try { sock.close(); } catch { /* already closing */ }
    });
    try {
      // Wildcard, NEVER an interface address: a socket bound to 192.168.x.y
      // does not receive that subnet's broadcast, which is most of what we want.
      sock.bind(port, '0.0.0.0', () => {
        try { sock.setBroadcast(true); } catch { /* not fatal for RX */ }
        status.listening = true;
        if (port === ARTNET_PORT) status.port = port;
        else status.mirrorPort = port;
        server.config.logger.info(`[artnet] listening on 0.0.0.0:${port} (${label})`);
      });
    } catch (err) {
      status.error = `${label}: ${(err as Error).message}`;
      return null;
    }
    return sock;
  }

  /** All-zeros on every channel we might have lit. See beatsync's
   *  `prepareBlackout`: stopping mid-gate latches a channel on with the sender
   *  already gone — the one failure nobody thinks to debug from the desk. */
  function blackout(cfg: TestConfig) {
    if (!tx) return;
    const zero = new Uint8Array(cfg.count);
    const p = encodeArtDmx(cfg.net, cfg.subnet, cfg.universe, zero, 0);
    const port = cfg.dest === 'mirror' ? ARTNET_MIRROR_PORT : ARTNET_PORT;
    // Three times: UDP may drop, and this is the one frame that must arrive.
    for (let i = 0; i < 3; i++) {
      try { tx.send(p, port, cfg.host); } catch { /* receiver gone; fine */ }
    }
  }

  function stopTest() {
    if (txTimer) { clearInterval(txTimer); txTimer = null; }
    if (txConfig) blackout(txConfig);
    txConfig = null;
  }

  function startTest(server: ViteDevServer, cfg: TestConfig) {
    stopTest();
    if (!tx) {
      tx = createSocket({ type: 'udp4' });
      tx.bind(() => { try { tx?.setBroadcast(true); } catch { /* ignore */ } });
    }
    txConfig = cfg;
    txStart = Date.now();
    txSeq = 1;
    const port = cfg.dest === 'mirror' ? ARTNET_MIRROR_PORT : ARTNET_PORT;
    server.config.logger.info(
      `[artnet] test pattern '${cfg.pattern}' → ${cfg.host}:${port} ` +
      `net ${cfg.net} sub ${cfg.subnet} uni ${cfg.universe}`);
    txTimer = setInterval(() => {
      if (!txConfig || !tx) return;
      const bytes = patternFrame(txConfig.pattern, Date.now() - txStart, txConfig.count);
      const p = encodeArtDmx(txConfig.net, txConfig.subnet, txConfig.universe, bytes, txSeq);
      txSeq = txSeq >= 255 ? 1 : txSeq + 1;   // 0 would mean "sequencing off"
      try { tx.send(p, port, txConfig.host); } catch { /* nothing listening */ }
    }, Math.round(1000 / TX_HZ));
    txTimer.unref?.();
  }

  return {
    name: 'nano-modules:udp-bridge',
    apply: 'serve',
    async configureServer(server) {
      // Vitest builds a Vite server too. A unit-test run must not open sockets
      // or start timers — the timers alone keep the process alive past the end
      // of the suite.
      if (process.env.VITEST) return;

      // Ask for the strongest sharing the platform actually offers — see the
      // header for why the option NAMES can't be trusted to tell us that.
      const canShare = await reusePortSupported();
      rxMain = bind(server, ARTNET_PORT, 'artnet', canShare);
      rxMirror = bind(server, ARTNET_MIRROR_PORT, 'mirror', canShare);

      server.ws.on(EV_HELLO, (_data, client) => {
        client.send(EV_STATUS, { ...status });
        client.send(EV_FRAME, { universes: snapshot(true) });
      });

      server.ws.on(EV_TEST, (data: any) => {
        if (!data || data.action === 'stop') { stopTest(); return; }
        startTest(server, {
          pattern: (data.pattern ?? 'chase') as TestPattern,
          net: Number(data.net) || 0,
          subnet: Number(data.subnet) || 0,
          universe: Number(data.universe ?? 1) || 0,
          count: Math.max(1, Math.min(Number(data.count) || 4, 512)),
          dest: data.dest === 'broadcast' ? 'broadcast' : 'mirror',
          host: typeof data.host === 'string' && data.host
            ? data.host : '255.255.255.255',
        });
      });

      pushTimer = setInterval(() => {
        const changed = snapshot(false);
        if (Object.keys(changed).length === 0) return;
        server.ws.send(EV_FRAME, { universes: changed });
      }, PUSH_INTERVAL_MS);
      // Never let a debug timer be the reason the dev server won't exit.
      pushTimer.unref?.();

      // A dev server that dies mid-gate would latch whatever the pattern last
      // lit. Cover every exit the process actually takes.
      const shutdown = () => {
        stopTest();
        if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
        for (const s of [rxMain, rxMirror, tx]) { try { s?.close(); } catch { /* closed */ } }
        rxMain = rxMirror = tx = null;
      };
      server.httpServer?.once('close', shutdown);
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    },
    closeBundle() {
      stopTest();
    },
  };
}
