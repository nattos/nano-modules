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
import type { TestPattern } from './artnet-packet';

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

export interface TestPatternRequest {
  pattern: TestPattern;
  net: number;
  subnet: number;
  universe: number;
  count: number;
  dest: 'mirror' | 'broadcast';
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

  /** Start a test pattern on the dev server's transmitter. */
  startTestPattern(req: TestPatternRequest): void {
    this.hot?.send(EV_TEST, { action: 'start', ...req });
  }

  /** Stop it — the server blacks out the universe on the way down. */
  stopTestPattern(): void {
    this.hot?.send(EV_TEST, { action: 'stop' });
  }
}

/** Process-wide instance; `isAvailable` is false when there's no dev server. */
export const artnetClient = new ArtnetClient(
  (import.meta as unknown as { hot?: unknown }).hot);
