/**
 * Devices-tab UI state — a small MobX module store (snackbars-store pattern).
 *
 * Panel-local, ephemeral view state. Deliberately NOT part of the global
 * Selectable registry in appState.local: control selection here drives the
 * floating mapping panel, while the sketch editor's selection keeps driving
 * its inspector independently. Persisted bits (group filters, monitor height)
 * live in UserSettings instead.
 *
 * Selection targets are (deviceId, controlId) pairs where deviceId may be a
 * TEMPLATE id — editing a template's mapping lazy-forks it (the details panel
 * re-targets selection to the fork id returned by the midi controller).
 */

import { makeAutoObservable } from 'mobx';
import type { PhysicalIdentity } from '../../midi/midi-types';

export interface ControlSelection {
  deviceId: string;
  /** Physical control id ('b0/e05'), not a gesture endpoint. */
  controlId: string;
}

class DevicesUiStore {
  /** Selected controls; first entry is the primary/anchor (details panel). */
  selectedControls: ControlSelection[] = [];
  /** DEFINE MODE: the unknown port being bound, or null. */
  defineMode: PhysicalIdentity | null = null;
  /** Bank shown per device card (UI view state; the hardware's live bank is
   *  in appState.local.midi.activeBanks). Keyed by instance/template id. */
  activeBank: Record<string, number> = {};
  /** Card-level selection (rename/delete/restore affordances). */
  selectedCardId: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  selectCard(id: string | null): void {
    this.selectedCardId = id;
    if (id !== null) this.selectedControls = [];
  }

  selectControl(deviceId: string, controlId: string, opts: { additive?: boolean } = {}): void {
    this.selectedCardId = null;
    const idx = this.selectedControls.findIndex(
      s => s.deviceId === deviceId && s.controlId === controlId);
    if (opts.additive) {
      if (idx >= 0) this.selectedControls.splice(idx, 1);
      else this.selectedControls.push({ deviceId, controlId });
    } else {
      this.selectedControls = [{ deviceId, controlId }];
    }
  }

  /** Selection follows a lazy fork: template-id targets become the fork's. */
  retargetSelection(fromDeviceId: string, toDeviceId: string): void {
    for (const s of this.selectedControls) {
      if (s.deviceId === fromDeviceId) s.deviceId = toDeviceId;
    }
    if (this.selectedCardId === fromDeviceId) this.selectedCardId = toDeviceId;
    const bank = this.activeBank[fromDeviceId];
    if (bank !== undefined) this.activeBank[toDeviceId] = bank;
  }

  clearSelection(): void {
    this.selectedControls = [];
    this.selectedCardId = null;
  }

  isControlSelected(deviceId: string, controlId: string): boolean {
    return this.selectedControls.some(
      s => s.deviceId === deviceId && s.controlId === controlId);
  }

  enterDefineMode(port: PhysicalIdentity): void {
    this.defineMode = { ...port };
    this.clearSelection();
  }

  exitDefineMode(): void {
    this.defineMode = null;
  }

  setBank(deviceId: string, bank: number): void {
    this.activeBank[deviceId] = bank;
  }

  bankFor(deviceId: string): number {
    return this.activeBank[deviceId] ?? 0;
  }
}

export const devicesUi = new DevicesUiStore();
