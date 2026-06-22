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
import { importVideoFile } from './media/drop-import';

import './surfaces/transport-bar';
import './surfaces/arr-ruler';
import './surfaces/arr-grid';
import './surfaces/arr-tabbar';
import './surfaces/arr-inspector';
import './surfaces/arr-monitor';
import './surfaces/arr-overlay';
import './surfaces/arr-clip-view';

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
      width: 320px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--app-bg-color2);
      border-left: 1px solid var(--app-tint-3);
    }
    arr-inspector {
      flex: 1;
      min-height: 0;
      overflow: hidden;
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

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.onKey);
    this.addEventListener('dragover', this.onDragOver);
    this.addEventListener('drop', this.onDrop);
    this.lastT = performance.now();
    this.tick(this.lastT);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.onKey);
    this.removeEventListener('dragover', this.onDragOver);
    this.removeEventListener('drop', this.onDrop);
    cancelAnimationFrame(this.raf);
  }

  /** Allow file drops anywhere on the page. */
  private onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  /**
   * Drop a file → a video clip. On the timeline it lands at the quantized cursor
   * beat on the track under the pointer (nearest eligible track if that row can't
   * host clips); dropped elsewhere it lands at the play position on the nearest
   * eligible track. Multiple files stack sequentially. The grid (which owns the
   * beat↔pixel + track↔Y transforms) resolves the position.
   */
  private onDrop = async (e: DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    const grid = this.shadowRoot?.querySelector('arr-grid') as
      | (HTMLElement & { resolveDropTarget(x: number, y: number): { trackId: string; startBeat: number } | null })
      | null;
    let target = grid?.resolveDropTarget(e.clientX, e.clientY) ?? null;
    if (!target) {
      const id = store.addTrack();
      target = { trackId: id, startBeat: store.quantize(store.positionBeat) };
    }
    const bpm = store.composition.meta.baseBPM;
    let beat = target.startBeat;
    for (const file of Array.from(files)) {
      const media = await importVideoFile(file);
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
  };

  /**
   * Transport ticker. Explicit rAF loop (no MobX reaction) advances the playhead
   * through the WARPED beat clock (Component E) and loops at the brace — the
   * playhead moves faster where the grid clumps, slower where it spreads.
   */
  private tick = (now: number) => {
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    this.transport.advance(store, dt);
    this.raf = requestAnimationFrame(this.tick);
  };

  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'Backspace' || e.key === 'Delete') {
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
    } else if (e.key === ' ') {
      e.preventDefault();
      store.togglePlay();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    }
  };

  render() {
    return html`
      <div class="transport-row"><transport-bar></transport-bar></div>
      <div class="main">
        <arr-ruler></arr-ruler>
        <arr-grid></arr-grid>
      </div>
      <div class="side">
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
    `;
  }

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
