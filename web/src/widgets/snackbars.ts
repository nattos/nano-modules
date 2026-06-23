/**
 * General snackbar (toast) mechanism — a small MobX store + `<snackbar-host>`
 * component. Supports multiple concurrent snackbars, optional action buttons, and
 * optional auto-dismiss. App-agnostic: any surface can `snackbars.show(...)`.
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { makeAutoObservable, runInAction } from 'mobx';
import { MobxLitElement } from '../mobx-lit-element';

export interface SnackbarAction {
  label: string;
  /** Invoked on click. The snackbar is dismissed afterwards unless `keepOpen`. */
  run: () => void;
  keepOpen?: boolean;
}

export interface Snackbar {
  id: number;
  message: string;
  actions: SnackbarAction[];
  /** Auto-dismiss after this many ms (0 = sticky until dismissed/actioned). */
  timeoutMs: number;
}

export interface SnackbarOpts {
  message: string;
  actions?: SnackbarAction[];
  /** Default 6000ms; pass 0 to keep it until the user acts/closes. */
  timeoutMs?: number;
  /** De-dupe key: a new show() with the same key replaces the existing one
   *  (resets its timer) instead of stacking a duplicate. */
  dedupeKey?: string;
}

class SnackbarStore {
  items: Snackbar[] = [];
  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private byKey = new Map<string, number>();

  constructor() {
    makeAutoObservable<SnackbarStore, 'timers' | 'byKey' | 'nextId'>(this, {
      timers: false,
      byKey: false,
      nextId: false,
    });
  }

  show(opts: SnackbarOpts): number {
    const timeoutMs = opts.timeoutMs ?? 6000;
    // Replace an existing snackbar with the same dedupe key (reset its timer).
    if (opts.dedupeKey && this.byKey.has(opts.dedupeKey)) {
      this.dismiss(this.byKey.get(opts.dedupeKey)!);
    }
    const id = this.nextId++;
    const item: Snackbar = { id, message: opts.message, actions: opts.actions ?? [], timeoutMs };
    runInAction(() => { this.items = [...this.items, item]; });
    if (opts.dedupeKey) this.byKey.set(opts.dedupeKey, id);
    if (timeoutMs > 0) {
      this.timers.set(id, setTimeout(() => this.dismiss(id), timeoutMs));
    }
    return id;
  }

  dismiss(id: number) {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
    for (const [k, v] of this.byKey) if (v === id) this.byKey.delete(k);
    runInAction(() => { this.items = this.items.filter((i) => i.id !== id); });
  }

  runAction(id: number, action: SnackbarAction) {
    action.run();
    if (!action.keepOpen) this.dismiss(id);
  }
}

export const snackbars = new SnackbarStore();

@customElement('snackbar-host')
export class SnackbarHost extends MobxLitElement {
  static styles = css`
    :host {
      position: fixed;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      pointer-events: none;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
    }
    .bar {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 14px;
      max-width: 92vw;
      padding: 9px 12px 9px 14px;
      background: var(--app-bg-color3, #2a2c34);
      color: var(--app-text-color1, #eee);
      border: 1px solid var(--app-tint-4, rgba(255,255,255,0.14));
      border-radius: 6px;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.45);
      font-size: var(--app-fs-s, 12px);
      animation: rise 140ms ease-out;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .msg { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { display: flex; gap: 6px; flex-shrink: 0; }
    button {
      font: inherit;
      cursor: pointer;
      border-radius: 4px;
      padding: 3px 9px;
      border: 1px solid var(--app-tint-4, rgba(255,255,255,0.18));
      background: var(--app-tint-2, rgba(255,255,255,0.06));
      color: var(--app-hi-color2, #6f9bff);
    }
    button:hover { background: var(--app-tint-3, rgba(255,255,255,0.12)); }
    button.close {
      color: var(--app-text-color2, #aaa);
      padding: 3px 7px;
    }
  `;

  render() {
    return html`
      ${snackbars.items.map(
        (s) => html`<div class="bar">
          <span class="msg" title=${s.message}>${s.message}</span>
          <div class="actions">
            ${s.actions.map(
              (a) => html`<button @click=${() => snackbars.runAction(s.id, a)}>${a.label}</button>`,
            )}
            <button class="close" title="Dismiss" @click=${() => snackbars.dismiss(s.id)}>✕</button>
          </div>
        </div>`,
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'snackbar-host': SnackbarHost;
  }
}
