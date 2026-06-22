/**
 * <transport-bar> — top-center transport (play/stop/loop, position, BPM,
 * play-mode, Precise/Live). Mockup: position is static unless played; "Live"
 * mode is disabled in v1.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../../mobx-lit-element';
import { store } from '../state/store';
import '../../../widgets/ui-icon';

@customElement('transport-bar')
export class TransportBar extends MobxLitElement {
  static styles = css`
    :host {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      height: 40px;
      padding: 0 var(--app-sp-5);
      gap: var(--app-sp-4);
    }
    .brand {
      font-size: var(--app-fs-lg);
      color: var(--app-text-color2);
      letter-spacing: 0.04em;
    }
    .brand b {
      color: var(--app-text-color1);
      font-weight: 600;
    }
    .center {
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      justify-self: center;
    }
    .right {
      justify-self: end;
      display: flex;
      align-items: center;
      gap: var(--app-sp-3);
      color: var(--app-text-color2);
      font-size: var(--app-fs-sm);
    }
    button {
      font-family: inherit;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      height: 24px;
      min-width: 26px;
      padding: 0 var(--app-sp-3);
      font-size: var(--app-fs-md);
      cursor: pointer;
    }
    button:hover {
      background: var(--app-tint-2);
    }
    button.active {
      border-color: var(--app-hi-color2);
      color: var(--app-hi-color2);
    }
    button.play.active {
      border-color: var(--app-ok);
      color: var(--app-ok);
    }
    button ui-icon {
      --icon-size: 13px;
    }
    button.autobtn {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      font-size: var(--app-fs-sm);
      font-weight: 600;
    }
    button.autobtn.active {
      border-color: var(--app-cat-mod);
      color: var(--app-cat-mod);
    }
    button.autobtn.wires.active {
      border-color: var(--app-io-output);
      color: var(--app-io-output);
    }
    .pos {
      font-variant-numeric: tabular-nums;
      font-size: var(--app-fs-lg);
      color: var(--app-hi-color4);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-3);
      border-radius: 2px;
      padding: 3px var(--app-sp-4);
      min-width: 92px;
      text-align: center;
    }
    .field {
      display: flex;
      align-items: center;
      gap: var(--app-sp-2);
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    input.bpm {
      width: 46px;
      font-family: inherit;
      font-size: var(--app-fs-md);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 3px var(--app-sp-2);
      text-align: right;
    }
    select {
      font-family: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      padding: 3px var(--app-sp-2);
    }
    .seg {
      display: inline-flex;
      border: 1px solid var(--app-tint-4);
      border-radius: 2px;
      overflow: hidden;
    }
    .seg button {
      border: none;
      border-radius: 0;
      height: 22px;
    }
    .seg button.on {
      background: var(--app-hi-color2);
      color: #fff;
    }
    .seg button[disabled] {
      color: var(--app-text-color2);
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  render() {
    const meta = store.composition.meta;
    const beatsPerBar = meta.timeSignature[0];
    const pos = store.positionBeat;
    const bar = Math.floor(pos / beatsPerBar) + 1;
    const beat = Math.floor(pos % beatsPerBar) + 1;
    const tick = Math.floor((pos % 1) * 4) + 1;
    const posStr = `${bar}.${beat}.${tick}`;

    return html`
      <div class="brand">nano <b>arrangement</b></div>

      <div class="center">
        <button title="Stop" @click=${() => store.stop()}>
          <ui-icon icon="la-stop"></ui-icon>
        </button>
        <button
          class="play ${store.playing ? 'active' : ''}"
          title="Play / Pause"
          @click=${() => store.togglePlay()}
        >
          <ui-icon icon=${store.playing ? 'la-pause' : 'la-play'}></ui-icon>
        </button>
        <button
          class="${store.loopEnabled ? 'active' : ''}"
          title="Loop"
          @click=${() => store.toggleLoop()}
        >
          <ui-icon icon="la-redo-alt"></ui-icon>
        </button>

        <div class="pos">${posStr}</div>

        <div class="field">
          <input
            class="bpm"
            type="number"
            .value=${String(meta.baseBPM)}
            @change=${this.onBpm}
          />
          <span>BPM</span>
        </div>

        <button
          class="autobtn ${store.automationMode ? 'active' : ''}"
          title="Automation mode — reveal all automation lanes"
          @click=${() => store.toggleAutomationMode()}
        >
          <ui-icon icon="la-bezier-curve"></ui-icon> A
        </button>
        <button
          class="autobtn wires ${store.wiresMode ? 'active' : ''}"
          title="Wires — show rail modulation wires"
          @click=${() => store.toggleWiresMode()}
        >
          <ui-icon icon="la-project-diagram"></ui-icon> W
        </button>

        <div class="seg" title="Precise always waits. Live is future.">
          <button
            class=${store.transportMode === 'precise' ? 'on' : ''}
            @click=${() => store.setTransportMode('precise')}
          >
            Precise
          </button>
          <button disabled title="Live mode — future">Live</button>
        </div>
      </div>

      <div class="right">
        ${meta.resolution.width}×${meta.resolution.height}
      </div>
    `;
  }

  private onBpm = (e: Event) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (!Number.isNaN(v)) store.setBpm(v);
  };
}
