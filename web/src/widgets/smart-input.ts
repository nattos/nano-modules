/**
 * <smart-input> — Inline CodeMirror editor with autocomplete for effect type selection.
 *
 * Used to change effect types in sketch edit mode. Filters available effects
 * as the user types, shows a dropdown via CodeMirror autocompletion, and
 * dispatches preview/commit/cancel events.
 *
 * Events:
 *   preview  — detail: effectId (string) — fired on each keystroke with the top match
 *   commit   — detail: effectId (string) — fired on Enter/Tab/blur with the final selection
 *   cancel   — fired on Escape
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, query } from 'lit/decorators.js';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  autocompletion,
  type CompletionContext,
  type CompletionResult,
  startCompletion,
  closeCompletion,
  acceptCompletion,
  completionKeymap,
} from '@codemirror/autocomplete';
import { standardKeymap } from '@codemirror/commands';
import type { AvailableEffect } from '../state/types';

function shortName(id: string) { return id.split('.').pop() ?? id; }

/** Simple fuzzy match: all query chars must appear in order in the target. */
function fuzzyMatch(q: string, t: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Score a match — lower is better. Returns -1 for no match. */
function matchScore(query: string, effect: AvailableEffect): number {
  const q = query.toLowerCase();
  const name = effect.name.toLowerCase();
  const short = shortName(effect.id).toLowerCase();

  if (short === q) return 0;
  if (short.startsWith(q)) return 1;
  if (name === q) return 2;
  if (name.startsWith(q)) return 3;
  if (fuzzyMatch(q, short)) return 4;
  if (fuzzyMatch(q, name)) return 5;
  for (const kw of effect.keywords) {
    if (kw.toLowerCase().startsWith(q)) return 6;
    if (fuzzyMatch(q, kw)) return 7;
  }
  if (fuzzyMatch(q, effect.category.toLowerCase())) return 8;
  return -1;
}

/** Search effects and return scored results (best first). */
function searchEffects(effects: AvailableEffect[], query: string): AvailableEffect[] {
  const q = query.trim();
  if (q.length === 0) return [...effects];
  return effects
    .map(e => ({ effect: e, score: matchScore(q, e) }))
    .filter(x => x.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map(x => x.effect);
}

@customElement('smart-input')
export class SmartInput extends LitElement {
  @property({ type: Array }) effects: AvailableEffect[] = [];
  @property() initialValue = '';
  @property({ type: Boolean }) autoSelect = false;

  @query('#editor') private editorContainer!: HTMLElement;

  private editorView?: EditorView;
  private lastPreviewedId: string | null = null;

  static styles = css`
    :host {
      display: block;
      position: relative;
      z-index: 100;
    }
    #editor {
      width: 100%;
    }
    /* CodeMirror dark theme overrides */
    .cm-editor {
      font-size: 11px;
      background: transparent;
    }
    .cm-editor.cm-focused { outline: none; }
    .cm-scroller { overflow: visible; }
    .cm-content {
      padding: 0;
      font-family: inherit;
      caret-color: var(--app-text-color1, #e0e0e0);
    }
    .cm-line { padding: 0; }
    .cm-selectionBackground { background: rgba(65, 105, 225, 0.35) !important; }
    .cm-cursor { border-left-color: var(--app-text-color1, #e0e0e0) !important; }

    /* Autocomplete popup */
    .cm-tooltip {
      background: var(--app-bg-color2, #1a1a2e) !important;
      color: var(--app-text-color1, #e0e0e0) !important;
      border: 1px solid rgba(255,255,255,0.15) !important;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    .cm-tooltip-autocomplete {
      max-height: 200px;
    }
    .cm-tooltip-autocomplete > ul {
      font-family: inherit;
      font-size: 11px;
    }
    .cm-tooltip-autocomplete > ul > li {
      padding: 3px 8px !important;
      line-height: 1.4;
    }
    .cm-tooltip-autocomplete > ul > li[aria-selected] {
      background: rgba(65, 105, 225, 0.3) !important;
      color: var(--app-text-color1, #e0e0e0) !important;
    }
    .cm-completionLabel {
      font-weight: 500;
    }
    .cm-completionDetail {
      font-style: normal !important;
      color: var(--app-text-color2, #888) !important;
      margin-left: 8px !important;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .cm-completionMatchedText {
      text-decoration: none !important;
      color: var(--app-hi-color2, #4169E1) !important;
    }
    /* Namespace entries get a subtle folder-like appearance */
    .cm-tooltip-autocomplete > ul > li .cm-completionLabel {
      font-weight: 400;
    }
  `;

  protected firstUpdated() {
    this.initEditor();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.editorView?.destroy();
    this.editorView = undefined;
  }

  private initEditor() {
    if (!this.editorContainer) return;

    const darkTheme = EditorView.theme({
      '&': { color: '#eee', backgroundColor: 'transparent' },
      '.cm-content': { caretColor: '#fff' },
      '&.cm-focused .cm-cursor': { borderLeftColor: '#fff' },
      '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: '#444' },
      '.cm-tooltip': {
        backgroundColor: '#1a1a2e',
        color: '#eee',
        border: '1px solid rgba(255,255,255,0.15)',
        position: 'fixed',
        zIndex: '99999',
      },
      '.cm-tooltip-autocomplete': {
        '& > ul > li[aria-selected]': { backgroundColor: '#334', color: '#fff' },
      },
    }, { dark: true });

    const self = this;

    const extensions = [
      darkTheme,
      keymap.of([
        {
          key: 'Tab',
          run: (view) => {
            if (acceptCompletion(view)) return true;
            const val = view.state.doc.toString();
            if (val.length === 0) {
              self.dispatchEvent(new CustomEvent('delete-request'));
              return true;
            }
            self.dispatchCommit(val);
            return true;
          },
        },
        {
          key: 'Enter',
          run: (view) => {
            if (acceptCompletion(view)) return true;
            const val = view.state.doc.toString();
            if (val.length === 0) {
              self.dispatchEvent(new CustomEvent('delete-request'));
              return true;
            }
            self.dispatchCommit(val);
            return true;
          },
        },
        {
          key: 'Escape',
          run: () => {
            self.dispatchEvent(new CustomEvent('cancel'));
            return true;
          },
        },
        ...completionKeymap,
        ...standardKeymap,
      ]),
      cmPlaceholder('Search effects...'),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;

        const isUserEvent = update.transactions.some(
          tr => tr.isUserEvent('input') || tr.isUserEvent('delete'),
        );
        if (!isUserEvent) return;

        const value = update.state.doc.toString();

        // An explicitly emptied input means the user is asking to delete the
        // effect on commit — clear the pending preview so dispatchCommit can
        // route into the delete path rather than falling back to a guess.
        if (value.length === 0) {
          self.lastPreviewedId = null;
          startCompletion(self.editorView!);
          return;
        }

        const results = searchEffects(self.effects, value);

        if (results.length > 0) {
          self.lastPreviewedId = results[0].id;
          self.dispatchEvent(new CustomEvent('preview', { detail: results[0].id }));
        } else if (self.lastPreviewedId) {
          // Keep last valid preview
          self.dispatchEvent(new CustomEvent('preview', { detail: self.lastPreviewedId }));
        }

        startCompletion(self.editorView!);
      }),
      autocompletion({
        override: [this.completionSource.bind(this)],
        icons: false,
        defaultKeymap: false,
        optionClass: (opt) => opt.type === 'namespace' ? 'namespace-option' : '',
      }),
    ];

    const startState = EditorState.create({
      doc: this.initialValue,
      extensions,
    });

    this.editorView = new EditorView({
      state: startState,
      parent: this.editorContainer,
    });

    // Auto-focus and select all
    if (this.autoSelect) {
      this.editorView.focus();
      this.editorView.dispatch({
        selection: { anchor: 0, head: this.initialValue.length },
      });
      startCompletion(this.editorView);
    } else {
      this.editorView.focus();
    }

    // Initialize lastPreviewedId from starting value
    if (this.initialValue) {
      const results = searchEffects(this.effects, this.initialValue);
      if (results.length > 0) {
        this.lastPreviewedId = results[0].id;
      }
    }

    // Commit on blur
    this.editorView.contentDOM.addEventListener('blur', () => {
      // Delay so autocomplete clicks resolve first
      setTimeout(() => {
        if (!this.isConnected) return;
        this.dispatchCommit(this.editorView!.state.doc.toString());
      }, 150);
    });
  }

  private completionSource(context: CompletionContext): CompletionResult | null {
    const query = context.state.doc.toString().trim();

    // Collect unique namespace prefixes from effect IDs
    const allNamespaces = new Set<string>();
    for (const e of this.effects) {
      const dotIdx = e.id.indexOf('.');
      if (dotIdx > 0) allNamespaces.add(e.id.slice(0, dotIdx));
    }

    // Check if the query is a namespace prefix (e.g., "video." or "video")
    const dotIdx = query.indexOf('.');
    const queryNamespace = dotIdx > 0 ? query.slice(0, dotIdx) : null;
    const queryAfterDot = dotIdx > 0 ? query.slice(dotIdx + 1) : null;

    // If query matches a namespace prefix exactly (e.g., "video." or "video.b"),
    // show only effects within that namespace
    if (queryNamespace && allNamespaces.has(queryNamespace)) {
      const nsEffects = this.effects.filter(e => e.id.startsWith(queryNamespace + '.'));
      const subQuery = queryAfterDot ?? '';
      const filtered = subQuery.length > 0
        ? nsEffects.filter(e => {
            const local = e.id.slice(queryNamespace.length + 1);
            return fuzzyMatch(subQuery.toLowerCase(), local.toLowerCase())
              || fuzzyMatch(subQuery.toLowerCase(), e.name.toLowerCase());
          })
        : nsEffects;

      if (filtered.length === 0) {
        return { from: 0, options: [{ label: 'No matching effects', type: 'text', apply: '' }], filter: false };
      }

      return {
        from: 0,
        options: filtered.map((effect, i) => ({
          label: effect.name,
          detail: effect.id,
          apply: () => { this.dispatchCommit(effect.id, true); },
          boost: filtered.length - i,
        })),
        filter: false,
      };
    }

    // Root level: show namespace categories first, then all matching effects
    const options: any[] = [];

    // Add namespace drill-down options
    const matchingNamespaces = query.length > 0
      ? [...allNamespaces].filter(ns => ns.startsWith(query.toLowerCase()) || fuzzyMatch(query.toLowerCase(), ns))
      : [...allNamespaces];

    for (const ns of matchingNamespaces.sort()) {
      const count = this.effects.filter(e => e.id.startsWith(ns + '.')).length;
      options.push({
        label: `${ns}/`,
        detail: `${count} effect${count !== 1 ? 's' : ''}`,
        type: 'namespace',
        apply: (view: EditorView, _completion: any, from: number, to: number) => {
          // Drill down: replace text with "namespace." and re-trigger completion
          view.dispatch({
            changes: { from, to, insert: ns + '.' },
            selection: { anchor: ns.length + 1 },
          });
          setTimeout(() => startCompletion(view), 0);
        },
        boost: 1000 + (ns.startsWith(query.toLowerCase()) ? 100 : 0),
      });
    }

    // Add matching effects
    const results = searchEffects(this.effects, query);
    for (let i = 0; i < results.length; i++) {
      const effect = results[i];
      options.push({
        label: effect.name,
        detail: effect.id,
        apply: () => { this.dispatchCommit(effect.id, true); },
        boost: results.length - i,
      });
    }

    if (options.length === 0) {
      return { from: 0, options: [{ label: 'No matching effects', type: 'text', apply: '' }], filter: false };
    }

    return { from: 0, options, filter: false };
  }

  private dispatchCommit(value: string, explicit = false) {
    if (this.editorView) {
      closeCompletion(this.editorView);
    }

    if (!explicit) {
      // Implicit commit (Enter without accepting, blur):
      // Use last valid preview, or fall back to initial value.
      // Note: explicit empty-then-Enter is routed to 'delete-request' by the
      // Enter/Tab key handlers before reaching here, so an empty value here
      // means the user blurred without typing anything.
      if (this.lastPreviewedId) {
        value = this.lastPreviewedId;
      } else {
        value = this.initialValue;
      }
    }

    this.dispatchEvent(new CustomEvent('commit', { detail: value }));
  }

  render() {
    return html`<div id="editor"></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'smart-input': SmartInput;
  }
}
