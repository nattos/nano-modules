/**
 * <smart-input> — Inline CodeMirror editor with autocomplete for effect type selection.
 *
 * Used to change effect types in sketch edit mode. Filters available effects
 * as the user types, shows a dropdown via CodeMirror autocompletion, and
 * dispatches preview/commit/cancel events.
 *
 * Events (exactly one terminal event — commit / delete-request / cancel — fires
 * per session):
 *   preview        — detail: effectId (string) — each keystroke, with the top match
 *   commit         — detail: effectId (string) — Enter/Tab (or clicking an option)
 *                    with a non-empty selection
 *   delete-request — Enter/Tab on an empty / whitespace-only field (express
 *                    commit of "nothing")
 *   cancel         — Escape, OR blur / clicking away (click-away is a cancel,
 *                    never a commit)
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
import { effectDomain } from './category-color';

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
  const id = effect.id.toLowerCase();
  const name = effect.name.toLowerCase();
  const short = shortName(effect.id).toLowerCase();

  // Full dotted-id matches first, so a path-style query ("color.tone.bright")
  // resolves straight to its effect (drives live preview + express commit when
  // the field is seeded with a full identifier).
  if (id === q || short === q) return 0;
  if (id.startsWith(q)) return 1;
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
  /** Set once a terminal event (commit/delete/cancel) has fired — guards against
   *  a second one racing in (e.g. the delayed blur handler after an option click). */
  private finished = false;

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
      font-size: var(--app-fs-md);
      background: transparent;
      /* Keep the editor's total height identical to the static
       * .effect-card-name label it replaces (same line-height + vertical
       * padding) so opening the type editor doesn't nudge the header. */
      line-height: 1.4;
    }
    .cm-editor.cm-focused { outline: none; }
    .cm-scroller { overflow: visible; line-height: 1.4; }
    .cm-content {
      padding: 3px 0;
      font-family: inherit;
      line-height: 1.4;
      caret-color: var(--app-text-color1, #e0e0e0);
    }
    .cm-line { padding: 0; line-height: 1.4; }
    .cm-selectionBackground { background: rgba(65, 105, 225, 0.35) !important; }
    .cm-cursor { border-left-color: var(--app-text-color1, #e0e0e0) !important; }

    /* Autocomplete popup */
    .cm-tooltip {
      background: var(--app-bg-color2) !important;
      color: var(--app-text-color1, #e0e0e0) !important;
      border: 1px solid var(--app-tint-5) !important;
      border-radius: 1px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    .cm-tooltip-autocomplete {
      max-height: 200px;
    }
    .cm-tooltip-autocomplete > ul {
      font-family: inherit;
      font-size: var(--app-fs-md);
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
      font-size: var(--app-fs-xs);
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
    /* Per-category accent dot, mirroring the effect-card header dot. Only
       categorized rows (cat-*) get one, so the placeholder row stays flush. */
    .cm-tooltip-autocomplete > ul > li[class*="cat-"]::before {
      content: '';
      display: inline-block;
      width: 5px; height: 5px;
      border-radius: 50%;
      margin-right: 7px;
      vertical-align: middle;
      background: var(--app-text-color2);
      opacity: 0.8;
    }
    .cm-tooltip-autocomplete > ul > li.cat-source::before { background: var(--app-cat-source); }
    .cm-tooltip-autocomplete > ul > li.cat-color::before { background: var(--app-cat-color); }
    .cm-tooltip-autocomplete > ul > li.cat-filter::before { background: var(--app-cat-filter); }
    .cm-tooltip-autocomplete > ul > li.cat-warp::before { background: var(--app-cat-warp); }
    .cm-tooltip-autocomplete > ul > li.cat-composite::before { background: var(--app-cat-composite); }
    .cm-tooltip-autocomplete > ul > li.cat-motion::before { background: var(--app-cat-motion); }
    .cm-tooltip-autocomplete > ul > li.cat-mod::before { background: var(--app-cat-mod); }
    .cm-tooltip-autocomplete > ul > li.cat-control::before { background: var(--app-cat-control); }
    .cm-tooltip-autocomplete > ul > li.cat-debug::before { background: var(--app-cat-debug); }
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
        backgroundColor: '#1a1d24',
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
            // Empty/whitespace text + accept means "express commit of nothing" —
            // check this BEFORE acceptCompletion, otherwise the open autocomplete
            // dropdown (showing all effects when the query is empty) would swallow
            // Tab and pick a namespace/effect instead of routing to delete-request.
            const val = view.state.doc.toString();
            if (val.trim().length === 0) {
              self.emitDelete();
              return true;
            }
            if (acceptCompletion(view)) return true;
            self.emitCommit(val);
            return true;
          },
        },
        {
          key: 'Enter',
          run: (view) => {
            const val = view.state.doc.toString();
            if (val.trim().length === 0) {
              self.emitDelete();
              return true;
            }
            if (acceptCompletion(view)) return true;
            self.emitCommit(val);
            return true;
          },
        },
        {
          key: 'Escape',
          run: () => {
            self.emitCancel();
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

        // An emptied (or whitespace-only) input means the user is asking to
        // commit "nothing" — clear the pending preview so the express-commit
        // path routes into delete rather than falling back to a stale guess.
        if (value.trim().length === 0) {
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
        optionClass: (opt) => {
          // `category` is stashed on the completion in completionSource so each
          // row can carry a subtle per-domain accent dot (see the cat-* CSS).
          const cat = (opt as any).category ? `cat-${(opt as any).category}` : '';
          return opt.type === 'namespace' ? `namespace-option ${cat}`.trim() : cat;
        },
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

    // Click-away is a cancel (never a commit). Delay so that clicking an
    // autocomplete option resolves first — that fires commit and sets
    // `finished`, which makes this a no-op.
    this.editorView.contentDOM.addEventListener('blur', () => {
      setTimeout(() => {
        if (!this.isConnected || this.finished) return;
        this.emitCancel();
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
        category: effectDomain(fullPath),
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

    // --- Effects. While searching, reach into deeper folders too so a fuzzy
    // match can jump straight to a nested effect.
    let effects: AvailableEffect[];
    if (sub.length === 0 && prefix.length === 0) {
      // Root with no query: just the (dotless) leaf effects — the top-level
      // folders are listed separately above. Don't dump every effect flat.
      effects = under.filter(e => !e.id.slice(prefix.length).includes('.'));
    } else if (sub.length === 0) {
      // Relaxed drill-down: once inside a path, list EVERY effect under it at
      // any depth — not just the immediate leaves — so drilling into "color/"
      // also surfaces "color.tone.brightness_contrast" directly (alongside the
      // "tone/" folder). Shallower effects sort first.
      effects = [...under].sort((a, b) => {
        const da = a.id.slice(prefix.length).split('.').length;
        const db = b.id.slice(prefix.length).split('.').length;
        if (da !== db) return da - db;
        return a.id.localeCompare(b.id);
      });
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
        category: effectDomain(effect.id),
        apply: () => { this.emitCommit(effect.id, true); },
        boost: effects.length - i,
      });
    }

    if (options.length === 0) {
      return { from: 0, options: [{ label: 'No matching effects', type: 'text', apply: '' }], filter: false };
    }

    return { from: 0, options, filter: false };
  }

  /** Express commit (Enter/Tab without an accepted option, or an option click). */
  private emitCommit(value: string, explicit = false) {
    if (this.finished) return;

    if (!explicit) {
      // Keyboard commit without accepting a dropdown row. Resolve to the last
      // valid preview — the typed text is a human-readable short name, but the
      // consumer needs a full effect id, so an unresolved name must NOT be
      // baked in. With nothing valid, fall back to a cancel.
      if (this.lastPreviewedId) {
        value = this.lastPreviewedId;
      } else {
        this.emitCancel();
        return;
      }
    }

    this.finished = true;
    if (this.editorView) closeCompletion(this.editorView);
    this.dispatchEvent(new CustomEvent('commit', { detail: value }));
  }

  /** Express commit of an empty field — the consumer decides delete vs. back-out. */
  private emitDelete() {
    if (this.finished) return;
    this.finished = true;
    if (this.editorView) closeCompletion(this.editorView);
    this.dispatchEvent(new CustomEvent('delete-request'));
  }

  /** Escape or click-away — abandon the edit. */
  private emitCancel() {
    if (this.finished) return;
    this.finished = true;
    if (this.editorView) closeCompletion(this.editorView);
    this.dispatchEvent(new CustomEvent('cancel'));
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
