/**
 * ArtnetClient — the browser end of the dev server's UDP bridge.
 *
 * Receives coalesced Art-Net channel tables from `vite-plugins/udp-bridge.ts`
 * over Vite's HMR socket, and each frame lowers them into the executor's
 * injected-scalar table for whichever `control.artnet` cards the composition
 * currently holds.
 *
 * DEV ONLY, BY CONSTRUCTION. The transport is `import.meta.hot`, which does not
 * exist in a production build — so `isAvailable` is false there and every
 * method is a no-op. That is deliberate: the shipping Art-Net path is the
 * native listener inside the shared-server dylib, which needs neither this
 * file nor a dev server. In the web IDE this exists so a sketch can be built
 * and felt without a barrel running.
 *
 * The MIDI controller is the model for the push discipline (see
 * `state/midi-controller.ts`): build a canonical JSON, compare it to the last
 * one, and only cross the worker boundary when it actually changed.
 */

import { appState } from '../state/app-state';
import { buildInjectedScalars } from './artnet-lowering';
import { clampVelSquash, type TestPattern } from './artnet-packet';

const EV_HELLO = 'nano:artnet:hello';
const EV_TEST = 'nano:artnet:test';
const EV_STATUS = 'nano:artnet:status';
const EV_FRAME = 'nano:artnet:frame';

/** What one universe currently reads, as the Devices/inspector UI shows it. */
export interface UniverseInfo {
  channels: Uint8Array;
  src: string;
  ageMs: number;
  packets: number;
  drops: number;
  /** Wall-clock ms when this arrived here — `ageMs` goes stale immediately,
   *  this doesn't. */
  receivedAt: number;
}

export interface BridgeStatus {
  listening: boolean;
  port: number;
  mirrorPort: number;
  error: string;
}

/** Where a test pattern is aimed: the card's own Art-Net address. */
export interface TestPatternAddress {
  net: number;
  subnet: number;
  universe: number;
  count: number;
}

export type TestDest = 'mirror' | 'broadcast';

/** The generator's live settings. Session-scoped and held HERE, not in the
 *  card's gear panel: closing the panel, switching tabs or editing another
 *  sketch tears that element down, and a transmitter that stopped whenever its
 *  UI unmounted was unusable for the thing it exists for — leaving a pattern
 *  running while you go wire it up. */
export interface TestPatternState {
  running: boolean;
  pattern: TestPattern;
  /** Velocity-squash position, 0 = linear. Upward-only; see `velSquash`. */
  squash: number;
  dest: TestDest;
  /** Which `control.artnet` card started it — the others show Send, not Stop. */
  instanceKey: string;
  address: TestPatternAddress | null;
}

type Hot = {
  on(event: string, cb: (data: any) => void): void;
  send(event: string, data?: unknown): void;
};

export class ArtnetClient {
  private hot: Hot | null = null;
  private universes = new Map<string, UniverseInfo>();
  private enginePush: ((json: string) => void) | null = null;
  private lastPushedJson = '';
  private status: BridgeStatus = { listening: false, port: 0, mirrorPort: 0, error: '' };
  /** Bumps on every arriving frame so UI can cheaply poll for freshness. */
  private revision = 0;
  private test: TestPatternState = {
    running: false, pattern: 'chase', squash: 0, dest: 'mirror',
    instanceKey: '', address: null,
  };

