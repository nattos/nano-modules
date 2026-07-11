/**
 * Unknown-MIDI-device "define it" snackbar offer (live-offers.ts pattern: a
 * plain MobX autorun over observable state — UI-only, no persistence/engine
 * sync rides this reaction).
 *
 * When a plugged-in MIDI input matches no library instance it lands in
 * `appState.local.midi.unknownPorts`; each such port gets ONE sticky snackbar
 * EVER (persisted in userSettings.midiOfferedPorts, so replug / rematch
 * churn / the next session never re-toast) offering to define it. "Define"
 * jumps to the Devices tab and enters define mode for that port (fork a
 * template/instance → claim). The snackbar auto-dismisses when the port
 * stops being unknown — claimed via define mode or unplugged. The Devices
 * tab's "unrecognized" card carries the persistent define affordance.
 */

import { autorun, untracked } from 'mobx';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { snackbars } from '../../widgets/snackbars';
import type { PhysicalIdentity } from '../../midi/midi-types';
import { devicesUi } from './devices-ui';

const portKey = (p: PhysicalIdentity) => `${p.manufacturer}|${p.name}`;

export function installDeviceDefineOffers(): void {
  // portKey → live snackbar id, so a port that stops being unknown can pull
  // its own snackbar down.
  const shown = new Map<string, number>();

  autorun(() => {
    const unknown = appState.local.midi.unknownPorts;
    const current = new Set(unknown.map(portKey));

    for (const [key, id] of shown) {
      if (!current.has(key)) {
        snackbars.dismiss(id);
        shown.delete(key);
      }
    }

    // Read the persisted offered set untracked: showing a toast records into
    // it below, and observing our own write would re-run the autorun for
    // nothing (the loop converges, but why churn).
    const offered = new Set(untracked(() => appState.local.userSettings.midiOfferedPorts));

    for (const port of unknown) {
      const key = portKey(port);
      if (offered.has(key)) continue;
      offered.add(key);
      appController.setUserSetting('midiOfferedPorts', [...offered]);
      const label = port.name || 'Unknown MIDI device';
      const id = snackbars.show({
        message: `Unknown MIDI device «${label}»`,
        timeoutMs: 0,
        dedupeKey: `midi-unknown-${key}`,
        actions: [{
          label: 'define',
          run: () => {
            // Each surface keys its tab bar differently: the effect IDE on
            // `ideLeftTab`, the unified surface on `activeTab`.
            if (appState.local.userSettings.appMode === 'effect-dev') {
              appController.setUserSetting('ideLeftTab', 'devices');
            } else {
              appController.setActiveTab('devices');
            }
            devicesUi.enterDefineMode(port);
          },
        }],
      });
      shown.set(key, id);
    }
  });
}
