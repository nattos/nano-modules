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
 * placeholders resolve null and are skipped). The edited instance always
 * comes from the DB (its live edits are fresher); the others prefer the
 * prefetch, since the DB copy of an instance you've left is never updated.
 *
 * The Devices tab's wires panel reads the same merged view, so it lists the
 * wires of every instance, not only the ones opened this session.
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
  /** A refresh asked for while one was in flight — run once more after it,
   *  so a switch of edited instance mid-scan isn't lost. */
  private again = false;

  constructor() {
    makeAutoObservable(this, { prefetched: false });
  }

  /**
   * Prefetch every live barrel instance's sketch EXCEPT the one being edited
   * (the editor holds that one, live). Cheap to call on every Devices tab
   * activation and every switch of edited instance: playground resolves null
   * for everything (no bridge) and the map just stays empty.
   *
   * The other instances are fetched even when the DB holds a copy: in Live
   * the DB keeps whatever it had when you last left an instance, and nothing
   * updates it after that.
   */
  async refresh(): Promise<void> {
    if (this.scanning) { this.again = true; return; }
    const editing = appState.local.editingSketchId;
    runInAction(() => {
      this.scanning = true;
      // The instance just left: its DB copy is fresher than any prefetch
      // taken before the switch, so let the DB answer until the fetch lands.
      for (const k of [...this.prefetched.keys()]) {
        if (k in appState.database.sketches) this.prefetched.delete(k);
      }
    });
    try {
      const keys = appState.local.barrelInstances.map(i => i.key).filter(k => k !== editing);
      const fetched = await Promise.all(
        keys.map(async k => [k, await appController.fetchLiveSketch(k)] as const));
      runInAction(() => {
        this.prefetched.clear();
        for (const [k, sk] of fetched) if (sk) this.prefetched.set(k, sk);
      });
    } finally {
      runInAction(() => { this.scanning = false; });
    }
    if (this.again) {
      this.again = false;
      await this.refresh();
    }
  }

  /**
   * Every instance's sketch this client can see: the edited instance from the
   * DB (live edits), the rest from the prefetch when there is one, else the
   * DB. Playground has no prefetch, so this is just the DB there.
   */
  compositionSketches(): Record<string, Sketch | undefined> {
    const editing = appState.local.editingSketchId;
    const merged: Record<string, Sketch | undefined> = {};
    for (const k of Object.keys(appState.database.sketches)) {
      merged[k] = appState.database.sketches[k];
    }
    for (const [k, sk] of this.prefetched) {
      if (k !== editing) merged[k] = sk;
    }
    return merged;
  }

  /** Current ghosts over the whole composition (compositionSketches). */
  ghosts(): GhostDevice[] {
    const merged = this.compositionSketches();
    return collectGhostDevices(
      merged, Object.keys(merged), midiController.knownDeviceIds());
  }

  /** The ghost for a uuid, if any (details-panel branch). */
  ghost(deviceId: string): GhostDevice | undefined {
    return this.ghosts().find(g => g.deviceId === deviceId);
  }
}

export const ghostScan = new GhostScan();
