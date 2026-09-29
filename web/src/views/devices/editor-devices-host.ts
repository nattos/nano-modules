/**
 * The sketch editor's DevicesHost (Remote Control's Live + Playground, and
 * Effect Dev): the Devices panel over appController / appState, with the
 * composition-wide ghost scan (Live mode prefetches every instance's sketch
 * over the bridge). Installed on import — the editor surfaces that mount
 * <devices-tab> import this module.
 */

import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { instanceDisplayLabel } from '../../state/instance-labels';
import { tapsConnect } from '../../widgets/taps-connect';
import { scrollToAndFlashField } from '../../widgets/field-anchor-lookup';
import type { Wire } from '../../sketch-types';
import { ghostScan } from './ghost-scan';
import { setDevicesHost, type DevicesHost } from './devices-host';

export const editorDevicesHost: DevicesHost = {
  sketches: () => ghostScan.compositionSketches(),
  scanIds: () => {
    const editing = appState.local.editingSketchId;
    return [
      ...(editing ? [editing] : []),
      ...appState.local.barrelInstances.map((i) => i.key),
    ];
  },
  currentSketchId: () => appState.local.editingSketchId,
  sketchLabel: (id) => instanceDisplayLabel(id),
  // Everywhere in Playground (the worker runs every instance); in Live only
  // the edited instance pushes its sketch to Resolume.
  canEditWires: (id) => !appState.local.barrelMode || id === appState.local.editingSketchId,
  fieldDef: (moduleType, field) =>
    appState.local.plugins.find((p) => p.id === moduleType)?.schema?.[field] as Record<string, any> | undefined,
  wireOps: (sketchId, wireId) => ({
    getWire: (): Wire | undefined =>
      appState.database.sketches[sketchId]?.wires?.find((w) => w.id === wireId),
    updateWire: (patch) => appController.updateWire(sketchId, wireId, patch),
    beginUpdateWire: (patch) => appController.beginUpdateWire(sketchId, wireId, patch),
    updateUpdateWire: (edit: any, patch) => appController.updateUpdateWire(edit, sketchId, wireId, patch),
  }),
  removeWire: (sketchId, wireId) => appController.removeWire(sketchId, wireId),
  // Open the dest instance (if not already being edited), select the dest
  // field (surfaces its floating card), scroll to it and flash it.
  locate: (sketchId, chainIdx, field) => {
    if (appState.local.editingSketchId !== sketchId) appController.selectBarrelInstance(sketchId);
    const key = `${sketchId}/0/${chainIdx}/${field}`;
    appController.selectField(key);   // queues until the editor renders it
    scrollToAndFlashField(key);
  },
  refreshScan: () => ghostScan.refresh(),
  scanning: () => ghostScan.scanning,
  wiresMode: () => appState.local.tappingMode,
  connect: () => tapsConnect,
  filters: () => appState.local.userSettings.deviceFilters,
  setFilters: (f) => appController.setUserSetting('deviceFilters', { ...f, inUse: !!f.inUse }),
  // Above the floating output monitor the Devices tab pops out.
  detailsBottomInset: () => appState.local.userSettings.devicesMonitorHeight,
  get usageLabel() {
    return appState.local.barrelMode ? 'wired in the composition' : 'wired in these sketches';
  },
};

setDevicesHost(editorDevicesHost);
