/**
 * The wire-mode "mask" over a connectable endpoint: the translucent box a
 * field row gets in W mode (inputs blue, outputs red), its hover / selected
 * states, and the mid-gesture drop-target highlight taps-connect toggles
 * (`[tap-drop-target]`). Shared by column-group's field hit-boxes and the
 * arrangement's I/O port pips so every wire endpoint reads the same.
 */

import { css } from 'lit';

export const tapHitStyles = css`
    /* Inputs (reads) — blue. */
    .tap-overlay-hit {
      position: absolute;
      background: rgba(65, 105, 225, 0.12);
      border: 1px solid rgba(65, 105, 225, 0.3);
      border-radius: 1px;
      cursor: pointer;
      pointer-events: all;
    }
    .tap-overlay-hit:hover {
      background: rgba(65, 105, 225, 0.25);
    }
    .tap-overlay-hit[selected] {
      outline: 1px solid var(--app-hi-color2, #4169E1);
      outline-offset: 1px;
      background: rgba(65, 105, 225, 0.2);
    }
    /* Output field overlay — writes are red. */
    .tap-overlay-hit.output {
      background: rgba(255, 69, 0, 0.14);
      border: 1px solid rgba(255, 69, 0, 0.35);
    }
    .tap-overlay-hit.output:hover {
      background: rgba(255, 69, 0, 0.28);
    }
    .tap-overlay-hit.output[selected] {
      outline-color: var(--app-hi-color1, #ff4500);
      background: rgba(255, 69, 0, 0.22);
    }
    /* Mid-gesture: the drop target under the pointer (taps-connect sets it). */
    .tap-overlay-hit[tap-drop-target] {
      outline: 2px solid var(--app-hi-color2, #4169E1);
      outline-offset: 1px;
      background: rgba(65, 105, 225, 0.35);
    }
    .tap-overlay-hit.output[tap-drop-target] {
      outline-color: var(--app-hi-color1, #ff4500);
      background: rgba(255, 69, 0, 0.35);
    }
`;
