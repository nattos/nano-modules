/**
 * <help-slot> — the single render + edit surface for one help "slot".
 *
 * A help slot is addressable by a `path` within an effect: a `helpField`'s name,
 * or `@group/<id>` for a group's section help. The same component is used by the
 * default inspector, the column-group section headers, AND custom inspectors
 * (e.g. brutal_fold) — so help renders and edits identically everywhere.
 *
 * Three text layers resolve per slot (see the help-text feature):
 *   - effect default  — the schema-authored markdown (the `default` prop),
 *   - global override — browser-wide, cross-sketch (field-docs-store / IndexedDB),
 *   - local override  — this sketch's instance (via the binding's getHelp/setHelp).
 * A per-slot `scope` ('global' | 'local', stored in the sketch) picks which layer
 * is SHOWN outside editing.
 *
 * Visible only when the surface's "?" help mode is on (binding.helpMode); it
 * collapses to nothing otherwise. Double-click reveals a raw-markdown editor with
 * a global | local segment selector.
 */

import { html, css, nothing, PropertyValues } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { marked } from 'marked';
import { MobxLitElement } from '../mobx-lit-element';
import type { FieldBinding } from './field-editor';
import { fieldDocsStore } from '../state/field-docs-store';
import './field-tab-bar';

type Scope = 'global' | 'local';

// Render markdown → HTML synchronously. This is a trusted, local creative tool
// (no untrusted multi-user input), so we don't pull in a full sanitizer; we do
// strip <script>/<style> blocks as a minimal guard against pasted junk.
function renderMarkdown(md: string): string {
  const html = marked.parse(md ?? '', { async: false }) as string;
  return html.replace(/<\/?(script|style)\b[^>]*>/gi, '');
}

@customElement('help-slot')
export class HelpSlot extends MobxLitElement {
  /** The field binding (help methods + helpMode + moduleType live here). */
  @property({ attribute: false }) binding: FieldBinding | null = null;
  /** The slot path — a helpField name or `@group/<id>`. */
  @property() path = '';
  /** The effect-authored default markdown (schema `default` / group `help`). */
  @property() default = '';

  @state() private editing = false;
  @state() private editScope: Scope = 'global';
  @state() private draft = '';

  static styles = css`
    :host { display: block; }
    .help-body {
      font-size: var(--app-fs-xs); line-height: 1.5;
      color: var(--app-text-color2, #b8b8b8);
      background: var(--app-tint-1, rgba(255,255,255,0.04));
      border-left: 2px solid var(--app-hi-color1, #6a9bd8);
      border-radius: 3px;
      padding: 6px 9px; margin: 2px 0 6px;
      cursor: text; overflow-wrap: anywhere;
    }
    .help-body.placeholder { opacity: 0.5; font-style: italic; border-left-style: dashed; }
    .help-body :first-child { margin-top: 0; }
    .help-body :last-child { margin-bottom: 0; }
    .help-body h1, .help-body h2, .help-body h3 {
      font-size: var(--app-fs-sm); margin: 8px 0 3px;
      color: var(--app-text-color1, #e0e0e0); font-weight: 600;
    }
    .help-body p { margin: 4px 0; }
    .help-body ul, .help-body ol { margin: 4px 0; padding-left: 18px; }
    .help-body li { margin: 1px 0; }
    .help-body code {
      font-family: var(--app-mono, monospace); font-size: 0.92em;
      background: var(--app-tint-2, rgba(255,255,255,0.08));
      padding: 0 3px; border-radius: 2px;
    }
    .help-body a { color: var(--app-hi-color1, #6a9bd8); }
    .help-body strong { color: var(--app-text-color1, #e0e0e0); }

    .editor { margin: 2px 0 6px; }
    .seg-wrap { margin-bottom: 5px; }
    textarea {
      width: 100%; box-sizing: border-box; min-height: 90px; resize: vertical;
      font-family: var(--app-mono, monospace); font-size: var(--app-fs-xs);
      line-height: 1.45; color: var(--app-text-color1, #e0e0e0);
      background: var(--app-bg-color2, #1a1a1a);
      border: 1px solid var(--app-tint-3, rgba(255,255,255,0.14)); border-radius: 3px;
      padding: 6px 8px;
    }
    .hint { font-size: var(--app-fs-xs); opacity: 0.5; margin-top: 2px; }
  `;

  /** The stored local override for this slot ({ scope, text }), or undefined. */
  private get localHelp(): { scope?: Scope; text?: string } | undefined {
    return this.binding?.getHelp?.(this.path);
  }

