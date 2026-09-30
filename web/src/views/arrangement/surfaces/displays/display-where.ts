/**
 * Where a display lands, in words — one place for the card, the row, the
 * inspector and the details panel to say it the same way.
 */

import { displayMode, type DisplayScreen, type DisplaySlot } from '../../../../displays/display-types';
import { engineBridge } from '../../engine/engine-bridge';
import { displayController } from '../../state/display-controller';
import { outputMaster } from '../../state/output-master';
import { store } from '../../state/store';

export function screenLabel(s: DisplayScreen): string {
  return `${s.name} · ${s.w}×${s.h}${s.hz ? ` · ${Math.round(s.hz)} Hz` : ''}`;
}

export interface DisplayWhere {
  text: string;
  /** 'live' (showing now), 'off', 'local' (this engine can't), 'none' (no
   *  screen), 'idle' (not in the show). */
  state: 'live' | 'off' | 'local' | 'none' | 'idle';
}

/** A slot's state: placed (`placementId`) — what it shows now; else where it
 *  would land. */
export function displayWhere(slot: DisplaySlot, placementId?: string): DisplayWhere {
  const p = placementId ? store.placementById(placementId) : undefined;
  if (p) {
    if (!engineBridge.outputsDisplays) return { text: 'this engine doesn’t output displays', state: 'local' };
    if (p.enabled === false) return { text: 'off', state: 'off' };
    if (!outputMaster.armed) return { text: 'output is off (the Devices panel’s switch)', state: 'off' };
    const st = displayController.status[p.id];
    switch (st?.state) {
      case 'showing':
        return { text: st.screen ? screenLabel(st.screen) : `${st.width}×${st.height}`, state: 'live' };
      case 'window':
        return { text: `window · ${st.width}×${st.height}`, state: 'live' };
      case 'syphon':
        return { text: `Syphon · “${slot.name}” · ${st.width}×${st.height}`, state: 'live' };
      case 'spout':
        return { text: `Spout · “Nano Modules - ${slot.name}” · ${st.width}×${st.height}`, state: 'live' };
      case 'no-screen':
        return { text: 'no screen for it', state: 'none' };
      case 'no-output':
        return { text: 'can’t open displays here', state: 'local' };
      default:
        return { text: 'opening…', state: 'off' };
    }
  }
  if (displayMode(slot) === 'window') return { text: 'rehearses in a window', state: 'idle' };
  if (displayMode(slot) === 'syphon') return { text: `Syphon server “${slot.name}”`, state: 'idle' };
  if (displayMode(slot) === 'spout') return { text: `Spout sender “Nano Modules - ${slot.name}”`, state: 'idle' };
  if (!displayController.screens) {
    return { text: slot.screen ? slot.screen.name : 'automatic screen', state: 'idle' };
  }
  const s = displayController.screenFor(slot);
  return s ? { text: `→ ${screenLabel(s)}`, state: 'idle' } : { text: 'no screen connected', state: 'none' };
}
