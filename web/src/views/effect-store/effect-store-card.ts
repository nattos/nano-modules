/**
 * <effect-store-card> — one effect in the Effects tab's grid.
 *
 * Shows the effect's cached thumbnail (baked on the preview engine the first
 * time the card scrolls into view), swaps it for the effect running LIVE while
 * the pointer rests on the card, and carries the Use / Preview actions. Hovering
 * also shows a floating "add reaction" button (the chat-app pattern): it opens
 * the six recent emoji as a quick row, whose "+" expands into the full picker;
 * reactions already given show as chips under the title, and
 * take no room until there is one. Double-click is Use.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { autorun, type IReactionDisposer } from 'mobx';
import { MobxLitElement } from '../../mobx-lit-element';
import type { AvailableEffect } from '../../state/types';
import type { PreviewEngine } from '../../preview/preview-engine';
import { drawPlot } from '../../preview/preview-engine';
import type { Thumbnails } from '../../preview/thumbnails';
import { scenarioThumb } from '../../preview/scenario';
import { appState } from '../../state/app-state';
import { appController } from '../../state/controller';
import { effectStore } from '../../state/effect-store-controller';
import { categoryColor, effectDomain } from '../../widgets/category-color';
import { bundleLabel } from '../../effect-bundles';
import { pushRecentEmoji, toggleReaction, versionBadge } from './store-model';

/** The emoji popup's footprints — compact quick row, then expanded — for
 *  keeping it inside the viewport. */
const QUICK_SIZE = { w: 270, h: 48 };
const PICKER_SIZE = { w: 320, h: 380 };
import '../../widgets/ui-icon';
import '../../widgets/emoji-picker';

/** Pointer must rest this long before a card starts running live. */
const HOVER_DELAY_MS = 180;

@customElement('effect-store-card')
export class EffectStoreCard extends MobxLitElement {
  @property({ attribute: false }) effect!: AvailableEffect;
  @property({ attribute: false }) engine!: PreviewEngine;
  @property({ attribute: false }) thumbs!: Thumbnails;
  /** Where the emoji picker opens (viewport px), or null when closed. It is
   *  position:fixed so no scroll container or card edge clips it. */
  @state() private pickerAt: { right: number; top: number } | null = null;
  /** The add-reaction button's rect when the popup opened (it is placed
   *  against it, and again when it expands). */
  private pickerAnchor: DOMRect | null = null;

  private io: IntersectionObserver | null = null;
  private visible = false;
  private hoverTimer = 0;
  private liveDisposer: IReactionDisposer | null = null;

