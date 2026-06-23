/**
 * Persist the arrangement's WORKSPACE LAYOUT (not the document) in user settings:
 * which tabs/panels were open, panel sizes, edit modes, and the last open file.
 * One record in the shared `settings` IndexedDB store.
 */

import { idbGet, idbPut, STORE_SETTINGS } from '../../../state/idb-store';

const KEY = 'arr-layout';

export interface ArrLayout {
  activeRightTab?: string;
  clipViewOpen?: boolean;
  clipViewHeight?: number;
  sidePanelWidth?: number;
  headerWidth?: number;
  monitorHeight?: number;
  wiresMode?: boolean;
  automationMode?: boolean;
  /** Name of the last-opened arrangement file (re-opened on next mount). */
  lastFile?: string | null;
}

export async function saveLayout(layout: ArrLayout): Promise<void> {
  await idbPut(STORE_SETTINGS, { id: KEY, ...layout });
}

export async function loadLayout(): Promise<ArrLayout | null> {
  const rec = await idbGet<ArrLayout & { id: string }>(STORE_SETTINGS, KEY);
  if (!rec) return null;
  const { id: _id, ...layout } = rec;
  return layout;
}
