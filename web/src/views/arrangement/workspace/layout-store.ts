/**
 * Persist the arrangement's WORKSPACE LAYOUT (not the document) in user settings:
 * which tabs/panels were open, panel sizes, edit modes, and the last open file.
 * One record in the shared `settings` IndexedDB store — or, in the desktop app,
 * the `layout` section of `Settings/arrangement.json` (settings-files.ts),
 * which an external edit updates live (`watchLayout`).
 */

import { idbGet, idbPut, STORE_SETTINGS } from '../../../state/idb-store';
import {
  readSection, settingsFilesAvailable, SETTINGS_FILES, watchSection, writeSection,
} from '../../../state/settings-files';

const FILE = SETTINGS_FILES.arrangement;
const SECTION = 'layout';

const KEY = 'arr-layout';

export interface ArrLayout {
  activeRightTab?: string;
  clipViewOpen?: boolean;
  clipViewHeight?: number;
  sidePanelWidth?: number;
  sideCollapsed?: boolean;
  headerWidth?: number;
  monitorHeight?: number;
  wiresMode?: boolean;
  automationMode?: boolean;
  helpMode?: boolean;
  /** Name of the last-opened arrangement file (re-opened on next mount). */
  lastFile?: string | null;
}

export async function saveLayout(layout: ArrLayout): Promise<void> {
  if (settingsFilesAvailable()) { writeSection(FILE, SECTION, layout); return; }
  await idbPut(STORE_SETTINGS, { id: KEY, ...layout });
}

export async function loadLayout(): Promise<ArrLayout | null> {
  if (settingsFilesAvailable()) {
    const l = readSection<ArrLayout>(FILE, SECTION);
    return l && typeof l === 'object' ? l : null;
  }
  const rec = await idbGet<ArrLayout & { id: string }>(STORE_SETTINGS, KEY);
  if (!rec) return null;
  const { id: _id, ...layout } = rec;
  return layout;
}

/** Desktop only: `cb` whenever the file's `layout` section is edited from
 *  outside. A no-op in the browser. */
export function watchLayout(cb: (layout: ArrLayout) => void): () => void {
  return watchSection<ArrLayout>(FILE, SECTION, (l) => { if (l && typeof l === 'object') cb(l); });
}
