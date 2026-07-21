/**
 * Ghost-device scan store — the composition-wide view behind the Devices
 * tab's "missing device" cards.
 *
 * Ghosts are reconstructed from `midi:` wires whose device uuid no library
 * instance answers to (ids ∪ knownAs aliases). In Live mode the editor DB
 * only holds the wired-for-editing instance's sketch, so a scan that only
 * read the DB would count ~1 sketch's wires while the composition holds 14×
 * that — `refresh()` prefetches every live barrel instance's sketch over the
 * bridge (appController.fetchLiveSketch, 3s-timeout one-shot; offline
 * placeholders resolve null and are skipped). DB copies win over prefetched
 * ones (the edited sketch's live edits are fresher).
 */

import { makeAutoObservable, observable, runInAction } from 'mobx';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { midiController } from '../../state/midi-controller';
import type { Sketch } from '../../sketch-types';
import { collectGhostDevices, type GhostDevice } from './device-wires-model';

class GhostScan {
  /** Live instances' sketches fetched over the bridge, by instance key. */
  prefetched = observable.map<string, Sketch>();
  scanning = false;

  constructor() {
    makeAutoObservable(this, { prefetched: false });
  }

  /**
   * Prefetch every live barrel instance's sketch. Cheap to call on every
   * Devices tab activation: playground resolves null for everything (no
   * bridge) and the map just stays empty.
   */
  async refresh(): Promise<void> {
    if (this.scanning) return;
    runInAction(() => { this.scanning = true; });
    try {
      const keys = appState.local.barrelInstances.map(i => i.key)
        .filter(k => !(k in appState.database.sketches));
      const fetched = await Promise.all(
        keys.map(async k => [k, await appController.fetchLiveSketch(k)] as const));
      runInAction(() => {
        this.prefetched.clear();
        for (const [k, sk] of fetched) if (sk) this.prefetched.set(k, sk);
      });
    } finally {
      runInAction(() => { this.scanning = false; });
    }
  }

  /** Current ghosts over DB ⊕ prefetched sketches (DB wins per key). */
  ghosts(): GhostDevice[] {
    const merged: Record<string, Sketch | undefined> = {};
    for (const [k, sk] of this.prefetched) merged[k] = sk;
    for (const k of Object.keys(appState.database.sketches)) {
      merged[k] = appState.database.sketches[k];
    }
    return collectGhostDevices(
      merged, Object.keys(merged), midiController.knownDeviceIds());
  }

  /** The ghost for a uuid, if any (details-panel branch). */
  ghost(deviceId: string): GhostDevice | undefined {
    return this.ghosts().find(g => g.deviceId === deviceId);
  }
}

export const ghostScan = new GhostScan();
