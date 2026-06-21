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
            // Empty text + accept means "delete this effect" — check this
            // BEFORE acceptCompletion, otherwise the open autocomplete dropdown
            // (showing all effects when query is empty) would swallow Tab and
            // pick a namespace/effect instead of routing to delete-request.
            const val = view.state.doc.toString();
            if (val.length === 0) {
              closeCompletion(view);
              self.dispatchEvent(new CustomEvent('delete-request'));
              return true;
            }
            if (acceptCompletion(view)) return true;
            self.dispatchCommit(val);
            return true;
          },
        },
        {
          key: 'Enter',
          run: (view) => {
            const val = view.state.doc.toString();
            if (val.length === 0) {
              closeCompletion(view);
              self.dispatchEvent(new CustomEvent('delete-request'));
              return true;
            }
            if (acceptCompletion(view)) return true;
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

    // Effect ids are dotted paths of arbitrary depth (e.g.
    // "source.light.chroma_wave"). The drill-down context is everything up to
    // and including the last dot — that's the path we've descended into — and
    // the text after the last dot is the local search within that path.
    //   ""                     -> prefix "",              sub ""        (root)
    //   "source"               -> prefix "",              sub "source"  (root, filtering)
    //   "source."              -> prefix "source.",       sub ""
    //   "source.li"            -> prefix "source.",       sub "li"
    //   "source.light."        -> prefix "source.light.", sub ""
    //   "source.light.chr"     -> prefix "source.light.", sub "chr"
    const lastDot = query.lastIndexOf('.');
    let prefix = lastDot >= 0 ? query.slice(0, lastDot + 1) : '';
    let subQuery = lastDot >= 0 ? query.slice(lastDot + 1) : query;

    // If the typed prefix isn't a real path (no effect lives under it), fall
    // back to a flat fuzzy search over the whole query.
    if (prefix && !this.effects.some(e => e.id.startsWith(prefix))) {
      prefix = '';
      subQuery = query;
    }

    const sub = subQuery.toLowerCase();
    const under = this.effects.filter(e => e.id.length > prefix.length && e.id.startsWith(prefix));

    const options: any[] = [];

    // --- Sub-folders: the next path segment of any deeper effect under the
    // current prefix. A segment is a folder when at least one effect has a
    // further dot beyond it (i.e. there's something to descend into).
    const folderCounts = new Map<string, number>();
    for (const e of under) {
      const remainder = e.id.slice(prefix.length);
      const dot = remainder.indexOf('.');
      if (dot <= 0) continue; // leaf at this level, not a folder
      const seg = remainder.slice(0, dot);
      folderCounts.set(seg, (folderCounts.get(seg) ?? 0) + 1);
    }

    const folders = [...folderCounts.keys()]
      .filter(seg => sub.length === 0 || seg.toLowerCase().startsWith(sub) || fuzzyMatch(sub, seg.toLowerCase()))
      .sort();

    for (const seg of folders) {
      const fullPath = prefix + seg;
      const count = folderCounts.get(seg)!;
      options.push({
        label: `${seg}/`,
        detail: `${count} effect${count !== 1 ? 's' : ''}`,
        type: 'namespace',
        apply: (view: EditorView, _completion: any, from: number, to: number) => {
          // Drill down: replace text with "<path>." and re-trigger completion
          view.dispatch({
            changes: { from, to, insert: fullPath + '.' },
            selection: { anchor: fullPath.length + 1 },
          });
          setTimeout(() => startCompletion(view), 0);
        },
        boost: 1000 + (seg.toLowerCase().startsWith(sub) ? 100 : 0),
      });
    }

    // --- Effects. With no sub-query, list only the immediate leaves under the
    // prefix (clean drill-down). While searching, reach into deeper folders too
    // so a fuzzy match can jump straight to a nested effect.
    let effects: AvailableEffect[];
    if (sub.length === 0) {
      effects = under.filter(e => !e.id.slice(prefix.length).includes('.'));
    } else if (prefix.length === 0) {
      effects = searchEffects(this.effects, subQuery);
    } else {
      effects = under
        .map(e => ({ e, s: matchScore(subQuery, e) }))
        .filter(x => x.s >= 0)
        .sort((a, b) => a.s - b.s)
        .map(x => x.e);
    }

    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i];
      options.push({
        label: effect.name,
        detail: effect.id,
        apply: () => { this.dispatchCommit(effect.id, true); },
        boost: effects.length - i,
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
      // Implicit commit (Enter without accepting, blur). Use last valid
      // preview if we have one. Falling back to initialValue is unsafe —
      // it's the human-readable short name, but the consumer
      // (changeEffectType) needs a full effect id; an unresolved short name
      // ends up baked into the chain entry as an invalid module_type.
      // If we have nothing valid, treat it as a cancel so the chain is left
      // unchanged.
      if (this.lastPreviewedId) {
        value = this.lastPreviewedId;
      } else {
        this.dispatchEvent(new CustomEvent('cancel'));
        return;
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
