/**
 * <smart-input> — Inline text input with fuzzy filtering and autocomplete.
 *
 * Used to change effect types in sketch edit mode. Filters available effects
 * as the user types, shows a dropdown, and dispatches preview/commit/cancel events.
 *
 * Events:
 *   preview  — detail: effectId (string) — fired on each keystroke with the top match
 *   commit   — detail: effectId (string) — fired on Enter/Tab/blur with the final selection
 *   cancel   — fired on Escape
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import type { AvailableEffect } from '../state/types';

function shortName(id: string) { return id.split('.').pop() ?? id; }

/** Simple fuzzy match: all query chars must appear in order in the target. */
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Score a match — lower is better. Exact prefix > fuzzy name > fuzzy keyword. */
function matchScore(query: string, effect: AvailableEffect): number {
  const q = query.toLowerCase();
  const name = effect.name.toLowerCase();
  const short = shortName(effect.id).toLowerCase();

  if (short === q) return 0;          // exact match on short name
  if (short.startsWith(q)) return 1;  // prefix of short name
  if (name === q) return 2;           // exact match on display name
  if (name.startsWith(q)) return 3;   // prefix of display name
  if (fuzzyMatch(q, short)) return 4; // fuzzy on short name
  if (fuzzyMatch(q, name)) return 5;  // fuzzy on display name
  // keyword match
  for (const kw of effect.keywords) {
    if (kw.toLowerCase().startsWith(q)) return 6;
    if (fuzzyMatch(q, kw)) return 7;
  }
  if (fuzzyMatch(q, effect.category.toLowerCase())) return 8;
  return -1; // no match
}

@customElement('smart-input')
export class SmartInput extends LitElement {
  @property({ type: Array }) effects: AvailableEffect[] = [];
  @property() initialValue = '';
  @property({ type: Boolean }) autoSelect = false;

  @state() private inputValue = '';
  @state() private results: AvailableEffect[] = [];
  @state() private selectedIndex = 0;
  @state() private showDropdown = false;

  private lastPreviewedId: string | null = null;

  @query('input') private inputEl!: HTMLInputElement;

  static styles = css`
    :host {
      display: block;
      position: relative;
      z-index: 100;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      background: var(--app-bg-color2, #1a1a2e);
      border: 1px solid var(--app-hi-color2, #4169E1);
      color: var(--app-text-color1, #e0e0e0);
      font-size: 11px;
      font-family: inherit;
      padding: 3px 6px;
      border-radius: 2px;
      outline: none;
    }
    input:focus {
      border-color: var(--app-hi-color2, #4169E1);
      box-shadow: 0 0 4px rgba(65, 105, 225, 0.3);
    }
    .dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      max-height: 200px;
      overflow-y: auto;
      background: var(--app-bg-color2, #1a1a2e);
      border: 1px solid rgba(255,255,255,0.15);
      border-top: none;
      border-radius: 0 0 4px 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .dropdown-item {
      padding: 4px 8px;
      cursor: pointer;
      font-size: 11px;
      color: var(--app-text-color1, #e0e0e0);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .dropdown-item:hover,
    .dropdown-item[selected] {
      background: rgba(65, 105, 225, 0.2);
    }
    .dropdown-item-name { flex: 1; min-width: 0; }
    .dropdown-item-category {
      font-size: 9px;
      color: var(--app-text-color2, #888);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
    }
    .dropdown-item-desc {
      font-size: 9px;
      color: var(--app-text-color2, #888);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.inputValue = this.initialValue;
  }

  firstUpdated() {
    this.updateResults();
    requestAnimationFrame(() => {
      if (this.inputEl) {
        this.inputEl.focus();
        if (this.autoSelect) {
          this.inputEl.select();
        }
      }
    });
  }

  private updateResults() {
    const q = this.inputValue.trim();
    if (q.length === 0) {
      this.results = [...this.effects];
      this.showDropdown = true;
    } else {
      const scored = this.effects
        .map(e => ({ effect: e, score: matchScore(q, e) }))
        .filter(x => x.score >= 0)
        .sort((a, b) => a.score - b.score);
      this.results = scored.map(x => x.effect);
      this.showDropdown = this.results.length > 0;
    }
    this.selectedIndex = 0;

    // Emit preview for the top result
    if (this.results.length > 0) {
      this.lastPreviewedId = this.results[0].id;
      this.dispatchEvent(new CustomEvent('preview', { detail: this.results[0].id }));
    }
  }

  private onInput(e: InputEvent) {
    this.inputValue = (e.target as HTMLInputElement).value;
    this.updateResults();
  }

  private onKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (this.results.length > 0) {
          this.selectedIndex = (this.selectedIndex + 1) % this.results.length;
          this.lastPreviewedId = this.results[this.selectedIndex].id;
          this.dispatchEvent(new CustomEvent('preview', { detail: this.lastPreviewedId }));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (this.results.length > 0) {
          this.selectedIndex = (this.selectedIndex - 1 + this.results.length) % this.results.length;
          this.lastPreviewedId = this.results[this.selectedIndex].id;
          this.dispatchEvent(new CustomEvent('preview', { detail: this.lastPreviewedId }));
        }
        break;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        this.commitSelection();
        break;
      case 'Escape':
        e.preventDefault();
        this.dispatchEvent(new CustomEvent('cancel'));
        break;
    }
  }

  private onBlur() {
    // Small delay to allow click on dropdown items to fire first
    setTimeout(() => {
      if (!this.isConnected) return;
      this.commitSelection();
    }, 150);
  }

  private commitSelection() {
    const effectId = this.results[this.selectedIndex]?.id
      ?? this.lastPreviewedId
      ?? this.initialValue;
    this.dispatchEvent(new CustomEvent('commit', { detail: effectId }));
  }

  private onItemClick(index: number) {
    this.selectedIndex = index;
    this.commitSelection();
  }

  render() {
    return html`
      <input
        type="text"
        .value=${this.inputValue}
        @input=${this.onInput}
        @keydown=${this.onKeyDown}
        @blur=${this.onBlur}
      />
      ${this.showDropdown && this.results.length > 0 ? html`
        <div class="dropdown">
          ${this.results.map((effect, i) => html`
            <div class="dropdown-item"
              ?selected=${i === this.selectedIndex}
              @pointerdown=${(e: Event) => { e.preventDefault(); this.onItemClick(i); }}>
              <span class="dropdown-item-name">${effect.name}</span>
              <span class="dropdown-item-category">${effect.category}</span>
            </div>
          `)}
        </div>
      ` : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'smart-input': SmartInput;
  }
}
