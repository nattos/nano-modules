/**
 * <devices-tab> — the MIDI device library/manager. Occupies the app-shell's
 * monitor AREA (the sketch editor stays in the left panel; the main output
 * pops out to <devices-float-monitor>).
 *
 * Groups, gated by the persisted `deviceFilters` toggles in the header:
 *   CONNECTED    — instances with a live port pair, plus ghost placeholders
 *                  for plugged-in-but-unknown ports (not forkable).
 *   DISCONNECTED — user forks with no matching port.
 *   TEMPLATES    — code-registered factory originals.
 *   DELETED      — soft-deleted forks (restorable; off by default).
 *
 * DEFINE MODE (entered via the unknown-device snackbar): everything that
 * can't be forked dims out; clicking a template/fork forks it and claims the
 * unknown port for the new instance. Esc / the banner button cancels.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { midiController } from '../../state/midi-controller';
import { allDeviceTemplates } from '../../midi/device-registry';
import type { DeviceInstance, DeviceTemplate, PhysicalIdentity } from '../../midi/midi-types';
import { devicesUi } from './devices-ui';
import { ghostScan } from './ghost-scan';
import type { GhostDevice } from './device-wires-model';

import './device-card';
import './device-surface';
import './device-control-details';

const FILTER_LABELS = {
  connected: 'connected',
  disconnected: 'disconnected',
  unrecognized: 'unrecognized',
  templates: 'templates',
  deleted: 'deleted',
} as const;
type FilterKey = keyof typeof FILTER_LABELS;

@customElement('devices-tab')
export class DevicesTab extends MobxLitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      color: var(--app-text-color1);
    }
    .header {
      display: flex;
      align-items: center;
      gap: var(--app-sp-4);
      padding: 8px 16px;
      border-bottom: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
    }
    .title {
      font-size: var(--app-fs-lg);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--app-text-color2);
    }
    .spacer { flex: 1; }
    .chip {
      font: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      background: none;
      border: 1px solid var(--app-tint-3);
      border-radius: 1px;
      padding: 2px 8px;
      cursor: pointer;
    }
    .chip:hover { border-color: var(--app-tint-5); }
    .chip[data-on] {
      color: var(--app-text-color1);
      border-color: var(--app-hi-color2);
      background: rgba(65, 105, 225, 0.12);
    }
    .define-bar {
      display: flex;
      align-items: center;
      gap: var(--app-sp-4);
      padding: 6px 16px;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
      background: rgba(65, 105, 225, 0.14);
      border-bottom: 1px solid var(--app-hi-color2);
    }
    .define-bar .cancel {
      font: inherit;
      color: var(--app-text-color2);
      background: none;
      border: 1px solid var(--app-tint-4);
      border-radius: 1px;
      padding: 1px 8px;
      cursor: pointer;
    }
    .define-bar .cancel:hover { border-color: var(--app-tint-5); color: var(--app-text-color1); }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-6);
    }
    .group-label {
      font-size: var(--app-fs-xs);
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--app-text-color2);
      margin-bottom: 6px;
    }
    .cards {
      display: flex;
      flex-wrap: wrap;
      gap: var(--app-sp-4);
      align-items: flex-start;
    }
    .group-label .chip {
      margin-left: 8px;
      text-transform: none;
      letter-spacing: 0;
    }
    .missing-body {
      padding: 10px 6px;
      font-size: var(--app-fs-xs);
      color: var(--app-text-color2);
    }
    .empty-note {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      border: 1px dashed var(--app-tint-3);
      border-radius: 1px;
      padding: 10px 12px;
    }
    .enable {
      font: inherit;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
      background: none;
      border: 1px dashed var(--app-tint-4);
      border-radius: 1px;
      padding: 2px 10px;
      cursor: pointer;
    }
    .enable:hover { border-color: var(--app-hi-color2); color: var(--app-hi-color2); }
    /* Slotted into the ghost card's body (light DOM — styled from here). */
    .ghost-define { display: block; margin: 6px auto; padding: 2px 16px; }
  `;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && devicesUi.defineMode) {
      e.preventDefault();
      devicesUi.exitDefineMode();
    }
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKeyDown);
    // First visit is the permission-prompt moment when the library is empty
    // (boot already initialized when devices exist).
    void midiController.initMidi();
    // Composition-wide ghost scan: in Live mode this prefetches every live
    // instance's sketch so missing-device counts cover ALL 14 instances, not
    // just the one loaded in the editor. No-op in playground (no bridge).
    void ghostScan.refresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKeyDown);
  }

  private toggleFilter(key: FilterKey) {
    const current = appState.local.userSettings.deviceFilters;
    appController.setUserSetting('deviceFilters', { ...current, [key]: !current[key] });
  }

  private onCardClick(id: string, forkable: boolean) {
    const define = devicesUi.defineMode;
    if (define) {
      if (!forkable) return;
      // Templates fork; an existing instance claims the port DIRECTLY (its
      // wires must keep pointing at the instance the hardware now feeds).
      const claimed = midiController.claimPort(id, define);
      devicesUi.exitDefineMode();
      devicesUi.selectCard(claimed.id);
      return;
    }
    devicesUi.selectCard(devicesUi.selectedCardId === id ? null : id);
  }

  /** Re-enter define mode for an already-claimed device (its port never
   *  shows as unknown, so this is the only path to move it to another
   *  instance — e.g. the fork that actually holds the wires). */
  private onReassign(instanceId: string) {
    const port = midiController.manager.connectedPortIdentity(instanceId);
    if (!port) return;
    devicesUi.enterDefineMode(port);
  }

  private renderInstanceCard(instance: DeviceInstance, status: 'connected' | 'disconnected' | 'deleted') {
    const define = devicesUi.defineMode !== null;
    const forkable = define && !instance.deleted;
    return html`
      <device-card
        .name=${instance.name}
        .subtitle=${''}
        .status=${status}
        .actionLabel=${status === 'connected' && !define ? 'reassign' : ''}
        ?selected=${devicesUi.selectedCardId === instance.id}
        ?forkable=${forkable}
        ?dimmed=${define && !forkable}
        @click=${() => this.onCardClick(instance.id, forkable)}
        @card-action=${() => this.onReassign(instance.id)}
      >
        <device-surface
          .deviceId=${instance.id}
          .interactive=${status !== 'deleted' && !define}
        ></device-surface>
      </device-card>
    `;
  }

  private renderTemplateCard(template: DeviceTemplate) {
    const define = devicesUi.defineMode !== null;
    return html`
      <device-card
        .name=${template.name}
        .subtitle=${template.vendor}
        .status=${'template'}
        ?selected=${devicesUi.selectedCardId === template.templateId}
        ?forkable=${define}
        @click=${() => this.onCardClick(template.templateId, define)}
      >
        <device-surface
          .deviceId=${template.templateId}
          .interactive=${!define}
        ></device-surface>
      </device-card>
    `;
  }

  /**
   * A device the composition's wires reference but the library doesn't know:
   * a re-created profile, or a composition from someone else. Selecting it
   * opens the details panel with the adopt/alias repair actions — the wires
   * themselves are never rewritten.
   */
  private renderMissingCard(ghost: GhostDevice) {
    const subtitle = [
      `${ghost.deviceId.slice(0, 8)}…`,
      `${ghost.wireCount} wire${ghost.wireCount === 1 ? '' : 's'}`,
      `${ghost.controls.length} control${ghost.controls.length === 1 ? '' : 's'}`,
      `${ghost.sketchCount} sketch${ghost.sketchCount === 1 ? '' : 'es'}`,
    ].join(' · ');
    return html`
      <device-card
        .name=${'Unknown device'}
        .subtitle=${subtitle}
        .status=${'missing'}
        ?selected=${devicesUi.selectedCardId === ghost.deviceId}
        ?dimmed=${devicesUi.defineMode !== null}
        @click=${() => devicesUi.selectCard(ghost.deviceId)}
      >
        <div class="missing-body">
          mapped in ${ghost.sketchCount} sketch${ghost.sketchCount === 1 ? '' : 'es'} —
          select to adopt
        </div>
      </device-card>
    `;
  }

  private renderGhostCard(port: PhysicalIdentity) {
    // Plugged in but unknown — a placeholder, never forkable (you fork a
    // template/instance FOR it in define mode). Its define button is the
    // persistent entry into define mode (the snackbar offer only shows once).
    return html`
      <device-card
        .name=${port.name || 'Unknown device'}
        .subtitle=${port.manufacturer}
        .status=${'ghost'}
        ?dimmed=${devicesUi.defineMode !== null}
      >
        <button class="enable ghost-define"
          @click=${(e: Event) => { e.stopPropagation(); devicesUi.enterDefineMode(port); }}
        >define</button>
      </device-card>
    `;
  }

  render() {
    const midi = appState.local.midi;
    const filters = appState.local.userSettings.deviceFilters;
    const define = devicesUi.defineMode;
    const ghosts = ghostScan.ghosts();

    const live = midi.library.filter(i => !i.deleted);
    const connected = live.filter(i => midi.connected[i.id]);
    const disconnected = live.filter(i => !midi.connected[i.id]);
    const deleted = midi.library.filter(i => i.deleted);
    const templates = allDeviceTemplates();

    const groups = [
      filters.connected ? html`
        <div>
          <div class="group-label">Connected</div>
          <div class="cards">
            ${connected.map(i => this.renderInstanceCard(i, 'connected'))}
            ${filters.unrecognized ? midi.unknownPorts.map(p => this.renderGhostCard(p)) : nothing}
            ${connected.length === 0 && midi.unknownPorts.length === 0
              ? html`<div class="empty-note">No devices detected.
                  ${midiController.manager.initialized ? nothing : html`
                    <button class="enable" @click=${() => midiController.initMidi()}>enable MIDI access</button>`}
                </div>`
              : nothing}
          </div>
        </div>` : nothing,
      filters.disconnected && disconnected.length > 0 ? html`
        <div>
          <div class="group-label">Your devices — disconnected</div>
          <div class="cards">${disconnected.map(i => this.renderInstanceCard(i, 'disconnected'))}</div>
        </div>` : nothing,
      filters.templates ? html`
        <div>
          <div class="group-label">Templates</div>
          <div class="cards">${templates.map(t => this.renderTemplateCard(t))}</div>
        </div>` : nothing,
      filters.deleted && deleted.length > 0 ? html`
        <div>
          <div class="group-label">Deleted</div>
          <div class="cards">${deleted.map(i => this.renderInstanceCard(i, 'deleted'))}</div>
        </div>` : nothing,
      ghosts.length > 0 ? html`
        <div>
          <div class="group-label">Missing devices — wired in the composition
            <button class="chip" ?disabled=${ghostScan.scanning}
              title="Re-scan every live instance's sketch for wires to unknown devices"
              @click=${() => ghostScan.refresh()}>
              ${ghostScan.scanning ? 'scanning…' : 'rescan'}
            </button>
          </div>
          <div class="cards">${ghosts.map(g => this.renderMissingCard(g))}</div>
        </div>` : nothing,
    ];

    return html`
      <div class="header">
        <div class="title">Devices</div>
        <div class="spacer"></div>
        ${(Object.keys(FILTER_LABELS) as FilterKey[]).map(key => html`
          <button class="chip" ?data-on=${filters[key]} @click=${() => this.toggleFilter(key)}>
            ${FILTER_LABELS[key]}
          </button>
        `)}
      </div>
      ${define ? html`
        <div class="define-bar">
          <span>Defining «${define.name || 'unknown device'}» — pick a device or template to fork</span>
          <div class="spacer"></div>
          <button class="cancel" @click=${() => devicesUi.exitDefineMode()}>cancel (Esc)</button>
        </div>` : nothing}
      <div class="scroll" @click=${(e: Event) => {
        if (e.target === e.currentTarget) devicesUi.clearSelection();
      }}>
        ${groups}
      </div>
      <device-control-details></device-control-details>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'devices-tab': DevicesTab;
  }
}
