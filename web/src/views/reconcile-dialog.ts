/**
 * <reconcile-dialog> — the Live-mode cache-vs-canonical conflict dialog.
 *
 * Shown when `state/live-reconcile.ts`'s `reconcileDecision` returns
 * 'conflict': the offline cache has local edits that don't match what the
 * barrel currently holds. Blocks editing (readonly stays on) until the user
 * picks a side — this is a destructive, mutually-exclusive overwrite of
 * shared state, so unlike the snackbar system there is deliberately no
 * soft-dismiss/auto-timeout.
 *
 * A small MobX singleton store (mirrors `widgets/snackbars.ts`'s shape) so
 * any caller can `reconcileStore.open(...)` without prop-drilling through the
 * Resolume shell.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { makeAutoObservable, runInAction } from 'mobx';
import { MobxLitElement } from '../mobx-lit-element';
import type { Sketch } from '../sketch-types';
import type { RecencySide } from '../state/live-reconcile';

export interface ReconcileRequest {
  instanceKey: string;
  instanceLabel: string;
  /** The local, offline-edited copy. */
  cached: Sketch;
  /** What the barrel currently holds. */
  canonical: Sketch;
  /** Which side `reconcileDecision` suggests (visually emphasized). */
  recommended: RecencySide;
  onResolve: (choice: 'keep-cached' | 'keep-canonical') => void;
}

class ReconcileStore {
  request: ReconcileRequest | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  open(request: ReconcileRequest) {
    runInAction(() => { this.request = request; });
  }

  resolve(choice: 'keep-cached' | 'keep-canonical') {
    const req = this.request;
    if (!req) return;
    runInAction(() => { this.request = null; });
    req.onResolve(choice);
  }
}

export const reconcileStore = new ReconcileStore();

/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago", "4w ago". */
function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `${Math.round(d)}d ago`;
  const w = d / 7;
  return `${Math.round(w)}w ago`;
}

function summarize(sketch: Sketch): string {
  const effects = (sketch.chain ?? []).filter(e => e.type === 'module').length;
  const wires = sketch.wires?.length ?? 0;
  return `${effects} effect${effects === 1 ? '' : 's'} · ${wires} wire${wires === 1 ? '' : 's'}`;
}

@customElement('reconcile-dialog')
export class ReconcileDialog extends MobxLitElement {
  static styles = css`
    /* No request → no box at all, so this can't swallow clicks meant for
       whatever's underneath (the Settings tab, a snackbar's buttons, ...).
       Only the [open] state (set in render(), reflecting reconcileStore.request)
       becomes the full-viewport scrim. */
    :host {
      display: none;
    }
    :host([open]) {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
    }
    .card {
      width: min(720px, 92vw);
      background: var(--app-bg-color2);
      border: 1px solid var(--app-tint-4);
      border-radius: 6px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      padding: var(--app-sp-6);
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-5);
      color: var(--app-text-color1);
    }
    h1 {
      font-size: var(--app-fs-lg);
      margin: 0;
    }
    .explain {
      font-size: var(--app-fs-md);
      color: var(--app-text-color2);
      line-height: 1.5;
    }
    .panels {
      display: flex;
      gap: var(--app-sp-4);
    }
    .panel {
      flex: 1;
      border: 1px solid var(--app-tint-4);
      border-radius: 4px;
      padding: var(--app-sp-4);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .panel[recommended] {
      border-color: var(--app-hi-color2);
    }
    .panel .title {
      font-size: var(--app-fs-md);
      font-weight: 600;
    }
    .badge {
      align-self: flex-start;
      font-size: var(--app-fs-sm);
      padding: 1px 6px;
      border-radius: 2px;
      border: 1px solid var(--app-tint-5);
      color: var(--app-text-color2);
    }
    .badge.newer {
      color: var(--app-ok);
      border-color: var(--app-ok);
    }
    .panel .time {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    .panel .summary {
      font-size: var(--app-fs-sm);
      color: var(--app-text-color2);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--app-sp-3);
    }
    button {
      font: inherit;
      cursor: pointer;
      border-radius: 3px;
      padding: 6px 14px;
      border: 1px solid var(--app-tint-5);
      background: var(--app-tint-2, rgba(255,255,255,0.06));
      color: var(--app-text-color1);
    }
    button:hover {
      background: var(--app-tint-3, rgba(255,255,255,0.12));
    }
  `;

  render() {
    const req = reconcileStore.request;
    this.toggleAttribute('open', !!req);
    if (!req) return html``;

    const cachedLM = req.cached.lastModified;
    const canonicalLM = req.canonical.lastModified;

    return html`
      <div class="card">
        <h1>Composition conflict — ${req.instanceLabel}</h1>
        <div class="explain">
          Your offline edits differ from what Resolume currently has for this
          instance. Pick which one to keep — the other will be discarded.
        </div>
        <div class="panels">
          <div class="panel" ?recommended=${req.recommended === 'cached'}>
            <span class="title">Your copy</span>
            <span class="badge ${req.recommended === 'cached' ? 'newer' : ''}">
              ${req.recommended === 'cached' ? 'more recent' : 'offline edits'}
            </span>
            <span class="time" title=${cachedLM ? new Date(cachedLM).toLocaleString() : ''}>
              ${cachedLM ? timeAgo(cachedLM) : 'unknown edit time'}
            </span>
            <span class="summary">${summarize(req.cached)}</span>
          </div>
          <div class="panel" ?recommended=${req.recommended === 'canonical'}>
            <span class="title">Resolume's version</span>
            <span class="badge ${req.recommended === 'canonical' ? 'newer' : ''}">
              ${req.recommended === 'canonical' ? 'more recent' : 'current live state'}
            </span>
            <span class="time" title=${canonicalLM ? new Date(canonicalLM).toLocaleString() : ''}>
              ${canonicalLM ? timeAgo(canonicalLM) : 'unknown edit time'}
            </span>
            <span class="summary">${summarize(req.canonical)}</span>
          </div>
        </div>
        <div class="actions">
          <button @click=${() => reconcileStore.resolve('keep-canonical')}>Keep Resolume's version</button>
          <button @click=${() => reconcileStore.resolve('keep-cached')}>Keep my copy</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'reconcile-dialog': ReconcileDialog;
  }
}