  static styles = css`
    :host { display: block; min-width: 0; }
    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--app-bg-color2, #1b1d22);
      border: 1px solid var(--app-tint-3);
      border-radius: 8px;
      overflow: hidden;
      cursor: default;
      transition: border-color 0.12s;
    }
    .card:hover { border-color: var(--app-tint-5, #555); }
    .card[previewing] { border-color: var(--app-hi-color2, #4169e1); }
    .thumb {
      position: relative;
      aspect-ratio: 16 / 9;
      background: #0e0f12;
      overflow: hidden;
    }
    .thumb img, .thumb canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .shimmer {
      position: absolute;
      inset: 0;
      background: linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.05) 50%, transparent 80%) #121318;
      background-size: 200% 100%;
      animation: shimmer 1.4s linear infinite;
    }
    .icon-tile {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 12px;
      text-align: center;
      font-size: 15px;
      font-weight: 600;
      color: var(--app-text-color2);
      background: radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--tile) 28%, transparent), transparent 70%) #121318;
    }
    @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
    .badge {
      position: absolute;
      top: 6px;
      left: 6px;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: var(--app-hi-color2, #4169e1);
      color: white;
    }
    .badge.updated { background: #8a6d1d; }
    .live-dot {
      position: absolute;
      bottom: 9px;
      left: 8px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ff4d5e;
      box-shadow: 0 0 6px #ff4d5e;
    }
    .actions {
      position: absolute;
      bottom: 6px;
      right: 6px;
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.12s;
    }
    .card:hover .actions, .card[previewing] .actions { opacity: 1; }
    .actions button {
      padding: 3px 9px;
      border-radius: 4px;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(12, 13, 16, 0.82);
      color: var(--app-text-color1);
      font: inherit;
      font-size: var(--app-fs-sm);
      cursor: pointer;
    }
    .actions button:hover:not(:disabled) { background: var(--app-hi-color2, #4169e1); }
    .actions button.use { background: var(--app-hi-color2, #4169e1); border-color: transparent; }
    .actions button:disabled { opacity: 0.4; cursor: default; }
    .meta { padding: 7px 9px 4px; min-width: 0; }
    .title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .name { overflow: hidden; text-overflow: ellipsis; }
    .sub {
      margin-top: 2px;
      font-size: var(--app-fs-xs, 11px);
      color: var(--app-text-color3, #777);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .desc {
      margin-top: 4px;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    :host([size='s']) .desc { display: none; }
    .reactions {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      padding: 0 8px 8px;
      margin-top: auto;
    }
    .reaction {
      display: inline-flex;
      align-items: center;
      padding: 0 5px;
      height: 20px;
      border-radius: 10px;
      border: 1px solid var(--app-hi-color2, #4169e1);
      background: rgba(65, 105, 225, 0.2);
      font-size: 12px;
      cursor: pointer;
    }
    .reaction:hover { background: rgba(65, 105, 225, 0.35); }
    .react-btn {
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.18);
      background: rgba(12, 13, 16, 0.82);
      color: var(--app-text-color1);
      --icon-size: 17px;
      cursor: pointer;
      opacity: 0;
      transform: scale(0.85);
      transition: opacity 0.12s, transform 0.12s;
    }
    .card:hover .react-btn, .react-btn[open] { opacity: 1; transform: none; }
    .react-btn:hover, .react-btn[open] { background: var(--app-hi-color2, #4169e1); border-color: transparent; }
    emoji-picker { position: fixed; z-index: 1000; }
  `;

  connectedCallback() {
    super.connectedCallback();
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((entries) => {
        this.visible = entries[entries.length - 1]?.isIntersecting ?? false;
        if (this.visible) this.thumbs?.request(this.effect);
      }, { rootMargin: '300px' });
      this.io.observe(this);
    } else {
      this.thumbs?.request(this.effect);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.io?.disconnect();
    this.io = null;
    this.leave();
  }

  updated(changed: Map<string, unknown>) {
    // Re-pointed at another effect while on screen (no intersection change
    // fires for that): ask for the new one's thumbnail.
    if (changed.has('effect') && changed.get('effect') !== undefined && this.visible) this.thumbs?.request(this.effect);
  }

  private enter = () => {
    clearTimeout(this.hoverTimer);
    if (scenarioThumb(this.effect.preview) === 'icon') return; // nothing to run
    this.hoverTimer = window.setTimeout(() => {
      void this.engine.startLive(this.effect);
      this.watchLive();
    }, HOVER_DELAY_MS);
  };

  private leave = () => {
    clearTimeout(this.hoverTimer);
    this.liveDisposer?.();
    this.liveDisposer = null;
    if (this.engine?.liveEffect.get() === this.effect?.id) void this.engine.stopLive(this.effect.id);
  };

  /** Draw the live frame (or plot) into the thumbnail canvas as it arrives. */
  private watchLive() {
    this.liveDisposer?.();
    this.liveDisposer = autorun(() => {
      this.engine.liveGeneration.get();
      if (this.engine.liveEffect.get() !== this.effect.id) return;
      const canvas = this.renderRoot.querySelector('canvas.live') as HTMLCanvasElement | null;
      if (!canvas) return;
      const samples = this.engine.liveSamples;
      const frame = this.engine.liveFrame.get();
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      if (samples) {
        canvas.width = 320; canvas.height = 180;
        drawPlot(ctx, samples.values, samples.min, samples.max, canvas.width, canvas.height, samples.ghosts);
      } else if (frame) {
        if (canvas.width !== frame.width) canvas.width = frame.width;
        if (canvas.height !== frame.height) canvas.height = frame.height;
        ctx.drawImage(frame, 0, 0);
      }
    });
  }

  private togglePicker = (ev: MouseEvent) => {
    ev.stopPropagation();
    if (this.pickerAt) { this.pickerAt = null; return; }
    this.pickerAnchor = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    this.placePicker(QUICK_SIZE);
  };

