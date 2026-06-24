/**
 * <arrangement-app> — root shell of the Nano Arrangement page.
 *
 * Layout:
 *   ┌───────────────────────────────────────────────┬──────┬──┐
 *   │  transport (centered)                          │      │  │
 *   ├───────────────────────────────────────────────┤ insp │ R│
 *   │  ruler (warped beat grid, drag-zoom)           │ ector│ I│
 *   ├───────────────────────────────────────────────┤ ──── │ G│
 *   │  arrangement grid (headers | lanes | clips)    │ MONI │ H│
 *   │                                                │ TOR  │ T│
 *   └───────────────────────────────────────────────┴──────┴──┘
 */

import { html, css } from 'lit';
import { customElement } from 'lit/decorators.js';
import { MobxLitElement } from '../../mobx-lit-element';
import { store } from './state/store';
import { TransportController } from './engine/transport-clock';
import { engineBridge } from './engine/engine-bridge';
import { importVideoFile } from './media/drop-import';
import { linkMedia } from './workspace/media-store';
import { DirectoryBackend } from './workspace/backend';
import { snackbars } from '../../widgets/snackbars';
import '../../widgets/snackbars';

import './surfaces/transport-bar';
import './surfaces/arr-ruler';
import './surfaces/arr-grid';
import './surfaces/arr-tabbar';
import './surfaces/arr-inspector';
import './surfaces/arr-monitor';
import './surfaces/arr-overlay';
import './surfaces/arr-clip-view';

/** The focused element, resolved through nested shadow roots. */
function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

/** True if the element is a text editor (so global key shortcuts should defer). */
function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (el as HTMLElement).isContentEditable;
}

@customElement('arrangement-app')
export class ArrangementApp extends MobxLitElement {
  static styles = css`
    :host {
      display: grid;
      grid-template-columns: 1fr auto auto;
      grid-template-rows: auto 1fr auto;
      grid-template-areas:
        'transport side tabbar'
        'main      side tabbar'
        'clipview  side tabbar';
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      font-family: 'JetBrains Mono', 'SF Mono', 'Menlo', monospace;
      color: var(--app-text-color1);
      background: var(--app-bg-color1);
      /* The arrangement is a direct-manipulation surface — text selection on
         drag is noise. Inputs / editable fields opt back in below. */
      -webkit-user-select: none;
      user-select: none;
    }
    /* Real text entry must stay selectable/editable. */
    :host input,
    :host textarea,
    :host [contenteditable],
    :host editable-label {
      -webkit-user-select: text;
      user-select: text;
    }
    .transport-row {
      grid-area: transport;
      border-bottom: 1px solid var(--app-tint-3);
      background: var(--app-bg-color2);
    }
    .main {
      grid-area: main;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    arr-ruler {
      flex-shrink: 0;
    }
    arr-grid {
      flex: 1;
      min-height: 0;
    }
    .side {
      grid-area: side;
      position: relative;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--app-bg-color2);
      border-left: 1px solid var(--app-tint-3);
    }
    .side-resize {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 5px;
      cursor: ew-resize;
      z-index: 3;
    }
    .side-resize:hover {
      background: var(--app-hi-color2);
      opacity: 0.5;
    }
    arr-inspector {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    arr-monitor {
      flex-shrink: 0;
      border-top: 1px solid var(--app-tint-3);
    }
    .tabbar {
      grid-area: tabbar;
    }
    .clipview {
      grid-area: clipview;
      position: relative;
      min-width: 0;
      overflow: hidden;
    }
    .clipview-resize {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 5px;
      cursor: ns-resize;
      z-index: 2;
    }
    .clipview-resize:hover {
      background: var(--app-hi-color2);
      opacity: 0.5;
    }
    arr-clip-view {
      display: block;
      height: 100%;
    }
  `;

