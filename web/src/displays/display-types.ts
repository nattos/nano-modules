/**
 * Display devices — the library model (the devices push, D3).
 *
 * A display is a portable SLOT — "Display 1", "Display 2" — not a monitor. A
 * show places a slot (by its id, the same on every machine); each machine's
 * library says which physical screen fills it and how:
 *   - `screen`: remembered by a stable id — the CGDisplay UUID on macOS, the
 *     monitor's device path on Windows — never by index (indices reshuffle
 *     on hotplug). Absent = automatic: Display N takes the Nth screen
 *     that ISN'T the main one (the menu bar's), so a fresh machine never covers
 *     the editor. A remembered screen that isn't connected falls back to the
 *     automatic binding; with no screen at all the display is inert — an
 *     unplugged cable, not an error.
 *   - `mode`: fullscreen on that screen (the default), a normal WINDOW to
 *     rehearse in (a laptop, no projector), or SHARED with other apps (no
 *     screen at all) — a SYPHON server on macOS, a SPOUT sender on Windows:
 *     whichever the engine offers (comp_report.shareMode).
 *
 * Display 1 and Display 2 always exist (synthesised when the library has no
 * row for them); "New display" adds Display 3 and on. The native compositor
 * resolves the binding (comp_displays.h resolveDisplayScreen, lock-step with
 * resolveDisplayScreen here, which the UI uses to say where a display WILL
 * land) so a hotplug re-binds at once.
 *
 * Pure types + helpers — no DOM, no store.
 */

/** How the show's frame fits a display: Fit letterboxes in black, Fill crops,
 *  Stretch ignores the aspect. Lock-step: GPUBackend::PresentFit. */
export type DisplayFit = 'fit' | 'fill' | 'stretch';

export const DISPLAY_FITS: readonly { id: DisplayFit; label: string; title: string }[] = [
  { id: 'fit', label: 'Fit', title: 'The whole frame, black bars where the aspects differ' },
  { id: 'fill', label: 'Fill', title: 'Fill the screen, cropping the frame' },
  { id: 'stretch', label: 'Stretch', title: 'Fill the screen, ignoring the aspect' },
];

/** Where a display goes on this machine. Lock-step: comp_displays.h
 *  DisplayMode. */
export type DisplayMode = 'fullscreen' | 'window' | ShareMode;
/** Sharing the frame with other apps: Syphon (macOS) or Spout (Windows). */
export type ShareMode = 'syphon' | 'spout';

export const DISPLAY_MODES: readonly { id: DisplayMode; label: string; title: string }[] = [
  { id: 'fullscreen', label: 'fullscreen', title: 'Fullscreen on its screen' },
  { id: 'window', label: 'window', title: 'A normal window to rehearse in — no projector needed' },
  { id: 'syphon', label: 'syphon', title: 'A Syphon server other apps can read (Resolume, MadMapper, OBS…) — no screen' },
  { id: 'spout', label: 'spout', title: 'A Spout sender other apps can read (Resolume, TouchDesigner, OBS…) — no screen' },
];

/** The modes to offer where the engine shares by `share`. */
export function displayModesFor(share: ShareMode): typeof DISPLAY_MODES {
  return DISPLAY_MODES.filter((m) => m.id === 'fullscreen' || m.id === 'window' || m.id === share);
}

/** Does this mode hand the frame to other apps (no screen, no fit)? */
export function displayModeShares(mode: DisplayMode): mode is ShareMode {
  return mode === 'syphon' || mode === 'spout';
}

/** What a shared display is called to the viewer. */
export function shareModeLabel(mode: ShareMode): string {
  return mode === 'spout' ? 'Spout' : 'Syphon';
}

/** What identify asks the engine for. */
export interface DisplayIdentify { label: string; screenUuid: string; ordinal: number; mode: DisplayMode }