  /** Put the popup under the button, right edges aligned (so its actual
   *  width never matters), or above it when there is no room below. */
  private placePicker(size: { w: number; h: number }) {
    const r = this.pickerAnchor;
    if (!r) return;
    const right = Math.max(8, Math.min(innerWidth - r.right, innerWidth - size.w - 8));
    const top = r.bottom + 6 + size.h <= innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - size.h - 6);
    this.pickerAt = { right, top };
  }

  private react(emoji: string) {
    const s = appState.local.userSettings;
    const next = toggleReaction(s.effectReactions[this.effect.id], emoji);
    const reactions = { ...s.effectReactions };
    if (next.length) reactions[this.effect.id] = next; else delete reactions[this.effect.id];
    appController.setUserSetting('effectReactions', reactions);
    if (next.includes(emoji)) appController.setUserSetting('recentEmoji', pushRecentEmoji(s.recentEmoji, emoji));
  }

  render() {
    const e = this.effect;
    const view = this.thumbs?.views.get(e.id);
    const live = this.engine?.liveEffect.get() === e.id;
    const previewing = effectStore.preview.get()?.effectId === e.id;
    const canPlace = effectStore.canPlace();
    const target = effectStore.target.get();
    const badge = versionBadge(e);
    const domain = effectDomain(e.id);
    const mine = appState.local.userSettings.effectReactions[e.id] ?? [];
    const useLabel = target?.kind === 'retype' ? 'Use here' : 'Insert';
    const placeHint = canPlace ? '' : ' — open a sketch in Edit first';
    return html`
      <div class="card" ?previewing=${previewing}
        @pointerenter=${this.enter} @pointerleave=${this.leave}
        @dblclick=${() => { if (canPlace) effectStore.use(e.id); }}>
        <div class="thumb">
          ${scenarioThumb(e.preview) === 'icon'
            ? html`<div class="icon-tile" style="--tile:${categoryColor(domain)}">${e.name || e.id}</div>`
            : view ? html`<img src=${view.url} alt="" draggable="false" />` : html`<div class="shimmer"></div>`}
          ${live ? html`<canvas class="live"></canvas><span class="live-dot" title="Running live"></span>` : nothing}
          ${badge ? html`<span class="badge ${badge}">${badge === 'new' ? 'New' : 'Updated'}</span>` : nothing}
          <div class="actions">
            <button title=${`Preview in place without committing${placeHint}`} ?disabled=${!canPlace}
              @click=${() => effectStore.togglePreview(e.id)}>${previewing ? 'Stop' : 'Preview'}</button>
            <button class="use" title=${`${useLabel}${placeHint}`} ?disabled=${!canPlace}
              @click=${() => effectStore.use(e.id)}>${useLabel}</button>
          </div>
        </div>
        <div class="meta">
          <div class="title">
            <span class="dot" style="background:${categoryColor(domain)}"></span>
            <span class="name" title=${e.id}>${e.name || e.id}</span>
          </div>
          <div class="sub">${e.id}${e.bundle ? html` · ${bundleLabel(e.bundle)}` : nothing}</div>
          ${e.description ? html`<div class="desc">${e.description}</div>` : nothing}
        </div>
        ${mine.length ? html`
          <div class="reactions">
            ${mine.map((x) => html`<span class="reaction" title="Remove reaction" @click=${() => this.react(x)}>${x}</span>`)}
          </div>` : nothing}
        <button class="react-btn" title="Add reaction" ?open=${!!this.pickerAt}
          @click=${this.togglePicker} @dblclick=${(ev: Event) => ev.stopPropagation()}>
          <ui-icon icon="la-smile"></ui-icon>
        </button>
        ${this.pickerAt ? html`<emoji-picker style="right:${this.pickerAt.right}px;top:${this.pickerAt.top}px"
            .quick=${appState.local.userSettings.recentEmoji} .selected=${mine}
            .anchor=${this.renderRoot.querySelector('.react-btn')}
            @dblclick=${(ev: Event) => ev.stopPropagation()}
            @expand=${() => this.placePicker(PICKER_SIZE)}
            @pick=${(ev: CustomEvent<string>) => { this.pickerAt = null; this.react(ev.detail); }}
            @close=${() => { this.pickerAt = null; }}></emoji-picker>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'effect-store-card': EffectStoreCard }
}