  /** The browser-global override text for this slot, or undefined. */
  private get globalText(): string | undefined {
    const mt = this.binding?.moduleType;
    return mt ? fieldDocsStore.get(mt, this.path) : undefined;
  }

  /** Which layer is shown outside editing (defaults to 'global'). */
  private get scope(): Scope {
    return this.localHelp?.scope === 'local' ? 'local' : 'global';
  }

  /** The text to SHOW for the active scope (with fallbacks). */
  private get displayedText(): string {
    if (this.scope === 'local') {
      return this.localHelp?.text ?? this.globalText ?? this.default ?? '';
    }
    return this.globalText ?? this.default ?? '';
  }

  /** The current text for a given scope (used to seed the editor). */
  private textFor(scope: Scope): string {
    if (scope === 'local') return this.localHelp?.text ?? this.globalText ?? this.default ?? '';
    return this.globalText ?? this.default ?? '';
  }

  private enterEdit = (e: Event) => {
    e.stopPropagation();
    this.editScope = this.scope;
    this.draft = this.textFor(this.editScope);
    this.editing = true;
    this.focusEditor(true);
  };

  /** Focus the textarea after the next render; optionally select all its content. */
  private focusEditor(selectAll = false) {
    this.updateComplete.then(() => {
      const ta = this.renderRoot.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!ta) return;
      ta.focus();
      if (selectAll) ta.select();
    });
  }

  /** Persist `draft` into the currently-edited scope. */
  private commitDraft(scope: Scope) {
    if (scope === 'global') {
      const mt = this.binding?.moduleType;
      if (mt) fieldDocsStore.set(mt, this.path, this.draft);
    } else {
      this.binding?.setHelp?.(this.path, { text: this.draft });
    }
  }

  private switchScope(next: Scope) {
    if (next === this.editScope) return;
    // Persist what's typed so far into the current scope, then load the target.
    this.commitDraft(this.editScope);
    this.editScope = next;
    // Record the shown-scope selection in the sketch.
    this.binding?.setHelp?.(this.path, { scope: next });
    this.draft = this.textFor(next);
    // Content fully changed → re-select so a retype replaces it cleanly.
    this.focusEditor(true);
  }

  private finishEdit() {
    if (!this.editing) return;
    this.commitDraft(this.editScope);
    this.binding?.setHelp?.(this.path, { scope: this.editScope });
    this.editing = false;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); this.editing = false; }   // cancel
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.finishEdit(); }
  };

  protected updated(changed: PropertyValues) {
    // Leaving help mode while editing → commit and close.
    if (this.editing && this.binding && !this.binding.helpMode) this.finishEdit();
    super.updated(changed);
  }

  render() {
    if (!this.binding?.helpMode) return nothing;

    if (this.editing) {
      // A tiny binding maps the tab bar's pseudo-field to editScope. Recreated
      // each render so its identity changes → <field-tab-bar> re-renders and the
      // active segment tracks editScope. mousedown-preventDefault on the wrapper
      // keeps the textarea focused (so its @blur doesn't commit + close the editor
      // before the segment click lands — the switching bug).
      const scopeBinding: FieldBinding = {
        instanceKey: 'help-scope',
        getValue: () => this.editScope,
        setValue: (_f, v) => this.switchScope(v as Scope),
        beginContinuousEdit: () => ({ update: () => {}, accept: () => {}, cancel: () => {} }),
      };
      return html`
        <div class="editor">
          <div class="seg-wrap" @mousedown=${(e: Event) => e.preventDefault()}>
            <field-tab-bar
              .fieldPath=${'scope'}
              .options=${[{ label: 'Global', value: 'global' }, { label: 'Local', value: 'local' }]}
              .binding=${scopeBinding}
            ></field-tab-bar>
          </div>
          <textarea
            .value=${this.draft}
            @input=${(e: Event) => { this.draft = (e.target as HTMLTextAreaElement).value; }}
            @keydown=${this.onKeyDown}
            @blur=${() => this.finishEdit()}
            @dblclick=${(e: Event) => e.stopPropagation()}
          ></textarea>
          <div class="hint">${this.editScope === 'global'
            ? 'Global — shared across every sketch on this browser'
            : 'Local — saved in this sketch only'} · ⌘/Ctrl+Enter to save · Esc to cancel</div>
        </div>
      `;
    }

    const text = this.displayedText;
    if (!text) {
      return html`<div class="help-body placeholder" @dblclick=${this.enterEdit}
        title="Double-click to add help text">Double-click to add help…</div>`;
    }
    return html`<div class="help-body" @dblclick=${this.enterEdit}
      title="Double-click to edit help text">${unsafeHTML(renderMarkdown(text))}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'help-slot': HelpSlot;
  }
}
