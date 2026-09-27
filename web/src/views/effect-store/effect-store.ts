/**
 * <effect-store> — the Effects tab: every effect as a browsable card grid.
 *
 * Takes over both panels (a `full-takeover` tab). The top bar holds the query
 * (the type picker's search rules — state/effect-search.ts) and an expandable
 * "Settings & filters" area of segmented buttons: the collection (group by
 * category, bundle, release or reaction), which kinds show, card size, and
 * whether debug effects show. All of it is sticky (UserSettings.effectStore).
 *
 * The catalog comes from the store's own preview engine (preview/), which
 * loads the same bundles the surface does and renders every thumbnail. In
 * Remote Control it is narrowed to what the Resolume plugin actually has.
 *
 * Arriving from the type editor's Browse… shows a breadcrumb back to the card
 * (or insert position) being chosen for; see state/effect-store-controller.ts
 * for what Use and Preview do with or without one.
 */

import { html, css, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { effectStore } from '../../state/effect-store-controller';
import type { AvailableEffect, EffectStoreSettings } from '../../state/types';
import type { PreviewEngine } from '../../preview/preview-engine';
import type { Thumbnails } from '../../preview/thumbnails';
import { sketchChain } from '../../sketch-types';
import { groupEffects } from './store-model';
import './effect-store-card';
import '../../widgets/ui-icon';

interface SegOption<V> { value: V; label: string }

const COLLECTIONS: SegOption<EffectStoreSettings['collection']>[] = [
  { value: 'category', label: 'By Category' },
  { value: 'bundle', label: 'By Bundle' },
  { value: 'updated', label: 'Updated & New' },
  { value: 'favs', label: 'Favs' },
];
const SHOWS: SegOption<EffectStoreSettings['show']>[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Image' },
  { value: 'generator', label: 'Generators' },
  { value: 'modulation', label: 'Modulation' },
];
const SIZES: SegOption<EffectStoreSettings['size']>[] = [
  { value: 's', label: 'S' },
  { value: 'm', label: 'M' },
  { value: 'l', label: 'L' },
];
const DEBUG: SegOption<boolean>[] = [
  { value: false, label: 'Hide' },
  { value: true, label: 'Show' },
];
const CARD_MIN: Record<EffectStoreSettings['size'], number> = { s: 150, m: 210, l: 300 };

@customElement('effect-store')
export class EffectStore extends MobxLitElement {
  private engine: PreviewEngine | null = null;
  private thumbs: Thumbnails | null = null;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--app-bg-color1);
      color: var(--app-text-color1);
      font-size: var(--app-fs-md, 13px);
    }
    .crumb {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 14px;
      background: rgba(65, 105, 225, 0.14);
      border-bottom: 1px solid rgba(65, 105, 225, 0.35);
      font-size: var(--app-fs-sm);
    }
    .crumb button, .toolbar button {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid var(--app-tint-4);
      background: var(--app-bg-color2, #1b1d22);
      color: var(--app-text-color1);
      font: inherit;
      font-size: var(--app-fs-sm);
      cursor: pointer;
    }
    .crumb button:hover, .toolbar button:hover { background: var(--app-tint-3); }
    .crumb .where { color: var(--app-text-color2); }
    .crumb .where b { color: var(--app-text-color1); font-weight: 600; }
    .crumb .spacer { flex: 1; }
    .crumb .previewing { color: var(--app-hi-color2, #4169e1); }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px 8px;
    }
    .query {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--app-tint-4);
      border-radius: 6px;
      background: var(--app-bg-color2, #1b1d22);
    }
    .query:focus-within { border-color: var(--app-hi-color2, #4169e1); }
    .query input {
      flex: 1;
      min-width: 0;
      background: transparent;
      border: none;
      outline: none;
      color: inherit;
      font: inherit;
    }
    .count { color: var(--app-text-color3, #777); font-size: var(--app-fs-sm); white-space: nowrap; }
    .toolbar button[open] { background: var(--app-tint-3); }
    .filters {
      display: grid;
      grid-template-columns: max-content minmax(0, 520px);
      align-items: center;
      gap: 8px 14px;
      padding: 4px 14px 12px;
      border-bottom: 1px solid var(--app-tint-3);
      font-size: var(--app-fs-sm);
    }
    .filters .label { color: var(--app-text-color2); }
    .seg {
      display: flex;
      border: 1px solid var(--app-tint-4);
      border-radius: 4px;
      overflow: hidden;
      background: var(--app-bg-color1);
    }
    .seg button {
      flex: 1 1 0;
      min-width: 0;
      background: transparent;
      border: none;
      border-left: 1px solid var(--app-tint-4);
      color: var(--app-text-color2, #b0b0b0);
      font: inherit;
      padding: 4px 10px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .seg button:first-child { border-left: none; }
    .seg button:hover { background: var(--app-tint-2); color: var(--app-text-color1); }
    .seg button[active] {
      color: var(--app-hi-color2, #4169e1);
      background: var(--app-tint-3);
      box-shadow: inset 0 -2px 0 var(--app-hi-color2, #4169e1);
    }
    .collections { padding: 0 14px 10px; }
    .collections .seg { max-width: 560px; }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px 14px 24px;
    }
    section { margin-bottom: 18px; }
    h3 {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin: 10px 0 8px;
      font-size: var(--app-fs-md, 13px);
      font-weight: 600;
    }
    h3 .n { color: var(--app-text-color3, #777); font-weight: 400; font-size: var(--app-fs-sm); }
    .grid {
      display: grid;
      gap: 12px;
    }
    .empty {
      padding: 40px 12px;
      text-align: center;
      color: var(--app-text-color2);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    const { engine, thumbs } = effectStore.open();
    this.engine = engine;
    this.thumbs = thumbs;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    effectStore.close();
    this.engine = null;
    this.thumbs = null;
  }

  private get settings(): EffectStoreSettings {
    return appState.local.userSettings.effectStore;
  }

  private set(patch: Partial<EffectStoreSettings>) {
    appController.setUserSetting('effectStore', { ...this.settings, ...patch });
  }

  /** The catalog, narrowed in Remote Control to what the plugin has. */
  private catalog(): AvailableEffect[] {
    const engine = this.engine;
    if (!engine) return [];
    const all = [...engine.catalog.values()] as AvailableEffect[];
    if (!appState.local.barrelMode) return all;
    const live = new Set(appState.local.availableEffects.map((e) => e.id));
    return live.size ? all.filter((e) => live.has(e.id)) : all;
  }

  private seg<V>(options: SegOption<V>[], value: V, pick: (v: V) => void) {
    return html`<div class="seg">
      ${options.map((o) => html`<button ?active=${o.value === value} @click=${() => pick(o.value)}>${o.label}</button>`)}
    </div>`;
  }

  private renderCrumb() {
    const t = effectStore.target.get();
    if (!t) return nothing;
    const sk = appState.database.sketches[t.sketchId];
    let where: unknown;
    if (t.kind === 'retype') {
      const chain = sk ? sketchChain(sk) : [];
      const idx = chain.findIndex((e) => e.instance_key === t.instanceKey);
      const type = t.originalType ?? chain[idx]?.module_type;
      const name = type ? (appState.local.availableEffects.find((e) => e.id === type)?.name ?? type) : t.instanceKey;
      where = html`Choosing a new type for <b>${name}</b> (card ${idx + 1})`;
    } else {
      where = html`Choosing an effect to insert at position <b>${t.index + 1}</b>`;
    }
    const preview = effectStore.preview.get();
    const previewName = preview ? (this.engine?.catalog.get(preview.effectId)?.name ?? preview.effectId) : null;
    return html`
      <div class="crumb">
        <button @click=${() => effectStore.back()} title="Back without changing anything">
          <ui-icon icon="la-arrow-left"></ui-icon> Back
        </button>
        <span class="where">${where}</span>
        <span class="spacer"></span>
        ${previewName ? html`
          <span class="previewing">Previewing ${previewName}</span>
          <button @click=${() => effectStore.cancelPreview()}>Revert</button>
          <button @click=${() => effectStore.use(preview!.effectId)}>Keep</button>` : nothing}
      </div>`;
  }

  render() {
    const s = this.settings;
    const engine = this.engine;
    const us = appState.local.userSettings;
    const loaded = engine?.loaded.get() ?? false;
    engine?.schemaGeneration.get(); // re-group once kinds are known
    const groups = groupEffects(
      this.catalog(), s, (id) => engine?.kindOf(id) ?? 'image', us.effectReactions, us.recentEmoji);
    const total = groups.reduce((n, g) => n + g.effects.length, 0);
    const preview = effectStore.preview.get();
    return html`
      ${this.renderCrumb()}
      <div class="toolbar">
        <label class="query">
          <ui-icon icon="la-search"></ui-icon>
          <input
            placeholder="Search effects — or browse a path: color.  com.nano.core."
            .value=${s.query}
            @input=${(e: Event) => this.set({ query: (e.target as HTMLInputElement).value })}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Escape' && s.query) { e.stopPropagation(); this.set({ query: '' }); } }}
          />
        </label>
        <span class="count">${loaded ? `${total} effect${total === 1 ? '' : 's'}` : 'Loading effects…'}</span>
        <button ?open=${s.filtersOpen} @click=${() => this.set({ filtersOpen: !s.filtersOpen })}>
          <ui-icon icon="la-sliders-h"></ui-icon> Settings &amp; filters
          <ui-icon icon=${s.filtersOpen ? 'la-angle-up' : 'la-angle-down'}></ui-icon>
        </button>
        ${!effectStore.target.get() && preview ? html`
          <button @click=${() => effectStore.cancelPreview()} title="Remove the previewed effect">Revert preview</button>` : nothing}
      </div>
      <div class="collections">${this.seg(COLLECTIONS, s.collection, (v) => this.set({ collection: v }))}</div>
      ${s.filtersOpen ? html`
        <div class="filters">
          <span class="label">Show</span>${this.seg(SHOWS, s.show, (v) => this.set({ show: v }))}
          <span class="label">Card size</span>${this.seg(SIZES, s.size, (v) => this.set({ size: v }))}
          <span class="label">Debug effects</span>${this.seg(DEBUG, s.showDebug, (v) => this.set({ showDebug: v }))}
        </div>` : nothing}
      <div class="scroll">
        ${groups.length === 0 ? html`<div class="empty">${!loaded ? 'Loading effects…'
          : s.collection === 'favs' && !s.query ? 'React to an effect with an emoji to collect it here.'
          : 'No effects match.'}</div>` : nothing}
        ${groups.map((g) => html`
          <section>
            <h3>${g.label} <span class="n">${g.effects.length}</span></h3>
            <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(${CARD_MIN[s.size]}px, 1fr))">
              ${repeat(g.effects, (e) => e.id, (e) => html`<effect-store-card
                size=${s.size} .effect=${e} .engine=${engine} .thumbs=${this.thumbs}></effect-store-card>`)}
            </div>
          </section>`)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'effect-store': EffectStore }
}