/** A screen as the native compositor reports it (comp_report.screens). */
export interface DisplayScreen {
  uuid: string;
  name: string;
  /** Pixels. */
  w: number;
  h: number;
  hz: number;
  /** The screen with the menu bar — the editor's, usually. */
  main: boolean;
}

/** A window's content rect, as this machine's compositor measures it: macOS
 *  in screen points, origin bottom-left; Windows in physical pixels, origin
 *  top-left. Only ever read back on the machine that wrote it. */
export interface WindowFrame { x: number; y: number; w: number; h: number }

/** One slot in this machine's library. */
export interface DisplaySlot {
  kind: 'display';
  /** `display.<n>` — portable: a show on another machine means that
   *  machine's Display n. */
  id: string;
  name: string;
  /** This machine's screen for it; absent = automatic. */
  screen?: { uuid: string; name: string };
  /** Where it goes (absent: fullscreen on its screen). */
  mode?: 'window' | ShareMode;
  /** Where that window was last (remembered when it moves). */
  windowFrame?: WindowFrame;
  updatedAt: number;
  deleted?: boolean;
}

export const DISPLAY_ID_PREFIX = 'display.';
/** Display 1 and 2 always exist. */
export const BUILTIN_DISPLAY_COUNT = 2;

export function displaySlotId(n: number): string {
  return `${DISPLAY_ID_PREFIX}${n}`;
}

/** 'display.3' → 3; 0 for anything else. */
export function displayOrdinal(id: string): number {
  if (!id.startsWith(DISPLAY_ID_PREFIX)) return 0;
  const n = Number(id.slice(DISPLAY_ID_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function defaultDisplaySlot(n: number): DisplaySlot {
  return { kind: 'display', id: displaySlotId(n), name: `Display ${n}`, updatedAt: 0 };
}

export function displayMode(slot: Pick<DisplaySlot, 'mode'>): DisplayMode {
  return slot.mode ?? 'fullscreen';
}

/**
 * Every slot this machine has, in order: Display 1 and 2 (the library's row,
 * else the default), then every other live row.
 */
export function librarySlots(rows: readonly DisplaySlot[]): DisplaySlot[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: DisplaySlot[] = [];
  for (let n = 1; n <= BUILTIN_DISPLAY_COUNT; n++) {
    const r = byId.get(displaySlotId(n));
    out.push(r && !r.deleted ? r : defaultDisplaySlot(n));
  }
  const rest = rows
    .filter((r) => !r.deleted && displayOrdinal(r.id) > BUILTIN_DISPLAY_COUNT)
    .sort((a, b) => displayOrdinal(a.id) - displayOrdinal(b.id));
  return [...out, ...rest];
}

/** A slot by id: the library's, a built-in's default, or — for a slot this
 *  machine has never configured (a show from elsewhere) — a default. */
export function librarySlot(rows: readonly DisplaySlot[], id: string, label?: string): DisplaySlot | undefined {
  const n = displayOrdinal(id);
  if (!n) return undefined;
  const r = rows.find((x) => x.id === id && !x.deleted);
  if (r) return r;
  const d = defaultDisplaySlot(n);
  return label ? { ...d, name: label } : d;
}

/**
 * Which of `screens` a slot lands on (fullscreen), or -1: its remembered
 * screen if connected, else the Nth screen that isn't the main one. Lock-step:
 * native bridge/comp_displays.cpp resolveDisplayScreen.
 */
export function resolveDisplayScreen(slot: Pick<DisplaySlot, 'id' | 'screen'>,
                                     screens: readonly DisplayScreen[]): number {
  if (slot.screen) {
    const i = screens.findIndex((s) => s.uuid === slot.screen!.uuid);
    if (i >= 0) return i;
  }
  const ordinal = Math.max(1, displayOrdinal(slot.id));
  let n = 0;
  for (let i = 0; i < screens.length; i++) {
    if (screens[i].main) continue;
    if (++n === ordinal) return i;
  }
  return -1;
}
