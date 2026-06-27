/**
 * play-mode-controls.ts — the shared editable controls for a clip's play-mode
 * timing (mode / slice seconds / speed / direction / ping-pong / beat-lock).
 *
 * Rendered in BOTH the clip details panel (arr-clip-view) and the inspector
 * (arr-inspector) so there's one source of truth for the layout + behaviour. The
 * host wires `onPatch` to `store.updateClipLoop(track, clip, patch)` (undoable). The
 * styles are self-contained under `pm-*` class names; spread `playModeControlsStyles`
 * into the host's `static styles` (shadow DOM).
 */

import { html, css, type TemplateResult } from 'lit';
import type { ClipLoopConfig } from '../model/composition';
import { RANDOM_DEFAULTS } from '../model/composition';
import '../../../widgets/editable-number';
import '../../../widgets/bars-beats-field';
import '../../../widgets/scalar-slider';

export const playModeControlsStyles = css`
  .pm-row {
    font-size: var(--app-fs-sm);
    color: var(--app-text-color2);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .pm-seg {
    display: inline-flex;
    border: 1px solid var(--app-tint-4);
    border-radius: 2px;
    overflow: hidden;
    width: fit-content;
  }
  .pm-seg button {
    font-family: inherit;
    font-size: var(--app-fs-xs);
    border: none;
    background: var(--app-bg-color1);
    color: var(--app-text-color2);
    padding: 2px 7px;
    cursor: pointer;
  }
  .pm-seg button.on {
    background: var(--app-hi-color2);
    color: #fff;
  }
  .pm-slider {
    font-size: var(--app-fs-xs);
    width: 100%;
    min-width: 0;
  }
  .pm-num {
    font-size: var(--app-fs-xs);
    width: 64px;
    background: var(--app-bg-color1);
    color: var(--app-text-color1);
    border: 1px solid var(--app-tint-4);
    border-radius: 2px;
    --editable-text-pad: 1px 4px;
  }
  .pm-bbs {
    font-size: var(--app-fs-xs);
    width: fit-content;
    background: var(--app-bg-color1);
    color: var(--app-text-color1);
    border: 1px solid var(--app-tint-4);
    border-radius: 2px;
    padding: 1px 4px;
  }
  .pm-toggle {
    font-family: inherit;
    font-size: var(--app-fs-xs);
    width: fit-content;
    background: var(--app-bg-color1);
    color: var(--app-text-color2);
    border: 1px solid var(--app-tint-4);
    border-radius: 2px;
    padding: 2px 7px;
    cursor: pointer;
  }
  .pm-toggle.on {
    background: var(--app-hi-color2);
    color: #fff;
  }
`;

/**
 * The play-mode control rows. `videoDurSec` (source duration; 0 if unknown) seeds the
 * `End (s)` default. `onPatch` applies a partial loop update (undoable).
 */
