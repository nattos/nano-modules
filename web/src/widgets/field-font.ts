/**
 * <field-font> — Font-family LIST editor for string `font` params (source.text.plain).
 *
 * The `font` param is a CSS font-family value: an ordered, comma-separated list
 * of families (a fallback chain). This widget shows that list as inline removable
 * CHIPS, each previewed in its own face, with a trailing "+" to add and a pencil
 * to toggle an inline picker that expands BELOW the row (pushing the rest of the
 * card down — not a floating popover):
 *
 *   font  [ Noto Sans × ] [ Hiragino Sans × ] [ + ]                    [ ✎ ]
 *         ┌───────────────────────────────────────────────────────────────┐
 *         │ search…                                                        │
 *         │ Arial                                                          │
 *         │ Helvetica Neue   ← APPLIED (live)                              │
 *         │ … (previewed in their own font)                               │
 *         └───────────────────────────────────────────────────────────────┘
 *
 * Selecting is LIVE: ↑/↓ flip through the list and apply each font immediately
 * (no separate cursor-then-commit step) — the highlighted row is simply the
 * family the edited chip currently holds. Clicking a row applies it too. Picking
 * REPLACES the selected chip (click a chip to select it) or, with none selected
 * (opened via "+"/pencil), APPENDS a new chip. List parse/serialize go through
 * the shared font-list helpers (parity with the C++ engine).
 *
 * The search box is an UNCONTROLLED input (no reactive `.value`) so IME
 * composition isn't clobbered — font names are commonly typed with an IME.
 */

import { html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding, FieldEditorElement } from './field-editor';
import { parseFamilyList, formatFamilyList } from '../font-list';
import {
  COMMON_FONT_SUGGESTIONS,
  localFontFamilies,
  localFontsSupported,
  primeLocalFonts,
} from '../font-access';

interface PickItem { label: string; value: string; kind: 'family' | 'custom'; }

// Common CSS generics, offered as fallback-chain entries (rendered in their own
// generic face by the browser).
const GENERIC_OPTIONS = ['sans-serif', 'serif', 'monospace'];

// Cap rendered rows so a machine with 1000+ faces doesn't build a giant list;
// search narrows past this quickly.
const MAX_ROWS = 200;

@customElement('field-font')
export class FieldFont extends MobxLitElement implements FieldEditorElement {
  @property() fieldPath = '';
  @property() label = '';
  @property() defaultValue = '';
  @property({ attribute: false }) binding: FieldBinding | null = null;

  @state() private editing = false;
  // Index of the chip a pick edits; null → append a new chip.
  @state() private selectedChip: number | null = null;
  @state() private query = '';
  // The applied family we last auto-scrolled into view. We only scroll when this
  // CHANGES (a flip / opening), never on every re-render — otherwise an
  // unrelated reactive update re-yanks the list back and fights manual scrolling.
  // `undefined` = "scroll on the next update" (set when the editor opens).
  private lastScrolledTarget: string | null | undefined = undefined;

  get controlledFields() { return [this.fieldPath]; }

  getControlElements(): HTMLElement[] {
    const el = this.renderRoot.querySelector('.row') as HTMLElement | null;
    return el ? [el] : [this];
  }

  bindInstance(binding: FieldBinding) { this.binding = binding; }

