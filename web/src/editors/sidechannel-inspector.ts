/**
 * Custom inspector for util.sidechannel_out / util.sidechannel_in — the
 * cross-instance texture channel effects.
 *
 * The generic inspector would render the raw schema fine (a channel select +
 * a text field); what it can't do is tell you WHAT'S ON each channel. This
 * one decorates the numeric channel options with the display name of the
 * last instance that wrote to them ("3 — Instance 2"), live from
 * `appState.local.engine.sidechannels` (worker push in the playground,
 * /global/sidechannels in barrel mode). It also handles the Custom-name
 * conditional client-side, so barrel mode doesn't depend on the remote
 * schema's visibility refresh.
 *
 * A custom inspector REPLACES the generic card body — including the texture
 * port placeholder rows the generic path renders — so the send's texture
 * inputs must be re-rendered here or wires have nothing to attach to (no
 * click-to-connect target, no tap anchor). The send shows `tex_in` (the chain
 * passthrough) and `send_in` (the wireable publish override); the receive
 * shows neither (REPLACE semantics — its chain input is discarded, so a port
 * would invite wires that do nothing).
 */

import { html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import { editorRegistry } from '../editor-registry';
import { appState } from '../state/app-state';
import type { FieldBinding } from '../widgets/field-editor';
import type { FieldSelectOption } from '../widgets/field-select';
import '../widgets/field-select';
import '../widgets/field-text';
import '../widgets/field-placeholder';
import '../widgets/help-slot';

/**
 * Human label for a sidechannel writer tag: a `pg:` sketch id (playground) or
 * a plugin key (barrel) — both resolve through the shared instances list;
 * unknown tags fall back to the barrel label convention (first UUID segment).
 */
export function sidechannelWriterLabel(writerTag: string): string {
  if (!writerTag) return '';
  const inst = appState.local.barrelInstances.find(i => i.key === writerTag);
  if (inst) return inst.label;
  return writerTag.split('-')[0] || writerTag;
}

@customElement('sidechannel-inspector')
export class SidechannelInspector extends MobxLitElement {
  @property({ attribute: false }) binding: FieldBinding | null = null;

  /** True for util.sidechannel_out: render the texture input ports (chain
   *  passthrough + the wireable send override). Set by the factory. */
  @property({ type: Boolean }) sendPorts = false;

  static styles = css`
    :host { display: flex; flex-direction: column; gap: var(--app-sp-2); }
    .hint {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      padding: 2px 0 0 0;
    }
  `;

  private channelOptions(): FieldSelectOption[] {
    const channels = appState.local.engine.sidechannels;
    const opts: FieldSelectOption[] = [];
    for (let n = 1; n <= 8; n++) {
      const writer = channels[String(n)]?.writer;
      const label = writer ? `${n} — ${sidechannelWriterLabel(writer)}` : String(n);
      opts.push({ label, value: n });
    }
    opts.push({ label: 'Custom', value: 0 });
    return opts;
  }

  render() {
    const b = this.binding;
    if (!b) return html``;
    const raw = b.getValue('channel');
    const channel = typeof raw === 'number' ? Math.round(raw) : 1;
    const custom = channel === 0;
    // Live "what's on this channel" readout for the effective channel name.
    const name = custom ? String(b.getValue('channel_name') ?? '').trim() : String(channel);
    const info = name ? appState.local.engine.sidechannels[name] : undefined;
    return html`
      <help-slot .binding=${b} .path=${'intro'}></help-slot>
      ${this.sendPorts ? html`
        <field-placeholder .fieldPath=${'tex_in'} label="tex_in"
          kind="texture" direction="input" .binding=${b}></field-placeholder>
        <field-placeholder .fieldPath=${'send_in'} label="Send Override"
          kind="texture" direction="input" .binding=${b}></field-placeholder>
      ` : ''}
      <field-select .fieldPath=${'channel'} .label=${'Channel'}
        .options=${this.channelOptions()} .defaultValue=${1} .binding=${b}></field-select>
      ${custom ? html`
        <field-text .fieldPath=${'channel_name'} .label=${'Custom Name'}
          .placeholder=${'channel name'} .binding=${b}></field-text>
      ` : ''}
      ${info
        ? html`<div class="hint">carrying ${sidechannelWriterLabel(info.writer)} · ${info.w}×${info.h}</div>`
        : name
          ? html`<div class="hint">channel "${name}" — nothing sent yet</div>`
          : ''}
    `;
  }
}

const makeInspector = (sendPorts: boolean) => ({
  create(_pluginKey: string, binding: FieldBinding): HTMLElement {
    const el = document.createElement('sidechannel-inspector') as SidechannelInspector;
    el.binding = binding;
    el.sendPorts = sendPorts;
    return el;
  },
  destroy(_element: HTMLElement) {},
});
editorRegistry.register('util.sidechannel_out', { inspector: makeInspector(true) });
editorRegistry.register('util.sidechannel_in', { inspector: makeInspector(false) });
