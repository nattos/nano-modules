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
import { generatorThumbCapturer } from './media/generator-thumb-capture';
import { setGeneratorThumbPersist } from './media/generator-thumb-cache';
import { thumbnailController } from './media/thumbnail-controller';
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
      /* minmax(0, 1fr): the timeline column must be allowed to shrink to ZERO so the
         side panel + tab bar can never push past the viewport's right edge. A bare
         '1fr' is minmax(auto, 1fr), whose 'auto' min keeps the timeline at its
         content width and lets the side panel overflow off-screen. */
      grid-template-columns: minmax(0, 1fr) auto auto;
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
      /* Hard ceiling regardless of the dragged width (tab bar + a sliver of timeline). */
      max-width: calc(100vw - 100px);
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
    /* Output monitor floating over the timeline while the inspector is collapsed.
       Anchored bottom-right (above the tab bar); width is locked to the composition
       aspect so the composite shows with no padding. */
    .float-monitor {
      position: fixed;
      z-index: 50;
      background: var(--app-bg-color1);
      border: 1px solid var(--app-tint-3);
      border-radius: 4px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }
    .float-monitor arr-monitor {
      display: block;
      width: 100%;
      height: 100%;
    }
    .fm-edge {
      position: absolute;
      z-index: 2;
    }
    .fm-edge.top { top: 0; left: 8px; right: 8px; height: 6px; cursor: ns-resize; }
    .fm-edge.left { left: 0; top: 8px; bottom: 0; width: 6px; cursor: ew-resize; }
    .fm-edge.corner { left: 0; top: 0; width: 12px; height: 12px; cursor: nwse-resize; z-index: 3; }
    .fm-edge:hover { background: var(--app-hi-color2); opacity: 0.4; }
    .fm-edge.corner:hover { background: var(--app-hi-color2); opacity: 0.6; }
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
  private lastSurface: 'timeline' | 'inspector' | 'clipview' | 'other' = 'other';

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('pointerdown', this.onPointerDownCapture, true);
    this.addEventListener('dragover', this.onDragOver);
    this.addEventListener('dragleave', this.onDragLeave);
    this.addEventListener('drop', this.onDrop);
    this.lastT = performance.now();
    this.tick(this.lastT);
    // Boot the engine eagerly so it discovers every effect's schema — the
    // add-effect palette + inspector read store.enginePlugins, which is empty
    // until the engine warms the bundles (an empty timeline never triggers the
    // lazy boot otherwise).
    engineBridge.warm();
    // Back generator-clip thumbnails with the same OPFS disk tier the video reel uses,
    // so their film strips survive app restarts (best-effort; no GPU needed).
    setGeneratorThumbPersist({
      read: (key) => thumbnailController.persistRead(key),
      write: (key, bmp) => thumbnailController.persistWrite(key, bmp),
    });
    // Restore the saved workspace layout (panels/tabs/modes + last file) BEFORE
    // mounting, so the remembered file re-opens; then re-open the last workspace
    // (silently if permission persists, else on the first user gesture).
    void store.restoreLayout().then(() => store.autoMountRememberedWorkspace());
    this.installBackTrap();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onWindowResize);
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

  /** Re-clamp the resizable panels when the window shrinks, so neither the side
   *  inspector nor the clip-details panel ends up extending past the document edge. */
  private onWindowResize = () => {
    store.setSidePanelWidth(store.sidePanelWidth);
    store.setClipViewHeight(store.clipViewHeight);
  };

  /** Track the interacted surface via the composed path (crosses shadow roots). */
  private onPointerDownCapture = (e: PointerEvent) => {
    const path = e.composedPath();
    const has = (tag: string) => path.some((n) => (n as Element)?.tagName === tag);
    if (has('ARR-CLIP-VIEW')) this.lastSurface = 'clipview';
    else if (has('ARR-GRID') || has('ARR-RULER')) this.lastSurface = 'timeline';
    else if (has('ARR-INSPECTOR') || has('ARR-TABBAR')) this.lastSurface = 'inspector';
    else this.lastSurface = 'other';
    // Click-away (one rule for BOTH focus systems): a pointer-down that doesn't
    // land on a card/chip/pip/popup clears the chain card/field focus AND
    // dismisses the rail-wire popup. Clicks ON those re-establish focus
    // afterwards in their own handlers (pips that open a popup set it after this
    // capture-phase clear, so switching pips still works).
    if (store.chainFocusPath || store.chainFieldKey || store.selectedWireId || store.tapPopup) {
      const inClass = (classes: string[]) => path.some((n) => {
        const cl = (n as Element)?.classList;
        return !!cl && classes.some((c) => cl.contains(c));
      });
      // Chain card/field focus is preserved when the click lands on a card/chip
      // (the card's own handler then sets focus). The wire POPUP is preserved
      // ONLY when the click lands on the popup itself or a pip — so clicking an
      // effect card (incl. its output-trace area) still dismisses an open popup.
      if (!inClass(['effect-card', 'cat-chip', 'wire-hit', 'wire-mod-panel'])) store.clearChainFocus();
      if (!inClass(['tap-card', 'wire-mod-panel', 'field-option-pip', 'fpip'])) store.dismissPopups();
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
      // Match the clip length to the REAL video duration (metadata already probed in
      // importVideoFile) — exact beats, NOT snapped, so the clip spans the whole file.
      const lengthBeat = Math.max(0.25, (media.durationSec * bpm) / 60);
      store.addVideoClip(
        target.trackId,
        beat,
        {
          sourceKey: media.sourceKey,
          url: media.url,
          frameCount: media.frameCount,
          fps: media.fps,
          label: media.label,
          width: media.width,
          height: media.height,
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
    // Evaluate automation curves at the playhead and push them to the executor
    // (deduped inside the bridge, so a paused/unedited playhead stays quiet).
    engineBridge.pushAutomation();
    // Opportunistically push-capture generator-clip thumbnails from the live render
    // (throttled + only while a clip has uncached samples — see the capturer). Never
    // blocks: it taps the worker-produced trace bitmap and downscales async.
    generatorThumbCapturer.tick(store.positionBeat);
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
      // Clip automation editor focused → delete the envelope nodes in its selection.
      if (this.lastSurface === 'clipview') {
        const cv = this.renderRoot?.querySelector('arr-clip-view') as
          | (HTMLElement & { deleteSelectedAutoNodes?: () => boolean })
          | null;
        if (cv?.deleteSelectedAutoNodes?.()) { e.preventDefault(); return; }
        return;
      }
      // A focused effect card deletes first (works regardless of surface — the
      // chain lives in the inspector).
      if (store.hasChainFocus) {
        e.preventDefault();
        store.deleteChainFocus();
        return;
      }
      // A selected rail wire deletes first — works from either the timeline
      // overlay or a dashboard pip, and takes priority over the clip it rode in
      // on (selectWire also selects the clip, so check this before that branch).
      if (store.selectedWireId) {
        e.preventDefault();
        store.deleteSelectedWire();
        return;
      }
      // Otherwise Backspace/Delete is timeline-only: deleting an effect in a
      // sketch card or anywhere else must NOT delete clips/tracks.
      if (this.lastSurface !== 'timeline') return;
      // Caret on an automation lane with a region → delete that lane's nodes.
      if (store.caretLaneId && store.hasTimeSelection) {
        e.preventDefault();
        store.deleteAutoPointsInRange(store.caretLaneId, store.timeSelStart!, store.timeSelEnd);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        store.deleteTime(); // ripple-delete the time box
        return;
      }
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
    } else if (e.key.startsWith('Arrow')) {
      // Caret navigation (timeline only). Shift = extend (drag-like); Option/Alt
      // = jump to the next clip edge; both = extend to the edge.
      if (this.lastSurface !== 'timeline') return;
      e.preventDefault();
      const extend = e.shiftKey;
      const toEvent = e.altKey;
      if (e.key === 'ArrowLeft') store.caretMoveHorizontal(-1, { extend, toEvent });
      else if (e.key === 'ArrowRight') store.caretMoveHorizontal(1, { extend, toEvent });
      else if (e.key === 'ArrowUp') store.caretMoveVertical(-1, extend);
      else if (e.key === 'ArrowDown') store.caretMoveVertical(1, extend);
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
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      store.splitAtCursor(); // split at the caret
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
      // Cmd+Shift+B → collapse/expand the bottom (clip-details) panel.
      e.preventDefault();
      store.toggleClipView();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      // Cmd+B → collapse/expand the side (inspector) panel.
      e.preventDefault();
      store.setSideCollapsed(!store.sideCollapsed);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      store.insertTime();
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
      if (this.lastSurface !== 'timeline') return;
      e.preventDefault();
      store.pasteTime(); // insert clipboard-length time, then paste
    } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
      if (this.lastSurface !== 'timeline') return;
      e.preventDefault();
      store.cutTime(); // copy slices, then ripple-delete
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      if (this.lastSurface !== 'timeline') return;
      e.preventDefault();
      // Automation mode: every row is an envelope → copy the region's nodes.
      if (store.automationMode) {
        if (store.hasTimeSelection) store.copyAutomation(store.timeSelStart!, store.timeSelEnd);
      } else store.copyClips();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x') {
      if (this.lastSurface !== 'timeline') return;
      e.preventDefault();
      if (store.automationMode) {
        if (store.hasTimeSelection) store.cutAutomation(store.timeSelStart!, store.timeSelEnd);
      } else store.cutClips();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
      if (this.lastSurface !== 'timeline') return;
      e.preventDefault();
      // Paste follows the CLIPBOARD, not the current mode — pasting in the "wrong"
      // mode still applies the data (and never flips the mode on you).
      if (store.lastClipboardKind === 'auto') store.pasteAutomation(store.playFromBeat);
      else if (store.lastClipboardKind === 'clips') store.pasteClips();
    } else if (!e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      store.soloShortcut();
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
      ${store.sideCollapsed
        ? ''
        : html`<div class="side" style="width:${store.sidePanelWidth}px">
            <div
              class="side-resize"
              @pointerdown=${this.onSideResize}
              @dblclick=${() => store.setSideCollapsed(true)}
            ></div>
            <arr-inspector></arr-inspector>
            <arr-monitor></arr-monitor>
          </div>`}
      ${store.sideCollapsed ? this.renderFloatingMonitor() : ''}
      <div class="tabbar"><arr-tabbar></arr-tabbar></div>
      ${store.clipViewOpen
        ? html`<div class="clipview" style="height:${store.clipViewHeight}px">
            <div
              class="clipview-resize"
              @pointerdown=${this.onClipResize}
              @dblclick=${() => store.toggleClipView()}
            ></div>
            <arr-clip-view></arr-clip-view>
          </div>`
        : ''}
      <arr-overlay></arr-overlay>
      <snackbar-host></snackbar-host>
    `;
  }

  /** The output monitor floating over the timeline while the inspector is
   *  collapsed. Height = the user's monitor height; width locked to the
   *  composition aspect (no padding); anchored bottom-right above the tab bar. */
  private renderFloatingMonitor() {
    const h = store.monitorHeight;
    const w = h * store.compositionAspect;
    const right = 44 + 12; // tab bar width + margin
    const bottom = (store.clipViewOpen ? store.clipViewHeight : 0) + 12;
    return html`<div
      class="float-monitor"
      style="width:${w}px; height:${h}px; right:${right}px; bottom:${bottom}px"
    >
      <div class="fm-edge top" @pointerdown=${(e: PointerEvent) => this.onFloatResize(e, true, false)}></div>
      <div class="fm-edge left" @pointerdown=${(e: PointerEvent) => this.onFloatResize(e, false, true)}></div>
      <div class="fm-edge corner" @pointerdown=${(e: PointerEvent) => this.onFloatResize(e, true, true)}></div>
      <arr-monitor floating></arr-monitor>
    </div>`;
  }

  /** Resize the floating monitor by dragging an edge/corner. Width is aspect-locked,
   *  so every gesture resolves to a new monitor HEIGHT (a left-edge drag is mapped
   *  through the aspect; a corner takes whichever axis moved more). */
  private onFloatResize = (e: PointerEvent, top: boolean, left: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startH = store.monitorHeight;
    const aspect = store.compositionAspect || 16 / 9;
    const x0 = e.clientX, y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const deltas: number[] = [];
      if (top) deltas.push(y0 - ev.clientY);              // drag up → taller
      if (left) deltas.push((x0 - ev.clientX) / aspect);  // drag left → wider → taller
      const dH = deltas.length ? Math.max(...deltas) : 0;
      store.setMonitorHeight(startH + dH);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

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
