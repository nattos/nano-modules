/**
 * <arr-scene-lane> — the lane body of a SCENE track: a horizontal row of
 * launchable <arr-scene> cells (array order, no timeline), a stop button
 * (the track's scene slot empties), and an add affordance. The scene grid's
 * whole point is that it does NOT pan/zoom with the beat grid — you always
 * know where your scenes are.
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import './arr-scene';

@customElement('arr-scene-lane')
export class ArrSceneLane extends MobxLitElement {
  @property({ attribute: false }) trackId!: string;
  @property({ attribute: false }) accent = 'var(--app-cat-source)';

  static styles = css`
    :host {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: stretch;
      gap: 6px;
      padding: 4px 6px;
      overflow-x: auto;
      overflow-y: hidden;
      box-sizing: border-box;
    }
    .stop {
      flex: 0 0 auto;
      width: 26px;
      align-self: stretch;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      background: var(--app-bg-2, #121318);
      color: rgba(255, 255, 255, 0.6);
      cursor: pointer;
      font-size: 10px;
    }
    .stop:hover {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.3);
    }
    .stop.armed {
      color: var(--app-cat-source, #57b47a);
      border-color: var(--app-cat-source, #57b47a);
    }
    .square {
      width: 8px;
      height: 8px;
      background: currentColor;
    }
    .add {
      flex: 0 0 auto;
      width: 48px;
      align-self: stretch;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px dashed rgba(255, 255, 255, 0.18);
      border-radius: 4px;
      color: rgba(255, 255, 255, 0.45);
      cursor: pointer;
      font-size: 16px;
      user-select: none;
    }
    .add:hover {
      color: #fff;
      border-color: rgba(255, 255, 255, 0.4);
    }
  `;

  render() {
    const track = store.trackById(this.trackId);
    if (!track) return html``;
    const playing = !!store.sceneLaunchState[this.trackId];
    const accent = track.color ?? this.accent;
    return html`
      <div
        class="stop ${playing ? 'armed' : ''}"
        title="Stop the playing scene"
        @pointerdown=${(e: PointerEvent) => {
          e.stopPropagation();
          store.stopScene(this.trackId);
        }}
      >
        <div class="square"></div>
      </div>
      ${repeat(
        track.clips,
        (c) => c.id,
        (c) => html`<arr-scene .trackId=${this.trackId} .clip=${c} .accent=${accent}></arr-scene>`,
      )}
      <div
        class="add"
        title="Add a scene"
        @pointerdown=${(e: PointerEvent) => {
          e.stopPropagation();
          store.createEmptyClip(this.trackId, 0);
        }}
      >
        +
      </div>
    `;
  }
}
