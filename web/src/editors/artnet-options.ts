/**
 * <artnet-options> — the `control.artnet` card's GEAR panel: channel count,
 * live feed status, and the dev-server test-pattern generator.
 *
 * Registered against the `options` slot rather than `inspector`, so the card
 * body still renders the effect's own fields — which matters more here than
 * usual: the sixteen `ch_N` outputs ARE the feature, and a custom inspector
 * replacing the body would have to re-render every one of them to keep its tap
 * anchors and wire targets.
 *
 * `channel_count` sits here for the same reason `input_count` does on the math
 * nodes: it changes the card's SHAPE, not a value.
 *
 * The test-pattern half is DEV-ONLY and hides itself entirely when the dev
 * server's UDP bridge isn't there (a production build, or Live mode, where the
 * native listener inside the shared server is authoritative). Better to show
 * nothing than an affordance that can't work.
 *
 * Its settings — pattern, destination, whether it's running — belong to
 * `artnetClient` for the session, not to this element. You close the gear panel
 * to go wire the channels up, and that used to unmount the element and stop the
 * signal at the moment you needed it.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import type { FieldBinding } from '../widgets/field-editor';
import { artnetClient, type TestDest, type TestPatternAddress } from '../artnet/artnet-client';
import { ARTNET_MAX_FIELDS, ARTNET_MODULE_TYPE } from '../artnet/artnet-lowering';
import { TEST_PATTERNS, universeKey, type TestPattern } from '../artnet/artnet-packet';
import '../widgets/field-tab-bar';
import '../widgets/ui-button';

const COUNT_OPTIONS = Array.from(
  { length: ARTNET_MAX_FIELDS },
  (_, i) => ({ label: String(i + 1), value: i + 1 }),
);

const PATTERN_LABELS: Record<TestPattern, string> = {
  chase: 'Chase',
  pulse: 'Pulse',
  ramp: 'Ramp',
  flat: 'Flat',
  beatsync: 'Beat',
};

/** How often the status line re-reads the bridge. The card doesn't need
 *  per-frame precision; it needs to stop saying "live" once a feed dies. */
const POLL_MS = 250;