  constructor(hot: unknown) {
    // `import.meta.hot` is undefined outside a dev server — the whole feature
    // is then absent rather than broken.
    if (!hot || typeof (hot as Hot).on !== 'function') return;
    this.hot = hot as Hot;
    this.hot.on(EV_STATUS, (data: BridgeStatus) => { this.status = data; });
    this.hot.on(EV_FRAME, (data: { universes: Record<string, any> }) => {
      const now = Date.now();
      for (const [key, u] of Object.entries(data?.universes ?? {})) {
        this.universes.set(key, {
          channels: new Uint8Array(u.ch ?? []),
          src: u.src ?? '',
          ageMs: u.ageMs ?? 0,
          packets: u.packets ?? 0,
          drops: u.drops ?? 0,
          receivedAt: now,
        });
      }
      this.revision++;
    });
    this.hot.send(EV_HELLO);
    // Nothing on the server tracks which browser asked for a pattern, so a
    // reload or a closed tab would leave it transmitting with no way to stop
    // it short of restarting the dev server. `pagehide` covers both (and fires
    // where `beforeunload` doesn't, on mobile / bfcache).
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        if (this.test.running) this.stopTestPattern();
      });
    }
  }

  /** False in a production build or with no dev server — callers should hide
   *  any Art-Net affordance rather than offer a dead one. */
  get isAvailable(): boolean { return this.hot !== null; }
  get bridgeStatus(): BridgeStatus { return this.status; }
  get frameRevision(): number { return this.revision; }

  /** One universe's current state, for meters and diagnostics. */
  universe(key: string): UniverseInfo | undefined { return this.universes.get(key); }

  /** Boot wires this to `engine.setInjectedScalars`. */
  bindEnginePush(push: (json: string) => void): void {
    this.enginePush = push;
    this.lastPushedJson = '';
  }

  /**
   * Lower the current channel tables through the composition's
   * `control.artnet` cards into the executor. Cheap enough to call every rAF:
   * with no cards, or no traffic, it builds one small string and pushes
   * nothing.
   */
  pushInjectedScalars(): void {
    if (!this.enginePush || !this.hot) return;
    const json = buildInjectedScalars(
      appState.database.sketches,
      key => this.universes.get(key)?.channels);
    if (json === this.lastPushedJson) return;
    this.lastPushedJson = json;
    this.enginePush(json);
  }

  /** The generator's session-scoped settings — see `TestPatternState`. */
  get testState(): Readonly<TestPatternState> { return this.test; }

  /** Pick the pattern / destination. Changing either while one is running
   *  restarts the generator on the new setting rather than waiting for Stop —
   *  and a destination change blacks out the old one on the way (the server's
   *  stop does that), so nothing is left latched on the port we just left. */
  setTestPattern(pattern: TestPattern): void {
    this.test.pattern = pattern;
    if (this.test.running) this.startTestPattern(this.test.instanceKey, this.test.address);
  }
  /** Move the velocity squash. Like the pattern, it restarts a running
   *  generator rather than waiting for Stop — the point of the control is to
   *  hear the difference while the signal is flowing. */
  setTestSquash(pos: number): void {
    const n = clampVelSquash(pos);
    if (this.test.squash === n) return;
    this.test.squash = n;
    if (this.test.running) this.startTestPattern(this.test.instanceKey, this.test.address);
  }
  setTestDest(dest: TestDest): void {
    if (this.test.dest === dest) return;
    this.test.dest = dest;
    if (this.test.running) this.startTestPattern(this.test.instanceKey, this.test.address);
  }

  /** Start (or re-aim) the dev server's transmitter for one card. */
  startTestPattern(instanceKey: string, address: TestPatternAddress | null): void {
    if (!this.hot || !address) return;
    this.test.running = true;
    this.test.instanceKey = instanceKey;
    this.test.address = { ...address };
    this.hot.send(EV_TEST, {
      action: 'start',
      pattern: this.test.pattern,
      squash: this.test.squash,
      dest: this.test.dest,
      ...address,
    });
  }

  /** Stop it — the server blacks out the universe on the way down. */
  stopTestPattern(): void {
    this.test.running = false;
    this.test.instanceKey = '';
    this.hot?.send(EV_TEST, { action: 'stop' });
  }
}

/** Process-wide instance; `isAvailable` is false when there's no dev server. */
export const artnetClient = new ArtnetClient(
  (import.meta as unknown as { hot?: unknown }).hot);
