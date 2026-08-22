/**
 * The tab rail's MODE pills — the toggles that sit under the tabs in
 * <app-tab-bar>, each the twin of a bare-key shortcut in the editor.
 *
 * They live together here, and not beside the surfaces they switch, so the
 * set stays legible as a set: one place that says which modes the rail
 * offers, what letter each carries, and what colour it lights.
 *
 * Every factory reads the mode's observable on CALL, so a surface must build
 * its toggles inside `render()` — the pill then tracks a change made from
 * anywhere else (the keyboard, a wire drop that opens the canvas).
 */

import { appState } from '../state/app-state';
import { appController } from '../state/controller';
import type { AppToggleDef } from './app-tab-bar';

/**
 * `W` — wires (tapping) mode: field rows become wire ports, and the surfaces
 * that draw arcs start drawing them.
 *
 * Deliberately the SAME orange as the arrangement transport's W pill: this is
 * one mode across surfaces, not two that happen to share a letter.
 */
export function wiresModeToggle(): AppToggleDef {
  const on = appState.local.tappingMode;
  return {
    id: 'wires',
    icon: 'la-project-diagram',
    letter: 'W',
    title: 'Wires — show field ports and modulation wires (W)',
    active: on,
    accent: 'var(--app-io-output)',
    onToggle: () => appController.setTappingMode(!on),
  };
}

/**
 * `C` — the sidecar node canvas, opened beside the linear effects list.
 *
 * Blue (the rail's own active accent) rather than W's orange: the canvas is a
 * surface, not a wiring mode, and the two must not read as the same thing
 * sitting a few pixels apart.
 */
export function canvasModeToggle(): AppToggleDef {
  const open = appState.local.userSettings.sketchCanvasOpen === true;
  return {
    id: 'canvas',
    icon: 'la-object-group',
    letter: 'C',
    title: 'Canvas — open the sidecar node canvas (C)',
    active: open,
    onToggle: () => appController.setSketchCanvasOpen(!open),
  };
}