export function renderPlayModeControls(
  loop: ClipLoopConfig,
  videoDurSec: number,
  onPatch: (patch: Partial<ClipLoopConfig>) => void,
  beatsPerBar = 4,
): TemplateResult {
  const looping = loop.mode === 'time' || loop.mode === 'beat-sync';
  const random = loop.mode === 'random';
  const endDefault = videoDurSec > 0 ? videoDurSec : 0;
  const num = (val: number, on: (n: number) => void, step = 0.1) => html`<editable-number
    class="pm-num"
    .value=${Number.isFinite(val) ? val : 0}
    .step=${step}
    .precision=${step >= 1 ? 0 : 3}
    @input=${(e: CustomEvent<number>) => on(e.detail)}
  ></editable-number>`;
  // A seconds-into-the-source SLIDER bounded by the source duration (double-click to
  // type an exact value). Falls back to the number input when the duration is unknown.
  const secSlider = (val: number, on: (n: number) => void, max: number) => max > 0
    ? html`<scalar-slider
        class="pm-slider"
        .value=${Number.isFinite(val) ? val : 0}
        .min=${0}
        .max=${max}
        .step=${Math.max(0.01, Math.round((max / 200) * 100) / 100)}
        .units=${'s'}
        @input=${(e: CustomEvent<number>) => on(e.detail)}
      ></scalar-slider>`
    : num(val, on);
  const seg = <T extends string>(opts: readonly T[], cur: T, on: (v: T) => void) => html`<div class="pm-seg">
    ${opts.map((o) => html`<button class=${cur === o ? 'on' : ''} @click=${() => on(o)}>${o}</button>`)}
  </div>`;
  return html`
    <div class="pm-row"><span>Play mode</span>
      ${seg(['one-shot', 'time', 'beat-sync', 'random'] as const, loop.mode, (m) => onPatch({ mode: m }))}
    </div>
    <div class="pm-row"><span>${random ? 'Range start (s)' : 'Start (s)'}</span>
      ${loop.mode === 'one-shot'
        // one-shot start may be negative (transparent lead-in) → free number input.
        ? num(loop.startSec ?? 0, (n) => onPatch({ startSec: n }))
        : secSlider(loop.startSec ?? 0, (n) => onPatch({ startSec: n }), endDefault)}
    </div>
    ${loop.mode === 'one-shot'
      ? ''
      : html`<div class="pm-row"><span>${random ? 'Range end (s)' : 'End (s)'}</span>${secSlider(loop.endSec ?? endDefault, (n) => onPatch({ endSec: n }), endDefault)}</div>`}
    ${looping
      ? html`<div class="pm-row"><span>Play start (s)</span>${secSlider(loop.playStartSec ?? loop.startSec ?? 0, (n) => onPatch({ playStartSec: n }), endDefault)}</div>`
      : ''}
    ${loop.mode === 'beat-sync'
      ? html`<div class="pm-row"><span>Loop (bars.beats.16ths)</span>
          <bars-beats-field
            class="pm-bbs"
            length
            .value=${loop.syncBeats ?? 4}
            .beatsPerBar=${beatsPerBar}
            .sixPerBeat=${4}
            .min=${0.25}
            @input=${(e: CustomEvent<number>) => onPatch({ syncBeats: e.detail })}
          ></bars-beats-field>
        </div>`
      : html`<div class="pm-row"><span>Speed</span>${num(loop.speed ?? 1, (n) => onPatch({ speed: n }))}</div>`}
    ${random
      ? html`<div class="pm-row"><span>Dwell</span>
          <div style="display:flex; gap:4px; align-items:center;">
            ${num(loop.dwell ?? RANDOM_DEFAULTS.dwell, (n) => onPatch({ dwell: n }))}
            ${seg(['beat', 'sec'] as const, loop.dwellUnit ?? RANDOM_DEFAULTS.dwellUnit, (u) => onPatch({ dwellUnit: u }))}
          </div>
        </div>
        <div class="pm-row"><span>Dwell jitter</span>${num(loop.dwellJitter ?? RANDOM_DEFAULTS.dwellJitter, (n) => onPatch({ dwellJitter: n }))}</div>
        <div class="pm-row"><span title="Each jump samples a distance uniformly in [min, max] from the current position">Jump distance</span>
          <div style="display:flex; gap:4px; align-items:center;">
            ${num(loop.jumpDistanceMin ?? RANDOM_DEFAULTS.jumpDistanceMin, (n) => onPatch({ jumpDistanceMin: n }))}
            <span style="opacity:0.6">–</span>
            ${num(loop.jumpDistanceMax ?? RANDOM_DEFAULTS.jumpDistanceMax, (n) => onPatch({ jumpDistanceMax: n }))}
            ${seg(['fraction', 'sec'] as const, loop.jumpDistanceUnit ?? RANDOM_DEFAULTS.jumpDistanceUnit, (u) => onPatch({ jumpDistanceUnit: u }))}
          </div>
        </div>`
      : ''}
    ${random
      ? ''
      : html`<div class="pm-row"><span>Direction</span>
          ${seg(['forward', 'reverse'] as const, loop.direction ?? 'forward', (d) => onPatch({ direction: d }))}
        </div>`}
    ${looping
      ? html`<div class="pm-row"><span>Ping-pong</span>
          <button class="pm-toggle ${loop.pingpong ? 'on' : ''}" @click=${() => onPatch({ pingpong: !loop.pingpong })}>
            ${loop.pingpong ? 'on' : 'off'}
          </button>
        </div>`
      : ''}
  `;
}