@customElement('artnet-options')
export class ArtnetOptions extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  /** Bumped by the poll timer purely to force a re-render of the live status —
   *  the client's tables are plain Maps, not observables. Pattern / dest /
   *  running are NOT held here: they live on `artnetClient` for the session, so
   *  closing this panel (or switching tabs, or editing another sketch) doesn't
   *  tear the transmitter down with the element. */
  @state() private tick = 0;

  private timer: ReturnType<typeof setInterval> | null = null;

  static styles = css`
    :host { display: flex; flex-direction: column; gap: var(--app-sp-2); }
    .section {
      display: flex; flex-direction: column; gap: var(--app-sp-1);
      padding-top: var(--app-sp-2);
      border-top: 1px solid var(--app-tint-3);
    }
    .label {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    .row { display: flex; gap: var(--app-sp-1); flex-wrap: wrap; align-items: center; }
    .status { font-size: var(--app-fs-sm); }
    .live { color: var(--app-text-color1); }
    .dead { color: var(--app-text-color2); }
    .warn { color: var(--app-warn-color, #d98d3a); }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (artnetClient.isAvailable) {
      this.timer = setInterval(() => { this.tick++; this.followAddress(); }, POLL_MS);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Deliberately does NOT stop the pattern: you close the gear panel to go
    // wire the channels up, which is exactly when you want the signal flowing.
    // It stops on Stop, on another card taking over, or on page unload
    // (ArtnetClient's pagehide) — and the dev server blacks out on the way.
  }

  private address(): TestPatternAddress {
    const b = this.binding;
    const num = (path: string, fallback: number) => {
      const v = b?.getValue(path);
      return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
    };
    return {
      net: num('net', 0),
      subnet: num('subnet', 0),
      universe: num('universe', 1),
      count: num('channel_count', 4),
    };
  }

  /** True when the running pattern is THIS card's — a second Art-Net card
   *  offers Send (which takes the transmitter over), not Stop. */
  private get isMine(): boolean {
    const t = artnetClient.testState;
    return t.running && t.instanceKey === this.binding?.instanceKey;
  }

  private startTest() {
    artnetClient.startTestPattern(this.binding?.instanceKey ?? '', this.address());
    this.requestUpdate();
  }

  private stopTest() {
    artnetClient.stopTestPattern();
    this.requestUpdate();
  }

  private toggleTest() {
    if (this.isMine) this.stopTest();
    else this.startTest();
  }

  /** Retarget a running pattern when the card it belongs to is re-addressed —
   *  editing Universe with the generator on should move the signal, not leave
   *  it lighting the universe you just left. */
  private followAddress() {
    if (!this.isMine) return;
    const a = this.address();
    const cur = artnetClient.testState.address;
    if (cur && cur.net === a.net && cur.subnet === a.subnet
        && cur.universe === a.universe && cur.count === a.count) return;
    this.startTest();
  }

  private renderStatus() {
    const addr = this.address();
    const info = artnetClient.universe(universeKey(addr.net, addr.subnet, addr.universe));
    const bridge = artnetClient.bridgeStatus;
    if (!bridge.listening) {
      return html`<div class="status warn">
        bridge not listening${bridge.error ? ` — ${bridge.error}` : ''}
      </div>`;
    }
    // Bound the mirror but not 6454: something holds Art-Net's port without
    // SO_REUSEPORT. Test patterns still work; a live rig's stream won't reach
    // us until it mirrors. Say which, rather than just showing an empty card.
    const partial = bridge.port === 0 ? html`
      <div class="status warn">
        port 6454 unavailable${bridge.error ? ` — ${bridge.error}` : ''};
        feed this card with beatsync --artnet-mirror 127.0.0.1:${bridge.mirrorPort}
      </div>` : nothing;
    if (!info) {
      return html`${partial}<div class="status dead">
        universe ${addr.universe} — nothing heard yet
      </div>`;
    }
    // Age from when WE received it: the server's own ageMs is a snapshot that
    // goes stale the moment it's sent.
    const age = Date.now() - info.receivedAt + info.ageMs;
    const live = age < 2000;
    return html`${partial}<div class="status ${live ? 'live' : 'dead'}">
      ${live ? 'live' : 'stale'} · ${info.src || 'unknown source'} ·
      ${(age / 1000).toFixed(1)}s ago · ${info.packets} pkt${info.drops ? ` · ${info.drops} dropped` : ''}
    </div>`;
  }

  render() {
    const b = this.binding;
    if (!b) return html``;
    const test = artnetClient.testState;
    return html`
      <field-tab-bar
        .fieldPath=${'channel_count'}
        .label=${'Channels'}
        .options=${COUNT_OPTIONS}
        .defaultValue=${4}
        ?shapeField=${true}
        ?wrap=${true}
        .binding=${b}
      ></field-tab-bar>

      ${!artnetClient.isAvailable ? nothing : html`
        <div class="section">
          ${this.renderStatus()}
          <div class="label">Test pattern</div>
          <div class="row">
            ${TEST_PATTERNS.map(p => html`
              <ui-button
                ?active=${test.pattern === p}
                @click=${() => { artnetClient.setTestPattern(p); this.requestUpdate(); }}
              >${PATTERN_LABELS[p]}</ui-button>
            `)}
          </div>
          <div class="row">
            ${(['mirror', 'broadcast'] as TestDest[]).map(d => html`
              <ui-button
                ?active=${test.dest === d}
                @click=${() => { artnetClient.setTestDest(d); this.requestUpdate(); }}
                title=${d === 'mirror'
                  ? 'Send on the mirror port — only nano hears it, Resolume does not react'
                  : 'Broadcast on 6454 to the whole LAN — Resolume receives this too and may fire clips'}
              >${d === 'mirror' ? 'Mirror' : 'Broadcast'}</ui-button>
            `)}
            <ui-button ?active=${this.isMine} @click=${() => this.toggleTest()}>
              ${this.isMine ? 'Stop' : 'Send'}
            </ui-button>
          </div>
          ${test.running && !this.isMine ? html`
            <div class="status warn">
              running on another Art-Net card (universe ${test.address?.universe ?? '?'}) —
              Send moves it here
            </div>` : nothing}
          ${test.dest === 'broadcast' ? html`
            <div class="status warn">
              broadcasts to the LAN on 6454 — Resolume receives this and may fire clips
            </div>` : nothing}
        </div>
      `}
    `;
  }
}

const optionsFactory = {
  create(_pluginKey: string, binding: FieldBinding): HTMLElement {
    const el = document.createElement('artnet-options') as ArtnetOptions;
    el.binding = binding;
    return el;
  },
  destroy(_element: HTMLElement) {},
};

// `options`, not `inspector`: the card body keeps rendering the effect's own
// fields, so every ch_N output stays a real wire target.
editorRegistry.register(ARTNET_MODULE_TYPE, { options: optionsFactory });