  connectedCallback() {
    super.connectedCallback();
    // Navigation keys are handled at the HOST level: keydown is composed, so it
    // bubbles to the host wherever focus sits inside the widget — robust against
    // focus drift between the search box, buttons and chips.
    this.addEventListener('keydown', this.onKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('keydown', this.onKeyDown);
  }

  private get value(): string {
    const v = this.binding?.getValue(this.fieldPath);
    return typeof v === 'string' ? v : this.defaultValue;
  }

  private get families(): string[] { return parseFamilyList(this.value); }

  /** The family the edited chip currently holds (null in append mode). */
  private get currentTarget(): string | null {
    const f = this.families;
    return this.selectedChip !== null && this.selectedChip < f.length ? f[this.selectedChip] : null;
  }

  private commitFamilies(fams: string[]) {
    this.binding?.setValue(this.fieldPath, formatFamilyList(fams));
  }

  // --- Chip operations ------------------------------------------------------

  private removeChip(i: number, e: Event) {
    e.stopPropagation();
    const f = this.families;
    f.splice(i, 1);
    this.commitFamilies(f);
    if (this.selectedChip === i) this.selectedChip = null;
    else if (this.selectedChip !== null && this.selectedChip > i) this.selectedChip--;
  }

  private selectChip(i: number) { this.openEditor(i); }
  private addNew() { this.openEditor(null); }
  private togglePencil() { this.editing ? this.closeEditor() : this.openEditor(null); }

  private openEditor(sel: number | null) {
    this.selectedChip = sel;
    this.query = '';
    this.editing = true;
    this.lastScrolledTarget = undefined;  // scroll the applied row in once, on open
    // The open is a user gesture — prime Local Font Access, then re-render with
    // the OS families (localFontFamilies() isn't observable).
    void primeLocalFonts().then(() => this.requestUpdate());
    void this.updateComplete.then(() => {
      (this.renderRoot.querySelector('.search') as HTMLInputElement | null)?.focus();
    });
  }

  private closeEditor() {
    this.editing = false;
    this.selectedChip = null;
  }

  // Apply `value` to the edited chip: replace the selected one, or append a new
  // chip. `selectNew` keeps the freshly-appended chip selected so a subsequent
  // live flip keeps editing the same chip (keyboard flow); plain clicks leave
  // append mode so you can click several rows to add several fonts.
  private applyFont(value: string, selectNew: boolean) {
    const f = this.families;
    if (this.selectedChip !== null && this.selectedChip < f.length) {
      f[this.selectedChip] = value;
    } else {
      f.push(value);
      if (selectNew) this.selectedChip = f.length - 1;
    }
    this.commitFamilies(f);
  }

  // Click a row: apply (replace selected chip / append), then reset the filter.
  private pickFont(value: string) {
    this.applyFont(value, false);
    this.query = '';
    void this.updateComplete.then(() => {
      const s = this.renderRoot.querySelector('.search') as HTMLInputElement | null;
      if (s) { s.value = ''; s.focus(); }
    });
  }

  // ↑/↓ flip: move to the adjacent row and apply it LIVE (selecting the chip so
  // continued flipping edits the same one).
  private flip(dir: 1 | -1) {
    const items = this.visibleItems();
    if (items.length === 0) return;
    const cur = this.cursorIndex(items);
    let idx: number;
    if (cur < 0) idx = dir > 0 ? 0 : items.length - 1;   // not yet on a row → enter the list
    else idx = Math.max(0, Math.min(items.length - 1, cur + dir));
    this.applyFont(items[idx].value, true);
    // .hl follows currentTarget (derived) → updated() scrolls it into view.
  }

  // --- Picker list ----------------------------------------------------------

  private allFamilies(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of [...COMMON_FONT_SUGGESTIONS, ...GENERIC_OPTIONS, ...localFontFamilies()]) {
      const k = f.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push(f); }
    }
    return out;
  }

  private visibleItems(): PickItem[] {
    const q = this.query.trim().toLowerCase();
    const items: PickItem[] = [];
    let exact = false;
    let count = 0;
    for (const fam of this.allFamilies()) {
      if (q && !fam.toLowerCase().includes(q)) continue;
      if (fam.toLowerCase() === q) exact = true;
      items.push({ label: fam, value: fam, kind: 'family' });
      if (++count >= MAX_ROWS) break;
    }
    if (q && !exact) {
      items.push({ label: `Add “${this.query.trim()}”`, value: this.query.trim(), kind: 'custom' });
    }
    return items;
  }

  /** Row index of the edited chip's current family (the live "applied" row), or
   *  -1 in append mode / when it isn't in the (filtered) list. */
  private cursorIndex(items: PickItem[]): number {
    const tk = this.currentTarget?.toLowerCase();
    if (!tk) return -1;
    return items.findIndex((it) => it.kind === 'family' && it.value.toLowerCase() === tk);
  }

  // --- Search box (uncontrolled; IME-safe) ----------------------------------

  private onSearchInput(e: Event) {
    this.query = (e.target as HTMLInputElement).value;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.editing) return;
    if (e.key === 'ArrowDown') {
      this.flip(1);
    } else if (e.key === 'ArrowUp') {
      this.flip(-1);
    } else if (e.key === 'Enter') {
      // Commit the top search result (type-to-filter, Enter-to-pick); on an
      // empty search Enter just closes (selections already applied live).
      const items = this.visibleItems();
      if (this.query.trim() && items.length) {
        this.applyFont(items[0].value, true);
        this.query = '';
        void this.updateComplete.then(() => {
          const s = this.renderRoot.querySelector('.search') as HTMLInputElement | null;
          if (s) { s.value = ''; s.focus(); }
        });
      } else {
        this.closeEditor();
      }
    } else if (e.key === 'Escape') {
      this.closeEditor();
    } else {
      return;  // let typing + Left/Right caret motion reach the search box
    }
    e.preventDefault();
    e.stopPropagation();
  };

  protected updated() {
    if (!this.editing) return;
    // Only auto-scroll when the applied font changed (flip / open) — NOT on
    // every re-render, which would fight the user scrolling the list manually.
    const cur = this.currentTarget;
    if (cur === this.lastScrolledTarget) return;
    this.lastScrolledTarget = cur;
    (this.renderRoot.querySelector('.item.hl') as HTMLElement | null)
      ?.scrollIntoView({ block: 'nearest' });
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--app-sp-2);
      padding: 2px 0;
      font-size: var(--app-fs-sm);
    }
    .row { display: flex; align-items: flex-start; gap: var(--app-sp-3); }
    .label {
      min-width: 60px;
      padding-top: 3px;
      color: var(--app-text-color2, #b0b0b0);
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chips {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--app-sp-2);
      min-height: 20px;
    }
    .hint { color: var(--app-text-color2, #8a8a8a); font-style: italic; padding: 0 2px; }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: var(--app-sp-2);
      max-width: 100%;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--app-tint-5);
      border-radius: 1px;
      padding: 1px 2px 1px 6px;
      cursor: pointer;
      color: var(--app-text-color1, #eaeaea);
    }
    .chip:hover { border-color: var(--app-hi-color2, #4169E1); }
    .chip.sel { border-color: var(--app-hi-color2, #4169E1); background: rgba(65, 105, 225, 0.28); }
    .chip-name {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: var(--app-fs-md);
    }
    .chip-x {
      border: none; background: transparent; cursor: pointer;
      color: var(--app-text-color2, #b0b0b0);
      font-size: var(--app-fs-lg); line-height: 1; padding: 0 3px; border-radius: 1px;
    }
    .chip-x:hover { color: #fff; background: var(--app-tint-5); }

    .add, .pencil {
      border: 1px solid var(--app-tint-5);
      background: rgba(0, 0, 0, 0.3);
      color: var(--app-text-color1, #eaeaea);
      border-radius: 1px;
      cursor: pointer;
      font-size: var(--app-fs-md);
      line-height: 1;
      flex-shrink: 0;
    }
    .add { padding: 2px 6px; }
    .pencil { padding: 2px 5px; }
    .add:hover, .pencil:hover { border-color: var(--app-hi-color2, #4169E1); }
    .pencil.on { border-color: var(--app-hi-color2, #4169E1); background: rgba(65, 105, 225, 0.28); }

    /* Inline expanding picker (in normal flow — grows the card downward). */
    .editor {
      margin-left: 66px;  /* align under the chips, past the label */
      display: flex;
      flex-direction: column;
      background: rgba(0, 0, 0, 0.25);
      border: 1px solid var(--app-hi-color2, #4169E1);
      border-radius: 1px;
      overflow: hidden;
    }
    .search {
      border: none;
      border-bottom: 1px solid var(--app-tint-4);
      background: rgba(0, 0, 0, 0.35);
      color: var(--app-text-color1, #eaeaea);
      padding: 5px 7px;
      font-size: var(--app-fs-md);
      font-family: inherit;
      outline: none;
    }
    .list { overflow-y: auto; max-height: 220px; }
    .item {
      display: flex;
      align-items: baseline;
      gap: var(--app-sp-4);
      padding: 4px 8px;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
    }
    .item:hover { background: rgba(65, 105, 225, 0.14); }
    /* The applied row (the edited chip's current font). */
    .item.hl {
      background: rgba(65, 105, 225, 0.34);
      box-shadow: inset 2px 0 0 var(--app-hi-color2, #4169E1);
    }
    .item .name {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      font-size: var(--app-fs-lg); color: var(--app-text-color1, #eaeaea);
    }
    .item.custom .name { font-size: var(--app-fs-md); color: var(--app-text-color2, #b0b0b0); font-style: italic; }
    .item .tag { flex-shrink: 0; font-size: var(--app-fs-xs); color: var(--app-hi-color2, #6f8fff); }
    .status {
      padding: 4px 8px;
      border-top: 1px solid var(--app-tint-4);
      color: var(--app-text-color2, #9a9a9a);
      font-size: var(--app-fs-sm);
      display: flex; justify-content: space-between; gap: var(--app-sp-4);
    }
    .empty { padding: var(--app-sp-4); color: var(--app-text-color2, #8a8a8a); font-size: var(--app-fs-sm); }
  `;

  render() {
    const fams = this.families;
    return html`
      <div class="row">
        <span class="label">${this.label}</span>
        <div class="chips">
          ${fams.length === 0 ? html`<span class="hint">host default</span>` : nothing}
          ${fams.map((fam, i) => html`
            <span class="chip ${i === this.selectedChip ? 'sel' : ''}"
                  title=${fam} @click=${() => this.selectChip(i)}>
              <span class="chip-name" style="font-family: '${cssEscape(fam)}', sans-serif">${fam}</span>
              <button class="chip-x" title="Remove" @click=${(e: Event) => this.removeChip(i, e)}>×</button>
            </span>
          `)}
          <button class="add" title="Add font" @click=${this.addNew}>+</button>
        </div>
        <button class="pencil ${this.editing ? 'on' : ''}" title="Edit font list"
                @click=${this.togglePencil}>✎</button>
      </div>
      ${this.editing ? this.renderEditor(fams) : nothing}
    `;
  }

  private renderEditor(fams: string[]) {
    const items = this.visibleItems();
    const cur = this.cursorIndex(items);
    const target = this.selectedChip !== null && this.selectedChip < fams.length
      ? `Editing “${fams[this.selectedChip]}”`
      : 'Adding to end of list';
    return html`
      <div class="editor">
        <input class="search" type="text" placeholder="Search fonts…"
               @input=${this.onSearchInput} />
        <div class="list">
          ${items.length === 0
            ? html`<div class="empty">No matches</div>`
            : items.map((it, i) => html`
              <div class="item ${it.kind} ${i === cur ? 'hl' : ''}"
                   @click=${() => this.pickFont(it.value)}>
                <span class="name"
                      style=${it.kind === 'family' ? `font-family: '${cssEscape(it.value)}', sans-serif` : ''}>
                  ${it.label}
                </span>
                ${i === cur ? html`<span class="tag">applied</span>` : nothing}
              </div>
            `)}
          ${!localFontsSupported()
            ? html`<div class="empty">Type a name to add a system font (OS font list unavailable in this browser).</div>`
            : nothing}
        </div>
        <div class="status">
          <span>${target}</span>
          <span>↑↓ pick · Esc close</span>
        </div>
      </div>
    `;
  }
}

/** Escape a font family for safe inclusion inside a single-quoted CSS value. */
function cssEscape(family: string): string {
  return family.replace(/['\\]/g, '\\$&');
}