  private raf = 0;
  private lastT = 0;
  private transport = new TransportController();
  /** Which surface the user last interacted with (gates timeline deletions). */
  private lastSurface: 'timeline' | 'inspector' | 'other' = 'other';

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('pointerdown', this.onPointerDownCapture, true);
    this.addEventListener('dragover', this.onDragOver);
    this.addEventListener('dragleave', this.onDragLeave);
    this.addEventListener('drop', this.onDrop);
    this.lastT = performance.now();
    this.tick(this.lastT);
    // Restore the saved workspace layout (panels/tabs/modes + last file) BEFORE
    // mounting, so the remembered file re-opens; then re-open the last workspace
    // (silently if permission persists, else on the first user gesture).
    void store.restoreLayout().then(() => store.autoMountRememberedWorkspace());
    this.installBackTrap();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointerdown', this.onPointerDownCapture, true);
    this.removeEventListener('dragover', this.onDragOver);
    this.removeEventListener('dragleave', this.onDragLeave);
    this.removeEventListener('drop', this.onDrop);
    window.removeEventListener('popstate', this.onPopState);
    cancelAnimationFrame(this.raf);
  }

  /**
   * Trap the browser Back gesture (a two-finger swipe is far too easy to trigger
   * accidentally and would discard the session). We keep one sentinel history
   * entry; a Back pops it but stays on the document — we re-push it and surface a
   * snackbar offering a real "Go back". Confirming pops past the sentinel.
   */
  private backLeaving = false;
  private installBackTrap() {
    history.pushState({ __arrTrap: true }, '');
    window.addEventListener('popstate', this.onPopState);
  }
  private onPopState = () => {
    if (this.backLeaving) {
      // Confirmed: we're now on the entry the sentinel sat above — go back once
      // more to actually leave the app.
      history.back();
      return;
    }
    // Accidental back: re-establish the sentinel (stay put) and offer a real exit.
    history.pushState({ __arrTrap: true }, '');
    snackbars.show({
      message: 'Back gesture prevented',
      dedupeKey: 'back-trap',
      actions: [{ label: 'Go back', run: () => { this.backLeaving = true; history.back(); } }],
    });
  };

  /** Track the interacted surface via the composed path (crosses shadow roots). */
  private onPointerDownCapture = (e: PointerEvent) => {
    const path = e.composedPath();
    const has = (tag: string) => path.some((n) => (n as Element)?.tagName === tag);
    if (has('ARR-GRID') || has('ARR-RULER')) this.lastSurface = 'timeline';
    else if (has('ARR-INSPECTOR') || has('ARR-TABBAR')) this.lastSurface = 'inspector';
    else this.lastSurface = 'other';
    // Click-away: a pointer-down that doesn't land on an effect card or a
    // category chip clears the chain card/field focus. (Clicks ON a card set
    // focus afterwards in the card's own handler; clicks on a chip insert.)
    if (store.chainFocusPath || store.chainFieldKey) {
      const KEEP = ['effect-card', 'cat-chip', 'wire-hit', 'wire-mod-panel'];
      const inChain = path.some((n) => {
        const cl = (n as Element)?.classList;
        return !!cl && KEEP.some((c) => cl.contains(c));
      });
      if (!inChain) store.clearChainFocus();
    }
  };

  private gridEl(): (HTMLElement & {
    resolveDropTarget(x: number, y: number): { trackId: string; startBeat: number } | null;
    setClipDropTarget(trackId: string | null): void;
  }) | null {
    return (this.shadowRoot?.querySelector('arr-grid') as any) ?? null;
  }

  /** Allow file drops anywhere on the page + preview which track they'd land on
   *  (the same lane highlight a cross-track clip drag shows). */
  private onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const grid = this.gridEl();
    grid?.setClipDropTarget(grid.resolveDropTarget(e.clientX, e.clientY)?.trackId ?? null);
  };

  /** Clear the drop highlight when the drag leaves the window. */
  private onDragLeave = (e: DragEvent) => {
    if (e.relatedTarget === null) this.gridEl()?.setClipDropTarget(null);
  };

  /**
   * Drop a file → a video clip. On the timeline it lands at the quantized cursor
   * beat on the track under the pointer (nearest eligible track if that row can't
   * host clips); dropped elsewhere it lands at the play position on the nearest
   * eligible track. Multiple files stack sequentially. The grid (which owns the
   * beat↔pixel + track↔Y transforms) resolves the position.
   */
  private onDrop = async (e: DragEvent) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    // Capture everything synchronously — `DataTransfer` is cleared once we await.
    const files = dt.files;
    const handlePromises = Array.from(dt.items || [])
      .filter((it) => it.kind === 'file' && typeof (it as any).getAsFileSystemHandle === 'function')
      .map((it) =>
        ((it as any).getAsFileSystemHandle() as Promise<FileSystemHandle | null>).catch(() => null),
      );
    if (!files?.length && !handlePromises.length) return;
    e.preventDefault();

    // A dropped FOLDER switches the workspace (rather than importing media).
    if (handlePromises.length) {
      const handles = await Promise.all(handlePromises);
      const dir = handles.find(
        (h): h is FileSystemDirectoryHandle => !!h && h.kind === 'directory',
      );
      if (dir) {
        await store.mountWorkspace(new DirectoryBackend(dir, dir.name || 'workspace'));
        store.setRightTab('workspace');
        return;
      }
    }

    if (!files || files.length === 0) return;
    const grid = this.shadowRoot?.querySelector('arr-grid') as
      | (HTMLElement & { resolveDropTarget(x: number, y: number): { trackId: string; startBeat: number } | null })
      | null;
    let target = grid?.resolveDropTarget(e.clientX, e.clientY) ?? null;
    if (!target) {
      const id = store.addTrack();
      target = { trackId: id, startBeat: store.quantize(store.positionBeat) };
    }

    // Prefer dropped FILE HANDLES (Chrome): linkMedia persists them (library-
    // relative when possible) so the source RELINKS after reload. Without a
    // handle (Safari) we fall back to the plain File (session-only blob URL).
    const fileHandles = (await Promise.all(handlePromises))
      .filter((h): h is FileSystemFileHandle => !!h && h.kind === 'file');
    const imports: Array<{ file: File; sourceKey: string }> = [];
    if (fileHandles.length) {
      for (const h of fileHandles) {
        try {
          const sourceKey = await linkMedia(h); // persist + canonical key
          imports.push({ file: await h.getFile(), sourceKey });
        } catch { /* unreadable handle → skip */ }
      }
    } else {
      for (const file of Array.from(files)) imports.push({ file, sourceKey: '' });
    }

    const bpm = store.composition.meta.baseBPM;
    let beat = target.startBeat;
    for (const { file, sourceKey } of imports) {
      const media = await importVideoFile(file, sourceKey || undefined);
      const lengthBeat = Math.max(1, store.quantize((media.durationSec * bpm) / 60));
      store.addVideoClip(
        target.trackId,
        beat,
        {
          sourceKey: media.sourceKey,
          url: media.url,
          frameCount: media.frameCount,
          fps: media.fps,
          label: media.label,
        },
        lengthBeat,
      );
      beat += lengthBeat;
    }
    this.gridEl()?.setClipDropTarget(null);
  };

  /**
   * Transport ticker. Explicit rAF loop (no MobX reaction) advances the playhead
   * through the WARPED beat clock (Component E) and loops at the brace — the
   * playhead moves faster where the grid clumps, slower where it spreads.
   */
  private tick = (now: number) => {
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    // Precise mode: don't step the transport while a video input for the current
    // beat is still decoding (time must never run ahead of the picture). The
    // pump keeps decoding the held beat, so the stall self-resolves.
    if (!(store.playing && !engineBridge.inputsReady())) this.transport.advance(store, dt);
    // Drive the engine's effect clock from the transport: effects animate in
    // lock-step with the playhead (and hold still when it's paused), instead of
    // free-running on wall time. Deduped inside the bridge.
    engineBridge.setTime(this.transport.secondsAt(store));
    this.raf = requestAnimationFrame(this.tick);
  };

  private onKey = (e: KeyboardEvent) => {
    // Resolve focus through shadow roots — typing in any editor consumes the key.
    if (isEditable(deepActiveElement())) return;
    if (e.key === 'Backspace' || e.key === 'Delete') {
      // A focused field widget handles its own Delete (reset to default) — don't
      // also delete the card it's in.
      const tag = deepActiveElement()?.tagName ?? '';
      if (tag === 'SCALAR-SLIDER' || tag.startsWith('FIELD-')) return;
      // A focused effect card deletes first (works regardless of surface — the
      // chain lives in the inspector).
      if (store.hasChainFocus) {
        e.preventDefault();
        store.deleteChainFocus();
        return;
      }
      // Otherwise Backspace/Delete is timeline-only: deleting an effect in a
      // sketch card or anywhere else must NOT delete clips/tracks.
      if (this.lastSurface !== 'timeline') return;
      if (store.primaryPath?.startsWith('track/')) {
        e.preventDefault();
        store.deleteSelectedTracks(); // a focused track → delete it (never the bus)
      } else if (store.hasTimeSelection) {
        e.preventDefault();
        store.clearTime(); // split + remove center, leave empty time
      } else if (store.selection.size) {
        e.preventDefault();
        store.deleteSelectedClips();
      }
    } else if (e.key === 'Escape') {
      store.clearSelection();
    } else if (e.code === 'Space' || e.key === ' ') {
      // Use e.code: Option/Alt+Space on macOS yields a non-breaking space for
      // e.key, so matching ' ' alone would miss it. Alt+Space → rewind + play.
      e.preventDefault();
      if (e.altKey) store.rewindAndPlay();
      else store.togglePlay();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if (e.key.toLowerCase() === 'l') {
      // Cmd/Ctrl+L (preventDefault'd so the browser doesn't grab it) or plain L:
      // toggle the loop, or snap it to the time box when one is set.
      e.preventDefault();
      store.toggleLoopOrSetToTimeBox();
    } else if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      store.toggleAutomationMode();
    } else if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      store.toggleWiresMode();
    } else if (!e.metaKey && !e.ctrlKey && e.key === '0') {
      e.preventDefault();
      store.toggleBypassShortcut();
    }
  };

  render() {
    return html`
      <div class="transport-row"><transport-bar></transport-bar></div>
      <div class="main">
        <arr-ruler></arr-ruler>
        <arr-grid></arr-grid>
      </div>
      <div class="side" style="width:${store.sidePanelWidth}px">
        <div class="side-resize" @pointerdown=${this.onSideResize}></div>
        <arr-inspector></arr-inspector>
        <arr-monitor></arr-monitor>
      </div>
      <div class="tabbar"><arr-tabbar></arr-tabbar></div>
      ${store.clipViewOpen
        ? html`<div class="clipview" style="height:${store.clipViewHeight}px">
            <div class="clipview-resize" @pointerdown=${this.onClipResize}></div>
            <arr-clip-view></arr-clip-view>
          </div>`
        : ''}
      <arr-overlay></arr-overlay>
      <snackbar-host></snackbar-host>
    `;
  }

  private onSideResize = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.target as HTMLElement;
    const right = (el.parentElement as HTMLElement).getBoundingClientRect().right;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => store.setSidePanelWidth(right - ev.clientX);
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  private onClipResize = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.target as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => store.setClipViewHeight(window.innerHeight - ev.clientY);
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}
