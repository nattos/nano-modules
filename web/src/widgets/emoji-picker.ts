/**
 * <emoji-picker> — the full emoji set, for the effect store's reactions.
 *
 * The data (emojibase-data's compact English set, ~570 KB) is imported on
 * first open only, so nobody pays for it until they press "+". Group tabs are
 * a segmented bar (one per emoji group, labelled by a representative emoji);
 * typing searches every group by name and tag instead.
 *
 * Fires `pick` ({detail: emoji}) and `close`. The host positions it.
 */

import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';

interface EmojiEntry { unicode: string; label: string; group?: number; order?: number; tags?: string[] }
interface EmojiGroup { id: number; icon: string; name: string; emoji: EmojiEntry[] }

/** emojibase group ids → our labels (2 = skin-tone components: skipped). */
const GROUP_NAMES: Record<number, string> = {
  0: 'Smileys', 1: 'People', 3: 'Nature', 4: 'Food', 5: 'Travel',
  6: 'Activities', 7: 'Objects', 8: 'Symbols', 9: 'Flags',
};

let groupsPromise: Promise<EmojiGroup[]> | null = null;

/** Load + shape the emoji data once per session. */
export function loadEmojiGroups(): Promise<EmojiGroup[]> {
  groupsPromise ??= import('emojibase-data/en/compact.json').then((mod) => {
    const data = ((mod as any).default ?? mod) as EmojiEntry[];
    const byGroup = new Map<number, EmojiEntry[]>();
    for (const e of data) {
      if (e.group === undefined || !(e.group in GROUP_NAMES)) continue;
      let g = byGroup.get(e.group);
      if (!g) byGroup.set(e.group, g = []);
      g.push({ unicode: e.unicode, label: e.label, group: e.group, order: e.order, tags: e.tags });
    }
    return [...byGroup.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, emoji]) => {
        emoji.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return { id, name: GROUP_NAMES[id], icon: emoji[0]?.unicode ?? '?', emoji };
      });
  });
  return groupsPromise;
}

@customElement('emoji-picker')
export class EmojiPicker extends LitElement {
  @state() private groups: EmojiGroup[] | null = null;
  @state() private groupId = 0;
  @state() private search = '';
  @query('input') private input!: HTMLInputElement;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 320px;
      max-height: 340px;
      background: var(--app-bg-color2, #1d1f24);
      border: 1px solid var(--app-tint-4);
      border-radius: 6px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
      overflow: hidden;
      font-size: var(--app-fs-sm);
      color: var(--app-text-color1);
    }
    input, .tabs { flex-shrink: 0; }
    input {
      margin: 8px;
      padding: 5px 8px;
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-4);
      border-radius: 4px;
      color: inherit;
      font: inherit;
    }
    .tabs {
      display: flex;
      margin: 0 8px 6px;
      border: 1px solid var(--app-tint-4);
      border-radius: 4px;
      overflow: hidden;
    }
    .tabs button {
      flex: 1 1 0;
      min-width: 0;
      padding: 3px 0;
      background: transparent;
      border: none;
      border-left: 1px solid var(--app-tint-4);
      cursor: pointer;
      font-size: 14px;
      line-height: 1.2;
    }
    .tabs button:first-child { border-left: none; }
    .tabs button:hover { background: var(--app-tint-2); }
    .tabs button[active] { background: var(--app-tint-3); box-shadow: inset 0 -2px 0 var(--app-hi-color2, #4169e1); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(32px, 1fr));
      padding: 0 6px 8px;
      overflow-y: auto;
      flex: 1;
      min-height: 0;
    }
    .grid button {
      aspect-ratio: 1;
      font-size: 20px;
      background: transparent;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      padding: 0;
    }
    .grid button:hover { background: var(--app-tint-3); }
    .empty, .loading { grid-column: 1 / -1; padding: 16px; color: var(--app-text-color2); text-align: center; }
  `;

  connectedCallback() {
    super.connectedCallback();
    void loadEmojiGroups().then((g) => {
      this.groups = g;
      this.groupId = g[0]?.id ?? 0;
    });
    window.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('keydown', this.onKey, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('keydown', this.onKey, true);
  }

  firstUpdated() {
    this.input?.focus();
  }

  private onOutside = (e: PointerEvent) => {
    if (!e.composedPath().includes(this)) this.dispatchEvent(new CustomEvent('close'));
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.dispatchEvent(new CustomEvent('close'));
    }
  };

  private pick(emoji: string) {
    this.dispatchEvent(new CustomEvent('pick', { detail: emoji }));
  }

  private visible(): EmojiEntry[] {
    const groups = this.groups ?? [];
    const q = this.search.trim().toLowerCase();
    if (!q) return groups.find((g) => g.id === this.groupId)?.emoji ?? [];
    const out: EmojiEntry[] = [];
    for (const g of groups) {
      for (const e of g.emoji) {
        if (e.label.toLowerCase().includes(q) || e.tags?.some((t) => t.startsWith(q))) out.push(e);
        if (out.length >= 240) return out;
      }
    }
    return out;
  }

  render() {
    const list = this.visible();
    return html`
      <input
        placeholder="Search emoji"
        .value=${this.search}
        @input=${(e: Event) => { this.search = (e.target as HTMLInputElement).value; }}
      />
      ${this.search.trim() ? nothing : html`
        <div class="tabs">
          ${(this.groups ?? []).map((g) => html`
            <button title=${g.name} ?active=${g.id === this.groupId} @click=${() => { this.groupId = g.id; }}>${g.icon}</button>
          `)}
        </div>`}
      <div class="grid">
        ${!this.groups
          ? html`<div class="loading">Loading…</div>`
          : list.length === 0
            ? html`<div class="empty">No emoji match</div>`
            : list.map((e) => html`<button title=${e.label} @click=${() => this.pick(e.unicode)}>${e.unicode}</button>`)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'emoji-picker': EmojiPicker }
}
