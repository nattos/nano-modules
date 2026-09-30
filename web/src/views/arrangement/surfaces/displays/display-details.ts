/**
 * <display-details> — the floating details panel for the display card
 * selected in the Devices view (the lights' and MIDI panels' twin, same
 * place, same selection):
 *
 *   - ON THIS MACHINE (the library): where it goes — fullscreen on a screen
 *     (automatic, or one picked from the screens the compositor sees; a
 *     remembered one that isn't connected stays listed), a rehearsal window,
 *     or shared (Syphon / Spout) — identify, rename.
 *   - IN THIS SHOW (when placed): the output switch, how the frame fits
 *     (Fit / Fill / Stretch; not for a shared one, whose frame is the show's) and
 *     what it shows (the main output, or a route).
 *
 * Library edits go through displayController (persisted, per machine); show
 * edits through the store (undoable).
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../../../mobx-lit-element';
import {
  BUILTIN_DISPLAY_COUNT, DISPLAY_FITS, displayMode, displayModeShares, displayModesFor, displayOrdinal, type DisplaySlot,
} from '../../../../displays/display-types';
import { devicesUi } from '../../../devices/devices-ui';
import { devicesHost } from '../../../devices/devices-host';
import { engineBridge } from '../../engine/engine-bridge';
import { displayController } from '../../state/display-controller';
import { store } from '../../state/store';
import { routeEndLabel } from '../arr-io';
import { displayWhere, screenLabel } from './display-where';

import '../device-input-pip';
import './display-surface';

@customElement('display-details')
export class DisplayDetails extends MobxLitElement {
  static styles = css`
    :host {
      position: fixed; right: 12px; bottom: 12px; z-index: 30;
      width: 340px; max-height: 70vh; overflow-y: auto;
      background: var(--app-bg-color2); border: 1px solid var(--app-tint-4); border-radius: 2px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace; font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
    }
    :host([data-empty]) { display: none; }
    .head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--app-tint-2); }
    .head .kind { color: var(--app-text-color2); font-size: var(--app-fs-xs); text-transform: uppercase; letter-spacing: 0.08em; }
    .sec { padding: 8px 10px; border-bottom: 1px solid var(--app-tint-2); display: flex; flex-direction: column; gap: 6px; }
    .sec:last-child { border-bottom: none; }
    .sec h4 { margin: 0; font-weight: normal; font-size: var(--app-fs-xs); letter-spacing: 0.1em; text-transform: uppercase; color: var(--app-text-color2); }
    .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .row label { flex: 0 0 72px; color: var(--app-text-color2); }
    .row select { flex: 1; min-width: 0; }
    .note { color: var(--app-text-color2); font-size: var(--app-fs-xs); line-height: 1.4; }
    input, select {
      font: inherit; color: var(--app-text-color1); background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-3); border-radius: 1px; padding: 1px 4px; min-width: 0;
    }
    input:focus, select:focus { outline: none; border-color: var(--app-hi-color2); }
    input.name { flex: 1; }
    button {
      font: inherit; font-size: var(--app-fs-xs); color: var(--app-text-color2); background: none;
      border: 1px solid var(--app-tint-4); border-radius: 1px; padding: 1px 6px; cursor: pointer;
    }
    button:hover:not(:disabled) { border-color: var(--app-hi-color2); color: var(--app-hi-color2); }
    button:disabled { opacity: 0.4; cursor: default; }
    button.on { border-color: var(--app-hi-color2); color: var(--app-hi-color2); background: rgba(65, 105, 225, 0.12); }
    button.primary { color: var(--app-text-color1); border-color: var(--app-hi-color2); }
    .btns { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
    .spacer { flex: 1; }
  `;

  render() {
    const id = devicesUi.selectedCardId;
    const slot = id && displayOrdinal(id) ? displayController.slot(id) : undefined;
    this.toggleAttribute('data-empty', !slot);
    if (!slot) return nothing;
    const { right, bottom } = devicesHost().detailsInset();
    this.style.right = `${right}px`;
    this.style.bottom = `${bottom}px`;
    this.style.maxHeight = `calc(100vh - ${bottom + 60}px)`;
    const placement = store.placementForDevice(slot.id);
    return html`
      <div class="head">
        <input class="name" .value=${slot.name} data-display-field="name" @change=${(e: Event) =>
          displayController.rename(slot.id, (e.target as HTMLInputElement).value)}>
        <span class="kind">display</span>
      </div>
      ${this.renderMachine(slot)}
      ${placement && placement.kind === 'display' ? this.renderShow(slot, placement.id, placement.enabled !== false)
        : html`<div class="sec"><div class="btns">
            <button class="primary" data-display-action="include"
              @click=${() => store.includeDevice(slot.id, { kind: 'display', label: slot.name })}>add to show</button>
            <span class="note">It shows the main output, fitted to its screen.</span>
          </div></div>`}
      ${displayOrdinal(slot.id) > BUILTIN_DISPLAY_COUNT ? html`<div class="sec"><div class="btns">
        <span class="spacer"></span>
        <button data-display-action="delete" @click=${() => {
          displayController.setDeleted(slot.id, !slot.deleted);
          if (!slot.deleted) devicesUi.selectCard(null);
        }}>${slot.deleted ? 'restore' : 'delete display'}</button>
      </div></div>` : nothing}`;
  }

  /** The library's side: where this slot lands on THIS machine. */
  private renderMachine(slot: DisplaySlot) {
    const screens = displayController.screens;
    const outputs = engineBridge.outputsDisplays;
    const mode = displayMode(slot);
    const auto = screens ? displayController.screenFor({ ...slot, screen: undefined, mode: undefined }) : null;
    const remembered = slot.screen && !screens?.some((s) => s.uuid === slot.screen!.uuid) ? slot.screen : null;
    const n = displayOrdinal(slot.id);
    const where = mode !== 'fullscreen' ? null : screens ? displayController.screenFor(slot) : null;
    return html`
      <div class="sec">
        <h4>On this machine</h4>
        <div class="row"><label>screen</label>
          <select data-display-field="screen" ?disabled=${mode !== 'fullscreen' || !screens} @change=${(e: Event) => {
            const uuid = (e.target as HTMLSelectElement).value;
            const s = screens?.find((x) => x.uuid === uuid) ?? (remembered?.uuid === uuid ? remembered : null);
            displayController.bindScreen(slot.id, s ? { uuid: s.uuid, name: s.name } : null);
          }}>
            <option value="" ?selected=${!slot.screen}>automatic — ${auto ? auto.name
              : `external screen ${n}`}</option>
            ${(screens ?? []).map((s) => html`<option value=${s.uuid} ?selected=${slot.screen?.uuid === s.uuid}>
              ${screenLabel(s)}${s.main ? ' (main)' : ''}</option>`)}
            ${remembered ? html`<option value=${remembered.uuid} selected>${remembered.name} — not connected</option>` : nothing}
          </select></div>
        <div class="row"><label>as</label>
          <div class="btns">${displayModesFor(displayController.share).map((m) => html`<button class=${mode === m.id ? 'on' : ''}
            data-display-mode=${m.id} title=${m.title}
            @click=${() => displayController.setMode(slot.id, m.id)}>${m.label}</button>`)}</div></div>
        <div class="btns">
          <button data-display-action="identify" ?disabled=${!outputs || displayModeShares(mode)}
            title="Show this display's name on its screen for a moment"
            @click=${() => displayController.identify(slot.id)}>identify</button>
        </div>
        <div class="note">${!outputs
          ? 'Displays need the native compositor (the desktop app); this engine renders the show but opens no screens.'
          : mode === 'window' ? 'Opens as a normal window (close it to turn the display off).'
          : mode === 'syphon' ? html`A Syphon server named <b>${slot.name}</b> (app “Nano Modules”), at the
              show’s full resolution — Resolume, MadMapper, OBS… list it. No screen.`
          : mode === 'spout' ? html`A Spout sender named <b>Nano Modules - ${slot.name}</b>, at the show’s
              full resolution — Resolume, TouchDesigner, OBS… list it. No screen.`
          : where ? html`Fullscreen on <b>${where.name}</b>.`
          : 'No screen for it — plug one in, pick one, or rehearse in a window.'}
          ${mode === 'fullscreen' && !slot.screen ? ` Automatic never picks the main screen (${
            displayController.share === 'spout' ? 'the primary one' : 'the menu bar’s'}).` : ''}</div>
      </div>`;
  }

  /** The show's side: on/off, fit, what it shows. */
  private renderShow(slot: DisplaySlot, pid: string, enabled: boolean) {
    const p = store.placementById(pid)!;
    const route = store.deviceInputRoute(pid);
    const where = displayWhere(slot, pid);
    const fit = p.fit ?? 'fit';
    return html`
      <div class="sec">
        <h4>In this show</h4>
        <display-surface .slotId=${slot.id} .placementId=${pid}></display-surface>
        <div class="row"><label>output</label>
          <button class=${enabled ? 'on' : ''} data-display-action="enable"
            @click=${() => store.setDisplayEnabled(pid, !enabled)}>${enabled ? 'on' : 'off'}</button>
          <span class="note">${where.text}</span></div>
        ${displayModeShares(displayMode(slot)) ? nothing : html`<div class="row"><label>fit</label>
          <div class="btns">${DISPLAY_FITS.map((f) => html`<button class=${fit === f.id ? 'on' : ''}
            data-display-fit=${f.id} title=${f.title}
            @click=${() => store.setDisplayFit(pid, f.id)}>${f.label}</button>`)}</div></div>`}
        <div class="row"><label>shows</label>
          <device-input-pip .placementId=${pid} .scope=${'devices'}></device-input-pip>
          ${route ? html`<button title="Show the main output again"
            @click=${() => store.removeRoute(route.id)}>main</button>` : nothing}</div>
        ${route ? html`<div class="note">Routed from ${routeEndLabel(route.src)}.</div>` : nothing}
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'display-details': DisplayDetails }
}
